/**
 * HMAC-signed cookie session management.
 * Uses crypto.createHmac with the SESSION_SECRET env var.
 * Cookie flags: HttpOnly, Secure (in production), SameSite=Strict, Path=/, Max-Age=30d
 */

const crypto = require('crypto');
const credStore = require('./credentials');

const DEV_SECRET = 'dev-secret-change-me';
const SECRET = process.env.SESSION_SECRET || DEV_SECRET;
const COOKIE_NAME = 'session';
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function sign(token) {
  const hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(token);
  return token + '.' + hmac.digest('hex');
}

function verify(signed) {
  if (!signed || typeof signed !== 'string') return null;
  const parts = signed.split('.');
  if (parts.length !== 2) return null;
  const token = parts[0];
  const expected = sign(token);
  if (signed.length !== expected.length) return null;
  // Constant-time comparison
  if (!crypto.timingSafeEqual(Buffer.from(signed), Buffer.from(expected))) return null;
  return token;
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.substring(0, idx).trim();
    const val = pair.substring(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  const signed = cookies[COOKIE_NAME];
  if (!signed) return null;
  return verify(signed);
}

function validateRequest(req) {
  const token = getSessionToken(req);
  if (!token) return null;
  return credStore.validateSession(token);
}

function setSessionCookie(res, token) {
  const signed = sign(token);
  const flags = [
    COOKIE_NAME + '=' + signed,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + MAX_AGE_SECONDS,
  ];
  if (IS_PRODUCTION) {
    flags.push('Secure');
  }
  res.setHeader('Set-Cookie', flags.join('; '));
}

function clearSessionCookie(res) {
  const flags = [
    COOKIE_NAME + '=',
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (IS_PRODUCTION) {
    flags.push('Secure');
  }
  res.setHeader('Set-Cookie', flags.join('; '));
}

function validateSecret() {
  const val = process.env.SESSION_SECRET;
  if (!val) {
    return { valid: false, reason: 'SESSION_SECRET environment variable is not set' };
  }
  if (val === DEV_SECRET) {
    return { valid: false, reason: 'SESSION_SECRET must not use the default development value' };
  }
  return { valid: true };
}

// knip 6.x mis-resolves shorthand exports in modules consumed via namespace
// access (`session.validateRequest(…)` pattern), flagging every entry as
// unused. Explicit-property form sidesteps it.
/* eslint-disable object-shorthand */
module.exports = {
  sign: sign,
  verify: verify,
  parseCookies: parseCookies,
  getSessionToken: getSessionToken,
  validateRequest: validateRequest,
  setSessionCookie: setSessionCookie,
  clearSessionCookie: clearSessionCookie,
  validateSecret: validateSecret,
  DEV_SECRET: DEV_SECRET,
};
/* eslint-enable object-shorthand */
