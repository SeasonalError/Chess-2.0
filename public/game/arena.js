import {
  initialState, legalMoves, applyMove, labelMove, coord, POWERS, inCheck, result,
} from './engine.js';

const el = id => document.getElementById(id);
const names = {p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King'};
const levels = {easy: 'Initiate', medium: 'Veteran', hard: 'Apex'};
const sideName = side => side === 'w' ? 'White' : 'Black';
const sideOf = piece => piece === piece.toUpperCase() ? 'w' : 'b';
const icon = name => '<svg aria-hidden="true"><use href="./art/ui.svg#' + name + '"/></svg>';
const sprite = (piece, cls = '') => '<svg class="' + cls + '" viewBox="0 0 64 64" aria-hidden="true"><use href="./art/pieces.svg#' + sideOf(piece) + piece.toLowerCase() + '"/></svg>';
const escapeText = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const storage = {
  read(key) {
    try { return JSON.parse(localStorage.getItem('riftbound:v1:' + key)); }
    catch { return null; }
  },
  write(key, value) {
    try { localStorage.setItem('riftbound:v1:' + key, JSON.stringify(value)); }
    catch { /* In restricted browser sessions the game still works until refresh. */ }
  },
};

const board = el('board');
const modal = el('modal');
let game = initialState(), log = [], side = 'w', level = 'hard', mode = 'bot', outcome = null, moves = [];
let room = null, token = '', selected = null, armed = false, technique = 'n', flipped = false;
let worker = null, job = 0, botError = false, busy = false, pollBusy = false, offline = false;
let sound = !!storage.read('sound'), audio = null, flash = null, flashTimer, toastTimer;
let roomEpoch = 0, roving = 52;

function toast(message) {
  el('toast').textContent = message;
  el('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el('toast').classList.remove('show'), 2500);
}

function ping(power) {
  if (!sound) return;
  try {
    audio ??= new AudioContext();
    void audio.resume();
    const osc = audio.createOscillator(), gain = audio.createGain(), t = audio.currentTime;
    osc.type = power ? 'triangle' : 'sine';
    osc.frequency.setValueAtTime(power ? 420 : 275, t);
    osc.frequency.exponentialRampToValueAtTime(power ? 890 : 150, t + 0.11);
    gain.gain.setValueAtTime(0.055, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(gain); gain.connect(audio.destination);
    osc.start(t); osc.stop(t + 0.14);
  } catch { /* Audio is optional. */ }
}

function show(title, body, kicker = 'ARENA / CONTROL') {
  el('modal-body').innerHTML = '<div class="eyebrow"><span class="line"></span>' + kicker +
    '</div><h2 class="dialog-title" id="dialog-title">' + title + '</h2>' + body;
  modal.setAttribute('aria-labelledby', 'dialog-title');
  if (!modal.open) modal.showModal();
}
function hide() { if (modal.open) modal.close(); }

el('modal-close').onclick = hide;
modal.addEventListener('click', event => {
  if (event.target !== modal) return;
  const bounds = modal.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) hide();
});

function selectRules() {
  show('Rules of the rift',
    '<p class="dialog-text">Checkmate wins. Your pieces move as in chess until you spend a charge.</p>' +
    '<ul class="rules-list"><li>Each side starts with <b>three charges for the entire duel</b>. Each piece type can cast its technique once across your army.</li>' +
    '<li>A technique takes your entire turn. Play a normal move before casting again. Most techniques cost one charge. Domain Expansion costs two.</li>' +
    '<li>Select a piece for normal moves. To cast, choose its type in the deck, arm the technique, then choose a highlighted piece and destination. For Domain Expansion, choose the king’s own square.</li>' +
    '<li>Check uses ordinary chess attacks. You must escape check, and cannot expose your king with a technique. Castling, en passant and all four promotions are available.</li>' +
    '<li>Stalemate, threefold repetition, fifty moves by each side without a pawn move or capture, and insufficient mating material draw automatically.</li></ul>' +
    '<div class="dlg-actions"><button id="view-codex" class="secondary">Technique codex</button><button class="primary" id="ok">Enter arena</button></div>',
    'FIELD MANUAL / 01');
  el('ok').onclick = hide;
  el('view-codex').onclick = selectCodex;
}
function selectCodex() {
  const entries = Object.entries(POWERS).map(([type, power]) =>
    '<div class="codex-item">' + sprite(type.toUpperCase()) +
    '<div><b>' + power.name + '</b><small>' + names[type].toUpperCase() + ' · ' + power.cost +
    ' CHG</small><p>' + power.description + '</p></div></div>');
  show('Technique codex', '<p class="dialog-text">Six techniques. Three charges. Both sides use the same deck.</p>' +
    '<div class="codex-list">' + entries.join('') + '</div>', 'FIELD MANUAL / 02');
}
function selectNew() {
  const options = Object.entries(levels).map(([value, name]) =>
    '<option value="' + value + '">' + name + '</option>');
  show('New bot duel', '<p class="dialog-text">Challenge The Oracle. Apex gives it the longest time to search for tactics and techniques.</p>' +
    '<label class="form-label" for="bot-level">Opponent level</label><select id="bot-level">' + options.join('') + '</select>' +
    '<label class="form-label" for="bot-side">Play as</label><select id="bot-side"><option value="w">White · move first</option><option value="b">Black · move second</option></select>' +
    '<div class="dlg-actions"><button class="secondary" id="cancel">Cancel</button><button class="primary" id="launch">Start duel ' + icon('arrow') + '</button></div>', 'SOLO MATCH / SETUP');
  el('bot-side').value = side;
  el('bot-level').value = level;
  el('cancel').onclick = hide;
  el('launch').onclick = () => newBot(el('bot-side').value, el('bot-level').value);
}

function stopWorker() {
  job++;
  worker?.terminate();
  worker = null;
  botError = false;
}
function resetSelection() { selected = null; armed = false; }
function saveSolo() {
  if (mode === 'bot') storage.write('solo', {game, log, side, level, outcome});
}
function mine() {
  return !busy && !outcome && side === game.turn && (mode === 'bot' || room?.ready);
}
function refreshGame() {
  moves = legalMoves(game);
  outcome ??= result(game, moves);
  render();
}
function newBot(color, difficulty) {
  stopWorker();
  roomEpoch++;
  mode = 'bot'; room = null; token = ''; busy = false; offline = false;
  game = initialState(); log = []; outcome = null; side = color; flipped = side === 'b'; level = difficulty;
  resetSelection(); technique = 'n';
  history.replaceState(null, '', location.pathname);
  hide(); refreshGame(); saveSolo(); runBot();
}
function notePower(move, mover) {
  if (!move?.power) return;
  const overlay = document.createElement('div');
  overlay.className = 'cast-fx';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.innerHTML = '<img src="./art/' + (mover === side ? 'duelist' : 'oracle') + '.svg" alt="">' +
    '<div><span>TECHNIQUE ACTIVATED</span><strong>' + POWERS[move.power].name + '</strong></div>';
  document.querySelector('.cast-fx')?.remove();
  board.parentElement.append(overlay);
  setTimeout(() => overlay.remove(), 850);
  flash = move.to;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = null; drawBoard(); }, 650);
  toast(POWERS[move.power].name);
}
function soloMove(move) {
  const label = labelMove(game, move), moving = game.turn;
  game = applyMove(game, move);
  log.push({label, side: moving, from: move.from, to: move.to, power: move.power});
  resetSelection(); notePower(move, moving); ping(!!move.power);
  refreshGame(); saveSolo(); runBot();
}
function runBot() {
  if (mode !== 'bot' || outcome || game.turn === side || worker) return;
  const id = ++job;
  const fail = () => {
    if (id !== job) return;
    stopWorker(); botError = true; render();
  };
  try {
    worker = new Worker(new URL('./bot-worker.js', import.meta.url), {type: 'module'});
    worker.onerror = fail;
    worker.onmessage = ({data}) => {
      if (id !== job || data.id !== id) return;
      if (data.error || !data.move) { fail(); return; }
      stopWorker();
      try { soloMove(data.move); } catch { botError = true; render(); }
    };
    worker.postMessage({id, state: game, level});
    render();
  } catch { fail(); }
}
function controlledMove(move) {
  if (!mine()) return;
  if (mode === 'bot') { soloMove(move); return; }
  const intent = {from: move.from, to: move.to};
  if (move.power) intent.power = move.power;
  if (move.promotion) intent.promotion = move.promotion;
  void roomAction('move', {move: intent});
}
function choosePromotion(options) {
  const choices = options.map(move =>
    '<button data-promo="' + move.promotion + '" aria-label="Promote to ' + names[move.promotion] + '">' +
    sprite(side === 'w' ? move.promotion.toUpperCase() : move.promotion) + '</button>');
  show('Choose a promotion', '<p class="dialog-text">Your pawn reached the last rank. Choose the piece it becomes.</p>' +
    '<div class="promos">' + choices.join('') + '</div>', 'PAWN / PROMOTION');
  for (const button of modal.querySelectorAll('[data-promo]')) {
    button.onclick = () => { hide(); controlledMove(options.find(m => m.promotion === button.dataset.promo)); };
  }
}

