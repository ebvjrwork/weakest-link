// Shared render-to-HTML-string components used across host/controller/player
// views — the same "build markup once, patch the odd node directly for
// high-frequency updates" approach the original single-file app used.

import { esc, fmtMoney, accuracyOf } from '../core/dom.js';
import { CHAIN_VALUES } from './state.js';

export function ladderHtml(chainIndex, justClimbed) {
  return '<div class="ladder-h">' + CHAIN_VALUES.map((v, i) => {
    let cls = 'rung-h';
    if (i === chainIndex) cls += ' current';
    else if (i < chainIndex) cls += ' climbed';
    if (i === chainIndex && justClimbed) cls += ' just-climbed';
    return `<div class="${cls}">${fmtMoney(v)}</div>`;
  }).join('') + '</div>';
}

// .js-timer / .js-countdown text is patched directly by a lightweight
// interval in main.js (see startLiveTicker), never via a full re-render —
// the server only sends absolute endsAt/countdownEndsAt timestamps, exactly
// once per real phase change, so the ticking display costs zero network traffic.
export function bigTimerHtml() {
  return '<div class="big-timer js-timer">--:--</div>';
}

export function countdownHtml(sub) {
  return `<div class="countdown-block">
    <div class="countdown-label">Starting in</div>
    <div class="big-countdown js-countdown">5</div>
    ${sub ? `<div class="countdown-sub">${esc(sub)}</div>` : ''}
  </div>`;
}

export function podiumRow(players, spotlightId, dimmed) {
  const cls = 'podium-row' + (dimmed ? ' dimmed' : '');
  return `<div class="${cls}">` + players.map((p) => {
    const spot = p.id === spotlightId;
    const acc = accuracyOf(p);
    return `<div class="podium${spot ? ' spotlight' : ''}" data-player-id="${p.id}">
      ${spot ? '<div class="spotlight-beam"></div>' : ''}
      <div class="podium-name">${esc(p.name)}${p.alive ? '' : ' 💀'}</div>
      <div class="podium-acc">${acc == null ? '—' : acc + '%'}</div>
      <div class="podium-base"></div>
    </div>`;
  }).join('') + '</div>';
}

export function standingsHtml(players) {
  const sorted = [...players].sort((a, b) => (b.correct - b.incorrect) - (a.correct - a.incorrect));
  return '<div class="standings">' + sorted.map((p) => {
    const acc = accuracyOf(p);
    return `<div class="r"><span>${esc(p.name)}</span><span>${acc == null ? 'no answers yet' : acc + '% accuracy'}</span></div>`;
  }).join('') + '</div>';
}

export const allPlayersAccuracyTable = standingsHtml;

export function controllerRoster(players, currentAskedId) {
  return '<div class="roster">' + players.filter((p) => p.alive).map((p) => `
    <div class="chip${p.id === currentAskedId ? ' selected' : ''}" data-action="ctrlSelectAsked" data-arg="${p.id}">
      <span><span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.name)}</span>
      <span class="sub">${p.correct}&#10003; ${p.incorrect}&#10007;</span>
    </div>
  `).join('') + '</div>';
}

export function kickBoxes(players, canKick) {
  return '<div class="roster">' + players.map((p) => `
    <div class="chip">
      <span><span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.name)}</span>
      ${canKick ? `<button class="kick-btn" data-action="ctrlKickPlayer" data-arg="${p.id}">&#10005;</button>` : ''}
    </div>
  `).join('') + '</div>';
}

export function tallyHtml(tally) {
  if (!tally || !tally.length) return '';
  return '<div class="tally">' + tally.map((t) => `<div class="r"><span>${esc(t.name)}</span><span>${t.votes} vote${t.votes === 1 ? '' : 's'}</span></div>`).join('') + '</div>';
}

export function activityLog(entries) {
  if (!entries || !entries.length) return '';
  return '<div class="log">' + entries.map((e) => `<div>${esc(e.msg)}</div>`).join('') + '</div>';
}

// Shared paste/CSV question-bank editor, used by the host room-setup screen
// and the controller's in-lobby bank panel. `idPrefix` keeps element ids
// unique when (in principle) more than one instance could render.
export function questionBankEditorHtml(idPrefix, draftText, preview) {
  return `
    <div class="qbank-editor">
      <textarea id="${idPrefix}CustomQuestions" data-bind="${idPrefix}QuestionsDraft" placeholder="Question | Answer&#10;One per line, or paste a JSON array of [q, a] pairs">${esc(draftText || '')}</textarea>
      <div class="file-row">
        <input type="file" id="${idPrefix}CsvFileInput" accept=".csv,text/csv" data-bind="${idPrefix}Csv">
        <span>or upload a .csv file</span>
      </div>
      ${preview ? `
        <div class="qbank-preview">
          Found <b>${preview.questions.length}</b> question${preview.questions.length === 1 ? '' : 's'} in <b>${esc(preview.fileName)}</b>.
          <div class="btns">
            <button class="act-btn primary" data-action="${idPrefix}UseCsvQuestions">Use these questions</button>
            <button class="act-btn neutral" data-action="${idPrefix}ClearCsvPreview">Cancel</button>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

export function spawnConfetti(container, count) {
  const layer = document.createElement('div');
  layer.className = 'confetti-layer';
  const colors = ['var(--gold)', 'var(--red)', 'var(--green)', 'var(--blue)', '#ffffff'];
  for (let i = 0; i < count; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    piece.style.setProperty('--x', Math.random() * 100 + '%');
    piece.style.setProperty('--size', (6 + Math.random() * 6) + 'px');
    piece.style.setProperty('--c', colors[i % colors.length]);
    piece.style.setProperty('--dur', (2.5 + Math.random() * 2).toFixed(2) + 's');
    piece.style.setProperty('--delay', (Math.random() * 1.2).toFixed(2) + 's');
    if (Math.random() > 0.5) piece.style.borderRadius = '50%';
    layer.appendChild(piece);
  }
  container.appendChild(layer);
  setTimeout(() => layer.remove(), 6000);
}

export function soundToggleHtml(muted) {
  return `<button class="sound-toggle${muted ? '' : ' on'}" data-action="toggleSound" title="${muted ? 'Unmute' : 'Mute'} sound effects">${muted ? '&#128263;' : '&#128266;'}</button>`;
}
