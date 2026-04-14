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

    delete require.cache[require.resolve('../server/lib/device-config.js')];
    deviceConfig = require('../server/lib/device-config.js');
    deviceConfig._reset();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    delete process.env.DEVICE_CONFIG_PATH;
  });

  it('returns default config when no file exists', (t, done) => {
    deviceConfig.load(function (err, config) {
      assert.ifError(err);
      assert.strictEqual(config.ce, false);
      assert.strictEqual(config.ea, 0);
      assert.strictEqual(config.fm, null);
      assert.deepStrictEqual(config.we, {});
      assert.deepStrictEqual(config.wz, {});
      assert.deepStrictEqual(config.wb, {});
      assert.strictEqual(config.v, 1);
      done();
    });
  });

  it('GET returns current config', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      const res = mockResponse();
      deviceConfig.handleGet({}, res);
      const body = JSON.parse(res._body);
      assert.strictEqual(body.ce, false);
      assert.strictEqual(res._statusCode, 200);
      done();
    });
  });

  it('PUT updates and increments version', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // ea: valves=1, pump=2 → 3
      const body = JSON.stringify({ ce: true, ea: 3 });
      const res = mockResponse();
      deviceConfig.handlePut({}, res, body, function (config) {
        assert.strictEqual(config.ce, true);
        assert.strictEqual(config.ea, 3);
        assert.strictEqual(config.v, 2);

        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.strictEqual(saved.v, 2);
        assert.strictEqual(saved.ce, true);
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
      deviceConfig.updateConfig({ ce: true }, function (err2, config) {
        assert.ifError(err2);
        assert.strictEqual(config.ce, true);

        // Reload from disk
        deviceConfig._reset();
        delete require.cache[require.resolve('../server/lib/device-config.js')];
        const fresh = require('../server/lib/device-config.js');
        fresh._reset();
        process.env.DEVICE_CONFIG_PATH = configPath;
        fresh.load(function (err3, loaded) {
          assert.ifError(err3);
          assert.strictEqual(loaded.ce, true);
          assert.strictEqual(loaded.v, 2);
          done();
        });
      });
    });
  });

  // ── Manual override (mo) field tests ──

  it('mo field accepted and persisted', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      const mo = { a: true, ex: 1712505600, ss: false };
      deviceConfig.updateConfig({ mo: mo }, function (err2, config) {
        assert.ifError(err2);
        assert.deepStrictEqual(config.mo, mo);
        // Verify persisted to disk
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.deepStrictEqual(saved.mo, mo);
        done();
      });
    });
  });

  it('mo: null clears override', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, ss: true } }, function (err2) {
        assert.ifError(err2);
        deviceConfig.updateConfig({ mo: null }, function (err3, config) {
          assert.ifError(err3);
          assert.strictEqual(config.mo, null);
          done();
        });
      });
    });
  });

  it('mo rejected when invalid structure', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ mo: { a: 'yes' } }, function (err2) {
        assert.ok(err2, 'should reject invalid mo');
        assert.ok(err2.message.includes('Invalid mo'));
        done();
      });
    });
  });

  it('mo preserved through unrelated config updates', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      const mo = { a: true, ex: 1712505600, ss: false };
      deviceConfig.updateConfig({ mo: mo }, function (err2) {
        assert.ifError(err2);
        // Update ce without touching mo
        deviceConfig.updateConfig({ ce: true }, function (err3, config) {
          assert.ifError(err3);
          assert.deepStrictEqual(config.mo, mo);
          assert.strictEqual(config.ce, true);
          done();
        });
      });
    });
  });

  // ── Mode bans (wb) — replaces legacy am filter ──

  it('empty wb means all modes unrestricted', (t, done) => {
    deviceConfig.load(function (err, config) {
      assert.ifError(err);
      assert.deepStrictEqual(config.wb, {});
      done();
    });
  });

  it('null wb clears all bans', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ wb: { GH: 9999999999 } }, function (err2) {
        assert.ifError(err2);
        deviceConfig.updateConfig({ wb: null }, function (err3, config) {
          assert.ifError(err3);
          assert.deepStrictEqual(config.wb, {});
          done();
        });
      });
    });
  });

  it('subset of modes banned is preserved as wb entries', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // Ban GH and AD permanently
      deviceConfig.updateConfig({
        wb: { GH: 9999999999, AD: 9999999999 }
      }, function (err2, config) {
        assert.ifError(err2);
        assert.strictEqual(config.wb.GH, 9999999999);
        assert.strictEqual(config.wb.AD, 9999999999);
        done();
      });
    });
  });

  it('legacy am field is migrated to wb on load', (t, done) => {
    // Pre-populate the config file with a legacy am array
    fs.writeFileSync(configPath, JSON.stringify({
      ce: false, ea: 0, fm: null, am: ['I', 'SC'], v: 1
    }));
    deviceConfig._reset();
    delete require.cache[require.resolve('../server/lib/device-config.js')];
    deviceConfig = require('../server/lib/device-config.js');
    deviceConfig._reset();
    deviceConfig.load(function (err, config) {
      assert.ifError(err);
      assert.strictEqual(config.am, undefined);
      assert.strictEqual(config.wb.GH, 9999999999);
      assert.strictEqual(config.wb.AD, 9999999999);
      assert.strictEqual(config.wb.EH, 9999999999);
      assert.strictEqual(config.wb.I, undefined);
      assert.strictEqual(config.wb.SC, undefined);
      done();
    });
  });

  // ── Save no-op detection ──

  it('PUT with identical config does not bump version', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ ce: true, ea: 31 }, function (err2, first) {
        assert.ifError(err2);
        const v1 = first.v;
        deviceConfig.updateConfig({ ce: true, ea: 31 }, function (err3, second) {
          assert.ifError(err3);
          assert.strictEqual(second.v, v1, 'identical save should not bump version');
          done();
        });
      });
    });
  });

  it('config with watchdog fields fits within 256 bytes', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // Max-size config with mo + watchdog fields
      deviceConfig.updateConfig({
        ce: true, ea: 31, fm: 'EH',
        we: { sng: 1, scs: 1, ggr: 1 },
        wz: { sng: 1713050000, scs: 1713050000, ggr: 1713053400 },
        wb: { SC: 9999999999, GH: 1713094215, AD: 9999999999 },
        mo: { a: true, ex: 9999999999, ss: true },
      }, function (err2, config) {
        assert.ifError(err2);
        const size = JSON.stringify(config).length;
        assert.ok(size <= 256, 'Config size ' + size + ' exceeds 256 bytes');
        done();
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
