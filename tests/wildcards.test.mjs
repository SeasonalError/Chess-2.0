import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,legalMoves,playLegal,applyMove,resolveCast,coord,keyOf,inCheck,result,
  wildcardMoves,WILDCARDS,powerAt,redactWildcardState,labelMove} from '../public/game/engine.js';

const sq = name => 'abcdefgh'.indexOf(name[0]) + (8-Number(name[1]))*8;
const mv = (a,b,extra={})=>({from:sq(a),to:sq(b),...extra});
function position(fen) {
  const [layout,turn='w',rights='-'] = fen.split(' ');
  const board=[];
  for(const c of layout.replaceAll('/','')) {
    if (/\d/.test(c)) board.push(...Array(+c).fill(null)); else board.push(c);
  }
  assert.equal(board.length,64);
  return {...initialState(),board,turn,castling:rights==='-'?'':rights};
}
function card(s,id,from,to=from) {
  const m=wildcardMoves(s,id).find(m=>m.from===sq(from)&&m.to===sq(to));
  assert(m,`Missing ${id} ${from} ${to}`);
  return playLegal(s,m);
}
function play(s,a,b,extra) {return applyMove(s,mv(a,b,extra));}
function hasCard(s,id,from,to=from) {
  return wildcardMoves(s,id).some(m=>m.from===sq(from)&&m.to===sq(to));
}

test('six cards are independent of draft, unavailable in check, and cost a turn without recharging',()=>{
  assert.deepEqual(Object.keys(WILDCARDS),['kamui','noble','trade','freeze','repulse','relay']);
  const original=initialState();
  assert(!legalMoves(original).some(m=>m.wildcard));
  original.cooldown.w=true; original.halfmove=7; original.ep=sq('e6');
  const next=card(original,'noble','b1');
  assert.equal(next.turn,'b'); assert.equal(next.halfmove,8); assert.equal(next.ep,null);
  assert.deepEqual(next.energy,original.energy);
  assert.deepEqual(next.spent,original.spent);
  assert.deepEqual(next.counters,original.counters);
  assert.equal(next.cooldown.w,true);
  const checked=position('4r2k/8/8/8/8/8/P7/4K3');
  for(const id of Object.keys(WILDCARDS)) assert.deepEqual(wildcardMoves(checked,id),[]);
});

test('Kamui reserves an empty square, permits passing rays and returns after exactly two subsequent actions',()=>{
  let s=position('7k/8/8/8/b7/8/8/R5K1');
  s=card(s,'kamui','a4');
  assert.equal(s.board[sq('a4')],null);
  assert.deepEqual(s.wild.exiles,[{square:sq('a4'),piece:'b',remaining:2}]);
  s=play(s,'h8','g8');
  assert.equal(s.wild.exiles[0].remaining,1);
  assert(!legalMoves(s).some(m=>m.from===sq('a1')&&m.to===sq('a4')));
  assert(legalMoves(s).some(m=>m.from===sq('a1')&&m.to===sq('a5')));
  s=play(s,'a1','a5');
  assert.equal(s.board[sq('a4')],'b');
  assert.deepEqual(s.wild.exiles,[]);
});

test('Kamui cannot expose its own king, and return safety applies to ordinary moves and every cast outcome',()=>{
  const pin=position('4r2k/8/8/8/4R3/8/8/4K3');
  assert(!hasCard(pin,'kamui','e4'));
  const s=position('7k/8/8/8/8/2N5/8/K7');
  s.wild.exiles=[{square:sq('a8'),piece:'r',remaining:1}];
  assert(!legalMoves(s).some(m=>m.from===sq('c3') && m.power));
  assert(!legalMoves(s).some(m=>m.from===sq('c3') && m.to===sq('d5')));
  assert(legalMoves(s).some(m=>m.from===sq('c3') && m.to===sq('a2')));
  assert(legalMoves(s).some(m=>m.from===sq('a1')&&m.to===sq('b1')));
  assert.equal(wildcardMoves(s,'noble').length,0);
  const after=play(s,'a1','b1');
  assert.equal(after.board[sq('a8')],'r'); assert(!inCheck(after,'w'));
});

test('Kamui clock advances on subsequent wildcard actions',()=>{
  let s=position('7k/7p/8/8/8/8/8/KR6');
  s=card(s,'kamui','b1');
  s=card(s,'noble','h7');
  assert.equal(s.wild.exiles[0].remaining,1);
  s=play(s,'a1','a2');
  assert.equal(s.board[sq('b1')],'R');
});

