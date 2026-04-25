const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

describe('db-config', () => {
  let dbConfig;
  let s3Calls;

  beforeEach(() => {
    s3Calls = [];

    // Mock S3 client
    const mockS3Client = {
      send: function (cmd) {
        s3Calls.push(cmd);
        if (cmd.constructor.name === 'GetObjectCommand' || cmd.input && cmd.input.Key) {
          // Check if this is a get or put
          if (s3Calls.length === 1 && !s3Calls._stored) {
            // First load — no data stored yet
            const err = new Error('NoSuchKey');
            err.name = 'NoSuchKey';
            err.$metadata = { httpStatusCode: 404 };
            return Promise.reject(err);
          }
          if (s3Calls._stored) {
            return Promise.resolve({
              Body: { transformToString: function () { return Promise.resolve(s3Calls._stored); } },
            });
          }
        }
        return Promise.resolve({});
      },
    };

    // Mock the in-tree S3 client module
    require.cache[require.resolve('../server/lib/s3-client.js')] = {
      id: require.resolve('../server/lib/s3-client.js'),
      exports: {
        S3Client: function () { return mockS3Client; },
        GetObjectCommand: function (params) { this.input = params; },
        PutObjectCommand: function (params) {
          this.input = params;
          s3Calls._stored = params.Body;
        },
      },
    };

    process.env.S3_ENDPOINT = 'https://test.endpoint';
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_ACCESS_KEY_ID = 'test-key';
    process.env.S3_SECRET_ACCESS_KEY = 'test-secret';

    delete require.cache[require.resolve('../server/lib/db-config.js')];
    dbConfig = require('../server/lib/db-config.js');
    dbConfig._resetClient();
  });

  afterEach(() => {
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
  });

  it('load returns null when no config in S3', (t, done) => {
    dbConfig.load(function (err, url) {
      assert.ifError(err);
      assert.strictEqual(url, null);
      done();
    });
  });

  it('store saves URL to S3', (t, done) => {
    dbConfig.store('postgres://user:pass@host:5432/db', function (err) {
      assert.ifError(err);
      assert.ok(s3Calls.length > 0);
      done();
    });
  });

  it('store then load round-trips the URL', (t, done) => {
    dbConfig.store('postgres://user:pass@host:5432/db', function (err) {
      assert.ifError(err);
      dbConfig.load(function (err2, url) {
        assert.ifError(err2);
        assert.strictEqual(url, 'postgres://user:pass@host:5432/db');
        done();
      });
    });
  });

  it('fails when S3 is not configured', (t, done) => {
    delete process.env.S3_ENDPOINT;
    dbConfig._resetClient();
    delete require.cache[require.resolve('../server/lib/db-config.js')];
    dbConfig = require('../server/lib/db-config.js');

    dbConfig.load(function (err) {
      assert.ok(err);
      assert.ok(err.message.includes('S3 not configured'));
      done();
    });
  });
});
