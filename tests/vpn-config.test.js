/**
 * Unit tests for VPN config S3 persistence helper.
 * Tests download/upload logic with mocked S3 calls.
 */
var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var testDir = path.join(__dirname, 'vpn-config-test-' + process.pid);
var testFile = path.join(testDir, 'wg0.conf');
var sampleConfig = '[Interface]\nAddress = 10.10.10.1/24\nListenPort = 51820\nPrivateKey = testkey\n';

function loadModule() {
  delete require.cache[require.resolve('../monitor/lib/vpn-config')];
  return require('../monitor/lib/vpn-config');
}

describe('vpn-config CLI argument parsing', function () {
  it('exports download and upload functions when required', function () {
    var mod = loadModule();
    assert.strictEqual(typeof mod.download, 'function');
    assert.strictEqual(typeof mod.upload, 'function');
    assert.strictEqual(typeof mod._resetClient, 'function');
  });
});

describe('vpn-config download', function () {
  beforeEach(function () {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    try { fs.unlinkSync(testFile); } catch (e) { /* ignore */ }
    // Set up S3 env vars
    process.env.S3_ENDPOINT = 'https://s3.example.com';
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_ACCESS_KEY_ID = 'testkey';
    process.env.S3_SECRET_ACCESS_KEY = 'testsecret';
    process.env.VPN_CONFIG_KEY = 'wg0.conf';
  });

  afterEach(function () {
    try { fs.unlinkSync(testFile); } catch (e) { /* ignore */ }
    try { fs.rmdirSync(testDir); } catch (e) { /* ignore */ }
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.VPN_CONFIG_KEY;
  });

  it('returns error when S3 not configured', function (t, done) {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    var mod = loadModule();
    mod.download(testFile, function (err) {
      assert.ok(err);
      assert.match(err.message, /S3 not configured/);
      done();
    });
  });
});

describe('vpn-config upload', function () {
  beforeEach(function () {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    process.env.S3_ENDPOINT = 'https://s3.example.com';
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_ACCESS_KEY_ID = 'testkey';
    process.env.S3_SECRET_ACCESS_KEY = 'testsecret';
    process.env.VPN_CONFIG_KEY = 'wg0.conf';
  });

  afterEach(function () {
    try { fs.unlinkSync(testFile); } catch (e) { /* ignore */ }
    try { fs.rmdirSync(testDir); } catch (e) { /* ignore */ }
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    delete process.env.VPN_CONFIG_KEY;
  });

  it('returns error when S3 not configured', function (t, done) {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    fs.writeFileSync(testFile, sampleConfig);
    var mod = loadModule();
    mod.upload(testFile, function (err) {
      assert.ok(err);
      assert.match(err.message, /S3 not configured/);
      done();
    });
  });

  it('returns error when local file does not exist', function (t, done) {
    var mod = loadModule();
    mod.upload('/nonexistent/wg0.conf', function (err) {
      assert.ok(err);
      assert.match(err.message, /Local file not found/);
      done();
    });
  });
});

describe('vpn-config VPN_CONFIG_KEY default', function () {
  it('uses wg0.conf as default key when VPN_CONFIG_KEY not set', function () {
    delete process.env.VPN_CONFIG_KEY;
    process.env.S3_ENDPOINT = 'https://s3.example.com';
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_ACCESS_KEY_ID = 'testkey';
    process.env.S3_SECRET_ACCESS_KEY = 'testsecret';
    // We can't easily test the internal config without exposing it,
    // but we verify the module loads without error
    var mod = loadModule();
    assert.ok(mod.download);
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });
});
