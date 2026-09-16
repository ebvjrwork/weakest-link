// Public "suggest a trivia question" page. Fully decoupled from the game
// client: no shared state/render bus, no core/dom.js import — just a small
// self-contained render()-on-innerHTML app, matching the buildless style
// used everywhere else in this codebase.
//
// This page is NOT the admin panel: submitters land in a moderation queue,
// never see other people's submissions, the full approved bank, or whether
// their own submission was approved. That boundary is called out in the
// permanent notice rendered at the top of the form (see noticeHtml()).

import { parseCSVQuestions, parseCustomQuestions } from '../core/questions-parse.js';

const QUESTION_MAX = 300;
const ANSWER_MAX = 150;
const NAME_MAX = 80;
const NOTE_MAX = 500;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- tiny fetch helpers -----------------------------------------------------

async function asJSON(res) {
  let body = null;
  try { body = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function postJSON(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(asJSON);
}

function postForm(path, formData) {
  return fetch(path, { method: 'POST', body: formData }).then(asJSON);
}

// --- state -------------------------------------------------------------------

function emptyState() {
  return {
    view: 'form', // 'form' | 'submitted'
    mode: 'single', // 'single' | 'bulk'
    submitting: false,
    error: null,
    submittedCount: 0,
    single: { question: '', answer: '', name: '', note: '' },
    bulk: { text: '', name: '', note: '', file: null, fileName: '', filePreviewCount: 0 },
  };
}

let state = emptyState();

function resetForm() {
  state = emptyState();
  render();
}

function bulkPreviewCount() {
  if (state.bulk.file) return state.bulk.filePreviewCount || 0;
  return parseCustomQuestions(state.bulk.text).length;
}

// Raw (unescaped) text — callers decide whether to esc() it (innerHTML) or
// hand it straight to textContent (direct DOM patch).
function bulkPreviewText() {
  const count = bulkPreviewCount();
  const plural = count === 1 ? '' : 's';
  if (state.bulk.file) {
    return `Found ${count} question${plural} in ${state.bulk.fileName}.`;
  }
  return count === 0 ? 'Found 0 questions yet — paste some above.' : `Found ${count} question${plural}.`;
}

function bulkSubmitLabel() {
  const count = bulkPreviewCount();
  return `Submit ${count} question${count === 1 ? '' : 's'} for review`;
}

// --- markup --------------------------------------------------------------

function noticeHtml() {
  return `
    <div class="submit-notice">
      Submissions are reviewed by a moderator before joining the shared question bank.
      You won't see other people's submissions or the full approved bank here, and you
      won't be notified whether your submission was approved.
    </div>
  `;
}

function errorHtml() {
  if (!state.error) return '';
  return `<div class="tool-error">${esc(state.error)}</div>`;
}

function tabsHtml() {
  return `
    <div class="tool-tabs">
      <button type="button" class="${state.mode === 'single' ? 'active' : ''}" data-action="setMode" data-arg="single">Single question</button>
      <button type="button" class="${state.mode === 'bulk' ? 'active' : ''}" data-action="setMode" data-arg="bulk">Bulk paste / CSV</button>
    </div>
  `;
}

function singlePanelHtml() {
  const s = state.single;
  return `
    <form class="tool-form" data-form="single">
      <label>Question <span>(up to ${QUESTION_MAX} characters)</span></label>
      <textarea class="submit-question-input" data-bind="single.question" maxlength="${QUESTION_MAX}" placeholder="e.g. What is the capital of France?">${esc(s.question)}</textarea>

      <label>Answer <span>(up to ${ANSWER_MAX} characters)</span></label>
      <input type="text" data-bind="single.answer" maxlength="${ANSWER_MAX}" value="${esc(s.answer)}" placeholder="e.g. Paris">

      <label>Your name (optional)</label>
      <input type="text" data-bind="single.name" maxlength="${NAME_MAX}" value="${esc(s.name)}" placeholder="e.g. Alex">

      <label>Note for moderators (optional)</label>
      <textarea data-bind="single.note" maxlength="${NOTE_MAX}" placeholder="Any context that helps a moderator review this">${esc(s.note)}</textarea>

      <div class="tool-btn-row">
        <button type="submit" class="tool-btn primary" ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Submitting…' : 'Submit question'}</button>
      </div>
    </form>
  `;
}

function bulkPanelHtml() {
  const b = state.bulk;
  const count = bulkPreviewCount();
  const hintText = bulkPreviewText();
  return `
    <div class="tool-form">
      <label>Paste questions</label>
      <textarea data-bind="bulk.text" placeholder="Question | Answer  (one per line)&#10;or a JSON array of [question, answer] pairs" ${b.file ? 'disabled' : ''}>${esc(b.text)}</textarea>
      <div class="submit-hint${count > 0 ? ' has-count' : ''}" data-bulk-preview>${esc(hintText)}</div>

      <div class="submit-divider">or</div>

      <label>Upload a CSV file</label>
      <input type="file" accept=".csv,text/csv" data-bulk-file>
      ${b.fileName ? `
        <div class="submit-filename">
          <span>${esc(b.fileName)}</span>
          <button type="button" class="tool-btn" data-action="clearFile">Remove</button>
        </div>
      ` : ''}

      <label>Your name (optional)</label>
      <input type="text" data-bind="bulk.name" maxlength="${NAME_MAX}" value="${esc(b.name)}" placeholder="e.g. Alex">

      <label>Note for moderators (optional)</label>
      <textarea data-bind="bulk.note" maxlength="${NOTE_MAX}" placeholder="Any context that helps a moderator review these">${esc(b.note)}</textarea>

      <div class="tool-btn-row">
        <button type="button" class="tool-btn primary" data-action="submitBulk" data-bulk-submit ${(count === 0 || state.submitting) ? 'disabled' : ''}>${state.submitting ? 'Submitting…' : esc(bulkSubmitLabel())}</button>
      </div>
    </div>
  `;
}

function formView() {
  return `
    <div class="submit-wrap">
      <a class="back-link" href="/">&larr; Back to Chain Reaction</a>
      <div class="submit-card">
        <div class="submit-brand">
          <svg class="tool-logo" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
            <g fill="none" stroke="#e8b23d" stroke-width="4" stroke-linecap="round">
              <ellipse cx="12" cy="12.5" rx="6.2" ry="5" transform="rotate(-32 12 12.5)"/>
              <ellipse cx="20" cy="19.5" rx="6.2" ry="5" transform="rotate(-32 20 19.5)"/>
            </g>
          </svg>
          <h1 class="submit-title">Suggest a Question</h1>
        </div>
        <p class="submit-sub">Help grow the community trivia bank for Chain Reaction.</p>
        ${noticeHtml()}
        ${errorHtml()}
        ${tabsHtml()}
        ${state.mode === 'single' ? singlePanelHtml() : bulkPanelHtml()}
      </div>
    </div>
  `;
}

function submittedView() {
  const n = state.submittedCount || 1;
  const plural = n !== 1;
  const message = plural
    ? "Your questions have been sent to our moderators. We'll review them before they join the community bank — you won't see them appear immediately."
    : "Your question has been sent to our moderators. We'll review it before it joins the community bank — you won't see it appear immediately.";
  return `
    <div class="submit-wrap">
      <div class="submit-card submit-card-done">
        <div class="submit-done">
          <div class="submit-check">&#10003;</div>
          <h2>Thanks!</h2>
          <p class="submit-count">${n} question${plural ? 's' : ''} submitted</p>
          <p>${esc(message)}</p>
          <button type="button" class="tool-btn primary" data-action="resetForm">Submit another</button>
          <div class="submit-back"><a href="/">&larr; Back to Chain Reaction</a></div>
        </div>
      </div>
    </div>
  `;
}

function render() {
  document.getElementById('app').innerHTML = state.view === 'submitted' ? submittedView() : formView();
}

// Patches just the live-preview line + submit button, without touching the
// textarea/file input — a full render() would replace those DOM nodes and
// steal focus/cursor position mid-keystroke.
function patchBulkPreview() {
  if (state.view !== 'form' || state.mode !== 'bulk') return;
  const count = bulkPreviewCount();
  const line = document.querySelector('[data-bulk-preview]');
  if (line) {
    line.textContent = bulkPreviewText();
    line.classList.toggle('has-count', count > 0);
  }
  const btn = document.querySelector('[data-bulk-submit]');
  if (btn) {
    btn.disabled = count === 0 || state.submitting;
    if (!state.submitting) btn.textContent = bulkSubmitLabel();
  }
}

// --- submit handlers -----------------------------------------------------

async function submitSingle() {
  if (state.submitting) return;
  const question = state.single.question.trim();
  const answer = state.single.answer.trim();
  if (!question || !answer) {
    state.error = 'Please fill in both the question and the answer.';
    render();
    return;
  }
  state.submitting = true;
  state.error = null;
  render();
  try {
    await postJSON('/api/submissions', {
      question,
      answer,
      submitterName: state.single.name.trim() || undefined,
      note: state.single.note.trim() || undefined,
    });
    state.view = 'submitted';
    state.submittedCount = 1;
    state.submitting = false;
    render();
  } catch (err) {
    state.submitting = false;
    state.error = err.message || 'Something went wrong — please try again.';
    render();
  }
}

async function submitBulk() {
  if (state.submitting) return;
  const count = bulkPreviewCount();
  if (count === 0) return;
  state.submitting = true;
  state.error = null;
  render();
  try {
    let result;
    if (state.bulk.file) {
      const fd = new FormData();
      fd.append('file', state.bulk.file);
      const name = state.bulk.name.trim();
      const note = state.bulk.note.trim();
      if (name) fd.append('submitterName', name);
      if (note) fd.append('note', note);
      result = await postForm('/api/submissions/bulk', fd);
    } else {
      result = await postJSON('/api/submissions/bulk', {
        text: state.bulk.text,
        submitterName: state.bulk.name.trim() || undefined,
        note: state.bulk.note.trim() || undefined,
      });
    }
    state.view = 'submitted';
    state.submittedCount = (result && typeof result.accepted === 'number') ? result.accepted : count;
    state.submitting = false;
    render();
  } catch (err) {
    state.submitting = false;
    state.error = err.message || 'Something went wrong — please try again.';
    render();
  }
}

// --- global delegated event listeners --------------------------------------

let bulkDebounce = null;

document.addEventListener('input', (e) => {
  const el = e.target;
  const bind = el.getAttribute && el.getAttribute('data-bind');
  if (!bind) return;
  if (bind === 'single.question') state.single.question = el.value;
  else if (bind === 'single.answer') state.single.answer = el.value;
  else if (bind === 'single.name') state.single.name = el.value;
  else if (bind === 'single.note') state.single.note = el.value;
  else if (bind === 'bulk.name') state.bulk.name = el.value;
  else if (bind === 'bulk.note') state.bulk.note = el.value;
  else if (bind === 'bulk.text') {
    state.bulk.text = el.value;
    clearTimeout(bulkDebounce);
    bulkDebounce = setTimeout(patchBulkPreview, 200);
  }
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (!(el.matches && el.matches('[data-bulk-file]'))) return;
  const file = el.files && el.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || '');
    state.bulk.file = file;
    state.bulk.fileName = file.name;
    state.bulk.filePreviewCount = parseCSVQuestions(text).length;
    state.error = null;
    render();
  };
  reader.onerror = () => {
    state.error = 'Could not read that file — please try again.';
    render();
  };
  reader.readAsText(file);
});

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.getAttribute('data-action');
  const arg = el.getAttribute('data-arg');
  if (action === 'setMode') {
    state.mode = arg;
    state.error = null;
    render();
  } else if (action === 'clearFile') {
    state.bulk.file = null;
    state.bulk.fileName = '';
    state.bulk.filePreviewCount = 0;
    render();
  } else if (action === 'submitBulk') {
    submitBulk();
  } else if (action === 'resetForm') {
    resetForm();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.closest && e.target.closest('[data-form="single"]')) {
    e.preventDefault();
    submitSingle();
  }
});

render();
