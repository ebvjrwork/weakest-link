// Host ("big screen"/TV) view. The Go server is authoritative for all game
// state now — this module is a pure read-only spectator: it opens a
// WebSocket, renders whatever `hostState` the server pushes, and layers a
// few polish touches (sound cues, one-shot CSS animation flags, confetti) on
// top of state transitions it notices along the way. No game logic lives
// here.

import {
  $, esc, fmtMoney, buildControllerLink, buildHostLink,
} from '../core/dom.js';
import {
  createConnection, apiGet, apiPost, wsURL,
} from '../core/net.js';
import { session } from '../core/storage.js';
import * as sound from '../core/sound.js';
import { parseCSVQuestions, parseCustomQuestions, pairsToObjects } from '../core/questions-parse.js';
import {
  HOST, setRole, setLocalView, render, Actions, Binds, Changes, setupUI,
} from './state.js';
import {
  ladderHtml, bigTimerHtml, countdownHtml, podiumRow, standingsHtml, tallyHtml,
  questionBankEditorHtml, spawnConfetti,
} from './components.js';

// One-shot render flags for CSS animations that should replay exactly once
// right after a state transition (chain climb / bank increase), cleared a
// tick after the render that consumes them.
const hostFX = { justClimbed: false, bankPulse: false };
let confettiSpawned = false;

// --- room-creation screen ----------------------------------------------------------------

export function hostSetupView() {
  const custom = setupUI.bankMode === 'custom';
  const preview = setupUI.csvParsedQuestions
    ? { questions: setupUI.csvParsedQuestions, fileName: setupUI.csvFileName }
    : null;
  return `
    <div class="landing">
      <button class="back-link" data-action="goBack">&larr; Back</button>
      <div class="setup-card">
        <h2>Host a game</h2>
        <label>Round duration</label>
        <select id="roundDuration">
          <option value="45">45 seconds</option>
          <option value="60" selected>60 seconds</option>
          <option value="90">90 seconds</option>
          <option value="120">120 seconds</option>
        </select>
        <label>Question bank</label>
        <div class="radio-row">
          <div class="radio-opt${!custom ? ' active' : ''}" data-action="setBankModeCommunity">Community bank</div>
          <div class="radio-opt${custom ? ' active' : ''}" data-action="setBankModeCustom">My own set for this game</div>
        </div>
        ${custom ? questionBankEditorHtml('setup', setupUI.questionsDraft, preview) : ''}
        ${HOST.error ? `<div class="error-box">${esc(HOST.error)}</div>` : ''}
        <button class="big-btn gold full-btn" data-action="createRoom">Create room</button>
      </div>
    </div>
  `;
}

Actions.createRoom = async () => {
  sound.unlock();
  const durationEl = $('#roundDuration');
  const roundDuration = parseInt((durationEl && durationEl.value) || '60', 10);

  let body;
  if (setupUI.bankMode === 'custom') {
    const pairs = (setupUI.csvParsedQuestions && setupUI.csvParsedQuestions.length)
      ? setupUI.csvParsedQuestions
      : parseCustomQuestions(setupUI.questionsDraft);
    body = (pairs && pairs.length)
      ? { roundDuration, bank: { mode: 'custom', questions: pairsToObjects(pairs) } }
      : { roundDuration, bank: { mode: 'community' } };
  } else {
    body = { roundDuration, bank: { mode: 'community' } };
  }

  try {
    const res = await apiPost('/api/rooms', body);
    connectHost(res.roomCode, res.controllerKey);
  } catch (err) {
    HOST.error = err.message;
    render();
  }
};

Actions.retryHost = () => {
  if (HOST.conn) { try { HOST.conn.close(); } catch (e) { /* ignore */ } }
  HOST.conn = null;
  HOST.state = null;
  HOST.ready = false;
  HOST.error = null;
  HOST.connLost = false;
  session.remove('wlink_host_session');
  try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* ignore */ }
  setRole(null);
  setLocalView('hostSetup');
  render();
};

Binds.setupQuestionsDraft = (val) => { setupUI.questionsDraft = val; };

Changes.setupCsv = (el) => {
  const file = el.files && el.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    setupUI.csvParsedQuestions = parseCSVQuestions(text);
    setupUI.csvFileName = file.name;
    render();
  };
  reader.onerror = () => {
    alert('Could not read that file.');
  };
  reader.readAsText(file);
};

// The parsed CSV preview is already staged in setupUI as soon as the file is
// read; "Use these questions" just needs to keep the preview panel around
// (createRoom reads setupUI.csvParsedQuestions directly), so this is a no-op.
Actions.setupUseCsvQuestions = () => { render(); };

