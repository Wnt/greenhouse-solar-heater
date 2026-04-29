/**
 * Browser-side passkey authentication using @simplewebauthn/browser.
 * Handles both registration (setup) and login flows.
 */
import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';

const elLoginBtn = document.getElementById('login-btn');
const elRegisterBtn = document.getElementById('register-btn');
const elRegisterSection = document.getElementById('register-section');
const elLoginSection = document.getElementById('login-section');
const elError = document.getElementById('login-error');
const elInfo = document.getElementById('login-info');
const elSubtitle = document.getElementById('login-subtitle');
const elInviteLink = document.getElementById('invite-link');
const elInviteSection = document.getElementById('invite-section');
const elInviteCodeInput = document.getElementById('invite-code-input');
const elInviteRegisterBtn = document.getElementById('invite-register-btn');

function showError(msg) {
  elError.textContent = msg;
  elError.style.display = 'block';
  elInfo.style.display = 'none';
}

function showInfo(msg) {
  elInfo.textContent = msg;
  elInfo.style.display = 'block';
  elError.style.display = 'none';
}

function hideMessages() {
  elError.style.display = 'none';
  elInfo.style.display = 'none';
}

// Update only the label span inside a button, preserving the icon span.
// textContent on the button itself would wipe out the icon.
function setBtnLabel(btn, text) {
  const label = btn.querySelector('.login-btn-label');
  if (label) {
    label.textContent = text;
  } else {
    btn.textContent = text;
  }
}

async function checkStatus() {
  try {
    const res = await fetch('/auth/status');
    const status = await res.json();

    if (status.authenticated) {
      window.location.href = '/';
      return;
    }

    if (status.setupMode && status.registrationOpen) {
      // Show registration UI
      elRegisterSection.classList.add('visible');
      elLoginSection.style.display = 'none';
      elInviteLink.style.display = 'none';
      elSubtitle.textContent = 'Register your first passkey to get started.';
    } else if (status.setupMode && !status.registrationOpen) {
      // Registration window closed, no credentials
      elLoginSection.style.display = 'none';
      elInviteLink.style.display = 'none';
      showError('Registration window has expired. Redeploy to register a new passkey.');
    } else {
      // Normal login mode — show invitation option
      elLoginSection.style.display = 'block';
      elRegisterSection.classList.remove('visible');
      elInviteLink.style.display = 'inline-block';
    }
  } catch (err) {
    showError('Cannot reach server: ' + err.message);
  }
}

async function doLogin() {
  hideMessages();
  elLoginBtn.disabled = true;
  setBtnLabel(elLoginBtn, 'Authenticating\u2026');

  try {
    const optionsRes = await fetch('/auth/login/options', { method: 'POST' });
    if (!optionsRes.ok) {
      const errData = await optionsRes.json();
      showError(errData.error || 'Failed to get login options');
      return;
    }
    const options = await optionsRes.json();

    const assertion = await startAuthentication({ optionsJSON: options });

    const verifyRes = await fetch('/auth/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assertion),
    });

    const result = await verifyRes.json();
    if (result.verified) {
      window.location.href = '/';
    } else {
      showError('Authentication failed. Please try again.');
    }
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showError('Authentication was cancelled or timed out.');
    } else {
      showError('Authentication error: ' + err.message);
    }
  } finally {
    elLoginBtn.disabled = false;
    setBtnLabel(elLoginBtn, 'Sign in with passkey');
  }
}

async function doRegister() {
  hideMessages();
  elRegisterBtn.disabled = true;
  setBtnLabel(elRegisterBtn, 'Registering\u2026');

  try {
    const optionsRes = await fetch('/auth/register/options', { method: 'POST' });
    if (!optionsRes.ok) {
      const errData = await optionsRes.json();
      showError(errData.error || 'Failed to get registration options');
      return;
    }
    const options = await optionsRes.json();

    const attestation = await startRegistration({ optionsJSON: options });

    const verifyRes = await fetch('/auth/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attestation),
    });

    const result = await verifyRes.json();
    if (result.verified) {
      showInfo('Passkey registered successfully! Redirecting...');
      setTimeout(function () { window.location.href = '/'; }, 1000);
    } else {
      showError('Registration failed. Please try again.');
    }
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showError('Registration was cancelled or timed out.');
    } else {
      showError('Registration error: ' + err.message);
    }
  } finally {
    elRegisterBtn.disabled = false;
    setBtnLabel(elRegisterBtn, 'Register passkey');
  }
}

