// Player (contestant's phone) module: setup screen, in-game views for every
// server-driven phase, and the WebSocket networking glue. The server is
// authoritative for all game state — this module only renders `P.state` and
// forwards taps as `vote` / `callBank` / `rename` messages.

import {
  $, esc, fmtMoney, accuracyOf,
} from '../core/dom.js';
import { apiPost, createConnection, wsURL } from '../core/net.js';
import { session } from '../core/storage.js';
import * as sound from '../core/sound.js';
import {
  P, pendingJoinCode, setRole, setLocalView, render, Actions, Changes,
} from './state.js';
import {
  ladderHtml, bigTimerHtml, countdownHtml, standingsHtml, tallyHtml, spawnConfetti,
} from './components.js';

// One-shot-per-terminal-state effect guards (module-level so they survive
// re-renders of the same phase but reset once the room moves on).
let confettiSpawned = false;
let statPop = null; // 'correct' | 'incorrect' | null — drives the .p-stat bounce
let statPopTimer = null;

function markStatPop(kind) {
  statPop = kind;
  clearTimeout(statPopTimer);
  statPopTimer = setTimeout(() => {
    statPop = null;
    render();
  }, 400);
}

function getMe(s) {
  return s.players.find((p) => p.id === s.myId) || {
    correct: 0, incorrect: 0, alive: true, name: P.myName,
  };
}

function everyoneProgress(players) {
  return `
    <div class="everyone-label">Everyone's progress</div>
    ${standingsHtml(players)}
  `;
}

// ---------------- networking ----------------

function handleMessage(msg) {
  if (msg.type === 'state') {
    const prevState = P.state;
    const prevPhase = prevState && prevState.phase;
    const prevMe = prevState ? prevState.players.find((p) => p.id === P.myId) : null;
    const prevAlive = prevMe ? prevMe.alive : undefined;

    P.state = msg.state;
    P.connLost = false;
    if (msg.state.phase !== 'voting') { P.localVoted = false; P.voteDraft = null; }

    const meNow = msg.state.players.find((p) => p.id === P.myId);

    // Sound moments this module owns: your own elimination, and entering gameover.
    if (prevAlive === true && meNow && meNow.alive === false) {
      sound.eliminate();
    }

    if (prevMe && meNow) {
      if (meNow.correct > prevMe.correct) markStatPop('correct');
      else if (meNow.incorrect > prevMe.incorrect) markStatPop('incorrect');
    }

    if (prevPhase && prevPhase !== 'gameover' && msg.state.phase === 'gameover') {
      sound.win();
      if (!confettiSpawned) {
        confettiSpawned = true;
        spawnConfetti(document.body, 40);
      }
    }
    if (msg.state.phase !== 'gameover') {
      // Reset once the room moves on so a future game-over spawns confetti again.
      confettiSpawned = false;
    }
  } else if (msg.type === 'kicked') {
    P.denied = 'You were removed from the game by the host.';
    session.remove('wlink_session');
  } else if (msg.type === 'roomClosed') {
    P.denied = 'The host has closed this room.';
    session.remove('wlink_session');
  } else if (msg.type === 'renameFailed') {
    P.renameError = msg.reason;
  }
  render();
}

export function connectPlayer(code, name, creds) {
  // creds = {playerId, playerToken} — always required now (from the REST join
  // response, or a stored session on auto-rejoin). There is no server
  // "welcome" message anymore, so P.myId is set immediately from creds.
  setRole('player');
  P.roomCode = code;
  P.myName = name;
  P.myId = creds.playerId;
  P.myToken = creds.playerToken;
  P.error = null;
  P.denied = null;
  session.set('wlink_session', {
    roomCode: code, playerId: creds.playerId, playerToken: creds.playerToken, myName: name,
  });
  const conn = createConnection(wsURL({
    role: 'player', code, playerId: creds.playerId, token: creds.playerToken,
  }));
  P.conn = conn;
  conn.on('open', () => { P.connLost = false; render(); });
  conn.on('data', handleMessage);
  conn.on('close', (info) => {
    if (!P.state && info && info.reason) {
      P.error = info.reason;
      session.remove('wlink_session');
    } else {
      P.connLost = true;
    }
    render();
  });
  conn.on('error', () => { P.connLost = true; render(); });
  render();
}

