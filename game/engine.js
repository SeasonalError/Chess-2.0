import {WILDCARDS, freshWild, effectsOf, powerAt, reserved, nobleAt, frozenAt, reboundMove,
  cardCandidates, applyCardBoard, updatedEffects, wildKey, redactWildcardState} from './wildcards.js';
export {WILDCARDS,powerAt,redactWildcardState};

// Riftbound uses ordinary chess attacks for check, even when a technique is ready.
// Squares run a8..h1 from 0..63. All public state is plain, serializable data.
export const POWERS = {
  p: {name: 'Vector Step', cost: 1, description: 'Slide one file sideways into an empty square.'},
  n: {name: 'Rift Jump', cost: 1, description: 'Teleport exactly two squares along a rank or file to an empty square.'},
  b: {name: 'Phase Lance', cost: 1, description: 'Pass through one piece diagonally. Land beyond it or capture the first enemy beyond it.'},
  r: {name: 'Aegis', cost: 1, description: 'Shield another allied piece, except the king, up to three squares along a rank or file through blockers. It cannot be captured on the next reply. The rook stays put.'},
  q: {name: 'Royal Tribunal', cost: 2, description: 'Challenge an enemy piece other than the king within four squares on a rank or file, through blockers. Win to remove it. Lose or tie and your queen falls. The queen stays put.'},
  k: {name: 'Domain Expansion', cost: 2, description: 'Stay in place. The opponent cannot land on any of the eight surrounding squares on their next turn.'},
};

const WHITE = 'w';
const BLACK = 'b';
const other = side => side === WHITE ? BLACK : WHITE;
const owner = piece => piece < 'a' ? WHITE : BLACK;
const colored = (type, side) => side === WHITE ? type.toUpperCase() : type;
const FILES = 'abcdefgh';
export const coord = sq => FILES[sq % 8] + (8 - (sq >> 3));

const orthogonal = [[1,0], [-1,0], [0,1], [0,-1]];
const diagonal = [[1,1], [-1,1], [1,-1], [-1,-1]];
const allDirs = [...orthogonal, ...diagonal];
const knightDirs = [[1,2], [-1,2], [1,-2], [-1,-2], [2,1], [-2,1], [2,-1], [-2,-1]];
const shift = (sq, dr, df) => {
  const r = (sq >> 3) + dr, f = (sq % 8) + df;
  return r >= 0 && r < 8 && f >= 0 && f < 8 ? r * 8 + f : -1;
};
const table = fn => Array.from({length: 64}, (_, sq) => fn(sq));
const steps = directions => table(sq => directions.map(([r,f]) => shift(sq, r, f)).filter(x => x >= 0));
const kingSteps = steps(allDirs);
const knightSteps = steps(knightDirs);
const knightJumps = steps(orthogonal.map(([r,f]) => [2*r, 2*f]));
const pawnSideways = steps([[0,1], [0,-1]]);
const pawnAttacks = {w: steps([[-1,1], [-1,-1]]), b: steps([[1,1], [1,-1]])};
const rays = table(sq => allDirs.map(([dr,df]) => {
  const line = [];
  for (let next = shift(sq,dr,df); next !== -1; next = shift(next,dr,df)) line.push(next);
  return line;
}));
const promotions = ['q', 'r', 'b', 'n'];
const castles = {
  w: [{right:'K', side:'K', king:60, rook:63, transit:61, to:62, empty:[61,62]},
      {right:'Q', side:'Q', king:60, rook:56, transit:59, to:58, empty:[59,58,57]}],
  b: [{right:'k', side:'K', king:4, rook:7, transit:5, to:6, empty:[5,6]},
      {right:'q', side:'Q', king:4, rook:0, transit:3, to:2, empty:[3,2,1]}],
};

export function initialState() {
  const rank = s => s.split('');
  return {
    board: [...rank('rnbqkbnr'), ...rank('pppppppp'), ...Array(32).fill(null), ...rank('PPPPPPPP'), ...rank('RNBQKBNR')],
    turn: WHITE, castling:'KQkq', ep:null, pawnNoDouble:{w:null,b:null}, halfmove:0, fullmove:1,
    energy:{w:3,b:3}, spent:{w:[],b:[]}, cooldown:{w:false,b:false}, domain:null, shield:null, counters:{w:2,b:2},
    history:[], wild:freshWild(),
  };
}

