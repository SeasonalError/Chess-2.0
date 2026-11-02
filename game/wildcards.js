// The match layer privately equips/spends a card. These functions describe its
// board effects, which are shared by the local engine, bot and room server.
export const WILDCARDS = {
  kamui: {name:'Kamui Rift', description:'Remove any non-king for two subsequent turns. Its square stays empty until it returns. Pieces can pass through.'},
  noble: {name:'Noble Protection', description:'Mark an allied non-king permanently. Enemy techniques and wildcards cannot affect it. Ordinary captures still work.'},
  trade: {name:'Power Trade', description:'Secretly swap the techniques of two different allied piece types. They keep their normal moves. A king cannot risk itself in Royal Tribunal.'},
  freeze: {name:'Absolute Zero', description:'Freeze an enemy non-king for its next turn. It still attacks and defends, but cannot move, castle or cast.'},
  repulse: {name:'Repulse', description:'Choose an allied non-king and push an adjacent enemy non-king one square directly away into an empty square.'},
  relay: {name:'Relay', description:'Exchange the positions of two adjacent allied non-kings. Pawns cannot swap onto the last rank.'},
};

export function freshWild() {
  return {exiles:[],noble:[],trades:{},freeze:null,pawnLocks:[]};
}
const EMPTY = freshWild();
export const effectsOf = state => state.wild ?? EMPTY;
const owner = piece => piece < 'a' ? 'w' : 'b';
const isKing = piece => piece.toLowerCase() === 'k';
const lastRank = (piece,sq) => piece === 'P' ? sq < 8 : piece === 'p' && sq >= 56;
const pawnOnEdge = (piece,sq) => piece.toLowerCase() === 'p' && (sq < 8 || sq >= 56);
const homePawn = (piece,sq) => (piece === 'P' && sq >> 3 === 6) || (piece === 'p' && sq >> 3 === 1);
export const powerAt = (state,sq) => state.board[sq] ? effectsOf(state).trades[sq] ?? state.board[sq].toLowerCase() : null;
export const reserved = (state,sq) => effectsOf(state).exiles.some(item => item.square === sq);
export const nobleAt = (state,sq) => effectsOf(state).noble.includes(sq);
export const frozenAt = (state,sq) => effectsOf(state).freeze?.square === sq;
export function reboundMove(board,move) {
  return (move.power === 'b' || move.power === 'n') && lastRank(board[move.from],move.to);
}
export function pushSquare(from,to) {
  const dr = (to >> 3) - (from >> 3), df = to % 8 - from % 8;
  const rank = (to >> 3) + dr, file = to % 8 + df;
  if (Math.max(Math.abs(dr),Math.abs(df)) !== 1 || rank < 0 || rank > 7 || file < 0 || file > 7) return -1;
  return 8*rank + file;
}
function adjacent(a,b) {
  return Math.max(Math.abs((a >> 3)-(b >> 3)),Math.abs(a%8-b%8)) === 1;
}

// Geometry only. The caller checks both immediate and returning-piece king safety.
export function cardCandidates(state,id,canLand) {
  if (!Object.hasOwn(WILDCARDS,id)) return [];
  const {board,turn} = state, moves = [];
  for (let from=0; from<64; from++) {
    const piece = board[from];
    if (!piece || (id !== 'trade' && isKing(piece))) continue;
    const ally = owner(piece) === turn;
    const hostileImmune = !ally && nobleAt(state,from);
    if (id === 'kamui' || id === 'freeze' || id === 'noble') {
      const shielded = state.shield?.square === from && state.shield.side !== turn;
      if (id === 'kamui' && !hostileImmune && !(!ally && shielded)
        || id === 'freeze' && !ally && !hostileImmune
        || id === 'noble' && ally && !nobleAt(state,from)) moves.push({wildcard:id,from,to:from});
      continue;
    }
    if (!ally || id === 'repulse' && frozenAt(state,from)) continue;
    for (let to=0; to<64; to++) {
      const target = board[to];
      if (!target || from === to || (id !== 'trade' && isKing(target))) continue;
      if (id === 'trade') {
        if (owner(target) === turn && piece.toLowerCase() !== target.toLowerCase() && powerAt(state,from) !== powerAt(state,to)) {
          moves.push({wildcard:id,from,to});
        }
      } else if (id === 'relay') {
        if (owner(target) === turn && adjacent(from,to) && !pawnOnEdge(piece,to) && !pawnOnEdge(target,from)
          && !frozenAt(state,from) && !frozenAt(state,to) && canLand(from,to) && canLand(to,from)) moves.push({wildcard:id,from,to});
      } else if (owner(target) !== turn && !nobleAt(state,to)) {
        const dest = pushSquare(from,to);
        if (dest >= 0 && !board[dest] && !pawnOnEdge(target,dest) && canLand(to,dest)) moves.push({wildcard:id,from,to});
      }
    }
  }
  return moves;
}