function selectSquare(index) {
  roving = index;
  if (!mine()) return;
  const piece = game.board[index];
  const targets = selected == null ? [] : moves.filter(move =>
    move.from === selected && move.to === index && (armed ? move.power === technique : !move.power));
  if (targets.length) {
    if (targets.length > 1) choosePromotion(targets);
    else controlledMove(targets[0]);
    return;
  }
  if (armed && piece && sideOf(piece) === side && piece.toLowerCase() === technique &&
      moves.some(move => move.from === index && move.power === technique)) {
    selected = index; render(); return;
  }
  if (piece && sideOf(piece) === side) {
    armed = false;
    selected = selected === index ? null : index;
    if (selected != null) technique = piece.toLowerCase();
  } else { resetSelection(); }
  render();
}
function arm() {
  if (armed) { armed = false; render(); return; }
  const choices = moves.filter(move => move.power === technique);
  if (!mine() || !choices.length) return;
  const origins = [...new Set(choices.map(move => move.from))];
  armed = true;
  if (!origins.includes(selected)) selected = origins.length === 1 ? origins[0] : null;
  render();
  if (matchMedia('(max-width:680px)').matches) board.scrollIntoView({block: 'center', behavior: 'smooth'});
}

function drawBoard() {
  const focused = board.contains(document.activeElement);
  const indices = Array.from({length:64}, (_, i) => flipped ? 63 - i : i);
  const last = log.at(-1), checked = inCheck(game, game.turn), domain = game.domain;
  const selectedMoves = selected == null ? [] : moves.filter(move =>
    move.from === selected && (armed ? move.power === technique : !move.power));
  board.innerHTML = indices.map(i => {
    const piece = game.board[i], row = i >> 3, col = i % 8;
    const target = selectedMoves.some(move => move.to === i);
    const cls = ['square', (row + col) % 2 ? 'dark' : 'light'];
    if (last && (last.from === i || last.to === i)) cls.push('last');
    if (i === selected) cls.push('selected');
    if (target) {
      cls.push('legal');
      if (piece) cls.push('capture');
      if (selected === i) cls.push('same');
      if (armed) cls.push('special');
    }
    if (armed && selected == null && moves.some(move => move.from === i && move.power === technique)) cls.push('caster');
    if (checked && piece?.toLowerCase() === 'k' && sideOf(piece) === game.turn) cls.push('check');
    if (domain && Math.max(Math.abs((domain.center >> 3) - row), Math.abs(domain.center % 8 - col)) === 1) cls.push('seal');
    if (flash === i) cls.push('flash');
    const label = coord(i) + (piece ? ' ' + sideName(sideOf(piece)) + ' ' + names[piece.toLowerCase()] : ' empty') + (target ? ' · legal destination' : '');
    return '<button class="' + cls.join(' ') + '" tabindex="' + (roving === i ? 0 : -1) +
      '" aria-label="' + label + '" aria-pressed="' + (i === selected) + '" data-square="' + i + '">' +
      (piece ? sprite(piece, 'piece') : '') + '</button>';
  }).join('');
  el('files').innerHTML = [...(flipped ? 'hgfedcba' : 'abcdefgh')].map(f => '<span>' + f + '</span>').join('');
  el('ranks').innerHTML = [...(flipped ? '12345678' : '87654321')].map(r => '<span>' + r + '</span>').join('');
  if (focused) board.querySelector('[data-square="' + roving + '"]')?.focus({preventScroll:true});
}

