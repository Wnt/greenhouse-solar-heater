/**
 * Unit tests for auth modules: session signing and credential store.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ── Session module tests ──

describe('session', function () {
  // Set env before requiring module
  before(function () {
    process.env.SESSION_SECRET = 'test-secret-32chars-minimum!!!!';
  });

  const session = require('../server/auth/session');

  it('sign produces token.signature format', function () {
    var signed = session.sign('test-token');
    assert.ok(signed.includes('.'), 'should contain a dot separator');
    var parts = signed.split('.');
    assert.strictEqual(parts[0], 'test-token');
    assert.strictEqual(parts[1].length, 64, 'HMAC-SHA256 hex should be 64 chars');
  });

  it('verify returns token for valid signature', function () {
    var signed = session.sign('my-token');
    var result = session.verify(signed);
    assert.strictEqual(result, 'my-token');
  });

  it('verify returns null for tampered signature', function () {
    var signed = session.sign('my-token');
    var tampered = signed.slice(0, -1) + 'x';
    assert.strictEqual(session.verify(tampered), null);
  });

  it('verify returns null for missing input', function () {
    assert.strictEqual(session.verify(null), null);
    assert.strictEqual(session.verify(undefined), null);
    assert.strictEqual(session.verify(''), null);
  });

  it('verify returns null for input without dot', function () {
    assert.strictEqual(session.verify('no-dot-here'), null);
  });

  it('parseCookies extracts key=value pairs', function () {
    var req = { headers: { cookie: 'session=abc; other=xyz' } };
    var cookies = session.parseCookies(req);
    assert.strictEqual(cookies.session, 'abc');
    assert.strictEqual(cookies.other, 'xyz');
  });

  it('parseCookies handles missing cookie header', function () {
    var req = { headers: {} };
    var cookies = session.parseCookies(req);
    assert.deepStrictEqual(cookies, {});
  });
});

// ── Credential store tests ──

describe('credential store', function () {
  var credPath = path.join(__dirname, 'test-credentials-' + process.pid + '.json');

  before(function () {
    process.env.CREDENTIALS_PATH = credPath;
    process.env.SETUP_WINDOW_MINUTES = '30';
  });

  beforeEach(function () {
    // Clean up and re-require
    try { fs.unlinkSync(credPath); } catch (e) { /* ignore */ }
    // Clear module cache to get fresh store
    delete require.cache[require.resolve('../server/auth/credentials')];
  });

  after(function () {
    try { fs.unlinkSync(credPath); } catch (e) { /* ignore */ }
  });

  it('starts with empty store when no file exists', function () {
    var store = require('../server/auth/credentials');
    store.load();
    assert.strictEqual(store.getUser(), null);
    assert.deepStrictEqual(store.getCredentials(), []);
  });

  it('createUser creates a user with random id', function () {
    var store = require('../server/auth/credentials');
    store.load();
    var user = store.createUser('admin');
    assert.strictEqual(user.name, 'admin');
    assert.ok(user.id.length > 0);
  });

  it('createUser returns existing user on second call', function () {
    var store = require('../server/auth/credentials');
    store.load();
    var first = store.createUser('admin');
    var second = store.createUser('other');
    assert.strictEqual(first.id, second.id);
    assert.strictEqual(second.name, 'admin');
  });

  it('addCredential and getCredentialById work', function () {
    var store = require('../server/auth/credentials');
    store.load();
    store.addCredential({
      id: 'cred-123',
      publicKey: 'pk-abc',
      counter: 0,
      transports: ['internal'],
    });
    var found = store.getCredentialById('cred-123');
    assert.ok(found);
    assert.strictEqual(found.publicKey, 'pk-abc');
    assert.strictEqual(found.counter, 0);
  });

  it('updateCredentialCounter updates counter', function () {
    var store = require('../server/auth/credentials');
    store.load();
    store.addCredential({ id: 'cred-1', publicKey: 'pk', counter: 5, transports: [] });
    store.updateCredentialCounter('cred-1', 10);
    assert.strictEqual(store.getCredentialById('cred-1').counter, 10);
  });

  it('createSession and validateSession work', function () {
    var store = require('../server/auth/credentials');
    store.load();
    var sess = store.createSession();
    assert.ok(sess.token);
    assert.ok(sess.createdAt);
    assert.ok(sess.expiresAt);
    var valid = store.validateSession(sess.token);
    assert.ok(valid, 'session should be valid');
  });

  it('validateSession returns null for unknown token', function () {
    var store = require('../server/auth/credentials');
    store.load();
    assert.strictEqual(store.validateSession('nonexistent'), null);
  });

  it('removeSession deletes a session', function () {
    var store = require('../server/auth/credentials');
    store.load();
    var sess = store.createSession();
    store.removeSession(sess.token);
    assert.strictEqual(store.validateSession(sess.token), null);
  });

  it('isRegistrationOpen returns true initially', function () {
    var store = require('../server/auth/credentials');
    store.load();
    assert.strictEqual(store.isRegistrationOpen(), true);
  });

  it('isRegistrationOpen returns false after adding credential', function () {
    var store = require('../server/auth/credentials');
    store.load();
    store.initSetup();
    store.addCredential({ id: 'c1', publicKey: 'pk', counter: 0, transports: [] });
    assert.strictEqual(store.isRegistrationOpen(), false);
  });

  it('closeRegistration closes the window', function () {
    var store = require('../server/auth/credentials');
    store.load();
    store.initSetup();
    store.closeRegistration();
    // Even though no credentials exist, window is closed
    // (isRegistrationOpen checks credentials first, so we need to test with empty creds)
    var setup = store.getSetupState();
    assert.strictEqual(setup.registrationOpen, false);
  });

  it('persists data to JSON file', function () {
    var store = require('../server/auth/credentials');
    store.load();
    store.createUser('test');
    store.addCredential({ id: 'persist-test', publicKey: 'pk', counter: 1, transports: [] });

    // Read file directly
    var raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    assert.strictEqual(raw.user.name, 'test');
    assert.strictEqual(raw.credentials.length, 1);
    assert.strictEqual(raw.credentials[0].id, 'persist-test');
  });

  it('removeSession is idempotent for unknown tokens', function () {
    var store = require('../server/auth/credentials');
    store.load();
    // Should not throw when removing a token that doesn't exist
    store.removeSession('nonexistent-token');
    assert.strictEqual(store.validateSession('nonexistent-token'), null);
  });

  it('clearSessionCookie sets Max-Age=0', function () {
    var session = require('../server/auth/session');
    var headers = {};
    var res = { setHeader: function (k, v) { headers[k] = v; } };
    session.clearSessionCookie(res);
    assert.ok(headers['Set-Cookie'], 'should set Set-Cookie header');
    assert.ok(headers['Set-Cookie'].includes('Max-Age=0'), 'should set Max-Age=0');
    assert.ok(headers['Set-Cookie'].includes('session=;') || headers['Set-Cookie'].startsWith('session=;'), 'should clear session value');
  });

  it('logout flow: create session, remove it, validate returns null', function () {
    var store = require('../server/auth/credentials');
    store.load();
    var sess = store.createSession();
    assert.ok(store.validateSession(sess.token), 'session should be valid before logout');
    store.removeSession(sess.token);
    assert.strictEqual(store.validateSession(sess.token), null, 'session should be invalid after logout');
  });

  it('expireSessions removes expired sessions', function () {
    var store = require('../server/auth/credentials');
    store.load();
    var sess = store.createSession();

    // Manually set expiry to the past
    var raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    raw.sessions[0].expiresAt = '2020-01-01T00:00:00.000Z';
    fs.writeFileSync(credPath, JSON.stringify(raw));

    // Re-load and expire
    delete require.cache[require.resolve('../server/auth/credentials')];
    var store2 = require('../server/auth/credentials');
    store2.load();
    store2.expireSessions();
    assert.strictEqual(store2.validateSession(sess.token), null);
  });
});

