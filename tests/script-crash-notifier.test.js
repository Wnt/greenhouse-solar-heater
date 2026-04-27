/**
 * Unit tests for the script-monitor → push notification bridge.
 *
 * Drives the listener with hand-crafted status snapshots that mirror
 * what script-monitor.emitStatus() would produce, and asserts:
 *   - one push fires per running → not-running transition
 *   - no push fires on subsequent polls while the script stays down
 *   - the per-type rate limit is cleared on recovery so a re-crash
 *     within the 1 h window still notifies (the user-requested behavior:
 *     "if it's crashed, up, then crashed again -> it should push a new
 *     notification").
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createScriptCrashNotifier, buildPayload } = require('../server/lib/script-crash-notifier');

function makeFakePush() {
  const sent = [];
  const cleared = [];
  return {
    sent,
    cleared,
    sendNotification(type, payload) { sent.push({ type, payload }); },
    clearRateLimit(type) { cleared.push(type); },
  };
}

describe('script-crash-notifier', () => {
  it('fires a push on running → not-running transition', () => {
    const push = makeFakePush();
    const listener = createScriptCrashNotifier(push);

    listener({ running: true, error_msg: null, crashId: null });
    assert.strictEqual(push.sent.length, 0, 'healthy state must not push');

    listener({ running: false, error_msg: 'boom', crashId: 7 });
    assert.strictEqual(push.sent.length, 1);
    assert.strictEqual(push.sent[0].type, 'script_crash');
    assert.match(push.sent[0].payload.body, /boom/);
    assert.strictEqual(push.sent[0].payload.tag, 'script-crash-7');
    assert.strictEqual(push.sent[0].payload.actions[0].action, 'restart');
  });

  it('fires only once when the script stays down across polls', () => {
    const push = makeFakePush();
    const listener = createScriptCrashNotifier(push);

    listener({ running: true });
    listener({ running: false, error_msg: 'boom', crashId: 7 });
    listener({ running: false, error_msg: 'boom', crashId: 7 });
    listener({ running: false, error_msg: 'boom', crashId: 7 });

    assert.strictEqual(push.sent.length, 1, 'no re-pushes while down');
  });

  it('fires when booting straight into a crashed state', () => {
    const push = makeFakePush();
    const listener = createScriptCrashNotifier(push);

    // First observation is already crashed (e.g. server restarted while
    // the script was dead). prevRunning starts null.
    listener({ running: false, error_msg: 'boom', crashId: 1 });
    assert.strictEqual(push.sent.length, 1);
  });

  it('clears the rate-limit slot on recovery so a re-crash notifies', () => {
    const push = makeFakePush();
    const listener = createScriptCrashNotifier(push);

    listener({ running: true });
    listener({ running: false, error_msg: 'boom', crashId: 1 });
    assert.strictEqual(push.sent.length, 1);
    assert.deepStrictEqual(push.cleared, []);

    // Recovery must clear the rate-limit slot.
    listener({ running: true });
    assert.deepStrictEqual(push.cleared, ['script_crash']);

    // Second crash within the same hour fires a fresh push because
    // the slot was cleared on recovery.
    listener({ running: false, error_msg: 'boom again', crashId: 2 });
    assert.strictEqual(push.sent.length, 2);
    assert.match(push.sent[1].payload.body, /boom again/);
    assert.strictEqual(push.sent[1].payload.tag, 'script-crash-2');
  });

  it('does not clear rate limit when first observation is healthy', () => {
    // prevRunning starts null; null → true is the boot-into-healthy
    // case. There was no prior crash to clear, so don't churn the slot.
    const push = makeFakePush();
    const listener = createScriptCrashNotifier(push);
    listener({ running: true });
    assert.deepStrictEqual(push.cleared, []);
  });

  it('ignores unreachable polls (running: null)', () => {
    const push = makeFakePush();
    const listener = createScriptCrashNotifier(push);
    listener({ running: true });
    listener({ running: null, reachable: false });
    listener({ running: true });
    assert.strictEqual(push.sent.length, 0);
    assert.deepStrictEqual(push.cleared, []);
  });

  it('truncates very long error messages in the body', () => {
    const longErr = 'A'.repeat(500);
    const payload = buildPayload({ running: false, error_msg: longErr, crashId: 99 });
    assert.ok(payload.body.length < longErr.length);
    assert.match(payload.body, /…/);
  });

  it('payload carries data.kind=script_crash and the restart action', () => {
    const payload = buildPayload({ running: false, error_msg: 'x', crashId: 5 });
    assert.strictEqual(payload.data.kind, 'script_crash');
    assert.strictEqual(payload.data.crashId, 5);
    assert.strictEqual(payload.url, '/#status');
    assert.strictEqual(payload.requireInteraction, true);
    const action = payload.actions.find(a => a.action === 'restart');
    assert.ok(action, 'expected a restart action');
    assert.strictEqual(action.type, 'button');
  });
});