board.onclick = event => {
  const button = event.target.closest('[data-square]');
  if (button) selectSquare(Number(button.dataset.square));
};
board.onkeydown = event => {
  const button = event.target.closest('[data-square]');
  const deltas = {ArrowUp:-8, ArrowDown:8, ArrowLeft:-1, ArrowRight:1};
  if (!button || !(event.key in deltas)) return;
  event.preventDefault();
  const from = Number(button.dataset.square), delta = deltas[event.key] * (flipped ? -1 : 1), to = from + delta;
  if (to < 0 || to > 63 || (Math.abs(delta) === 1 && (to >> 3) !== (from >> 3))) return;
  roving = to;
  button.tabIndex = -1;
  const next = board.querySelector('[data-square="' + to + '"]');
  next.tabIndex = 0; next.focus();
};
function drawPlayer(id, color) {
  const self = color === side;
  const identity = self ? 'You' : mode === 'bot' ? 'The Oracle' : room?.ready ? 'Challenger' : 'Open seat';
  const charge = game.energy[color];
  const pips = [0,1,2].map(i => '<i class="pip ' + (i < charge ? 'full' : '') + '"></i>').join('');
  el(id).innerHTML = '<div class="player-crest">' + icon(self ? 'rift' : mode === 'bot' ? 'cpu' : 'shield') +
    '</div><div class="player-info"><strong>' + identity + '</strong><small>' + sideName(color).toUpperCase() +
    ' PIECES</small></div><div class="energy" aria-label="' + charge + ' charges remaining"><span>CHARGES</span>' + pips + '</div>';
}
function drawDeck() {
  el('tech-tabs').innerHTML = Object.keys(names).map(type => {
    const title = names[type] + ' · ' + POWERS[type].name;
    return '<button data-type="' + type + '" class="type-tab ' + (game.spent[side].includes(type) ? 'spent' : '') +
      '" aria-label="' + title + '" title="' + title + '" aria-pressed="' + (technique === type) + '">' +
      sprite(side === 'w' ? type.toUpperCase() : type) + '</button>';
  }).join('');
  const power = POWERS[technique];
  el('tech-index').textContent = names[technique].toUpperCase() + ' / TECHNIQUE 0' + (Object.keys(names).indexOf(technique) + 1);
  el('tech-name').textContent = power.name;
  el('tech-text').textContent = power.description;
  el('tech-meta').innerHTML = icon('bolt') + power.cost + ' CHARGE' + (power.cost > 1 ? 'S' : '') + ' <i></i> ONCE PER SIDE';
  const button = el('power-btn'), possible = moves.some(move => move.power === technique);
  button.disabled = !mine() || !possible;
  button.classList.toggle('armed', armed);
  let caption = 'Arm technique';
  if (armed) caption = 'Cancel technique';
  else if (outcome) caption = 'Duel complete';
  else if (game.spent[side].includes(technique)) caption = 'Technique spent';
  else if (game.energy[side] < power.cost) caption = 'Insufficient charges';
  else if (game.cooldown[side]) caption = 'Play a normal move first';
  else if (!mine()) caption = 'Waiting for your turn';
  else if (!possible) caption = 'No legal target';
  button.querySelector('span').textContent = caption;
}