// ── Invitation tests ──

describe('invitations', function () {
  var inv = require('../server/auth/invitations');

  beforeEach(function () {
    inv.reset();
  });

  it('createInvitation returns a 6-digit code with expiry', function () {
    var invite = inv.createInvitation('session-1');
    assert.ok(invite.code, 'should have a code');
    assert.strictEqual(invite.code.length, 6, 'code should be 6 digits');
    assert.ok(/^\d{6}$/.test(invite.code), 'code should be all digits');
    assert.ok(invite.expiresAt, 'should have expiresAt');
    assert.strictEqual(invite.expiresInSeconds, 300, 'should expire in 300s');
  });

  it('validateInvitation returns true for valid code', function () {
    var invite = inv.createInvitation('session-1');
    assert.strictEqual(inv.validateInvitation(invite.code), true);
  });

  it('validateInvitation returns false for nonexistent code', function () {
    assert.strictEqual(inv.validateInvitation('000000'), false);
  });

  it('validateInvitation returns false for expired code', function () {
    var invite = inv.createInvitation('session-1');
    // Manually expire it
    var active = inv._getActiveInvitations();
    active[invite.code].expiresAt = Date.now() - 1000;
    assert.strictEqual(inv.validateInvitation(invite.code), false);
  });

  it('consumeInvitation deletes the code', function () {
    var invite = inv.createInvitation('session-1');
    assert.strictEqual(inv.consumeInvitation(invite.code), true);
    assert.strictEqual(inv.validateInvitation(invite.code), false);
  });

  it('consumeInvitation returns false for nonexistent code', function () {
    assert.strictEqual(inv.consumeInvitation('999999'), false);
  });

  it('creating new invitation invalidates previous one from same session', function () {
    var invite1 = inv.createInvitation('session-1');
    var invite2 = inv.createInvitation('session-1');
    assert.notStrictEqual(invite1.code, invite2.code);
    assert.strictEqual(inv.validateInvitation(invite1.code), false);
    assert.strictEqual(inv.validateInvitation(invite2.code), true);
  });

  it('invitations from different sessions coexist', function () {
    var invite1 = inv.createInvitation('session-1');
    var invite2 = inv.createInvitation('session-2');
    assert.strictEqual(inv.validateInvitation(invite1.code), true);
    assert.strictEqual(inv.validateInvitation(invite2.code), true);
  });

  it('cleanExpired removes expired invitations', function () {
    var invite = inv.createInvitation('session-1');
    var active = inv._getActiveInvitations();
    active[invite.code].expiresAt = Date.now() - 1000;
    inv.cleanExpired();
    assert.strictEqual(Object.keys(active).length, 0);
  });
});

