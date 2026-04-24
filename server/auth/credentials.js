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
const { buildDeviceDetails } = require('./device-info');

const log = createLogger('credentials');
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const SETUP_WINDOW_MS = parseInt(process.env.SETUP_WINDOW_MINUTES || '30', 10) * 60 * 1000;

const ROLES = { ADMIN: 'admin', READONLY: 'readonly' };

let store = null;

function emptyStore() {
  return {
    users: [],
    credentials: [],
    sessions: [],
    setup: null,
  };
}

function normalizeCredential(cred) {
  if (!cred) return cred;
  if (!cred.createdAt) cred.createdAt = new Date().toISOString();
  if (!Array.isArray(cred.transports)) cred.transports = [];
  if (typeof cred.label !== 'string') cred.label = '';
  if (!cred.lastUsedAt) cred.lastUsedAt = null;
  if (!cred.lastIp) cred.lastIp = null;
  if (typeof cred.lastUserAgent !== 'string') cred.lastUserAgent = '';
  if (!cred.device || typeof cred.device !== 'object') {
    cred.device = buildDeviceDetails(cred.lastUserAgent);
  } else {
    const rebuilt = buildDeviceDetails(cred.lastUserAgent);
    cred.device.browser = cred.device.browser || rebuilt.browser;
    cred.device.os = cred.device.os || rebuilt.os;
    cred.device.deviceType = cred.device.deviceType || rebuilt.deviceType;
    cred.device.deviceName = cred.device.deviceName || rebuilt.deviceName;
    cred.device.summary = cred.device.summary || rebuilt.summary;
  }
  return cred;
}

