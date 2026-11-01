import {
  coord, initialState, labelMove, legalMoves, playLegal, resolveCast, result,
  WILDCARDS, wildcardMoves, redactWildcardState,
} from './engine.js';

export const COUNTER_MS = 15_000;
export const READY_MS = 15_000;
export const COUNTDOWN_MS = 3_000;
export const DUEL_MS = 10_000;
export const MAX_BATCH = 4;
export const TAPS_PER_SECOND = 12;
const other = side => side === 'w' ? 'b' : 'w';

function newEncounterId() {
  // getRandomValues also works when playing a local game over a LAN HTTP URL.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export class EncounterError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function requireThat(condition, status, message) {
  if (!condition) throw new EncounterError(status, message);
}

export function createMatch(state = initialState()) {
  // Stored games from the first release predate counter seals.
  if (!state.counters) state = {...state, counters: {w: 2, b: 2}};
  return {state, draft: null, encounter: null, log: [], outcome: null};
}

export function createDraftMatch(state = initialState()) {
  return {...createMatch(state), draft: {cards:{w:null,b:null}, used:{w:false,b:false}}};
}

export function draftMatch(match, side, card) {
  requireThat(match.draft, 409, 'This match has no wildcard draft.');
  requireThat(side === 'w' || side === 'b', 403, 'A player seat is required.');
  requireThat(typeof card === 'string' && Object.hasOwn(WILDCARDS, card), 400, 'Choose one of the six wildcard cards.');
  const {cards} = match.draft;
  if (cards[side] === card) return match;
  requireThat(!match.outcome && !cards[side], 409, 'Your wildcard choice is already locked.');
  return {...match, draft: {...match.draft, cards: {...cards, [side]:card}}};
}

function matchResult(state, draft, moves) {
  const ending = result(state, moves);
  if (ending?.reason !== 'Stalemate' || !draft || draft.used[state.turn]) return ending;
  // An unused playable card is a legal turn. Other automatic draw rules still apply.
  const cards = wildcardMoves(state, draft.cards[state.turn]);
  return cards.length ? result(state, cards) : ending;
}

function entry(state, move) {
  return {label: labelMove(state, move), side: state.turn, from: move.from, to: move.to,
    ...(move.power ? {power: move.power} : {})};
}

function finish(match, state, record) {
  return {...match, state, encounter: null, log: [...match.log, record], outcome: matchResult(state, match.draft)};
}

function settleCast(match, countered, queenWon = true) {
  const e = match.encounter;
  const chosen = e.square != null;
  const state = resolveCast(match.state, e.move, {countered, queenWon, counterSpent: chosen});
  const record = entry(match.state, e.move);
  record.counter = chosen ? {square: e.square, hit: countered} : null;
  record.resolution = countered ? 'countered' : 'landed';
  if (chosen) record.label += ' · ' + (countered ? 'Countered on ' : 'Missed counter on ') + coord(e.square);
  if (e.phase === 'duel') {
    const winner = queenWon ? e.caster : other(e.caster);
    record.resolution = 'duel';
    record.duel = {scores: {...e.scores}, winner};
    const removed = queenWon ? e.move.to : e.move.from;
    const score = e.scores.w + '–' + e.scores.b;
    record.label += ' · ' + (winner === 'w' ? 'White' : 'Black') + ' wins ' + score + ' (W–B), ' + coord(removed) + ' falls';
  }
  return finish(match, state, record);
}

function answerCounter(match, square, now) {
  const e = {...match.encounter, square};
  const next = {...match, encounter: e};
  if (square === e.move.to) return settleCast(next, true);
  if (e.move.power !== 'q') return settleCast(next, false);
  return {...match, encounter: {
    id: e.id, phase: 'duel', caster: e.caster, move: e.move, square,
    readyDeadline: now + READY_MS, ready: {w:false, b:false}, startsAt: null, endsAt: null,
    scores: {w:0, b:0}, lastSeq: {w:0, b:0}, buckets: null,
  }};
}

export function moveMatch(match, side, input, now, id) {
  requireThat(!match.outcome, 409, 'This match is over.');
  requireThat(!match.encounter, 409, 'Resolve the encounter before making a move.');
  requireThat(match.state.turn === side, 409, "It is your opponent's turn.");
  const draft = match.draft;
  requireThat(!draft || (draft.cards.w && draft.cards.b), 409, 'Both players must lock a wildcard before play.');
  const moves = legalMoves(match.state);
  requireThat(!matchResult(match.state, draft, moves), 409, 'This match is over.');
  if (input?.wildcard != null) {
    const id = input.wildcard;
    requireThat(draft && draft.cards[side] === id && !draft.used[side], 400, 'That wildcard is unavailable.');
    const cardMove = wildcardMoves(match.state, id).find(m => m.from === input.from && m.to === input.to);
    requireThat(cardMove && input.power == null && input.promotion == null, 400, 'Illegal wildcard target.');
    const spent = {...match, draft: {...draft, used: {...draft.used, [side]:true}}};
    const {from, to} = cardMove;
    const squares = from === to ? coord(to) : coord(from) + ' → ' + coord(to);
    return finish(spent, playLegal(match.state, cardMove),
      {label: WILDCARDS[id].name + ' · ' + squares, side, wildcard: id, from, to});
  }
  const move = input && moves.find(m => m.from === input.from && m.to === input.to &&
    (m.power ?? null) === (input.power ?? null) && (m.promotion ?? null) === (input.promotion ?? null));
  requireThat(move, 400, 'That move is illegal in this position.');
  if (!move.power) return finish(match, playLegal(match.state, move), entry(match.state, move));
  const pending = {...match, encounter: {
    id: id ?? newEncounterId(), phase: 'counter', caster: side, deadline: now + COUNTER_MS, move,
  }};
  return match.state.counters[other(side)] ? pending : answerCounter(pending, null, now);
}