export function attacked(board, sq, by) {
  const upper = by === WHITE;
  for (const from of pawnAttacks[other(by)][sq]) if (board[from] === (upper ? 'P' : 'p')) return true;
  for (const from of knightSteps[sq]) if (board[from] === (upper ? 'N' : 'n')) return true;
  for (const from of kingSteps[sq]) if (board[from] === (upper ? 'K' : 'k')) return true;
  const lines = rays[sq], queen = upper ? 'Q' : 'q';
  for (let d = 0; d < 8; d++) {
    const slider = d < 4 ? (upper ? 'R' : 'r') : (upper ? 'B' : 'b');
    for (const from of lines[d]) {
      const piece = board[from];
      if (piece) {
        if (piece === slider || piece === queen) return true;
        break;
      }
    }
  }
  return false;
}
export function inCheck(state, side = state.turn) {
  const king = state.board.indexOf(colored('k',side));
  return king === -1 || attacked(state.board,king,other(side));
}
export function counterCount(state, side) {
  return state.counters?.[side] ?? 2;
}
function protectedSquare(state, sq, mover) {
  return state.shield?.side === other(mover) && state.shield.square === sq;
}
function sealed(domain, sq, mover) {
  return domain && domain.side !== mover && kingSteps[domain.center].includes(sq);
}

function canLand(state,from,to) {
  return !reserved(state,to) && (nobleAt(state,from) || !sealed(state.domain,to,owner(state.board[from])));
}
// The king must be safe immediately after the action and after any scheduled returns.
function safeAtEnd(board,king,enemy,due) {
  if (attacked(board,king,enemy)) return false;
  if (!due.length) return true;
  for (const item of due) board[item.square] = item.piece;
  const safe = !attacked(board,king,enemy);
  for (const item of due) board[item.square] = null;
  return safe;
}

// Used on a private board copy for legal filtering, and on a fresh board per played move.
function writeMove(board, move, piece, side) {
  if (move.from === move.to) return;
  if (reboundMove(board,move)) { board[move.to] = null; return; }
  board[move.from] = null;
  board[move.to] = move.promotion ? colored(move.promotion,side) : piece;
  if (move.enPassant) board[move.to + (side === WHITE ? 8 : -8)] = null;
  if (move.castle) {
    const kingSide = move.castle === 'K';
    board[move.from + (kingSide ? 3 : -4)] = null;
    board[move.from + (kingSide ? 1 : -1)] = colored('r',side);
  }
}
function undoTrial(board, move, piece, captured, side) {
  if (move.from === move.to) return;
  board[move.from] = piece;
  board[move.to] = captured;
  if (move.enPassant) board[move.to + (side === WHITE ? 8 : -8)] = colored('p',other(side));
  if (move.castle) {
    const kingSide = move.castle === 'K';
    board[move.from + (kingSide ? 3 : -4)] = colored('r',side);
    board[move.from + (kingSide ? 1 : -1)] = null;
  }
}

function available(state, side, type) {
  return !state.cooldown[side] && state.energy[side] >= POWERS[type].cost && !state.spent[side].includes(type);
}