export function applyCardBoard(state,move,board) {
  const {from,to,wildcard} = move;
  if (wildcard === 'kamui') board[from] = null;
  if (wildcard === 'repulse') {
    const dest = pushSquare(from,to);
    board[dest] = board[to];
    board[to] = null;
  }
  if (wildcard === 'relay') [board[from],board[to]] = [board[to],board[from]];
}

export function restoreDue(board,exiles) {
  for (const item of exiles) if (item.remaining === 1) board[item.square] = item.piece;
}

// Persist tags by piece identity. Simultaneous relocation matters if two
// same-type pieces exchange squares, or a tagged piece takes another tagged piece.
export function updatedEffects(state,move,board,{moved=false,removed=null,rebound=false}={}) {
  const old = effectsOf(state), {from,to,wildcard:id} = move, piece = state.board[from];
  if (!id && !old.freeze && !old.exiles.length && !old.noble.length && !Object.keys(old.trades).length && !old.pawnLocks.length &&
    !(moved && homePawn(piece,rebound ? from : to))) return old;
  const locations = new Map();
  if (moved && !rebound) {
    locations.set(from,to);
    if (move.castle) {
      const kingside = move.castle === 'K';
      locations.set(from + (kingside ? 3 : -4), from + (kingside ? 1 : -1));
    }
  }
  if (id === 'relay') { locations.set(from,to); locations.set(to,from); }
  if (id === 'repulse') locations.set(to,pushSquare(from,to));

  const relocate = square => square === removed ? null : locations.get(square) ?? square;
  const noble = old.noble.map(relocate).filter(sq => sq !== null);
  if (id === 'noble') noble.push(from);
  const trades = {};
  for (const [square,power] of Object.entries(old.trades)) {
    const dest = relocate(Number(square));
    if (dest !== null) trades[dest] = power;
  }
  if (id === 'trade') {
    trades[from] = powerAt(state,to);
    trades[to] = powerAt(state,from);
  }
  const pawnLocks = old.pawnLocks.filter(square => square !== removed && !locations.has(square));
  for (const [start,dest] of locations) if (homePawn(state.board[start],dest)) pawnLocks.push(dest);
  if (rebound && homePawn(piece,from) && !pawnLocks.includes(from)) pawnLocks.push(from);
  const exiles = old.exiles.filter(item => item.remaining > 1).map(item => ({...item,remaining:item.remaining-1}));
  if (id === 'kamui') exiles.push({square:from, piece, remaining:2});
  restoreDue(board,old.exiles);
  return {exiles,noble,trades,pawnLocks,freeze:id === 'freeze' ? {side:owner(piece),square:from} : null};
}

export function wildKey(state) {
  const wild = effectsOf(state);
  if (!wild.freeze && !wild.exiles.length && !wild.noble.length && !wild.pawnLocks.length && !Object.keys(wild.trades).length) return '';
  const ascending = (a,b) => a-b;
  return '|wild:' + JSON.stringify([
    wild.exiles.map(x=>[x.square,x.piece,x.remaining]).sort((a,b)=>a[0]-b[0]),
    [...wild.noble].sort(ascending), Object.entries(wild.trades),wild.freeze?.square ?? null,[...wild.pawnLocks].sort(ascending),
  ]);
}
function visibleTrades(entries,board,exiles,viewer) {
  return entries.filter(([square]) => {
    const sq = Number(square), piece = board[sq] === '.' ? null : board[sq];
    const carrier = piece ?? exiles.find(item=>item.square===sq)?.piece;
    return carrier && owner(carrier) === viewer;
  });
}
function redactPositionKey(key,viewer) {
  const split = key.indexOf('|wild:');
  if (split < 0) return key;
  try {
    const data = JSON.parse(key.slice(split+6));
    const exiles = data[0].map(([square,piece])=>({square,piece}));
    data[2] = visibleTrades(data[2],key.slice(0,64),exiles,viewer);
    const empty = !data[0].length && !data[1].length && !data[2].length && data[3] === null && !data[4].length;
    return key.slice(0,split) + (empty ? '' : '|wild:' + JSON.stringify(data));
  } catch {
    // Unknown formats must not leak a historical private assignment.
    return null;
  }
}
export function redactWildcardState(state,viewer) {
  const wild = effectsOf(state);
  const trades = Object.fromEntries(visibleTrades(Object.entries(wild.trades),state.board,wild.exiles,viewer));
  const history = state.history.map(key=>redactPositionKey(key,viewer)).filter(key=>key !== null);
  return {...state,history,wild:{...wild,trades}};
}
