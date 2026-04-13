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
let currentCredentialId = null;
let usersCache = [];
let editingUserId = null;
let editingPasskeyId = null;
let confirmingUserDeleteId = null;
let confirmingPasskeyDeleteId = null;
let creatingUser = false;

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
  const newUserBtn = $('users-new-btn');
  if (newUserBtn) newUserBtn.addEventListener('click', openCreateUserForm);
  const createUserSaveBtn = $('users-create-save-btn');
  if (createUserSaveBtn) createUserSaveBtn.addEventListener('click', createEmptyUser);
  const createUserCancelBtn = $('users-create-cancel-btn');
  if (createUserCancelBtn) createUserCancelBtn.addEventListener('click', closeCreateUserForm);

  try {
    const res = await fetch('/auth/status');
    if (!res.ok) {
      // Auth disabled (404). Treat as full admin so all UI shows up.
      setRole('admin', null);
      return;
    }
    const data = await res.json();
    if (data.authenticated) {
      currentUserId = data.userId || null;
      currentCredentialId = data.credentialId || null;
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
      window.location.href = '/public/login.html';
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
  qr.addData(window.location.origin + '/public/login.html?invite=' + code);
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
    usersCache = data.users || [];
    renderUsers(usersCache);
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
  users.forEach(u => list.appendChild(buildUserCard(u, users)));
}

function buildUserCard(user, allUsers) {
  const card = document.createElement('div');
  card.className = 'user-card';
  card.dataset.userId = user.id;

  const row = document.createElement('div');
  row.className = 'user-row';
  const info = document.createElement('div');
  info.className = 'user-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'user-name';
  nameEl.textContent = user.name + (user.isCurrent ? ' (you)' : '');
  info.appendChild(nameEl);

  const meta = document.createElement('div');
  meta.className = 'user-meta';
  const passkeyLabel = user.credentialCount === 1 ? '1 passkey' : (user.credentialCount + ' passkeys');
  meta.textContent = passkeyLabel + (user.createdAt ? ' · added ' + formatWhen(user.createdAt) : '');
  info.appendChild(meta);

  row.appendChild(info);

  const badge = document.createElement('span');
  badge.className = 'user-role-badge user-role-' + user.role;
  badge.textContent = user.role === 'readonly' ? 'Read-only' : 'Admin';
  row.appendChild(badge);

  const edit = document.createElement('button');
  edit.className = 'user-edit-btn';
  edit.title = 'Edit user';
  edit.innerHTML = '<span class="material-symbols-outlined">edit</span>';
  edit.addEventListener('click', () => {
    editingPasskeyId = null;
    confirmingUserDeleteId = null;
    confirmingPasskeyDeleteId = null;
    editingUserId = editingUserId === user.id ? null : user.id;
    renderUsers(usersCache);
  });
  row.appendChild(edit);

  if (!user.isCurrent) {
    const del = document.createElement('button');
    del.className = 'user-delete-btn';
    del.title = 'Delete user';
    del.innerHTML = '<span class="material-symbols-outlined">delete</span>';
    del.addEventListener('click', () => {
      editingPasskeyId = null;
      editingUserId = null;
      confirmingPasskeyDeleteId = null;
      confirmingUserDeleteId = confirmingUserDeleteId === user.id ? null : user.id;
      renderUsers(usersCache);
    });
    row.appendChild(del);
  }

  card.appendChild(row);

  if (editingUserId === user.id) {
    card.appendChild(buildUserEditor(user));
  }
  if (confirmingUserDeleteId === user.id) {
    card.appendChild(buildDangerConfirm(
      'Delete user "' + user.name + '"? All of their passkeys and active sessions will be revoked.',
      () => deleteUser(user),
      () => {
        confirmingUserDeleteId = null;
        renderUsers(usersCache);
      }
    ));
  }

  const devices = document.createElement('div');
  devices.className = 'user-devices';
  const devicesHeader = document.createElement('div');
  devicesHeader.className = 'user-devices-header';
  devicesHeader.textContent = 'Devices';
  devices.appendChild(devicesHeader);

  if (!user.passkeys || user.passkeys.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'passkey-empty';
    empty.textContent = 'No passkeys assigned.';
    devices.appendChild(empty);
  } else {
    user.passkeys.forEach(passkey => {
      devices.appendChild(buildPasskeyRow(passkey, allUsers));
      if (editingPasskeyId === passkey.id) {
        devices.appendChild(buildPasskeyEditor(passkey, allUsers));
      }
      if (confirmingPasskeyDeleteId === passkey.id) {
        devices.appendChild(buildDangerConfirm(
          'Revoke "' + getPasskeyLabel(passkey) + '"? That device will lose access immediately.',
          () => deletePasskey(passkey),
          () => {
            confirmingPasskeyDeleteId = null;
            renderUsers(usersCache);
          }
        ));
      }
    });
  }

  card.appendChild(devices);
  return card;
}

function buildUserEditor(user) {
  const editor = document.createElement('div');
  editor.className = 'users-inline-editor user-inline-editor';
  editor.innerHTML =
    '<div class="users-inline-grid">' +
      '<label class="users-field"><span>Name</span><input type="text" class="invite-text-input" maxlength="64" data-field="name"></label>' +
      '<label class="users-field"><span>Role</span><select class="invite-select" data-field="role">' +
        '<option value="readonly">Read-only</option>' +
        '<option value="admin">Admin</option>' +
      '</select></label>' +
    '</div>' +
    '<div class="users-inline-actions">' +
      '<button class="auth-btn auth-btn-primary" type="button" data-action="save">Save</button>' +
      '<button class="auth-btn" type="button" data-action="cancel">Cancel</button>' +
    '</div>';
  const nameInput = editor.querySelector('[data-field="name"]');
  const roleSelect = editor.querySelector('[data-field="role"]');
  nameInput.value = user.name;
  roleSelect.value = user.role;
  if (user.isCurrent) roleSelect.disabled = true;
  editor.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const updates = {};
    const nextName = nameInput.value.trim();
    const nextRole = roleSelect.value;
    if (nextName !== user.name) updates.name = nextName;
    if (!user.isCurrent && nextRole !== user.role) updates.role = nextRole;
    if (!Object.keys(updates).length) {
      editingUserId = null;
      renderUsers(usersCache);
      return;
    }
    const ok = await patchUser(user, updates);
    if (ok) {
      editingUserId = null;
      refreshUsers();
    }
  });
  editor.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    editingUserId = null;
    renderUsers(usersCache);
  });
  return editor;
}

