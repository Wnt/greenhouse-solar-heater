/**
 * push.sendNotification severity options:
 *   - force:           deliver to every subscription regardless of the
 *                      per-category opt-in (for safety-critical alerts the
 *                      user must receive even if they never toggled the
 *                      category — e.g. the control script is down).
 *   - ignoreRateLimit: bypass the 1-per-hour-per-type throttle.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('push.sendNotification severity options', () => {
  let push;
  let sent;
  let tmpDir;

  beforeEach((t, done) => {
    sent = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-force-'));
    delete process.env.S3_ENDPOINT; delete process.env.S3_BUCKET;
    delete process.env.S3_ACCESS_KEY_ID; delete process.env.S3_SECRET_ACCESS_KEY;
    process.env.PUSH_CONFIG_PATH = path.join(tmpDir, 'push.json');

    delete require.cache[require.resolve('../server/lib/push.js')];
    delete require.cache[require.resolve('../server/lib/web-push.js')];
    require.cache[require.resolve('../server/lib/web-push.js')] = {
      id: require.resolve('../server/lib/web-push.js'),
      exports: {
        generateVAPIDKeys() { return { publicKey: 'p', privateKey: 'k' }; },
        setVapidDetails() {},
        sendNotification(sub) { sent.push(sub.endpoint); return Promise.resolve(); },
      },
    };
    push = require('../server/lib/push.js');
    push._reset();
    push.init(function () {
      push._setPushData({
        vapidKeys: { publicKey: 'p', privateKey: 'k' },
        subscriptions: [
          { endpoint: 'opted-in', keys: { p256dh: 'a', auth: 'b' }, categories: ['script_crash'] },
          { endpoint: 'opted-out', keys: { p256dh: 'a', auth: 'b' }, categories: ['evening_report'] },
        ],
      });
      done();
    });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
    delete process.env.PUSH_CONFIG_PATH;
    delete require.cache[require.resolve('../server/lib/web-push.js')];
  });

  it('respects per-category opt-in by default', () => {
    push.sendNotification('script_crash', { title: 't' });
    assert.deepStrictEqual(sent, ['opted-in'], 'only the opted-in subscription receives a normal send');
  });

  it('force delivers to every subscription regardless of opt-in', () => {
    push.sendNotification('script_crash', { title: 't' }, { force: true });
    assert.deepStrictEqual(sent.slice().sort(), ['opted-in', 'opted-out'], 'force reaches everyone');
  });

  it('ignoreRateLimit + force bypasses the per-type throttle and opt-in', () => {
    push.sendNotification('script_crash', { title: 'first' });
    assert.strictEqual(sent.length, 1);
    push.sendNotification('script_crash', { title: 'second' });
    assert.strictEqual(sent.length, 1, 'second normal send is rate-limited');
    push.sendNotification('script_crash', { title: 'critical' }, { force: true, ignoreRateLimit: true });
    assert.strictEqual(sent.length, 3, 'critical send punches through to both subscriptions');
  });
});
