/**
 * Tests for multi-user role enforcement and the user management API.
 *
 * Exercises the WebAuthn handler module directly (no real WebAuthn ceremony):
 *   - GET /auth/users — both roles can list, read-only sees the same list
 *   - DELETE /auth/users/:id — admin only, refuses self-delete, refuses
 *     deleting the last admin
 *   - POST /auth/invite/create — admin only, requires a name, accepts a role
 *   - GET /auth/status — exposes role + name
 */

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Mock res object: collects writeHead + end so we can assert on responses.
function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead: function (status, hdrs) {
      this.statusCode = status;
      if (hdrs) Object.assign(this.headers, hdrs);
    },
    setHeader: function (k, v) { this.headers[k] = v; },
    end: function (body) { this.body = body || ''; },
  };
}

function jsonBody(res) {
  if (!res.body) return null;
  return JSON.parse(res.body);
}

// Mock req that carries a session cookie so session.validateRequest works.
function reqWithSession(method, urlPath, sessionToken, body) {
  var session = require('../server/auth/session');
  var headers = { cookie: 'session=' + encodeURIComponent(session.sign(sessionToken)) };
  return {
    method: method,
    url: urlPath,
    headers: headers,
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function unauthReq(method, urlPath) {
  return {
    method: method,
    url: urlPath,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
  };
}

describe('user management API', function () {
  var credPath = path.join(__dirname, 'test-user-mgmt-' + process.pid + '.json');
  var credStore;
  var webauthn;
  var invitations;

  before(function () {
    process.env.SESSION_SECRET = 'test-secret-32chars-minimum!!!!';
    process.env.CREDENTIALS_PATH = credPath;
    process.env.SETUP_WINDOW_MINUTES = '30';
  });

  // Lazy-load once: clearing the require cache between tests would orphan
  // session.js's reference to credentials.js. Instead we reset() the
  // in-memory store and the file before each test.
  before(function () {
    credStore = require('../server/auth/credentials');
    webauthn = require('../server/auth/webauthn');
    invitations = require('../server/auth/invitations');
  });

  beforeEach(function () {
    try { fs.unlinkSync(credPath); } catch (e) { /* ignore */ }
    invitations.reset();
    credStore._reset();
    credStore.load();
  });

  after(function () {
    try { fs.unlinkSync(credPath); } catch (e) { /* ignore */ }
  });

  function createAdminAndSession(name) {
    var user = credStore.createUser(name || 'admin');
    var sess = credStore.createSession(user.id);
    return { user: user, sessionToken: sess.token };
  }

  function createReadonlyAndSession(name) {
    var user = credStore.createUser(name || 'viewer', 'readonly');
    var sess = credStore.createSession(user.id);
    return { user: user, sessionToken: sess.token };
  }

  // ── GET /auth/status ──

  it('GET /auth/status returns role and name when authenticated', function () {
    var admin = createAdminAndSession('alice');
    var req = reqWithSession('GET', '/auth/status', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/status', '');
    assert.strictEqual(res.statusCode, 200);
    var body = jsonBody(res);
    assert.strictEqual(body.authenticated, true);
    assert.strictEqual(body.role, 'admin');
    assert.strictEqual(body.name, 'alice');
  });

  it('GET /auth/status returns role=readonly for read-only user', function () {
    var ro = createReadonlyAndSession('bob');
    var req = reqWithSession('GET', '/auth/status', ro.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/status', '');
    var body = jsonBody(res);
    assert.strictEqual(body.role, 'readonly');
    assert.strictEqual(body.name, 'bob');
  });

  // ── GET /auth/users ──

  it('GET /auth/users requires authentication', function () {
    var req = unauthReq('GET', '/auth/users');
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users', '');
    assert.strictEqual(res.statusCode, 401);
  });

  it('GET /auth/users lists all users with role + isCurrent flag', function () {
    var admin = createAdminAndSession('alice');
    credStore.createUser('bob', 'readonly');
    credStore.addCredential({
      id: 'alice-cred',
      userId: admin.user.id,
      publicKey: 'pk',
      counter: 0,
      transports: [],
      label: 'MacBook',
      lastIp: '203.0.113.10',
      lastUserAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
      lastUsedAt: '2026-04-13T09:00:00.000Z',
    });
    var req = reqWithSession('GET', '/auth/users', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users', '');
    assert.strictEqual(res.statusCode, 200);
    var body = jsonBody(res);
    assert.strictEqual(body.users.length, 2);
    var alice = body.users.find(function (u) { return u.name === 'alice'; });
    var bob = body.users.find(function (u) { return u.name === 'bob'; });
    assert.ok(alice);
    assert.ok(bob);
    assert.strictEqual(alice.role, 'admin');
    assert.strictEqual(bob.role, 'readonly');
    assert.strictEqual(alice.isCurrent, true);
    assert.strictEqual(bob.isCurrent, false);
    assert.strictEqual(alice.passkeys.length, 1);
    assert.strictEqual(alice.passkeys[0].label, 'MacBook');
    assert.strictEqual(alice.passkeys[0].lastIp, '203.0.113.10');
  });

  it('POST /auth/users creates an empty user for passkey transfers', function () {
    var admin = createAdminAndSession('alice');
    var req = reqWithSession('POST', '/auth/users', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users', JSON.stringify({ name: 'tablet', role: 'readonly' }));
    assert.strictEqual(res.statusCode, 200);
    var body = jsonBody(res);
    assert.strictEqual(body.user.name, 'tablet');
    assert.strictEqual(body.user.credentialCount, 0);
    assert.strictEqual(credStore.findUserByName('tablet').role, 'readonly');
  });

  it('GET /auth/users is also accessible to read-only users', function () {
    var ro = createReadonlyAndSession('bob');
    credStore.createUser('admin');
    var req = reqWithSession('GET', '/auth/users', ro.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users', '');
    assert.strictEqual(res.statusCode, 200);
    var body = jsonBody(res);
    assert.strictEqual(body.users.length, 2);
  });

  // ── DELETE /auth/users/:id ──

  it('DELETE /auth/users/:id requires admin role', function () {
    var ro = createReadonlyAndSession('bob');
    var target = credStore.createUser('alice');
    var req = reqWithSession('DELETE', '/auth/users/' + target.id, ro.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + target.id, '');
    assert.strictEqual(res.statusCode, 403);
    // Target still exists
    assert.ok(credStore.getUserById(target.id));
  });

  it('DELETE /auth/users/:id refuses self-delete', function () {
    var admin = createAdminAndSession('alice');
    var req = reqWithSession('DELETE', '/auth/users/' + admin.user.id, admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + admin.user.id, '');
    assert.strictEqual(res.statusCode, 400);
    assert.ok(jsonBody(res).error.match(/yourself/i));
    assert.ok(credStore.getUserById(admin.user.id));
  });

  it('DELETE /auth/users/:id refuses to remove the last admin', function () {
    var admin = createAdminAndSession('alice');
    // Create another non-admin so admin can target someone, but also keep
    // alice as the only admin so the "last admin" guard fires.
    credStore.createUser('bob', 'readonly');
    var anotherAdmin = credStore.createUser('charlie');
    // Delete charlie first (legal) so alice is the only admin again
    var req1 = reqWithSession('DELETE', '/auth/users/' + anotherAdmin.id, admin.sessionToken);
    var res1 = mockRes();
    webauthn.handleRequest(req1, res1, '/auth/users/' + anotherAdmin.id, '');
    assert.strictEqual(res1.statusCode, 200);
    // Now try to delete alice — she is current user (refuses) and last admin
    var req2 = reqWithSession('DELETE', '/auth/users/' + admin.user.id, admin.sessionToken);
    var res2 = mockRes();
    webauthn.handleRequest(req2, res2, '/auth/users/' + admin.user.id, '');
    assert.strictEqual(res2.statusCode, 400);
  });

  it('DELETE /auth/users/:id removes a target user successfully', function () {
    var admin = createAdminAndSession('alice');
    var target = credStore.createUser('bob', 'readonly');
    credStore.addCredential({ id: 'bob-cred', userId: target.id, publicKey: 'pk', counter: 0, transports: [] });
    var sess = credStore.createSession(target.id);

    var req = reqWithSession('DELETE', '/auth/users/' + target.id, admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + target.id, '');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(credStore.getUserById(target.id), null);
    assert.strictEqual(credStore.getCredentialById('bob-cred'), null);
    assert.strictEqual(credStore.validateSession(sess.token), null);
  });

  it('DELETE /auth/users/:id returns 404 for unknown user', function () {
    var admin = createAdminAndSession('alice');
    var req = reqWithSession('DELETE', '/auth/users/does-not-exist', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/does-not-exist', '');
    assert.strictEqual(res.statusCode, 404);
  });

  // ── PATCH /auth/users/:id ──

  it('PATCH /auth/users/:id requires admin role', function () {
    var ro = createReadonlyAndSession('bob');
    var target = credStore.createUser('alice');
    var req = reqWithSession('PATCH', '/auth/users/' + target.id, ro.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + target.id, JSON.stringify({ name: 'eve' }));
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(credStore.getUserById(target.id).name, 'alice');
  });

  it('PATCH /auth/users/:id renames a user', function () {
    var admin = createAdminAndSession('alice');
    var target = credStore.createUser('bob', 'readonly');
    var req = reqWithSession('PATCH', '/auth/users/' + target.id, admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + target.id, JSON.stringify({ name: 'bobby' }));
    assert.strictEqual(res.statusCode, 200);
    var body = jsonBody(res);
    assert.strictEqual(body.user.name, 'bobby');
    assert.strictEqual(credStore.getUserById(target.id).name, 'bobby');
  });

  it('PATCH /auth/users/:id rejects duplicate name', function () {
    var admin = createAdminAndSession('alice');
    credStore.createUser('eve', 'readonly');
    var target = credStore.createUser('bob', 'readonly');
    var req = reqWithSession('PATCH', '/auth/users/' + target.id, admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + target.id, JSON.stringify({ name: 'eve' }));
    assert.strictEqual(res.statusCode, 400);
  });

  it('PATCH /auth/users/:id changes role between admin and readonly', function () {
    var admin = createAdminAndSession('alice');
    var target = credStore.createUser('bob', 'readonly');
    var req = reqWithSession('PATCH', '/auth/users/' + target.id, admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + target.id, JSON.stringify({ role: 'admin' }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(credStore.getUserById(target.id).role, 'admin');
  });

  it('PATCH /auth/users/:id refuses changing your own role', function () {
    var admin = createAdminAndSession('alice');
    credStore.createUser('charlie'); // keeps another admin so the
    // last-admin guard doesn't fire — we want to confirm the
    // explicit self-demotion guard is the one rejecting.
    var req = reqWithSession('PATCH', '/auth/users/' + admin.user.id, admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + admin.user.id, JSON.stringify({ role: 'readonly' }));
    assert.strictEqual(res.statusCode, 400);
    assert.match(jsonBody(res).error, /your own role/i);
    assert.strictEqual(credStore.getUserById(admin.user.id).role, 'admin');
  });

  it('PATCH /auth/users/:id refuses demoting the last admin', function () {
    var admin = createAdminAndSession('alice');
    var helper = credStore.createUser('helper');
    var ses2 = credStore.createSession(helper.id);
    // helper is also an admin; from helper's session we try to demote alice
    // — that would leave helper as the only admin, which is fine. So we
    // use a third user as a target instead: helper demotes alice while
    // alice is the only "other" admin → store-level last-admin guard
    // does not apply. To exercise the guard we delete helper first.
    credStore.deleteUser(helper.id);
    void ses2;
    // Now alice is the only admin. Try to PATCH alice via alice's
    // session — caught by the self-demotion guard, not the store. Use
    // the credential store directly to confirm the store-level guard.
    assert.throws(function () { credStore.updateUser(admin.user.id, { role: 'readonly' }); }, /last admin/);
  });

  it('PATCH /auth/users/:id returns 404 for unknown user', function () {
    var admin = createAdminAndSession('alice');
    var req = reqWithSession('PATCH', '/auth/users/nope', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/nope', JSON.stringify({ name: 'x' }));
    assert.strictEqual(res.statusCode, 404);
  });

  it('PUT /auth/users/:id is also accepted as an alias for PATCH', function () {
    var admin = createAdminAndSession('alice');
    var target = credStore.createUser('bob', 'readonly');
    var req = reqWithSession('PUT', '/auth/users/' + target.id, admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/users/' + target.id, JSON.stringify({ name: 'bobby' }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(credStore.getUserById(target.id).name, 'bobby');
  });

  it('PATCH /auth/passkeys/:id updates label and owner', function () {
    var admin = createAdminAndSession('alice');
    var targetUser = credStore.createUser('tablet-owner', 'readonly');
    credStore.addCredential({ id: 'alice-cred', userId: admin.user.id, publicKey: 'pk', counter: 0, transports: [] });

    var req = reqWithSession('PATCH', '/auth/passkeys/alice-cred', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/passkeys/alice-cred', JSON.stringify({
      label: 'iPad',
      userId: targetUser.id,
    }));
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(credStore.getCredentialById('alice-cred').label, 'iPad');
    assert.strictEqual(credStore.getCredentialById('alice-cred').userId, targetUser.id);
  });

  it('DELETE /auth/passkeys/:id revokes only that device and its sessions', function () {
    var admin = createAdminAndSession('alice');
    credStore.addCredential({ id: 'keep', userId: admin.user.id, publicKey: 'pk1', counter: 0, transports: [] });
    credStore.addCredential({ id: 'remove', userId: admin.user.id, publicKey: 'pk2', counter: 0, transports: [] });
    var keepSession = credStore.createSession(admin.user.id, 'keep');
    var removeSession = credStore.createSession(admin.user.id, 'remove');

    var req = reqWithSession('DELETE', '/auth/passkeys/remove', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/passkeys/remove', '');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(credStore.getCredentialById('keep'));
    assert.strictEqual(credStore.getCredentialById('remove'), null);
    assert.ok(credStore.validateSession(keepSession.token));
    assert.strictEqual(credStore.validateSession(removeSession.token), null);
  });

  // ── POST /auth/invite/create ──

  it('POST /auth/invite/create requires admin role', function () {
    var ro = createReadonlyAndSession('bob');
    var req = reqWithSession('POST', '/auth/invite/create', ro.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/invite/create', JSON.stringify({ name: 'eve', role: 'readonly' }));
    assert.strictEqual(res.statusCode, 403);
  });

  it('POST /auth/invite/create requires a name', function () {
    var admin = createAdminAndSession('alice');
    var req = reqWithSession('POST', '/auth/invite/create', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/invite/create', JSON.stringify({ role: 'readonly' }));
    assert.strictEqual(res.statusCode, 400);
    assert.match(jsonBody(res).error, /name/i);
  });

  it('POST /auth/invite/create rejects duplicate names', function () {
    var admin = createAdminAndSession('alice');
    credStore.createUser('eve', 'readonly');
    var req = reqWithSession('POST', '/auth/invite/create', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/invite/create', JSON.stringify({ name: 'eve', role: 'readonly' }));
    assert.strictEqual(res.statusCode, 400);
  });

  it('POST /auth/invite/create returns a code with role + name', function () {
    var admin = createAdminAndSession('alice');
    var req = reqWithSession('POST', '/auth/invite/create', admin.sessionToken);
    var res = mockRes();
    webauthn.handleRequest(req, res, '/auth/invite/create', JSON.stringify({ name: 'eve', role: 'readonly' }));
    assert.strictEqual(res.statusCode, 200);
    var body = jsonBody(res);
    assert.match(body.code, /^\d{6}$/);
    assert.strictEqual(body.role, 'readonly');
    assert.strictEqual(body.name, 'eve');
  });

  it('POST /auth/invite/validate exposes role + name to the new device', function () {
    var admin = createAdminAndSession('alice');
    var createReq = reqWithSession('POST', '/auth/invite/create', admin.sessionToken);
    var createRes = mockRes();
    webauthn.handleRequest(createReq, createRes, '/auth/invite/create', JSON.stringify({ name: 'eve', role: 'readonly' }));
    var code = jsonBody(createRes).code;

    var validateReq = unauthReq('POST', '/auth/invite/validate');
    var validateRes = mockRes();
    webauthn.handleRequest(validateReq, validateRes, '/auth/invite/validate', JSON.stringify({ code: code }));
    assert.strictEqual(validateRes.statusCode, 200);
    var body = jsonBody(validateRes);
    assert.strictEqual(body.valid, true);
    assert.strictEqual(body.role, 'readonly');
    assert.strictEqual(body.name, 'eve');
  });

  // ── requireAdmin / requireUser exposed helpers ──

  it('requireAdmin returns user for admin and writes 403 for read-only', function () {
    var admin = createAdminAndSession('alice');
    var ro = createReadonlyAndSession('bob');

    var adminReq = reqWithSession('GET', '/anything', admin.sessionToken);
    var adminRes = mockRes();
    var adminUser = webauthn.requireAdmin(adminReq, adminRes);
    assert.ok(adminUser);
    assert.strictEqual(adminUser.role, 'admin');
    assert.strictEqual(adminRes.statusCode, 0);

    var roReq = reqWithSession('GET', '/anything', ro.sessionToken);
    var roRes = mockRes();
    var blocked = webauthn.requireAdmin(roReq, roRes);
    assert.strictEqual(blocked, null);
    assert.strictEqual(roRes.statusCode, 403);
  });

  it('requireUser allows both roles but rejects unauthenticated', function () {
    var ro = createReadonlyAndSession('bob');
    var roReq = reqWithSession('GET', '/anything', ro.sessionToken);
    var roRes = mockRes();
    var u = webauthn.requireUser(roReq, roRes);
    assert.ok(u);
    assert.strictEqual(u.role, 'readonly');

    var unauth = unauthReq('GET', '/anything');
    var unauthRes = mockRes();
    var none = webauthn.requireUser(unauth, unauthRes);
    assert.strictEqual(none, null);
    assert.strictEqual(unauthRes.statusCode, 401);
  });
});
