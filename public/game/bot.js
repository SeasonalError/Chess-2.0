// Riftbound searches the same move generator as the game. Scores are centipawns.
import { attacked, counterCount, drawReason, hasLegalMove, inCheck, keyOf, legalMoves, playLegal, resolveCast, result } from './engine.js';

export const LEVELS = {
  easy:   { timeMs: 300,  maxDepth: 2 },
  medium: { timeMs: 1150, maxDepth: 5 },
  hard:   { timeMs: 3600, maxDepth: 9 },
};

const duelTiming = {
  easy:   { interval:410, reaction:500 },
  medium: { interval:235, reaction:400 },
  hard:   { interval:165, reaction:320 },
};

// The complete schedule is fixed before the duel starts and never uses the human's score.
export function duelTapSchedule(level = 'hard', durationMs = 10000, rng = Math.random) {
  const {interval, reaction} = duelTiming[level] || duelTiming.hard;
  const taps = [];
  let tap = Math.round(reaction + rng() * 180);
  while (tap < durationMs) {
    taps.push(tap);
    tap += Math.round(interval * (0.89 + rng() * 0.22));
  }
  return taps;
}

const MATE = 30000;
const MATE_WINDOW = MATE - 128;
const TIMEOUT = Symbol('search timeout');
const middleValue = { p:100, n:322, b:337, r:505, q:950, k:0 };
const endValue = { p:118, n:309, b:332, r:532, q:945, k:0 };
const phaseValue = { p:0, n:1, b:1, r:2, q:4, k:0 };

function squareBonus(type, file, advance) {
  const fileCenter = 3.5 - Math.abs(file - 3.5);
  const center = fileCenter + 3.5 - Math.abs(advance - 3.5);
  const centralPawn = file === 3 || file === 4;
  switch (type) {
    case 'p': return [
      fileCenter * 2 + advance * 3 + (centralPawn ? Math.min(advance, 3) * 10 : 0),
      advance * advance * 2 + fileCenter * 2,
    ];
    case 'n': return [center * 11 - (advance === 0 ? 15 : 0), center * 8];
    case 'b': return [center * 5 - (advance === 0 ? 12 : 0), center * 5];
    case 'r': return [fileCenter * 2 + (advance === 6 ? 18 : 0), center * 2 + advance * 2];
    case 'q': return [center * 2 - (advance > 2 ? 6 : 0), center * 4];
    case 'k': return [
      -advance * 11 - fileCenter * 7 + (advance === 0 && (file === 6 || file === 2) ? 23 : 0),
      center * 11,
    ];
  }
}

const tables = {};
for (const type of Object.keys(middleValue)) {
  for (const piece of [type, type.toUpperCase()]) {
    const white = piece !== type;
    const sign = white ? 1 : -1;
    tables[piece] = Array.from({length:64}, (_, square) => {
      const row = square >> 3, file = square & 7;
      const [mid, end] = squareBonus(type, file, white ? 7 - row : row);
      return [sign * (middleValue[type] + mid), sign * (endValue[type] + end)];
    });
  }
}

function evaluate(state) {
  let middle = 0, end = 0, phase = 0;
  const pawns = [new Int8Array(8), new Int8Array(8)];
  const backRank = [new Int8Array(8).fill(-1), new Int8Array(8).fill(8)];
  const bishops = [0,0], kings = [0,0];
  for (let sq = 0; sq < 64; sq++) {
    const piece = state.board[sq];
    if (!piece) continue;
    const type = piece.toLowerCase(), side = piece === type ? 1 : 0;
    const [mg, eg] = tables[piece][sq];
    middle += mg;
    end += eg;
    phase += phaseValue[type];
    if (type === 'p') {
      const f = sq & 7, row = sq >> 3;
      pawns[side][f]++;
      backRank[side][f] = side ? Math.min(backRank[side][f], row) : Math.max(backRank[side][f], row);
    }
    if (type === 'b') bishops[side]++;
    if (type === 'k') kings[side] = sq;
  }
  for (let sq = 0; sq < 64; sq++) {
    const piece = state.board[sq];
    if (!piece) continue;
    const type = piece.toLowerCase(), side = piece === type ? 1 : 0;
    const sign = side ? -1 : 1, file = sq & 7;
    if (type === 'p') {
      const row = sq >> 3, advance = side ? row : 7 - row;
      const isolated = !pawns[side][file - 1] && !pawns[side][file + 1];
      if (isolated) { middle -= sign * 12; end -= sign * 9; }
      if (pawns[side][file] > 1) { middle -= sign * 9; end -= sign * 13; }
      let passed = true;
      for (let f = Math.max(0,file - 1); f <= Math.min(7,file + 1); f++) {
        if (!pawns[1 - side][f]) continue;
        if (side ? backRank[0][f] > row : backRank[1][f] < row) { passed = false; break; }
      }
      if (passed) { middle += sign * advance * 3; end += sign * advance * advance * 2; }
    }
    if (type === 'r' && !pawns[side][file]) {
      middle += sign * (pawns[1 - side][file] ? 10 : 21);
    }
  }
  for (const side of [0,1]) {
    const sign = side ? -1 : 1, color = side ? 'b' : 'w';
    if (bishops[side] >= 2) { middle += sign * 27; end += sign * 35; }
    const file = kings[side] & 7, row = (kings[side] >> 3) + (side ? 1 : -1);
    if (row >= 0 && row < 8) {
      for (let f = Math.max(0,file - 1); f <= Math.min(7,file + 1); f++) {
        if (state.board[row * 8 + f] === (side ? 'p' : 'P')) middle += sign * 8;
      }
    }
    const reserve = state.energy[color] * 19 + counterCount(state,color) * 12;
    const lance = state.energy[color] && bishops[side] && !state.spent[color].includes('b') ? 12 : 0;
    middle += sign * (reserve + lance);
    end += sign * (reserve + lance);
  }
  phase = Math.min(24, phase);
  const whiteScore = Math.round((middle * phase + end * (24 - phase)) / 24);
  return (state.turn === 'w' ? whiteScore : -whiteScore) + 7;
}

