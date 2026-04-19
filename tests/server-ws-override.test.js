/**
 * Unit tests for the override-set-mode WebSocket command and the
 * forcedMode field added to existing override-ack responses.
 *
 * These tests require server.js directly (which exports handleWsCommand
 * for testing) and use the real device-config module, patching
 * mqttBridge.publishConfig to avoid network calls.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeFakeWs(opts) {
  return {
    _role: opts.role,
    _sent: [],
    readyState: 1,
    send: function (s) { this._sent.push(JSON.parse(s)); },
  };
}

function sent(ws) {
  return ws._sent;
}

// ── Module-scoped vars (set in beforeEach) ────────────────────────────────────

var tmpDir;
var deviceConfig;
var serverModule;
var mqttBridge;

// Shared beforeEach / afterEach setup for both describe blocks
function sharedSetup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-ws-override-test-'));
  process.env.DEVICE_CONFIG_PATH = path.join(tmpDir, 'device-config.json');

  // Clear S3 env vars to force local file mode
  delete process.env.S3_ENDPOINT;
  delete process.env.S3_BUCKET;
  delete process.env.S3_ACCESS_KEY_ID;
  delete process.env.S3_SECRET_ACCESS_KEY;
  // Disable MQTT so server.js does not try to connect on startup
  delete process.env.MQTT_HOST;

  // Clear caches so fresh modules pick up new DEVICE_CONFIG_PATH
  delete require.cache[require.resolve('../server/lib/device-config.js')];
  delete require.cache[require.resolve('../server/lib/notifications.js')];
  delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
  delete require.cache[require.resolve('../server/server.js')];

  serverModule = require('../server/server.js');

  // Grab the instances that server.js is using from the shared module cache
  deviceConfig = require('../server/lib/device-config.js');
  mqttBridge = require('../server/lib/mqtt-bridge.js');

  // Patch publishConfig to a no-op (no MQTT connection in tests)
  mqttBridge.publishConfig = function () {};

  deviceConfig._reset();
}

function sharedTeardown() {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  delete process.env.DEVICE_CONFIG_PATH;
}

// ── override-set-mode tests ───────────────────────────────────────────────────

describe('override-set-mode WS command', () => {
  beforeEach(sharedSetup);
  afterEach(sharedTeardown);

  it('requires admin role', (t, done) => {
    var ws = makeFakeWs({ role: 'readonly' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-set-mode', mode: 'SC' }));
    var last = sent(ws).pop();
    assert.strictEqual(last.type, 'override-error');
    assert.match(last.message, /Admin role required/);
    done();
  });

  it('rejects when override is not active', (t, done) => {
    deviceConfig._reset();
    var ws = makeFakeWs({ role: 'admin' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-set-mode', mode: 'SC' }));
    var last = sent(ws).pop();
    assert.strictEqual(last.type, 'override-error');
    assert.match(last.message, /Override not active/);
    done();
  });

  it('rejects banned modes', (t, done) => {
    deviceConfig._reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false }, wb: { SC: 9999999999 }, we: {}, wz: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-set-mode', mode: 'SC' }));
    var last = sent(ws).pop();
    assert.strictEqual(last.type, 'override-error');
    assert.match(last.message, /Mode banned/);
    done();
  });

  it('rejects unknown mode codes', (t, done) => {
    deviceConfig._reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false }, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-set-mode', mode: 'XX' }));
    var last = sent(ws).pop();
    assert.strictEqual(last.type, 'override-error');
    assert.match(last.message, /mo\.fm/);
    done();
  });

  it('sets mo.fm and acks on success', (t, done) => {
    deviceConfig._reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false }, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-set-mode', mode: 'SC' }));
    // updateConfig is async (calls save); wait for callback via setImmediate
    setImmediate(function () {
      var ack = sent(ws).pop();
      assert.strictEqual(ack.type, 'override-ack');
      assert.strictEqual(ack.forcedMode, 'SC');
      assert.strictEqual(deviceConfig.getConfig().mo.fm, 'SC');
      done();
    });
  });

  it('clears mo.fm when mode is null', (t, done) => {
    deviceConfig._reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-set-mode', mode: null }));
    setImmediate(function () {
      var ack = sent(ws).pop();
      assert.strictEqual(ack.type, 'override-ack');
      assert.strictEqual(ack.forcedMode, null);
      assert.strictEqual(deviceConfig.getConfig().mo.fm, undefined);
      done();
    });
  });
});

// ── forcedMode in existing override-ack responses ─────────────────────────────

describe('forcedMode field in existing override-ack responses', () => {
  beforeEach(sharedSetup);
  afterEach(sharedTeardown);

  it('override-enter ack includes forcedMode: null', (t, done) => {
    deviceConfig._reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: null, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-enter', ttl: 300, suppressSafety: false }));
    setImmediate(function () {
      var ack = sent(ws).pop();
      assert.strictEqual(ack.type, 'override-ack');
      assert.ok('forcedMode' in ack, 'override-enter ack must include forcedMode');
      assert.strictEqual(ack.forcedMode, null);
      done();
    });
  });

  it('override-update preserves mo.fm and surfaces it in the ack', (t, done) => {
    deviceConfig._reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-update', ttl: 600 }));
    setImmediate(function () {
      var ack = sent(ws).pop();
      assert.strictEqual(ack.type, 'override-ack');
      assert.strictEqual(ack.forcedMode, 'SC');
      assert.strictEqual(deviceConfig.getConfig().mo.fm, 'SC');
      done();
    });
  });

  it('override-exit ack includes forcedMode: null', (t, done) => {
    deviceConfig._reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    serverModule.handleWsCommand(ws, JSON.stringify({ type: 'override-exit' }));
    setImmediate(function () {
      var ack = sent(ws).pop();
      assert.strictEqual(ack.type, 'override-ack');
      assert.strictEqual(ack.active, false);
      assert.strictEqual(ack.forcedMode, null);
      done();
    });
  });
});
