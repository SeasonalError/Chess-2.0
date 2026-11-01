import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, coord, keyOf, legalMoves, hasLegalMove, inCheck, applyMove, playLegal, result, labelMove, resolveCast, counterCount, POWERS} from '../public/game/engine.js';

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
test('Aegis targets allied non-kings within three orthogonal squares, including beyond blockers', () => {
  const state = position('7k/3P4/3r4/8/N2R1N2/3P4/8/3K4');
  assert.deepEqual(destinations(state,'d4','r'),['a4','d3','d7','f4']);
  const after = play(state,'d4','d7',{power:'r'});
  assert.deepEqual(after.board,state.board);
  assert.deepEqual(after.shield,{side:'w',square:sq('d7')});
  assert.equal(after.halfmove,1);
  assert.equal(after.energy.w,2);
});
test('Aegis blocks normal, en passant, Phase Lance and Tribunal captures but leaves checks unchanged', () => {
  const state = position('7k/8/p7/1b6/2p5/3P3q/1R6/K7 b - -');
  const original = destinations(state,'h3','q');
  assert(original.includes('d3'));
  assert(destinations(state,'b5','b').includes('d3'));
  assert(destinations(state,'c4',undefined).includes('d3'));
  state.shield = {side:'w',square:sq('d3')};
  assert(!destinations(state,'h3','q').includes('d3'));
  assert(!destinations(state,'b5','b').includes('d3'));
  assert(!destinations(state,'c4',undefined).includes('d3'));
  const replied = play(state,'a6','a5');
  assert.equal(replied.shield,null);
  const ep = position('7k/8/8/3pP3/8/8/8/K7 w - d6');
  assert(legalMoves(ep).some(m=>m.enPassant));
  ep.shield = {side:'b',square:sq('d5')};
  assert(!legalMoves(ep).some(m=>m.enPassant));
  assert.equal(keyOf(ep),keyOf({...ep,ep:null}));
  const checked = position('7k/8/8/8/8/8/r7/K7');
  checked.shield = {side:'b',square:sq('a2')};
  assert(inCheck(checked));
  assert(!destinations(checked,'a1',undefined).includes('a2'));
});
test('knight teleport has fixed range, ignores blockers and only lands on empty squares', () => {
  const state = position('7k/8/3p4/8/3N4/8/8/K7');
  assert.deepEqual(destinations(state,'d4','n'),['b4','d2','f4']);
});
test('Tribunal targets only an enemy non-king within four orthogonal squares, through blockers', () => {
  const state = position('3r3k/8/3P4/7p/N2Qp2n/8/8/K7');
  assert.deepEqual(destinations(state,'d4','q'),['d8','e4','h4']);
  state.board[sq('h4')] = 'k';
  state.board[sq('h8')] = 'p';
  assert(!destinations(state,'d4','q').includes('h4'));
  const far = position('7k/8/8/1Q4n1/8/8/8/K7');
  assert(!destinations(far,'b5','q').includes('g5'));
});
test('Tribunal is forbidden if either the loss or the win would expose the caster king', () => {
  const pinnedQueen = position('4r2k/8/8/8/8/8/4Q2p/4K3');
  assert(!inCheck(pinnedQueen));
  assert(!destinations(pinnedQueen,'e2','q').includes('h2'));
  const pinnedVictim = position('4r2k/8/8/8/8/Q3n3/8/4K3');
  assert(!inCheck(pinnedVictim));
  assert(!destinations(pinnedVictim,'a3','q').includes('e3'));
  const checked = position('4r2k/8/8/8/8/3P4/2N5/4K3');
  assert(inCheck(checked));
  assert(!legalMoves(checked).some(m=>m.power));
});
test('Tribunal has distinct win, loss and cancellation transitions without moving its pieces', () => {
  const state = position('4k2r/8/7p/8/7Q/8/8/K7 w k -');
  state.halfmove = 22;
  const cast = legalMoves(state).find(m=>m.power==='q' && m.to===sq('h8'));
  assert(cast);
  const snapshot = JSON.stringify(state);
  const win = resolveCast(state,cast);
  assert.deepEqual(win,playLegal(state,cast));
  assert.equal(win.board[cast.from],'Q');
  assert.equal(win.board[cast.to],null);
  assert.equal(win.castling,'');
  assert.equal(win.halfmove,0);
  const lost = resolveCast(state,cast,{queenWon:false,counterSpent:true});
  assert.equal(lost.board[cast.from],null);
  assert.equal(lost.board[cast.to],'r');
  assert.equal(lost.castling,'k');
  assert.equal(lost.halfmove,0);
  const stopped = resolveCast(state,cast,{countered:true,counterSpent:true});
  assert.deepEqual(stopped.board,state.board);
  assert.equal(stopped.castling,'k');
  assert.equal(stopped.halfmove,23);
  for (const after of [win,lost,stopped]) {
    assert.equal(after.turn,'b');
    assert.deepEqual(after.spent.w,['q']);
    assert.equal(after.energy.w,1);
    assert.equal(after.cooldown.w,true);
    assert.deepEqual(after.history,[]);
  }
  assert.equal(win.counters.b,2);
  assert.equal(lost.counters.b,1);
  assert.equal(stopped.counters.b,1);
  assert.equal(JSON.stringify(state),snapshot);
});
test('countering a pawn preserves its prior status and expires transient effects', () => {
  const state = position('7k/8/8/8/8/8/1P6/K7 w - f6');
  state.halfmove = 17;
  state.domain = {side:'b',center:sq('h8')};
  state.shield = {side:'b',square:sq('g7')};
  const cast = legalMoves(state).find(m=>m.power==='p');
  const next = resolveCast(state,cast,{countered:true,counterSpent:true});
  assert.deepEqual(next.board,state.board);
  assert.deepEqual(next.pawnNoDouble,state.pawnNoDouble);
  assert.equal(next.halfmove,18);
  assert.equal(next.ep,null);
  assert.equal(next.shield,null);
  assert.equal(next.domain,null);
  assert.deepEqual(next.counters,{w:2,b:1});
  const reply = play(next,'h8','h7');
  assert(destinations(reply,'b2',undefined).includes('b4'));
  assert.throws(()=>resolveCast({...state,counters:{w:1,b:0}},cast,{counterSpent:true}));
});
test('legacy states get two counters per side, no shield and compatible repetition keys', () => {
  const state = initialState();
  const old = {...state};
  delete old.shield;
  delete old.counters;
  assert.equal(counterCount(old,'b'),2);
  assert.equal(keyOf(old),keyOf(state));
  assert.deepEqual(legalMoves(old),legalMoves(state));
  const cast = legalMoves(old).find(m=>m.power==='n');
  const next = resolveCast(old,cast,{countered:true,counterSpent:true});
  assert.deepEqual(next.counters,{w:2,b:1});
  assert.equal(next.shield,null);
  assert.notEqual(keyOf({...old,counters:{w:1,b:2}}),keyOf(old));
  assert.notEqual(keyOf({...old,shield:{side:'b',square:sq('g8')}}),keyOf(old));
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
  assert(legalMoves(state).some(m => m.power === 'b'));
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
  assert.equal(play(state,'h1','h2',{power:'r'}).castling,'K');
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