test('Kamui does not declare bare kings while a rook is returning and resolves on countered casts',()=>{
  let s=position('7k/8/8/8/8/8/8/KR6');
  s=card(s,'kamui','b1');
  assert.equal(result(s),null);
  s=play(s,'h8','h7');
  const cast=legalMoves(s).find(m=>m.power==='k');
  assert(cast);
  s=resolveCast(s,cast,{countered:true,counterSpent:true});
  assert.equal(s.board[sq('b1')],'R');
  assert.equal(s.wild.exiles.length,0);
  assert.deepEqual(s.counters,{w:2,b:1});
});

test('Noble blocks enemy techniques/cards but permits ordinary capture and travels with its piece',()=>{
  let s=position('7k/8/8/8/8/q2R4/4P3/7K');
  s=card(s,'noble','d3');
  assert(!legalMoves(s).some(m=>m.power==='q'&&m.to===sq('d3')));
  assert(legalMoves(s).some(m=>!m.power&&m.from===sq('a3')&&m.to===sq('d3')));
  for(const id of ['kamui','freeze']) assert(!hasCard(s,id,'d3'));
  s=play(s,'h8','h7');
  s=play(s,'d3','d4');
  assert(s.wild.noble.includes(sq('d4'))); assert(!s.wild.noble.includes(sq('d3')));
});

test('Trade follows carrier identity, preserves normal moves and never refreshes spent type charges',()=>{
  let s=initialState();
  s.spent.w=['b'];
  s=card(s,'trade','b2','c1');
  assert.equal(powerAt(s,sq('b2')),'b'); assert.equal(powerAt(s,sq('c1')),'p');
  s=play(s,'a7','a6');
  assert(!legalMoves(s).some(m=>m.from===sq('b2')&&m.power==='b'));
  s=play(s,'b2','b3');
  assert.equal(powerAt(s,sq('b3')),'b');
  assert.equal(powerAt(s,sq('b2')),null);
  assert.equal(s.wild.trades[sq('b2')],undefined);
});

test('a pawn borrowing Phase Lance strikes the promotion rank and rebounds with no new double step',()=>{
  let s=card(initialState(),'trade','b2','c1');
  s=play(s,'a7','a6');
  const cast=legalMoves(s).find(m=>m.from===sq('b2')&&m.to===sq('h8')&&m.power==='b');
  assert(cast);
  const before=JSON.stringify(s);
  const canceled=resolveCast(s,cast,{countered:true,counterSpent:true});
  assert.equal(canceled.board[sq('h8')],'r');
  assert.equal(canceled.board[sq('b2')],'P');
  assert(!canceled.wild.pawnLocks.includes(sq('b2')));
  s=playLegal(s,cast);
  assert.equal(s.board[sq('h8')],null);
  assert.equal(s.board[sq('b2')],'P');
  assert(!s.castling.includes('k'));
  assert(s.wild.pawnLocks.includes(sq('b2')));
  assert.equal(s.halfmove,0);
  s=play(s,'h7','h6');
  assert(!legalMoves(s).some(m=>m.from===sq('b2')&&m.to===sq('b4')));
  assert.equal(JSON.parse(before).board[sq('h8')],'r');
});

test('kings can trade Domain and borrow safe movement, but cannot cast Tribunal',()=>{
  let s=position('7k/8/8/8/8/8/8/N3K1Q1');
  s=card(s,'trade','e1','a1');
  assert.equal(powerAt(s,sq('a1')),'k');
  s=play(s,'h8','h7');
  const jump=legalMoves(s).find(m=>m.from===sq('e1')&&m.to===sq('e3')&&m.power==='n');
  assert(jump); s=playLegal(s,jump); assert.equal(s.board[sq('e3')],'K');
  assert(!inCheck(s,'w'));
  let t=position('7k/8/8/8/8/4p3/8/3QK3');
  t=card(t,'trade','e1','d1'); t=play(t,'h8','h7');
  assert(!legalMoves(t).some(m=>m.from===sq('e1')&&m.power==='q'));
  const domain=legalMoves(t).find(m=>m.from===sq('d1')&&m.power==='k');
  assert(domain);
  t=playLegal(t,domain);
  assert.deepEqual(t.domain,{side:'w',center:sq('d1')});
  const danger=position('4r2k/8/8/8/8/8/4P3/4K3');
  danger.wild.trades[sq('e1')]='n';
  assert(!legalMoves(danger).some(m=>m.from===sq('e1')&&m.to===sq('e3')&&m.power));
});

