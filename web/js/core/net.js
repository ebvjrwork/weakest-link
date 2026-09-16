// Thin WebSocket wrapper mirroring PeerJS's old DataConnection interface
// (on('open'|'data'|'close'|'error'), .send()) so the game/controller/player
// modules barely notice the transport changed from PeerJS to a plain socket.
//
// Ping/pong keepalive is handled entirely by the browser at the protocol
// level (the server sends WS ping frames; the browser replies automatically)
// — nothing to do here for that.

export function createConnection(url) {
  const listeners = { open: [], data: [], close: [], error: [] };
  let ws = null;
  let closedByUser = false;
  let backoffMs = 1000;
  let reconnectTimer = null;
  let queue = [];
  const MAX_BACKOFF = 15000;

  function emit(evt, payload) {
    listeners[evt].forEach((fn) => {
      try { fn(payload); } catch (e) { console.error(e); }
    });
  }

  function flushQueue() {
    const q = queue;
    queue = [];
    q.forEach((obj) => ws.send(JSON.stringify(obj)));
  }

  function scheduleReconnect() {
    if (reconnectTimer || closedByUser) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
      open();
    }, backoffMs + Math.random() * 300);
  }

  function open() {
    closedByUser = false;
    ws = new WebSocket(url);
    ws.onopen = () => {
      backoffMs = 1000;
      flushQueue();
      emit('open');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      emit('data', msg);
    };
    ws.onclose = (ev) => {
      // On an attach rejection (room gone, bad/expired token) the server closes
      // immediately with no write pump ever having started, so the close
      // frame's reason string is the only way that message reaches us.
      emit('close', { code: ev.code, reason: ev.reason });
      if (!closedByUser) scheduleReconnect();
    };
    ws.onerror = (e) => emit('error', e);
  }

  open();

  return {
    on(evt, fn) {
      (listeners[evt] || (listeners[evt] = [])).push(fn);
    },
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
      } else {
        queue.push(obj);
      }
    },
    close() {
      closedByUser = true;
      clearTimeout(reconnectTimer);
      if (ws) ws.close();
    },
    get isOpen() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}

// --- REST helpers for room bootstrap / admin / submissions -----------------

async function asJSON(res) {
  let body = null;
  try { body = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function apiGet(path) {
  return fetch(path, { credentials: 'include' }).then(asJSON);
}

export function apiPost(path, body) {
  return fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(asJSON);
}

export function apiPut(path, body) {
  return fetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(asJSON);
}

export function apiDelete(path) {
  return fetch(path, { method: 'DELETE', credentials: 'include' }).then(asJSON);
}

export function apiUpload(path, formData) {
  return fetch(path, { method: 'POST', credentials: 'include', body: formData }).then(asJSON);
}

export function wsURL(params) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const qs = new URLSearchParams(params).toString();
  return `${proto}//${window.location.host}/ws?${qs}`;
}