Actions.setupClearCsvPreview = () => {
  setupUI.csvParsedQuestions = null;
  setupUI.csvFileName = null;
  render();
};

Actions.setBankModeCommunity = () => { setupUI.bankMode = 'community'; render(); };
Actions.setBankModeCustom = () => { setupUI.bankMode = 'custom'; render(); };

// --- connection --------------------------------------------------------------------------

// A room lives on the server independently of any one browser tab — if the
// host's display tab/window is closed or crashes, this is what lets them get
// back to the SAME room instead of only ever being able to create a new one.
// No secret is needed to view the host screen itself (it's read-only, same
// info a player already sees) — but `controllerKey` is only ever available
// when it's actually known (fresh creation, or a same-tab session that saved
// it): the ?host=CODE cross-device recovery link deliberately carries no
// secret, so a host screen reached that way has no controller key to show,
// and hostLobbyView/topBarSimple must hide the controller link rather than
// build one with a missing key.
export async function connectHost(code, controllerKey) {
  setRole('host');
  HOST.roomCode = code;
  HOST.controllerKey = controllerKey || '';
  HOST.state = null;
  HOST.error = null;
  HOST.ready = false;
  HOST.connLost = false;
  render();

  // A stale recovery link/session (room already ended, or the server
  // restarted) would otherwise retry the WebSocket forever with no clear
  // signal why — a quick REST pre-flight gives an immediate, honest answer.
  try {
    const summary = await apiGet(`/api/rooms/${code}`);
    if (!summary.exists) {
      HOST.error = 'This room no longer exists — it may have ended, or the server restarted.';
      session.remove('wlink_host_session');
      render();
      return;
    }
  } catch (e) {
    // Pre-flight itself failed (network hiccup) — fall through and let the
    // WebSocket attempt speak for itself rather than blocking recovery on it.
  }

  // Only persisted for a same-tab refresh / "reopen closed tab" — never put
  // in the URL, so the controller key can't leak just by sharing this link.
  session.set('wlink_host_session', { roomCode: code, controllerKey: HOST.controllerKey });
  try { window.history.replaceState(null, '', buildHostLink(code)); } catch (e) { /* ignore */ }

  const conn = createConnection(wsURL({ role: 'host', code }));
  HOST.conn = conn;

  conn.on('open', () => {
    HOST.connLost = false;
    render();
  });

  conn.on('data', (msg) => {
    if (!msg) return;
    if (msg.type === 'roomClosed') {
      HOST.error = 'This room has been closed.';
      session.remove('wlink_host_session');
      conn.close(); // definitive — stop net.js's auto-reconnect against a room that's now gone
      render();
      return;
    }
    if (msg.type !== 'hostState') return;
    const prev = HOST.state;
    const next = msg.state;
    HOST.state = next;
    HOST.ready = true;

    let enteredGameOver = false;
    if (prev) {
      if (prev.chainIndex < next.chainIndex) {
        sound.correct();
        hostFX.justClimbed = true;
      }
      if (next.chainIndex === -1 && prev.chainIndex >= 0 && prev.phase === 'playing' && next.phase === 'playing') {
        sound.wrong();
      }
      if (next.bank > prev.bank) {
        sound.bank();
        hostFX.bankPulse = true;
      }
      if (next.phase === 'elimination' && prev.phase !== 'elimination') {
        sound.eliminate();
      }
      if (next.phase === 'gameover' && prev.phase !== 'gameover') {
        sound.win();
        enteredGameOver = true;
      }
      if (prev.phase === 'gameover' && next.phase !== 'gameover') {
        confettiSpawned = false;
      }
    }

    render();

    if (hostFX.justClimbed || hostFX.bankPulse) {
      setTimeout(() => {
        hostFX.justClimbed = false;
        hostFX.bankPulse = false;
      }, 50);
    }

    if (enteredGameOver && !confettiSpawned) {
      confettiSpawned = true;
      spawnConfetti(document.body, 100);
    }
  });

  conn.on('close', (info) => {
    if (!HOST.state && info && info.reason) {
      HOST.error = info.reason;
    } else {
      HOST.connLost = true;
    }
    render();
  });

  conn.on('error', () => {
    HOST.connLost = true;
    render();
  });
}

// --- root dispatch -------------------------------------------------------------------------