export function counterMatch(match, side, square, now) {
  const e = match.encounter;
  requireThat(e?.phase === 'counter' && now < e.deadline, 409, 'The counter window is closed.');
  requireThat(side === other(e.caster), 403, 'Only the defender can answer this cast.');
  requireThat(square === null || (Number.isInteger(square) && square >= 0 && square < 64),
    400, 'Choose one board square or pass.');
  return answerCounter(match, square, now);
}

function startCountdown(match, now) {
  const startsAt = now + COUNTDOWN_MS;
  // Credit measured in thousandths of one tap, on the authoritative clock.
  const bucket = () => ({at: startsAt, credit: 1000});
  return {...match, encounter: {...match.encounter, startsAt, endsAt: startsAt + DUEL_MS,
    buckets: {w:bucket(), b:bucket()}}};
}

export function readyMatch(match, side, now) {
  const e = match.encounter;
  requireThat(e?.phase === 'duel' && (side === 'w' || side === 'b'), 409, 'No duel is waiting.');
  if (e.ready[side] || e.startsAt !== null) return match;
  requireThat(now < e.readyDeadline, 409, 'The ready window is closed.');
  const ready = {...e.ready, [side]: true};
  const updated = {...match, encounter: {...e, ready}};
  return ready.w && ready.b ? startCountdown(updated, now) : updated;
}

export function tapMatch(match, side, batch, now) {
  const e = match.encounter;
  requireThat(e?.phase === 'duel' && (side === 'w' || side === 'b') &&
    e.startsAt !== null && now >= e.startsAt && now < e.endsAt, 409, 'Taps count only during the ten-second duel.');
  const {seq, count} = batch ?? {};
  requireThat(Number.isSafeInteger(seq) && seq > 0 && Number.isInteger(count) && count > 0 && count <= MAX_BATCH,
    400, 'Send a numbered batch of one to four taps.');
  if (seq <= e.lastSeq[side]) return match;
  requireThat(seq === e.lastSeq[side] + 1, 409, 'A tap batch is missing. Sync your duel and try again.');
  const old = e.buckets[side];
  const at = Math.max(now, old.at);
  const credit = Math.min(MAX_BATCH * 1000, old.credit + (at - old.at) * TAPS_PER_SECOND);
  const accepted = Math.min(count, Math.floor(credit / 1000));
  return {...match, encounter: {...e,
    lastSeq: {...e.lastSeq, [side]: seq},
    scores: {...e.scores, [side]: e.scores[side] + accepted},
    buckets: {...e.buckets, [side]: {at, credit: credit - accepted * 1000}},
  }};
}

// Anchor unseen timeouts to their scheduled deadline. A reconnect cannot restart
// or stretch the countdown, even when no browser polled through the entire duel.
export function advanceMatch(match, now) {
  let e = match.encounter;
  if (e?.phase === 'counter' && now >= e.deadline) {
    match = answerCounter(match, null, e.deadline);
    e = match.encounter;
  }
  if (e?.phase === 'duel' && e.startsAt === null && now >= e.readyDeadline) {
    match = startCountdown(match, e.readyDeadline);
    e = match.encounter;
  }
  if (e?.phase === 'duel' && e.endsAt !== null && now >= e.endsAt) {
    return settleCast(match, false, e.scores[e.caster] > e.scores[other(e.caster)]);
  }
  return match;
}

// Explicit allowlists keep the stored intent, rate-limit state, and response
// square out of every public snapshot during the blind reaction window.
export function viewMatch(match, now, viewer) {
  const e = match.encounter;
  let encounter = null;
  if (e?.phase === 'counter') encounter = {id:e.id, phase:e.phase, caster:e.caster, deadline:e.deadline};
  if (e?.phase === 'duel') encounter = {
    id:e.id, phase:e.phase, caster:e.caster, from:e.move.from, to:e.move.to,
    ready: {...e.ready}, readyDeadline:e.readyDeadline, startsAt:e.startsAt, endsAt:e.endsAt,
    scores: {...e.scores}, lastSeq:{...e.lastSeq},
  };
  const seat = viewer === 'w' || viewer === 'b';
  const hand = match.draft;
  const draft = hand ? {
    phase: hand.cards.w && hand.cards.b ? 'playing' : 'picking',
    picked: {w: Boolean(hand.cards.w), b: Boolean(hand.cards.b)},
    card: seat ? hand.cards[viewer] : null,
    used: seat ? hand.used[viewer] : false,
  } : null;
  // The board and history may themselves contain secret technique assignments.
  // Omitting a viewer exposes neither player's private information.
  const state = redactWildcardState(match.state, viewer);
  const log = match.log.map(event => event.wildcard === 'trade' && event.side !== viewer
    ? {side:event.side, wildcard:'trade', label:WILDCARDS.trade.name + ' · hidden targets'} : event);
  return {state, draft, encounter, log, outcome:match.outcome, serverNow:now};
}
