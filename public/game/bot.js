// Riftbound searches the same move generator as the game. Scores are centipawns.
import { drawReason, hasLegalMove, inCheck, keyOf, legalMoves, playLegal, result } from './engine.js';

export const LEVELS = {
  easy:   { timeMs: 300,  maxDepth: 2 },
  medium: { timeMs: 1150, maxDepth: 5 },
  hard:   { timeMs: 3600, maxDepth: 9 },
};

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
    const reserve = state.energy[color] * 19;
    const lance = state.energy[color] && bishops[side] && !state.spent[color].includes('b') ? 12 : 0;
    middle += sign * (reserve + lance);
    end += sign * (reserve + lance);
  }
  phase = Math.min(24, phase);
  const whiteScore = Math.round((middle * phase + end * (24 - phase)) / 24);
  return (state.turn === 'w' ? whiteScore : -whiteScore) + 7;
}

function captureValue(state, move) {
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
    else if (victim || move.promotion) {
      score = 100000 + victim * 16 - middleValue[moving.toLowerCase()]
        + (move.promotion ? middleValue[move.promotion] * 16 : 0);
    } else if (killers?.includes(id)) score = 90000;
    else {
      score = (history.get(state.turn + id) || 0);
      const sign = state.turn === 'w' ? 1 : -1;
      score += sign * (tables[moving][move.to][0] - tables[moving][move.from][0]);
      if (move.castle) score += 65;
      if (move.power) score -= move.power === 'k' ? 70 : 22;
    }
    return {move, score, id};
  });
  return rankedMoves.sort((a,b) => b.score - a.score);
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
      const score = -quiet(playLegal(state, move), -beta, -alpha, ply + 1, qDepth + 1);
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
      if (i === 0) value = -search(next, depth - 1, -beta, -alpha, ply + 1);
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
        const score = -search(playLegal(state,move), depth - 1, -Infinity, -iterationScore, 1);
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