function buildPasskeyRow(passkey) {
  const row = document.createElement('div');
  row.className = 'passkey-row';

  const label = document.createElement('div');
  label.className = 'passkey-label';
  label.textContent = getPasskeyLabel(passkey) + (passkey.isCurrent ? ' (this device)' : '');
  row.appendChild(label);

  const subtitle = document.createElement('div');
  subtitle.className = 'passkey-subtitle';
  subtitle.textContent = passkey.deviceSummary || 'Unknown device';
  row.appendChild(subtitle);

  const meta = document.createElement('div');
  meta.className = 'passkey-meta';
  const parts = [];
  if (passkey.lastUsedAt) parts.push('Last seen ' + formatWhen(passkey.lastUsedAt));
  if (passkey.lastIp) parts.push('IP ' + passkey.lastIp);
  if (passkey.createdAt) parts.push('Added ' + formatWhen(passkey.createdAt));
  meta.textContent = parts.join(' · ');
  row.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'passkey-actions';

  const edit = document.createElement('button');
  edit.className = 'user-edit-btn';
  edit.type = 'button';
  edit.title = 'Edit device';
  edit.innerHTML = '<span class="material-symbols-outlined">edit</span>';
  edit.addEventListener('click', () => {
    editingUserId = null;
    confirmingPasskeyDeleteId = null;
    confirmingUserDeleteId = null;
    editingPasskeyId = editingPasskeyId === passkey.id ? null : passkey.id;
    renderUsers(usersCache);
  });
  actions.appendChild(edit);

  const del = document.createElement('button');
  del.className = 'user-delete-btn';
  del.type = 'button';
  del.title = 'Revoke device';
  del.innerHTML = '<span class="material-symbols-outlined">delete</span>';
  del.addEventListener('click', () => {
    editingPasskeyId = null;
    editingUserId = null;
    confirmingUserDeleteId = null;
    confirmingPasskeyDeleteId = confirmingPasskeyDeleteId === passkey.id ? null : passkey.id;
    renderUsers(usersCache);
  });
  actions.appendChild(del);

  row.appendChild(actions);
  return row;
}

function buildPasskeyEditor(passkey, allUsers) {
  const editor = document.createElement('div');
  editor.className = 'users-inline-editor inline-passkey-editor';
  editor.innerHTML =
    '<div class="users-inline-grid">' +
      '<label class="users-field"><span>Device label</span><input type="text" class="invite-text-input" maxlength="80" data-field="label"></label>' +
      '<label class="users-field"><span>Owner</span><select class="invite-select" data-field="userId"></select></label>' +
    '</div>' +
    '<div class="users-inline-actions">' +
      '<button class="auth-btn auth-btn-primary" type="button" data-action="save">Save</button>' +
      '<button class="auth-btn" type="button" data-action="cancel">Cancel</button>' +
    '</div>';
  const labelInput = editor.querySelector('[data-field="label"]');
  const userSelect = editor.querySelector('[data-field="userId"]');
  labelInput.value = passkey.label || passkey.deviceName || '';
  allUsers.forEach(user => {
    const option = document.createElement('option');
    option.value = user.id;
    option.textContent = user.name + ' (' + (user.role === 'readonly' ? 'read-only' : 'admin') + ')';
    if (user.id === passkey.userId) option.selected = true;
    userSelect.appendChild(option);
  });
  editor.querySelector('[data-action="save"]').addEventListener('click', async () => {
    const updates = {};
    if (labelInput.value.trim() !== (passkey.label || '')) updates.label = labelInput.value.trim();
    if (userSelect.value !== passkey.userId) updates.userId = userSelect.value;
    if (!Object.keys(updates).length) {
      editingPasskeyId = null;
      renderUsers(usersCache);
      return;
    }
    const ok = await patchPasskey(passkey, updates);
    if (ok) {
      editingPasskeyId = null;
      refreshUsers();
    }
  });
  editor.querySelector('[data-action="cancel"]').addEventListener('click', () => {
    editingPasskeyId = null;
    renderUsers(usersCache);
  });
  return editor;
}