function captureValue(state, move) {
  if (move.power === 'r') return 0; // Aegis targets a friendly piece.
  if (move.enPassant) return middleValue.p;
  const target = move.from !== move.to && state.board[move.to];
  return target ? middleValue[target.toLowerCase()] : 0;
}

function moveId(move) {
  return [move.from, move.to, move.power || '', move.promotion || ''].join('/');
}

function ranked(state, moves, pv, killers, history) {
  const rankedMoves = moves.map(move => {
    const id = moveId(move);
    const moving = state.board[move.from], victim = captureValue(state, move);
    let score = 0;
    if (id === pv) score = 1e7;
    else if (move.power === 'q') {
      // Tribunal risks our entire queen. A straight capture comes first.
      score = victim - middleValue.q;
    } else if (victim || move.promotion) {
      score = 100000 + victim * 16 - middleValue[moving.toLowerCase()]
        + (move.promotion ? middleValue[move.promotion] * 16 : 0);
    } else if (killers?.includes(id)) score = 90000;
    else {
      score = (history.get(state.turn + id) || 0);
      const sign = state.turn === 'w' ? 1 : -1;
      if (move.power !== 'r') score += sign * (tables[moving][move.to][0] - tables[moving][move.from][0]);
      if (move.castle) score += 65;
      if (move.power) score -= move.power === 'k' ? 70 : 22;
    }
    return {move, score, id};
  });
  return rankedMoves.sort((a,b) => b.score - a.score);
}

// Infer plausible destinations from the public pre-cast board. Neither the
// declaration's piece type nor the actual submitted move is an input.
function forecastCounters(state, level, candidates = legalMoves(state)) {
  const side = state.turn, defender = side === 'w' ? 'b' : 'w';
  const remaining = counterCount(state,defender);
  const empty = {spend:0, targets:[]};
  if (!remaining) return empty;

  const scores = new Map();
  for (const move of candidates) {
    if (!move.power) continue;
    const next = playLegal(state,move), type = move.power;
    let signal = 12;
    if (type === 'r') {
      const value = middleValue[state.board[move.to].toLowerCase()];
      signal += attacked(state.board,move.to,defender) ? value * 0.27 : value * 0.008;
    } else if (type === 'q') {
      signal += captureValue(state,move) * 0.20;
      if (attacked(state.board,move.from,defender)) signal += 40;
    } else if (type !== 'k') {
      const piece = state.board[move.from];
      signal += 0.48 * captureValue(state,move);
      signal += Math.max(-12, (side === 'w' ? 1 : -1) * (tables[piece][move.to][0] - tables[piece][move.from][0]) * 0.4);
      if (attacked(next.board,move.to,defender)) signal -= middleValue[piece.toLowerCase()] * 0.12;
      else if (attacked(state.board,move.from,defender)) signal += middleValue[piece.toLowerCase()] * 0.20;
    }
    if (inCheck(next)) signal += hasLegalMove(next) ? 105 : 750;
    scores.set(move.to, Math.max(signal, scores.get(move.to) ?? -Infinity));
  }
  if (!scores.size) return empty;
  const peak = Math.max(...scores.values());
  const temperature = level === 'easy' ? 130 : level === 'medium' ? 82 : 48;
  // A uniform component keeps the Oracle imperfect even on obvious squares.
  const noise = level === 'easy' ? 0.60 : level === 'medium' ? 0.32 : 0.16;
  const weights = Array.from(scores, ([square,signal]) => ({square,weight: Math.exp((signal-peak)/temperature)}));
  const total = weights.reduce((n,t) => n + t.weight, 0);
  const targets = weights.map(({square,weight}) => ({square,probability:(1-noise)*weight/total + noise/weights.length}));
  const best = Math.max(...targets.map(t => t.probability));
  // Save a scarce attempt on ambiguous, low-value declarations. Spend more
  // freely when the opponent has only this last point of energy.
  const urgency = state.energy[side] === 1 ? 0.40 : remaining === 1 ? -0.12 : 0;
  const spend = Math.max(0.08,Math.min(0.98,0.16 + peak/600 + 0.55*best + urgency));
  return {spend,targets};
}

