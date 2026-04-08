/**
 * Auth UI for the playground: checks authentication status and wires up
 * logout + "Add Device" (invitation) actions in the sidebar. When auth is
 * disabled (e.g. local LAN mode, GitHub Pages, or the /auth endpoints are
 * not reachable) the controls stay hidden.
 */
import qrcode from 'qrcode-generator';

let inviteCountdown = null;

function $(id) {
  return document.getElementById(id);
}

export async function initAuth() {
  const authActions = $('auth-actions');
  const logoutBtn = $('logout-btn');
  const inviteBtn = $('invite-btn');
  const inviteModal = $('invite-modal');
  const inviteBackdrop = $('invite-modal-backdrop');
  const inviteCloseBtn = $('invite-close-btn');

  if (!authActions || !logoutBtn || !inviteBtn) return;

  logoutBtn.addEventListener('click', doLogout);
  inviteBtn.addEventListener('click', doCreateInvite);
  if (inviteCloseBtn) inviteCloseBtn.addEventListener('click', closeInviteModal);
  if (inviteBackdrop) inviteBackdrop.addEventListener('click', closeInviteModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && inviteModal && !inviteModal.hidden) {
      closeInviteModal();
    }
  });

  try {
    const res = await fetch('/auth/status');
    if (!res.ok) return; // auth disabled (404) — keep actions hidden
    const data = await res.json();
    if (data.authenticated) {
      authActions.hidden = false;
    }
  } catch (err) {
    // Network error / auth unreachable — keep actions hidden
  }
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

async function doCreateInvite() {
  const inviteBtn = $('invite-btn');
  const inviteError = $('invite-error');
  if (inviteError) inviteError.hidden = true;
  if (inviteBtn) inviteBtn.disabled = true;
  try {
    const res = await fetch('/auth/invite/create', { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showInviteError(err.error || 'Failed to create invitation (HTTP ' + res.status + ')');
      openInviteModal();
      return;
    }
    const data = await res.json();
    openInviteModal();
    renderInvite(data.code, data.expiresInSeconds);
  } catch (err) {
    showInviteError('Network error: ' + err.message);
    openInviteModal();
  } finally {
    if (inviteBtn) inviteBtn.disabled = false;
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
