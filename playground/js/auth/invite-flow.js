// Admin invite-creation UI flow. Extracted from auth.js.
//
// External API:
//   openCreateInviteForm() — called from the "Invite" button
//   closeInviteModal()     — called from the modal's close button,
//                            backdrop click, and Escape keydown
//   doCreateInvite()       — called from the modal's "Create" button
//
// Internal state: inviteCountdown (the setInterval handle driving the
// TTL countdown) + helpers for modal show/hide and the QR render.

import qrcode from 'qrcode-generator';

let inviteCountdown = null;

function $(id) {
  return document.getElementById(id);
}

export function openCreateInviteForm() {
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

export async function doCreateInvite() {
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
      body: JSON.stringify({ name, role: roleSelect.value }),
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

export function closeInviteModal() {
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
