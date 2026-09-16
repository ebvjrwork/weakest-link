// Quizmaster remote-control module — the ONLY role that can mutate the game.
// It attaches straight to `GET /ws?role=controller&code=ABCD` (no signup, no
// handshake message — identity lives entirely in the URL) and the server
// pushes a fresh `{type:'controllerState', state:{...}}` after every action.
// Every command we send is the same envelope: `{type:'control', action, arg}`.
//
// The controller is the only device that ever sees `currentQuestion.a` — the
// big screen and players never get the answer text from the server.

import { $, esc, fmtMoney, buildInviteLink } from '../core/dom.js';
import { createConnection, wsURL } from '../core/net.js';
import * as sound from '../core/sound.js';
import { parseCSVQuestions, parseCustomQuestions, pairsToObjects } from '../core/questions-parse.js';
import {
  role, setRole, setLocalView, CTRL, ctrlUI, render, Actions, Binds, Changes,
} from './state.js';
import {
  ladderHtml, bigTimerHtml, controllerRoster, tallyHtml, activityLog, questionBankEditorHtml, standingsHtml,
} from './components.js';

// --- networking --------------------------------------------------------

function sendControl(action, arg) {
  if (CTRL.conn && CTRL.conn.isOpen) CTRL.conn.send({ type: 'control', action, arg });
}

export function connectController(code, key) {
  setRole('controller');
  CTRL.roomCode = code;
  CTRL.controllerKey = key || '';
  CTRL.error = null;
  const conn = createConnection(wsURL({ role: 'controller', code, key: CTRL.controllerKey }));
  CTRL.conn = conn;
  conn.on('open', () => { CTRL.connLost = false; render(); });
  conn.on('data', (msg) => {
    if (msg.type === 'controllerState') { CTRL.state = msg.state; CTRL.connLost = false; }
    else if (msg.type === 'roomClosed') {
      CTRL.error = 'The host closed this room.';
      conn.close(); // definitive — stop net.js's auto-reconnect against a room that's now gone
    }
    render();
  });
  conn.on('close', (info) => {
    // A close that arrives before any 'data' ever came in, carrying a reason,
    // means the server rejected the attach outright (e.g. room not found) —
    // net.js won't keep retrying a room that doesn't exist, so surface it.
    if (!CTRL.state && info && info.reason) { CTRL.error = info.reason; }
    else { CTRL.connLost = true; }
    render();
  });
  conn.on('error', () => { CTRL.connLost = true; render(); });
  render();
}

// --- actions: connection lifecycle --------------------------------------

Actions.ctrlJoin = () => {
  const code = (($('#ctrlRoomCodeInput') || {}).value || '').trim().toUpperCase();
  const key = (($('#ctrlKeyInput') || {}).value || '').trim();
  if (!code || !key) { alert('Enter both the room code and the quizmaster key from your host screen.'); return; }
  sound.unlock(); // user gesture — good spot to warm up the audio context
  connectController(code, key);
};

Actions.ctrlRetry = () => {
  setLocalView('controllerSetup');
  setRole(null);
  CTRL.conn = null;
  // Deliberately keep CTRL.roomCode/controllerKey so the setup form can
  // prefill them — this path is reached after a dropped/failed connection,
  // and re-typing a long key from scratch would be a needless hassle.
  CTRL.state = null;
  CTRL.error = null;
  CTRL.connLost = false;
  render();
};

// --- actions: thin sendControl wrappers ---------------------------------

