'use strict';
/* app.js — frontend logic: auth, prompt submission, live queue + gallery. */

const $ = (sel) => document.querySelector(sel);
const authView = $('#auth-view');
const appView = $('#app-view');

let authMode = 'login'; // or 'signup'

/* ---------- tiny API helper (cookies carry the session) ---------- */
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/signup')) {
    showAuth(); // session expired
    throw new Error('signed out');
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

/* ---------- auth ---------- */
function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-signup').classList.toggle('active', mode === 'signup');
  $('#auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('#auth-error').classList.add('hidden');
  // Extra profile fields only exist on the signup tab.
  $('#signup-fields').classList.toggle('hidden', mode !== 'signup');
  $('#auth-firstname').required = mode === 'signup';
  // Use the right autocomplete hint for the password field per tab.
  $('#auth-password').setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
}
$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-signup').onclick = () => setAuthMode('signup');

// Password visibility toggle (the "eye" button).
$('#toggle-password').onclick = () => {
  const input = $('#auth-password');
  const btn = $('#toggle-password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  btn.setAttribute('title', show ? 'Hide password' : 'Show password');
};

function showAuth() {
  authView.classList.remove('hidden');
  appView.classList.add('hidden');
  stopPolling();
}
function showApp(user) {
  authView.classList.add('hidden');
  appView.classList.remove('hidden');
  $('#user-email').textContent = user.first_name ? `Hi, ${user.first_name}` : user.email;
  refreshJobs();
  startPolling();
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#auth-error');
  err.classList.add('hidden');
  try {
    const body = {
      email: $('#auth-email').value,
      password: $('#auth-password').value,
    };
    if (authMode === 'signup') {
      body.firstName = $('#auth-firstname').value.trim();
      body.lastName = $('#auth-lastname').value.trim();
      body.gender = $('#auth-gender').value;
    }
    const user = await api(authMode === 'login' ? '/api/login' : '/api/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    $('#auth-password').value = '';
    showApp(user);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

$('#logout-btn').onclick = async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  showAuth();
};

/* ---------- prompt form ---------- */
$('#prompt-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#prompt-error');
  err.classList.add('hidden');

  const formData = new FormData();
  formData.append('prompt', $('#prompt-input').value.trim());
  formData.append('format', document.querySelector('input[name="format"]:checked').value);
  const file = $('#image-input').files[0];
  if (file) formData.append('image', file);

  try {
    await api('/api/jobs', { method: 'POST', body: formData });
    $('#prompt-input').value = '';
    $('#image-input').value = '';
    refreshJobs();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.remove('hidden');
  }
});

/* ---------- jobs: queue + gallery ---------- */
const fmtBadge = { '9:16': '📱 9:16', '1:1': '⬛ 1:1', '16:9': '🖥️ 16:9' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (iso) => new Date(iso + 'Z').toLocaleString();

function jobCard(job) {
  const active = job.status === 'pending' || job.status === 'processing';
  const statusHtml = active && job.status === 'processing'
    ? `<span class="status processing"><span class="spinner"></span>processing</span>`
    : `<span class="status ${job.status}">${job.status}</span>`;

  let body = `
    <div class="job">
      <div class="job-top">
        <span class="badge">${fmtBadge[job.format] || esc(job.format)}</span>
        ${statusHtml}
      </div>
      <div class="job-prompt">${esc(job.prompt)}</div>
      <div class="job-meta">${when(job.createdAt)}${job.hasRefImage ? ' · 🖼️ reference image' : ''}</div>`;

  if (job.status === 'done') {
    body += `
      <video controls preload="metadata" src="/api/media/${job.id}"></video>
      <div class="job-actions">
        <a class="btn small" href="/api/media/${job.id}" download="video-${job.id}.mp4">⬇ Download</a>
        <button class="btn danger" data-del="${job.id}" type="button">Delete</button>
      </div>`;
  } else if (job.status === 'failed') {
    body += `
      <div class="job-error">⚠ ${esc(job.error || 'Generation failed')}</div>
      <div class="job-actions">
        <button class="btn small" data-retry="${job.id}" type="button">↻ Retry</button>
        <button class="btn danger" data-del="${job.id}" type="button">Delete</button>
      </div>`;
  } else {
    body += `
      <div class="job-actions">
        <button class="btn danger" data-del="${job.id}" type="button">Cancel</button>
      </div>`;
  }
  return body + '</div>';
}

async function refreshJobs() {
  try {
    const jobs = await api('/api/jobs');
    const queued = jobs.filter((j) => j.status === 'pending' || j.status === 'processing');
    const finished = jobs.filter((j) => j.status === 'done' || j.status === 'failed');

    $('#queue-count').textContent = queued.length ? `(${queued.length})` : '';
    $('#gallery-count').textContent = finished.length ? `(${finished.length})` : '';
    $('#queue-list').innerHTML = queued.length
      ? queued.map(jobCard).join('')
      : '<p class="empty">Nothing in the queue.</p>';
    $('#gallery-list').innerHTML = finished.length
      ? finished.map(jobCard).join('')
      : '<p class="empty">Your finished videos will appear here.</p>';
  } catch (ex) {
    if (ex.message !== 'signed out') console.error(ex);
  }
}

document.addEventListener('click', async (e) => {
  const retry = e.target.dataset.retry;
  const del = e.target.dataset.del;
  try {
    if (retry) await api(`/api/jobs/${retry}/retry`, { method: 'POST' });
    if (del) {
      if (!confirm('Delete this job and its video?')) return;
      await api(`/api/jobs/${del}`, { method: 'DELETE' });
    }
    if (retry || del) refreshJobs();
  } catch (ex) {
    alert(ex.message);
  }
});

/* Poll while there is anything in flight; also refreshes right after submit. */
let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(refreshJobs, 3000);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/* ---------- boot ---------- */
(async () => {
  try {
    const me = await api('/api/me');
    showApp(me);
  } catch {
    showAuth();
  }
})();
