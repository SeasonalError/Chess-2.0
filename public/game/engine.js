// Riftbound uses ordinary chess attacks for check, even when a technique is ready.
// Squares run a8..h1 from 0..63. All public state is plain, serializable data.
export const POWERS = {
  p: {name: 'Vector Step', cost: 1, description: 'Slide one file sideways into an empty square.'},
  n: {name: 'Rift Jump', cost: 1, description: 'Teleport exactly two squares along a rank or file to an empty square.'},
  b: {name: 'Phase Lance', cost: 1, description: 'Pass through one piece diagonally. Land beyond it or capture the first enemy beyond it.'},
  r: {name: 'Iron Vault', cost: 1, description: 'Vault the first friendly piece on a rank or file and land on the empty square immediately beyond it.'},
  q: {name: 'Mirror Step', cost: 1, description: 'Teleport exactly two squares diagonally to an empty square, ignoring blockers.'},
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
const queenSteps = steps(diagonal.map(([r,f]) => [2*r, 2*f]));
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
    energy:{w:3,b:3}, spent:{w:[],b:[]}, cooldown:{w:false,b:false}, domain:null,
    history:[],
  };
}

function attacked(board, sq, by) {
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
function sealed(domain, sq, mover) {
  return domain && domain.side !== mover && kingSteps[domain.center].includes(sq);
}

// Used on a private board copy for legal filtering, and on a fresh board per played move.
function writeMove(board, move, piece, side) {
  if (move.from === move.to) return;
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

  function consider(move) {
    const {from,to} = move, piece = original[from], target = original[to];
    if (from !== to && target && (owner(target) === side || target.toLowerCase() === 'k')) return false;
    if (capturesOnly && !target && !move.enPassant && !move.promotion) return false;
    if (sealed(state.domain, to, side)) return false;
    if (move.castle && sealed(state.domain, from + (move.castle === 'K' ? 1 : -1), side)) return false;
    writeMove(board, move, piece, side);
    const legal = !attacked(board, from === king ? to : king, enemy);
    undoTrial(board, move, piece, target, side);
    if (legal) moves.push(move);
    return legal && first;
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
    if (!piece || owner(piece) !== side) continue;
    const type = piece.toLowerCase();
    if (type === 'p') {
      const forward = side === WHITE ? -8 : 8, to = from + forward;
      if (to >= 0 && to < 64 && !original[to]) {
        if (pawnMove(from,to)) return moves;
        if ((from >> 3) === (side === WHITE ? 6 : 1) && from !== state.pawnNoDouble?.[side] && !original[to+forward] && consider({from,to:to+forward})) return moves;
      }
      for (const capture of pawnAttacks[side][from]) {
        if (original[capture]) {
          if (pawnMove(from,capture)) return moves;
        } else if (state.ep === capture && original[capture-forward] === colored('p',enemy)) {
          if (pawnMove(from,capture,true)) return moves;
        }
      }
    } else if (type === 'n' || type === 'k') {
      const destinations = type === 'k' ? kingSteps[from] : knightSteps[from];
      for (const to of destinations) if (consider({from,to})) return moves;
      if (type === 'k' && !checked && !capturesOnly) {
        for (const option of castles[side]) {
          if (from !== option.king || !state.castling.includes(option.right)) continue;
          if (original[option.rook] !== colored('r',side) || option.empty.some(sq => original[sq])) continue;
          if (attacked(board,option.transit,enemy)) continue;
          if (consider({from,to:option.to,castle:option.side})) return moves;
        }
      }
    } else {
      const start = type === 'b' ? 4 : 0, end = type === 'r' ? 4 : 8;
      for (let d = start; d < end; d++) {
        for (const to of rays[from][d]) {
          if (consider({from,to})) return moves;
          if (original[to]) break;
        }
      }
    }

    if (!available(state,side,type)) continue;
    if (capturesOnly && type !== 'b') continue;
    if (type === 'p' || type === 'n' || type === 'q') {
      const destinations = type === 'p' ? pawnSideways[from] : type === 'n' ? knightJumps[from] : queenSteps[from];
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
    } else if (type === 'r') {
      for (let d = 0; d < 4; d++) {
        const ray = rays[from][d];
        const blocker = ray.findIndex(sq => original[sq]);
        if (blocker < 0 || owner(original[ray[blocker]]) !== side || blocker + 1 >= ray.length) continue;
        const to = ray[blocker+1];
        if (!original[to] && consider({from,to,power:'r'})) return moves;
      }
    }
  }
  return moves;
}
export function legalMoves(state, {tacticalOnly = false} = {}) {
  return generate(state,tacticalOnly,false);
}
export function hasLegalMove(state) {
  return generate(state,false,true).length > 0;
}

// FIDE repetition only distinguishes an EP target when a legal EP capture exists.
function effectiveEp(state) {
  const to = state.ep, side = state.turn;
  if (to === null || sealed(state.domain,to,side)) return '-';
  const board = state.board.slice(), victim = to + (side === WHITE ? 8 : -8);
  if (board[to] || board[victim] !== colored('p',other(side))) return '-';
  for (const from of pawnAttacks[other(side)][to]) {
    if (board[from] !== colored('p',side)) continue;
    const move = {from,to,enPassant:true}, piece = board[from];
    writeMove(board,move,piece,side);
    const king = board.indexOf(colored('k',side));
    const legal = king >= 0 && !attacked(board,king,other(side));
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
  return [board,state.turn,state.castling,effectiveEp(state),resourceKey(state,WHITE),resourceKey(state,BLACK),domain,state.pawnNoDouble?.w ?? '-',state.pawnNoDouble?.b ?? '-'].join('|');
}

const homeRooks = {0:'q',7:'k',56:'Q',63:'K'};
function remainingCastling(state, move, type, target) {
  let rights = state.castling;
  if (!rights) return rights;
  if (type === 'k' && move.from !== move.to) rights = rights.replace(state.turn === WHITE ? /[KQ]/g : /[kq]/g,'');
  if (type === 'r' && homeRooks[move.from]) rights = rights.replace(homeRooks[move.from],'');
  if (target?.toLowerCase() === 'r' && homeRooks[move.to]) rights = rights.replace(homeRooks[move.to],'');
  return rights;
}

export function playLegal(state, move) {
  const {from,to,power} = move, side = state.turn, board = state.board.slice(), piece = board[from], type = piece.toLowerCase();
  const target = from === to ? null : board[to], capture = Boolean(target || move.enPassant);
  writeMove(board,move,piece,side);
  const rights = remainingCastling(state,move,type,target);
  const irreversible = type === 'p' || capture || power || rights !== state.castling;
  // A pawn that steps sideways on its starting rank has already taken its first move.
  let pawnNoDouble = state.pawnNoDouble;
  if (pawnNoDouble?.w === from || pawnNoDouble?.w === to) pawnNoDouble = {...pawnNoDouble,w:null};
  if (pawnNoDouble?.b === from || pawnNoDouble?.b === to) pawnNoDouble = {...pawnNoDouble,b:null};
  if (power === 'p' && (to >> 3) === (side === WHITE ? 6 : 1)) pawnNoDouble = {...pawnNoDouble,[side]:to};
  return {
    board,turn:other(side),castling:rights,pawnNoDouble,
    ep:type === 'p' && !power && Math.abs(to-from) === 16 ? (to+from)/2 : null,
    halfmove:type === 'p' || capture ? 0 : state.halfmove+1,
    fullmove:state.fullmove + (side === BLACK ? 1 : 0),
    energy:power ? {...state.energy,[side]:state.energy[side]-POWERS[power].cost} : state.energy,
    spent:power ? {...state.spent,[side]:[...state.spent[side],power]} : state.spent,
    cooldown:state.cooldown[side] !== Boolean(power) ? {...state.cooldown,[side]:Boolean(power)} : state.cooldown,
    domain:power === 'k' ? {side,center:from} : null,
    history:irreversible ? [] : [...state.history,keyOf(state)],
  };
}

export function applyMove(state, input) {
  if (!input || !Number.isInteger(input.from) || !Number.isInteger(input.to)) throw new Error('Invalid move');
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
  if (insufficientMaterial(state.board)) return 'Insufficient material';
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
  if (move.castle) return move.castle === 'K' ? 'O-O' : 'O-O-O';
  if (move.power === 'k') return 'Domain Expansion · ' + coord(move.from);
  const type = state.board[move.from].toUpperCase(), piece = type === 'P' ? '' : type;
  const separator = state.board[move.to] || move.enPassant ? '×' : '–';
  const notation = piece + coord(move.from) + separator + coord(move.to) + (move.promotion ? '=' + move.promotion.toUpperCase() : '');
  return move.power ? POWERS[move.power].name + ' · ' + notation : notation;
}
