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
  var hmac = crypto.createHmac('sha256', SECRET);
  hmac.update(token);
  return token + '.' + hmac.digest('hex');
}

function verify(signed) {
  if (!signed || typeof signed !== 'string') return null;
  var parts = signed.split('.');
  if (parts.length !== 2) return null;
  var token = parts[0];
  var expected = sign(token);
  if (signed.length !== expected.length) return null;
  // Constant-time comparison
  if (!crypto.timingSafeEqual(Buffer.from(signed), Buffer.from(expected))) return null;
  return token;
}

function parseCookies(req) {
  var header = req.headers.cookie || '';
  var cookies = {};
  header.split(';').forEach(function (pair) {
    var idx = pair.indexOf('=');
    if (idx < 0) return;
    var key = pair.substring(0, idx).trim();
    var val = pair.substring(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function getSessionToken(req) {
  var cookies = parseCookies(req);
  var signed = cookies[COOKIE_NAME];
  if (!signed) return null;
  return verify(signed);
}

function validateRequest(req) {
  var token = getSessionToken(req);
  if (!token) return null;
  return credStore.validateSession(token);
}

function setSessionCookie(res, token) {
  var signed = sign(token);
  var flags = [
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
  var flags = [
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
  var val = process.env.SESSION_SECRET;
  if (!val) {
    return { valid: false, reason: 'SESSION_SECRET environment variable is not set' };
  }
  if (val === DEV_SECRET) {
    return { valid: false, reason: 'SESSION_SECRET must not use the default development value' };
  }
  return { valid: true };
}

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
