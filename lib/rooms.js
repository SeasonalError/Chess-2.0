import { pagesOrigin } from '../public/game/hosting.js';
import {
  createMatch, createDraftMatch, draftMatch, viewMatch, advanceMatch, moveMatch, counterMatch, readyMatch, tapMatch, EncounterError,
} from "../public/game/encounter.js";

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

function encodeMatch(match) {
  // Keep the schema and D1 migration compatible with already-open rooms.
  return JSON.stringify({version: 3, state: match.state, encounter: match.encounter, draft: match.draft ?? null});
}

function decodeMatch(row) {
  const saved = JSON.parse(row.state);
  const envelope = saved.version === 2 || saved.version === 3;
  const match = createMatch(envelope ? saved.state : saved);
  match.encounter = envelope ? saved.encounter : null;
  match.draft = saved.version === 3 ? saved.draft : null;
  match.log = JSON.parse(row.log);
  match.outcome = JSON.parse(row.outcome);
  return match;
}

function snapshot(row, match, side, now, token) {
  return {
    code: row.code, revision: row.revision, ready: row.black_hash !== null, side,
    ...viewMatch(match, now, side),
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

async function createRoom(db, request, clock) {
  const token = bearer(request, true);
  const hash = await hashToken(token);
  const match = createDraftMatch();
  const state = encodeMatch(match);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await first(db,
      "INSERT INTO rooms (code, white_hash, revision, state, log) VALUES (?, ?, 0, ?, '[]') ON CONFLICT DO NOTHING RETURNING *",
      generateCode(), hash, state);
    if (row) return json(snapshot(row, match, "w", clock(), token), 201);
    // A lost response can be recovered by retrying with the same bearer.
    const existing = await first(db, "SELECT * FROM rooms WHERE white_hash = ?", hash);
    if (existing) return serve(db, existing, "w", clock, null, null, token);
  }
  throw new RoomError(503, "A room code could not be allocated. Try again.");
}

async function joinRoom(db, code, request, clock) {
  const token = bearer(request, true);
  const hash = await hashToken(token);
  // The seat and the revision change in one statement, even for simultaneous joins.
  let row = await first(db,
    "UPDATE rooms SET black_hash = ?, revision = revision + 1 WHERE code = ? AND black_hash IS NULL AND white_hash != ? RETURNING *",
    hash, code, hash);
  if (row) return serve(db, row, "b", clock, null, null, token);
  row = await readRoom(db, code);
  if (row.white_hash !== hash && row.black_hash !== hash) {
    throw new RoomError(409, "Both seats in this room are taken.");
  }
  return serve(db, row, sideFor(row, hash), clock, null, null, token);
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

function stale() {
  return new RoomError(409, "The room has changed. Refresh the position and try again.");
}

function perform(match, row, side, kind, body, now) {
  // Picks are seat-local and irrevocable. A concurrent join or a pick by the
  // other seat does not invalidate this player's choice or its retry.
  if (kind === "draft") {
    if (body.revision > row.revision) throw stale();
    return draftMatch(match, side, body.card);
  }
  if (!row.black_hash) throw new RoomError(409, "Waiting for the second player.");
  if (match.outcome) throw new RoomError(409, "This match is over.");

  // The opponent can update a duel while our input is in flight. A unique
  // encounter ID scopes ready/tap requests; tap sequence numbers prevent replay.
  const concurrent = kind === "ready" || kind === "tap";
  if (body.revision > row.revision || (!concurrent && body.revision !== row.revision)) throw stale();
  if (kind === "move") return moveMatch(match, side, body.move, now);
  if (kind === "resign") return {...match, encounter: null,
    outcome: {winner: side === "w" ? "b" : "w", reason: "Resignation"}};
  if (!match.encounter || body.encounterId !== match.encounter.id) throw stale();
  if (kind === "counter") return counterMatch(match, side, body.square, now);
  if (kind === "ready") return readyMatch(match, side, now);
  return tapMatch(match, side, body, now);
}

function commit(db, row, match) {
  return first(db,
    "UPDATE rooms SET state = ?, log = ?, outcome = ?, revision = revision + 1 WHERE code = ? AND revision = ? RETURNING *",
    encodeMatch(match), JSON.stringify(match.log), match.outcome ? JSON.stringify(match.outcome) : null, row.code, row.revision);
}

async function serve(db, row, side, clock, kind, body, token) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const now = clock();
    const saved = decodeMatch(row);
    const advanced = advanceMatch(saved, now);
    if (advanced !== saved) {
      // Persist expired windows before responding, including when the triggering
      // request is a late tap, a stale guess, a reconnect or an ordinary poll.
      const updated = await commit(db, row, advanced);
      row = updated ?? await readRoom(db, row.code);
      continue;
    }
    const next = kind ? perform(saved, row, side, kind, body, now) : saved;
    if (next === saved) return json(snapshot(row, saved, side, now, token));
    const updated = await commit(db, row, next);
    if (updated) return json(snapshot(updated, next, side, now, token));
    row = await readRoom(db, row.code);
  }
  throw stale();
}

/** Shared by the Worker and local SQLite server; clock injection is for deterministic tests. */
export async function handleRoomRequest(db, request, clock = Date.now) {
  const pagesRequest = request.headers.get('Origin') === pagesOrigin;
  if (request.method === 'OPTIONS') {
    if (!pagesRequest) return new Response(null, {status: 403});
    return new Response(null, {status: 204, headers: {
      'Access-Control-Allow-Origin': pagesOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin',
    }});
  }
  const response = await routeRoomRequest(db, request, clock);
  if (pagesRequest) response.headers.set('Access-Control-Allow-Origin', pagesOrigin);
  response.headers.append('Vary', 'Origin');
  return response;
}

async function routeRoomRequest(db, request, clock) {
  try {
    const match = new URL(request.url).pathname.match(/^\/api\/rooms(?:\/([^/]+)(?:\/(join|draft|move|resign|counter|ready|tap))?)?\/?$/);
    if (!match) throw new RoomError(404, "Room endpoint not found.");
    if (!match[1] && request.method === "POST") return await createRoom(db, request, clock);
    const code = (match[1] ?? "").toUpperCase();
    if (!CODE_PATTERN.test(code)) throw new RoomError(404, "Room not found. Check the invite code.");
    const kind = match[2];
    if (kind === "join" && request.method === "POST") return await joinRoom(db, code, request, clock);
    if (!(request.method === "GET" && !kind) && !(request.method === "POST" && ["draft", "move", "resign", "counter", "ready", "tap"].includes(kind))) {
      throw new RoomError(405, "Unsupported room action.");
    }
    const hash = await hashToken(bearer(request));
    const row = await readRoom(db, code);
    const side = sideFor(row, hash);
    const body = kind ? await readAction(request) : null;
    return await serve(db, row, side, clock, kind, body);
  } catch (error) {
    if (error instanceof RoomError || error instanceof EncounterError) return json({ error: error.message }, error.status);
    console.error("Room storage or engine failure:", error);
    return json({ error: "The room service is unavailable. Try again shortly." }, 503);
  }
}
