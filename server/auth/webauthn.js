/**
 * WebAuthn registration and authentication handlers.
 * Uses @simplewebauthn/server for cryptographic operations.
 *
 * Supports multiple users with role-based access. New users register via
 * an invitation code created by an admin (role + name baked into the
 * invitation). The very first registration during the setup window
 * always becomes an admin.
 */

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const credStore = require('./credentials');
const session = require('./session');
const invitations = require('./invitations');
const createLogger = require('../lib/logger');

const log = createLogger('webauthn');

const RPID = process.env.RPID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';
const RP_NAME = 'Helios Canopy';

// In-memory challenge store, keyed per-flow so concurrent users don't clash.
// 'login' is shared across the resident-key login flow (no user known yet),
// 'register:<code>' for invitation-driven registration, and
// 'register:setup' for the very first setup-window registration.
var pendingChallenges = {};

function init(callback) {
  credStore.load(function (err) {
    if (err) {
      if (callback) callback(err);
      return;
    }
    // If no credentials exist, start setup window
    if (credStore.getCredentials().length === 0) {
      credStore.initSetup();
    }
    // Clean expired sessions on startup
    credStore.expireSessions();
    if (callback) callback(null);
  });
}

function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Helpers ──

function getClientIp(req) {
  var forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || 'unknown';
}

// Resolve the current authenticated user for a request, or null.
function getCurrentUser(req) {
  var sess = session.validateRequest(req);
  if (!sess) return null;
  if (!sess.userId) return null;
  return credStore.getUserById(sess.userId);
}

// Reject if the caller is not authenticated. Returns the user on success
// or null after writing the 401 response.
function requireUser(req, res) {
  var user = getCurrentUser(req);
  if (!user) {
    jsonResponse(res, 401, { error: 'Not authenticated' });
    return null;
  }
  return user;
}

// Reject if the caller is not an admin. Returns the user on success or
// null after writing the appropriate response.
function requireAdmin(req, res) {
  var user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== credStore.ROLES.ADMIN) {
    jsonResponse(res, 403, { error: 'Admin role required' });
    return null;
  }
  return user;
}

// ── Route handler ──

function handleRequest(req, res, urlPath, body) {
  // Clean expired invitations on each request
  invitations.cleanExpired();

  if (req.method === 'POST' && urlPath === '/auth/register/options') {
    handleRegisterOptions(req, res, body);
  } else if (req.method === 'POST' && urlPath === '/auth/register/verify') {
    handleRegisterVerify(req, res, body);
  } else if (req.method === 'POST' && urlPath === '/auth/login/options') {
    handleLoginOptions(req, res);
  } else if (req.method === 'POST' && urlPath === '/auth/login/verify') {
    handleLoginVerify(req, res, body);
  } else if (req.method === 'GET' && urlPath === '/auth/status') {
    handleStatus(req, res);
  } else if (req.method === 'POST' && urlPath === '/auth/logout') {
    handleLogout(req, res);
  } else if (req.method === 'POST' && urlPath === '/auth/invite/create') {
    handleInviteCreate(req, res, body);
  } else if (req.method === 'POST' && urlPath === '/auth/invite/validate') {
    handleInviteValidate(req, res, body);
  } else if (req.method === 'GET' && urlPath === '/auth/users') {
    handleListUsers(req, res);
  } else if (req.method === 'DELETE' && urlPath.indexOf('/auth/users/') === 0) {
    handleDeleteUser(req, res, urlPath);
  } else if ((req.method === 'PATCH' || req.method === 'PUT') && urlPath.indexOf('/auth/users/') === 0) {
    handleUpdateUser(req, res, urlPath, body);
  } else {
    jsonResponse(res, 404, { error: 'Not found' });
  }
}

// ── POST /auth/invite/create ──

