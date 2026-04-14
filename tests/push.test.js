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
    it('contains all six categories', () => {
      assert.deepStrictEqual(push.VALID_CATEGORIES, [
        'evening_report', 'noon_report', 'overheat_warning', 'freeze_warning', 'offline_warning', 'watchdog_fired'
      ]);
    });
  });

  describe('buildMockPayload', () => {
    it('returns a payload for each valid category', () => {
      push.VALID_CATEGORIES.forEach((cat) => {
        const payload = push.buildMockPayload(cat);
        assert.ok(payload, `expected payload for ${cat}`);
        assert.match(payload.title, /\[Test\]/);
        assert.ok(payload.body && payload.body.length > 0);
        assert.ok(payload.tag && payload.tag.indexOf('test-') === 0);
        assert.strictEqual(payload.url, '/#status');
      });
    });

    it('returns null for unknown categories', () => {
      assert.strictEqual(push.buildMockPayload('bogus'), null);
      assert.strictEqual(push.buildMockPayload(''), null);
      assert.strictEqual(push.buildMockPayload(null), null);
    });

    it('each mock body mentions plausible data for its category', () => {
      assert.match(push.buildMockPayload('evening_report').body, /kWh|Wh/);
      assert.match(push.buildMockPayload('noon_report').body, /heating/);
      assert.match(push.buildMockPayload('overheat_warning').body, /\u00b0C/);
      assert.match(push.buildMockPayload('freeze_warning').body, /\u00b0C/);
      assert.match(push.buildMockPayload('offline_warning').body, /offline|no data|minutes/i);
    });

    it('every mock payload carries a per-category icon path', () => {
      push.VALID_CATEGORIES.forEach((cat) => {
        const payload = push.buildMockPayload(cat);
        assert.ok(payload.icon, `expected icon for ${cat}`);
        assert.match(payload.icon, /^assets\/notif-.*\.png$/, `icon path for ${cat} must be assets/notif-*.png (got ${payload.icon})`);
      });
    });

    it('watchdog_fired mock includes inline-reply action so the test exercises real shape', () => {
      const payload = push.buildMockPayload('watchdog_fired');
      assert.ok(Array.isArray(payload.actions), 'expected actions array');
      assert.strictEqual(payload.actions.length, 2);

      const snooze = payload.actions.find(a => a.action === 'snooze');
      assert.ok(snooze, 'expected snooze action');
      assert.strictEqual(snooze.type, 'text', 'snooze action must be type:text for inline reply');
      assert.ok(snooze.placeholder, 'snooze action should have a placeholder hint');

      const shutdown = payload.actions.find(a => a.action === 'shutdownnow');
      assert.ok(shutdown, 'expected shutdownnow action');
      assert.strictEqual(shutdown.type, 'button');

      // requireInteraction so the notification doesn't auto-dismiss
      assert.strictEqual(payload.requireInteraction, true);

      // SW must recognize this as a watchdog-style notification AND
      // know it's a test, so it short-circuits before POSTing to
      // the real /api/watchdog/* endpoints.
      assert.ok(payload.data, 'expected data object on watchdog mock');
      assert.strictEqual(payload.data.kind, 'watchdog_fired');
      assert.strictEqual(payload.data.test, true);
    });
  });

  describe('iconFor / CATEGORY_ICONS', () => {
    it('maps every valid category to a PNG under assets/', () => {
      push.VALID_CATEGORIES.forEach((cat) => {
        assert.match(push.iconFor(cat), /^assets\/notif-.*\.png$/);
      });
    });

    it('returns the generic app icon for unknown categories', () => {
      assert.strictEqual(push.iconFor('bogus'), 'assets/icon-192.png');
      assert.strictEqual(push.iconFor(null), 'assets/icon-192.png');
    });

    it('uses distinct icons for each category', () => {
      const seen = new Set();
      push.VALID_CATEGORIES.forEach((cat) => {
        seen.add(push.iconFor(cat));
      });
      assert.strictEqual(seen.size, push.VALID_CATEGORIES.length);
    });
  });

  describe('sendTestToEndpoint', () => {
    beforeEach((t, done) => {
      push.init(done);
    });

    it('returns "Subscription not found" when endpoint is unknown', (t, done) => {
      push.sendTestToEndpoint('https://push.example.com/unknown', { title: 'x', body: 'y' }, (err) => {
        assert.ok(err);
        assert.strictEqual(err.message, 'Subscription not found');
        done();
      });
    });

    it('returns "No subscriptions" when push data is empty', (t, done) => {
      push._setPushData(null);
      push.sendTestToEndpoint('https://push.example.com/any', { title: 'x' }, (err) => {
        assert.ok(err);
        assert.strictEqual(err.message, 'No subscriptions');
        done();
      });
    });

    it('does not consume the rate limit slot', (t, done) => {
      // Even if we "sent" a test (which will fail with an unreachable mock
      // endpoint), the rate limit map must remain empty — tests should be
      // runnable back-to-back.
      const sub = {
        endpoint: 'https://push.example.com/rl',
        keys: { p256dh: 'abc', auth: 'def' },
      };
      push.addSubscription(sub, ['evening_report'], (err) => {
        assert.ifError(err);
        push.sendTestToEndpoint(sub.endpoint, { title: 'test', body: 'body' }, () => {
          // We don't care if the mock send succeeded — just that rate limit
          // wasn't touched.
          assert.deepStrictEqual(push._getLastSentAt(), {});
          done();
        });
      });
    });
  });
});