Actions.ctrlStartGame = () => sendControl('startGame');
Actions.ctrlSelectAsked = (id) => sendControl('selectAsked', id);
Actions.ctrlNextQuestion = () => sendControl('nextQuestion');
Actions.ctrlMarkCorrect = () => sendControl('markCorrect');
Actions.ctrlMarkIncorrect = () => sendControl('markIncorrect');
Actions.ctrlBankChain = () => sendControl('bankChain');
Actions.ctrlEndRound = () => sendControl('endRound');
Actions.ctrlStartVoteReveal = () => sendControl('startVoteReveal');
Actions.ctrlAdvanceReveal = () => sendControl('advanceReveal');
Actions.ctrlManualTieBreak = (id) => sendControl('manualTieBreak', id);
Actions.ctrlContinueAfterElimination = () => sendControl('continueAfterElimination');
Actions.ctrlShootoutNextQuestion = () => sendControl('shootoutNextQuestion');
Actions.ctrlShootoutMark = (result) => sendControl('shootoutMark', result);
Actions.ctrlPlayAgain = () => sendControl('playAgain');
Actions.ctrlKickPlayer = (id) => sendControl('kickPlayer', id);
Actions.ctrlCloseRoom = () => {
  if (!confirm("Close this room and remove everyone? This can't be undone.")) return;
  sendControl('closeRoom');
};

Actions.ctrlAddPlayer = () => {
  const input = $('#addPlayerInput');
  const name = input ? input.value.trim() : '';
  if (!name) return;
  sendControl('addPlayer', name);
};

Actions.ctrlCopyInviteLink = () => {
  if (!CTRL.state || !CTRL.state.roomCode) return;
  const url = buildInviteLink(CTRL.state.roomCode);
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      ctrlUI.linkCopied = true;
      render();
      setTimeout(() => { ctrlUI.linkCopied = false; render(); }, 2000);
    }).catch(() => {
      if (typeof prompt !== 'undefined') prompt('Copy this invite link:', url);
    });
  } else if (typeof prompt !== 'undefined') {
    prompt('Copy this invite link:', url);
  }
};

// --- actions: question bank editor ---------------------------------------

Actions.ctrlSaveCustomQuestions = () => {
  const parsed = parseCustomQuestions(ctrlUI.questionsDraft);
  if (parsed.length === 0) {
    alert('Could not find any valid questions.\n\nUse one per line, in the format:\nQuestion text | Answer text');
    return;
  }
  sendControl('setQuestionBank', { questions: pairsToObjects(parsed) });
};

Actions.ctrlResetQuestions = () => sendControl('resetQuestionBank');

Actions.ctrlUseCsvQuestions = () => {
  if (!ctrlUI.csvParsedQuestions || !ctrlUI.csvParsedQuestions.length) {
    alert('No valid rows found in that file.');
    return;
  }
  sendControl('setQuestionBank', { questions: pairsToObjects(ctrlUI.csvParsedQuestions) });
  ctrlUI.csvParsedQuestions = null;
  ctrlUI.csvFileName = null;
  render();
};

Actions.ctrlClearCsvPreview = () => {
  ctrlUI.csvParsedQuestions = null;
  ctrlUI.csvFileName = null;
  render();
};

// Textarea draft just mirrors into ctrlUI — no render() here, so an in-progress
// keystroke never gets clobbered by a full innerHTML replace.
Binds.ctrlQuestionsDraft = (value) => { ctrlUI.questionsDraft = value; };

Changes.ctrlCsv = (el) => {
  const file = el.files && el.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    ctrlUI.csvParsedQuestions = parseCSVQuestions(ev.target.result);
    ctrlUI.csvFileName = file.name;
    render();
  };
  reader.onerror = () => {
    ctrlUI.csvParsedQuestions = null;
    ctrlUI.csvFileName = null;
    alert("Could not read that file. Make sure it's a plain .csv file.");
    render();
  };
  reader.readAsText(file);
};

// --- keyboard shortcuts: C = correct, I = incorrect ----------------------
// Marking lives on the controller now (that's where the quizmaster is), so
// the shortcut only ever fires here.

function flashButton(selector) {
  const el = document.querySelector(selector);
  if (!el) return;
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 300);
}