// Generate geometric candidates and reject self-check on a scratch board. 'first'
// short-circuits stalemate probes. Checked nodes always generate every possible evasion.
function generate(state, tacticalOnly, first) {
  const moves = [], original = state.board, board = original.slice(), side = state.turn, enemy = other(side);
  const king = board.indexOf(colored('k',side));
  if (king < 0) return moves;
  const checked = attacked(board,king,enemy);
  const capturesOnly = tacticalOnly && !checked;
  const wild = effectsOf(state), due = wild.exiles.filter(item => item.remaining === 1);
  const canStartCast = !checked && (!due.length || safeAtEnd(board,king,enemy,due));

  function add(move) {
    moves.push(move);
    return first;
  }
  function safeWithout(square) {
    const saved = board[square];
    board[square] = null;
    const safe = safeAtEnd(board,king,enemy,due);
    board[square] = saved;
    return safe;
  }
  function consider(move) {
    const {from,to} = move, piece = original[from], target = original[to];
    if (from !== to && target && (owner(target) === side || target.toLowerCase() === 'k')) return false;
    if (capturesOnly && !target && !move.enPassant && !move.promotion) return false;
    const victim = move.enPassant ? to + (side === WHITE ? 8 : -8) : to;
    if (from !== to && (protectedSquare(state,victim,side) || !canLand(state,from,to))) return false;
    if (move.power && target && from !== to && nobleAt(state,victim)) return false;
    if (move.castle) {
      const kingside = move.castle === 'K', rook = from + (kingside ? 3 : -4);
      if (frozenAt(state,rook) || !canLand(state,rook, from + (kingside ? 1 : -1))) return false;
    }
    writeMove(board, move, piece, side);
    const legal = safeAtEnd(board,from === king ? to : king,enemy,due);
    undoTrial(board, move, piece, target, side);
    return legal && add(move);
  }

  function pawnMove(from, to, enPassant = false) {
    if (to < 8 || to >= 56) {
      for (const promotion of promotions) if (consider({from,to,promotion})) return true;
      return false;
    }
    return consider(enPassant ? {from,to,enPassant:true} : {from,to});
  }
  for (let from = 0; from < 64; from++) {
    const piece = original[from];
    if (!piece || owner(piece) !== side || frozenAt(state,from)) continue;
    const native = piece.toLowerCase();
    if (native === 'p') {
      const forward = side === WHITE ? -8 : 8, to = from + forward;
      if (to >= 0 && to < 64 && !original[to]) {
        if (pawnMove(from,to)) return moves;
        if ((from >> 3) === (side === WHITE ? 6 : 1) && from !== state.pawnNoDouble?.[side] && !wild.pawnLocks.includes(from) && !original[to+forward] && consider({from,to:to+forward})) return moves;
      }
      for (const capture of pawnAttacks[side][from]) {
        if (original[capture]) {
          if (pawnMove(from,capture)) return moves;
        } else if (state.ep === capture && original[capture-forward] === colored('p',enemy)) {
          if (pawnMove(from,capture,true)) return moves;
        }
      }
    } else if (native === 'n' || native === 'k') {
      const destinations = native === 'k' ? kingSteps[from] : knightSteps[from];
      for (const to of destinations) if (consider({from,to})) return moves;
      if (native === 'k' && !checked && !capturesOnly) {
        for (const option of castles[side]) {
          if (from !== option.king || !state.castling.includes(option.right)) continue;
          if (original[option.rook] !== colored('r',side) || option.empty.some(sq => original[sq])) continue;
          if (attacked(board,option.transit,enemy)) continue;
          if (consider({from,to:option.to,castle:option.side})) return moves;
        }
      }
    } else {
      const start = native === 'b' ? 4 : 0, end = native === 'r' ? 4 : 8;
      for (let d = start; d < end; d++) {
        for (const to of rays[from][d]) {
          if (consider({from,to})) return moves;
          if (original[to]) break;
        }
      }
    }

    // A counter leaves our board unchanged, so no cast can answer check.
    const type = powerAt(state,from);
    if (!canStartCast || !available(state,side,type) || native === 'k' && type === 'q') continue;
    if (capturesOnly && type !== 'b' && type !== 'q') continue;
    if (type === 'p' || type === 'n') {
      const destinations = type === 'p' ? pawnSideways[from] : knightJumps[from];
      for (const to of destinations) if (!original[to] && consider({from,to,power:type})) return moves;
    } else if (type === 'k') {
      if (consider({from,to:from,power:'k'})) return moves;
    } else if (type === 'b') {
      for (let d = 4; d < 8; d++) {
        let passed = false;
        for (const to of rays[from][d]) {
          if (passed) {
            if (consider({from,to,power:'b'})) return moves;
            if (original[to]) break;
          } else if (original[to]) passed = true;
        }
      }
    } else if (type === 'r' || type === 'q') {
      // These techniques target pieces without landing on their squares.
      const tribunal = type === 'q', range = tribunal ? 4 : 3;
      if (tribunal && !safeWithout(from)) continue;
      for (let d = 0; d < 4; d++) {
        const ray = rays[from][d];
        for (let i = 0; i < ray.length && i < range; i++) {
          const to = ray[i], target = original[to];
          if (!target || target.toLowerCase() === 'k' || owner(target) !== (tribunal ? enemy : side)) continue;
          if (tribunal && (protectedSquare(state,to,side) || nobleAt(state,to) || !safeWithout(to))) continue;
          if (add({from,to,power:type})) return moves;
        }
      }
    }
  }
  return moves;
}
export function legalMoves(state, {tacticalOnly = false} = {}) {
  return generate(state,tacticalOnly,false);
}
export function wildcardMoves(state,id) {
  const king = state.board.indexOf(colored('k',state.turn)), enemy = other(state.turn);
  if (king < 0 || attacked(state.board,king,enemy)) return [];
  const due = effectsOf(state).exiles.filter(item => item.remaining === 1);
  return cardCandidates(state,id,(from,to)=>canLand(state,from,to)).filter(move => {
    const board = state.board.slice();
    applyCardBoard(state,move,board);
    return safeAtEnd(board,king,enemy,due);
  });
}
export function hasLegalMove(state) {
  return generate(state,false,true).length > 0;
}

