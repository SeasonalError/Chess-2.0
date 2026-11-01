import assert from 'node:assert/strict';
import test from 'node:test';
import { WILDCARDS, initialState, legalMoves, playLegal, redactWildcardState, resolveCast, result, wildcardMoves } from '../public/game/engine.js';
import { chooseCounterSquare, chooseDraftCard, duelTapSchedule, findBestMove } from '../public/game/bot.js';

function position(layout, { white = 3, black = 3, turn = 'w' } = {}) {
  const state = initialState();
  state.board = layout.split('/').flatMap(rank => [...rank].flatMap(piece =>
    /[1-8]/.test(piece) ? Array(Number(piece)).fill(null) : [piece]));
  assert.equal(state.board.length, 64);
  return {...state, turn, castling:'', energy:{w:white,b:black}};
}

test('each difficulty returns a legal move without changing the supplied board', () => {
  const state = initialState(), original = structuredClone(state);
  for (const level of ['easy', 'medium', 'hard']) {
    const answer = findBestMove(state,level,{timeMs:150,maxDepth:2});
    assert.ok(legalMoves(state).some(move => JSON.stringify(move) === JSON.stringify(answer.move)));
    assert.deepEqual(state,original);
  }
  assert.ok(findBestMove(state,'hard',{timeMs:0}).move, 'expired budget has a legal fallback');
});

test('distinguishes a forced Rift Jump mate from one exposed to a counter', () => {
  const state = position('6rk/3N2pp/8/8/8/8/8/K7');
  const mate = legalMoves(state).filter(m => result(playLegal(state,m))?.winner === 'w');
  assert.deepEqual(mate, [{from:11,to:13,power:'n'}]);
  const contested = findBestMove(state,'medium',{maxDepth:3});
  assert.deepEqual(contested.move,mate[0]);
  state.counters.b = 0;
  const forced = findBestMove(state,'medium',{maxDepth:3});
  assert.deepEqual(forced.move,mate[0]);
  assert.ok(forced.score > 29000);
  assert.ok(contested.score < forced.score / 2);
});

test('defends against an opponent’s otherwise lethal Rift Jump', () => {
  const state = position('6rk/p2N2pp/8/8/8/8/8/K7',{turn:'b'});
  const matingReplies = position => legalMoves(position).filter(reply =>
    result(playLegal(position,reply))?.winner === 'w');
  const blunder = playLegal(state,{from:8,to:16});
  assert.deepEqual(matingReplies(blunder), [{from:11,to:13,power:'n'}]);
  const answer = findBestMove(state,'medium',{maxDepth:4});
  assert.deepEqual(matingReplies(playLegal(state,answer.move)), []);
});

test('wins a queen using Phase Lance through a friendly knight', () => {
  const state = position('6k1/8/8/5q2/4N3/3B4/8/K7');
  const answer = findBestMove(state,'hard',{timeMs:1500,maxDepth:4});
  assert.deepEqual(answer.move, {from:43,to:29,power:'b'});
});

test('finds a forced ordinary mate in two after both players expend their powers', () => {
  const state = position('7k/8/5K2/8/Q7/8/8/8',{white:0,black:0});
  const choices = legalMoves(state);
  assert.ok(!choices.some(m => result(playLegal(state,m))?.winner === 'w'));
  const choice = findBestMove(state,'medium');
  const black = playLegal(state,choice.move), replies = legalMoves(black);
  assert.ok(replies.length);
  for (const reply of replies) {
    const white = playLegal(black,reply);
    assert.ok(legalMoves(white).some(m => result(playLegal(white,m))?.winner === 'w'));
  }
});

test('handles terminal boards and underpromotes to avoid immediate stalemate', () => {
  const lost = position('7k/6Q1/5K2/8/8/8/8/8',{turn:'b'});
  assert.equal(findBestMove(lost).move,null);
  const draw = position('7k/8/5K2/8/8/8/8/8');
  assert.equal(findBestMove(draw).move,null);
  const promotion = position('8/1P6/8/8/8/8/5K2/7k',{white:0,black:0});
  const choice = findBestMove(promotion,'medium',{maxDepth:4});
  assert.equal(result(playLegal(promotion,{...choice.move,promotion:'q'}))?.reason,'Stalemate');
  assert.equal(choice.move.promotion,'r');
});

