const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('device-config', () => {
  let deviceConfig;
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-config-test-'));
    configPath = path.join(tmpDir, 'device-config.json');

    // Clear S3 env vars to force local mode
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    process.env.DEVICE_CONFIG_PATH = configPath;

    delete require.cache[require.resolve('../monitor/lib/device-config.js')];
    deviceConfig = require('../monitor/lib/device-config.js');
    deviceConfig._reset();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    delete process.env.DEVICE_CONFIG_PATH;
  });

  it('returns default config when no file exists', (t, done) => {
    deviceConfig.load(function (err, config) {
      assert.ifError(err);
      assert.strictEqual(config.controls_enabled, false);
      assert.strictEqual(config.enabled_actuators.pump, false);
      assert.strictEqual(config.enabled_actuators.valves, false);
      assert.strictEqual(config.version, 1);
      done();
    });
  });

  it('GET returns current config', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      const res = mockResponse();
      deviceConfig.handleGet({}, res);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.controls_enabled, false);
      assert.strictEqual(res._statusCode, 200);
      done();
    });
  });

  it('PUT updates and increments version', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      const body = JSON.stringify({
        controls_enabled: true,
        enabled_actuators: { pump: true, valves: true },
      });
      const res = mockResponse();
      deviceConfig.handlePut({}, res, body, function (config) {
        assert.strictEqual(config.controls_enabled, true);
        assert.strictEqual(config.enabled_actuators.pump, true);
        assert.strictEqual(config.enabled_actuators.valves, true);
        // Other actuators remain false
        assert.strictEqual(config.enabled_actuators.fan, false);
        assert.strictEqual(config.version, 2);

        // Verify persisted to disk
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.strictEqual(saved.version, 2);
        assert.strictEqual(saved.controls_enabled, true);
        done();
      });
    });
  });

  it('PUT rejects invalid JSON', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      const res = mockResponse();
      deviceConfig.handlePut({}, res, 'not json', null);
      assert.strictEqual(res._statusCode, 400);
      done();
    });
  });

  it('persistence round-trip works', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ controls_enabled: true }, function (err2, config) {
        assert.ifError(err2);
        assert.strictEqual(config.controls_enabled, true);

        // Reload from disk
        deviceConfig._reset();
        delete require.cache[require.resolve('../monitor/lib/device-config.js')];
        const fresh = require('../monitor/lib/device-config.js');
        fresh._reset();
        process.env.DEVICE_CONFIG_PATH = configPath;
        fresh.load(function (err3, loaded) {
          assert.ifError(err3);
          assert.strictEqual(loaded.controls_enabled, true);
          assert.strictEqual(loaded.version, 2);
          done();
        });
      });
    });
  });
});

function mockResponse() {
  return {
    _statusCode: 200,
    _headers: {},
    _body: '',
    writeHead: function (code, headers) {
      this._statusCode = code;
      this._headers = headers || {};
    },
    end: function (body) {
      this._body = body || '';
    },
  };
}