function drawStatus() {
  let message, action, warning = false;
  if (outcome) {
    message = (outcome.winner ? outcome.winner === side ? 'You won' : 'You lost' : 'Draw') + ' · ' + outcome.reason;
    action = ['New duel', mode === 'room' ? () => friendModal() : selectNew];
  } else if (mode === 'room' && offline) {
    message = 'Connection interrupted. Reconnecting…'; warning = true;
  } else if (mode === 'room' && !room.ready) {
    message = 'Waiting for a friend to join.'; action = ['Copy invite', copyInvite];
  } else if (botError) {
    message = 'The bot could not finish its turn.';
    action = ['Retry bot', () => { botError = false; runBot(); }];
  } else if (busy) {
    message = 'Submitting your move…';
  } else if (game.turn !== side) {
    message = mode === 'bot' ? 'The Oracle is thinking…' : 'Your friend is thinking…';
  } else if (armed) {
    message = selected == null ? 'Choose a highlighted ' + names[technique].toLowerCase() + '.' :
      technique === 'k' ? 'Choose the king’s square to expand its domain.' :
        'Choose a violet destination to cast ' + POWERS[technique].name + '.';
  } else if (inCheck(game, side)) {
    message = 'Check. Find a move that protects your king.'; warning = true;
  } else if (selected != null) {
    message = names[game.board[selected].toLowerCase()] + ' on ' + coord(selected) + ' · choose a legal destination.';
    if (moves.some(move => move.from === selected && move.power)) action = ['Arm technique', arm];
  } else {
    message = 'Your turn · select a piece to see its legal moves.';
  }
  const bar = el('status');
  bar.innerHTML = icon(warning ? 'shield' : 'crosshair') + '<span>' + escapeText(message) + '</span>';
  bar.classList.toggle('alert', warning);
  if (action) {
    const button = document.createElement('button');
    button.className = 'status-action';
    button.textContent = action[0]; button.onclick = action[1];
    bar.append(button);
  }
}
function drawLog() {
  const cell = move => {
    if (!move) return '';
    const label = escapeText(move.label);
    return move.power ? '<em>' + label + '</em>' : label;
  };
  el('log-count').textContent = String(log.length).padStart(2, '0');
  let rows = '';
  for (let i = 0; i < log.length; i += 2) {
    rows += '<div class="log-row"><span>' + String(1 + i / 2).padStart(2, '0') + '</span><span>' +
      cell(log[i]) + '</span><span>' + cell(log[i+1]) + '</span></div>';
  }
  const body = el('log-body'), nearEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 20;
  body.innerHTML = rows || '<div class="log-empty">' + icon('log') +
    '<div><strong>Awaiting the first move</strong><small>Your duel history appears here.</small></div></div>';
  if (nearEnd) body.scrollTop = body.scrollHeight;
}
function render() {
  drawBoard();
  drawPlayer('north', flipped ? 'w' : 'b');
  drawPlayer('south', flipped ? 'b' : 'w');
  drawDeck(); drawStatus(); drawLog();
  const online = mode === 'room';
  el('board-mode').textContent = online ? 'ROOM DUEL' : 'BOT DUEL';
  el('profile-name').textContent = online ? 'Challenger' : 'The Oracle';
  el('profile-type').textContent = online ? (room.ready ? 'Friend connected' : 'Awaiting challenger') : 'AI opponent';
  el('profile-badge').textContent = online ? 'HUMAN DUELIST' : 'TACTICAL BOT';
  el('profile-level').textContent = online ? 'Private room' : levels[level] + ' level';
  el('opponent-art').src = './art/' + (online ? 'duelist' : 'oracle') + '.svg';
  el('room-tools').hidden = !online;
  if (online) {
    el('room-tool-label').textContent = 'ROOM / ' + room.code;
    el('resign').hidden = !!outcome || !room.ready;
  }
}

