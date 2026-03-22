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

async function checkStatus() {
  try {
    var res = await fetch('/auth/status');
    var status = await res.json();

    if (status.authenticated) {
      window.location.href = '/';
      return;
    }

    if (status.setupMode && status.registrationOpen) {
      // Show registration UI
      elRegisterSection.classList.add('visible');
      elLoginSection.style.display = 'none';
      elSubtitle.textContent = 'Register your first passkey to get started.';
    } else if (status.setupMode && !status.registrationOpen) {
      // Registration window closed, no credentials
      elLoginSection.style.display = 'none';
      showError('Registration window has expired. Redeploy to register a new passkey.');
    } else {
      // Normal login mode
      elLoginSection.style.display = 'block';
      elRegisterSection.classList.remove('visible');
    }
  } catch (err) {
    showError('Cannot reach server: ' + err.message);
  }
}

async function doLogin() {
  hideMessages();
  elLoginBtn.disabled = true;
  elLoginBtn.textContent = 'Authenticating...';

  try {
    var optionsRes = await fetch('/auth/login/options', { method: 'POST' });
    if (!optionsRes.ok) {
      var errData = await optionsRes.json();
      showError(errData.error || 'Failed to get login options');
      return;
    }
    var options = await optionsRes.json();

    var assertion = await startAuthentication({ optionsJSON: options });

    var verifyRes = await fetch('/auth/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(assertion),
    });

    var result = await verifyRes.json();
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
    elLoginBtn.textContent = 'Sign in with Passkey';
  }
}

async function doRegister() {
  hideMessages();
  elRegisterBtn.disabled = true;
  elRegisterBtn.textContent = 'Registering...';

  try {
    var optionsRes = await fetch('/auth/register/options', { method: 'POST' });
    if (!optionsRes.ok) {
      var errData = await optionsRes.json();
      showError(errData.error || 'Failed to get registration options');
      return;
    }
    var options = await optionsRes.json();

    var attestation = await startRegistration({ optionsJSON: options });

    var verifyRes = await fetch('/auth/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(attestation),
    });

    var result = await verifyRes.json();
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
    elRegisterBtn.textContent = 'Register Passkey';
  }
}

// ── Init ──

if (!browserSupportsWebAuthn()) {
  showError('Your browser does not support passkeys (WebAuthn). Please use a modern browser.');
} else {
  elLoginBtn.addEventListener('click', doLogin);
  elRegisterBtn.addEventListener('click', doRegister);
  checkStatus();
}
