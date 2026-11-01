import {coord} from './engine.js';

const other = side => side === 'w' ? 'b' : 'w';
const seconds = (ms, precise = false) => precise ? (Math.max(0, ms) / 1000).toFixed(1) :
  String(Math.max(0, Math.ceil(ms / 1000)));

// Keep each action button mounted throughout its phase. Network acknowledgments and
// timer ticks update text nodes only, so fast taps and keyboard focus survive polling.
export function createEncounterPanel(panel, {counter, ready, tap}) {
  let currentKey = '';
  let nodes = {};
  function mount(key, html) {
    if (currentKey === key) return;
    currentKey = key;
    panel.innerHTML = html;
    nodes = Object.fromEntries(Array.from(panel.querySelectorAll('[data-field]'),
      node => [node.dataset.field, node]));
    if (nodes.confirm) nodes.confirm.onclick = () => counter(false);
    if (nodes.pass) nodes.pass.onclick = () => counter(true);
    if (nodes.ready) nodes.ready.onclick = ready;
    if (nodes.tap) {
      // Native click is shared by touch, mouse, and assistive technologies. For
      // physical keys count once on keydown and suppress the synthetic click.
      nodes.tap.onclick = tap;
      nodes.tap.onkeydown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (!event.repeat && !nodes.tap.disabled) tap();
      };
      nodes.tap.onkeyup = event => {
        if (event.key === ' ' || event.key === 'Enter') event.preventDefault();
      };
    }
  }
  const heading = '<p class="enc-kicker" data-field="kicker"></p><h2 class="enc-heading" data-field="title"></h2>' +
    '<p class="enc-copy" data-field="help"></p>';
  const clock = '<span class="enc-clock" data-field="clock" role="timer"></span>';
  function write(key, value) {
    if (nodes[key] && nodes[key].textContent !== value) nodes[key].textContent = value;
  }
  return function draw(encounter, side, remainingCounters, square, now, busy, pendingTaps = 0) {
    panel.hidden = !encounter;
    if (!encounter) { currentKey = ''; return; }
    const {id, phase, caster} = encounter;
    if (phase === 'counter') {
      const defending = side !== caster;
      panel.dataset.phase = 'prediction';
      mount(id + '/counter/' + side, heading + clock + (defending ?
        '<p class="enc-target" data-field="selection"></p><div class="enc-actions">' +
        '<button class="primary" data-field="confirm">Lock prediction</button>' +
        '<button class="secondary" data-field="pass">Pass</button></div>' : ''));
      write('kicker', 'COUNTER WINDOW');
      write('title', defending ? 'Predict the landing square' : 'Cast sealed');
      write('help', defending ?
        'A technique is incoming. Pick any board square and lock your guess, or pass to conserve a counter.' :
        'Your opponent can predict one square before the technique is revealed.');
      write('clock', seconds(encounter.deadline - now) + 's');
      if (defending) {
        write('selection', (square == null ? 'No square selected' : 'Prediction: ' + coord(square)) +
          ' · ' + remainingCounters + (remainingCounters === 1 ? ' counter left' : ' counters left'));
        nodes.confirm.disabled = busy || square == null || !remainingCounters || now >= encounter.deadline;
        nodes.pass.disabled = busy || now >= encounter.deadline;
      }
      return;
    }

    const waiting = encounter.startsAt == null;
    const beforeStart = !waiting && now < encounter.startsAt;
    const finished = !waiting && now >= encounter.endsAt;
    const step = waiting ? 'ready' : beforeStart ? 'countdown' : finished ? 'settling' : 'live';
    const attacking = caster === side;
    panel.dataset.phase = 'trial';
    const scores = '<div class="enc-scores"><span>You <strong data-field="own"></strong></span>' +
      '<span>Opponent <strong data-field="enemy"></strong></span></div>';
    mount(id + '/duel/' + step + '/' + side, heading + clock +
      (waiting ? '<div class="enc-actions"><button class="primary" data-field="ready">Ready to duel</button></div>' : '') +
      (!waiting ? scores : '') +
      (step === 'live' ? '<div class="enc-track"><i data-field="meter"></i></div>' +
        '<button class="enc-tap" data-field="tap" type="button">Strike · tap here</button>' : '') +
      '<p class="enc-note">Most taps wins. A tie goes to the defender.</p>');
    write('kicker', 'ROYAL TRIBUNAL / ' + (attacking ? 'ATTACKER' : 'DEFENDER'));
    write('title', waiting ? 'Ready for the tribunal?' : beforeStart ? 'Prepare to strike' :
      finished ? 'Resolving the tribunal' : 'Strike for 10 seconds');
    const stakes = attacking ? 'Win to take the piece on ' + coord(encounter.to) + '. Lose and your queen falls.' :
      'Win to save your piece on ' + coord(encounter.to) + ' and destroy the attacking queen.';
    write('help', waiting ? stakes : beforeStart ? 'The duel begins together for both players.' :
      finished ? 'Waiting for the final score.' : 'Tap the button, or press and release Enter or Space.');
    if (waiting) {
      nodes.ready.disabled = busy || encounter.ready[side];
      write('ready', encounter.ready[side] ? 'Ready · waiting' : 'Ready to duel');
      write('clock', 'Auto-ready in ' + seconds(encounter.readyDeadline - now) + 's');
    } else {
      write('clock', beforeStart ? 'Starts in ' + seconds(encounter.startsAt - now) + 's' :
        seconds(encounter.endsAt - now, true) + 's');
      write('own', String(encounter.scores[side] + pendingTaps));
      write('enemy', String(encounter.scores[other(side)]));
      if (nodes.meter) {
        const pct = Math.max(0, Math.min(100, (encounter.endsAt - now) / (encounter.endsAt - encounter.startsAt) * 100));
        nodes.meter.style.setProperty('--remaining', pct.toFixed(1) + '%');
      }
    }
  };
}