// ── Invitation-based registration ──

function toggleInviteSection() {
  const visible = elInviteSection.classList.contains('visible');
  if (visible) {
    elInviteSection.classList.remove('visible');
  } else {
    elInviteSection.classList.add('visible');
    elInviteCodeInput.focus();
  }
  hideMessages();
}

async function doInviteRegister() {
  hideMessages();
  const code = elInviteCodeInput.value.trim();
  if (!/^\d{6}$/.test(code)) {
    showError('Please enter a 6-digit invitation code.');
    return;
  }

  elInviteRegisterBtn.disabled = true;
  setBtnLabel(elInviteRegisterBtn, 'Validating\u2026');

  try {
    // Step 1: Validate the code
    const validateRes = await fetch('/auth/invite/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (validateRes.status === 429) {
      showError('Too many attempts. Try again later.');
      return;
    }
    if (!validateRes.ok) {
      const valErr = await validateRes.json();
      showError(valErr.error || 'Invalid or expired invitation code');
      return;
    }

    setBtnLabel(elInviteRegisterBtn, 'Registering\u2026');

    // Step 2: Get registration options with invitation code
    const optionsRes = await fetch('/auth/register/options', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invitationCode: code }),
    });
    if (optionsRes.status === 429) {
      showError('Too many attempts. Try again later.');
      return;
    }
    if (!optionsRes.ok) {
      const optErr = await optionsRes.json();
      showError(optErr.error || 'Failed to start registration');
      return;
    }
    const options = await optionsRes.json();

    // Step 3: Browser passkey creation
    const attestation = await startRegistration({ optionsJSON: options });

    // Step 4: Verify with invitation code
    const verifyBody = Object.assign({}, attestation, { invitationCode: code });
    const verifyRes = await fetch('/auth/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(verifyBody),
    });

    const result = await verifyRes.json();
    if (result.verified) {
      showInfo('Passkey registered successfully! Redirecting...');
      setTimeout(function () { window.location.href = '/'; }, 1000);
    } else {
      showError('Registration failed. Please try again.');
    }
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showError('Registration was cancelled or timed out.');
    } else {
      showError('Registration error: ' + err.message);
    }
  } finally {
    elInviteRegisterBtn.disabled = false;
    setBtnLabel(elInviteRegisterBtn, 'Register with code');
  }
}

function handleInviteUrlParam() {
  const params = new URLSearchParams(window.location.search);
  const inviteCode = params.get('invite');
  if (inviteCode && /^\d{6}$/.test(inviteCode)) {
    elInviteCodeInput.value = inviteCode;
    elInviteSection.classList.add('visible');
    // Auto-trigger after a short delay to let the page settle
    setTimeout(function () { doInviteRegister(); }, 300);
  }
}

// PR-preview rebrand. Mirrors the playground's connection.js fetch:
// `Solar sanctuary` → `Preview · #42 · branch/name` so reviewers
// know which deploy they hit before they even sign in.
async function applyPreviewBranding() {
  try {
    const res = await fetch('/api/runtime');
    if (!res.ok) return;
    const data = await res.json();
    const preview = data && data.preview;
    if (!preview) return;
    const tagline = document.getElementById('login-tagline');
    if (!tagline) return;
    const parts = ['Preview'];
    if (preview.pr != null) parts.push('#' + preview.pr);
    if (preview.branch) parts.push(preview.branch);
    tagline.textContent = parts.join(' · ');
  } catch (e) { /* silent — falls back to the prod copy */ }
}

// ── Init ──

if (!browserSupportsWebAuthn()) {
  showError('Your browser does not support passkeys (WebAuthn). Please use a modern browser.');
} else {
  elLoginBtn.addEventListener('click', doLogin);
  elRegisterBtn.addEventListener('click', doRegister);
  elInviteLink.addEventListener('click', toggleInviteSection);
  elInviteRegisterBtn.addEventListener('click', doInviteRegister);
  elInviteCodeInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doInviteRegister();
  });
  applyPreviewBranding();
  checkStatus().then(function () {
    handleInviteUrlParam();
  });
}
