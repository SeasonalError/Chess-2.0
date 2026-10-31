import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../lib/rooms-local.mjs";
import { handleRoomRequest } from "../lib/rooms.js";

function request(db, path = "", method = "GET", token, payload) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = new Request(`https://game.test/api/rooms${path}`, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return handleRoomRequest(db, request).then(async response => ({
    status: response.status, data: await response.json(), headers: response.headers,
  }));
}

function store(t) {
  const db = openRoomStore();
  t.after(() => db.close());
  return db;
}

async function pair(db) {
  const host = await request(db, "", "POST");
  assert.equal(host.status, 201);
  const path = "/" + host.data.code;
  const guest = await request(db, path + "/join", "POST");
  assert.equal(guest.status, 200);
  return { host: host.data, guest: guest.data, path };
}

test("host and guest play, keep the same position after reopening the database, and resign", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "riftbound-test-"));
  const filename = join(dir, "rooms.sqlite");
  let db = openRoomStore(filename);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const { host, guest, path } = await pair(db);
  assert.match(host.code, /^[A-HJ-NP-Z2-9]{10}$/);
  assert.equal(host.ready, false);
  assert.equal(host.side, "w");
  assert.equal(host.revision, 0);
  assert.equal(guest.side, "b");
  assert.equal(guest.ready, true);
  assert.equal(guest.revision, 1);
  assert.notEqual(host.token, guest.token);
  assert.equal((await request(db, path + "/move", "POST", guest.token, {
    revision: 1, move: { from: 12, to: 28 },
  })).status, 409);
  const white = await request(db, path + "/move", "POST", host.token, {
    revision: 1, move: { from: 52, to: 36 },
  });
  assert.equal(white.status, 200);
  assert.equal(white.data.state.board[36], "P");
  assert.equal(white.data.log.length, 1);
  assert.equal(white.data.log[0].side, "w");
  assert.ok(white.data.log[0].label);
  const black = await request(db, path + "/move", "POST", guest.token, {
    revision: 2, move: { from: 12, to: 28 },
  });
  assert.equal(black.status, 200);
  assert.equal(black.data.state.turn, "w");
  db.close();
  db = openRoomStore(filename);
  const refresh = await request(db, path, "GET", host.token);
  assert.equal(refresh.status, 200);
  assert.deepEqual(refresh.data.state, black.data.state);
  assert.deepEqual(refresh.data.log, black.data.log);
  assert.equal(refresh.data.token, undefined);
  assert.equal(refresh.headers.get("Cache-Control"), "private, no-store");
  const resigned = await request(db, path + "/resign", "POST", guest.token, { revision: 3 });
  assert.deepEqual(resigned.data.outcome, { winner: "w", reason: "Resignation" });
  assert.equal((await request(db, path + "/move", "POST", host.token, {
    revision: 4, move: { from: 62, to: 45 },
  })).status, 409);
});

test("two simultaneous guests cannot claim the same seat, or retrieve each other's secret", async (t) => {
  const db = store(t);
  const { data: host } = await request(db, "", "POST");
  const path = "/" + host.code;
  const premature = await request(db, path + "/move", "POST", host.token, { revision: 0, move: { from: 52, to: 36 } });
  assert.equal(premature.status, 409);
  const claims = await Promise.all([
    request(db, path + "/join", "POST"), request(db, path + "/join", "POST"),
  ]);
  assert.deepEqual(claims.map(v => v.status).sort(), [200, 409]);
  const guest = claims.find(v => v.status === 200).data;
  const raw = await db.prepare("SELECT white_hash, black_hash FROM rooms WHERE code = ?").bind(host.code).first();
  assert.notEqual(raw.white_hash, host.token);
  assert.notEqual(raw.black_hash, guest.token);
  for (const candidate of [host, guest]) {
    const view = await request(db, path, "GET", candidate.token);
    assert.equal(view.status, 200);
    const body = JSON.stringify(view.data);
    for (const secret of [raw.white_hash, raw.black_hash, host.token, guest.token]) assert.ok(!body.includes(secret));
  }
  assert.equal((await request(db, path)).status, 403);
  assert.equal((await request(db, path, "GET", "invalid")).status, 403);
  const unrelatedHost = (await request(db, "", "POST")).data;
  assert.equal((await request(db, path, "GET", unrelatedHost.token)).status, 403);
  assert.equal((await request(db, path + "/resign", "POST", unrelatedHost.token, { revision: 1 })).status, 403);
  assert.equal((await request(db, "/AAAAAAAAAA", "GET", host.token)).status, 404);
});

test("caller-generated bearer recovers host creation and guest claiming after a lost response", async (t) => {
  const db = store(t);
  const whiteToken = "1".repeat(64), blackToken = "2".repeat(64);
  const host = (await request(db, "", "POST", whiteToken)).data;
  const retry = await request(db, "", "POST", whiteToken);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.data, host);
  const path = "/" + host.code;
  const hostJoin = await request(db, path + "/join", "POST", whiteToken);
  assert.equal(hostJoin.data.side, "w");
  assert.equal(hostJoin.data.revision, 0);
  const guest = await request(db, path + "/join", "POST", blackToken);
  const guestRetry = await request(db, path + "/join", "POST", blackToken);
  assert.deepEqual(guestRetry.data, guest.data);
  assert.equal(guestRetry.data.revision, 1);
});

test("only one simultaneous move is committed and the server computes all power costs", async (t) => {
  const db = store(t);
  const { host, guest, path } = await pair(db);
  const forged = await request(db, path + "/move", "POST", host.token, {
    revision: 1, move: { from: 52, to: 20, power: "n" }, state: { energy: { w: 100 } },
  });
  assert.equal(forged.status, 400);
  const action = {
    revision: 1, move: { from: 57, to: 41, power: "n", castle: "K" },
    state: { board: [], turn: "w", energy: { w: 100 } },
  };
  const raced = await Promise.all([request(db, path + "/move", "POST", host.token, action),
    request(db, path + "/move", "POST", host.token, action)]);
  assert.deepEqual(raced.map(v => v.status).sort(), [200, 409]);
  const view = await request(db, path, "GET", guest.token);
  assert.equal(view.data.state.turn, "b");
  assert.equal(view.data.state.energy.w, 2);
  assert.equal(view.data.state.board[41], "N");
  assert.equal(view.data.state.board[57], null);
  assert.equal(view.data.log[0].power, "n");
  assert.equal(view.data.log.length, 1);
  assert.equal(view.data.revision, 2);
  assert.equal((await request(db, path + "/resign", "POST", guest.token, { revision: 1 })).status, 409);
  assert.equal((await request(db, path + "/move", "POST", guest.token, { move: action.move })).status, 400);
});

test("server recognizes checkmate and refuses further play", async (t) => {
  const db = store(t);
  const { host, guest, path } = await pair(db);
  let revision = 1;
  let last;
  // Ordinary Fool's Mate has three power escapes. Casting Domain Expansion
  // puts those escapes on cooldown before Black plays Qh4#.
  for (const [token, from, to, power] of [
    [host.token, 53, 45], [guest.token, 12, 28], [host.token, 54, 38], [guest.token, 1, 18],
    [host.token, 60, 60, "k"], [guest.token, 3, 39],
  ]) {
    last = await request(db, path + "/move", "POST", token, { revision: revision++, move: { from, to, power } });
    assert.equal(last.status, 200);
  }
  assert.deepEqual(last.data.outcome, { winner: "b", reason: "Checkmate" });
  assert.equal((await request(db, path + "/move", "POST", host.token, {
    revision: last.data.revision, move: { from: 48, to: 40 },
  })).status, 409);
});
