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
  var now = opts.startTime || 1700000000000; // arbitrary epoch ms
  var events = []; // { t, kind, detail }
  var timers = []; // { id, dueAt, cb, repeat, ms }
  var timerIdCounter = 0;
  var kvs = {};
  var configVersion = 100; // bumped by setConfig() — must exceed the BASE_CONFIG v seeded into KVS
  var eventHandlers = [];
  var httpResponder = opts.httpResponder || function(url) {
    return { ok: true, body: '' };
  };
  var componentStatus = opts.componentStatus || function() {
    return { apower: 50, output: true };
  };

  function record(kind, detail) {
    events.push({ t: now, kind: kind, detail: detail });
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
      var val = kvs[params.key] || null;
      setImmediate(function() { if (cb) cb(val ? { value: val } : null, null); });
      return;
    }
    if (method === 'KVS.Set') {
      kvs[params.key] = params.value;
      setImmediate(function() { if (cb) cb({}, null); });
      return;
    }
    if (method === 'HTTP.GET') {
      var url = params.url || '';
      record('http_get', { url: url });
      var resp = httpResponder(url);
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
    var id = ++timerIdCounter;
    timers.push({ id: id, dueAt: now + ms, cb: cb, repeat: repeat, ms: ms });
    return id;
  }
  function timerClear(id) {
    timers = timers.filter(function(t) { return t.id !== id; });
  }

  function emitEvent(name, data) {
    for (var i = 0; i < eventHandlers.length; i++) {
      try { eventHandlers[i]({ info: { event: name, data: data } }); } catch(e) {}
    }
  }

  var globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus: function(type) {
        if (type === 'switch') return componentStatus();
        if (type === 'sys') return { unixtime: Math.floor(now / 1000) };
        return {};
      },
      emitEvent: emitEvent,
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
    JSON: JSON,
    Date: { now: function() { return now; } },
    Math: Math,
    parseInt: parseInt,
    print: function() {},
  };

  return {
    globals: globals,
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
      var cb = globals.MQTT._subs['greenhouse/config'];
      if (cb) cb('greenhouse/config', JSON.stringify(cfg));
    },
    advance: function(ms, done) {
      // Advance the synthetic clock by jumping to the next-due timer
      // (or endAt). After each fired timer, drain async Shelly.call
      // callbacks via a short setImmediate chain (3 yields) so callback
      // chains complete before the next timer fires. Much faster than
      // 1 ms hops for long advances.
      var endAt = now + ms;
      function drainAndContinue(n) {
        if (n <= 0) return hop();
        setImmediate(function() { drainAndContinue(n - 1); });
      }
      function hop() {
        if (now >= endAt) { setImmediate(done); return; }
        var nextDue = endAt;
        for (var i = 0; i < timers.length; i++) {
          if (timers[i].dueAt < nextDue) nextDue = timers[i].dueAt;
        }
        if (nextDue > now) now = (nextDue <= endAt) ? nextDue : endAt;
        var fired;
        do {
          fired = null;
          for (var j = 0; j < timers.length; j++) {
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
    kvs: kvs,
    // Drive a control loop tick and wait for its async chain to settle.
    tick: function(done) {
      // Find the repeating controlLoop timer (30 s period).
      var controlLoop = timers.find(function(t) { return t.repeat && t.ms >= 10000; });
      if (controlLoop) controlLoop.cb();
      setImmediate(done);
    },
  };
}

function loadScript(runtime, files) {
  var src = files.map(function(f) {
    return fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8');
  }).join('\n');
  var g = runtime.globals;
  // __TEST_HARNESS enables the `Shelly.__test_driveTransition` hook in
  // control.js. On the real device this identifier is undefined and the
  // hook block is skipped entirely.
  var fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    '__TEST_HARNESS',
    src
  );
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

// Standard KVS seed used by all tests. All actuators enabled, override NOT
// active (tests activate it themselves via setConfig).
var BASE_CONFIG = {
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
    var rt = createOrderingRuntime();
    bootScript(rt, function() {
      rt.clearEvents();
      var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      var overrideCfg = Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, ss: false, fm: 'SC' }
      });
      rt.setConfig(overrideCfg);
      rt.advance(35000, function() {
        var evts = rt.events();
        var pumpOff = evts.findIndex(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        var firstValve = evts.findIndex(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        var pumpOn = evts.findIndex(function(e) {
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
    var rt = createOrderingRuntime();
    bootScript(rt, function() {
      var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      var cfgSC = Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, ss: false, fm: 'SC' }
      });
      rt.setConfig(cfgSC);
      // Advance 2 s: SC pump-stop fires; settle timer not yet expired —
      // state.transitioning is true and targetValves is set.
      rt.advance(2000, function() {
        rt.clearEvents();
        var cfgGH = Object.assign({}, BASE_CONFIG, {
          mo: { a: true, ex: sysUnix + 3600, ss: false, fm: 'GH' }
        });
        rt.setConfig(cfgGH);
        // Advance 30 s: GH valve commands must appear within the 20 s open
        // window + settle, well under the 5-min min-duration hold.
        rt.advance(30000, function() {
          var evts = rt.events();
          // GH valves: vi_top (192.168.30.51 id=1) and vo_rad (192.168.30.53 id=0)
          var ghValves = evts.filter(function(e) {
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
    var rt = createOrderingRuntime();
    bootScript(rt, function() {
      var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      // Establish override in in-memory config so prevMo.a=true on next update
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, ss: false, fm: 'SC' }
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
          var evts = rt.events();
          var pumpOff = evts.findIndex(function(e) {
            return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
          });
          var firstValve = evts.findIndex(function(e) {
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
    var rt = createOrderingRuntime();
    bootScript(rt, function() {
      var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: sysUnix + 3600, ss: false, fm: 'AD' }
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
          var evts = rt.events();
          var firstValve = evts.findIndex(function(e) {
            return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
          });
          var pumpOff = evts.findIndex(function(e) {
            return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
          });
          assert.ok(firstValve >= 0, 'expected valve commands on override exit from AD');
          assert.ok(pumpOff >= 0, 'expected pump-off on override exit from AD');
          assert.ok(firstValve < pumpOff,
            'AD exit must close valves (' + firstValve +
            ') BEFORE stopping pump (' + pumpOff + ')');
          // Verify the 20 s post-valve wait
          var valveCloses = evts.filter(function(e) {
            return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
          });
          var lastValveAt = valveCloses[valveCloses.length - 1].t;
          var pumpOffEvt = evts.find(function(e) {
            return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
          });
          var gap = pumpOffEvt.t - lastValveAt;
          assert.ok(gap >= 20000,
            'pump-off must be ≥ 20 000 ms after last valve command on AD exit (got ' + gap + ' ms)');
          done();
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
    var rt = createOrderingRuntime();
    bootScript(rt, function() {
      var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      // Override with no fm (plain relay-testing session, no mode forced)
      var shortTtl = sysUnix + 5;
      rt.setConfig(Object.assign({}, BASE_CONFIG, {
        mo: { a: true, ex: shortTtl, ss: false }
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
            var evts = rt.events();
            // All IDLE valves are already closed from boot, so the scheduler
            // immediately reaches targetReached → finalizeTransitionOK →
            // PUMP_PRIME_MS timer → setActuators(pump:false) → Switch.Set id=0 on=false
            var pumpOff = evts.find(function(e) {
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

});
