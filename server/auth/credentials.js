/**
 * JSON file credential store for WebAuthn passkeys.
 * Supports multiple users with role-based access (admin / readonly).
 *
 * Backwards compatible with the previous single-user format: when an old
 * `user` object is loaded, it is migrated to `users[0]` with the `admin`
 * role and all existing credentials/sessions are linked to it.
 */

const crypto = require('crypto');
const createLogger = require('../lib/logger');
const storage = require('../lib/s3-storage');

const log = createLogger('credentials');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SETUP_WINDOW_MS = parseInt(process.env.SETUP_WINDOW_MINUTES || '30', 10) * 60 * 1000;

var ROLES = { ADMIN: 'admin', READONLY: 'readonly' };

var store = null;

function emptyStore() {
  return {
    users: [],
    credentials: [],
    sessions: [],
    setup: null,
  };
}

// Migrate the legacy single-user shape ({user: {...}}) to the new
// multi-user shape ({users: [...]}). Existing credentials and sessions
// are linked to the migrated admin user.
function migrate(data) {
  if (!data) return data;
  if (Array.isArray(data.users)) {
    // Already in the new shape, but normalize defaults on each user.
    data.users.forEach(function (u) {
      if (!u.role) u.role = ROLES.ADMIN;
      if (!u.createdAt) u.createdAt = new Date().toISOString();
    });
    // Ensure every credential and session has a userId (legacy stores
    // that were never migrated may have them undefined).
    if (data.users.length > 0) {
      var firstAdmin = null;
      for (var i = 0; i < data.users.length; i++) {
        if (data.users[i].role === ROLES.ADMIN) { firstAdmin = data.users[i]; break; }
      }
      if (!firstAdmin) firstAdmin = data.users[0];
      (data.credentials || []).forEach(function (c) {
        if (!c.userId) c.userId = firstAdmin.id;
      });
      (data.sessions || []).forEach(function (s) {
        if (!s.userId) s.userId = firstAdmin.id;
      });
    }
    return data;
  }
  // Legacy single-user format
  var migrated = emptyStore();
  migrated.setup = data.setup || null;
  if (data.user) {
    var legacy = {
      id: data.user.id,
      name: data.user.name || 'admin',
      role: ROLES.ADMIN,
      createdAt: new Date().toISOString(),
    };
    migrated.users.push(legacy);
    migrated.credentials = (data.credentials || []).map(function (c) {
      return Object.assign({}, c, { userId: legacy.id });
    });
    migrated.sessions = (data.sessions || []).map(function (s) {
      return Object.assign({}, s, { userId: legacy.id });
    });
    log.info('migrated legacy single-user store to multi-user', { user: legacy.name });
  } else {
    migrated.credentials = data.credentials || [];
    migrated.sessions = data.sessions || [];
  }
  return migrated;
}

function load(callback) {
  if (storage.isS3Enabled()) {
    store = emptyStore();
    log.info('S3 storage enabled, loading credentials');
    storage.read(function (err, data) {
      if (err) {
        log.error('failed to load credentials from S3', { error: err.message });
        if (callback) callback(err);
        return;
      }
      if (data) {
        store = migrate(data);
        log.info('credentials loaded from S3', {
          users: store.users.length,
          credentials: store.credentials.length,
          sessions: store.sessions.length,
        });
      } else {
        log.info('no credentials in S3, starting fresh');
      }
      if (callback) callback(null);
    });
  } else {
    var data = storage.readSync();
    if (data) {
      store = migrate(data);
      log.info('credentials loaded', {
        users: store.users.length,
        credentials: store.credentials.length,
        sessions: store.sessions.length,
      });
    } else {
      store = emptyStore();
      log.info('no credentials file, starting fresh');
    }
    if (callback) callback(null);
  }
  return store;
}

function save() {
  if (storage.isS3Enabled()) {
    storage.write(store, function (err) {
      if (err) {
        log.error('failed to save credentials to S3', { error: err.message });
      }
    });
  } else {
    storage.writeSync(store);
  }
}

function getStore() {
  if (!store) load();
  return store;
}

// ── Users ──

function getUsers() {
  return getStore().users.slice();
}

