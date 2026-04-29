/**
 * Override forced-mode tests (Task 6).
 *
 * Verifies that mo.fm drives transitionTo() immediately, that switching
 * forced modes mid-override bypasses the min-duration hold, and that every
 * override exit path (user clear, TTL expiry) runs a staged IDLE transition
 * so relays don't linger in a user-set state.
 *
 * Drain-exit regression: exiting an AD-forced override must use the
 * valves-first + DRAIN_EXIT_PUMP_RUN_MS path, not the default pump-first
 * path.
 *
 * Timing guide for these tests:
 *   - VALVE_SETTLE_MS = 1 000 ms (pump-stop → valve-schedule delay)
 *   - openWindowMs    = 20 000 ms (each valve-open energizing window)
 *   - PUMP_PRIME_MS   =  5 000 ms (post-valve wait, non-drain exit)
 *   - DRAIN_EXIT_PUMP_RUN_MS = 20 000 ms (post-valve wait, AD exit)
 *   - minOpenMs       = 60 000 ms (valve min-open hold before close)
 *
 * Advance budget per transition after valves are open:
 *   SC or GH entry:  ~35 s (1 s settle + 20 s window + 5 s prime + margin)
 *   AD exit to IDLE: ~50 s (valves close; v_air needs 20 s open-window;
 *                    then 20 s DRAIN_EXIT_PUMP_RUN_MS; total ≥ 40 s)
 *   SC exit to IDLE: ~20 s (pump-stop + 1 s settle + valve closes immediate
 *                    since minOpenMs has expired; 5 s prime for IDLE)
 *
 * Setup: each test that asserts ordering calls setConfig(mo={a:true,...}) to
 * establish the override in the script's in-memory state, then calls
 * __test_driveTransition to seed state.mode and kick off the mode's own
 * transition. After 90 s (ensures valves are fully open and minOpenMs=60 s
 * hold has expired), we clear mo to trigger the exit transition.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

// ── Ordering runtime (verbatim copy of the helper in shelly-transition.test.js) ──

function createOrderingRuntime(opts) {
  opts = opts || {};
  let now = opts.startTime || 1700000000000; // arbitrary epoch ms
  const events = []; // { t, kind, detail }
  let timers = []; // { id, dueAt, cb, repeat, ms }
  let timerIdCounter = 0;
  const kvs = {};
  let configVersion = 100; // bumped by setConfig() — must exceed the BASE_CONFIG v seeded into KVS
  const eventHandlers = [];
  let httpResponder = opts.httpResponder || function(_url) {
    return { ok: true, body: '' };
  };
  let componentStatus = opts.componentStatus || function() {
    return { apower: 50, output: true };
  };

  function record(kind, detail) {
    events.push({ t: now, kind, detail });
  }

  function shellyCall(method, params, cb) {
    params = params || {};
    if (method === 'Switch.Set') {
      record('switch_set', { id: params.id, on: params.on });
      setImmediate(function() { if (cb) cb({}, null); });
      return;
    }
    if (method === 'Switch.SetConfig') {
      setImmediate(function() { if (cb) cb({}, null); });
      return;
    }
    if (method === 'KVS.Get') {
      const val = kvs[params.key] || null;
      setImmediate(function() { if (cb) cb(val ? { value: val } : null, null); });
      return;
    }
    if (method === 'KVS.Set') {
      kvs[params.key] = params.value;
      setImmediate(function() { if (cb) cb({}, null); });
      return;
    }
    if (method === 'HTTP.GET') {
      const url = params.url || '';
      record('http_get', { url });
      const resp = httpResponder(url);
      setImmediate(function() {
        if (resp.ok) {
          if (cb) cb({ code: 200, body: resp.body || '' }, null);
        } else {
          if (cb) cb(null, resp.err || 'error');
        }
      });
      return;
    }
    setImmediate(function() { if (cb) cb({}, null); });
  }

  function timerSet(ms, repeat, cb) {
    const id = ++timerIdCounter;
    timers.push({ id, dueAt: now + ms, cb, repeat, ms });
    return id;
  }
  function timerClear(id) {
    timers = timers.filter(function(t) { return t.id !== id; });
  }

  function emitEvent(name, data) {
    for (let i = 0; i < eventHandlers.length; i++) {
      try { eventHandlers[i]({ info: { event: name, data } }); } catch(e) {}
    }
  }

  const globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus: function(type) {
        if (type === 'switch') return componentStatus();
        if (type === 'sys') return { unixtime: Math.floor(now / 1000) };
        return {};
      },
      emitEvent,
      addEventHandler: function(fn) { eventHandlers.push(fn); },
      addStatusHandler: function() {},
    },
    Timer: { set: timerSet, clear: timerClear },
    MQTT: {
      _subs: {},
      _connectHandler: null,
      subscribe: function(topic, cb) { globals.MQTT._subs[topic] = cb; },
      unsubscribe: function(topic) { delete globals.MQTT._subs[topic]; },
      publish: function() {},
      isConnected: function() { return true; },
      setConnectHandler: function(cb) { globals.MQTT._connectHandler = cb; if (cb) cb(); },
    },
    JSON,
    Date: { now: function() { return now; } },
    Math,
    parseInt,
    print: function() {},
  };

  return {
    globals,
    events: function() { return events.slice(); },
    clearEvents: function() { events.length = 0; },
    setComponentStatus: function(fn) { componentStatus = fn; },
    setHttpResponder: function(fn) { httpResponder = fn; },
    // Push a new config into the script's in-memory deviceConfig by
    // invoking the MQTT CONFIG_TOPIC subscription callback the script
    // registered at boot — this is the same path the real MQTT bridge uses.
    // Each call auto-increments the version so applyConfig's no-op guard
    // (newCfg.v === deviceConfig.v) doesn't skip the update.
    setConfig: function(cfg) {
      cfg = Object.assign({}, cfg, { v: (configVersion++) });
      const cb = globals.MQTT._subs['greenhouse/config'];
      if (cb) cb('greenhouse/config', JSON.stringify(cfg));
    },
    advance: function(ms, done) {
      // Advance the synthetic clock by jumping to the next-due timer
      // (or endAt). After each fired timer, drain async Shelly.call
      // callbacks via a short setImmediate chain (3 yields) so callback
      // chains complete before the next timer fires. Much faster than
      // 1 ms hops for long advances.
      const endAt = now + ms;
      function drainAndContinue(n) {
        if (n <= 0) return hop();
        setImmediate(function() { drainAndContinue(n - 1); });
      }
      function hop() {
        if (now >= endAt) { setImmediate(done); return; }
        let nextDue = endAt;
        for (let i = 0; i < timers.length; i++) {
          if (timers[i].dueAt < nextDue) nextDue = timers[i].dueAt;
        }
        if (nextDue > now) now = (nextDue <= endAt) ? nextDue : endAt;
        let fired;
        do {
          fired = null;
          for (let j = 0; j < timers.length; j++) {
            if (timers[j].dueAt <= now) {
              fired = timers[j];
              if (fired.repeat) fired.dueAt = now + fired.ms;
              else timers.splice(j, 1);
              break;
            }
          }
          if (fired) { try { fired.cb(); } catch(e) {} }
        } while (fired);
        drainAndContinue(20);
      }
      hop();
    },
    kvs,
    // Drive a control loop tick and wait for its async chain to settle.
    tick: function(done) {
      // Find the repeating controlLoop timer (30 s period).
      const controlLoop = timers.find(function(t) { return t.repeat && t.ms >= 10000; });
      if (controlLoop) controlLoop.cb();
      setImmediate(done);
    },
  };
}

function loadScript(runtime, files) {
  const src = files.map(function(f) {
    return fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8');
  }).join('\n');
  const g = runtime.globals;
  // __TEST_HARNESS enables the `Shelly.__test_driveTransition` hook in
  // control.js. On the real device this identifier is undefined and the
  // hook block is skipped entirely.
  const fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    '__TEST_HARNESS',
    src
  );
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

// Standard KVS seed used by all tests. All actuators enabled, override NOT
// active (tests activate it themselves via setConfig).
const BASE_CONFIG = {
  ce: true, ea: 31, we: {}, wz: {}, wb: {}, v: 1
};

// Boot the script and advance 10 s to clear all boot timers.
function bootScript(rt, done) {
  rt.kvs.config = JSON.stringify(BASE_CONFIG);
  rt.kvs.drained = '0';
  rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
  loadScript(rt, ['control-logic.js', 'control.js']);
  rt.advance(10000, done);
}

// ── Tests ──

describe('override-forced-mode :: mo.fm drives transitionTo', function() {

  it('drives transition to SOLAR_CHARGING when mo.fm = SC', function(t, done) {
    // When config_changed fires with mo.fm=SC, handleForcedModeChange calls
    // transitionTo(makeModeResult('SC')). The transition uses the default
    // pump-first path: pump-off → VALVE_SETTLE_MS(1s) → valve opens →
    // openWindowMs(20s) → resumeTransition → finalizeTransitionOK →
    // PUMP_PRIME_MS(5s) → pump-on. Total ≈ 26 s; advance 35 s to be safe.
    const rt = createOrderingRuntime();
    bootScript(rt, function() {
      rt.clearEvents();
      const sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      const overrideCfg = Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, fm: 'SC' }
      });
      rt.setConfig(overrideCfg);
      rt.advance(35000, function() {
        const evts = rt.events();
        const pumpOff = evts.findIndex(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        const firstValve = evts.findIndex(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        const pumpOn = evts.findIndex(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === true;
        });
        assert.ok(pumpOff >= 0, 'expected pump-off Switch.Set (pump_stop phase)');
        assert.ok(firstValve >= 0, 'expected valve HTTP commands for SOLAR_CHARGING');
        assert.ok(pumpOn >= 0, 'expected pump-on Switch.Set after SOLAR_CHARGING transition');
        // Non-drain path: pump off BEFORE valves, pump on AFTER valves
        assert.ok(pumpOff < firstValve,
          'pump-off (' + pumpOff + ') must precede first valve (' + firstValve + ') in SC transition');
        assert.ok(firstValve < pumpOn,
          'valve commands (' + firstValve + ') must precede pump-on (' + pumpOn + ') in SC transition');
        done();
      });
    });
  });

  it('bypasses min-duration when switching forced modes mid-override', function(t, done) {
    // First set mo.fm=SC (starts the SC transition), then immediately switch
    // to mo.fm=GH while the SC transition is in-flight. If min-duration were
    // enforced we would wait 5 min; instead transitionTo() accepts an in-place
    // target update and GH valve commands appear within the existing
    // openWindowMs(20s) window.
    const rt = createOrderingRuntime();
    bootScript(rt, function() {
      const sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      const cfgSC = Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, fm: 'SC' }
      });
      rt.setConfig(cfgSC);
      // Advance 2 s: SC pump-stop fires; settle timer not yet expired —
      // state.transitioning is true and targetValves is set.
      rt.advance(2000, function() {
        rt.clearEvents();
        const cfgGH = Object.assign({}, BASE_CONFIG, {
          mo: { a: true, ex: sysUnix + 3600, fm: 'GH' }
        });
        rt.setConfig(cfgGH);
        // Advance 30 s: GH valve commands must appear within the 20 s open
        // window + settle, well under the 5-min min-duration hold.
        rt.advance(30000, function() {
          const evts = rt.events();
          // GH valves: vi_top (192.168.30.51 id=1) and vo_rad (192.168.30.53 id=0)
          const ghValves = evts.filter(function(e) {
            return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0 &&
              ((e.detail.url.indexOf('192.168.30.51') >= 0 && e.detail.url.indexOf('id=1') >= 0) ||
               (e.detail.url.indexOf('192.168.30.53') >= 0 && e.detail.url.indexOf('id=0') >= 0));
          });
          assert.ok(ghValves.length > 0,
            'GH valve commands (vi_top or vo_rad) must appear within 30 s — min-duration bypassed');
          done();
        });
      });
    });
  });

  it('exits override from SC via pump-first transition to IDLE', function(t, done) {
    // Setup: setConfig(mo={a:true,fm:'SC'}) so prevDeviceConfig.mo.a=true, then
    // __test_driveTransition to seed state.mode=SOLAR_CHARGING. Advance 90 s
    // so the SC transition completes AND minOpenMs=60 s hold expires (valves
    // openSince ≈ t+31s; readyAt = t+91s < t+100s). Then clear mo → pump-first
    // IDLE transition: pump-off → 1 s settle → valve closes → 5 s prime.
    const rt = createOrderingRuntime();
    bootScript(rt, function() {
      const sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      // Establish override in in-memory config so prevMo.a=true on next update
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, fm: 'SC' }
      }));
      // Drive state.mode = SOLAR_CHARGING and kick off the SC transition
      rt.globals.Shelly.__test_driveTransition('SOLAR_CHARGING', {
        nextMode: 'SOLAR_CHARGING',
        valves: { vi_btm: true, vi_top: false, vi_coll: false,
                  vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
        flags: {},
      });
      // 90 s: SC transition completes (35 s) + minOpenMs hold expires (60 s)
      rt.advance(90000, function() {
        rt.clearEvents();
        // Clear override (prevMo.a=true, nextMo=null) →
        // handleForcedModeChange → transitionTo(buildIdleTransitionResult())
        // state.transitionFromMode = SOLAR_CHARGING → pump-first path
        rt.setConfig(Object.assign({}, BASE_CONFIG, { mo: null }));
        // 20 s covers: pump-stop + 1 s settle + valve closes + 5 s prime
        rt.advance(20000, function() {
          const evts = rt.events();
          const pumpOff = evts.findIndex(function(e) {
            return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
          });
          const firstValve = evts.findIndex(function(e) {
            return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
          });
          assert.ok(pumpOff >= 0, 'expected pump-off on override exit from SC');
          assert.ok(firstValve >= 0, 'expected valve close commands on override exit from SC');
          assert.ok(pumpOff < firstValve,
            'SC→IDLE must use pump-first: pump-off (' + pumpOff +
            ') before first valve (' + firstValve + ')');
          done();
        });
      });
    });
  });

  it('exits override from AD via valves-first + DRAIN_EXIT_PUMP_RUN_MS path', function(t, done) {
    // Regression guard: the drain-exit branch (valves close first, pump stops
    // DRAIN_EXIT_PUMP_RUN_MS=20 s later) must survive override-exit when
    // state.mode === ACTIVE_DRAIN.
    //
    // Setup: same as test 3 but for ACTIVE_DRAIN. After 90 s (AD transition
    // complete, minOpenMs expired), clear mo. v_air needs a 20 s open-window
    // to physically close, so total drain-exit time is ≥ 40 s. Advance 50 s.
    const rt = createOrderingRuntime();
    bootScript(rt, function() {
      const sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, fm: 'AD' }
      }));
      rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
        nextMode: 'ACTIVE_DRAIN',
        valves: { vi_btm: false, vi_top: false, vi_coll: true,
                  vo_coll: false, vo_rad: false, vo_tank: true, v_air: true },
        actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
        flags: {},
      });
      rt.advance(90000, function() {
        rt.clearEvents();
        // Clear override → transitionTo(buildIdleTransitionResult()).
        // state.transitionFromMode = ACTIVE_DRAIN → drain-exit branch.
        rt.setConfig(Object.assign({}, BASE_CONFIG, { mo: null }));
        // 50 s: valve closes (immediate) + v_air 20 s open-window +
        //       DRAIN_EXIT_PUMP_RUN_MS (20 s) + margin
        rt.advance(50000, function() {
          const evts = rt.events();
          const firstValve = evts.findIndex(function(e) {
            return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
          });
          const pumpOff = evts.findIndex(function(e) {
            return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
          });
          assert.ok(firstValve >= 0, 'expected valve commands on override exit from AD');
          assert.ok(pumpOff >= 0, 'expected pump-off on override exit from AD');
          assert.ok(firstValve < pumpOff,
            'AD exit must close valves (' + firstValve +
            ') BEFORE stopping pump (' + pumpOff + ')');
          // Verify the 20 s post-valve wait
          const valveCloses = evts.filter(function(e) {
            return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
          });
          const lastValveAt = valveCloses[valveCloses.length - 1].t;
          const pumpOffEvt = evts.find(function(e) {
            return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
          });
          const gap = pumpOffEvt.t - lastValveAt;
          assert.ok(gap >= 20000,
            'pump-off must be ≥ 20 000 ms after last valve command on AD exit (got ' + gap + ' ms)');
          done();
        });
      });
    });
  });

  it('TTL expiry tags the published state with cause=forced reason=override_expired', function(t, done) {
    // Regression for the audit finding adjacent to the wb.EH bug fix:
    // isManualOverrideActive() previously called transitionTo(buildIdleTransitionResult())
    // with no cause/reason args. The IDLE row in the System Logs then
    // inherited the prior transition's lastTransitionCause (whatever
    // ran before the override — typically "automation") and a null
    // reason, falsely suggesting the device autonomously decided to
    // idle. The fix passes an explicit cause "forced" + reason
    // "override_expired" so operators can tell the row apart from
    // user-cleared override (cause "forced", reason "override_cleared")
    // and from any unrelated automation tick.
    const rt = createOrderingRuntime();
    bootScript(rt, function() {
      // Capture greenhouse/state publishes after boot.
      const stateMsgs = [];
      rt.globals.MQTT.publish = function(topic, payload) {
        if (topic === 'greenhouse/state') {
          try { stateMsgs.push(JSON.parse(payload)); } catch (e) {}
        }
      };
      const sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      const shortTtl = sysUnix + 5;
      // Override forcing IDLE with a 5-s TTL.
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: shortTtl, fm: 'I' }
      }));
      // Walk past the expiry, then drive the control loop so
      // isManualOverrideActive() detects now >= mo.ex.
      rt.advance(6000, function() {
        stateMsgs.length = 0;
        rt.tick(function() {
          // Let the staged IDLE transition run to completion.
          rt.advance(35000, function() {
            // Walk the publishes for the dedicated TTL-expiry tag.
            // Several idle broadcasts can come through during the
            // controlLoop tick + staged transition; the override-
            // expired transition is the one we care about.
            const expiredMsg = stateMsgs.find(function(m) {
              return m.mode === 'idle' && m.reason === 'override_expired';
            });
            assert.ok(expiredMsg,
              'expected a mode=idle publish with reason=override_expired; got: ' +
              JSON.stringify(stateMsgs.map(function(m) {
                return { mode: m.mode, cause: m.cause, reason: m.reason };
              })));
            assert.strictEqual(expiredMsg.cause, 'forced',
              'TTL expiry must tag cause=forced (matches user-clear path)');
            done();
          });
        });
      });
    });
  });

  it('triggers IDLE transition on TTL expiry without a user command', function(t, done) {
    // TTL-expiry path: isManualOverrideActive() detects now >= mo.ex, clears
    // mo, and (our new code) calls transitionTo(buildIdleTransitionResult()).
    // isManualOverrideActive() is called from the controlLoop. The repeating
    // controlLoop timer runs every 30 s; we trigger it via rt.tick().
    //
    // This test does NOT set mo.fm to avoid a concurrent SC transition that
    // would leave state.transitioning=true when the TTL check runs. The TTL
    // behaviour is independent of fm being set.
    //
    // Timeline (all simulated):
    //   t= 0 ms: boot start
    //   t=10 000 ms: boot done; sys.unixtime = 10 s
    //   Set override (no fm) expiring at unixtime = 10 + 5 = 15 s
    //   Advance 1 ms: setConfig fires → mo set in script; no SC transition
    //   Advance to t=16 001 ms (6 001 ms total): sys.unixtime = 16 s > 15 s
    //   rt.tick(): controlLoop → isManualOverrideActive() detects expiry →
    //              clears mo → state.transitioning=false → transitionTo(IDLE)
    //   Advance 35 s more: IDLE transition runs
    const rt = createOrderingRuntime();
    bootScript(rt, function() {
      const sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      // Override with no fm (plain relay-testing session, no mode forced)
      const shortTtl = sysUnix + 5;
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: shortTtl, fm: 'I' }
      }));
      // Advance 6 s: sys.unixtime advances to 10+6=16 s > shortTtl=15 s
      rt.advance(6000, function() {
        rt.clearEvents();
        // Trigger the control loop: isManualOverrideActive() fires, detects
        // expiry (now=16s ≥ ex=15s), calls transitionTo(buildIdleTransitionResult())
        rt.tick(function() {
          // Advance 35 s for the IDLE transition to run (pump-stop + 1 s settle
          // + valve work (all already closed from boot → targetReached immediately)
          // + PUMP_PRIME_MS=5 s)
          rt.advance(35000, function() {
            const evts = rt.events();
            // All IDLE valves are already closed from boot, so the scheduler
            // immediately reaches targetReached → finalizeTransitionOK →
            // PUMP_PRIME_MS timer → setActuators(pump:false) → Switch.Set id=0 on=false
            const pumpOff = evts.find(function(e) {
              return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
            });
            assert.ok(pumpOff,
              'TTL expiry must trigger IDLE transition (pump-off Switch.Set); ' +
              'got ' + evts.length + ' events: ' +
              evts.map(function(e) { return e.kind + '(' + JSON.stringify(e.detail) + ')'; }).join(', '));
            done();
          });
        });
      });
    });
  });

  // Regression: 2026-04-20 the live Pro 4PM crashed with
  //   "Uncaught Error: Too much recursion - the stack is about to overflow"
  // at scheduleStep → runValveBatch → runBoundedPool → drain → (sync cb) →
  // drain → … when the user enabled override forced-mode ACTIVE_DRAIN.
  //
  // Reproduction: forced mode AD enters from IDLE with EA_VALVES bit cleared
  // in `ea`. setValve() then returns synchronously from its "controls not
  // enabled for valves" guard for every valve, which feeds the bounded pool
  // items list as an unbroken chain of synchronous completions. The old
  // runBoundedPool.drain() recursed once per item; Espruino's ~20-frame stack
  // fell over on the third or fourth valve.
  //
  // After the fix drain() iterates instead of recursing, so N synchronous
  // completions fit in a single stack frame of the bounded-pool call.
  it('forced ACTIVE_DRAIN with EA_VALVES cleared does not blow the stack', function(t, done) {
    const rt = createOrderingRuntime();
    // Seed config with ea=30 (everything enabled EXCEPT EA_VALVES=1). This is
    // the config shape that reproduced the 2026-04-20 crash: setValve's open
    // path hits the sync early-return for every valve, so the bounded pool
    // sees all dispatches complete synchronously.
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 30, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      const sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      const throwsSeen = [];
      // Wrap every fired Timer.cb so a synchronous stack-overflow throw
      // surfaces to the test instead of being swallowed by the runtime's
      // `try { fired.cb(); } catch(e) {}` in advance().
      const origSet = rt.globals.Timer.set;
      rt.globals.Timer.set = function(ms, repeat, cb) {
        return origSet(ms, repeat, function() {
          try { cb(); } catch (e) { throwsSeen.push(String(e && e.message || e)); throw e; }
        });
      };
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        ea: 30,
        mo: { a: true, ex: sysUnix + 3600, fm: 'AD' }
      }));
      // Advance through the full AD entry chain. With the recursion fixed
      // this completes cleanly; with the old drain() it throws before any
      // of the stages finish.
      rt.advance(35000, function() {
        const overflow = throwsSeen.filter(function(m) {
          return /recursion|stack/i.test(m);
        });
        assert.strictEqual(overflow.length, 0,
          'scheduleStep must not throw a stack-overflow error for forced AD; saw: ' +
          throwsSeen.join(' | '));
        done();
      });
    });
  });

  // Regression: 2026-04-26 the live Pro 4PM crashed with the same
  //   "Too much recursion - the stack is about to overflow"
  // error as the 2026-04-20 incidents — but the device had ea=31 (all
  // permission bits set) so the previous setValve sync early-return /
  // skip-empty-batches fixes did not apply. Trace:
  //
  //   at Shelly.call("HTTP.GET", {url: url}, function(res, err) {
  //   in function "setValve" called from setValve(pair[0], pair[1], inner);
  //   in function "dispatch"  called from dispatch(it, onItem);
  //   in function "drain"     called from drain();
  //   in function "runBoundedPool" called from }, cb);
  //   in function "runValveBatch"  called fr…   ← truncated (runOpens)
  //
  // Root cause: scheduleStep chains `runValveBatch(closes) →
  // runValveBatch(opens)` through a synchronous callback. When the last
  // close's HTTP.GET cb fires via Shelly's event loop, the chain
  //   Shelly.call cb → setValve cb → onItem → done(okC) → cb1 →
  //   runOpens → runValveBatch → runBoundedPool → drain → dispatch →
  //   setValve → Shelly.call
  // accumulates ~13-14 frames before re-entering Shelly.call, blowing
  // Espruino's tight stack budget on the Pro 4PM. The fix defers
  // runOpens via Timer.set(MIN_RESUME_MS, ...) so the open batch starts
  // on a fresh stack, the same trick scheduleResume() already uses.
  //
  // We pin the property by simulating Espruino's tighter event loop —
  // Shelly.call HTTP.GET cbs fire SYNCHRONOUSLY rather than via
  // setImmediate, so the close→runOpens chain accumulates real stack
  // frames in Node. Stack depth at the open dispatch then exceeds the
  // close dispatch by ~5-7 frames; the defer fix makes them match.
  it('runOpens deferred — open batch starts on a fresh stack, not nested under close cb chain', function(t, done) {
    // Custom runtime: same as createOrderingRuntime but with synchronous
    // HTTP.GET callbacks. This is the Espruino model — when the device
    // fires Shelly.call's cb, it does so on a thin event-loop frame, not
    // a node-style setImmediate yield. Synchronously chaining the
    // close-batch done callback into runOpens then accumulates real
    // stack depth that Node can measure.
    const rt = createOrderingRuntime();
    const origShellyCall = rt.globals.Shelly.call;
    rt.globals.Shelly.call = function(method, params, cb) {
      // Replay the original Shelly.call's record/dispatch logic for
      // every method except HTTP.GET; for HTTP.GET, fire cb on the
      // current stack so close→open chaining is visible.
      params = params || {};
      if (method === 'HTTP.GET') {
        // Mirror the runtime's record() side-effect for the events()
        // log so order assertions in other tests still work.
        rt.events().push({ kind: 'http_get', detail: { url: params.url || '' } });
        if (cb) cb({ code: 200, body: '' }, null);
        return;
      }
      return origShellyCall.call(this, method, params, cb);
    };

    bootScript(rt, function() {
      const sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      // Drive into GREENHOUSE_HEATING (vi_top + vo_rad open) so the
      // subsequent forced AD requires both closes (vi_top, vo_rad) and
      // opens (vi_coll, vo_tank).
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, fm: 'GH' }
      }));
      rt.advance(40000, function() {
        // Wait minOpenMs (60 s) so close-now is allowed for vi_top/vo_rad.
        rt.advance(70000, function() {
          // Now wrap Shelly.call AGAIN to capture stack depth at every
          // valve HTTP.GET. The wrapper runs inside the synchronous
          // chain that setValve sets up, so depths reflect the real
          // script stack.
          const valveCallDepths = [];
          const innerCall = rt.globals.Shelly.call;
          // Lift Node's default 10-frame Error.stack cap so we can see
          // the full call chain at each Shelly.call entry.
          const prevLimit = Error.stackTraceLimit;
          Error.stackTraceLimit = Infinity;
          rt.globals.Shelly.call = function(method, params, cb) {
            if (method === 'HTTP.GET' && params && params.url &&
                params.url.indexOf('/rpc/Switch.Set') >= 0) {
              valveCallDepths.push({
                depth: new Error().stack.split('\n').length,
                on: params.url.indexOf('on=true') >= 0,
                url: params.url,
              });
            }
            return innerCall.call(this, method, params, cb);
          };

          rt.clearEvents();
          // Force-mode flip GH → AD: needs to close vi_top, vo_rad and
          // open vi_coll, vo_tank (v_air queues for next slot).
          rt.setConfig(Object.assign({}, BASE_CONFIG, {
            mo: { a: true, ex: sysUnix + 3600, fm: 'AD' }
          }));
          rt.advance(60000, function() {
            const closes = valveCallDepths.filter(function(c) { return !c.on; });
            const opens = valveCallDepths.filter(function(c) { return c.on; });
            assert.ok(closes.length >= 2,
              'expected ≥2 close HTTP.GETs (vi_top, vo_rad); saw ' + closes.length +
              ' (urls=' + valveCallDepths.map(function(c) { return c.url; }).join(', ') + ')');
            assert.ok(opens.length >= 1,
              'expected ≥1 open HTTP.GET; saw ' + opens.length);
            // Stack-depth invariant: with HTTP.GET cb firing on the
            // current stack (the Espruino model), opens must still
            // dispatch from approximately the same depth as closes
            // because runOpens is deferred via Timer.set. Without the
            // defer, open dispatches are ~5-7 frames deeper.
            const maxClose = Math.max.apply(null, closes.map(function(c) { return c.depth; }));
            const maxOpen = Math.max.apply(null, opens.map(function(c) { return c.depth; }));
            Error.stackTraceLimit = prevLimit;
            assert.ok(
              maxOpen <= maxClose + 3,
              'open dispatch must not nest deeper than close dispatch ' +
              '(close maxDepth=' + maxClose + ', open maxDepth=' + maxOpen + '). ' +
              'runOpens must defer via Timer.set so the open batch starts on a fresh stack.'
            );
            done();
          });
        });
      });
    });
  });

});