Actions.__keydown = (e) => {
  if (role !== 'controller' || !CTRL.state) return;
  if (e.repeat) return; // ignore OS key-repeat while held, avoid double-marking
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  const key = e.key ? e.key.toLowerCase() : '';
  if (key !== 'c' && key !== 'i') return;
  const s = CTRL.state;
  if (s.phase === 'playing' && s.currentQuestion) {
    e.preventDefault();
    if (key === 'c') { Actions.ctrlMarkCorrect(); flashButton('[data-action="ctrlMarkCorrect"]'); }
    else { Actions.ctrlMarkIncorrect(); flashButton('[data-action="ctrlMarkIncorrect"]'); }
  } else if (s.phase === 'shootout' && s.shootout && s.shootout.currentQuestion) {
    e.preventDefault();
    const result = key === 'c' ? 'correct' : 'incorrect';
    Actions.ctrlShootoutMark(result);
    flashButton(`[data-action="ctrlShootoutMark"][data-arg="${result}"]`);
  }
};

// --- local helpers -------------------------------------------------------

const SHOOTOUT_REGULATION_ROUNDS = 5;

// The shootout's hit/miss row. Deliberately NOT named `kickBoxes` —
// components.js already exports a `kickBoxes` for an unrelated purpose (a
// kickable player list), so this stays local to avoid confusion.
// Regulation is always 5 slots; sudden death keeps appending beyond that —
// showing every round played (instead of a hardcoded 5) is what makes
// sudden-death progress visible instead of looking frozen.
function shootoutKicksRow(rounds, side) {
  const slotCount = Math.max(SHOOTOUT_REGULATION_ROUNDS, (rounds || []).length);
  let out = '';
  for (let i = 0; i < slotCount; i++) {
    const r = rounds && rounds[i];
    const v = r ? r['p' + side] : null;
    if (v === 'correct') out += '<div class="kick hit">✓</div>';
    else if (v === 'incorrect') out += '<div class="kick miss">✗</div>';
    else out += '<div class="kick"></div>';
  }
  return `<div class="kicks">${out}</div>`;
}

// --- setup / root views ----------------------------------------------------

export function controllerSetupView() {
  return `
    <div class="landing">
      <div class="setup-card">
        <button class="back-link" data-action="goBack">&larr; Back</button>
        <h2 style="margin:0;">Quizmaster remote</h2>
        <p style="color:var(--muted);font-size:13px;margin:10px 0 0;">Normally you'd get here via the "Open quizmaster controller" link on the host screen. Use this form only to reconnect manually.</p>
        <label for="ctrlRoomCodeInput">Room code</label>
        <input id="ctrlRoomCodeInput" maxlength="4" placeholder="e.g. QWXK" autocomplete="off" value="${esc(CTRL.roomCode || '')}" style="text-transform:uppercase;letter-spacing:3px;">
        <label for="ctrlKeyInput">Quizmaster key</label>
        <input id="ctrlKeyInput" placeholder="from the host screen's controller link" autocomplete="off" value="${esc(CTRL.controllerKey || '')}">
        <button class="big-btn gold full-btn" data-action="ctrlJoin">Open controller</button>
      </div>
    </div>
  `;
}

export function controllerRootView() {
  if (CTRL.error) {
    return `<div class="landing"><div class="error-box">${esc(CTRL.error)}</div><button class="big-btn gold" data-action="ctrlRetry">Try again</button></div>`;
  }
  if (!CTRL.state) {
    return `
      <div class="landing">
        <p class="tag">Connecting to the main screen…</p>
        ${CTRL.connLost ? '<div class="error-box" style="max-width:400px;margin:20px auto 0;">Reconnecting…</div>' : ''}
      </div>
    `;
  }
  const s = CTRL.state;
  let inner;
  if (s.phase === 'lobby') inner = controllerLobbyView(s);
  else if (s.phase === 'countdown') inner = controllerCountdownView(s);
  else if (s.phase === 'playing') inner = controllerPlayingView(s);
  else if (s.phase === 'voting') inner = controllerVotingView(s);
  else if (s.phase === 'elimination') inner = controllerEliminationView(s);
  else if (s.phase === 'shootout') inner = controllerShootoutView(s);
  else if (s.phase === 'gameover') inner = controllerGameOverView(s);
  else inner = '<div class="center-msg">Unknown phase.</div>';
  return ctrlShell(inner);
}

