/**
 * WebAuthn registration and authentication handlers.
 * Uses @simplewebauthn/server for cryptographic operations.
 * All endpoints per contracts/api.md.
 */

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
const RP_NAME = 'Shelly Monitor';

// In-memory challenge store (short-lived, per-request)
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

// ── Route handler ──

function getClientIp(req) {
  var forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress || 'unknown';
}

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
    handleInviteCreate(req, res);
  } else if (req.method === 'POST' && urlPath === '/auth/invite/validate') {
    handleInviteValidate(req, res, body);
  } else {
    jsonResponse(res, 404, { error: 'Not found' });
  }
}

// ── POST /auth/invite/create ──

function handleInviteCreate(req, res) {
  var sess = session.validateRequest(req);
  if (!sess) {
    jsonResponse(res, 401, { error: 'Not authenticated' });
    return;
  }
  var sessionToken = session.getSessionToken(req);
  var invite = invitations.createInvitation(sessionToken);
  log.info('invitation created', { code: invite.code });
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

  if (invitations.validateInvitation(data.code)) {
    jsonResponse(res, 200, { valid: true });
  } else {
    jsonResponse(res, 400, { error: 'Invalid or expired invitation code' });
  }
}

// ── POST /auth/register/options ──

async function handleRegisterOptions(req, res, body) {
  var allowed = false;

  // Check 1: Registration window open (initial setup)
  if (credStore.isRegistrationOpen()) {
    allowed = true;
  }

  // Check 2: Authenticated session
  if (!allowed) {
    var sess = session.validateRequest(req);
    if (sess) allowed = true;
  }

  // Check 3: Valid invitation code
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
      if (invitations.validateInvitation(parsed.invitationCode)) {
        allowed = true;
      }
    }
  }

  if (!allowed) {
    jsonResponse(res, 403, { error: 'Registration not allowed' });
    return;
  }

  var user = credStore.getUser() || credStore.createUser('admin');
  var existingCreds = credStore.getCredentials();

  try {
    var options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RPID,
      userName: user.name,
      userDisplayName: user.name,
      userID: Uint8Array.from(Buffer.from(user.id, 'base64url')),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
      },
      excludeCredentials: existingCreds.map(function (c) {
        return { id: c.id, transports: c.transports };
      }),
    });

    // Store challenge for verification
    pendingChallenges['register'] = options.challenge;
    jsonResponse(res, 200, options);
  } catch (err) {
    log.error('register options failed', { error: err.message });
    jsonResponse(res, 500, { error: 'Failed to generate options' });
  }
}

// ── POST /auth/register/verify ──

async function handleRegisterVerify(req, res, body) {
  var allowed = false;
  var invitationCode = null;

  // Check authorization (same logic as register/options)
  if (credStore.isRegistrationOpen()) {
    allowed = true;
  }
  if (!allowed) {
    var sess = session.validateRequest(req);
    if (sess) allowed = true;
  }
  // Check invitation code from body
  if (!allowed) {
    try {
      var parsed = JSON.parse(body);
      if (parsed && parsed.invitationCode) {
        invitationCode = parsed.invitationCode;
        if (invitations.validateInvitation(invitationCode)) {
          allowed = true;
        }
      }
    } catch (e) { /* will fail later during attestation parse */ }
  }
  if (!allowed) {
    jsonResponse(res, 403, { error: 'Registration not allowed' });
    return;
  }

  var challenge = pendingChallenges['register'];
  if (!challenge) {
    jsonResponse(res, 400, { error: 'No pending registration' });
    return;
  }
  delete pendingChallenges['register'];

  try {
    var attestation = JSON.parse(body);
    var verification = await verifyRegistrationResponse({
      response: attestation,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RPID,
    });

    if (!verification.verified || !verification.registrationInfo) {
      jsonResponse(res, 400, { error: 'Verification failed' });
      return;
    }

    var info = verification.registrationInfo;
    credStore.addCredential({
      id: info.credential.id,
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

    // Create session
    var newSession = credStore.createSession();
    session.setSessionCookie(res, newSession.token);

    log.info('passkey registered');
    jsonResponse(res, 200, { verified: true });
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

    var newSession = credStore.createSession();
    session.setSessionCookie(res, newSession.token);

    log.info('passkey login successful');
    jsonResponse(res, 200, { verified: true });
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

  jsonResponse(res, 200, {
    authenticated: !!sess,
    setupMode: creds.length === 0,
    registrationOpen: regOpen || (!!sess && creds.length > 0),
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
};
