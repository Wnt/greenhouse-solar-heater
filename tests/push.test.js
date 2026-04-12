const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('push', () => {
  let push;
  let tmpDir;
  let configPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test-'));
    configPath = path.join(tmpDir, 'push-config.json');

    // Force local mode
    delete process.env.S3_ENDPOINT;
    delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    process.env.PUSH_CONFIG_PATH = configPath;

    delete require.cache[require.resolve('../server/lib/push.js')];
    push = require('../server/lib/push.js');
    push._reset();
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    delete process.env.PUSH_CONFIG_PATH;
  });

  describe('init', () => {
    it('generates VAPID keys on first run', (t, done) => {
      push.init(function (err) {
        assert.ifError(err);
        assert.ok(push.getPublicKey());
        assert.ok(push.getPublicKey().length > 20);
        done();
      });
    });

    it('persists VAPID keys to disk', (t, done) => {
      push.init(function (err) {
        assert.ifError(err);
        var key1 = push.getPublicKey();

        // Reload
        delete require.cache[require.resolve('../server/lib/push.js')];
        var push2 = require('../server/lib/push.js');
        push2._reset();
        push2.init(function (err2) {
          assert.ifError(err2);
          assert.strictEqual(push2.getPublicKey(), key1);
          done();
        });
      });
    });
  });

  describe('subscriptions', () => {
    beforeEach((t, done) => {
      push.init(done);
    });

    it('adds a subscription', (t, done) => {
      var sub = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'abc', auth: 'def' } };
      push.addSubscription(sub, ['evening_report', 'freeze_warning'], function (err) {
        assert.ifError(err);
        assert.strictEqual(push.getSubscriptionCount(), 1);
        var stored = push.getSubscription('https://push.example.com/1');
        assert.deepStrictEqual(stored.categories, ['evening_report', 'freeze_warning']);
        done();
      });
    });

    it('updates categories for existing endpoint', (t, done) => {
      var sub = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'abc', auth: 'def' } };
      push.addSubscription(sub, ['evening_report'], function (err) {
        assert.ifError(err);
        push.addSubscription(sub, ['freeze_warning', 'overheat_warning'], function (err2) {
          assert.ifError(err2);
          assert.strictEqual(push.getSubscriptionCount(), 1);
          var stored = push.getSubscription('https://push.example.com/1');
          assert.deepStrictEqual(stored.categories, ['freeze_warning', 'overheat_warning']);
          done();
        });
      });
    });

    it('removes a subscription', (t, done) => {
      var sub = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'abc', auth: 'def' } };
      push.addSubscription(sub, ['evening_report'], function (err) {
        assert.ifError(err);
        push.removeSubscription('https://push.example.com/1', function (err2) {
          assert.ifError(err2);
          assert.strictEqual(push.getSubscriptionCount(), 0);
          assert.strictEqual(push.getSubscription('https://push.example.com/1'), null);
          done();
        });
      });
    });

    it('filters invalid categories', (t, done) => {
      var sub = { endpoint: 'https://push.example.com/1', keys: { p256dh: 'abc', auth: 'def' } };
      push.addSubscription(sub, ['evening_report', 'invalid_cat', 'freeze_warning'], function (err) {
        assert.ifError(err);
        var stored = push.getSubscription('https://push.example.com/1');
        assert.deepStrictEqual(stored.categories, ['evening_report', 'freeze_warning']);
        done();
      });
    });

    it('returns null for unknown endpoint', () => {
      assert.strictEqual(push.getSubscription('https://push.example.com/unknown'), null);
    });
  });

  describe('rate limiting', () => {
    it('is not rate-limited initially', () => {
      assert.strictEqual(push.isRateLimited('evening_report'), false);
    });

    it('is rate-limited after sending', () => {
      push._setLastSentAt({ evening_report: Date.now() });
      assert.strictEqual(push.isRateLimited('evening_report'), true);
    });

    it('is not rate-limited after 1 hour', () => {
      push._setLastSentAt({ evening_report: Date.now() - push.RATE_LIMIT_MS - 1 });
      assert.strictEqual(push.isRateLimited('evening_report'), false);
    });

    it('rate limits different types independently', () => {
      push._setLastSentAt({ evening_report: Date.now(), freeze_warning: Date.now() - push.RATE_LIMIT_MS - 1 });
      assert.strictEqual(push.isRateLimited('evening_report'), true);
      assert.strictEqual(push.isRateLimited('freeze_warning'), false);
    });
  });

  describe('VALID_CATEGORIES', () => {
    it('contains all four categories', () => {
      assert.deepStrictEqual(push.VALID_CATEGORIES, [
        'evening_report', 'noon_report', 'overheat_warning', 'freeze_warning'
      ]);
    });
  });
});
