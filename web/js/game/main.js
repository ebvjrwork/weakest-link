// App bootstrap: landing view, the render() dispatcher, global delegated
// event listeners, the lightweight timer ticker, and startup (auto-rejoin /
// ?join=CODE handling) — the direct port of the original file's tail IIFE.

import { $, getQueryParam, fmtClock } from '../core/dom.js';
import { session } from '../core/storage.js';
import * as sound from '../core/sound.js';
import {
  role, localView, setLocalView, setPendingJoinCode, HOST, CTRL, P, onRender, Actions, Binds, Changes,
} from './state.js';
import { hostSetupView, hostRootView, connectHost } from './host.js';
import { controllerSetupView, controllerRootView, connectController } from './controller.js';
import { playerSetupView, playerRootView, connectPlayer } from './player.js';

// Ambient background "embers" — faint drifting sparks that rise slowly
// behind the landing hero. Purely decorative (aria-hidden, pointer-events
// disabled via CSS), randomized per mount via inline custom properties so
// the CSS keyframes (defined in landing.css) can stay generic.
function landingEmbers(count) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = (Math.random() * 100).toFixed(1);
    const size = (Math.random() * 3 + 2).toFixed(1);
    const dur = (Math.random() * 10 + 10).toFixed(1);
    const delay = (-Math.random() * dur).toFixed(1);
    const drift = (Math.random() * 44 - 22).toFixed(0);
    const op = (Math.random() * 0.25 + 0.15).toFixed(2);
    out += `<span class="ember" style="--x:${x}%;--size:${size}px;--dur:${dur}s;--delay:${delay}s;--drift:${drift}px;--op:${op}"></span>`;
  }
  return out;
}

// A handful of the same two-ring "chain link" brand motif, shrunk way down,
// scattered behind the hero and set adrift with a slow rotate/float loop —
// echoes the logo mark without competing with it.
function landingChainDrift(count) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const top = (Math.random() * 90 + 4).toFixed(1);
    const left = (Math.random() * 90 + 4).toFixed(1);
    const size = (Math.random() * 26 + 22).toFixed(0);
    const dur = (Math.random() * 10 + 14).toFixed(1);
    const delay = (-Math.random() * dur).toFixed(1);
    const rot = (Math.random() * 360).toFixed(0);
    const op = (Math.random() * 0.12 + 0.08).toFixed(2);
    out += `
      <svg class="drift-link" style="--top:${top}%;--left:${left}%;--size:${size}px;--dur:${dur}s;--delay:${delay}s;--rot:${rot}deg;--op:${op}" viewBox="0 0 32 32" aria-hidden="true">
        <g fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round">
          <ellipse cx="12" cy="12.5" rx="6.2" ry="5" transform="rotate(-32 12 12.5)"/>
          <ellipse cx="20" cy="19.5" rx="6.2" ry="5" transform="rotate(-32 20 19.5)"/>
        </g>
      </svg>`;
  }
  return out;
}

function landingView() {
  return `
    <div class="landing">
      <div class="landing-ambient" aria-hidden="true">
        ${landingEmbers(13)}
        ${landingChainDrift(5)}
      </div>
      <div class="landing-glow" aria-hidden="true"></div>
      <svg class="brand-mark" viewBox="0 0 32 32" width="76" height="76" aria-hidden="true">
        <g fill="none" stroke="url(#brandMarkGold)" stroke-width="4" stroke-linecap="round">
          <ellipse cx="12" cy="12.5" rx="6.2" ry="5" transform="rotate(-32 12 12.5)"/>
          <ellipse cx="20" cy="19.5" rx="6.2" ry="5" transform="rotate(-32 20 19.5)"/>
        </g>
        <defs>
          <linearGradient id="brandMarkGold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#fff"/>
            <stop offset="100%" stop-color="#e8b23d"/>
          </linearGradient>
        </defs>
      </svg>
      <h1 class="brand">Chain <span>Reaction</span></h1>
      <div class="landing-card">
        <p class="tag">A fast-paced trivia elimination party game. Pick a big screen to host on, grab your phones, and find out who's the weakest link.</p>
        <div class="landing-btns">
          <button class="big-btn gold" data-action="goHostSetup">Host on this screen</button>
          <button class="big-btn ghost" data-action="goPlayerSetup">Join as a player</button>
        </div>
      </div>
      <div class="landing-footer">
        <span>created by axiomatic7689</span>
      </div>
    </div>
  `;
}

function rootView() {
  if (role === 'host') return hostRootView();
  if (role === 'controller') return controllerRootView();
  if (role === 'player') return playerRootView();
  if (localView === 'hostSetup') return hostSetupView();
  if (localView === 'playerSetup') return playerSetupView();
  if (localView === 'controllerSetup') return controllerSetupView();
  return landingView();
}