test('Freeze preserves attacks, prevents moves and castling, expires after any reply',()=>{
  let s=position('4k2r/8/8/8/8/8/8/4K2R b Kk -');
  s=card(s,'freeze','h1');
  assert(!legalMoves(s).some(m=>m.from===sq('h1')||m.castle));
  s=play(s,'e1','d1');
  assert.equal(s.wild.freeze,null);
  const frozen=position('7k/8/8/8/8/8/r7/K7');
  frozen.wild.freeze={side:'b',square:sq('a2')};
  assert(inCheck(frozen));
  const pusher=position('7k/8/8/8/3Rp3/8/8/K7');
  pusher.wild.freeze={side:'w',square:sq('d4')};
  assert(!hasCard(pusher,'repulse','d4','e4'));
});

test('Repulse and Relay move tags/rights, reject occupied destinations, edges and king targets',()=>{
  let s=position('7k/8/8/8/3Rp3/8/8/K7');
  s=card(s,'repulse','d4','e4');
  assert.equal(s.board[sq('d4')],'R'); assert.equal(s.board[sq('e4')],null); assert.equal(s.board[sq('f4')],'p');
  const blocked=position('7k/8/8/8/3Rpp2/8/8/K7');
  assert(!hasCard(blocked,'repulse','d4','e4'));
  const edge=position('7k/8/8/8/8/6R1/6p1/K7');
  assert(!hasCard(edge,'repulse','g3','g2'));
  s=position('7k/8/8/8/8/8/8/4K1NR w K -');
  s.wild.noble=[sq('h1')]; s.wild.trades[sq('g1')]='b';
  assert(hasCard(s,'relay','h1','g1')&&hasCard(s,'relay','g1','h1'));
  s=card(s,'relay','h1','g1');
  assert.equal(s.castling,'');
  assert.equal(s.board[sq('g1')],'R');
  assert(s.wild.noble.includes(sq('g1')));
  assert.equal(powerAt(s,sq('h1')),'b');
});

test('Kamui preserves hidden identities, Noble and unmoved rook castling rights across return',()=>{
  let s=position('4k2r/8/8/8/8/8/8/4K2R w Kk -');
  s.wild.noble=[sq('h1')]; s.wild.trades[sq('h1')]='n';
  s=card(s,'kamui','h1');
  assert.equal(s.castling,'Kk');
  const view=redactWildcardState(s,'b');
  assert.equal(Object.keys(view.wild.trades).length,0);
  s=play(s,'e8','d8'); s=play(s,'e1','d1');
  assert.equal(s.board[sq('h1')],'R');
  assert.equal(powerAt(s,sq('h1')),'n');
  assert(s.wild.noble.includes(sq('h1')));
});

test('redaction hides opponent trade and historical assignments while preserving own history and purity',()=>{
  let s=initialState(); s=card(s,'trade','b2','c1');
  s=play(s,'a7','a6'); s=play(s,'g1','f3'); s=play(s,'b8','c6');
  const before=JSON.stringify(s);
  const blackView=redactWildcardState(s,'b');
  assert.deepEqual(blackView.wild.trades,{});
  assert(blackView.history.every(key=>!key.includes('|wild:')));
  const whiteView=redactWildcardState(s,'w');
  assert.deepEqual(whiteView.wild.trades,s.wild.trades);
  assert.deepEqual(whiteView.history,s.history);
  assert.equal(JSON.stringify(s),before);
  const legacy=initialState(); delete legacy.wild;
  legacy.history=['public-key'];
  assert.deepEqual(redactWildcardState(legacy,'w').history,['public-key']);
  assert.equal(keyOf(legacy),keyOf({...legacy,wild:initialState().wild}));
  assert.equal(labelMove(s,{wildcard:'trade',from:sq('b2'),to:sq('c1')}),'Power Trade');
});

test('ordinary promotion preserves a traded identity without altering pawn promotion rules',()=>{
  let s=position('7k/P7/8/8/8/8/8/K7');
  s.wild.trades[sq('a7')]='n';
  s=play(s,'a7','a8',{promotion:'r'});
  assert.equal(s.board[sq('a8')],'R');
  assert.equal(powerAt(s,sq('a8')),'n');
});
