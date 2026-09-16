// Chain Reaction admin panel — a small, self-contained internal tool for a
// single administrator to manage the shared question bank and moderate
// public submissions.
//
// This is intentionally NOT wired into the game's Actions/render() pub-sub
// (web/js/game/state.js). It's a separate mini-app with its own local
// state and its own DOM update logic: build an HTML string per view, assign
// it to #app.innerHTML, and wire it up with delegated click/submit/input
// listeners (same "buildless" style as the rest of the codebase, just not
// sharing the game's module graph).

import * as api from './api.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// --- state -------------------------------------------------------------------------------

const state = {
  view: 'login', // 'login' | 'questions' | 'moderation'

  loginBusy: false,
  loginError: '',

  pendingCount: 0,

  questions: {
    items: [],
    total: 0,
    limit: 25,
    offset: 0,
    search: '',
    loading: false,
    error: '',
    editingId: null,
    addQuestion: '',
    addAnswer: '',
    addError: '',
    bulkText: '',
    bulkMessage: '',
    bulkError: '',
  },

  moderation: {
    items: [],
    total: 0,
    limit: 25,
    offset: 0,
    loading: false,
    error: '',
    editingId: null,
  },
};

// --- rendering -----------------------------------------------------------------------------

function render() {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = state.view === 'login' ? loginView() : shellView();
}

function loginView() {
  return `
    <div class="tool-login">
      <div class="tool-brand tool-brand-stack">
        <svg class="tool-logo" viewBox="0 0 32 32" width="36" height="36" aria-hidden="true">
          <g fill="none" stroke="#e8b23d" stroke-width="4" stroke-linecap="round">
            <ellipse cx="12" cy="12.5" rx="6.2" ry="5" transform="rotate(-32 12 12.5)"/>
            <ellipse cx="20" cy="19.5" rx="6.2" ry="5" transform="rotate(-32 20 19.5)"/>
          </g>
        </svg>
        <h1>Chain Reaction Admin</h1>
      </div>
      <p style="color:var(--muted);font-size:13px;margin:6px 0 20px;">Sign in to manage the question bank</p>
      ${state.loginError ? `<div class="tool-error">${esc(state.loginError)}</div>` : ''}
      <form class="tool-form" data-form="login">
        <label for="admin-password">Password</label>
        <input id="admin-password" name="password" type="password" autocomplete="current-password" />
        <div class="tool-btn-row" style="justify-content:center;">
          <button type="submit" class="tool-btn primary" ${state.loginBusy ? 'disabled' : ''}>${state.loginBusy ? 'Logging in…' : 'Log in'}</button>
        </div>
      </form>
    </div>
  `;
}

function shellView() {
  const body = state.view === 'moderation' ? moderationView() : questionsView();
  return `
    <div class="tool-shell">
      <div class="tool-header">
        <div class="tool-brand">
          <svg class="tool-logo" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
            <g fill="none" stroke="#e8b23d" stroke-width="4" stroke-linecap="round">
              <ellipse cx="12" cy="12.5" rx="6.2" ry="5" transform="rotate(-32 12 12.5)"/>
              <ellipse cx="20" cy="19.5" rx="6.2" ry="5" transform="rotate(-32 20 19.5)"/>
            </g>
          </svg>
          <div>
            <h1>Chain Reaction Admin</h1>
            <div class="sub">Manage the trivia question bank and review public submissions</div>
          </div>
        </div>
        <div class="tool-nav">
          <button data-action="showQuestions" class="${state.view === 'questions' ? 'active' : ''}">Questions</button>
          <button data-action="showModeration" class="${state.view === 'moderation' ? 'active' : ''}">Moderation <span class="badge">${state.pendingCount}</span></button>
          <button data-action="logout">Log out</button>
        </div>
      </div>
      ${body}
    </div>
  `;
}