function render() {
  $('#app').innerHTML = rootView();
}
onRender(render);

// --- navigation + global actions --------------------------------------------------------

Actions.goHostSetup = () => { setLocalView('hostSetup'); render(); };
Actions.goPlayerSetup = () => { setLocalView('playerSetup'); render(); };
Actions.goControllerSetup = () => { setLocalView('controllerSetup'); render(); };
Actions.goBack = () => { setLocalView('landing'); render(); };
Actions.toggleSound = () => { sound.setMuted(!sound.isMuted()); render(); };

// --- global delegated event listeners ----------------------------------------------------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.getAttribute('data-action');
  const arg = el.getAttribute('data-arg');
  if (typeof Actions[action] === 'function') Actions[action](arg, el);
});

document.addEventListener('input', (e) => {
  const el = e.target;
  const bind = el.getAttribute && el.getAttribute('data-bind');
  if (bind && typeof Binds[bind] === 'function') Binds[bind](el.value, el);
});

document.addEventListener('change', (e) => {
  const el = e.target;
  const bind = el.getAttribute && el.getAttribute('data-bind');
  if (bind && typeof Changes[bind] === 'function') Changes[bind](el, e);
});

document.addEventListener('keydown', (e) => {
  if (typeof Actions.__keydown === 'function') Actions.__keydown(e);
});

// Unlock audio on the very first tap anywhere, as a catch-all in addition to
// the explicit unlock() calls on create/join/controller-connect buttons.
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });

// --- lightweight live timer/countdown ticker --------------------------------------------
// Patches only .js-timer/.js-countdown text nodes directly, never calling
// render(), so the rest of the screen never re-mounts just for a ticking clock.

let lastTickSecond = null;

function activeState() {
  if (role === 'host') return HOST.state;
  if (role === 'controller') return CTRL.state;
  if (role === 'player') return P.state;
  return null;
}

function tickLiveTimers() {
  const s = activeState();
  let endsAt = null;
  let running = false;
  let cdEndsAt = null;
  if (s) {
    if (s.phase === 'playing') { endsAt = s.timer.endsAt; running = s.timer.running; }
    if (s.phase === 'countdown') { cdEndsAt = s.countdownEndsAt; }
  }

  const remaining = running ? endsAt - Date.now() : null;
  const text = running ? fmtClock(remaining) : '--:--';
  const low = running && remaining < 10000;
  document.querySelectorAll('.js-timer').forEach((node) => {
    node.textContent = text;
    node.classList.toggle('low', !!low);
  });

  if (running) {
    const wholeSecond = Math.ceil(remaining / 1000);
    if (wholeSecond !== lastTickSecond && wholeSecond <= 10 && wholeSecond > 0) {
      sound.tick(wholeSecond <= 3);
    }
    lastTickSecond = wholeSecond;
  } else {
    lastTickSecond = null;
  }

  if (cdEndsAt !== null) {
    const secsLeft = Math.max(0, Math.ceil((cdEndsAt - Date.now()) / 1000));
    document.querySelectorAll('.js-countdown').forEach((node) => {
      node.textContent = secsLeft > 0 ? String(secsLeft) : 'GO!';
    });
  }
}
setInterval(tickLiveTimers, 500);

// --- bootstrap -----------------------------------------------------------------------------

function init() {
  const sess = session.get('wlink_session', null);
  if (sess && sess.roomCode && sess.playerId && sess.playerToken) {
    connectPlayer(sess.roomCode, sess.myName || '', { playerId: sess.playerId, playerToken: sess.playerToken });
    return;
  }
  // Same-tab refresh recovery for the big-screen display (mirrors the player
  // session above) — falls back to the ?host=CODE link below if there's no
  // session (a fresh tab/device, e.g. after the original tab was closed).
  const hostSess = session.get('wlink_host_session', null);
  if (hostSess && hostSess.roomCode) {
    connectHost(hostSess.roomCode, hostSess.controllerKey);
    return;
  }
  // Opened from the big screen's own "recovery URL" (or a bookmark of it) —
  // reconnects the display to an already-running room, no secret needed.
  const hostCode = getQueryParam('host');
  if (hostCode) {
    const clean = hostCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (clean) {
      connectHost(clean);
      return;
    }
  }
  // Opened from the "Open quizmaster controller" link on the host's lobby
  // screen — connect straight in, no manual room-code entry needed.
  const runCode = getQueryParam('run');
  if (runCode) {
    const clean = runCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (clean) {
      connectController(clean, getQueryParam('key') || '');
      return;
    }
  }
  const joinCode = getQueryParam('join');
  if (joinCode) {
    const clean = joinCode.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
    if (clean) {
      setLocalView('playerSetup');
      setPendingJoinCode(clean);
    }
  }
  render();
}

init();