function handleInviteCreate(req, res, body) {
  var user = requireAdmin(req, res);
  if (!user) return;

  var parsed = {};
  if (body) {
    try { parsed = JSON.parse(body) || {}; } catch (e) { parsed = {}; }
  }
  var role = parsed.role === 'readonly' ? 'readonly' : 'admin';
  var name = (parsed.name && typeof parsed.name === 'string') ? parsed.name.trim() : '';
  if (!name) {
    jsonResponse(res, 400, { error: 'Name is required' });
    return;
  }
  if (credStore.findUserByName(name)) {
    jsonResponse(res, 400, { error: 'A user with that name already exists' });
    return;
  }
  if (name.length > 64) {
    jsonResponse(res, 400, { error: 'Name is too long (max 64 chars)' });
    return;
  }

  var sessionToken = session.getSessionToken(req);
  var invite = invitations.createInvitation(sessionToken, { role: role, name: name });
  log.info('invitation created', { code: invite.code, role: role });
  jsonResponse(res, 200, invite);
}

// ── POST /auth/invite/validate ──

function handleInviteValidate(req, res, body) {
  var ip = getClientIp(req);
  if (!invitations.checkRateLimit(ip)) {
    jsonResponse(res, 429, { error: 'Too many attempts. Try again later.' });
    return;
  }
  invitations.recordAttempt(ip);

  var data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return;
  }

  if (!data.code || typeof data.code !== 'string') {
    jsonResponse(res, 400, { error: 'Invalid or expired invitation code' });
    return;
  }

  var invite = invitations.getInvitation(data.code);
  if (invite) {
    jsonResponse(res, 200, { valid: true, role: invite.role, name: invite.name });
  } else {
    jsonResponse(res, 400, { error: 'Invalid or expired invitation code' });
  }
}

// ── GET /auth/users ──

function handleListUsers(req, res) {
  var caller = requireUser(req, res);
  if (!caller) return;

  var users = credStore.getUsers().map(function (u) {
    var creds = credStore.getCredentialsForUser(u.id);
    return {
      id: u.id,
      name: u.name,
      role: u.role,
      createdAt: u.createdAt || null,
      credentialCount: creds.length,
      isCurrent: u.id === caller.id,
    };
  });
  jsonResponse(res, 200, { users: users });
}

// ── PATCH /auth/users/:id ──

