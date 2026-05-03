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
      assert.strictEqual(config.fm, undefined); // fm moved into mo.fm; top-level fm no longer exists
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
      const mo = { a: true, ex: 1712505600, fm: 'I' };
      deviceConfig.updateConfig({ mo }, function (err2, config) {
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
      deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, fm: 'I' } }, function (err2) {
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

  it('mo rejected when ss is present (legacy field, dropped 2026-04-21)', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, ss: false, fm: 'I' } }, function (err2) {
        assert.ok(err2, 'should reject mo.ss');
        assert.match(err2.message, /mo\.ss/);
        done();
      });
    });
  });

  it('mo rejected when a=true but fm missing', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999 } }, function (err2) {
        assert.ok(err2, 'should reject mo without fm when active');
        assert.match(err2.message, /mo\.fm required/);
        done();
      });
    });
  });

  it('mo preserved through unrelated config updates', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      const mo = { a: true, ex: 1712505600, fm: 'I' };
      deviceConfig.updateConfig({ mo }, function (err2) {
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

  // ── Tuning thresholds (tu) ──

  it('tu defaults to empty object', (t, done) => {
    deviceConfig.load(function (err, config) {
      assert.ifError(err);
      assert.deepStrictEqual(config.tu, {});
      done();
    });
  });

  it('tu accepts a single threshold and persists it', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ tu: { geT: 11 } }, function (err2, config) {
        assert.ifError(err2);
        assert.strictEqual(config.tu.geT, 11);
        const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.strictEqual(saved.tu.geT, 11);
        done();
      });
    });
  });

  it('tu null clears all overrides', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ tu: { geT: 11, gxT: 13 } }, function (err2) {
        assert.ifError(err2);
        deviceConfig.updateConfig({ tu: null }, function (err3, config) {
          assert.ifError(err3);
          assert.deepStrictEqual(config.tu, {});
          done();
        });
      });
    });
  });

  it('tu per-key null clears that key only', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ tu: { geT: 11, gxT: 13 } }, function (err2) {
        assert.ifError(err2);
        deviceConfig.updateConfig({ tu: { geT: null } }, function (err3, config) {
          assert.ifError(err3);
          assert.strictEqual(config.tu.geT, undefined);
          assert.strictEqual(config.tu.gxT, 13);
          done();
        });
      });
    });
  });

  it('tu clamps out-of-range values', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // ohT range is [70, 100]; 110 clamps to 100, -5 clamps to 0 for frT.
      deviceConfig.updateConfig({ tu: { ohT: 110, frT: -5 } }, function (err2, config) {
        assert.ifError(err2);
        assert.strictEqual(config.tu.ohT, 100);
        assert.strictEqual(config.tu.frT, 0);
        done();
      });
    });
  });

  it('tu rejects non-numeric values', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ tu: { geT: 'hot' } }, function (err2) {
        assert.ok(err2);
        assert.match(err2.message, /tu\.geT/);
        assert.strictEqual(err2.code, 'VALIDATION');
        done();
      });
    });
  });

  it('tu rejects greenhouse heat exit <= enter (invariant)', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // Default geT = 10. Try to set gxT = 9 which is below.
      deviceConfig.updateConfig({ tu: { gxT: 9 } }, function (err2) {
        assert.ok(err2);
        assert.match(err2.message, /greenhouse heat exit/);
        done();
      });
    });
  });

  it('tu rejects emergency heater exit <= enter (invariant)', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // Default ehE = 9. Setting ehX = 8 violates ehX > ehE.
      deviceConfig.updateConfig({ tu: { ehX: 8 } }, function (err2) {
        assert.ok(err2);
        assert.match(err2.message, /emergency heater exit/);
        done();
      });
    });
  });

  it('tu rejects fan-cool enter <= exit (invariant)', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // Default fcX = 28. Setting fcE = 27 violates fcE > fcX.
      deviceConfig.updateConfig({ tu: { fcE: 27 } }, function (err2) {
        assert.ok(err2);
        assert.match(err2.message, /fan-cool enter/);
        done();
      });
    });
  });

  it('tu invariant uses effective values across partial updates', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // Raise geT to 13 first.
      deviceConfig.updateConfig({ tu: { geT: 13, gxT: 15 } }, function (err2) {
        assert.ifError(err2);
        // Now try to lower gxT to 12 — would violate gxT > geT (13).
        deviceConfig.updateConfig({ tu: { gxT: 12 } }, function (err3) {
          assert.ok(err3);
          assert.match(err3.message, /greenhouse heat exit/);
          done();
        });
      });
    });
  });

  it('tu unrelated config update preserves tu', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      deviceConfig.updateConfig({ tu: { geT: 11 } }, function (err2) {
        assert.ifError(err2);
        deviceConfig.updateConfig({ ce: true }, function (err3, config) {
          assert.ifError(err3);
          assert.strictEqual(config.tu.geT, 11);
          assert.strictEqual(config.ce, true);
          done();
        });
      });
    });
  });

  it('tu schema keys agree with control-logic.js TUNING_KEYS', () => {
    delete require.cache[require.resolve('../shelly/control-logic.js')];
    const cl = require('../shelly/control-logic.js');
    const ranges = require('../server/lib/device-config.js').TUNING_RANGES;
    assert.deepStrictEqual(
      Object.keys(cl.TUNING_KEYS).sort(),
      Object.keys(ranges).sort(),
      'TUNING_KEYS in control-logic.js and TUNING_RANGES in device-config.js must list the same short keys'
    );
  });

  it('config with watchdog fields + a couple of tu overrides fits within 256 bytes', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // Realistic worst-case shape: watchdogs in flight + mode bans +
      // manual override + a couple of tuned thresholds.
      deviceConfig.updateConfig({
        ce: true, ea: 31,
        we: { sng: 1, scs: 1, ggr: 1 },
        wz: { sng: 1713050000, scs: 1713050000, ggr: 1713053400 },
        wb: { SC: 9999999999, GH: 1713094215, AD: 9999999999 },
        mo: { a: true, ex: 9999999999, fm: 'EH' },
        tu: { geT: 11, frT: 5 },
      }, function (err2, config) {
        assert.ifError(err2);
        const size = JSON.stringify(config).length;
        assert.ok(size <= 256, 'Config size ' + size + ' exceeds 256 bytes');
        done();
      });
    });
  });

  it('rejects PUT that would push the saved config over 256 bytes', (t, done) => {
    deviceConfig.load(function (err) {
      assert.ifError(err);
      // Pile every long-form field together so the projected size is
      // guaranteed to overflow. Overwriting the whole worst-case config
      // in a single update (server's projectedSize guard fires before
      // S3/MQTT).
      deviceConfig.updateConfig({
        ce: true, ea: 31,
        we: { sng: 1, scs: 1, ggr: 1 },
        wz: { sng: 1713050000, scs: 1713050000, ggr: 1713053400 },
        wb: { SC: 9999999999, GH: 1713094215, AD: 9999999999 },
        mo: { a: true, ex: 9999999999, fm: 'EH' },
        tu: { geT: 11, gxT: 13, fcE: 31, fcX: 29, frT: 4, ohT: 95 },
      }, function (err2) {
        assert.ok(err2);
        assert.match(err2.message, /256-byte/);
        done();
      });
    });
  });
});

