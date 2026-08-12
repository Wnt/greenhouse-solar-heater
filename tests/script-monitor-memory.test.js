/**
 * Unit tests for the JsVar memory guard in script-monitor (spec 025, FR-2/3).
 *
 * Background: on 2026-08-12 the Pro 4PM's script pool sat at its ceiling
 * (Script.GetStatus mem_peak == 25186 == mem_used + mem_free) and the
 * controller silently stopped switching modes for 48 minutes while the
 * collector stagnated to 71.7 °C. A device reboot is the only way to reclaim
 * a fragmented Espruino pool — a script restart cannot.
 *
 * The guard evaluates the freshest 30 s poll result every 5 minutes and
 * reboots only when every safety gate allows it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createScriptMonitor } = require('../server/lib/script-monitor');

const POOL = 25186;

// mem_used + mem_free == pool, so ratio is driven by mem_peak alone.
function statusWithPeak(peak) {
  return { id: 1, running: true, mem_used: 19488, mem_peak: peak, mem_free: POOL - 19488, cpu: 2 };
}

// Records every RPC and answers Script.GetStatus from a live `peak` closure.
function makeRpc(getPeak) {
  const calls = [];
  return {
    calls,
    rpc(host, method, params, timeoutMs, callback) {
      calls.push({ host, method, params });
      if (method === 'Script.GetStatus') { callback(null, statusWithPeak(getPeak())); return; }
      callback(null, { ok: true });
    },
  };
}

function reboots(rpc) {
  return rpc.calls.filter((c) => c.method === 'Shelly.Reboot').length;
}

function makeFakePush() {
  const sent = [];
  return { sent, sendNotification(type, payload, opts) { sent.push({ type, payload, opts }); } };
}

// Drive `n` memory evaluations by advancing the injected clock past the
// 5-minute cadence between polls.
function runChecks(monitor, clock, n, stepMs) {
  for (let i = 0; i < n; i++) {
    clock.t += stepMs != null ? stepMs : 5 * 60 * 1000;
    monitor.pollOnce();
  }
}

function setup(opts) {
  opts = opts || {};
  const clock = { t: 1_000_000 };
  const rpc = makeRpc(opts.getPeak || (() => POOL));
  const push = makeFakePush();
  const monitor = createScriptMonitor(Object.assign({
    rpc: rpc.rpc,
    now: () => clock.t,
    memGuard: true,
    push,
    autoRestart: false,
  }, opts.monitor));
  // A healthy IDLE snapshot unless the test says otherwise.
  monitor.recordStateSnapshot(Object.assign({
    ts: clock.t, mode: 'idle', transitioning: false, manual_override: null,
  }, opts.snapshot));
  return { clock, rpc, push, monitor };
}

describe('script-monitor memory guard', () => {
  it('exposes the memory block in getStatus()', () => {
    const { monitor, clock } = setup({ getPeak: () => 20000 });
    clock.t += 1000;
    monitor.pollOnce();
    const mem = monitor.getStatus().memory;
    assert.strictEqual(mem.peak, 20000);
    assert.strictEqual(mem.total, POOL);
    assert.ok(Math.abs(mem.peakRatio - 20000 / POOL) < 1e-9);
    assert.strictEqual(mem.rebootCount, 0);
  });

  // Regression pin for the first production firing: the routine post-boot
  // peak (24528 of 25186 B = 97.4 %) must NOT count as exhaustion, or the
  // guard spends its daily budget on healthy operation.
  it('does not reboot at the routine post-boot peak of 97.4 %', () => {
    const { monitor, clock, rpc } = setup({ getPeak: () => 24528 });
    runChecks(monitor, clock, 6);
    assert.strictEqual(reboots(rpc), 0);
  });

  it('reboots when the pool is fully consumed', () => {
    const { monitor, clock, rpc } = setup({ getPeak: () => POOL });
    runChecks(monitor, clock, 2);
    assert.strictEqual(reboots(rpc), 1);
  });

  it('does not reboot below the peak ratio threshold', () => {
    const { monitor, clock, rpc } = setup({ getPeak: () => Math.floor(POOL * 0.9) });
    runChecks(monitor, clock, 6);
    assert.strictEqual(reboots(rpc), 0);
  });

  it('requires two consecutive high checks before rebooting', () => {
    const { monitor, clock, rpc } = setup();
    runChecks(monitor, clock, 1);
    assert.strictEqual(reboots(rpc), 0);
    runChecks(monitor, clock, 1);
    assert.strictEqual(reboots(rpc), 1);
  });

  it('only evaluates memory on the 5-minute cadence, not every 30 s poll', () => {
    const { monitor, clock, rpc } = setup();
    // The first poll seeds one evaluation; the next ten (5 min of 30 s polls)
    // record stats but must not evaluate again, so no reboot yet.
    runChecks(monitor, clock, 10, 30 * 1000);
    assert.strictEqual(reboots(rpc), 0);
    assert.strictEqual(monitor.getStatus().memory.consecutiveHigh, 1);
    // The poll that crosses the 5-minute boundary produces the second
    // evaluation, and that is the one that reboots.
    runChecks(monitor, clock, 1, 30 * 1000);
    assert.strictEqual(reboots(rpc), 1);
  });

  it('sends one forced push when it reboots', () => {
    const { monitor, clock, push } = setup();
    runChecks(monitor, clock, 2);
    assert.strictEqual(push.sent.length, 1);
    assert.strictEqual(push.sent[0].opts.force, true);
    assert.match(push.sent[0].payload.title, /memory/i);
  });

  it('never reboots during active_drain', () => {
    const { monitor, clock, rpc } = setup({ snapshot: { mode: 'active_drain' } });
    runChecks(monitor, clock, 4);
    assert.strictEqual(reboots(rpc), 0);
  });

  it('never reboots while transitioning', () => {
    const { monitor, clock, rpc } = setup({ snapshot: { transitioning: true } });
    runChecks(monitor, clock, 4);
    assert.strictEqual(reboots(rpc), 0);
  });

  it('never reboots under manual override', () => {
    const { monitor, clock, rpc } = setup({ snapshot: { manual_override: { active: true } } });
    runChecks(monitor, clock, 4);
    assert.strictEqual(reboots(rpc), 0);
  });

  it('never reboots without a mode observation', () => {
    const clock = { t: 1_000_000 };
    const rpc = makeRpc(() => POOL);
    const monitor = createScriptMonitor({
      rpc: rpc.rpc, now: () => clock.t, memGuard: true, autoRestart: false,
    });
    runChecks(monitor, clock, 4);
    assert.strictEqual(reboots(rpc), 0);
  });

  it('reboots solar_charging (losing one tick beats a starved pool)', () => {
    const { monitor, clock, rpc } = setup({ snapshot: { mode: 'solar_charging' } });
    runChecks(monitor, clock, 2);
    assert.strictEqual(reboots(rpc), 1);
  });

  it('honors the cooldown between memory reboots', () => {
    const { monitor, clock, rpc } = setup();
    runChecks(monitor, clock, 2);
    assert.strictEqual(reboots(rpc), 1);
    // 1 h of further high checks — still inside the 2 h cooldown.
    runChecks(monitor, clock, 12);
    assert.strictEqual(reboots(rpc), 1);
    // Past the cooldown, it may fire again.
    clock.t += 2 * 60 * 60 * 1000;
    runChecks(monitor, clock, 2);
    assert.strictEqual(reboots(rpc), 2);
  });

  it('caps memory reboots per day and escalates with one forced push', () => {
    const { monitor, clock, rpc, push } = setup({
      monitor: { memRebootCooldownMs: 60 * 1000, maxMemRebootsPerDay: 2 },
    });
    for (let i = 0; i < 6; i++) {
      clock.t += 10 * 60 * 1000;
      runChecks(monitor, clock, 2);
    }
    assert.strictEqual(reboots(rpc), 2);
    const kinds = push.sent.map((p) => p.payload.data.kind);
    assert.deepStrictEqual(kinds, ['memory_reboot', 'memory_reboot', 'memory_guard_exhausted']);
    assert.strictEqual(monitor.getStatus().memory.exhausted, true);
  });

  it('does nothing when the guard is disabled', () => {
    const { monitor, clock, rpc } = setup({ monitor: { memGuard: false } });
    runChecks(monitor, clock, 6);
    assert.strictEqual(reboots(rpc), 0);
    assert.strictEqual(monitor.getStatus().memory.peak, POOL);
  });

  it('does not reboot while the script is not running (crash loop owns that)', () => {
    const clock = { t: 1_000_000 };
    const calls = [];
    const monitor = createScriptMonitor({
      now: () => clock.t,
      memGuard: true,
      autoRestart: false,
      rpc(host, method, params, timeoutMs, callback) {
        calls.push(method);
        if (method === 'Script.GetStatus') {
          callback(null, { id: 1, running: false, mem_used: 19488, mem_peak: POOL, mem_free: POOL - 19488 });
          return;
        }
        callback(null, {});
      },
    });
    monitor.recordStateSnapshot({ ts: clock.t, mode: 'idle', transitioning: false });
    runChecks(monitor, clock, 4);
    assert.strictEqual(calls.filter((m) => m === 'Shelly.Reboot').length, 0);
  });
});