// ── Rate limiting tests ──

describe('rate limiting', function () {
  var inv = require('../server/auth/invitations');

  beforeEach(function () {
    inv.reset();
  });

  it('allows first 5 attempts from same IP', function () {
    for (var i = 0; i < 5; i++) {
      assert.strictEqual(inv.checkRateLimit('1.2.3.4'), true, 'attempt ' + (i + 1) + ' should be allowed');
      inv.recordAttempt('1.2.3.4');
    }
  });

  it('blocks 6th attempt from same IP', function () {
    for (var i = 0; i < 5; i++) {
      inv.recordAttempt('1.2.3.4');
    }
    assert.strictEqual(inv.checkRateLimit('1.2.3.4'), false);
  });

  it('allows attempts from different IPs independently', function () {
    for (var i = 0; i < 5; i++) {
      inv.recordAttempt('1.2.3.4');
    }
    assert.strictEqual(inv.checkRateLimit('1.2.3.4'), false);
    assert.strictEqual(inv.checkRateLimit('5.6.7.8'), true);
  });

  it('allows attempts after old entries expire', function () {
    // Manually insert old attempts
    var limits = inv._getRateLimits();
    limits['1.2.3.4'] = {
      attempts: [
        Date.now() - 70000, // 70s ago (expired)
        Date.now() - 65000,
        Date.now() - 62000,
        Date.now() - 61000,
        Date.now() - 60500,
      ],
    };
    // All attempts are older than 60s, so should be pruned
    assert.strictEqual(inv.checkRateLimit('1.2.3.4'), true);
  });

  it('cleanExpired removes stale rate limit entries', function () {
    var limits = inv._getRateLimits();
    limits['1.2.3.4'] = { attempts: [Date.now() - 70000] };
    inv.cleanExpired();
    assert.strictEqual(limits['1.2.3.4'], undefined);
  });
});
