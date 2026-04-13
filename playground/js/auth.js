/**
 * Auth UI for the playground: checks authentication status, exposes the
 * current user's role to the rest of the app, and wires up logout +
 * "Add Device" (invitation) + user-management actions in Settings.
 *
 * Read-only users see the Settings card collapsed to the logout button —
 * invitation creation and user management are admin-only.
 */
import qrcode from 'qrcode-generator';
import { store } from './app-state.js';

let inviteCountdown = null;
let currentRole = null;
let currentName = null;
let currentUserId = null;

// Subscribers notified whenever the role is resolved or changes.
const roleListeners = new Set();

function $(id) {
  return document.getElementById(id);
}

export function getCurrentRole() {
  return currentRole;
}

export function isReadOnly() {
  return currentRole === 'readonly';
}

export function onRoleChange(listener) {
  roleListeners.add(listener);
  // Fire immediately if we already know the role
  if (currentRole !== null) listener(currentRole);
  return () => roleListeners.delete(listener);
}

function setRole(role, name) {
  const changed = currentRole !== role;
  currentRole = role;
  currentName = name || null;
  if (changed) {
    document.body.dataset.role = role || '';
    // Push the role into the app store so derived.availableViews and any
    // navigation subscribers can react.
    store.set('userRole', role || 'admin');
    roleListeners.forEach(fn => {
      try { fn(role); } catch (e) { /* noop */ }
    });
  }
}

export async function initAuth() {
  const authActions = $('auth-actions');
  const logoutBtn = $('logout-btn');
  const inviteBtn = $('invite-btn');
  const inviteModal = $('invite-modal');
  const inviteBackdrop = $('invite-modal-backdrop');
  const inviteCloseBtn = $('invite-close-btn');

  if (logoutBtn) logoutBtn.addEventListener('click', doLogout);
  if (inviteBtn) inviteBtn.addEventListener('click', openCreateInviteForm);
  if (inviteCloseBtn) inviteCloseBtn.addEventListener('click', closeInviteModal);
  if (inviteBackdrop) inviteBackdrop.addEventListener('click', closeInviteModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inviteModal && !inviteModal.hidden) {
      closeInviteModal();
    }
  });

  const createBtn = $('invite-create-btn');
  if (createBtn) createBtn.addEventListener('click', doCreateInvite);

  const refreshBtn = $('users-refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshUsers);

  try {
    const res = await fetch('/auth/status');
    if (!res.ok) {
      // Auth disabled (404). Treat as full admin so all UI shows up.
      setRole('admin', null);
      return;
    }
    const data = await res.json();
    if (data.authenticated) {
      currentUserId = null;
      setRole(data.role || 'admin', data.name || null);
      if (authActions) authActions.hidden = false;
      applyRoleVisibility();
      if (currentRole === 'admin') {
        refreshUsers();
      }
    } else {
      // Not authenticated and auth IS enabled — initAuth shouldn't normally
      // be called in that case (server redirects), but keep things safe.
      setRole('admin', null);
    }
  } catch (err) {
    // Network error / auth unreachable — assume admin so the playground
    // is still usable in offline/local mode.
    setRole('admin', null);
  }
}

// CSS handles `[data-admin-only]` visibility off the body[data-role]
// attribute set by setRole(); this hook stays available for any future
// programmatic toggles.
function applyRoleVisibility() {
  // no-op: see body[data-role="readonly"] [data-admin-only] in style.css
}