function ctrlShell(inner) {
  return `
    <div class="ctrl-wrap">
      <div style="text-align:right;margin-bottom:6px;">
        <button class="back-link" style="padding:0;font-size:12px;color:var(--muted);" data-action="ctrlCloseRoom">Close room &#10005;</button>
      </div>
      ${inner}
    </div>
  `;
}

function ctrlTopBar(s) {
  return `<div class="top-bar"><div class="room-pill">ROOM ${esc(s.roomCode)}</div><div class="stat-strip"><span class="stat-chip gold"><b>${fmtMoney(s.bank)}</b>Bank</span></div></div>`;
}

// --- question bank panel (shared shape between lobby and, eventually, mid-game tweaks) ---

function controllerQuestionBankPanel(s) {
  const statusLine = s.usingCustom
    ? `<span style="color:var(--gold);">Using ${s.questionBankCount} custom question${s.questionBankCount === 1 ? '' : 's'}</span>`
    : `<span style="color:var(--muted);">Using the ${s.questionBankCount} built-in questions</span>`;
  const preview = ctrlUI.csvParsedQuestions ? { questions: ctrlUI.csvParsedQuestions, fileName: ctrlUI.csvFileName } : null;
  return `
    <div class="panel" style="text-align:left;">
      <h3>Question bank</h3>
      <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">${statusLine}</p>
      <p style="font-size:12px;color:var(--muted);margin:14px 0 6px;">Paste your own, one per line: <code style="color:var(--text);">Question text | Answer text</code></p>
      ${questionBankEditorHtml('ctrl', ctrlUI.questionsDraft, preview)}
      <div class="action-row" style="justify-content:flex-start;margin-top:10px;">
        <button class="act-btn primary" data-action="ctrlSaveCustomQuestions">Use these questions</button>
        ${s.usingCustom ? '<button class="act-btn neutral" data-action="ctrlResetQuestions">Reset to built-in</button>' : ''}
      </div>
    </div>
  `;
}

// --- phase views -----------------------------------------------------------

function controllerLobbyView(s) {
  const rows = s.players.map((p) => `
    <div class="chip"><span><span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.name)}</span>
      <button class="kick-btn" data-action="ctrlKickPlayer" data-arg="${p.id}" title="Remove player">&#10005;</button></div>
  `).join('');
  return `
    <div class="top-bar"><div class="room-pill">ROOM ${esc(s.roomCode)}</div><div class="stat-strip"><span class="stat-chip"><b>${s.players.length}</b>Joined</span></div></div>
    <div class="panel">
      <h3>Invite players</h3>
      <p style="font-size:13px;color:var(--muted);margin:0 0 10px;">Share this link — it opens straight to the join form with the code already filled in.</p>
      <button class="act-btn primary full-btn" data-action="ctrlCopyInviteLink">${ctrlUI.linkCopied ? 'Link copied &#10003;' : 'Copy invite link'}</button>
    </div>
    <div class="panel">
      <h3>Players</h3>
      <div class="roster">${rows || '<p class="center-msg" style="padding:10px;">Waiting for players…</p>'}</div>
      <div class="action-row" style="justify-content:flex-start;margin-top:10px;">
        <input id="addPlayerInput" placeholder="Add a player without a device" style="flex:1;min-width:160px;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--text);">
        <button class="act-btn neutral" data-action="ctrlAddPlayer">Add</button>
      </div>
    </div>
    ${controllerQuestionBankPanel(s)}
    <button class="big-btn gold full-btn" data-action="ctrlStartGame" ${s.players.length < 3 ? 'disabled' : ''}>Start game (${s.players.length} joined${s.players.length < 3 ? ', need 3+' : ''})</button>
  `;
}