export function chooseCounterSquare(state, level = 'hard', rng = Math.random) {
  const {spend,targets} = forecastCounters(state,level);
  if (!targets.length || rng() >= spend) return null;
  let ticket = rng();
  for (const {square,probability} of targets) {
    ticket -= probability;
    if (ticket < 0) return square;
  }
  return targets.at(-1).square;
}

// Table mate scores use distance from the stored position, not distance from the root.
function toTable(score, ply) {
  return score >= MATE_WINDOW ? score + ply : score <= -MATE_WINDOW ? score - ply : score;
}
function fromTable(score, ply) { return toTable(score, -ply); }

export function findBestMove(state, level = 'hard', options = {}) {
  const preset = LEVELS[level] || LEVELS.hard;
  const maxDepth = options.maxDepth ?? preset.maxDepth;
  const timeMs = options.timeMs ?? preset.timeMs;
  const end = performance.now() + timeMs;
  let nodes = 0, depthReached = 0;
  const table = new Map(), killers = [], history = new Map();

  function visit() {
    nodes++;
    if ((nodes & 31) === 0 && performance.now() >= end) throw TIMEOUT;
  }

  const policies = new WeakMap();
  function castScore(state, move, next, alpha, beta, scoreChild, candidates) {
    const enemy = next.turn;
    let hit = 0, miss = 0;
    if (counterCount(state,enemy)) {
      let policy = policies.get(state);
      if (!policy) {
        policy = forecastCounters(state,level,candidates);
        policies.set(state,policy);
      }
      hit = policy.spend * (policy.targets.find(t => t.square === move.to)?.probability || 0);
      miss = policy.spend - hit;
    }
    if (!hit && !miss && move.power !== 'q') return scoreChild(next,alpha,beta);

    // For the search, choose the more likely counter inventory for an unblocked
    // cast. A specifically predicted destination still has its own cancellation
    // branch. Live guesses and inventory deduction are handled by the encounter.
    const spent = miss > (1 - hit) / 2;
    const unblocked = spent ? resolveCast(state,move,{counterSpent:true}) : next;
    const outcomes = [];
    const win = move.power === 'q' ? 0.48 : 1; // Unknown opponent cadence; a tied duel loses.
    outcomes.push({chance:(1-hit)*win, board:unblocked});
    if (win < 1) outcomes.push({chance:(1-hit)*(1-win), board:resolveCast(state,move,{queenWon:false,counterSpent:spent})});
    if (hit > 0) outcomes.push({chance:hit, board:resolveCast(state,move,{countered:true,counterSpent:true})});
    outcomes.sort((a,b) => b.chance-a.chance);

    // Chance-node alpha–beta: unsearched outcomes can contribute at most one
    // mate score in either direction. Bounds are rounded outwards.
    let sum = 0, remaining = 1;
    for (const {chance,board} of outcomes) {
      remaining = Math.max(0,remaining - chance);
      const lo = Math.floor((alpha - sum - remaining * MATE) / chance);
      const hi = Math.ceil((beta - sum + remaining * MATE) / chance);
      sum += chance * scoreChild(board,lo,hi);
      if (sum + remaining * MATE <= alpha) return Math.floor(sum + remaining * MATE);
      if (sum - remaining * MATE >= beta) return Math.ceil(sum - remaining * MATE);
    }
    return Math.round(sum);
  }

  function quiet(state, alpha, beta, ply, qDepth) {
    visit();
    const checked = inCheck(state);
    const moves = legalMoves(state, {tacticalOnly:true});
    if (!moves.length && (checked || !hasLegalMove(state))) return checked ? -MATE + ply : 0;
    if (drawReason(state)) return 0;
    // An in-check leaf must play an evasion, even at the extension cap.
    if (qDepth >= 24) {
      if (!checked) return evaluate(state);
      return Math.max(...moves.map(move => -evaluate(playLegal(state,move))));
    }
    if (!checked) {
      const standPat = evaluate(state);
      if (standPat >= beta) return standPat;
      alpha = Math.max(alpha, standPat);
    }
    for (const {move} of ranked(state, moves, null, null, history)) {
      const next = playLegal(state,move);
      const score = move.power
        ? castScore(state, move, next, alpha, beta, (child,lo,hi) => -quiet(child,-hi,-lo,ply+1,qDepth+1))
        : -quiet(next, -beta, -alpha, ply + 1, qDepth + 1);
      if (score >= beta) return score;
      alpha = Math.max(alpha, score);
    }
    return alpha;
  }

  function search(state, depth, alpha, beta, ply) {
    if (depth <= 0) return quiet(state, alpha, beta, ply, 0);
    visit();
    const moves = legalMoves(state);
    if (!moves.length) return inCheck(state) ? -MATE + ply : 0;
    if (drawReason(state)) return 0;
    const key = keyOf(state), entry = table.get(key);
    // Ordering can use any matching board. Reusing the score also requires the
    // same reversible history and clock because they affect a possible draw.
    if (entry && entry.depth >= depth && entry.clock === state.halfmove
        && entry.history.length === state.history.length
        && entry.history.every((position, index) => position === state.history[index])) {
      const value = fromTable(entry.value, ply);
      if (entry.bound === 'exact' || (entry.bound === 'lower' && value >= beta)
                                 || (entry.bound === 'upper' && value <= alpha)) return value;
    }
    const originalAlpha = alpha, checked = inCheck(state);
    let best = -Infinity, bestId;
    const sorted = ranked(state, moves, entry?.id, killers[ply], history);
    for (let i = 0; i < sorted.length; i++) {
      const {move, id} = sorted[i], next = playLegal(state,move);
      const isQuiet = !captureValue(state,move) && !move.promotion;
      let value;
      if (move.power) value = castScore(state,move,next,alpha,beta,
        (child,lo,hi) => -search(child,depth-1,-hi,-lo,ply+1),moves);
      else if (i === 0) value = -search(next, depth - 1, -beta, -alpha, ply + 1);
      else {
        const reduce = depth >= 3 && i >= 5 && isQuiet && !checked && !move.power
          && !move.castle && !inCheck(next);
        value = -search(next, depth - 1 - (reduce ? 1 : 0), -alpha - 1, -alpha, ply + 1);
        if (reduce && value > alpha)
          value = -search(next, depth - 1, -alpha - 1, -alpha, ply + 1);
        if (value > alpha && value < beta)
          value = -search(next, depth - 1, -beta, -alpha, ply + 1);
      }
      if (value > best) { best = value; bestId = id; }
      alpha = Math.max(alpha, value);
      if (alpha >= beta) {
        if (isQuiet) {
          killers[ply] = [id, ...(killers[ply] || []).filter(previous => previous !== id)].slice(0,2);
          const historyKey = state.turn + id;
          history.set(historyKey, Math.min(8000, (history.get(historyKey) || 0) + depth * depth));
        }
        break;
      }
    }
    if (table.size < 45000 || entry) {
      table.set(key, {depth, value:toTable(best,ply), id:bestId, history:state.history, clock:state.halfmove,
        bound:best <= originalAlpha ? 'upper' : best >= beta ? 'lower' : 'exact'});
    }
    return best;
  }

  const moves = legalMoves(state);
  const outcome = result(state, moves);
  if (outcome) return {move:null, depth:0, nodes:0, score:outcome.winner ? -MATE : 0};
  let bestMove = ranked(state, moves, null, [], history)[0].move;
  let bestScore = null;
  for (let depth = 1; depth <= maxDepth; depth++) {
    let iterationMove = bestMove, iterationScore = -Infinity;
    try {
      for (const {move} of ranked(state, moves, moveId(bestMove), [], history)) {
        if (performance.now() >= end) throw TIMEOUT;
        const next = playLegal(state,move);
        const score = move.power
          ? castScore(state,move,next,iterationScore,Infinity,(child,lo,hi) => -search(child,depth-1,-hi,-lo,1),moves)
          : -search(next, depth - 1, -Infinity, -iterationScore, 1);
        if (score > iterationScore) { iterationScore = score; iterationMove = move; }
        if (score >= MATE - 1) break;
      }
    } catch (error) {
      if (error !== TIMEOUT) throw error;
      if (depthReached === 0 && Number.isFinite(iterationScore)) {
        bestMove = iterationMove; bestScore = iterationScore;
      }
      break;
    }
    bestMove = iterationMove; bestScore = iterationScore; depthReached = depth;
    if (Math.abs(bestScore) >= MATE_WINDOW || performance.now() >= end) break;
  }
  return {move:bestMove, score:bestScore, depth:depthReached, nodes};
}