// ---------------- actions ----------------

Actions.joinRoom = async () => {
  const name = ($('#playerName')?.value || '').trim();
  const code = ($('#roomCodeInput')?.value || '').trim().toUpperCase();
  if (!name || !code) { alert('Enter your name and the room code.'); return; }
  sound.unlock();
  try {
    const res = await apiPost(`/api/rooms/${code}/players`, { name });
    connectPlayer(code, name, { playerId: res.playerId, playerToken: res.playerToken });
  } catch (e) {
    P.error = e.message || 'Could not join that room.';
    render();
  }
};

Actions.reconnectNow = () => {
  if (P.roomCode && P.myId && P.myToken) {
    connectPlayer(P.roomCode, P.myName, { playerId: P.myId, playerToken: P.myToken });
  }
};

Actions.retryJoin = () => {
  setLocalView('playerSetup');
  setRole(null);
  session.remove('wlink_session');
  P.conn = null;
  P.roomCode = '';
  P.myName = '';
  P.myId = null;
  P.myToken = null;
  P.state = null;
  P.error = null;
  P.denied = null;
  P.connLost = false;
  P.localVoted = false;
  P.voteDraft = null;
  P.bankFlash = false;
  P.renameError = null;
  confettiSpawned = false;
  render();
};

Actions.submitVote = () => {
  const sel = $('#voteSelect');
  if (!sel || !sel.value) return;
  P.conn.send({ type: 'vote', targetId: sel.value });
  P.localVoted = true;
  P.voteDraft = null;
  render();
};

Actions.callBank = () => {
  P.conn.send({ type: 'callBank' });
  sound.bank();
  P.bankFlash = true;
  render();
  setTimeout(() => { P.bankFlash = false; render(); }, 2500);
};

Actions.renameMe = () => {
  const input = $('#renameInput');
  const newName = input ? input.value.trim() : '';
  if (!newName || !P.conn) return;
  P.renameError = null;
  P.conn.send({ type: 'rename', newName });
  render();
};

Changes.voteDraft = (el) => { P.voteDraft = el.value || null; };

// ---------------- views ----------------

export function playerSetupView() {
  return `
    <div class="landing">
      <div class="setup-card">
        <button class="back-link" data-action="goBack" type="button">&larr; Back</button>
        <h2>Join a game</h2>
        <label for="playerName">Your name</label>
        <input id="playerName" maxlength="18" placeholder="e.g. Sam" autocomplete="off">
        <label for="roomCodeInput">Room code</label>
        <input id="roomCodeInput" class="room-code-input" maxlength="4" placeholder="ABCD" autocomplete="off" value="${esc(pendingJoinCode || '')}">
        <button class="act-btn primary full-btn" data-action="joinRoom" type="button">Join room</button>
      </div>
    </div>
  `;
}

export function playerRootView() {
  if (P.error) {
    return `
      <div class="landing">
        <div class="setup-card">
          <div class="error-box">${esc(P.error)}</div>
          <button class="act-btn primary full-btn" data-action="retryJoin" type="button">Try again</button>
        </div>
      </div>
    `;
  }

  if (P.denied) {
    return `
      <div class="landing">
        <div class="setup-card">
          <div class="error-box">${esc(P.denied)}</div>
          <button class="act-btn neutral full-btn" data-action="retryJoin" type="button">Back</button>
        </div>
      </div>
    `;
  }

  if (!P.myId || !P.state) {
    return `<div class="landing"><div class="center-msg">Connecting to the host&hellip;</div></div>`;
  }

  const s = P.state;
  const me = getMe(s);

  let body;
  switch (s.phase) {
    case 'lobby': body = playerLobbyView(s, me); break;
    case 'countdown': body = playerCountdownView(s, me); break;
    case 'playing': body = playerPlayingView(s, me); break;
    case 'voting': body = playerVotingView(s, me); break;
    case 'elimination': body = playerEliminationView(s, me); break;
    case 'shootout': body = playerShootoutView(s, me); break;
    case 'gameover': body = playerGameOverView(s, me); break;
    default: body = '';
  }

  return `
    <div class="player-wrap">
      <div class="p-header">
        <div class="rc">ROOM ${esc(s.roomCode)}</div>
      </div>
      ${P.connLost ? `
        <div class="banner">
          Connection to host lost. Trying to reconnect&hellip;
          <button class="link-btn" data-action="reconnectNow" type="button">Reconnect now</button>
        </div>
      ` : ''}
      ${body}
      <div class="footer-note">You are ${esc(P.myName)}</div>
    </div>
  `;
}

