/**
 * script-monitor never-give-up recovery loop (#262 recovery-first).
 *
 * The 2026-06-25 episode: the Pro 4PM OOM'd even at IDLE/BOOT and
 * crash-looped so hard that the old 3-attempt-then-one-reboot recovery
 * EXHAUSTED and then did nothing further, leaving the controller
 * permanently DOWN until a human intervened.
 *
 * The hardened recovery must NEVER permanently give up:
 *   - restart attempts within a window are spaced by exponential backoff
 *     (no Stop/Start storm every 30 s poll),
 *   - once the per-window restart cap is hit it escalates to a device
 *     reboot, then KEEPS trying — repeated reboots, each spaced by an
 *     exponential (capped) cooldown,
 *   - `exhausted` is informational ("in backoff / escalating"), never a
 *     terminal state that stops recovery,
 *   - recovery still resets cleanly once the script comes back, and a
 *     clean stop (deploy) is still never fought.
 *
 * Time is injected via options.now so backoff windows are deterministic.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createScriptMonitor } = require('../server/lib/script-monitor');

function makeFakeDb() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    insertScriptCrash(row, cb) { const id = nextId++; rows.push(Object.assign({ id }, row)); setImmediate(() => cb(null, id)); },
  };
}

function makeRpc(script) {
  const calls = [];
  function rpc(host, method, params, timeoutMs, cb) {
    calls.push({ host, method, params });
    const q = script[method];
    if (!q || q.length === 0) { setImmediate(() => cb(new Error('no scripted reply for ' + method))); return; }
    const reply = q.length > 1 ? q.shift() : q[0];
    if (reply.err) setImmediate(() => cb(reply.err));
    else setImmediate(() => cb(null, reply.result));
  }
  return { rpc, calls };
}

const crash = { result: { id: 1, running: false, errors: ['error'], error_msg: 'OOM' } };
const up = { result: { id: 1, running: true } };
const sys = { 'Sys.GetStatus': [{ result: { uptime: 1, ram_free: 1 } }] };

// Drive N sequential polls, then run assert. A mutable clock object lets a
// test advance virtual time between polls.
function pollTimes(mon, n, clock, perStepAdvanceMs, assertFn) {
  function step(i) {
    if (i >= n) { setImmediate(assertFn); return; }
    if (perStepAdvanceMs) clock.t += perStepAdvanceMs;
    mon.pollOnce(() => setImmediate(() => step(i + 1)));
  }
  step(0);
}

describe('script-monitor never-give-up recovery loop', () => {
  it('spaces restart attempts by exponential backoff (no Stop/Start storm)', (t, done) => {
    const clock = { t: 1000 };
    const { rpc, calls } = makeRpc(Object.assign({
      'Script.GetStatus': [up, crash], // then repeats crash
      'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }], 'Shelly.Reboot': [{ result: {} }],
    }, sys));
    const mon = createScriptMonitor({
      host: 'x', rpc, db: makeFakeDb(), autoRestart: true,
      maxAutoRestarts: 5, restartBackoffMs: 60000, now: () => clock.t,
    });
    // Poll many times but advance virtual time by only 1 s each poll. With a
    // 60 s base backoff, far fewer than one-restart-per-poll should fire.
    pollTimes(mon, 8, clock, 1000, () => {
      const starts = calls.filter(c => c.method === 'Script.Start').length;
      assert.ok(starts >= 1, 'at least one restart attempted');
      assert.ok(starts <= 2, 'backoff throttled restarts well below one-per-poll, got ' + starts);
      done();
    });
  });

  it('keeps escalating to device reboots — never permanently gives up', (t, done) => {
    const clock = { t: 1000 };
    const { rpc, calls } = makeRpc(Object.assign({
      'Script.GetStatus': [up, crash], // crashes forever
      'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }], 'Shelly.Reboot': [{ result: {} }],
    }, sys));
    const mon = createScriptMonitor({
      host: 'x', rpc, db: makeFakeDb(), autoRestart: true,
      maxAutoRestarts: 2, restartBackoffMs: 1000, rebootBackoffMs: 60000,
      maxBackoffMs: 600000, now: () => clock.t,
    });
    // Advance 10 min per poll so every backoff window is satisfied and each
    // escalation step is allowed to fire. Over many polls we must see MORE
    // than one reboot — the old code fired exactly one then stopped.
    pollTimes(mon, 12, clock, 10 * 60 * 1000, () => {
      const reboots = calls.filter(c => c.method === 'Shelly.Reboot').length;
      assert.ok(reboots >= 2, 'recovery keeps rebooting (never gives up); got ' + reboots);
      // And it never marks itself terminally done: still trying.
      const s = mon.getStatus();
      assert.strictEqual(typeof s.autoRestart.rebootCount, 'number');
      assert.ok(s.autoRestart.rebootCount >= 2);
      done();
    });
  });

  it('reboot escalation is rate-limited (no reboot every poll)', (t, done) => {
    const clock = { t: 1000 };
    const { rpc, calls } = makeRpc(Object.assign({
      'Script.GetStatus': [up, crash],
      'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }], 'Shelly.Reboot': [{ result: {} }],
    }, sys));
    const mon = createScriptMonitor({
      host: 'x', rpc, db: makeFakeDb(), autoRestart: true,
      maxAutoRestarts: 1, restartBackoffMs: 0, rebootBackoffMs: 300000,
      maxBackoffMs: 600000, now: () => clock.t,
    });
    // Advance only 1 s per poll: the 5-min reboot backoff must throttle hard.
    pollTimes(mon, 20, clock, 1000, () => {
      const reboots = calls.filter(c => c.method === 'Shelly.Reboot').length;
      assert.ok(reboots <= 1, 'reboot throttled by backoff within a short window; got ' + reboots);
      done();
    });
  });

  it('resets recovery state on script recovery', (t, done) => {
    const clock = { t: 1000 };
    const { rpc } = makeRpc(Object.assign({
      'Script.GetStatus': [up, crash, crash, up], // crash twice, then recover
      'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }], 'Shelly.Reboot': [{ result: {} }],
    }, sys));
    const mon = createScriptMonitor({
      host: 'x', rpc, db: makeFakeDb(), autoRestart: true,
      maxAutoRestarts: 5, restartBackoffMs: 0, now: () => clock.t,
    });
    pollTimes(mon, 4, clock, 1000, () => {
      const s = mon.getStatus();
      assert.strictEqual(s.autoRestart.attempts, 0, 'attempts cleared on recovery');
      assert.strictEqual(s.autoRestart.rebootCount, 0, 'reboot count cleared on recovery');
      assert.strictEqual(s.autoRestart.exhausted, false);
      done();
    });
  });

  it('still never fights a clean stop (deploy)', (t, done) => {
    const clock = { t: 1000 };
    const cleanStop = { result: { id: 1, running: false, errors: [] } };
    const { rpc, calls } = makeRpc(Object.assign({
      'Script.GetStatus': [up, cleanStop],
      'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }], 'Shelly.Reboot': [{ result: {} }],
    }, sys));
    const mon = createScriptMonitor({
      host: 'x', rpc, db: makeFakeDb(), autoRestart: true, now: () => clock.t,
    });
    pollTimes(mon, 6, clock, 10 * 60 * 1000, () => {
      assert.ok(!calls.some(c => c.method === 'Script.Stop'), 'no restart for a clean stop');
      assert.ok(!calls.some(c => c.method === 'Shelly.Reboot'), 'no reboot for a clean stop');
      done();
    });
  });
});
