/**
 * script-crash-notifier severity behaviour:
 *   - The routine crash push is FORCED (delivered regardless of the
 *     per-category opt-in) — control-script-down is safety-critical, not a
 *     preference. (A banner alone let the 2026-06-22 collector stagnate.)
 *   - When auto-restart is EXHAUSTED (the monitor gave up), a distinct
 *     CRITICAL "manual intervention needed" push fires once, bypassing both
 *     opt-in and the rate limit.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createScriptCrashNotifier } = require('../server/lib/script-crash-notifier');

function makePush() {
  const sent = [];
  return {
    sent,
    sendNotification(type, payload, opts) { sent.push({ type, payload, opts: opts || {} }); },
    clearRateLimit() {},
  };
}

describe('script-crash-notifier severity', () => {
  it('forces delivery of the crash push (bypasses per-category opt-in)', () => {
    const push = makePush();
    const notify = createScriptCrashNotifier(push);
    notify({ running: true });               // healthy baseline
    notify({ running: false, error_msg: 'OOM', crashId: 7 }); // crash
    assert.strictEqual(push.sent.length, 1);
    assert.strictEqual(push.sent[0].type, 'script_crash');
    assert.strictEqual(push.sent[0].opts.force, true, 'crash push must be forced');
  });

  it('fires a CRITICAL push once when auto-restart is exhausted', () => {
    const push = makePush();
    const notify = createScriptCrashNotifier(push);
    notify({ running: true });
    notify({ running: false, error_msg: 'OOM', crashId: 7, autoRestart: { exhausted: false, attempts: 1 } });
    const crashPushes = push.sent.length; // the crash push
    // Monitor escalates: still down, auto-restart now exhausted.
    notify({ running: false, error_msg: 'OOM', crashId: 7, autoRestart: { exhausted: true, attempts: 3 } });
    const critical = push.sent[push.sent.length - 1];
    assert.strictEqual(push.sent.length, crashPushes + 1, 'exactly one critical push added');
    assert.strictEqual(critical.opts.force, true, 'critical push is forced');
    assert.strictEqual(critical.opts.ignoreRateLimit, true, 'critical push bypasses rate limit');
    assert.match(critical.payload.body + critical.payload.title, /manual|intervention|down/i);

    // It must not re-fire while still exhausted on subsequent polls.
    notify({ running: false, error_msg: 'OOM', crashId: 7, autoRestart: { exhausted: true, attempts: 3 } });
    assert.strictEqual(push.sent.length, crashPushes + 1, 'critical push does not repeat while exhausted');
  });
});
