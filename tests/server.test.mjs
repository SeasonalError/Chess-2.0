import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('standalone HTTP arena keeps a cast secret, resolves a pass and synchronizes the reply', async t => {
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', ROOM_DB: ':memory:'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (server.exitCode !== null) return;
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  });
  const [line] = await once(server.stdout, 'data');
  const port = String(line).match(/port (\d+)/)?.[1];
  assert.ok(port);
  const base = 'http://127.0.0.1:' + port;
  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Duel Arena/);
  for (const path of ['/game/arena.js','/art/pieces.svg','/game/bot-worker.js']) {
    assert.equal((await fetch(base + path)).status, 200);
  }
  async function request(path, method, seat, body) {
    const res = await fetch(base + '/api/rooms' + path, {
      method, headers: {...(seat ? {Authorization: 'Bearer ' + seat} : {}), 'Content-Type': 'application/json'},
      ...(body ? {body: JSON.stringify(body)} : {}),
    });
    assert.ok(res.ok, 'request status ' + res.status);
    return res.json();
  }
  const host = await request('', 'POST', null, {});
  const path = '/' + host.code;
  const guest = await request(path + '/join', 'POST', null, {});
  await request(path + '/draft', 'POST', host.token, {revision:guest.revision, card:'noble'});
  const locked = await request(path + '/draft', 'POST', guest.token, {revision:guest.revision, card:'trade'});
  assert.equal(locked.draft.phase,'playing');
  assert.equal(locked.draft.card,'trade');
  await request(path + '/move', 'POST', host.token, {revision: locked.revision, move: {from:57, to:41, power:'n'}});
  const pending = await request(path, 'GET', guest.token);
  assert.equal(pending.encounter.phase, 'counter');
  assert.equal(pending.state.board[57], 'N');
  assert.equal(pending.state.board[41], null);
  assert.equal(pending.log.length, 0);
  assert.equal(pending.encounter.from, undefined);
  assert.equal(pending.encounter.to, undefined);
  const seen = await request(path + '/counter', 'POST', guest.token, {
    revision: pending.revision, encounterId: pending.encounter.id, square: null,
  });
  assert.equal(seen.state.board[41], 'N');
  assert.equal(seen.state.energy.w, 2);
  await request(path + '/move', 'POST', guest.token, {revision: seen.revision, move: {from:12, to:28}});
  const update = await request(path, 'GET', host.token);
  assert.equal(update.state.board[28], 'p');
  assert.equal(update.log.length, 2);
});

test('Pages uses the hosted room API with authorization preflights and readable errors', async () => {
  const {pagesOrigin, roomApiBase} = await import('../public/game/hosting.js');
  const {handleRoomRequest} = await import('../lib/rooms.js');
  const url = roomApiBase(pagesOrigin) + '/AAAAAAAAAA';
  assert.equal(new URL(url).origin, 'https://riftbound-chess-arena.nimeesh16-2007.chatgpt.site');
  assert.equal(roomApiBase('http://localhost:3000'), '/api/rooms');
  const preflight = origin => handleRoomRequest(null, new Request(url, {method:'OPTIONS', headers:{
    Origin:origin, 'Access-Control-Request-Method':'GET', 'Access-Control-Request-Headers':'authorization,content-type',
  }}));
  const allowed = await preflight(pagesOrigin);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), pagesOrigin);
  assert.match(allowed.headers.get('Access-Control-Allow-Headers'), /Authorization/i);
  const denied = await preflight('https://example.net');
  assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  const invalidSeat = await handleRoomRequest(null, new Request(url, {headers:{Origin:pagesOrigin}}));
  assert.equal(invalidSeat.status, 403);
  assert.equal(invalidSeat.headers.get('Access-Control-Allow-Origin'), pagesOrigin);
});