el('tech-tabs').onclick = event => {
  const button = event.target.closest('[data-type]');
  if (!button) return;
  technique = button.dataset.type; armed = false;
  if (selected != null && game.board[selected]?.toLowerCase() !== technique) selected = null;
  render();
};
el('power-btn').onclick = arm;
el('nav-arena').onclick = () => window.scrollTo({top: 0, behavior: 'smooth'});
el('deck-info').onclick = selectCodex;
el('nav-codex').onclick = selectCodex;
el('rules-top').onclick = selectRules;
el('new').onclick = selectNew;
el('flip').onclick = () => { flipped = !flipped; render(); };
function soundButton() {
  const label = sound ? 'Mute sound effects' : 'Enable sound effects';
  el('sound').innerHTML = icon(sound ? 'volume' : 'mute');
  el('sound').title = label;
  el('sound').setAttribute('aria-label', label);
  el('sound').setAttribute('aria-pressed', String(sound));
}
el('sound').onclick = () => { sound = !sound; storage.write('sound', sound); soundButton(); ping(true); };
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !modal.open) { resetSelection(); render(); }
});

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}
async function api(path, method, seat, body) {
  const response = await fetch('/api/rooms' + path, {
    method, cache: 'no-store',
    headers: {'Content-Type':'application/json', Authorization:'Bearer ' + seat},
    ...(body ? {body:JSON.stringify(body)} : {}),
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json().catch(() => ({error:'The room service is unavailable. Try again.'}));
  if (!response.ok || !data.state) throw new Error(data.error || 'Room request failed.');
  return data;
}
function acceptSnapshot(data, fresh = false) {
  if (!fresh && data.revision <= room.revision) {
    if (offline) { offline = false; render(); }
    return;
  }
  const previous = log.length;
  room = data; game = data.state; side = data.side; log = data.log; outcome = data.outcome;
  resetSelection(); offline = false;
  if (fresh) { flipped = side === 'b'; technique = 'n'; }
  if (!fresh && previous < log.length) {
    const move = log.at(-1);
    notePower(move, move.side); ping(!!move.power);
  }
  refreshGame();
}
function friendModal(invite = '') {
  const description = invite ? 'Your friend invited you to sit across the board.' :
    'Create a room and send its invite to a friend, or join with their room code.';
  show(invite ? 'Join this duel' : 'Play a friend', '<p class="dialog-text">' + description + '</p>' +
    (invite ? '' : '<button id="create-room" class="primary">' + icon('plus') + ' Create room</button>') +
    '<form class="room-form" id="join-form"><label class="form-label" for="join-code">Room code</label>' +
    '<input id="join-code" autocomplete="off" spellcheck="false" maxlength="10" placeholder="10-character code" value="' + escapeText(invite) + '">' +
    '<p id="room-error" class="error" role="alert"></p><div class="dlg-actions"><button class="secondary" id="join-room">Join room ' + icon('arrow') +
    '</button></div></form>', 'MULTIPLAYER / PRIVATE ROOM');
  if (el('create-room')) el('create-room').onclick = () => enterRoom('', true);
  el('join-form').onsubmit = event => { event.preventDefault(); void enterRoom(el('join-code').value); };
}
async function enterRoom(rawCode, create = false) {
  const button = create ? el('create-room') : el('join-room');
  if (button?.disabled) return;
  const code = String(rawCode || '').trim().toUpperCase();
  if (!create && !/^[A-HJ-NP-Z2-9]{10}$/.test(code)) {
    el('room-error').textContent = 'Enter the 10-character code from your friend.'; return;
  }
  const controls = [...modal.querySelectorAll('button,input')];
  for (const control of controls) control.disabled = true;
  const cacheKey = create ? 'pending-host' : 'seat-' + code;
  const key = storage.read(cacheKey) || randomToken();
  storage.write(cacheKey, key);
  try {
    const data = await api(create ? '' : '/' + code + '/join', 'POST', key, {});
    storage.write('seat-' + data.code, key);
    if (create) storage.write(cacheKey, null);
    roomEpoch++; stopWorker();
    mode = 'room'; token = key; busy = false; room = null;
    acceptSnapshot(data, true);
    const url = new URL(location.href);
    url.search = ''; url.searchParams.set('room', data.code);
    history.replaceState(null, '', url);
    hide();
    if (create && !data.ready) showInvite();
    else toast('Connected as ' + sideName(side));
  } catch (err) {
    if (el('room-error')) el('room-error').textContent = err.message;
    else toast(err.message);
  } finally { for (const control of controls) control.disabled = false; }
}
function inviteURL() {
  const url = new URL(location.href);
  url.search = ''; url.hash = ''; url.searchParams.set('room', room.code);
  return url.href;
}
async function copyInvite() {
  if (!room) return;
  try {
    await navigator.clipboard.writeText(inviteURL());
    toast('Invite link copied');
    if (el('invite-feedback')) el('invite-feedback').textContent = 'Invite link copied.';
  } catch {
    showInvite();
    el('invite-link').focus(); el('invite-link').select();
    el('invite-feedback').textContent = 'Copy the selected invite link.';
  }
}
function showInvite() {
  show('Your duel room', '<p class="dialog-text">Share this link to invite your opponent. The creator plays White and the guest plays Black. Reopening the link in the same browser restores your seat.</p>' +
    '<label class="form-label" for="invite-link">Invite link</label><input id="invite-link" readonly value="' + escapeText(inviteURL()) + '">' +
    '<p class="form-label">Room code &nbsp; <b>' + escapeText(room.code) + '</b></p>' +
    '<p class="dialog-text" id="invite-feedback" aria-live="polite"></p>' +
    '<div class="dlg-actions"><button id="close-invite" class="secondary">Back to board</button><button id="copy-invite" class="primary">' +
    icon('copy') + ' Copy link</button></div>', 'MULTIPLAYER / INVITE');
  el('copy-invite').onclick = copyInvite;
  el('close-invite').onclick = hide;
}
async function pollRoom() {
  if (mode !== 'room' || !room || pollBusy || busy || outcome) return;
  const epoch = roomEpoch, code = room.code;
  pollBusy = true;
  try {
    const data = await api('/' + code, 'GET', token);
    if (epoch === roomEpoch && mode === 'room') acceptSnapshot(data);
  } catch {
    if (epoch === roomEpoch && mode === 'room') { offline = true; drawStatus(); }
  } finally { pollBusy = false; }
}
async function roomAction(action, extra = {}) {
  if (mode !== 'room' || !room || busy) return;
  busy = true;
  const epoch = roomEpoch, code = room.code;
  drawStatus(); drawDeck();
  try {
    const data = await api('/' + code + '/' + action, 'POST', token, {revision:room.revision, ...extra});
    if (epoch === roomEpoch && mode === 'room') acceptSnapshot(data);
  } catch (err) {
    if (epoch === roomEpoch) toast(err.message);
  } finally {
    if (epoch === roomEpoch) { busy = false; render(); void pollRoom(); }
  }
}
el('friend').onclick = () => friendModal();
el('room-copy').onclick = copyInvite;
el('resign').onclick = () => {
  show('Resign this duel?', '<p class="dialog-text">Your friend will win this match by resignation.</p>' +
    '<div class="dlg-actions"><button class="secondary" id="cancel-resign">Keep playing</button>' +
    '<button class="primary" id="confirm-resign">Resign duel</button></div>', 'ROOM / RESIGN');
  el('cancel-resign').onclick = hide;
  el('confirm-resign').onclick = () => { hide(); void roomAction('resign'); };
};
setInterval(() => { if (!document.hidden) void pollRoom(); }, 1400);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void pollRoom(); });

function restoreSolo() {
  const saved = storage.read('solo');
  if (!saved || !Array.isArray(saved.log) || !['w','b'].includes(saved.side) || !Object.hasOwn(levels, saved.level)) return;
  try {
    legalMoves(saved.game);
    game = saved.game; log = saved.log; side = saved.side;
    level = saved.level; outcome = saved.outcome || null; flipped = side === 'b';
  } catch { /* Ignore an invalid local save and start a fresh duel. */ }
}
async function boot() {
  soundButton(); restoreSolo(); refreshGame();
  const code = new URL(location.href).searchParams.get('room')?.trim().toUpperCase();
  if (code) {
    friendModal(code);
    if (/^[A-HJ-NP-Z2-9]{10}$/.test(code) && storage.read('seat-' + code)) await enterRoom(code);
  }
  runBot();
}
void boot();