function handleUpdateUser(req, res, urlPath, body) {
  var caller = requireAdmin(req, res);
  if (!caller) return;

  var userId = urlPath.substring('/auth/users/'.length);
  if (!userId) {
    jsonResponse(res, 400, { error: 'Missing user id' });
    return;
  }
  var target = credStore.getUserById(userId);
  if (!target) {
    jsonResponse(res, 404, { error: 'User not found' });
    return;
  }

  var parsed;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch (e) {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  var updates = {};
  if (typeof parsed.name === 'string') updates.name = parsed.name;
  if (typeof parsed.role === 'string') updates.role = parsed.role;

  // Refuse self-demotion so an admin can't lock themselves out via the API.
  if (target.id === caller.id && updates.role && updates.role !== caller.role) {
    jsonResponse(res, 400, { error: 'Cannot change your own role' });
    return;
  }

  try {
    var updated = credStore.updateUser(userId, updates);
    jsonResponse(res, 200, {
      ok: true,
      user: { id: updated.id, name: updated.name, role: updated.role },
    });
  } catch (err) {
    var status = err.message === 'User not found' ? 404 : 400;
    jsonResponse(res, status, { error: err.message });
  }
}

// ── DELETE /auth/users/:id ──

function handleDeleteUser(req, res, urlPath) {
  var caller = requireAdmin(req, res);
  if (!caller) return;

  var userId = urlPath.substring('/auth/users/'.length);
  if (!userId) {
    jsonResponse(res, 400, { error: 'Missing user id' });
    return;
  }
  var target = credStore.getUserById(userId);
  if (!target) {
    jsonResponse(res, 404, { error: 'User not found' });
    return;
  }
  if (target.id === caller.id) {
    jsonResponse(res, 400, { error: 'Cannot delete yourself' });
    return;
  }
  try {
    credStore.deleteUser(userId);
    jsonResponse(res, 200, { ok: true });
  } catch (err) {
    jsonResponse(res, 400, { error: err.message });
  }
}

// ── POST /auth/register/options ──

async function handleRegisterOptions(req, res, body) {
  var allowed = false;
  var registerAs = null; // { name, role, isSetup }
  var invitationCode = null;

  // Check 1: Registration window open (initial setup) — first user is admin
  if (credStore.isRegistrationOpen()) {
    allowed = true;
    registerAs = { name: 'admin', role: credStore.ROLES.ADMIN, isSetup: true };
  }

  // Check 2: Valid invitation code
  if (!allowed && body) {
    var parsed;
    try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
    if (parsed && parsed.invitationCode) {
      var ip = getClientIp(req);
      if (!invitations.checkRateLimit(ip)) {
        jsonResponse(res, 429, { error: 'Too many attempts. Try again later.' });
        return;
      }
      invitations.recordAttempt(ip);
      var invite = invitations.getInvitation(parsed.invitationCode);
      if (invite) {
        allowed = true;
        invitationCode = parsed.invitationCode;
        registerAs = { name: invite.name, role: invite.role, isSetup: false };
      }
    }
  }

  if (!allowed) {
    jsonResponse(res, 403, { error: 'Registration not allowed' });
    return;
  }

  // Resolve a unique name. For setup, fall back to admin1, admin2, etc.
  var name = registerAs.name || 'user';
  if (credStore.findUserByName(name)) {
    if (registerAs.isSetup) {
      var n = 1;
      while (credStore.findUserByName(name + n)) n++;
      name = name + n;
    } else {
      jsonResponse(res, 400, { error: 'A user with that name already exists' });
      return;
    }
  }

  // Generate the WebAuthn user handle without persisting the user record yet.
  // We only commit the user (and attached credential) after a successful
  // verification, so cancelled or failed registrations leave no orphan.
  var pendingUserId = crypto.randomBytes(32).toString('base64url');

  try {
    var options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RPID,
      userName: name,
      userDisplayName: name,
      userID: Uint8Array.from(Buffer.from(pendingUserId, 'base64url')),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      excludeCredentials: [],
    });

    // Store challenge keyed by flow so concurrent registrations don't trample each other
    var challengeKey = invitationCode ? 'register:' + invitationCode : 'register:setup';
    pendingChallenges[challengeKey] = {
      challenge: options.challenge,
      pendingUserId: pendingUserId,
      name: name,
      role: registerAs.role,
      invitationCode: invitationCode,
    };
    jsonResponse(res, 200, options);
  } catch (err) {
    log.error('register options failed', { error: err.message });
    jsonResponse(res, 500, { error: 'Failed to generate options' });
  }
}

// ── POST /auth/register/verify ──

async function handleRegisterVerify(req, res, body) {
  var attestation;
  try {
    attestation = JSON.parse(body);
  } catch (e) {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  var invitationCode = attestation.invitationCode || null;
  var challengeKey = invitationCode ? 'register:' + invitationCode : 'register:setup';
  var pending = pendingChallenges[challengeKey];
  if (!pending) {
    jsonResponse(res, 400, { error: 'No pending registration' });
    return;
  }
  delete pendingChallenges[challengeKey];

  // Re-validate the authorization against the pending challenge so a stale
  // entry can't bypass an expired invitation.
  if (invitationCode) {
    if (!invitations.validateInvitation(invitationCode)) {
      jsonResponse(res, 403, { error: 'Invitation expired' });
      return;
    }
  } else if (!credStore.isRegistrationOpen()) {
    jsonResponse(res, 403, { error: 'Registration not allowed' });
    return;
  }

  try {
    var verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: pending.challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      jsonResponse(res, 400, { error: 'Verification failed' });
      return;
    }

    // Persist the user only after a successful verification.
    if (credStore.findUserByName(pending.name)) {
      jsonResponse(res, 400, { error: 'A user with that name already exists' });
      return;
    }
    var newUser;
    try {
      newUser = credStore.createUser(pending.name, pending.role);
    } catch (err) {
      jsonResponse(res, 400, { error: err.message });
      return;
    }

    var info = verification.registrationInfo;
    credStore.addCredential({
      id: info.credential.id,
      userId: newUser.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: attestation.response.transports || [],
    });

    // Consume invitation if used
    if (invitationCode) {
      invitations.consumeInvitation(invitationCode);
      log.info('invitation consumed', { code: invitationCode });
    }

    // Close initial registration window after first credential
    credStore.closeRegistration();

    // Create session for the freshly registered user
    var newSession = credStore.createSession(newUser.id);
    session.setSessionCookie(res, newSession.token);

    log.info('passkey registered', { user: newUser.name, role: newUser.role });
    jsonResponse(res, 200, { verified: true, role: newUser.role });
  } catch (err) {
    log.error('register verify failed', { error: err.message });
    jsonResponse(res, 400, { error: 'Verification failed' });
  }
}

