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

function handleRequest(req, res, urlPath, body) {
  if (req.method === 'POST' && urlPath === '/auth/register/options') {
    handleRegisterOptions(req, res);
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
  } else {
    jsonResponse(res, 404, { error: 'Not found' });
  }
}

// ── POST /auth/register/options ──

async function handleRegisterOptions(req, res) {
  if (!credStore.isRegistrationOpen()) {
    // Allow additional passkey registration if authenticated
    var sess = session.validateRequest(req);
    if (!sess) {
      jsonResponse(res, 403, { error: 'Registration window closed' });
      return;
    }
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
  if (!credStore.isRegistrationOpen()) {
    var sess = session.validateRequest(req);
    if (!sess) {
      jsonResponse(res, 403, { error: 'Registration window closed' });
      return;
    }
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
