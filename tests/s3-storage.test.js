/**
 * Unit tests for S3 storage adapter (local filesystem fallback mode).
 * Tests the adapter's local mode since S3 requires network access.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const testPath = path.join(__dirname, 'test-s3-storage-' + process.pid + '.json');

describe('s3-storage adapter (local mode)', function () {
  before(function () {
    // Ensure S3 is not configured — local fallback mode
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    process.env.CREDENTIALS_PATH = testPath;
  });

  beforeEach(function () {
    try { fs.unlinkSync(testPath); } catch (e) { /* ignore */ }
    // Clear module cache for fresh state
    delete require.cache[require.resolve('../server/lib/s3-storage')];
  });

  after(function () {
    try { fs.unlinkSync(testPath); } catch (e) { /* ignore */ }
  });

  it('isS3Enabled returns false when env vars not set', function () {
    const storage = require('../server/lib/s3-storage');
    storage._reset();
    assert.strictEqual(storage.isS3Enabled(), false);
  });

  it('readSync returns null when file does not exist', function () {
    const storage = require('../server/lib/s3-storage');
    const result = storage.readSync();
    assert.strictEqual(result, null);
  });

  it('writeSync and readSync round-trip data', function () {
    const storage = require('../server/lib/s3-storage');
    const data = { user: 'test', credentials: [{ id: 'c1' }] };
    storage.writeSync(data);
    const result = storage.readSync();
    assert.deepStrictEqual(result, data);
  });

  it('read callback returns null when file does not exist', function (t, done) {
    const storage = require('../server/lib/s3-storage');
    storage.read(function (err, data) {
      assert.ifError(err);
      assert.strictEqual(data, null);
      done();
    });
  });

  it('write and read callback round-trip data', function (t, done) {
    const storage = require('../server/lib/s3-storage');
    const testData = { sessions: [{ token: 'abc' }] };
    storage.write(testData, function (err) {
      assert.ifError(err);
      storage.read(function (err2, result) {
        assert.ifError(err2);
        assert.deepStrictEqual(result, testData);
        done();
      });
    });
  });

  it('writeSync creates parent directories if needed', function () {
    const nestedPath = path.join(__dirname, 'nested-' + process.pid, 'deep', 'creds.json');
    process.env.CREDENTIALS_PATH = nestedPath;
    delete require.cache[require.resolve('../server/lib/s3-storage')];
    const storage = require('../server/lib/s3-storage');
    storage._reset();
    const data = { test: true };
    storage.writeSync(data);
    const result = storage.readSync();
    assert.deepStrictEqual(result, data);
    // Clean up
    fs.unlinkSync(nestedPath);
    fs.rmdirSync(path.join(__dirname, 'nested-' + process.pid, 'deep'));
    fs.rmdirSync(path.join(__dirname, 'nested-' + process.pid));
    process.env.CREDENTIALS_PATH = testPath;
  });
});

describe('s3-storage adapter (S3 mode detection)', function () {
  before(function () {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });

  beforeEach(function () {
    delete require.cache[require.resolve('../server/lib/s3-storage')];
  });

  it('isS3Enabled returns true when all S3 env vars set', function () {
    process.env.S3_ENDPOINT = 'https://example.com';
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_ACCESS_KEY_ID = 'key123';
    process.env.S3_SECRET_ACCESS_KEY = 'secret456';
    const storage = require('../server/lib/s3-storage');
    storage._reset();
    assert.strictEqual(storage.isS3Enabled(), true);
    // Clean up
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });

  it('isS3Enabled returns false when only some S3 env vars set', function () {
    process.env.S3_ENDPOINT = 'https://example.com';
    // Missing bucket, key, secret
    const storage = require('../server/lib/s3-storage');
    storage._reset();
    assert.strictEqual(storage.isS3Enabled(), false);
    delete process.env.S3_ENDPOINT;
  });
});