async function doLogout() {
  const logoutBtn = $('logout-btn');
  if (logoutBtn) logoutBtn.disabled = true;
  try {
    const res = await fetch('/auth/logout', { method: 'POST' });
    if (res.ok || res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    console.error('Logout failed:', res.status);
    alert('Logout failed — please try again.');
  } catch (err) {
    console.error('Logout network error:', err);
    alert('Logout failed — network error.');
  } finally {
    if (logoutBtn) logoutBtn.disabled = false;
  }
}

function openCreateInviteForm() {
  openInviteModal();
  showInviteForm();
}

function showInviteForm() {
  const form = $('invite-form');
  const result = $('invite-result');
  if (form) form.hidden = false;
  if (result) result.hidden = true;
  const nameInput = $('invite-name-input');
  if (nameInput) {
    nameInput.value = '';
    setTimeout(() => nameInput.focus(), 60);
  }
  const err = $('invite-error');
  if (err) { err.hidden = true; err.textContent = ''; }
}

async function doCreateInvite() {
  const nameInput = $('invite-name-input');
  const roleSelect = $('invite-role-select');
  const createBtn = $('invite-create-btn');
  if (!nameInput || !roleSelect) return;

  const name = nameInput.value.trim();
  if (!name) {
    showInviteError('Name is required');
    return;
  }

  if (createBtn) createBtn.disabled = true;
  try {
    const res = await fetch('/auth/invite/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, role: roleSelect.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showInviteError(err.error || 'Failed to create invitation (HTTP ' + res.status + ')');
      return;
    }
    const data = await res.json();
    showInviteResult(data.code, data.expiresInSeconds, data.role, data.name);
  } catch (err) {
    showInviteError('Network error: ' + err.message);
  } finally {
    if (createBtn) createBtn.disabled = false;
  }
}

function showInviteResult(code, expiresInSeconds, role, name) {
  const form = $('invite-form');
  const result = $('invite-result');
  if (form) form.hidden = true;
  if (result) result.hidden = false;
  renderInvite(code, expiresInSeconds);
  const summary = $('invite-summary');
  if (summary) {
    summary.textContent = name + ' (' + (role === 'readonly' ? 'read-only' : 'admin') + ')';
  }
}

function openInviteModal() {
  const modal = $('invite-modal');
  if (modal) modal.hidden = false;
}

function closeInviteModal() {
  const modal = $('invite-modal');
  if (modal) modal.hidden = true;
  if (inviteCountdown) {
    clearInterval(inviteCountdown);
    inviteCountdown = null;
  }
  // Clear the code/qr so a new invite starts clean
  const code = $('invite-code');
  if (code) code.textContent = '';
  const timer = $('invite-timer');
  if (timer) {
    timer.textContent = '';
    timer.className = 'invite-timer';
  }
  const qr = $('invite-qr');
  if (qr) {
    const ctx = qr.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, qr.width, qr.height);
    qr.width = 0;
    qr.height = 0;
  }
  const err = $('invite-error');
  if (err) {
    err.hidden = true;
    err.textContent = '';
  }
}

function showInviteError(message) {
  const err = $('invite-error');
  if (err) {
    err.textContent = message;
    err.hidden = false;
  }
}

function renderInvite(code, expiresInSeconds) {
  const codeEl = $('invite-code');
  const qrCanvas = $('invite-qr');
  if (codeEl) codeEl.textContent = code;

  // Build QR pointing at the invitation URL
  const qr = qrcode(0, 'M');
  qr.addData(window.location.origin + '/login.html?invite=' + code);
  qr.make();
  const cellSize = 4;
  const margin = 8;
  const size = qr.getModuleCount() * cellSize + margin * 2;
  qrCanvas.width = size;
  qrCanvas.height = size;
  const ctx = qrCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < qr.getModuleCount(); row++) {
    for (let col = 0; col < qr.getModuleCount(); col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(col * cellSize + margin, row * cellSize + margin, cellSize, cellSize);
      }
    }
  }

  // Countdown timer
  let remaining = expiresInSeconds;
  updateInviteTimer(remaining);
  if (inviteCountdown) clearInterval(inviteCountdown);
  inviteCountdown = setInterval(() => {
    remaining--;
    updateInviteTimer(remaining);
    if (remaining <= 0) {
      closeInviteModal();
    }
  }, 1000);
}

function updateInviteTimer(seconds) {
  const timer = $('invite-timer');
  if (!timer) return;
  if (seconds < 0) seconds = 0;
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  timer.textContent = 'Expires in ' + min + ':' + (sec < 10 ? '0' : '') + sec;
  timer.className = seconds <= 30 ? 'invite-timer expiring' : 'invite-timer';
}