function controllerCountdownView(s) {
  const label = s.shootout ? 'Final shootout starting…' : `Round ${s.round} starting…`;
  return `
    ${ctrlTopBar(s)}
    <div class="panel countdown-block">
      <div class="countdown-label">${esc(label)}</div>
      <div class="js-countdown big-countdown">5</div>
      ${s.askedName && !s.shootout ? `<div class="countdown-sub">First up: ${esc(s.askedName)}</div>` : ''}
    </div>
  `;
}

function controllerPlayingView(s) {
  let stageInner;
  if (s.currentQuestion) {
    stageInner = `
      <div class="ctrl-asked">${esc(s.askedName || '')}</div>
      <div class="q-text">${esc(s.currentQuestion.q)}</div>
      <div class="a-text">${esc(s.currentQuestion.a)}</div>
      <div class="action-row">
        <button class="act-btn correct" data-action="ctrlMarkCorrect">Correct <span class="kbd">C</span></button>
        <button class="act-btn incorrect" data-action="ctrlMarkIncorrect">Incorrect <span class="kbd">I</span></button>
      </div>
      <div class="action-row" style="margin-top:8px;"><button class="act-btn neutral" data-action="ctrlNextQuestion">Skip — new question</button></div>
    `;
  } else {
    stageInner = `
      <div class="ctrl-asked" style="color:var(--blue);">${esc(s.askedName || '—')}</div>
      <div class="action-row"><button class="act-btn primary" data-action="ctrlNextQuestion">Ask next question</button></div>
    `;
  }
  return `
    <div class="top-bar"><div class="room-pill">ROOM ${esc(s.roomCode)}</div><div class="stat-strip"><span class="stat-chip"><b>${s.round}</b>Round</span></div></div>
    ${bigTimerHtml()}
    <div class="panel ctrl-question-panel">${stageInner}</div>
    <div class="panel">
      <h3>Chain</h3>
      ${ladderHtml(s.chainIndex)}
      <div class="bank-total"><div class="amt">${fmtMoney(s.bank)}</div><div class="lbl">Team bank</div></div>
      <button class="act-btn bank full-btn" data-action="ctrlBankChain" ${s.chainIndex < 0 ? 'disabled' : ''}>Bank ${s.chainIndex >= 0 ? fmtMoney(s.chainValue) : ''} (players can also bank instantly themselves)</button>
    </div>
    <div class="panel"><h3>Players — tap to choose who's asked</h3>${controllerRoster(s.players, s.currentAskedId)}</div>
    ${s.log && s.log.length ? `<div class="panel"><h3>Activity</h3>${activityLog(s.log)}</div>` : ''}
    <button class="act-btn neutral full-btn" data-action="ctrlEndRound">End round now</button>
  `;
}

function controllerVotingView(s) {
  const alive = s.players.filter((p) => p.alive);
  if (s.tieCandidates) {
    const cands = s.players.filter((p) => s.tieCandidates.indexOf(p.id) >= 0);
    return `
      ${ctrlTopBar(s)}
      <div class="panel" style="text-align:center;">
        <h2>It's a tie</h2>
        <p class="tag">Performance stats didn't break it either. Pick who goes home:</p>
        <div class="action-row">${cands.map((p) => `<button class="act-btn incorrect" data-action="ctrlManualTieBreak" data-arg="${p.id}">${esc(p.name)}</button>`).join('')}</div>
      </div>
    `;
  }
  if (s.revealing && s.revealInfo) {
    const isLast = s.revealInfo.index === s.revealOrder.length - 1;
    return `
      ${ctrlTopBar(s)}
      <div class="panel" style="text-align:center;">
        <p class="tag">Revealing vote ${s.revealInfo.index + 1} of ${s.revealInfo.total}</p>
        <div class="q-label">${esc(s.revealInfo.voterName)} voted for</div>
        <div class="name" style="color:var(--gold);font-family:'Oswald',sans-serif;font-size:26px;">${s.revealInfo.votedForName ? esc(s.revealInfo.votedForName) : 'No one'}</div>
        <button class="big-btn gold" style="margin-top:16px;" data-action="ctrlAdvanceReveal">${isLast ? 'Show result' : 'Reveal next vote'}</button>
      </div>
    `;
  }
  return `
    ${ctrlTopBar(s)}
    <div class="panel" style="text-align:center;">
      <h3>Voting</h3>
      <p class="tag">${s.votedCount} of ${alive.length} voted</p>
      <button class="big-btn gold" data-action="ctrlStartVoteReveal">Reveal votes</button>
    </div>
  `;
}