// ── POST /auth/login/options ──

async function handleLoginOptions(req, res) {
  var creds = credStore.getCredentials();
  if (creds.length === 0) {
    jsonResponse(res, 404, { error: 'No credentials registered' });
    return;
  }

  try {
    var options = await generateAuthenticationOptions({
      rpID: RPID,
      userVerification: 'preferred',
      allowCredentials: creds.map(function (c) {
        return { id: c.id, transports: c.transports };
      }),
    });

    pendingChallenges['login'] = options.challenge;
    jsonResponse(res, 200, options);
  } catch (err) {
    log.error('login options failed', { error: err.message });
    jsonResponse(res, 500, { error: 'Failed to generate options' });
  }
}

// ── POST /auth/login/verify ──

async function handleLoginVerify(req, res, body) {
  var challenge = pendingChallenges['login'];
  if (!challenge) {
    jsonResponse(res, 400, { error: 'No pending authentication' });
    return;
  }
  delete pendingChallenges['login'];

  try {
    var assertion = JSON.parse(body);
    var cred = credStore.getCredentialById(assertion.id);
    if (!cred) {
      jsonResponse(res, 401, { error: 'Authentication failed' });
      return;
    }

    var verification = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
      credential: {
        id: cred.id,
        publicKey: Buffer.from(cred.publicKey, 'base64url'),
        counter: cred.counter,
        transports: cred.transports,
      },
    });

    if (!verification.verified) {
      jsonResponse(res, 401, { error: 'Authentication failed' });
      return;
    }

    credStore.updateCredentialCounter(cred.id, verification.authenticationInfo.newCounter);

    var newSession = credStore.createSession(cred.userId);
    session.setSessionCookie(res, newSession.token);

    var user = credStore.getUserById(cred.userId);
    log.info('passkey login successful', { user: user && user.name, role: user && user.role });
    jsonResponse(res, 200, { verified: true, role: user && user.role });
  } catch (err) {
    log.error('login verify failed', { error: err.message });
    jsonResponse(res, 401, { error: 'Authentication failed' });
  }
}

// ── GET /auth/status ──

function handleStatus(req, res) {
  var sess = session.validateRequest(req);
  var creds = credStore.getCredentials();
  var regOpen = credStore.isRegistrationOpen();
  var user = sess && sess.userId ? credStore.getUserById(sess.userId) : null;

  jsonResponse(res, 200, {
    authenticated: !!sess,
    setupMode: creds.length === 0,
    registrationOpen: regOpen || (!!sess && user && user.role === credStore.ROLES.ADMIN),
    role: user ? user.role : null,
    name: user ? user.name : null,
  });
}

// ── POST /auth/logout ──

function handleLogout(req, res) {
  var token = session.getSessionToken(req);
  if (token) {
    credStore.removeSession(token);
  }
  session.clearSessionCookie(res);
  jsonResponse(res, 200, { ok: true });
}

module.exports = {
  init: init,
  handleRequest: handleRequest,
  validateRequest: session.validateRequest,
  getCurrentUser: getCurrentUser,
  requireAdmin: requireAdmin,
  requireUser: requireUser,
};
