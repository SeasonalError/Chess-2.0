import {WILDCARDS} from './engine.js';

const sigil = (id, cls) =>
  '<svg class="' + cls + '" aria-hidden="true" viewBox="0 0 64 64"><use href="./art/cards.svg#' + id + '"/></svg>';
const order = ['kamui','noble','trade','freeze','repulse','relay'];

export function wildcardInstruction(id, choosingSecond) {
  switch (id) {
    case 'repulse': return choosingSecond ? 'Choose the adjacent enemy to push.' : 'Choose a highlighted allied piece to push from.';
    case 'trade': return choosingSecond ? 'Choose the second ally to exchange techniques.' : 'Choose the first ally for the private exchange.';
    case 'relay': return choosingSecond ? 'Choose the second ally to swap positions.' : 'Choose the first ally for the relay.';
    case 'kamui': return 'Choose a highlighted piece to send into exile.';
    case 'noble': return 'Choose an ally to receive Noble Protection.';
    case 'freeze': return 'Choose an enemy to freeze for its next turn.';
    default: return 'Choose a highlighted target.';
  }
}

export function createWildcardPanels(draftPanel, cardPanel, {preview, lock, arm}) {
  let lastDraftKey = '', lastCardKey = '';
  draftPanel.onclick = event => {
    const card = event.target.closest('button[data-card]');
    if (card && !card.disabled) preview(card.dataset.card);
    if (event.target.closest('[data-lock]') && !event.target.closest('[data-lock]').disabled) lock();
  };
  cardPanel.onclick = event => {
    const button = event.target.closest('[data-arm-card]');
    if (button && !button.disabled) arm();
  };

  return function paint({draft, side, choice, busy, mine, checked, armed, hasTargets, outcome}) {
    const choosing = draft?.phase === 'picking' && !outcome;
    draftPanel.hidden = !choosing;
    if (choosing) {
      const locked = !!draft.picked[side], selected = locked ? draft.card : choice;
      const nextKey = [side, locked, selected, busy, draft.picked.w, draft.picked.b].join('|');
      if (nextKey !== lastDraftKey) {
        // Keep keyboard focus on the same choice after inspecting another card.
        const focused = draftPanel.contains(document.activeElement) ? document.activeElement.dataset.card : null;
        const tiles = order.map(id => {
          const index = String(order.indexOf(id) + 1).padStart(2, '0');
          return '<button type="button" class="draft-card" data-card="' + id + '" aria-pressed="' + (selected === id) +
            '" aria-label="Inspect ' + WILDCARDS[id].name + '"' + (busy || locked ? ' disabled' : '') + '>' +
            sigil(id, 'draft-sigil') + '<small class="draft-cost">CARD ' + index + '</small><span class="draft-name">' +
            WILDCARDS[id].name + '</span></button>';
        }).join('');
        const detail = selected ? '<span class="draft-name">' + WILDCARDS[selected].name +
          '</span> <span>' + WILDCARDS[selected].description + '</span>' : '<span>Select a card to inspect its effect.</span>';
        draftPanel.innerHTML = '<div class="draft-kicker">PRE-DUEL / SECRET LOADOUT</div>' +
          '<h2 class="draft-title">' + (locked ? 'Wildcard locked' : 'Choose your wildcard') + '</h2>' +
          '<p class="draft-copy">' + (locked ? 'Waiting for your opponent to lock a card.' :
            'Choose one card for the whole duel. Your opponent cannot see your pick. Both players can choose the same card.') + '</p>' +
          (locked ? '' : '<div class="draft-hand" role="group" aria-label="Wildcard choices">' + tiles + '</div>') +
          '<div class="draft-footer"><p class="draft-description" aria-live="polite">' + detail + '</p>' +
          (locked ? '' : '<button class="primary draft-lock" data-lock' + (busy || !selected ? ' disabled' : '') +
            '>' + (busy ? 'Locking…' : 'Lock wildcard') + '</button>') + '</div>';
        if (focused && !locked) draftPanel.querySelector('[data-card="' + focused + '"]')?.focus({preventScroll:true});
        lastDraftKey = nextKey;
      }
    } else { lastDraftKey = ''; }
    cardPanel.hidden = !draft?.card || draft.phase !== 'playing';
    if (cardPanel.hidden) { lastCardKey = ''; return; }
    const id = draft.card, card = WILDCARDS[id];
    const canArm = mine && hasTargets && !draft.used;
    const caption = armed ? 'Cancel wildcard' : draft.used ? 'Wildcard spent' : outcome ? 'Duel complete' :
      checked && mine ? 'Resolve check first' : !mine ? 'Waiting for your turn' : !hasTargets ? 'No legal targets' : 'Arm wildcard';
    const key = [id, caption, canArm, armed].join('|');
    if (key === lastCardKey) return;
    const refocus = cardPanel.contains(document.activeElement) && document.activeElement.hasAttribute('data-arm-card');
    cardPanel.dataset.card = id;
    cardPanel.dataset.state = draft.used ? 'spent' : armed ? 'armed' : 'ready';
    cardPanel.innerHTML = '<div class="wildcard-kicker">YOUR WILDCARD</div>' + sigil(id, 'wildcard-sigil') +
      '<h2 class="wildcard-title">' + card.name + '</h2><p class="wildcard-meta">' + (draft.used ? 'SPENT' : 'ONE USE') +
      ' · FULL TURN</p><p class="wildcard-description">' + card.description + '</p><div class="wildcard-actions">' +
      '<button type="button" data-arm-card class="cast-btn' + (armed ? ' armed' : '') + '" ' + (!canArm ? 'disabled ' : '') +
      'aria-pressed="' + armed + '">' + caption + '</button></div>';
    if (refocus && canArm) cardPanel.querySelector('[data-arm-card]')?.focus({preventScroll:true});
    lastCardKey = key;
  };
}
