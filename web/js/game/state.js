// Shared game-client state: role/view globals, per-role local mirrors of
// server state, and the render() pub-sub that lets any module trigger a
// re-render without importing main.js (which would create a cycle, since
// main.js imports host/controller/player which import this module).

export const CHAIN_VALUES = [20, 50, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 1000];

export let role = null; // null | 'host' | 'controller' | 'player'
export let localView = 'landing'; // 'landing' | 'hostSetup' | 'playerSetup' | 'controllerSetup'
export let pendingJoinCode = '';

export function setRole(r) { role = r; }
export function setLocalView(v) { localView = v; }
export function setPendingJoinCode(c) { pendingJoinCode = c; }

// HOST is a read-only spectator mirror now — the server is authoritative, so
// the "big screen" role no longer holds any special state of its own.
export const HOST = { conn: null, roomCode: '', state: null, error: null, connLost: false };

export const CTRL = {
  conn: null, roomCode: '', state: null, error: null, connLost: false,
};

export const P = {
  conn: null, roomCode: '', myName: '', myId: null, myToken: null,
  state: null, error: null, denied: null, connLost: false,
  localVoted: false, voteDraft: null, bankFlash: false, renameError: null,
};

// Controller-only draft UI state that must survive re-renders (a full
// innerHTML replace would otherwise wipe an in-progress textarea/file pick).
export const ctrlUI = {
  questionsDraft: '',
  csvParsedQuestions: null,
  csvFileName: null,
  linkCopied: false,
};

// Room-setup (host creating a room) draft state, shared with the controller's
// in-lobby bank editor via the same questionBankEditor() component.
export const setupUI = {
  bankMode: 'community', // 'community' | 'custom'
  questionsDraft: '',
  csvParsedQuestions: null,
  csvFileName: null,
};

let renderListeners = [];
export function onRender(fn) { renderListeners.push(fn); }
export function render() { renderListeners.forEach((fn) => fn()); }

// The server sends absolute epoch-ms timer/countdown deadlines and expects
// each client to count down against its own Date.now() (see CLAUDE.md's
// "zero server chatter" ticking-clock design) — that only stays accurate if
// the client's wall clock agrees with the server's. Every state message
// piggybacks the server's current time (no extra network chatter), and we
// track the client/server delta so tickLiveTimers can correct for drift
// instead of trusting the client clock outright.
let clockOffsetMs = 0;
export function syncClock(serverNow) {
  if (typeof serverNow === 'number') clockOffsetMs = Date.now() - serverNow;
}
export function clockNow() { return Date.now() - clockOffsetMs; }

export const Actions = {};

// Registries for the global delegated 'input'/'change' listeners (main.js),
// keyed by an element's data-bind attribute — lets host/controller/player
// modules own textarea-draft/file-input handling without main.js needing to
// import their internals.
export const Binds = {};
export const Changes = {};