describe('device-config mo.fm', () => {
  let deviceConfig;
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'device-config-mofm-test-'));
    configPath = path.join(tmpDir, 'device-config.json');

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

  it('accepts mo.fm when mo.a is true', (t, done) => {
    deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, fm: 'SC' } }, (err, cfg) => {
      assert.ifError(err);
      assert.deepStrictEqual(cfg.mo, { a: true, ex: 9999999999, fm: 'SC' });
      done();
    });
  });

  it('accepts mo.fm update while override is active', (t, done) => {
    deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, fm: 'I' } }, (err) => {
      assert.ifError(err);
      deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, fm: 'GH' } }, (err2, cfg) => {
        assert.ifError(err2);
        assert.strictEqual(cfg.mo.fm, 'GH');
        done();
      });
    });
  });

  it('rejects mo.fm when mo.a is false', (t, done) => {
    deviceConfig.updateConfig({ mo: { a: false, ex: 0, fm: 'SC' } }, (err) => {
      assert.ok(err);
      assert.match(err.message, /mo\.fm/);
      assert.strictEqual(err.code, 'VALIDATION');
      done();
    });
  });

  it('rejects unknown mode codes in mo.fm', (t, done) => {
    deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, fm: 'XX' } }, (err) => {
      assert.ok(err);
      assert.match(err.message, /mo\.fm/);
      done();
    });
  });

  it('clears mo.fm when mo is cleared', (t, done) => {
    deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, fm: 'SC' } }, (err) => {
      assert.ifError(err);
      deviceConfig.updateConfig({ mo: null }, (err2, cfg) => {
        assert.ifError(err2);
        assert.strictEqual(cfg.mo, null);
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