function questionsView() {
  const q = state.questions;
  const start = q.total === 0 ? 0 : q.offset + 1;
  const end = Math.min(q.offset + q.limit, q.total);

  let tableHtml;
  if (q.loading) {
    tableHtml = `<div class="tool-empty tool-empty--loading">Loading…</div>`;
  } else if (q.items.length === 0) {
    tableHtml = `<div class="tool-empty">No questions found.</div>`;
  } else {
    tableHtml = `
      <table class="tool-table">
        <thead><tr><th>Question</th><th>Answer</th><th>Source</th><th></th></tr></thead>
        <tbody>${q.items.map(questionRowHtml).join('')}</tbody>
      </table>
    `;
  }

  return `
    <div class="tool-card">
      <h2>Question bank</h2>
      <form class="tool-form admin-add-form" data-form="addQuestion">
        ${q.addError ? `<div class="tool-error">${esc(q.addError)}</div>` : ''}
        <label for="add-q">Question</label>
        <input id="add-q" name="question" type="text" value="${esc(q.addQuestion)}" placeholder="e.g. What is the capital of France?" />
        <label for="add-a">Answer</label>
        <input id="add-a" name="answer" type="text" value="${esc(q.addAnswer)}" placeholder="e.g. Paris" />
        <div class="tool-btn-row">
          <button type="submit" class="tool-btn primary">Add question</button>
        </div>
      </form>

      <div class="tool-search">
        <input type="text" placeholder="Search questions and answers…" value="${esc(q.search)}" data-bind="search" />
      </div>
      ${q.error ? `<div class="tool-error">${esc(q.error)}</div>` : ''}
      ${tableHtml}
      <div class="tool-pagination">
        <button data-action="qPrev" ${(q.offset <= 0 || q.loading) ? 'disabled' : ''}>Prev</button>
        <span>Showing ${start}–${end} of ${q.total}</span>
        <button data-action="qNext" ${((q.offset + q.limit) >= q.total || q.loading) ? 'disabled' : ''}>Next</button>
      </div>
    </div>

    <div class="tool-card">
      <h3>Bulk import</h3>
      ${q.bulkMessage ? `<div class="tool-success">${esc(q.bulkMessage)}</div>` : ''}
      ${q.bulkError ? `<div class="tool-error">${esc(q.bulkError)}</div>` : ''}
      <form class="tool-form" data-form="bulkImport">
        <label for="bulk-text">Paste questions — one "Question | Answer" per line, or a JSON array</label>
        <textarea id="bulk-text" name="text" placeholder="What is the capital of France? | Paris">${esc(q.bulkText)}</textarea>
        <div class="tool-btn-row">
          <button type="submit" class="tool-btn blue">Import</button>
        </div>
      </form>
    </div>
  `;
}

function questionRowHtml(item) {
  const editing = state.questions.editingId === item.id;
  if (editing) {
    return `
      <tr class="editing" data-id="${item.id}">
        <td class="q-cell"><input type="text" data-field="question" value="${esc(item.question)}" /></td>
        <td class="a-cell"><input type="text" data-field="answer" value="${esc(item.answer)}" /></td>
        <td class="muted">${esc(item.source || '—')}</td>
        <td class="row-actions">
          <button class="tool-btn primary" data-action="saveQuestion" data-arg="${item.id}">Save</button>
          <button class="tool-btn" data-action="cancelEditQuestion">Cancel</button>
        </td>
      </tr>
    `;
  }
  return `
    <tr data-id="${item.id}">
      <td class="q-cell">${esc(item.question)}</td>
      <td class="a-cell">${esc(item.answer)}</td>
      <td class="muted">${esc(item.source || '—')}</td>
      <td class="row-actions">
        <button class="tool-btn" data-action="editQuestion" data-arg="${item.id}">Edit</button>
        <button class="tool-btn danger" data-action="deleteQuestion" data-arg="${item.id}">Delete</button>
      </td>
    </tr>
  `;
}