test('sealed guesses use only public board and infer a priority threat across many possible destinations', () => {
  const state = position('6rk/3N2pp/8/8/8/8/8/K7');
  const options = new Set(legalMoves(state).filter(m => m.power).map(m => m.to));
  assert.ok(options.size > 2);
  function sample(seed) {
    return () => ((seed = (Math.imul(1664525,seed) + 1013904223) >>> 0) / 2 ** 32);
  }
  const rng = sample(2);
  const guesses = Array.from({length:200}, () => chooseCounterSquare(state,'hard',rng));
  assert.ok(guesses.every(square => square === null || options.has(square)));
  assert.ok(guesses.filter(square => square === 13).length > 135, 'locates the mating f7 jump');
  assert.ok(guesses.some(square => square !== 13), 'can guess wrong or pass');
  assert.equal(chooseCounterSquare(state,'hard',() => 0.999),null, 'can conserve the counter');
  state.counters.b = 0;
  assert.equal(chooseCounterSquare(state,'hard',() => 0),null);
  state.counters.b = 2;
  state.energy.w = 0;
  assert.equal(chooseCounterSquare(state,'hard',() => 0),null);
});

test('declines a risky Tribunal for a nominally free queen but challenges when it can unmask mate', () => {
  const safe = position('k7/8/8/4q3/4P3/8/4Q3/7K',{white:2,black:0});
  safe.counters.b = 0;
  const takeQueen = legalMoves(safe).find(m => m.power === 'q' && safe.board[m.to] === 'q');
  assert.ok(takeQueen);
  assert.equal(resolveCast(safe,takeQueen,{queenWon:true}).board[takeQueen.to],null);
  assert.equal(resolveCast(safe,takeQueen,{queenWon:false}).board[takeQueen.from],null);
  assert.notEqual(findBestMove(safe,'hard',{maxDepth:3,timeMs:1500}).move.power,'q');

  const tactic = position('k6r/rpQ5/8/8/8/8/8/R3K3',{white:2,black:0});
  tactic.counters.b = 0;
  const answer = findBestMove(tactic,'hard',{maxDepth:3,timeMs:1500});
  assert.deepEqual(answer.move,{from:10,to:8,power:'q'});
  assert.equal(result(resolveCast(tactic,answer.move,{queenWon:true}))?.winner,'w');
  assert.equal(result(resolveCast(tactic,answer.move,{queenWon:false})),null);
  assert.ok(answer.score > 0 && answer.score < 29000, 'values a chance of mate below a forced mate');
});

test('tap schedules allow human reaction, scale by level and obey the shared rate cap', () => {
  let previousTotal = 0;
  for (const level of ['easy','medium','hard']) {
    const taps = duelTapSchedule(level,10000,() => 0.5);
    assert.ok(taps[0] >= 300 && taps.at(-1) > 9000 && taps.at(-1) < 10000);
    assert.ok(taps.length > previousTotal);
    previousTotal = taps.length;
    const fastest = duelTapSchedule(level,10000,() => 0);
    assert.ok(fastest.length <= 70);
    for (let i = 1; i < fastest.length; i++) assert.ok(fastest[i] - fastest[i-1] >= 145);
  }
  assert.deepEqual(duelTapSchedule('hard',200),[]);
});


test('the open draft can choose all six cards and selects a viable card in sparse positions', () => {
  const starting = initialState(), before = structuredClone(starting);
  const choices = new Set(Array.from({length:36},(_,i) => chooseDraftCard(starting,'hard',() => i/36,'b')));
  assert.deepEqual(choices,new Set(Object.keys(WILDCARDS)));
  assert.deepEqual(starting,before);
  const sparse = position('7k/8/8/8/8/8/8/K6R');
  for (const random of [0,0.2,0.6,0.99]) {
    assert.ok(['kamui','noble','trade'].includes(chooseDraftCard(sparse,'hard',() => random)));
  }
});

