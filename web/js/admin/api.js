// Tiny fetch wrapper for the /api/admin/* REST endpoints. Every request rides
// on the httpOnly admin session cookie (never touched directly by JS), so
// credentials: 'include' is mandatory on all of them. A 401 from any endpoint
// means "not logged in" — callers check err.status === 401 and route back to
// the login view.

async function asJSON(res) {
  let body = null;
  try { body = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

export function get(path) {
  return fetch(path, { credentials: 'include' }).then(asJSON);
}

export function post(path, body) {
  return fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(asJSON);
}

export function put(path, body) {
  return fetch(path, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(asJSON);
}

export function del(path) {
  return fetch(path, { method: 'DELETE', credentials: 'include' }).then(asJSON);
}