export function hostRootView() {
  if (HOST.error) {
    return `
      <div class="landing">
        <div class="error-box">${esc(HOST.error)}</div>
        <button class="big-btn gold" data-action="retryHost">Try again</button>
      </div>
    `;
  }
  if (!HOST.ready) {
    return '<div class="landing"><p class="tag">Setting up your room&hellip;</p></div>';
  }

  const s = HOST.state;
  let body;
  switch (s.phase) {
    case 'lobby': body = hostLobbyView(); break;
    case 'countdown': body = hostCountdownView(); break;
    case 'playing': body = hostPlayingView(); break;
    case 'voting': body = hostVotingView(); break;
    case 'elimination': body = hostEliminationView(); break;
    case 'shootout': body = hostShootoutView(); break;
    case 'gameover': body = hostGameOverView(); break;
    default: body = '<div class="center-msg">&hellip;</div>';
  }

  const banner = HOST.connLost ? '<div class="banner">Connection lost &mdash; reconnecting&hellip;</div>' : '';
  return `<div class="host-wrap">${banner}${body}</div>`;
}

// --- shared bits -----------------------------------------------------------------------------

function topBarSimple() {
  const s = HOST.state;
  return `
    <div class="top-bar">
      <div class="room-pill">${esc(s.roomCode)}</div>
      <div class="stat-strip">
        <div class="stat-chip gold"><b>${fmtMoney(s.bank)}</b>Bank</div>
        ${s.phase === 'playing' ? `<div class="stat-chip"><b>${esc(s.round)}</b>Round</div>` : ''}
        ${HOST.controllerKey ? `<a class="stat-chip" href="${buildControllerLink(s.roomCode, HOST.controllerKey)}" target="_blank" rel="noopener">Open controller &#8599;</a>` : ''}
      </div>
    </div>
  `;
}

// A visible, selectable copy of this screen's own recovery URL — shown so
// closing/crashing this tab is recoverable even on a kiosk/TV browser where
// the address bar (which already reflects this same URL) may not be visible
// at all. Deliberately plain text, not just a link, so it can be read off,
// photographed, or copied by hand.
function hostRecoveryNote(code) {
  return `
    <div class="host-recovery-note">
      If this screen closes, reopen it at:<br>
      <span class="host-recovery-url">${esc(buildHostLink(code))}</span>
    </div>
  `;
}

// --- phase views -----------------------------------------------------------------------------

function hostLobbyView() {
  const s = HOST.state;
  const count = s.players.length;
  const body = count
    ? podiumRow(s.players)
    : '<div class="center-msg">Waiting for players to join&hellip;</div>';
  return `
    <div class="top-bar">
      <div class="stat-strip">
        <div class="stat-chip"><b>${count}</b>${count === 1 ? 'Player' : 'Players'}</div>
      </div>
    </div>
    <div class="room-code-display">${esc(s.roomCode)}</div>
    <div style="text-align:center;margin:4px 0 18px;">
      ${HOST.controllerKey ? `
        <a class="big-btn gold" href="${buildControllerLink(s.roomCode, HOST.controllerKey)}" target="_blank" rel="noopener">Open quizmaster controller &#8599;</a>
      ` : `
        <div class="error-box" style="max-width:420px;margin:0 auto;">
          This screen was reopened via its recovery link, which doesn't carry the quizmaster key for security reasons.
          Use the original "Open quizmaster controller" link/tab from when this room was created, or the controller's
          own reconnect form with your saved room code and key.
        </div>
      `}
    </div>
    ${body}
    ${HOST.controllerKey ? `<div class="footer-note">The link above opens the quizmaster's controller in a new tab &mdash; keep it open on your phone or another device to run the game.</div>` : ''}
    ${hostRecoveryNote(s.roomCode)}
  `;
}

function hostCountdownView() {
  const s = HOST.state;
  if (s.shootout) {
    const [p0, p1] = s.shootout.order;
    return `
      ${topBarSimple()}
      <div class="duel">
        <div class="duel-side active"><div class="nm">${esc(p0.name)}</div></div>
        <div class="duel-side"><div class="nm">${esc(p1.name)}</div></div>
      </div>
      <div class="phase-heading">Final shootout starting&hellip;</div>
      ${countdownHtml(null)}
    `;
  }
  const alive = s.players.filter((p) => p.alive);
  const asked = alive.find((p) => p.id === s.currentAskedId);
  return `
    ${topBarSimple()}
    ${podiumRow(alive, s.currentAskedId)}
    <div class="phase-heading">Round ${esc(s.round)} starting&hellip;</div>
    ${countdownHtml(asked ? `First up: ${asked.name}` : null)}
  `;
}

function hostPlayingView() {
  const s = HOST.state;
  const alive = s.players.filter((p) => p.alive);
  const asked = s.players.find((p) => p.id === s.currentAskedId);
  const askedName = asked ? asked.name : '';
  const stageBody = s.currentQuestion
    ? `<div class="q-label">Reading to ${esc(askedName)}</div><div class="q-text">${esc(s.currentQuestion.q)}</div>`
    : `<div class="q-text" style="color:var(--blue)">On the spot: ${esc(askedName)}</div>`;
  return `
    ${topBarSimple()}
    ${bigTimerHtml()}
    ${podiumRow(alive, s.currentAskedId)}
    <div class="stage">${stageBody}</div>
    ${ladderHtml(s.chainIndex, hostFX.justClimbed)}
    <div class="bank-total${hostFX.bankPulse ? ' pulse' : ''}">
      <div class="amt">${fmtMoney(s.bank)}</div>
      <div class="lbl">Team bank</div>
    </div>
  `;
}

function hostVotingView() {
  const s = HOST.state;
  const alive = s.players.filter((p) => p.alive);
  if (s.revealing && s.revealInfo) {
    const info = s.revealInfo;
    const voter = alive.find((p) => p.name === info.voterName);
    return `
      ${topBarSimple()}
      ${podiumRow(alive, voter ? voter.id : null, true)}
      <div class="elim-card">
        <div class="phase-heading">${esc(info.voterName)} voted for</div>
        <div class="name">${esc(info.votedForName || 'No one')}</div>
      </div>
    `;
  }
  // The host never receives tieCandidates or a live vote count — a manual
  // tie-break happening controller-side just shows up as the phase staying
  // 'voting' a bit longer with no reveal cycle running yet, which is a fine
  // simplification for a read-only spectator display.
  return `
    ${topBarSimple()}
    ${podiumRow(alive)}
    <div class="phase-heading">Voting&hellip;</div>
  `;
}

function hostEliminationView() {
  const s = HOST.state;
  const alive = s.players.filter((p) => p.alive);
  const elim = s.lastElimination;
  return `
    ${topBarSimple()}
    ${podiumRow(alive)}
    <div class="elim-card">
      <div class="phase-heading">Eliminated</div>
      <div class="name">${elim ? esc(elim.name) : ''}</div>
      ${elim && elim.note ? `<div class="elim-note">${esc(elim.note)}</div>` : ''}
      ${elim ? tallyHtml(elim.tally) : ''}
    </div>
  `;
}

const SHOOTOUT_REGULATION_ROUNDS = 5;

function shootoutKicks(shootout, sideIndex) {
  const rounds = shootout.rounds || [];
  // Regulation is always 5 slots; sudden death keeps appending beyond that —
  // showing every round played (instead of a hardcoded 5) is what makes
  // sudden-death progress visible instead of looking frozen.
  const slotCount = Math.max(SHOOTOUT_REGULATION_ROUNDS, rounds.length);
  let out = '';
  for (let i = 0; i < slotCount; i++) {
    const r = rounds[i];
    const val = r ? (sideIndex === 0 ? r.p0 : r.p1) : null;
    let cls = 'kick';
    let mark = '';
    if (val === 'correct') { cls += ' hit'; mark = '&#10003;'; }
    else if (val === 'incorrect') { cls += ' miss'; mark = '&#10007;'; }
    out += `<div class="${cls}">${mark}</div>`;
  }
  return out;
}

function hostShootoutView() {
  const s = HOST.state;
  const so = s.shootout;
  if (!so) return topBarSimple();
  // currentTurn is an index (0/1) into shootout.order — NOT related to the
  // regular game's currentAskedId, which is stale/irrelevant once the
  // shootout starts.
  const turnPlayer = so.order[so.currentTurn];
  const askedName = turnPlayer ? turnPlayer.name : '';
  const suddenRound = so.currentRoundIndex - SHOOTOUT_REGULATION_ROUNDS + 1;
  const prefix = so.sudden ? `Sudden death (round ${suddenRound}) &mdash; ` : '';
  const stageBody = so.currentQuestion
    ? `<div class="q-label">${prefix}Reading to ${esc(askedName)}</div><div class="q-text">${esc(so.currentQuestion.q)}</div>`
    : `<div class="q-text" style="color:var(--blue)">${prefix}Up next: ${esc(askedName)}</div>`;
  return `
    ${topBarSimple()}
    <div class="duel${so.sudden ? ' sudden' : ''}">
      ${so.order.map((p, idx) => `
        <div class="duel-side${(so.currentTurn === idx || so.currentTurn === p.id) ? ' active' : ''}">
          <div class="nm">${esc(p.name)}</div>
          <div class="kicks">${shootoutKicks(so, idx)}</div>
        </div>
      `).join('')}
    </div>
    <div class="stage">${stageBody}</div>
  `;
}

function hostGameOverView() {
  const s = HOST.state;
  return `
    <div class="gameover">
      <div class="trophy">&#127942;</div>
      <div class="winner">${esc(s.winner || '')} wins!</div>
      <div class="bank-total">
        <div class="amt">${fmtMoney(s.bank)}</div>
        <div class="lbl">Final team bank</div>
      </div>
      ${standingsHtml(s.players)}
    </div>
  `;
}
