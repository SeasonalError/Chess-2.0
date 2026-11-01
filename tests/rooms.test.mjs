import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRoomStore } from "../lib/rooms-local.mjs";
import { handleRoomRequest } from "../lib/rooms.js";

function request(db, path = "", method = "GET", token, payload, now = 1000) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = new Request(`https://game.test/api/rooms${path}`, {
    method, headers, body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return handleRoomRequest(db, request, () => now).then(async response => ({
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
  const pending = (await request(db, path, "GET", guest.token)).data;
  assert.deepEqual(pending.state, guest.state);
  assert.deepEqual(pending.log, []);
  assert.deepEqual(Object.keys(pending.encounter).sort(), ["caster","deadline","id","phase"]);
  const body = {revision: 2, encounterId: pending.encounter.id, square: 0};
  assert.equal((await request(db, path + "/counter", "POST", host.token, body)).status, 403);
  assert.equal((await request(db, path + "/counter", "POST", guest.token, {...body, square: 64})).status, 400);
  assert.equal((await request(db, path + "/move", "POST", host.token, {...action, revision: 2})).status, 409);
  const guesses = await Promise.all([
    request(db, path + "/counter", "POST", guest.token, body),
    request(db, path + "/counter", "POST", guest.token, body),
  ]);
  assert.deepEqual(guesses.map(r => r.status).sort(), [200,409]);
  const view = await request(db, path, "GET", guest.token);
  assert.equal(view.data.state.counters.b, 1);
  assert.equal(view.data.state.turn, "b");
  assert.equal(view.data.state.energy.w, 2);
  assert.equal(view.data.state.board[41], "N");
  assert.equal(view.data.state.board[57], null);
  assert.equal(view.data.log[0].power, "n");
  assert.equal(view.data.log.length, 1);
  assert.equal(view.data.revision, 3);
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
    if (power) {
      last = await request(db, path + "/counter", "POST", guest.token, {
        revision: revision++, encounterId: last.data.encounter.id, square: null,
      });
      assert.equal(last.status, 200);
    }
  }
  assert.deepEqual(last.data.outcome, { winner: "b", reason: "Checkmate" });
  assert.equal((await request(db, path + "/move", "POST", host.token, {
    revision: last.data.revision, move: { from: 48, to: 40 },
  })).status, 409);
});

async function tribunal(db) {
  const seats = await pair(db);
  const {host,guest,path} = seats;
  for (const [side,revision,from,to,power] of [
    [host,1,51,35], [guest,2,11,27], [host,3,59,27,"q"],
  ]) {
    const r = await request(db, path + "/move", "POST", side.token, {revision,move:{from,to,power}});
    assert.equal(r.status, 200);
  }
  const pending = (await request(db, path, "GET", guest.token)).data;
  return {...seats,pending};
}

test("simultaneous ready signals and sequenced taps merge without replay or client-supplied scores", async t => {
  const db = store(t);
  const {host,guest,path,pending} = await tribunal(db);
  const encounterId = pending.encounter.id;
  const answer = await request(db, path + "/counter", "POST", guest.token, {
    revision:4, encounterId, square:null,
  });
  assert.equal(answer.data.encounter.phase, "duel");
  const payload = {revision:5, encounterId};
  const act = (name,token,body,now) => request(db, path + "/" + name,"POST",token,{...payload,...body},now);
  const ready = await Promise.all([act("ready",host.token,{},2000), act("ready",guest.token,{},2000)]);
  assert.deepEqual(ready.map(x=>x.status),[200,200]);
  const countdown = (await request(db,path,"GET",guest.token,undefined,2000)).data;
  assert.equal(countdown.encounter.startsAt,5000);
  assert.equal(countdown.encounter.endsAt,15000);
  assert.deepEqual(countdown.encounter.ready,{w:true,b:true});
  const batch = {seq:1,count:4, score:1e8, now:10000, winner:"w"};
  assert.equal((await act("tap",host.token,batch,4000)).status,409);
  assert.equal((await act("tap",host.token,{...batch,encounterId:"other"},5100)).status,409);
  assert.equal((await act("tap",host.token,{...batch,count:999},5100)).status,400);
  assert.equal((await act("tap",host.token,{...batch,seq:2},5100)).status,409);
  const taps = await Promise.all([
    act("tap",host.token,batch,5100),act("tap",guest.token,batch,5100),act("tap",guest.token,batch,5100),
  ]);
  assert.deepEqual(taps.map(r=>r.status),[200,200,200]);
  const current = (await request(db,path,"GET",guest.token,undefined,5100)).data;
  assert.deepEqual(current.encounter.scores,{w:2,b:2});
  assert.deepEqual(current.encounter.lastSeq,{w:1,b:1});
  assert.equal(current.revision,9);
  const extra = await act("tap",host.token,{seq:2,count:4},5600);
  assert.equal(extra.data.encounter.scores.w,6);
  assert.equal((await act("tap",guest.token,{seq:2,count:1},15000)).status,409);
  const finished = (await request(db,path,"GET",host.token,undefined,16000)).data;
  assert.equal(finished.encounter,null);
  assert.equal(finished.state.board[59],"Q");
  assert.equal(finished.state.board[27],null);
  assert.equal(finished.log.length,3);
  assert.deepEqual(finished.log[2].duel,{scores:{w:6,b:2},winner:"w"});
  assert.equal(finished.revision,11);
});

test("idle reconnect resolves expired reaction and duel exactly once; legacy boards load", async t => {
  const db = store(t);
  const {host,guest,path,pending} = await tribunal(db);
  const polls = await Promise.all([host,guest].map(seat=>request(db,path,"GET",seat.token,undefined,50000)));
  for (const {data} of polls) {
    assert.equal(data.revision,5);
    assert.equal(data.encounter,null);
    assert.equal(data.state.board[59],null);
    assert.equal(data.state.board[27],"p");
    assert.equal(data.state.counters.b,2);
    assert.equal(data.log[2].duel.winner,"b");
  }
  const late = await request(db,path + "/counter","POST",guest.token,{
    revision:4, encounterId:pending.encounter.id, square:27,
  },50000);
  assert.equal(late.status,409);
  const legacy = structuredClone(host.state);
  delete legacy.counters;
  await db.prepare("UPDATE rooms SET state = ?, log = '[]' WHERE code = ? RETURNING code").bind(JSON.stringify(legacy),host.code).first();
  const resumed = (await request(db,path,"GET",host.token)).data;
  assert.deepEqual(resumed.state.counters,{w:2,b:2});
  assert.equal(resumed.encounter,null);
  assert.equal((await request(db,path + "/move","POST",host.token,{
    revision:resumed.revision, move:{from:52,to:36},
  })).status,200);
});

test("reopening the database mid-cast restores only the public blind prompt until the defending seat answers", async t => {
  const dir = mkdtempSync(join(tmpdir(),"riftbound-seal-"));
  const filename = join(dir,"room.db");
  let db = openRoomStore(filename);
  t.after(()=>{db.close();rmSync(dir,{recursive:true,force:true});});
  const {host,guest,path} = await pair(db);
  const cast = await request(db,path + "/move","POST",host.token,{
    revision:1,move:{from:57,to:41,power:"n"},
  },2000);
  db.close();
  db = openRoomStore(filename);
  const restored = (await request(db,path,"GET",guest.token,undefined,10000)).data;
  assert.deepEqual(restored.encounter,cast.data.encounter);
  assert.deepEqual(restored.state,guest.state);
  assert.equal(restored.log.length,0);
  const solved = await request(db,path + "/counter","POST",guest.token,{
    revision:restored.revision,encounterId:restored.encounter.id,square:41,
  },10500);
  assert.equal(solved.status,200);
  assert.equal(solved.data.log[0].resolution,"countered");
  assert.equal(solved.data.state.board[57],"N");
  assert.equal(solved.data.state.counters.b,1);
});
