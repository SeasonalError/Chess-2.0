import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, coord, keyOf, legalMoves, hasLegalMove, inCheck, applyMove, playLegal, result, labelMove, POWERS} from '../public/game/engine.js';

const sq = name => 'abcdefgh'.indexOf(name[0]) + (8 - Number(name[1]))*8;
const move = (from,to,extra = {}) => ({from:sq(from),to:sq(to),...extra});
function position(fen) {
  const [layout,turn = 'w',rights = '-',ep = '-'] = fen.split(' ');
  const board = [];
  for (const token of layout.replaceAll('/','')) {
    if (/\d/.test(token)) board.push(...Array(Number(token)).fill(null));
    else board.push(token);
  }
  assert.equal(board.length,64);
  return {...initialState(),board,turn,castling:rights === '-' ? '' : rights, ep:ep === '-' ? null : sq(ep)};
}
function play(state, from,to, extra) { return applyMove(state,move(from,to,extra)); }
function destinations(state, from, power) {
  return legalMoves(state).filter(m => m.from === sq(from) && m.power === power).map(m => coord(m.to)).sort();
}
function perft(state, depth) {
  const legal = legalMoves(state);
  if (depth === 1) return legal.length;
  return legal.reduce((total,m) => total + perft(playLegal(state,m),depth-1),0);
}
test('orthodox perft from the start and from Kiwipete', () => {
  for (const [state, expected] of [
    [initialState(),[20,400,8902]],
    [position('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -'),[48,2039,97862]],
  ]) {
    state.energy = {w:0,b:0};
    for (let depth = 1; depth <= 3; depth++) assert.equal(perft(state,depth),expected[depth-1]);
  }
});
test('every applied move is immutable, JSON-safe and uses trusted metadata', () => {
  const state = initialState(), before = JSON.stringify(state);
  const movements = legalMoves(state);
  for (const candidate of movements) {
    const after = applyMove(state,{...candidate,castle:'Q',enPassant:true});
    assert.deepEqual(after,playLegal(state,candidate));
    assert.deepEqual(JSON.parse(JSON.stringify(after)),after);
    assert.equal(inCheck(after,'w'),false);
  }
  assert.equal(JSON.stringify(state),before);
  assert.throws(() => play(state,'a2','a1',{power:'p'}));
  assert.throws(() => applyMove(state,{from:null,to:8}));
});
test('bishop phase can pass exactly one piece and stop at the first enemy beyond', () => {
  const state = position('7k/7p/6r1/8/4P3/3B4/8/K7');
  assert.deepEqual(destinations(state,'d3','b'),['f5','g6']);
  assert(!inCheck(state,'b'));
  const after = play(state,'d3','g6',{power:'b'});
  assert.equal(after.board[sq('e4')],'P');
  assert.equal(after.board[sq('g6')],'B');
  assert.equal(after.halfmove,0);
  assert.equal(after.energy.w,2);
});
test('a technique cannot capture the king or bypass ordinary check', () => {
  const blocked = position('7k/8/5p2/4B3/8/8/P7/K7');
  assert(!inCheck(blocked,'b'));
  assert(!destinations(blocked,'e5','b').includes('h8'));
  const pinned = position('4r2k/8/8/8/8/8/4N3/4K3');
  assert.deepEqual(destinations(pinned,'e2','n'),['e4']);
  assert(!destinations(pinned,'e2','n').includes('c2'));
  const checked = position('4r2k/8/8/8/8/8/P7/4K3');
  assert(inCheck(checked));
  assert.deepEqual(destinations(checked,'e1','k'),[]);
});
test('rook vault only clears the first friendly blocker and only to the next empty square', () => {
  let state = position('7k/8/3r4/8/1P1R1N2/3P4/8/K7');
  assert.deepEqual(destinations(state,'d4','r'),['a4','d2','g4']);
  state.board[sq('g4')] = 'p';
  assert(!destinations(state,'d4','r').includes('g4'));
});
test('knight and queen teleports have fixed range, ignore blockers and only land on empties', () => {
  let state = position('7k/8/3p4/8/3N4/8/8/K7');
  assert.deepEqual(destinations(state,'d4','n'),['b4','d2','f4']);
  state = position('7k/8/5p2/4P3/3Q4/8/8/K7');
  assert.deepEqual(destinations(state,'d4','q'),['b2','b6','f2']);
});
test('pawn can step sideways into empty squares but cannot double-step after doing so', () => {
  let state = position('7k/8/8/8/8/8/1PP5/K7');
  assert.deepEqual(destinations(state,'b2','p'),['a2']);
  state = play(state,'b2','a2',{power:'p'});
  state = play(state,'h8','h7');
  assert.deepEqual(destinations(state,'a2',undefined),['a3']);
  assert.throws(() => play(state,'a2','a4'));
});
test('techniques have independent per-side charges, type limits, and recovery turns', () => {
  let state = play(initialState(),'b1','b3',{power:'n'});
  assert.equal(state.energy.w,2);
  assert.deepEqual(state.spent.w,['n']);
  state = play(state,'g8','g6',{power:'n'});
  assert.equal(state.energy.b,2);
  assert(!legalMoves(state).some(m => m.power));
  state = play(state,'e2','e4');
  state = play(state,'e7','e5');
  assert(legalMoves(state).some(m => m.power === 'q'));
  assert(!legalMoves(state).some(m => m.power === 'n'));
  state = play(state,'e1','e1',{power:'k'});
  assert.equal(state.energy.w,0);
  assert.equal(state.energy.b,2);
  assert.equal(state.castling,'KQkq');
});
test('a domain restricts enemy landings for precisely one reply; directed attacks are unchanged', () => {
  let state = position('3r3k/8/8/8/4K3/8/P7/8');
  state = play(state,'e4','e4',{power:'k'});
  assert.deepEqual(state.domain,{side:'w',center:sq('e4')});
  assert(!destinations(state,'d8',undefined).includes('d5'));
  assert(destinations(state,'d8',undefined).includes('d6'));
  state = play(state,'d8','e8');
  assert.equal(state.domain,null);
  assert(inCheck(state));
  state = play(state,'e4','d4');
  assert(destinations(state,'e8',undefined).includes('e5'));
});
test('castling respects attacked transit squares, lost rights and powered rook captures', () => {
  let state = position('4k2r/8/8/8/8/8/8/4K2R w Kk -');
  const castle = legalMoves(state).find(m=>m.castle === 'K');
  assert(castle);
  assert.equal(labelMove(state,castle),'O-O');
  const after = playLegal(state,castle);
  assert.equal(after.board[sq('g1')],'K');
  assert.equal(after.board[sq('f1')],'R');
  assert.equal(after.castling,'k');
  state.board[sq('f8')] = 'r';
  assert(!legalMoves(state).some(m=>m.castle));
  state = position('4k2r/8/5P2/4B3/8/8/8/K7 w k -');
  state = play(state,'e5','h8',{power:'b'});
  assert.equal(state.castling,'');
  state = position('7k/8/8/8/8/8/7P/4K2R w K -');
  assert.equal(play(state,'h1','h3',{power:'r'}).castling,'');
});
test('en passant and promotion account for discovered attacks and all four promotion choices', () => {
  let state = position('4r2k/8/8/3pP3/8/8/8/4K3 w - d6');
  assert(!legalMoves(state).some(m=>m.enPassant));
  assert.equal(keyOf(state),keyOf({...state,ep:null}));
  state.board[sq('e8')] = null;
  let after = play(state,'e5','d6');
  assert.equal(after.board[sq('d5')],null);
  assert.equal(after.board[sq('d6')],'P');
  assert.equal(after.ep,null);
  assert.notEqual(keyOf(state),keyOf({...state,ep:null}));
  after = play(state,'e5','d6');
  assert.equal(after.halfmove,0);
  state = position('7k/P7/8/8/8/8/8/K7');
  assert.deepEqual(legalMoves(state).filter(m=>m.to===sq('a8')).map(m=>m.promotion).sort(),['b','n','q','r']);
  assert.throws(()=>play(state,'a7','a8'));
  assert.equal(play(state,'a7','a8',{promotion:'n'}).board[sq('a8')],'N');
});
test('stalemate, checkmate, draws, and move generation after terminal results', () => {
  let state = position('7k/5Q2/6K1/8/8/8/8/8 b - -');
  state.energy.b = 0;
  assert.deepEqual(result(state),{winner:null,reason:'Stalemate'});
  state = position('7k/6Q1/5K2/8/8/8/8/8 b - -');
  state.halfmove = 100;
  assert.deepEqual(result(state),{winner:'w',reason:'Checkmate'});
  state = position('7k/8/8/8/8/8/8/K7');
  assert.equal(result(state).reason,'Insufficient material');
  assert.throws(()=>play(state,'a1','b1'));
  state = initialState();
  state.halfmove = 100;
  assert.equal(result(state).reason,'Fifty-move rule');
  state = initialState();
  for (let i=0; i<2; i++) {
    state = play(state,'g1','f3');
    state = play(state,'g8','f6');
    state = play(state,'f3','g1');
    state = play(state,'f6','g8');
  }
  assert.equal(result(state).reason,'Threefold repetition');
});
test('a technique can escape an orthodox stalemate', () => {
  const state = position('7k/5Q2/6K1/8/8/8/8/8 b - -');
  assert.equal(legalMoves(state).length,1);
  assert.equal(legalMoves(state)[0].power,'k');
  assert.equal(result(state),null);
});
test('tactical generation includes power captures, promotions and all checked evasions', () => {
  const state = position('7k/P6p/6r1/8/4P3/3B4/8/K7');
  const q = legalMoves(state,{tacticalOnly:true});
  assert(q.some(m => m.power === 'b' && m.to === sq('g6')));
  assert.equal(q.filter(m => m.promotion).length,4);
  assert(q.every(m => m.promotion || m.enPassant || state.board[m.to]));
  const checked = position('4r2k/8/8/8/8/8/8/4K3');
  assert.deepEqual(legalMoves(checked,{tacticalOnly:true}),legalMoves(checked));
  assert.equal(hasLegalMove(checked),true);
  for (const p of Object.values(POWERS)) assert(p.name && p.description && p.cost);
});