function moderationView() {
  const m = state.moderation;
  const start = m.total === 0 ? 0 : m.offset + 1;
  const end = Math.min(m.offset + m.limit, m.total);

  let listHtml;
  if (m.loading) {
    listHtml = `<div class="tool-empty tool-empty--loading">Loading…</div>`;
  } else if (m.items.length === 0) {
    listHtml = `<div class="tool-empty">No pending submissions</div>`;
  } else {
    const batchCounts = {};
    m.items.forEach((it) => {
      if (it.batchId) batchCounts[it.batchId] = (batchCounts[it.batchId] || 0) + 1;
    });
    let lastBatch = null;
    listHtml = m.items.map((item) => {
      let divider = '';
      if (item.batchId && item.batchId !== lastBatch && batchCounts[item.batchId] > 1) {
        divider = `<div class="tool-batch-divider">Submitted together</div>`;
      }
      lastBatch = item.batchId || null;
      return divider + submissionHtml(item);
    }).join('');
  }

  return `
    <div class="tool-card">
      <h2>Pending submissions</h2>
      ${m.error ? `<div class="tool-error">${esc(m.error)}</div>` : ''}
      ${listHtml}
      <div class="tool-pagination">
        <button data-action="mPrev" ${(m.offset <= 0 || m.loading) ? 'disabled' : ''}>Prev</button>
        <span>Showing ${start}–${end} of ${m.total}</span>
        <button data-action="mNext" ${((m.offset + m.limit) >= m.total || m.loading) ? 'disabled' : ''}>Next</button>
      </div>
    </div>
  `;
}

function submissionHtml(item) {
  const editing = state.moderation.editingId === item.id;
  const submitter = item.submitterName ? `Submitted by: ${esc(item.submitterName)}` : 'Anonymous';
  const noteHtml = item.note ? `<div class="muted" style="margin-top:2px;">Note: ${esc(item.note)}</div>` : '';

  const actionsHtml = editing ? `
      <div class="tool-form">
        <label>Question</label>
        <input type="text" data-field="edit-question" value="${esc(item.question)}" />
        <label>Answer</label>
        <input type="text" data-field="edit-answer" value="${esc(item.answer)}" />
      </div>
      <div class="tool-btn-row">
        <button class="tool-btn primary" data-action="confirmEditApprove" data-arg="${item.id}">Confirm &amp; approve</button>
        <button class="tool-btn" data-action="cancelEditApprove">Cancel</button>
      </div>
    ` : `
      <div class="tool-btn-row">
        <button class="tool-btn primary" data-action="approveSubmission" data-arg="${item.id}">Approve</button>
        <button class="tool-btn blue" data-action="editApprove" data-arg="${item.id}">Edit &amp; approve</button>
        <input type="text" class="admin-inline-input" placeholder="Reason (optional)" data-field="reject-reason" />
        <button class="tool-btn danger" data-action="rejectSubmission" data-arg="${item.id}">Reject</button>
      </div>
    `;

  return `
    <div class="admin-submission${editing ? ' editing' : ''}" data-id="${item.id}">
      <div><strong>${esc(item.question)}</strong></div>
      <div class="a-cell">${esc(item.answer)}</div>
      <div class="muted" style="margin-top:6px;">${submitter}</div>
      ${noteHtml}
      ${actionsHtml}
    </div>
  `;
}

// --- data loading ----------------------------------------------------------------------

function isUnauthorized(err) {
  if (err && err.status === 401) {
    state.view = 'login';
    render();
    return true;
  }
  return false;
}

function loadQuestions() {
  const q = state.questions;
  q.loading = true;
  render();
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  params.set('limit', String(q.limit));
  params.set('offset', String(q.offset));
  api.get('/api/admin/questions?' + params.toString())
    .then((data) => {
      q.loading = false;
      q.items = (data && data.items) || [];
      q.total = (data && data.total) || 0;
      render();
    })
    .catch((err) => {
      q.loading = false;
      if (isUnauthorized(err)) return;
      q.error = err.message || 'Failed to load questions.';
      render();
    });
}