function controllerEliminationView(s) {
  const e = s.lastElimination;
  const aliveCount = s.players.filter((p) => p.alive).length;
  return `
    ${ctrlTopBar(s)}
    <div class="elim-card">
      <div class="q-label">Voted off</div>
      <div class="name">${esc(e.name)}</div>
      ${e.note ? `<p class="tag">${esc(e.note)}</p>` : ''}
      ${tallyHtml(e.tally)}
      <button class="big-btn gold" data-action="ctrlContinueAfterElimination">${aliveCount === 2 ? 'Continue to final shootout' : 'Continue to next round'}</button>
    </div>
  `;
}

function controllerShootoutView(s) {
  const sh = s.shootout;
  const p0 = sh.order[0];
  const p1 = sh.order[1];
  const turnName = sh.order[sh.currentTurn].name;
  const suddenRound = sh.currentRoundIndex - SHOOTOUT_REGULATION_ROUNDS + 1;
  const suddenLabel = sh.sudden ? `Sudden death (round ${suddenRound}) — ` : '';
  let stageInner;
  if (sh.currentQuestion) {
    stageInner = `
      <div class="ctrl-asked">${suddenLabel}${esc(turnName)}</div>
      <div class="q-text">${esc(sh.currentQuestion.q)}</div>
      <div class="a-text">${esc(sh.currentQuestion.a)}</div>
      <div class="action-row">
        <button class="act-btn correct" data-action="ctrlShootoutMark" data-arg="correct">Correct <span class="kbd">C</span></button>
        <button class="act-btn incorrect" data-action="ctrlShootoutMark" data-arg="incorrect">Incorrect <span class="kbd">I</span></button>
      </div>
    `;
  } else {
    stageInner = `
      <div class="ctrl-asked" style="color:var(--blue);">${sh.sudden ? `Sudden death (round ${suddenRound})` : 'Up next'}: ${esc(turnName)}</div>
      <div class="action-row"><button class="act-btn primary" data-action="ctrlShootoutNextQuestion">Ask next question</button></div>
    `;
  }
  return `
    ${ctrlTopBar(s)}
    <div class="duel">
      <div class="duel-side${sh.currentTurn === 0 ? ' active' : ''}"><div class="nm">${esc(p0.name)}</div>${shootoutKicksRow(sh.rounds, 0)}</div>
      <div class="duel-side${sh.currentTurn === 1 ? ' active' : ''}"><div class="nm">${esc(p1.name)}</div>${shootoutKicksRow(sh.rounds, 1)}</div>
    </div>
    <div class="panel ctrl-question-panel">${stageInner}</div>
  `;
}

function controllerGameOverView(s) {
  return `
    <div class="gameover">
      <div class="trophy">🏆</div>
      <div class="winner">${esc(s.winner)} wins!</div>
      <div class="amt" style="font-family:'Oswald',sans-serif;font-size:30px;color:var(--gold);margin-bottom:4px;">${fmtMoney(s.bank)}</div>
      <div class="lbl" style="color:var(--muted);font-size:13px;margin-bottom:18px;">Final team bank</div>
      ${standingsHtml(s.players)}
      <button class="big-btn gold" style="margin-top:26px;" data-action="ctrlPlayAgain">Play again with same players</button>
    </div>
  `;
}
