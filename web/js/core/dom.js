// Small framework-free helpers shared by every view module.

export function $(sel, root) {
  return (root || document).querySelector(sel);
}

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function fmtMoney(n) {
  return '$' + Number(n || 0).toLocaleString();
}

export function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + (r < 10 ? '0' : '') + r;
}

export function accuracyOf(p) {
  const total = (p.correct || 0) + (p.incorrect || 0);
  if (total === 0) return null;
  return Math.round((p.correct / total) * 100);
}

export function uid() {
  return Math.random().toString(36).slice(2, 9);
}

export function getQueryParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch (e) {
    return null;
  }
}

export function buildInviteLink(code) {
  try {
    return window.location.origin + window.location.pathname.replace(/[^/]*$/, '') + '?join=' + code;
  } catch (e) {
    return '?join=' + code;
  }
}