// ── User management ──

async function refreshUsers() {
  const list = $('users-list');
  if (!list) return;
  list.innerHTML = '<div class="users-loading">Loading…</div>';
  try {
    const res = await fetch('/auth/users');
    if (!res.ok) {
      list.innerHTML = '<div class="users-error">Failed to load users (HTTP ' + res.status + ')</div>';
      return;
    }
    const data = await res.json();
    renderUsers(data.users || []);
  } catch (err) {
    list.innerHTML = '<div class="users-error">Network error: ' + err.message + '</div>';
  }
}

function renderUsers(users) {
  const list = $('users-list');
  if (!list) return;
  if (users.length === 0) {
    list.innerHTML = '<div class="users-empty">No users.</div>';
    return;
  }
  list.innerHTML = '';
  users.forEach(u => list.appendChild(buildUserRow(u)));
}

function buildUserRow(u) {
  const row = document.createElement('div');
  row.className = 'user-row';
  row.dataset.userId = u.id;

  const info = document.createElement('div');
  info.className = 'user-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'user-name';
  nameEl.textContent = u.name + (u.isCurrent ? ' (you)' : '');
  info.appendChild(nameEl);

  const meta = document.createElement('div');
  meta.className = 'user-meta';
  const passkeyLabel = u.credentialCount === 1 ? '1 passkey' : (u.credentialCount + ' passkeys');
  meta.textContent = passkeyLabel;
  info.appendChild(meta);

  row.appendChild(info);

  const badge = document.createElement('span');
  badge.className = 'user-role-badge user-role-' + u.role;
  badge.textContent = u.role === 'readonly' ? 'Read-only' : 'Admin';
  badge.title = u.isCurrent ? 'You cannot change your own role' : 'Click to toggle role';
  if (!u.isCurrent) {
    badge.classList.add('user-role-clickable');
    badge.addEventListener('click', () => toggleRole(u));
  }
  row.appendChild(badge);

  const edit = document.createElement('button');
  edit.className = 'user-edit-btn';
  edit.title = 'Rename user';
  edit.innerHTML = '<span class="material-symbols-outlined">edit</span>';
  edit.addEventListener('click', () => renameUser(u));
  row.appendChild(edit);

  if (!u.isCurrent) {
    const del = document.createElement('button');
    del.className = 'user-delete-btn';
    del.title = 'Delete user';
    del.innerHTML = '<span class="material-symbols-outlined">delete</span>';
    del.addEventListener('click', () => deleteUser(u));
    row.appendChild(del);
  }

  return row;
}

async function patchUser(user, updates, confirmMessage) {
  if (confirmMessage && !confirm(confirmMessage)) return false;
  try {
    const res = await fetch('/auth/users/' + encodeURIComponent(user.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || ('Failed to update user (HTTP ' + res.status + ')'));
      return false;
    }
    return true;
  } catch (err) {
    alert('Network error: ' + err.message);
    return false;
  }
}

async function renameUser(user) {
  const next = prompt('Rename "' + user.name + '" to:', user.name);
  if (next === null) return;
  const trimmed = next.trim();
  if (!trimmed || trimmed === user.name) return;
  const ok = await patchUser(user, { name: trimmed });
  if (ok) refreshUsers();
}

async function toggleRole(user) {
  const next = user.role === 'admin' ? 'readonly' : 'admin';
  const label = next === 'admin' ? 'Admin' : 'Read-only';
  const ok = await patchUser(user, { role: next }, 'Change ' + user.name + '\u2019s role to ' + label + '?');
  if (ok) refreshUsers();
}

async function deleteUser(user) {
  if (!confirm('Delete user "' + user.name + '"? This will revoke all their passkeys.')) return;
  try {
    const res = await fetch('/auth/users/' + encodeURIComponent(user.id), { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || ('Failed to delete user (HTTP ' + res.status + ')'));
      return;
    }
    refreshUsers();
  } catch (err) {
    alert('Network error: ' + err.message);
  }
}