function playerLobbyView(s, me) {
  return `
    <div class="panel">
      <h3>Waiting for the host to start&hellip;</h3>
      <div class="roster">
        ${s.players.map((p) => `
          <div class="chip">
            <span><span class="dot${p.connected ? '' : ' off'}"></span>${esc(p.name)}${p.id === s.myId ? ' (you)' : ''}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="panel">
      <h3>Change your name</h3>
      ${P.renameError ? `<div class="error-box">${esc(P.renameError)}</div>` : ''}
      <input id="renameInput" maxlength="18" value="${esc(me.name)}">
      <button class="act-btn primary full-btn" data-action="renameMe" type="button">Save name</button>
    </div>
  `;
}

function playerCountdownView(s, me) {
  const sub = s.shootout ? 'Final shootout starting…' : `Round ${s.round} starting…`;
  return `
    ${countdownHtml(sub)}
    ${!me.alive ? `<div class="spectator-tag">You've been voted off — spectating</div>` : ''}
  `;
}

function playerStatsHtml(me) {
  const acc = accuracyOf(me);
  return `
    <div class="p-stats">
      <div class="p-stat">
        <b>${acc == null ? '—' : `${acc}%`}</b>
        <span>Accuracy</span>
      </div>
      <div class="p-stat">
        <b class="${statPop === 'correct' ? 'pop' : ''}">${me.correct}</b>
        <span>Correct</span>
      </div>
      <div class="p-stat">
        <b class="${statPop === 'incorrect' ? 'pop' : ''}">${me.incorrect}</b>
        <span>Incorrect</span>
      </div>
    </div>
  `;
}

function chainBankPanel(s) {
  return `
    <div class="panel">
      ${ladderHtml(s.chainIndex)}
      <div class="bank-total">
        <div class="amt">${fmtMoney(s.bank)}</div>
        <div class="lbl">In the bank</div>
      </div>
    </div>
  `;
}

function playerPlayingView(s, me) {
  if (!me.alive) {
    return `
      <div class="spectator-tag">You've been voted off — spectating</div>
      ${chainBankPanel(s)}
      ${everyoneProgress(s.players)}
    `;
  }

  const yourTurn = s.currentAskedId === s.myId;
  const askedPlayer = s.players.find((p) => p.id === s.currentAskedId);

  return `
    ${bigTimerHtml()}
    ${playerStatsHtml(me)}
    <div class="turn-flag ${yourTurn ? 'yours' : 'theirs'}">
      ${yourTurn ? "You're on the spot!" : `${esc(askedPlayer ? askedPlayer.name : '…')} is answering`}
    </div>
    ${s.currentQuestion ? `
      <div class="stage">
        <div class="q-text">${esc(s.currentQuestion.q)}</div>
      </div>
    ` : ''}
    ${chainBankPanel(s)}
    ${yourTurn ? `
      <button class="act-btn bank full-btn" data-action="callBank" type="button" ${s.chainIndex < 0 ? 'disabled' : ''}>
        ${P.bankFlash ? 'Banked! \u{1F3E6}' : `Bank the chain now (${fmtMoney(s.chainValue)})`}
      </button>
    ` : ''}
  `;
}

function playerVotingView(s, me) {
  if (s.revealing && s.revealInfo) {
    const info = s.revealInfo;
    return `
      ${!me.alive ? `<div class="spectator-tag">You've been voted off — spectating</div>` : ''}
      <div class="center-msg">Revealing vote ${info.index} of ${info.total}</div>
      <div class="vote-grid">
        <div class="vote-row">
          <span>${esc(info.voterName)} voted for</span>
          <span class="${info.votedForName ? 'yes' : 'no'}">${info.votedForName ? esc(info.votedForName) : 'No one — no vote cast'}</span>
        </div>
      </div>
    `;
  }

  if (!me.alive) {
    return `
      <div class="spectator-tag">You've been voted off — spectating</div>
      <div class="center-msg">The remaining players are voting on the weakest link.</div>
      ${everyoneProgress(s.players)}
    `;
  }

  if (s.votedAlready || P.localVoted) {
    return `<div class="center-msg">Vote submitted — waiting for the rest of the group&hellip;</div>`;
  }

  const candidates = s.players.filter((p) => p.alive && p.id !== s.myId);
  return `
    <div class="center-msg">Who's the weakest link?</div>
    <select id="voteSelect" data-bind="voteDraft">
      ${candidates.map((p) => `<option value="${p.id}"${P.voteDraft === p.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}
    </select>
    <button class="act-btn primary full-btn" data-action="submitVote" type="button">Submit vote</button>
  `;
}

function playerEliminationView(s, me) {
  const elim = s.lastElimination;
  return `
    <div class="elim-card">
      ${elim ? `
        <div class="name">${esc(elim.name)}</div>
        ${elim.note ? `<div class="center-msg">${esc(elim.note)}</div>` : ''}
        ${tallyHtml(elim.tally)}
      ` : ''}
    </div>
    ${me.alive
      ? `<div class="center-msg">Get ready for the next round&hellip;</div>`
      : `<div class="spectator-tag">You've been voted off — spectating</div>${everyoneProgress(s.players)}`}
  `;
}

const SHOOTOUT_REGULATION_ROUNDS = 5;

// Regulation is always 5 slots; sudden death keeps appending beyond that —
// showing every round played (instead of a hardcoded 5) is what makes
// sudden-death progress visible instead of looking frozen.
function shootoutKicks(shootout, slotKey) {
  const rounds = shootout.rounds || [];
  const slotCount = Math.max(SHOOTOUT_REGULATION_ROUNDS, rounds.length);
  let html = '';
  for (let i = 0; i < slotCount; i++) {
    const round = rounds[i];
    const val = round ? round[slotKey] : undefined;
    if (val === 'correct') html += '<div class="kick hit">✓</div>';
    else if (val === 'incorrect') html += '<div class="kick miss">✗</div>';
    else html += '<div class="kick"></div>';
  }
  return html;
}

function playerShootoutView(s, me) {
  const shootout = s.shootout;
  if (!shootout) return '';

  const mine = shootout.order.some((o) => o.id === s.myId);
  const [p0, p1] = shootout.order;
  // currentTurn is an integer index (0 or 1) into shootout.order, not a player id.
  const turnPlayer = shootout.order[shootout.currentTurn];
  const myTurn = mine && turnPlayer && turnPlayer.id === s.myId;
  const suddenRound = shootout.currentRoundIndex - SHOOTOUT_REGULATION_ROUNDS + 1;

  return `
    ${!mine ? `<div class="spectator-tag">You've been voted off — spectating</div>` : ''}
    ${shootout.sudden ? `<div class="banner">Sudden death — round ${suddenRound}!</div>` : ''}
    <div class="duel">
      <div class="duel-side${shootout.currentTurn === 0 ? ' active' : ''}">
        <div class="nm">${esc(p0.name)}</div>
        <div class="kicks">${shootoutKicks(shootout, 'p0')}</div>
      </div>
      <div class="duel-side${shootout.currentTurn === 1 ? ' active' : ''}">
        <div class="nm">${esc(p1.name)}</div>
        <div class="kicks">${shootoutKicks(shootout, 'p1')}</div>
      </div>
    </div>
    ${mine
      ? `<div class="turn-flag ${myTurn ? 'yours' : 'theirs'}">${myTurn ? "You're up!" : 'Waiting for your turn'}</div>`
      : `<div class="turn-flag theirs">${esc(turnPlayer ? turnPlayer.name : '…')}'s turn</div>${everyoneProgress(s.players)}`}
  `;
}

function playerGameOverView(s, me) {
  return `
    <div class="gameover">
      <div class="trophy">\u{1F3C6}</div>
      <div class="winner">${esc(s.winner)} wins!</div>
      <div class="bank-total">
        <div class="amt">${fmtMoney(s.bank)}</div>
        <div class="lbl">Final bank</div>
      </div>
      <div class="center-msg">${s.winner === me.name ? 'That’s you \u{1F389}' : 'Thanks for playing!'}</div>
      ${standingsHtml(s.players)}
    </div>
  `;
}