function loadModeration() {
  const m = state.moderation;
  m.loading = true;
  render();
  const params = new URLSearchParams();
  params.set('status', 'pending');
  params.set('limit', String(m.limit));
  params.set('offset', String(m.offset));
  api.get('/api/admin/submissions?' + params.toString())
    .then((data) => {
      m.loading = false;
      m.items = (data && data.items) || [];
      m.total = (data && data.total) || 0;
      render();
    })
    .catch((err) => {
      m.loading = false;
      if (isUnauthorized(err)) return;
      m.error = err.message || 'Failed to load submissions.';
      render();
    });
}

function loadPendingCount() {
  api.get('/api/admin/submissions?status=pending&limit=1')
    .then((data) => {
      state.pendingCount = (data && data.total) || 0;
      render();
    })
    .catch((err) => {
      isUnauthorized(err);
      // Otherwise non-fatal — just leave the badge as it was.
    });
}

function removeSubmissionLocally(id) {
  const m = state.moderation;
  m.items = m.items.filter((it) => it.id !== id);
  m.total = Math.max(0, m.total - 1);
  if (m.editingId === id) m.editingId = null;
  if (m.items.length === 0 && m.offset > 0) {
    m.offset = Math.max(0, m.offset - m.limit);
    loadModeration();
  } else {
    render();
  }
}

function rowInputValue(id, field) {
  const row = document.querySelector(`[data-id="${id}"]`);
  if (!row) return '';
  const input = row.querySelector(`[data-field="${field}"]`);
  return input ? input.value : '';
}

// --- actions (click delegation) ---------------------------------------------------------

const Actions = {
  showQuestions() {
    state.view = 'questions';
    render();
    loadQuestions();
  },

  showModeration() {
    state.view = 'moderation';
    render();
    loadModeration();
  },

  logout() {
    api.post('/api/admin/logout', {})
      .catch(() => {})
      .then(() => {
        state.view = 'login';
        state.loginError = '';
        render();
      });
  },

  qPrev() {
    const q = state.questions;
    if (q.offset <= 0) return;
    q.offset = Math.max(0, q.offset - q.limit);
    loadQuestions();
  },

  qNext() {
    const q = state.questions;
    if (q.offset + q.limit >= q.total) return;
    q.offset += q.limit;
    loadQuestions();
  },

  editQuestion(id) {
    state.questions.editingId = Number(id);
    render();
  },

  cancelEditQuestion() {
    state.questions.editingId = null;
    render();
  },

  saveQuestion(id) {
    const question = rowInputValue(id, 'question').trim();
    const answer = rowInputValue(id, 'answer').trim();
    if (!question || !answer) return;
    api.put(`/api/admin/questions/${id}`, { question, answer })
      .then(() => {
        state.questions.editingId = null;
        loadQuestions();
      })
      .catch((err) => {
        if (isUnauthorized(err)) return;
        state.questions.error = err.message || 'Failed to save question.';
        render();
      });
  },

  deleteQuestion(id) {
    if (!confirm('Delete this question?')) return;
    api.del(`/api/admin/questions/${id}`)
      .then(() => loadQuestions())
      .catch((err) => {
        if (isUnauthorized(err)) return;
        state.questions.error = err.message || 'Failed to delete question.';
        render();
      });
  },

  mPrev() {
    const m = state.moderation;
    if (m.offset <= 0) return;
    m.offset = Math.max(0, m.offset - m.limit);
    loadModeration();
  },

  mNext() {
    const m = state.moderation;
    if (m.offset + m.limit >= m.total) return;
    m.offset += m.limit;
    loadModeration();
  },

  approveSubmission(id) {
    api.post(`/api/admin/submissions/${id}/approve`, {})
      .then(() => {
        removeSubmissionLocally(Number(id));
        loadPendingCount();
      })
      .catch((err) => {
        if (isUnauthorized(err)) return;
        state.moderation.error = err.message || 'Failed to approve submission.';
        render();
      });
  },

  editApprove(id) {
    state.moderation.editingId = Number(id);
    render();
  },

  cancelEditApprove() {
    state.moderation.editingId = null;
    render();
  },

  confirmEditApprove(id) {
    const question = rowInputValue(id, 'edit-question').trim();
    const answer = rowInputValue(id, 'edit-answer').trim();
    if (!question || !answer) return;
    api.post(`/api/admin/submissions/${id}/approve`, { question, answer })
      .then(() => {
        state.moderation.editingId = null;
        removeSubmissionLocally(Number(id));
        loadPendingCount();
      })
      .catch((err) => {
        if (isUnauthorized(err)) return;
        state.moderation.error = err.message || 'Failed to approve submission.';
        render();
      });
  },

  rejectSubmission(id) {
    const reason = rowInputValue(id, 'reject-reason').trim();
    api.post(`/api/admin/submissions/${id}/reject`, reason ? { reason } : {})
      .then(() => {
        removeSubmissionLocally(Number(id));
        loadPendingCount();
      })
      .catch((err) => {
        if (isUnauthorized(err)) return;
        state.moderation.error = err.message || 'Failed to reject submission.';
        render();
      });
  },
};

