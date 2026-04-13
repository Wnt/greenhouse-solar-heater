/**
 * Invitation management for passkey registration.
 * Pure logic — no WebAuthn or HTTP dependencies.
 */
const crypto = require('crypto');

// In-memory invitation store (keyed by code)
var activeInvitations = {};

// In-memory rate limit tracking (keyed by IP)
var rateLimits = {};

var INVITE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
var RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
var RATE_LIMIT_MAX = 5; // max attempts per window

// ── Invitation management ──

function createInvitation(sessionToken, options) {
  options = options || {};
  // Invalidate any previous invitation from the same session
  Object.keys(activeInvitations).forEach(function (code) {
    if (activeInvitations[code].sessionToken === sessionToken) {
      delete activeInvitations[code];
    }
  });

  var code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  // Ensure uniqueness (extremely unlikely collision)
  while (activeInvitations[code]) {
    code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  }

  var now = Date.now();
  var role = options.role === 'readonly' ? 'readonly' : 'admin';
  activeInvitations[code] = {
    code: code,
    createdAt: now,
    expiresAt: now + INVITE_EXPIRY_MS,
    sessionToken: sessionToken,
    role: role,
    name: options.name || null,
  };

  return {
    code: code,
    expiresAt: new Date(now + INVITE_EXPIRY_MS).toISOString(),
    expiresInSeconds: INVITE_EXPIRY_MS / 1000,
    role: role,
    name: options.name || null,
  };
}

function validateInvitation(code) {
  var invite = activeInvitations[code];
  if (!invite) return false;
  if (Date.now() > invite.expiresAt) {
    delete activeInvitations[code];
    return false;
  }
  return true;
}

function getInvitation(code) {
  if (!validateInvitation(code)) return null;
  return activeInvitations[code];
}

function consumeInvitation(code) {
  if (!validateInvitation(code)) return false;
  delete activeInvitations[code];
  return true;
}

// ── Rate limiting ──

function checkRateLimit(ip) {
  var entry = rateLimits[ip];
  if (!entry) return true;
  var now = Date.now();
  entry.attempts = entry.attempts.filter(function (t) {
    return now - t < RATE_LIMIT_WINDOW_MS;
  });
  if (entry.attempts.length === 0) {
    delete rateLimits[ip];
    return true;
  }
  return entry.attempts.length < RATE_LIMIT_MAX;
}

function recordAttempt(ip) {
  if (!rateLimits[ip]) {
    rateLimits[ip] = { attempts: [] };
  }
  rateLimits[ip].attempts.push(Date.now());
}

// ── Cleanup ──

function cleanExpired() {
  var now = Date.now();
  Object.keys(activeInvitations).forEach(function (code) {
    if (now > activeInvitations[code].expiresAt) {
      delete activeInvitations[code];
    }
  });
  Object.keys(rateLimits).forEach(function (ip) {
    rateLimits[ip].attempts = rateLimits[ip].attempts.filter(function (t) {
      return now - t < RATE_LIMIT_WINDOW_MS;
    });
    if (rateLimits[ip].attempts.length === 0) {
      delete rateLimits[ip];
    }
  });
}

function reset() {
  activeInvitations = {};
  rateLimits = {};
}

module.exports = {
  createInvitation: createInvitation,
  validateInvitation: validateInvitation,
  getInvitation: getInvitation,
  consumeInvitation: consumeInvitation,
  checkRateLimit: checkRateLimit,
  recordAttempt: recordAttempt,
  cleanExpired: cleanExpired,
  reset: reset,
  // For testing access to internal state
  _getActiveInvitations: function () { return activeInvitations; },
  _getRateLimits: function () { return rateLimits; },
};