test('saves opening cards instead of spending them for cosmetic changes', () => {
  const state = initialState(), before = structuredClone(state);
  for (const card of Object.keys(WILDCARDS)) {
    const answer = findBestMove(state,'easy',{wildcard:card,maxDepth:2,timeMs:1200});
    assert.equal(answer.move.wildcard,undefined);
    assert.ok(legalMoves(state).some(move => JSON.stringify(move) === JSON.stringify(answer.move)));
  }
  assert.deepEqual(state,before);
});

test('uses Relay or Kamui when the one-shot card delivers otherwise unavailable mate', () => {
  for (const [card,layout] of [
    ['relay','6rk/5Ppp/4N3/8/8/8/8/K7'],
    ['kamui','k6r/rpQ5/8/8/8/8/8/R3K3'],
  ]) {
    const state = position(layout,{white:0,black:0});
    assert.ok(!legalMoves(state).some(move => result(playLegal(state,move))?.winner === 'w'));
    const answer = findBestMove(state,'hard',{wildcard:card,maxDepth:3,timeMs:1200});
    assert.equal(answer.move.wildcard,card);
    assert.ok(wildcardMoves(state,card).some(move => JSON.stringify(move) === JSON.stringify(answer.move)));
    assert.equal(result(playLegal(state,answer.move))?.winner,'w');
    const withoutCard = findBestMove(state,'easy',{maxDepth:1});
    assert.equal(withoutCard.move.wildcard,undefined);
    assert.ok(withoutCard.score < 29000);
  }
});

test('a borrowed Royal Tribunal stakes the cheap carrier and is worth using against a queen', () => {
  const state = position('7k/8/8/8/8/8/P3q3/Q6K',{white:2,black:0});
  state.counters.b = 0;
  state.wild.trades = {48:'q',56:'p'};
  const answer = findBestMove(state,'hard',{maxDepth:3,timeMs:1200});
  assert.deepEqual(answer.move,{from:48,to:52,power:'q'});
  const loss = resolveCast(state,answer.move,{queenWon:false});
  assert.equal(loss.board[48],null);
  assert.equal(loss.board[56],'Q');
  assert.ok(answer.score > 0);
});

test('search and counter predictions ignore the opponent’s private trade assignments', () => {
  const base = position('6rk/3N2pp/8/8/8/8/8/K7');
  const secretlyTraded = structuredClone(base);
  secretlyTraded.wild.trades = {6:'q',14:'r'};
  const searchOptions = {maxDepth:2,timeMs:1200};
  assert.deepEqual(findBestMove(base,'medium',searchOptions),findBestMove(secretlyTraded,'medium',searchOptions));
  const casting = position('7k/8/8/8/8/8/P3q3/Q6K',{white:2,black:0});
  const hidden = structuredClone(casting);
  hidden.wild.trades = {48:'q',56:'p'};
  for (const random of [0.02,0.3,0.8]) {
    assert.equal(chooseCounterSquare(casting,'hard',() => random),chooseCounterSquare(hidden,'hard',() => random));
  }
});

test('the normal worker entry point forwards the privately equipped wildcard', async () => {
  const state = position('6rk/5Ppp/4N3/8/8/8/8/K7',{white:0,black:0});
  let answer;
  globalThis.self = {postMessage: value => { answer = value; }};
  try {
    await import('../public/game/bot-worker.js?wildcard-test');
    self.onmessage({data:{id:19,state,level:'easy',wildcard:'relay'}});
    assert.equal(answer.id,19);
    assert.equal(answer.move.wildcard,'relay');
    assert.equal(result(playLegal(state,answer.move))?.winner,'w');
  } finally {
    delete globalThis.self;
  }
});

test('the bot recognizes threefold repetition after receiving a seat-filtered position', () => {
  let state = initialState();
  for (let n = 0; n < 2; n++) {
    for (const [from,to] of [[62,45],[6,21],[45,62],[21,6]]) {
      const move = legalMoves(state).find(m => m.from === from && m.to === to && !m.power);
      state = playLegal(state,move);
    }
  }
  const publicPosition = redactWildcardState(state,state.turn);
  assert.equal(result(publicPosition)?.reason,'Threefold repetition');
  const answer = findBestMove(publicPosition,'hard',{wildcard:'trade'});
  assert.equal(answer.move,null);
  assert.equal(answer.nodes,0);
});
