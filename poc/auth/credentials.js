/**
 * JSON file credential store for WebAuthn passkeys (single-user).
 * Manages users, passkey credentials, sessions, and setup state.
 * See data-model.md for entity definitions.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const createLogger = require('../lib/logger');

const log = createLogger('credentials');
const CREDENTIALS_PATH = process.env.CREDENTIALS_PATH || path.join(__dirname, 'credentials.json');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SETUP_WINDOW_MS = parseInt(process.env.SETUP_WINDOW_MINUTES || '30', 10) * 60 * 1000;

var store = null;

function emptyStore() {
  return {
    user: null,
    credentials: [],
    sessions: [],
    setup: null,
  };
}

function load() {
  try {
    var data = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    store = JSON.parse(data);
    log.info('credentials loaded', { credentials: store.credentials.length, sessions: store.sessions.length });
  } catch (err) {
    if (err.code === 'ENOENT') {
      store = emptyStore();
      log.info('no credentials file, starting fresh');
    } else {
      log.error('failed to load credentials', { error: err.message });
      store = emptyStore();
    }
  }
  return store;
}

function save() {
  var dir = path.dirname(CREDENTIALS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(store, null, 2));
}

function getStore() {
  if (!store) load();
  return store;
}

// ── User ──

function getUser() {
  return getStore().user;
}

function createUser(name) {
  var s = getStore();
  if (s.user) return s.user;
  s.user = {
    id: crypto.randomBytes(32).toString('base64url'),
    name: name || 'admin',
  };
  save();
  log.info('user created', { name: s.user.name });
  return s.user;
}

// ── Credentials ──

function getCredentials() {
  return getStore().credentials;
}

function getCredentialById(credentialId) {
  var creds = getStore().credentials;
  for (var i = 0; i < creds.length; i++) {
    if (creds[i].id === credentialId) return creds[i];
  }
  return null;
}

function addCredential(cred) {
  var s = getStore();
  s.credentials.push({
    id: cred.id,
    publicKey: cred.publicKey,
    counter: cred.counter,
    transports: cred.transports || [],
    createdAt: new Date().toISOString(),
  });
  save();
  log.info('credential added', { id: cred.id });
}

function updateCredentialCounter(credentialId, newCounter) {
  var cred = getCredentialById(credentialId);
  if (cred) {
    cred.counter = newCounter;
    save();
  }
}

// ── Sessions ──

function createSession() {
  var s = getStore();
  var token = crypto.randomBytes(32).toString('hex');
  var now = new Date();
  var session = {
    token: token,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS).toISOString(),
  };
  s.sessions.push(session);
  save();
  log.info('session created');
  return session;
}

function validateSession(token) {
  if (!token) return null;
  var s = getStore();
  var now = new Date();
  for (var i = 0; i < s.sessions.length; i++) {
    if (s.sessions[i].token === token && new Date(s.sessions[i].expiresAt) > now) {
      return s.sessions[i];
    }
  }
  return null;
}

function removeSession(token) {
  var s = getStore();
  s.sessions = s.sessions.filter(function (sess) { return sess.token !== token; });
  save();
}

function expireSessions() {
  var s = getStore();
  var now = new Date();
  var before = s.sessions.length;
  s.sessions = s.sessions.filter(function (sess) {
    return new Date(sess.expiresAt) > now;
  });
  if (s.sessions.length < before) {
    save();
    log.info('expired sessions cleaned', { removed: before - s.sessions.length });
  }
}

// ── Setup state ──

function getSetupState() {
  var s = getStore();
  if (!s.setup) return null;
  return s.setup;
}

function initSetup() {
  var s = getStore();
  if (s.setup) return s.setup;
  s.setup = {
    deployedAt: new Date().toISOString(),
    registrationOpen: true,
  };
  save();
  log.info('setup window opened', { windowMinutes: SETUP_WINDOW_MS / 60000 });
  return s.setup;
}

function isRegistrationOpen() {
  var s = getStore();
  // If credentials already exist, registration is only allowed when authenticated
  if (s.credentials.length > 0) return false;
  // If no setup state, init it
  if (!s.setup) initSetup();
  if (!s.setup.registrationOpen) return false;
  // Check time window
  var elapsed = Date.now() - new Date(s.setup.deployedAt).getTime();
  if (elapsed > SETUP_WINDOW_MS) {
    s.setup.registrationOpen = false;
    save();
    log.info('setup window expired');
    return false;
  }
  return true;
}

function closeRegistration() {
  var s = getStore();
  if (s.setup) {
    s.setup.registrationOpen = false;
    save();
    log.info('registration closed');
  }
}

module.exports = {
  load: load,
  getUser: getUser,
  createUser: createUser,
  getCredentials: getCredentials,
  getCredentialById: getCredentialById,
  addCredential: addCredential,
  updateCredentialCounter: updateCredentialCounter,
  createSession: createSession,
  validateSession: validateSession,
  removeSession: removeSession,
  expireSessions: expireSessions,
  getSetupState: getSetupState,
  initSetup: initSetup,
  isRegistrationOpen: isRegistrationOpen,
  closeRegistration: closeRegistration,
  SESSION_MAX_AGE_MS: SESSION_MAX_AGE_MS,
};
