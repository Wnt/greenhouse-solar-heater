/**
 * Script JsVar-memory mitigations (2026-06 out_of_memory episode).
 *
 * Root cause (confirmed via live device + script_crashes DB + spare-2PM
 * measurement): the merged control script runs in a fixed ~25 KB Espruino
 * JsVar pool and idles ~300 B below the ceiling. Peak-solar midday
 * transitions push transient allocations over the edge → Espruino
 * "out_of_memory". The dominant transient is the per-resume
 * emitStateUpdate() → buildSnapshotFromState() → JSON.stringify() spike,
 * which the old scheduler fired once *per resume cycle* during a single
 * transition (measured: 5 emits for one SC→GH flip). Device RAM was never
 * the constraint (it stayed ~90 KB free); the JsVar pool is.
 *
 * Two mitigations are pinned down here:
 *
 *   1. Emit coalescing — scheduleStep() must NOT broadcast a fresh snapshot
 *      on every resume. At most one "valves_opening" snapshot per transition.
 *
 *   2. Periodic safe self-reboot — only a full device reboot defragments
 *      the JsVar pool (a script restart does not, which is why the
 *      server-side auto-restart loop never cleared the 2026-06 episode while
 *      the device stayed up ~50 days). The script reboots once device uptime
 *      passes REBOOT_UPTIME_S, but ONLY while safely IDLE (never
 *      mid-transition, mid-drain, or under manual override) so freeze /
 *      overheat protection is never interrupted.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

const MODE_VALVES = {
  SOLAR_CHARGING:     { vi_btm:true,  vi_top:false, vi_coll:false, vo_coll:true,  vo_rad:false, vo_tank:false, v_air:false },
  GREENHOUSE_HEATING: { vi_btm:false, vi_top:true,  vi_coll:false, vo_coll:false, vo_rad:true,  vo_tank:false, v_air:false },
};
const MODE_ACTUATORS = {
  GREENHOUSE_HEATING: { pump:true, fan:true, space_heater:false, immersion_heater:false },
};

function createRuntime() {
  let now = 1700000000000;
  let sysUptime = 0;
  let timers = [];
  let timerIdCounter = 0;
  const kvs = {};
  const calls = [];
  const publishes = [];

  function shellyCall(method, params, cb) {
    params = params || {};
    calls.push(method);
    if (method === 'HTTP.GET') { setImmediate(function () { if (cb) cb({ code: 200, body: '{"tC":20}' }, null); }); return; }
    if (method === 'KVS.Get') { const v = kvs[params.key] || null; setImmediate(function () { if (cb) cb(v ? { value: v } : null, null); }); return; }
    if (method === 'KVS.Set') { kvs[params.key] = params.value; setImmediate(function () { if (cb) cb({}, null); }); return; }
    setImmediate(function () { if (cb) cb({}, null); });
  }
  function timerSet(ms, repeat, cb) { const id = ++timerIdCounter; timers.push({ id, repeat: !!repeat, cb, dueAt: now + (ms || 0) }); return id; }
  function timerClear(id) { timers = timers.filter(function (t) { return t.id !== id; }); }

  const globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus: function (type) {
        if (type === 'sys') return { unixtime: Math.floor(now / 1000), uptime: sysUptime };
        if (type === 'switch') return { apower: 0, output: false };
        return {};
      },
      emitEvent: function () {}, addEventHandler: function () {}, addStatusHandler: function () {},
    },
    Timer: { set: timerSet, clear: timerClear },
    MQTT: {
      subscribe: function () {}, unsubscribe: function () {},
      publish: function (topic, payload) { publishes.push({ topic, payload }); },
      isConnected: function () { return true; }, setConnectHandler: function () {},
    },
    JSON, Date: { now: function () { return now; } }, Math, parseInt, print: function () {},
  };

  return {
    globals,
    kvs,
    rebootCount: function () { return calls.filter(function (m) { return m === 'Shelly.Reboot'; }).length; },
    stateSnapshots: function () {
      // Epic #254 (#258): the device now publishes the MINIMAL decision-state
      // payload on greenhouse/state/min (the server reassembles the full
      // greenhouse/state). These assertions read mode/transitioning/
      // transition_step, all of which survive in the minimal payload.
      return publishes
        .filter(function (p) { return p.topic === 'greenhouse/state/min'; })
        .map(function (p) { return JSON.parse(p.payload); });
    },
    setUptime: function (s) { sysUptime = s; },
    // Event-driven settle: fire one-shot timers in due order, one per
    // setImmediate so async Shelly.call (HTTP/KVS) callbacks drain in
    // between, advancing the virtual clock to each timer's due time so
    // wall-clock-gated logic (valve open windows, pump prime) actually
    // elapses. The repeating 30 s control-loop timer is skipped, so the
    // system never auto-reverts mid-test. Exits once nothing is pending for
    // a few consecutive rounds — i.e. boot/transition has fully settled.
    flush: function (done) {
      let idle = 0, total = 0;
      function loop() {
        const oneshots = timers.filter(function (t) { return !t.repeat; });
        if (oneshots.length === 0) {
          // No pending one-shot. Keep draining setImmediate so timer-less
          // async chains (closeAllValves, loadPersistedState, valve HTTP
          // batches) can register their next timer. Only conclude the boot/
          // transition has settled after a long quiet stretch.
          if (++idle >= 50) { done(); return; }
        } else {
          idle = 0;
          let next = oneshots[0];
          for (let i = 1; i < oneshots.length; i++) if (oneshots[i].dueAt < next.dueAt) next = oneshots[i];
          if (now < next.dueAt) now = next.dueAt;
          timers = timers.filter(function (t) { return t.id !== next.id; });
          try { next.cb(); } catch (e) {}
        }
        if (++total >= 2000) { done(); return; }
        setImmediate(loop);
      }
      setImmediate(loop);
    },
  };
}

function loadScript(rt, cfg) {
  rt.kvs.config = JSON.stringify(Object.assign({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }, cfg || {}));
  rt.kvs.drained = '0';
  rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
  const src = fs.readFileSync(path.join(SHELLY_DIR, 'control-logic.js'), 'utf8') + '\n' +
              fs.readFileSync(path.join(SHELLY_DIR, 'control.js'), 'utf8');
  const g = rt.globals;
  const fn = new Function('Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print', '__TEST_HARNESS', src);
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

function boot(rt, cfg, done) { loadScript(rt, cfg); rt.flush(done); }

// ── 1. Emit coalescing ──

describe('transition emit coalescing (JsVar peak reduction)', function () {
  it('publishes at most one valves_opening snapshot per transition', function (t, done) {
    const rt = createRuntime();
    boot(rt, null, function () {
      // SOLAR_CHARGING → GREENHOUSE_HEATING: closes vi_btm+vo_coll, opens
      // vi_top+vo_rad. The close→open hand-off re-enters scheduleStep on a
      // fresh timer frame and the opens carry an open-window resume, so the
      // transition resumes multiple times — the exact path the old code
      // re-broadcast a full snapshot on (5 emits, measured).
      rt.globals.Shelly.__test_driveTransition('SOLAR_CHARGING', {
        nextMode: 'GREENHOUSE_HEATING',
        valves: MODE_VALVES.GREENHOUSE_HEATING,
        actuators: MODE_ACTUATORS.GREENHOUSE_HEATING,
        flags: {},
      });
      rt.flush(function () {
        const snaps = rt.stateSnapshots();
        const opening = snaps.filter(function (s) { return s.transitioning === true && s.transition_step === 'valves_opening'; });
        const pumpStop = snaps.filter(function (s) { return s.transition_step === 'pump_stop'; });
        // One transition was driven, so exactly one pump_stop entry frames it.
        assert.strictEqual(pumpStop.length, 1, 'expected exactly one transition (pump_stop) in this test');
        assert.ok(opening.length <= 1,
          'scheduleStep must coalesce mid-transition broadcasts: expected ≤1 ' +
          '"valves_opening" snapshot for one transition, got ' + opening.length +
          ' (per-resume emit regression — the JsVar peak driver)');
        // The transition must still complete and announce the new mode, so
        // coalescing does not blind the server/playground to the outcome.
        assert.ok(snaps.some(function (s) { return s.mode === 'greenhouse_heating'; }),
          'transition must still publish its final greenhouse_heating state');
        done();
      });
    });
  });
});

// ── 2. Periodic safe self-reboot ──

describe('periodic JsVar-defrag reboot (uptime-gated, IDLE-only)', function () {
  it('reboots when device uptime exceeds threshold and system is IDLE', function (t, done) {
    const rt = createRuntime();
    boot(rt, null, function () {
      rt.setUptime(8 * 24 * 3600); // 8 days — past the 7-day threshold
      rt.globals.Shelly.__test_controlTick();
      assert.strictEqual(rt.rebootCount(), 1, 'expected one Shelly.Reboot on an old, idle device');
      done();
    });
  });

  it('does NOT reboot when uptime is below the threshold', function (t, done) {
    const rt = createRuntime();
    boot(rt, null, function () {
      rt.setUptime(3 * 24 * 3600); // 3 days — under threshold
      rt.globals.Shelly.__test_controlTick();
      assert.strictEqual(rt.rebootCount(), 0, 'must not reboot a recently-booted device');
      done();
    });
  });

  it('does NOT reboot while manual override is active, even past the threshold', function (t, done) {
    const rt = createRuntime();
    const future = Math.floor(1700000000000 / 1000) + 3600;
    boot(rt, { mo: { a: true, ex: future, fm: null }, v: 5 }, function () {
      rt.setUptime(30 * 24 * 3600); // 30 days
      rt.globals.Shelly.__test_controlTick();
      assert.strictEqual(rt.rebootCount(), 0,
        'manual override suspends automation — a reboot would break deterministic manual control');
      done();
    });
  });
});
