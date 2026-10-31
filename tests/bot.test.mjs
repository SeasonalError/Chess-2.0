import assert from 'node:assert/strict';
import test from 'node:test';
import { initialState, legalMoves, playLegal, result } from '../public/game/engine.js';
import { findBestMove } from '../public/game/bot.js';

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

test('finds a smothered mate only available through Rift Jump', () => {
  const state = position('6rk/3N2pp/8/8/8/8/8/K7');
  const mate = legalMoves(state).filter(m => result(playLegal(state,m))?.winner === 'w');
  assert.deepEqual(mate, [{from:11,to:13,power:'n'}]);
  const answer = findBestMove(state,'medium');
  assert.deepEqual(answer.move, mate[0]);
  assert.ok(answer.score > 29000);
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