function getUserById(userId) {
  if (!userId) return null;
  var users = getStore().users;
  for (var i = 0; i < users.length; i++) {
    if (users[i].id === userId) return users[i];
  }
  return null;
}

function findUserByName(name) {
  if (!name) return null;
  var users = getStore().users;
  for (var i = 0; i < users.length; i++) {
    if (users[i].name === name) return users[i];
  }
  return null;
}

function createUser(name, role) {
  var s = getStore();
  if (!name || typeof name !== 'string') {
    throw new Error('name is required');
  }
  var trimmed = name.trim();
  if (!trimmed) throw new Error('name is required');
  if (findUserByName(trimmed)) {
    throw new Error('user already exists: ' + trimmed);
  }
  var resolvedRole = role === ROLES.READONLY ? ROLES.READONLY : ROLES.ADMIN;
  var user = {
    id: crypto.randomBytes(32).toString('base64url'),
    name: trimmed,
    role: resolvedRole,
    createdAt: new Date().toISOString(),
  };
  s.users.push(user);
  save();
  log.info('user created', { name: user.name, role: user.role });
  return user;
}

function deleteUser(userId) {
  var s = getStore();
  var idx = -1;
  for (var i = 0; i < s.users.length; i++) {
    if (s.users[i].id === userId) { idx = i; break; }
  }
  if (idx < 0) return false;
  // Refuse to delete the last admin so the system never locks itself out.
  var deleted = s.users[idx];
  if (deleted.role === ROLES.ADMIN) {
    var otherAdmins = 0;
    for (var j = 0; j < s.users.length; j++) {
      if (j !== idx && s.users[j].role === ROLES.ADMIN) otherAdmins++;
    }
    if (otherAdmins === 0) {
      throw new Error('Cannot delete the last admin user');
    }
  }
  s.users.splice(idx, 1);
  s.credentials = s.credentials.filter(function (c) { return c.userId !== userId; });
  s.sessions = s.sessions.filter(function (sess) { return sess.userId !== userId; });
  save();
  log.info('user deleted', { name: deleted.name, role: deleted.role });
  return true;
}

function countAdmins() {
  var users = getStore().users;
  var n = 0;
  for (var i = 0; i < users.length; i++) {
    if (users[i].role === ROLES.ADMIN) n++;
  }
  return n;
}

// ── Credentials ──

function getCredentials() {
  return getStore().credentials;
}

function getCredentialsForUser(userId) {
  return getStore().credentials.filter(function (c) { return c.userId === userId; });
}

function getCredentialById(credentialId) {
  var creds = getStore().credentials;
  for (var i = 0; i < creds.length; i++) {
    if (creds[i].id === credentialId) return creds[i];
  }
  return null;
}

function addCredential(cred) {
  if (!cred.userId) throw new Error('credential requires userId');
  var s = getStore();
  s.credentials.push({
    id: cred.id,
    userId: cred.userId,
    publicKey: cred.publicKey,
    counter: cred.counter,
    transports: cred.transports || [],
    createdAt: new Date().toISOString(),
  });
  save();
  log.info('credential added', { id: cred.id, userId: cred.userId });
}

function updateCredentialCounter(credentialId, newCounter) {
  var cred = getCredentialById(credentialId);
  if (cred) {
    cred.counter = newCounter;
    save();
  }
}

// ── Sessions ──

function createSession(userId) {
  if (!userId) throw new Error('createSession requires userId');
  var s = getStore();
  var token = crypto.randomBytes(32).toString('hex');
  var now = new Date();
  var session = {
    token: token,
    userId: userId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS).toISOString(),
  };
  s.sessions.push(session);
  save();
  log.info('session created', { userId: userId });
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

// ── Test helpers ──

function _reset() {
  store = null;
}

module.exports = {
  ROLES: ROLES,
  load: load,
  getUsers: getUsers,
  getUserById: getUserById,
  findUserByName: findUserByName,
  createUser: createUser,
  deleteUser: deleteUser,
  countAdmins: countAdmins,
  getCredentials: getCredentials,
  getCredentialsForUser: getCredentialsForUser,
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
  _reset: _reset,
};
