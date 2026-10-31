import { initialState, legalMoves, playLegal, labelMove, result } from "../public/game/engine.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
const TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const READ_ROOM = "SELECT * FROM rooms WHERE code = ?";

class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

function hex(bytes) {
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

function randomBytes(count) {
  return crypto.getRandomValues(new Uint8Array(count));
}

function generateCode() {
  return Array.from(randomBytes(10), byte => CODE_ALPHABET[byte & 31]).join("");
}

async function hashToken(token) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))));
}

function bearer(request, allowNew = false) {
  const header = request.headers.get("authorization");
  if (allowNew && !header) return hex(randomBytes(32));
  const token = header?.match(/^Bearer (\S+)$/i)?.[1] ?? "";
  if (!TOKEN_PATTERN.test(token)) throw new RoomError(403, "This browser does not hold a valid seat token.");
  return token;
}

function sideFor(row, hash) {
  if (row.white_hash === hash) return "w";
  if (row.black_hash === hash) return "b";
  throw new RoomError(403, "This seat token does not belong to this room.");
}

function snapshot(row, side, token) {
  return {
    code: row.code,
    revision: row.revision,
    ready: row.black_hash !== null,
    side,
    state: JSON.parse(row.state),
    log: JSON.parse(row.log),
    outcome: row.outcome === null ? null : JSON.parse(row.outcome),
    ...(token ? { token } : {}),
  };
}

async function first(db, sql, ...args) {
  return db.prepare(sql).bind(...args).first();
}

async function readRoom(db, code) {
  const row = await first(db, READ_ROOM, code);
  if (!row) throw new RoomError(404, "Room not found. Check the invite code.");
  return row;
}

async function createRoom(db, request) {
  const token = bearer(request, true);
  const hash = await hashToken(token);
  const state = JSON.stringify(initialState());
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await first(db,
      "INSERT INTO rooms (code, white_hash, revision, state, log) VALUES (?, ?, 0, ?, '[]') ON CONFLICT DO NOTHING RETURNING *",
      generateCode(), hash, state);
    if (row) return json(snapshot(row, "w", token), 201);
    // A lost response can be recovered by retrying with the same bearer.
    const existing = await first(db, "SELECT * FROM rooms WHERE white_hash = ?", hash);
    if (existing) return json(snapshot(existing, "w", token));
  }
  throw new RoomError(503, "A room code could not be allocated. Try again.");
}

async function joinRoom(db, code, request) {
  const token = bearer(request, true);
  const hash = await hashToken(token);
  // The seat and the revision change in one statement, even for simultaneous joins.
  let row = await first(db,
    "UPDATE rooms SET black_hash = ?, revision = revision + 1 WHERE code = ? AND black_hash IS NULL AND white_hash != ? RETURNING *",
    hash, code, hash);
  if (row) return json(snapshot(row, "b", token));
  row = await readRoom(db, code);
  if (row.white_hash !== hash && row.black_hash !== hash) {
    throw new RoomError(409, "Both seats in this room are taken.");
  }
  return json(snapshot(row, sideFor(row, hash), token));
}

async function readAction(request) {
  const limit = 4096;
  if (Number(request.headers.get("content-length")) > limit) throw new RoomError(413, "Move request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new RoomError(400, "A move request body is required.");
  const decoder = new TextDecoder();
  let count = 0;
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) {
        await reader.cancel();
        throw new RoomError(413, "Move request is too large.");
      }
      body += decoder.decode(value, { stream: true });
    }
    const action = JSON.parse(body + decoder.decode());
    if (!Number.isSafeInteger(action?.revision) || action.revision < 0) {
      throw new RoomError(400, "Supply the revision of the position you played.");
    }
    return action;
  } catch (error) {
    if (error instanceof RoomError) throw error;
    throw new RoomError(400, "Invalid JSON request.");
  } finally {
    reader.releaseLock();
  }
}

function matchMove(state, input) {
  // Only use the engine's generated move and flags; the client names an intent.
  const move = input && legalMoves(state).find(candidate =>
    candidate.from === input.from && candidate.to === input.to &&
    (candidate.power ?? null) === (input.power ?? null) &&
    (candidate.promotion ?? null) === (input.promotion ?? null));
  if (!move) throw new RoomError(400, "That move is illegal in this position.");
  return move;
}

function stale() {
  return new RoomError(409, "The room has changed. Refresh the position and try again.");
}

async function act(db, row, side, actionName, request) {
  const action = await readAction(request);
  if (action.revision !== row.revision) throw stale();
  if (!row.black_hash) throw new RoomError(409, "Waiting for the second player.");
  if (row.outcome !== null) throw new RoomError(409, "This match is over.");

  let state = JSON.parse(row.state);
  const log = JSON.parse(row.log);
  let outcome;
  if (actionName === "resign") {
    outcome = { winner: side === "w" ? "b" : "w", reason: "Resignation" };
  } else {
    if (state.turn !== side) throw new RoomError(409, "It is your opponent's turn.");
    const move = matchMove(state, action.move);
    log.push({
      label: labelMove(state, move), side, from: move.from, to: move.to,
      ...(move.power ? { power: move.power } : {}),
    });
    state = playLegal(state, move);
    outcome = result(state);
  }

  const updated = await first(db,
    "UPDATE rooms SET state = ?, log = ?, outcome = ?, revision = revision + 1 WHERE code = ? AND revision = ? RETURNING *",
    JSON.stringify(state), JSON.stringify(log), outcome ? JSON.stringify(outcome) : null, row.code, row.revision);
  if (!updated) throw stale();
  return json(snapshot(updated, side));
}

/** Shared by the Worker route and any D1-compatible local SQLite adapter. */
export async function handleRoomRequest(db, request) {
  try {
    const match = new URL(request.url).pathname.match(/^\/api\/rooms(?:\/([^/]+)(?:\/(join|move|resign))?)?\/?$/);
    if (!match) throw new RoomError(404, "Room endpoint not found.");
    if (!match[1] && request.method === "POST") return await createRoom(db, request);
    const code = (match[1] ?? "").toUpperCase();
    if (!CODE_PATTERN.test(code)) throw new RoomError(404, "Room not found. Check the invite code.");
    const action = match[2];
    if (action === "join" && request.method === "POST") return await joinRoom(db, code, request);
    if (!(request.method === "GET" && !action) && !(request.method === "POST" && ["move", "resign"].includes(action))) {
      throw new RoomError(405, "Unsupported room action.");
    }
    const hash = await hashToken(bearer(request));
    const row = await readRoom(db, code);
    const side = sideFor(row, hash);
    if (!action) return json(snapshot(row, side));
    return await act(db, row, side, action, request);
  } catch (error) {
    if (error instanceof RoomError) return json({ error: error.message }, error.status);
    console.error("Room storage or engine failure:", error);
    return json({ error: "The room service is unavailable. Try again shortly." }, 503);
  }
}