// FIDE repetition only distinguishes an EP target when a legal EP capture exists.
function effectiveEp(state) {
  const to = state.ep, side = state.turn;
  if (to === null || reserved(state,to)) return '-';
  const board = state.board.slice(), victim = to + (side === WHITE ? 8 : -8);
  if (board[to] || protectedSquare(state,victim,side) || board[victim] !== colored('p',other(side))) return '-';
  for (const from of pawnAttacks[other(side)][to]) {
    if (board[from] !== colored('p',side) || frozenAt(state,from) || !canLand(state,from,to)) continue;
    const move = {from,to,enPassant:true}, piece = board[from];
    writeMove(board,move,piece,side);
    const king = board.indexOf(colored('k',side));
    const due = effectsOf(state).exiles.filter(item => item.remaining === 1);
    const legal = king >= 0 && safeAtEnd(board,king,other(side),due);
    undoTrial(board,move,piece,null,side);
    if (legal) return to;
  }
  return '-';
}
function resourceKey(state, side) {
  const energy = state.energy[side];
  if (!energy) return '0';
  return energy + (state.cooldown[side] ? '!' : '.') + state.spent[side].slice().sort().join('');
}
export function keyOf(state) {
  // Fixed-width board encoding preserves empty squares and does not depend on JSON object order.
  let board = '';
  for (const piece of state.board) board += piece || '.';
  const domain = state.domain ? state.domain.side + state.domain.center : '-';
  const key = [board,state.turn,state.castling,effectiveEp(state),resourceKey(state,WHITE),resourceKey(state,BLACK),domain,state.pawnNoDouble?.w ?? '-',state.pawnNoDouble?.b ?? '-'].join('|');
  const white = counterCount(state,WHITE), black = counterCount(state,BLACK);
  // Retain compatibility with position keys in existing saved game histories.
  if (white === 2 && black === 2 && !state.shield) return key + wildKey(state);
  const shield = state.shield ? state.shield.side + state.shield.square : '-';
  return [key,white,black,shield].join('|') + wildKey(state);
}

const homeRooks = {0:'q',7:'k',56:'Q',63:'K'};
function advance(state, move, {countered = false, queenWon = true, counterSpent = false} = {}) {
  const {from,to,power,wildcard} = move, side = state.turn, enemy = other(side);
  const board = state.board.slice(), piece = board[from], type = piece.toLowerCase();
  let removed = null, moved = false;
  const rebound = !countered && reboundMove(board,move);
  if (wildcard) {
    applyCardBoard(state,move,board);
  } else if (!countered) {
    if (power === 'q') {
      removed = queenWon ? to : from;
      board[removed] = null;
    } else if (power !== 'r' && from !== to) {
      moved = true;
      if (move.enPassant) removed = to + (side === WHITE ? 8 : -8);
      else if (board[to]) removed = to;
      writeMove(board,move,piece,side);
    }
  }
  let rights = state.castling;
  if (rights) {
    if (moved && type === 'k') rights = rights.replace(side === WHITE ? /[KQ]/g : /[kq]/g,'');
    if (moved && type === 'r' && homeRooks[from]) rights = rights.replace(homeRooks[from],'');
    if (wildcard === 'relay' || wildcard === 'repulse') {
      const displaced = wildcard === 'relay' ? [from,to] : [to];
      for (const square of displaced) if (homeRooks[square] && state.board[square].toLowerCase() === 'r') rights = rights.replace(homeRooks[square],'');
    }
    if (removed !== null && state.board[removed]?.toLowerCase() === 'r' && homeRooks[removed]) {
      rights = rights.replace(homeRooks[removed],'');
    }
  }
  let counters = state.counters;
  if (counters?.w == null || counters?.b == null) counters = {w:counterCount(state,WHITE),b:counterCount(state,BLACK)};
  if (counterSpent) {
    if (counters[enemy] <= 0) throw new Error('No counters remaining');
    counters = {...counters,[enemy]:counters[enemy]-1};
  }
  const wild = updatedEffects(state,move,board,{moved,rebound,removed});
  const pawnMoved = moved && type === 'p' || wildcard === 'repulse' && state.board[to].toLowerCase() === 'p'
    || wildcard === 'relay' && (type === 'p' || state.board[to].toLowerCase() === 'p');
  const irreversible = pawnMoved || removed !== null || power || wildcard || rights !== state.castling;
  // A pawn that steps sideways on its starting rank has already taken its first move.
  let pawnNoDouble = state.pawnNoDouble ?? {w:null,b:null};
  if (pawnNoDouble.w != null && board[pawnNoDouble.w] !== 'P' && !wild.exiles.some(x=>x.square===pawnNoDouble.w && x.piece==='P')) pawnNoDouble = {...pawnNoDouble,w:null};
  if (pawnNoDouble.b != null && board[pawnNoDouble.b] !== 'p' && !wild.exiles.some(x=>x.square===pawnNoDouble.b && x.piece==='p')) pawnNoDouble = {...pawnNoDouble,b:null};
  if (pawnMoved && power === 'p' && (to >> 3) === (side === WHITE ? 6 : 1)) pawnNoDouble = {...pawnNoDouble,[side]:to};
  return {
    board,turn:enemy,castling:rights,pawnNoDouble,counters,wild,
    ep:pawnMoved && !power && !wildcard && Math.abs(to-from) === 16 ? (to+from)/2 : null,
    halfmove:pawnMoved || removed !== null ? 0 : state.halfmove+1,
    fullmove:state.fullmove + (side === BLACK ? 1 : 0),
    energy:power ? {...state.energy,[side]:state.energy[side]-POWERS[power].cost} : state.energy,
    spent:power ? {...state.spent,[side]:[...state.spent[side],power]} : state.spent,
    cooldown:!wildcard && state.cooldown[side] !== Boolean(power) ? {...state.cooldown,[side]:Boolean(power)} : state.cooldown,
    domain:power === 'k' && !countered ? {side,center:from} : null,
    shield:power === 'r' && !countered ? {side,square:to} : null,
    history:irreversible ? [] : [...state.history,keyOf(state)],
  };
}
export function resolveCast(state, generatedMove, outcome = {}) {
  if (!generatedMove.power) throw new Error('Expected a technique');
  return advance(state,generatedMove,outcome);
}
export function playLegal(state, move) {
  return advance(state,move);
}

