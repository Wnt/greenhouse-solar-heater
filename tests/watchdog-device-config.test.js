const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('watchdog config validators', () => {
  let deviceConfig;
  let tmpDir;
  let configPath;

  beforeEach((t, done) => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-cfg-test-'));
    configPath = path.join(tmpDir, 'device-config.json');

    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    process.env.DEVICE_CONFIG_PATH = configPath;

    delete require.cache[require.resolve('../server/lib/device-config.js')];
    deviceConfig = require('../server/lib/device-config.js');
    deviceConfig._reset();
    deviceConfig.load(function (err) {
      assert.ifError(err);
      done();
    });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    delete process.env.DEVICE_CONFIG_PATH;
  });

  it('accepts we enable flags', (t, done) => {
    deviceConfig.updateConfig({ we: { sng: 1, scs: 0, ggr: 1 } }, (err, cfg) => {
      assert.ifError(err);
      assert.deepStrictEqual(cfg.we, { sng: 1, scs: 0, ggr: 1 });
      done();
    });
  });

  it('accepts wz snooze timestamps', (t, done) => {
    deviceConfig.updateConfig({ wz: { ggr: 1800000000 } }, (err, cfg) => {
      assert.ifError(err);
      assert.strictEqual(cfg.wz.ggr, 1800000000);
      done();
    });
  });

  it('removes wz entry when value is 0', (t, done) => {
    deviceConfig.updateConfig({ wz: { ggr: 1800000000 } }, () => {
      deviceConfig.updateConfig({ wz: { ggr: 0 } }, (err, cfg) => {
        assert.ifError(err);
        assert.strictEqual(cfg.wz.ggr, undefined);
        done();
      });
    });
  });

  it('accepts wb ban timestamps', (t, done) => {
    deviceConfig.updateConfig({ wb: { GH: 1800000000 } }, (err, cfg) => {
      assert.ifError(err);
      assert.strictEqual(cfg.wb.GH, 1800000000);
      done();
    });
  });

  it('accepts sentinel 9999999999 as permanent ban', (t, done) => {
    deviceConfig.updateConfig({ wb: { SC: 9999999999 } }, (err, cfg) => {
      assert.ifError(err);
      assert.strictEqual(cfg.wb.SC, 9999999999);
      done();
    });
  });

  it('removes wb entry when value is 0', (t, done) => {
    deviceConfig.updateConfig({ wb: { GH: 1800000000 } }, () => {
      deviceConfig.updateConfig({ wb: { GH: 0 } }, (err, cfg) => {
        assert.ifError(err);
        assert.strictEqual(cfg.wb.GH, undefined);
        done();
      });
    });
  });

  it('rejects unknown watchdog ids in we', (t, done) => {
    deviceConfig.updateConfig({ we: { bogus: 1, sng: 1 } }, (err, cfg) => {
      assert.ifError(err);
      assert.strictEqual(cfg.we.bogus, undefined);
      assert.strictEqual(cfg.we.sng, 1);
      done();
    });
  });

  it('null for we clears all', (t, done) => {
    deviceConfig.updateConfig({ we: { sng: 1, ggr: 1 } }, () => {
      deviceConfig.updateConfig({ we: null }, (err, cfg) => {
        assert.ifError(err);
        assert.deepStrictEqual(cfg.we, {});
        done();
      });
    });
  });
});

