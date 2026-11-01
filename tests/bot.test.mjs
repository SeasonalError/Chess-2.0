import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, legalMoves, playLegal, resolveCast, result } from '../public/game/engine.js';
import { chooseCounterSquare, duelTapSchedule, findBestMove } from '../public/game/bot.js';

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
