import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState,legalMoves} from '../public/game/engine.js';
import {createMatch,viewMatch,moveMatch,counterMatch,readyMatch,tapMatch,advanceMatch,
  COUNTER_MS, READY_MS, COUNTDOWN_MS, DUEL_MS} from '../public/game/encounter.js';

const jump = {from:57,to:41,power:'n'};
const queen = {from:59,to:27,power:'q'};
function queenPosition() {
  let match=createMatch(initialState());
  match=moveMatch(match,'w',{from:51,to:35},0);
  return moveMatch(match,'b',{from:11,to:27},1);
}
function challenged() {
  return moveMatch(queenPosition(),'w',queen,100,'duel-id');
}
function live() {
  let match = counterMatch(challenged(),'b',1,120);
  match=readyMatch(match,'w',200);
  return readyMatch(match,'b',210);
}

test('all opening techniques produce identical secret views and freeze board, turn, charges and log',()=>{
  const original=createMatch();
  const powers=legalMoves(original.state).filter(m=>m.power);
  assert.ok(new Set(powers.map(x=>x.power)).size>=3);
  const baseline=viewMatch(moveMatch(original,'w',powers[0],300,'same-id'),300);
  for (const move of powers) {
    const next=moveMatch(original,'w',move,300,'same-id');
    assert.deepEqual(viewMatch(next,300),baseline);
    assert.equal(next.state,original.state);
    assert.equal(next.log,original.log);
    assert.notEqual(next.encounter,null);
  }
  assert.equal(original.encounter,null);
  assert.deepEqual(baseline.encounter,{phase:'counter',caster:'w',deadline:15300,id:'same-id'});
});

test('correct guesses cancel, missed guesses cost a counter, passing and timeout are free',()=>{
  const pending=moveMatch(createMatch(),'w',jump,100,'a');
  for(const [square,landed,remaining] of [[41,false,1],[40,true,1],[null,true,2]]) {
    const resolved=counterMatch(pending,'b',square,120);
    assert.equal(resolved.state.turn,'b');
    assert.equal(resolved.state.energy.w,2);
    assert.equal(resolved.state.cooldown.w,true);
    assert.ok(resolved.state.spent.w.includes('n'));
    assert.equal(resolved.state.counters.b,remaining);
    assert.equal(resolved.state.board[landed?41:57],'N');
    assert.equal(resolved.log.length,1);
    assert.equal(resolved.log[0].resolution,landed?'landed':'countered');
    assert.equal(resolved.encounter,null);
  }
  assert.equal(advanceMatch(pending,15099),pending);
  assert.equal(advanceMatch(pending,15100).state.counters.b,2);
  assert.throws(()=>counterMatch(pending,'b',41,15100), /closed/);
  for(const square of [undefined,-1,64,'41',12.1]) assert.throws(()=>counterMatch(pending,'b',square,200),/square/);
  assert.throws(()=>counterMatch(pending,'w',41,200),/defender/);
  const exhausted=createMatch({...initialState(),counters:{w:2,b:0}});
  assert.equal(moveMatch(exhausted,'w',jump,100).encounter,null);
});

test('a queen can be countered before either side sees a duel; an exhausted defender enters ready immediately',()=>{
  const m=challenged();
  const hit=counterMatch(m,'b',27,130);
  assert.equal(hit.encounter,null);
  assert.equal(hit.state.board[27],'p');
  assert.equal(hit.state.board[59],'Q');
  assert.equal(hit.state.energy.w,1);
  assert.equal(hit.state.counters.b,1);
  const base=queenPosition();
  base.state={...base.state,counters:{w:2,b:0}};
  assert.equal(moveMatch(base,'w',queen,130).encounter.phase,'duel');
});

test('a synchronized duel lasts ten seconds, both seats share the same fair cap and duplicate sequences are inert',()=>{
  let m=live();
  const start=m.encounter.startsAt;
  assert.equal(start,210+COUNTDOWN_MS);
  assert.equal(m.encounter.endsAt,start+DUEL_MS);
  assert.throws(()=>tapMatch(m,'b',{seq:1,count:1},start-1),/ten-second/);
  assert.throws(()=>tapMatch(m,'x',{seq:1,count:1},start),/ten-second/);
  for (let i=0;i<1000;i++) {
    const now=start+i*10;
    for(const side of ['w','b']) m=tapMatch(m,side,{seq:i+1,count:4},now);
  }
  assert.deepEqual(m.encounter.scores,{w:120,b:120});
  assert.equal(tapMatch(m,'w',{seq:1000,count:4},start+9999),m);
  assert.throws(()=>tapMatch(m,'b',{seq:1001,count:4},start+10000),/ten-second/);
  const done=advanceMatch(m,start+10000);
  assert.deepEqual(done.log.at(-1).duel,{winner:'b',scores:{w:120,b:120}});
  assert.equal(done.state.board[59],null);
  assert.equal(done.state.board[27],'p');
  assert.equal(done.state.counters.b,1);
});

test('winner keeps their combatant, a completely idle match favors the defender, and poll delays never reset time',()=>{
  for(const [w,b,winner] of [[3,1,'w'],[1,4,'b'],[0,0,'b']]) {
    let m=live();
    const {startsAt,endsAt}=m.encounter;
    if(w)m=tapMatch(m,'w',{seq:1,count:w},startsAt+400);
    if(b)m=tapMatch(m,'b',{seq:1,count:b},startsAt+400);
    const done=advanceMatch(m,endsAt);
    assert.equal(done.log.at(-1).duel.winner,winner);
    assert.equal(done.state.board[59],winner==='w'?'Q':null);
    assert.equal(done.state.board[27],winner==='w'?null:'p');
    assert.equal(done.state.turn,'b');
  }
  const m=challenged();
  const auto=100+COUNTER_MS+READY_MS+COUNTDOWN_MS;
  const delayed=advanceMatch(m,auto+5000);
  assert.equal(delayed.encounter.startsAt,auto);
  assert.equal(delayed.encounter.endsAt,auto+DUEL_MS);
  const done=advanceMatch(m,auto+DUEL_MS+90000);
  assert.equal(done.encounter,null);
  assert.equal(done.log.at(-1).duel.winner,'b');
  assert.equal(advanceMatch(done,auto+200000),done);
});
