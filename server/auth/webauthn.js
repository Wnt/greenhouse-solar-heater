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
const { buildDeviceDetails } = require('./device-info');
const userHandlers = require('./user-handlers');

const log = createLogger('webauthn');

const RPID = process.env.RPID || 'localhost';
const ORIGIN = process.env.ORIGIN || 'http://localhost:3000';
const RP_NAME = 'Helios Canopy';

// In-memory challenge store, keyed per-flow so concurrent users don't clash.
// 'login' is shared across the resident-key login flow (no user known yet),
// 'register:<code>' for invitation-driven registration, and
// 'register:setup' for the very first setup-window registration.
const pendingChallenges = {};

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
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || 'unknown';
}

function getClientUserAgent(req) {
  return req && req.headers ? (req.headers['user-agent'] || '') : '';
}

function buildCredentialMetadata(req) {
  const userAgent = getClientUserAgent(req);
  const device = buildDeviceDetails(userAgent);
  return {
    lastUsedAt: new Date().toISOString(),
    lastIp: getClientIp(req),
    lastUserAgent: userAgent,
    device,
    label: device.deviceName || device.summary || '',
  };
}

// Resolve the current authenticated user for a request, or null.
function getCurrentUser(req) {
  const sess = session.validateRequest(req);
  if (!sess) return null;
  if (!sess.userId) return null;
  return credStore.getUserById(sess.userId);
}

// Reject if the caller is not authenticated. Returns the user on success
// or null after writing the 401 response.
function requireUser(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    jsonResponse(res, 401, { error: 'Not authenticated' });
    return null;
  }
  return user;
}

// Reject if the caller is not an admin. Returns the user on success or
// null after writing the appropriate response.
function requireAdmin(req, res) {
  const user = requireUser(req, res);
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
    userHandlers.handleListUsers(req, res);
  } else if (req.method === 'POST' && urlPath === '/auth/users') {
    userHandlers.handleCreateUser(req, res, body);
  } else if (req.method === 'DELETE' && urlPath.indexOf('/auth/users/') === 0) {
    userHandlers.handleDeleteUser(req, res, urlPath);
  } else if ((req.method === 'PATCH' || req.method === 'PUT') && urlPath.indexOf('/auth/users/') === 0) {
    userHandlers.handleUpdateUser(req, res, urlPath, body);
  } else if ((req.method === 'PATCH' || req.method === 'PUT') && urlPath.indexOf('/auth/passkeys/') === 0) {
    userHandlers.handleUpdatePasskey(req, res, urlPath, body);
  } else if (req.method === 'DELETE' && urlPath.indexOf('/auth/passkeys/') === 0) {
    userHandlers.handleDeletePasskey(req, res, urlPath);
  } else {
    jsonResponse(res, 404, { error: 'Not found' });
  }
}

// ── POST /auth/invite/create ──

function handleInviteCreate(req, res, body) {
  const user = requireAdmin(req, res);
  if (!user) return;

  let parsed = {};
  if (body) {
    try { parsed = JSON.parse(body) || {}; } catch (e) { parsed = {}; }
  }
  const role = parsed.role === 'readonly' ? 'readonly' : 'admin';
  const name = (parsed.name && typeof parsed.name === 'string') ? parsed.name.trim() : '';
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

  const sessionToken = session.getSessionToken(req);
  const invite = invitations.createInvitation(sessionToken, { role, name });
  log.info('invitation created', { code: invite.code, role });
  jsonResponse(res, 200, invite);
}

// ── POST /auth/invite/validate ──

function handleInviteValidate(req, res, body) {
  const ip = getClientIp(req);
  if (!invitations.checkRateLimit(ip)) {
    jsonResponse(res, 429, { error: 'Too many attempts. Try again later.' });
    return;
  }
  invitations.recordAttempt(ip);

  let data;
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

  const invite = invitations.getInvitation(data.code);
  if (invite) {
    jsonResponse(res, 200, { valid: true, role: invite.role, name: invite.name });
  } else {
    jsonResponse(res, 400, { error: 'Invalid or expired invitation code' });
  }
}

// ── POST /auth/register/options ──