// --- forms (submit delegation) -----------------------------------------------------------

const Forms = {
  login(form) {
    const password = form.querySelector('[name="password"]').value;
    state.loginBusy = true;
    state.loginError = '';
    render();
    api.post('/api/admin/login', { password })
      .then(() => {
        state.loginBusy = false;
        state.view = 'questions';
        render();
        loadPendingCount();
        loadQuestions();
      })
      .catch((err) => {
        state.loginBusy = false;
        state.loginError = err.status === 401 ? 'Incorrect password.' : (err.message || 'Login failed.');
        render();
      });
  },

  addQuestion(form) {
    const question = form.querySelector('[name="question"]').value;
    const answer = form.querySelector('[name="answer"]').value;
    const q = state.questions;
    q.addQuestion = question;
    q.addAnswer = answer;
    q.addError = '';
    if (!question.trim() || !answer.trim()) {
      q.addError = 'Question and answer are required.';
      render();
      return;
    }
    api.post('/api/admin/questions', { question: question.trim(), answer: answer.trim() })
      .then(() => {
        q.addQuestion = '';
        q.addAnswer = '';
        loadQuestions();
      })
      .catch((err) => {
        if (isUnauthorized(err)) return;
        q.addError = err.message || 'Failed to add question.';
        render();
      });
  },

  bulkImport(form) {
    const text = form.querySelector('[name="text"]').value;
    const q = state.questions;
    q.bulkText = text;
    q.bulkMessage = '';
    q.bulkError = '';
    if (!text.trim()) {
      q.bulkError = 'Paste some questions first.';
      render();
      return;
    }
    api.post('/api/admin/questions/bulk', { text })
      .then((data) => {
        q.bulkText = '';
        q.bulkMessage = `Imported ${data && typeof data.imported === 'number' ? data.imported : 0} questions.`;
        loadQuestions();
      })
      .catch((err) => {
        if (isUnauthorized(err)) return;
        q.bulkError = err.message || 'Import failed.';
        render();
      });
  },
};

// --- global delegated event listeners ----------------------------------------------------

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  const action = el.getAttribute('data-action');
  const arg = el.getAttribute('data-arg');
  const fn = Actions[action];
  if (typeof fn === 'function') fn(arg, el);
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const name = form.getAttribute('data-form');
  const fn = Forms[name];
  if (typeof fn === 'function') fn(form);
});

let searchDebounceTimer = null;
document.addEventListener('input', (e) => {
  const el = e.target;
  const bind = el.getAttribute && el.getAttribute('data-bind');
  if (bind === 'search') {
    state.questions.search = el.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.questions.offset = 0;
      loadQuestions();
    }, 300);
  }
});

// --- bootstrap -----------------------------------------------------------------------------

function init() {
  api.get('/api/admin/me')
    .then(() => {
      state.view = 'questions';
      render();
      loadPendingCount();
      loadQuestions();
    })
    .catch(() => {
      state.view = 'login';
      render();
    });
}

init();