export function applyMove(state, input) {
  if (!input || input.wildcard || !Number.isInteger(input.from) || !Number.isInteger(input.to)) throw new Error('Invalid move');
  const moves = legalMoves(state);
  if (result(state,moves)) throw new Error('The game is over');
  const move = moves.find(m => m.from === input.from && m.to === input.to
    && (m.power ?? null) === (input.power ?? null) && (m.promotion ?? null) === (input.promotion ?? null));
  if (!move) throw new Error('Illegal move');
  return playLegal(state,move);
}

function insufficientMaterial(board) {
  let minorCount = 0, knights = 0, bishopColor = -1;
  for (let sq = 0; sq < 64; sq++) {
    const type = board[sq]?.toLowerCase();
    if (!type || type === 'k') continue;
    if (type !== 'b' && type !== 'n') return false;
    minorCount++;
    if (type === 'n') knights++;
    else {
      const color = ((sq >> 3) + sq % 8) % 2;
      if (bishopColor !== -1 && bishopColor !== color) return false;
      bishopColor = color;
    }
  }
  return minorCount < 2 || knights === 0;
}

export function drawReason(state) {
  if (state.halfmove >= 100) return 'Fifty-move rule';
  if (!effectsOf(state).exiles.length && insufficientMaterial(state.board)) return 'Insufficient material';
  if (state.history.length >= 4) {
    const key = keyOf(state);
    let prior = 0;
    for (let i = state.history.length-2; i >= 0; i -= 2) {
      if (state.history[i] === key && ++prior >= 2) return 'Threefold repetition';
    }
  }
  return null;
}
export function result(state, moves) {
  if (!(moves ? moves.length : hasLegalMove(state))) {
    return inCheck(state) ? {winner:other(state.turn),reason:'Checkmate'} : {winner:null,reason:'Stalemate'};
  }
  const reason = drawReason(state);
  return reason ? {winner:null,reason} : null;
}
export function labelMove(state, move) {
  if (move.wildcard === 'trade') return WILDCARDS.trade.name;
  if (move.wildcard) return WILDCARDS[move.wildcard].name + ' · ' + coord(move.from) + (move.from === move.to ? '' : ' → ' + coord(move.to));
  if (move.castle) return move.castle === 'K' ? 'O-O' : 'O-O-O';
  if (move.power === 'k') return 'Domain Expansion · ' + coord(move.from);
  if (move.power === 'r' || move.power === 'q') return POWERS[move.power].name + ' · ' + coord(move.from) + ' → ' + coord(move.to);
  const type = state.board[move.from].toUpperCase(), piece = type === 'P' ? '' : type;
  const separator = state.board[move.to] || move.enPassant ? '×' : '–';
  const notation = piece + coord(move.from) + separator + coord(move.to) + (move.promotion ? '=' + move.promotion.toUpperCase() : '');
  return move.power ? POWERS[move.power].name + ' · ' + notation : notation;
}