async function handleRegisterOptions(req, res, body) {
  let allowed = false;
  let registerAs = null; // { name, role, isSetup }
  let invitationCode = null;

  // Check 1: Registration window open (initial setup) — first user is admin
  if (credStore.isRegistrationOpen()) {
    allowed = true;
    registerAs = { name: 'admin', role: credStore.ROLES.ADMIN, isSetup: true };
  }

  // Check 2: Valid invitation code
  if (!allowed && body) {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
    if (parsed && parsed.invitationCode) {
      const ip = getClientIp(req);
      if (!invitations.checkRateLimit(ip)) {
        jsonResponse(res, 429, { error: 'Too many attempts. Try again later.' });
        return;
      }
      invitations.recordAttempt(ip);
      const invite = invitations.getInvitation(parsed.invitationCode);
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
  let name = registerAs.name || 'user';
  if (credStore.findUserByName(name)) {
    if (registerAs.isSetup) {
      let n = 1;
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
  const pendingUserId = crypto.randomBytes(32).toString('base64url');

  try {
    const options = await generateRegistrationOptions({
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
    const challengeKey = invitationCode ? 'register:' + invitationCode : 'register:setup';
    pendingChallenges[challengeKey] = {
      challenge: options.challenge,
      pendingUserId,
      name,
      role: registerAs.role,
      invitationCode,
    };
    jsonResponse(res, 200, options);
  } catch (err) {
    log.error('register options failed', { error: err.message });
    jsonResponse(res, 500, { error: 'Failed to generate options' });
  }
}

// ── POST /auth/register/verify ──

async function handleRegisterVerify(req, res, body) {
  let attestation;
  try {
    attestation = JSON.parse(body);
  } catch (e) {
    jsonResponse(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const invitationCode = attestation.invitationCode || null;
  const challengeKey = invitationCode ? 'register:' + invitationCode : 'register:setup';
  const pending = pendingChallenges[challengeKey];
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
    const verification = await verifyRegistrationResponse({
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
    let newUser;
    try {
      newUser = credStore.createUser(pending.name, pending.role);
    } catch (err) {
      jsonResponse(res, 400, { error: err.message });
      return;
    }

    const info = verification.registrationInfo;
    const metadata = buildCredentialMetadata(req);
    credStore.addCredential({
      id: info.credential.id,
      userId: newUser.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: attestation.response.transports || [],
      label: metadata.label,
      lastUsedAt: metadata.lastUsedAt,
      lastIp: metadata.lastIp,
      lastUserAgent: metadata.lastUserAgent,
      device: metadata.device,
    });

    // Consume invitation if used
    if (invitationCode) {
      invitations.consumeInvitation(invitationCode);
      log.info('invitation consumed', { code: invitationCode });
    }

    // Close initial registration window after first credential
    credStore.closeRegistration();

    // Create session for the freshly registered user
    const newSession = credStore.createSession(newUser.id, info.credential.id);
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
  const creds = credStore.getCredentials();
  if (creds.length === 0) {
    jsonResponse(res, 404, { error: 'No credentials registered' });
    return;
  }

  try {
    const options = await generateAuthenticationOptions({
      rpID: RPID,
      userVerification: 'preferred',
      allowCredentials: creds.map(function (c) {
        return { id: c.id, transports: c.transports };
      }),
    });

    pendingChallenges.login = options.challenge;
    jsonResponse(res, 200, options);
  } catch (err) {
    log.error('login options failed', { error: err.message });
    jsonResponse(res, 500, { error: 'Failed to generate options' });
  }
}

// ── POST /auth/login/verify ──

async function handleLoginVerify(req, res, body) {
  const challenge = pendingChallenges.login;
  if (!challenge) {
    jsonResponse(res, 400, { error: 'No pending authentication' });
    return;
  }
  delete pendingChallenges.login;

  try {
    const assertion = JSON.parse(body);
    const cred = credStore.getCredentialById(assertion.id);
    if (!cred) {
      jsonResponse(res, 401, { error: 'Authentication failed' });
      return;
    }

    const verification = await verifyAuthenticationResponse({
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
    credStore.touchCredential(cred.id, buildCredentialMetadata(req));

    const newSession = credStore.createSession(cred.userId, cred.id);
    session.setSessionCookie(res, newSession.token);

    const user = credStore.getUserById(cred.userId);
    log.info('passkey login successful', { user: user && user.name, role: user && user.role });
    jsonResponse(res, 200, { verified: true, role: user && user.role });
  } catch (err) {
    log.error('login verify failed', { error: err.message });
    jsonResponse(res, 401, { error: 'Authentication failed' });
  }
}

// ── GET /auth/status ──

function handleStatus(req, res) {
  const sess = session.validateRequest(req);
  const creds = credStore.getCredentials();
  const regOpen = credStore.isRegistrationOpen();
  const user = sess && sess.userId ? credStore.getUserById(sess.userId) : null;

  jsonResponse(res, 200, {
    authenticated: !!sess,
    setupMode: creds.length === 0,
    registrationOpen: regOpen || (!!sess && user && user.role === credStore.ROLES.ADMIN),
    role: user ? user.role : null,
    name: user ? user.name : null,
    userId: user ? user.id : null,
    credentialId: sess ? sess.credentialId || null : null,
  });
}

// ── POST /auth/logout ──

function handleLogout(req, res) {
  const token = session.getSessionToken(req);
  if (token) {
    credStore.removeSession(token);
  }
  session.clearSessionCookie(res);
  jsonResponse(res, 200, { ok: true });
}

module.exports = {
  init,
  handleRequest,
  validateRequest: session.validateRequest,
  getCurrentUser,
  requireAdmin,
  requireUser,
};
