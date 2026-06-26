/**
 * script-monitor reactive auto-restart.
 *
 * When the control script crashes (running → not-running WITH an error
 * trace), the monitor should automatically restart it instead of waiting
 * for a human — the morning 2026-06-22 episode left the collector to
 * stagnate to ~90 °C for hours because recovery depended on someone
 * clicking "restart". Capped (≤N per window) so a true crash-loop can't
 * spin forever; escalates to one device reboot when script-restarts don't
 * take; resets on recovery; never fires on a clean stop (a deploy's
 * Script.Stop/Start has no error trace).
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
    // Consume until one remains, then repeat the last reply indefinitely.
    const reply = q.length > 1 ? q.shift() : q[0];
    if (reply.err) setImmediate(() => cb(reply.err));
    else setImmediate(() => cb(null, reply.result));
  }
  return { rpc, calls };
}

const crash = { result: { id: 1, running: false, errors: ['error'], error_msg: 'OOM' } };
const up = { result: { id: 1, running: true } };
const sys = { 'Sys.GetStatus': [{ result: { uptime: 1, ram_free: 1 } }] };

// Drive N sequential polls, then run assert.
function pollTimes(mon, n, assertFn) {
  function step(i) {
    if (i >= n) { setImmediate(assertFn); return; }
    mon.pollOnce(() => setImmediate(() => step(i + 1)));
  }
  step(0);
}

describe('script-monitor auto-restart', () => {
  it('auto-restarts the script on a crash (Script.Stop + Script.Start)', (t, done) => {
    const { rpc, calls } = makeRpc(Object.assign({ 'Script.GetStatus': [up, crash], 'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }] }, sys));
    const mon = createScriptMonitor({ host: 'x', rpc, db: makeFakeDb(), autoRestart: true });
    pollTimes(mon, 2, () => {
      const s = mon.getStatus();
      assert.strictEqual(s.autoRestart.enabled, true);
      assert.strictEqual(s.autoRestart.attempts, 1, 'one restart attempt recorded');
      assert.ok(calls.some(c => c.method === 'Script.Stop'), 'Script.Stop issued');
      done();
    });
  });

  it('does NOT auto-restart a clean stop (no error trace — e.g. a deploy)', (t, done) => {
    const cleanStop = { result: { id: 1, running: false, errors: [] } };
    const { rpc, calls } = makeRpc(Object.assign({ 'Script.GetStatus': [up, cleanStop], 'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }] }, sys));
    const mon = createScriptMonitor({ host: 'x', rpc, db: makeFakeDb(), autoRestart: true });
    pollTimes(mon, 2, () => {
      assert.strictEqual(mon.getStatus().autoRestart.attempts, 0, 'no restart for a clean stop');
      assert.ok(!calls.some(c => c.method === 'Script.Stop'), 'no Script.Stop for a clean stop');
      done();
    });
  });

  it('caps restarts and escalates to a device reboot when the script will not stay up', (t, done) => {
    const { rpc, calls } = makeRpc(Object.assign({
      'Script.GetStatus': [up, crash], // then repeats `crash`
      'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }], 'Shelly.Reboot': [{ result: {} }],
    }, sys));
    // Inject a clock advancing 1 min/poll so the per-attempt restart backoff
    // is satisfied and both restarts plus the reboot escalation fire within
    // the 5-poll budget. (Recovery never permanently gives up — the reboot
    // loop is covered in script-monitor-recovery-loop.test.js; here we just
    // assert the cap→reboot handoff still happens.)
    const clock = { t: 1000 };
    const mon = createScriptMonitor({
      host: 'x', rpc, db: makeFakeDb(), autoRestart: true, maxAutoRestarts: 2,
      restartBackoffMs: 1000, rebootBackoffMs: 60000, now: () => clock.t,
    });
    // Stop right after the escalation poll (poll 4): up, crash→restart#1,
    // crash→restart#2, crash→reboot. A 5th poll would (correctly) begin a new
    // restart attempt — never-give-up — which the recovery-loop suite covers.
    function step(i) {
      if (i >= 4) {
        const s = mon.getStatus();
        assert.strictEqual(s.autoRestart.exhausted, true, 'marked exhausted after the cap');
        assert.ok(calls.some(c => c.method === 'Shelly.Reboot'), 'escalated to a device reboot');
        const reboots = calls.filter(c => c.method === 'Shelly.Reboot').length;
        assert.strictEqual(reboots, 1, 'one reboot in this short window (rate-limited)');
        const starts = calls.filter(c => c.method === 'Script.Start').length;
        assert.strictEqual(starts, 2, 'two script restarts before escalating');
        done();
        return;
      }
      clock.t += 60 * 1000;
      mon.pollOnce(() => setImmediate(() => step(i + 1)));
    }
    step(0);
  });

  it('resets after recovery so a later crash can be auto-restarted again', (t, done) => {
    const { rpc } = makeRpc(Object.assign({ 'Script.GetStatus': [up, crash, up, crash], 'Script.Stop': [{ result: {} }], 'Script.Start': [{ result: {} }] }, sys));
    const mon = createScriptMonitor({ host: 'x', rpc, db: makeFakeDb(), autoRestart: true, maxAutoRestarts: 5 });
    pollTimes(mon, 4, () => {
      const s = mon.getStatus();
      assert.strictEqual(s.autoRestart.attempts, 1, 'attempt counter reset on recovery, then 1 after the new crash');
      assert.strictEqual(s.autoRestart.exhausted, false);
      done();
    });
  });

  it('is off by default (back-compat) — no restart without opt-in', (t, done) => {
    const { rpc, calls } = makeRpc(Object.assign({ 'Script.GetStatus': [up, crash] }, sys));
    const mon = createScriptMonitor({ host: 'x', rpc, db: makeFakeDb() });
    pollTimes(mon, 2, () => {
      assert.strictEqual(mon.getStatus().autoRestart.enabled, false);
      assert.ok(!calls.some(c => c.method === 'Script.Stop'), 'no auto-restart when disabled');
      done();
    });
  });
});