function normalizeSession(sess) {
  if (!sess) return sess;
  if (!sess.credentialId) sess.credentialId = null;
  return sess;
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
    (data.credentials || []).forEach(normalizeCredential);
    (data.sessions || []).forEach(normalizeSession);
    // Ensure every credential and session has a userId (legacy stores
    // that were never migrated may have them undefined).
    if (data.users.length > 0) {
      let firstAdmin = null;
      for (let i = 0; i < data.users.length; i++) {
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
  const migrated = emptyStore();
  migrated.setup = data.setup || null;
  if (data.user) {
    const legacy = {
      id: data.user.id,
      name: data.user.name || 'admin',
      role: ROLES.ADMIN,
      createdAt: new Date().toISOString(),
    };
    migrated.users.push(legacy);
    migrated.credentials = (data.credentials || []).map(function (c) {
      return normalizeCredential(Object.assign({}, c, { userId: legacy.id }));
    });
    migrated.sessions = (data.sessions || []).map(function (s) {
      return normalizeSession(Object.assign({}, s, { userId: legacy.id }));
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
    const data = storage.readSync();
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
  const users = getStore().users;
  for (let i = 0; i < users.length; i++) {
    if (users[i].id === userId) return users[i];
  }
  return null;
}

function findUserByName(name) {
  if (!name) return null;
  const users = getStore().users;
  for (let i = 0; i < users.length; i++) {
    if (users[i].name === name) return users[i];
  }
  return null;
}

function createUser(name, role) {
  const s = getStore();
  if (!name || typeof name !== 'string') {
    throw new Error('name is required');
  }
  const trimmed = name.trim();
  if (!trimmed) throw new Error('name is required');
  if (findUserByName(trimmed)) {
    throw new Error('user already exists: ' + trimmed);
  }
  const resolvedRole = role === ROLES.READONLY ? ROLES.READONLY : ROLES.ADMIN;
  const user = {
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
  const s = getStore();
  let idx = -1;
  for (let i = 0; i < s.users.length; i++) {
    if (s.users[i].id === userId) { idx = i; break; }
  }
  if (idx < 0) return false;
  // Refuse to delete the last admin so the system never locks itself out.
  const deleted = s.users[idx];
  if (deleted.role === ROLES.ADMIN) {
    let otherAdmins = 0;
    for (let j = 0; j < s.users.length; j++) {
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

// Update a user's name and/or role. Throws on duplicate names, unknown
// users, or attempts to demote the last admin.
function updateUser(userId, updates) {
  const s = getStore();
  let user = null;
  for (let i = 0; i < s.users.length; i++) {
    if (s.users[i].id === userId) { user = s.users[i]; break; }
  }
  if (!user) throw new Error('User not found');

  let nextName = user.name;
  if (updates && typeof updates.name === 'string') {
    const trimmed = updates.name.trim();
    if (!trimmed) throw new Error('name is required');
    if (trimmed.length > 64) throw new Error('Name is too long (max 64 chars)');
    if (trimmed !== user.name) {
      const existing = findUserByName(trimmed);
      if (existing && existing.id !== userId) {
        throw new Error('A user with that name already exists');
      }
      nextName = trimmed;
    }
  }

  let nextRole = user.role;
  if (updates && typeof updates.role === 'string') {
    const requested = updates.role === ROLES.READONLY ? ROLES.READONLY : ROLES.ADMIN;
    if (requested !== user.role) {
      // Refuse to demote the last admin.
      if (user.role === ROLES.ADMIN && requested !== ROLES.ADMIN) {
        let otherAdmins2 = 0;
        for (let j = 0; j < s.users.length; j++) {
          if (s.users[j].id !== userId && s.users[j].role === ROLES.ADMIN) otherAdmins2++;
        }
        if (otherAdmins2 === 0) {
          throw new Error('Cannot demote the last admin user');
        }
      }
      nextRole = requested;
    }
  }

  if (nextName === user.name && nextRole === user.role) {
    return user; // no-op
  }

  user.name = nextName;
  user.role = nextRole;
  save();
  log.info('user updated', { name: user.name, role: user.role });
  return user;
}

function countAdmins() {
  const users = getStore().users;
  let n = 0;
  for (let i = 0; i < users.length; i++) {
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
  const creds = getStore().credentials;
  for (let i = 0; i < creds.length; i++) {
    if (creds[i].id === credentialId) return creds[i];
  }
  return null;
}

function addCredential(cred) {
  if (!cred.userId) throw new Error('credential requires userId');
  const s = getStore();
  s.credentials.push(normalizeCredential({
    id: cred.id,
    userId: cred.userId,
    publicKey: cred.publicKey,
    counter: cred.counter,
    transports: cred.transports || [],
    createdAt: new Date().toISOString(),
    label: cred.label || '',
    lastUsedAt: cred.lastUsedAt || null,
    lastIp: cred.lastIp || null,
    lastUserAgent: cred.lastUserAgent || '',
    device: cred.device || null,
  }));
  save();
  log.info('credential added', { id: cred.id, userId: cred.userId });
}

function updateCredentialCounter(credentialId, newCounter) {
  const cred = getCredentialById(credentialId);
  if (cred) {
    cred.counter = newCounter;
    save();
  }
}

function updateCredential(credentialId, updates) {
  const cred = getCredentialById(credentialId);
  if (!cred) throw new Error('Passkey not found');
  if (!updates || typeof updates !== 'object') return cred;

  if (typeof updates.label === 'string') {
    const trimmed = updates.label.trim();
    if (trimmed.length > 80) throw new Error('Passkey label is too long (max 80 chars)');
    cred.label = trimmed;
  }

  if (typeof updates.userId === 'string' && updates.userId && updates.userId !== cred.userId) {
    if (!getUserById(updates.userId)) throw new Error('Target user not found');
    cred.userId = updates.userId;
    removeSessionsForCredential(credentialId);
  }

  if (typeof updates.lastUsedAt === 'string' || updates.lastUsedAt === null) {
    cred.lastUsedAt = updates.lastUsedAt;
  }
  if (typeof updates.lastIp === 'string' || updates.lastIp === null) {
    cred.lastIp = updates.lastIp;
  }
  if (typeof updates.lastUserAgent === 'string') {
    cred.lastUserAgent = updates.lastUserAgent;
    cred.device = buildDeviceDetails(updates.lastUserAgent);
  } else if (updates.device && typeof updates.device === 'object') {
    cred.device = updates.device;
  }

  save();
  log.info('credential updated', { id: cred.id, userId: cred.userId });
  return cred;
}

function touchCredential(credentialId, metadata) {
  return updateCredential(credentialId, {
    lastUsedAt: metadata && metadata.lastUsedAt || new Date().toISOString(),
    lastIp: metadata && metadata.lastIp || null,
    lastUserAgent: metadata && metadata.lastUserAgent || '',
  });
}

function deleteCredential(credentialId) {
  const s = getStore();
  let idx = -1;
  for (let i = 0; i < s.credentials.length; i++) {
    if (s.credentials[i].id === credentialId) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return false;
  const removed = s.credentials[idx];
  s.credentials.splice(idx, 1);
  s.sessions = s.sessions.filter(function (sess) { return sess.credentialId !== credentialId; });
  save();
  log.info('credential deleted', { id: removed.id, userId: removed.userId });
  return true;
}

// ── Sessions ──

function createSession(userId, credentialId) {
  if (!userId) throw new Error('createSession requires userId');
  const s = getStore();
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const session = normalizeSession({
    token,
    userId,
    credentialId: credentialId || null,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_MAX_AGE_MS).toISOString(),
  });
  s.sessions.push(session);
  save();
  log.info('session created', { userId, credentialId: session.credentialId });
  return session;
}

function validateSession(token) {
  if (!token) return null;
  const s = getStore();
  const now = new Date();
  for (let i = 0; i < s.sessions.length; i++) {
    if (s.sessions[i].token === token && new Date(s.sessions[i].expiresAt) > now) {
      return s.sessions[i];
    }
  }
  return null;
}

function removeSession(token) {
  const s = getStore();
  s.sessions = s.sessions.filter(function (sess) { return sess.token !== token; });
  save();
}

function removeSessionsForCredential(credentialId) {
  const s = getStore();
  const before = s.sessions.length;
  s.sessions = s.sessions.filter(function (sess) { return sess.credentialId !== credentialId; });
  if (s.sessions.length !== before) {
    save();
  }
}

function expireSessions() {
  const s = getStore();
  const now = new Date();
  const before = s.sessions.length;
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
  const s = getStore();
  if (!s.setup) return null;
  return s.setup;
}

function initSetup() {
  const s = getStore();
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
  const s = getStore();
  // If credentials already exist, registration is only allowed when authenticated
  if (s.credentials.length > 0) return false;
  // If no setup state, init it
  if (!s.setup) initSetup();
  if (!s.setup.registrationOpen) return false;
  // Check time window
  const elapsed = Date.now() - new Date(s.setup.deployedAt).getTime();
  if (elapsed > SETUP_WINDOW_MS) {
    s.setup.registrationOpen = false;
    save();
    log.info('setup window expired');
    return false;
  }
  return true;
}

function closeRegistration() {
  const s = getStore();
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
  ROLES,
  load,
  getUsers,
  getUserById,
  findUserByName,
  createUser,
  deleteUser,
  updateUser,
  countAdmins,
  getCredentials,
  getCredentialsForUser,
  getCredentialById,
  addCredential,
  updateCredentialCounter,
  updateCredential,
  touchCredential,
  deleteCredential,
  createSession,
  validateSession,
  removeSession,
  removeSessionsForCredential,
  expireSessions,
  getSetupState,
  initSetup,
  isRegistrationOpen,
  closeRegistration,
  SESSION_MAX_AGE_MS,
  _reset,
};
