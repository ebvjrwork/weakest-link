// App bootstrap: landing view, the render() dispatcher, global delegated
// event listeners, the lightweight timer ticker, and startup (auto-rejoin /
// ?join=CODE handling) — the direct port of the original file's tail IIFE.

import { $, getQueryParam, fmtClock } from '../core/dom.js';
import { session } from '../core/storage.js';
import * as sound from '../core/sound.js';
import {
  role, localView, setLocalView, setPendingJoinCode, HOST, CTRL, P, onRender, Actions, Binds, Changes,
} from './state.js';
import { hostSetupView, hostRootView } from './host.js';
import { controllerSetupView, controllerRootView } from './controller.js';
import { playerSetupView, playerRootView, connectPlayer } from './player.js';

function landingView() {
  return `
    <div class="landing">
      <h1 class="brand">Chain <span>Reaction</span></h1>
      <p class="tag">A fast-paced trivia elimination party game. Pick a big screen to host on, grab your phones, and find out who's the weakest link.</p>
      <div class="landing-btns">
        <button class="big-btn gold" data-action="goHostSetup">Host on this screen</button>
        <button class="big-btn ghost" data-action="goPlayerSetup">Join as a player</button>
        <button class="big-btn ghost" data-action="goControllerSetup">Be the quizmaster</button>
      </div>
      <div class="landing-footer">
        <a href="/submit.html">Suggest questions for the community bank</a>
        <a href="/admin.html">Admin</a>
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