function buildDangerConfirm(message, onConfirm, onCancel) {
  const row = document.createElement('div');
  row.className = 'inline-danger-row';
  const text = document.createElement('p');
  text.textContent = message;
  row.appendChild(text);
  const actions = document.createElement('div');
  actions.className = 'users-inline-actions';
  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'auth-btn';
  confirmBtn.type = 'button';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.addEventListener('click', onConfirm);
  actions.appendChild(confirmBtn);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'auth-btn';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', onCancel);
  actions.appendChild(cancelBtn);
  row.appendChild(actions);
  return row;
}

async function patchUser(user, updates) {
  try {
    const res = await fetch('/auth/users/' + encodeURIComponent(user.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showUsersFeedback(err.error || ('Failed to update user (HTTP ' + res.status + ')'), true);
      return false;
    }
    showUsersFeedback('User updated.');
    return true;
  } catch (err) {
    showUsersFeedback('Network error: ' + err.message, true);
    return false;
  }
}

async function patchPasskey(passkey, updates) {
  try {
    const res = await fetch('/auth/passkeys/' + encodeURIComponent(passkey.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showUsersFeedback(err.error || ('Failed to update passkey (HTTP ' + res.status + ')'), true);
      return false;
    }
    showUsersFeedback('Passkey updated.');
    return true;
  } catch (err) {
    showUsersFeedback('Network error: ' + err.message, true);
    return false;
  }
}

async function deleteUser(user) {
  try {
    const res = await fetch('/auth/users/' + encodeURIComponent(user.id), { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showUsersFeedback(err.error || ('Failed to delete user (HTTP ' + res.status + ')'), true);
      return;
    }
    confirmingUserDeleteId = null;
    showUsersFeedback('User deleted.');
    refreshUsers();
  } catch (err) {
    showUsersFeedback('Network error: ' + err.message, true);
  }
}

async function deletePasskey(passkey) {
  try {
    const res = await fetch('/auth/passkeys/' + encodeURIComponent(passkey.id), { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showUsersFeedback(err.error || ('Failed to revoke passkey (HTTP ' + res.status + ')'), true);
      return;
    }
    confirmingPasskeyDeleteId = null;
    showUsersFeedback('Passkey revoked.');
    refreshUsers();
  } catch (err) {
    showUsersFeedback('Network error: ' + err.message, true);
  }
}

function openCreateUserForm() {
  const form = $('users-create-form');
  const name = $('users-create-name');
  if (!form || creatingUser) return;
  form.hidden = false;
  if (name) {
    name.value = '';
    setTimeout(() => name.focus(), 50);
  }
}

function closeCreateUserForm() {
  const form = $('users-create-form');
  if (form) form.hidden = true;
}

async function createEmptyUser() {
  const nameInput = $('users-create-name');
  const roleSelect = $('users-create-role');
  if (!nameInput || !roleSelect) return;
  const name = nameInput.value.trim();
  if (!name) {
    showUsersFeedback('Name is required.', true);
    return;
  }
  creatingUser = true;
  try {
    const res = await fetch('/auth/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, role: roleSelect.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showUsersFeedback(err.error || ('Failed to create user (HTTP ' + res.status + ')'), true);
      return;
    }
    closeCreateUserForm();
    showUsersFeedback('User created. You can now transfer a passkey to it.');
    refreshUsers();
  } catch (err) {
    showUsersFeedback('Network error: ' + err.message, true);
  } finally {
    creatingUser = false;
  }
}

function showUsersFeedback(message, isError = false) {
  const box = $('users-feedback');
  if (!box) return;
  box.hidden = !message;
  box.textContent = message || '';
  box.className = 'users-feedback' + (isError ? ' users-feedback-error' : '');
}

function getPasskeyLabel(passkey) {
  return passkey.label || passkey.deviceName || passkey.deviceSummary || 'Unnamed passkey';
}

function formatWhen(isoString) {
  if (!isoString) return 'unknown';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getCurrentUserId() {
  return currentUserId;
}

export function getCurrentCredentialId() {
  return currentCredentialId;
}
