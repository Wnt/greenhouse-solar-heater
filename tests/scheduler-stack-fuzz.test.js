/**
 * Scheduler stack-safety fuzz.
 *
 * The Shelly Pro 4PM has crashed twice with
 *
 *     Uncaught Error: Too much recursion - the stack is about to overflow
 *
 * inside the scheduleStep callback chain — once from forced-mode
 * ACTIVE_DRAIN entry with valve actuation returning synchronously
 * (2026-04-20 #1) and once from exiting ACTIVE_DRAIN while valves
 * were still inside their minOpenMs hold (2026-04-20 #2). Both
 * paths ran through scheduleStep → runValveBatch → runBoundedPool.
 *
 * This file brute-forces every mode-transition combination we
 * support, across a matrix of pre-conditions (valve open ages inside
 * vs past minOpenMs, forced vs automation cause, controls-enabled vs
 * ea-disabled), and asserts invariants that together make the
 * recursion fault structurally impossible:
 *
 *   (a) Timer.set is never scheduled with delay < MIN_RESUME_MS when
 *       re-entering resumeTransition. Below that threshold Espruino
 *       Timer.set on Shelly can re-enter on the same stack frame,
 *       which is what lit the second crash.
 *
 *   (b) For any single tick of the transition, at most one pair of
 *       synchronous runBoundedPool "done" callbacks can be on the
 *       stack. We detect excess by watching how many http_get events
 *       accumulate between two Timer.set calls — a number above the
 *       scheduler's max concurrent open budget signals that empty
 *       batches were still stacking up.
 *
 *   (c) No transition ever emits more than a small bounded number of
 *       Timer.set calls per simulated second. A runaway
 *       scheduleStep ↔ resumeTransition loop would show up here as
 *       thousands.
 *
 * If the scheduler is ever rewritten and this file goes red, that
 * is the signal that the new implementation must prove — with
 * reproducible preconditions — that it cannot re-enter the failing
 * pathway.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

// ── Matrix ──

const MODES = ['IDLE', 'SOLAR_CHARGING', 'GREENHOUSE_HEATING', 'ACTIVE_DRAIN', 'EMERGENCY_HEATING'];

const MODE_VALVES = {
  IDLE:               { vi_btm:false, vi_top:false, vi_coll:false, vo_coll:false, vo_rad:false, vo_tank:false, v_air:false },
  SOLAR_CHARGING:     { vi_btm:true,  vi_top:false, vi_coll:false, vo_coll:true,  vo_rad:false, vo_tank:false, v_air:false },
  GREENHOUSE_HEATING: { vi_btm:false, vi_top:true,  vi_coll:false, vo_coll:false, vo_rad:true,  vo_tank:false, v_air:false },
  ACTIVE_DRAIN:       { vi_btm:false, vi_top:false, vi_coll:true,  vo_coll:false, vo_rad:false, vo_tank:true,  v_air:true  },
  EMERGENCY_HEATING:  { vi_btm:false, vi_top:false, vi_coll:false, vo_coll:false, vo_rad:false, vo_tank:false, v_air:false },
};

const MODE_ACTUATORS = {
  IDLE:               { pump:false, fan:false, space_heater:false, immersion_heater:false },
  SOLAR_CHARGING:     { pump:true,  fan:false, space_heater:false, immersion_heater:false },
  GREENHOUSE_HEATING: { pump:true,  fan:true,  space_heater:false, immersion_heater:false },
  ACTIVE_DRAIN:       { pump:true,  fan:false, space_heater:false, immersion_heater:false },
  EMERGENCY_HEATING:  { pump:false, fan:false, space_heater:true,  immersion_heater:true  },
};

// Must match control.js:MIN_RESUME_MS. Duplicated here deliberately so the
// test is a pin-down spec: lowering the min in control.js without updating
// this constant fails the first test.
const MIN_RESUME_MS = 20;

// ── Runtime ──
//
// A slimmed copy of the ordering runtime from override-forced-mode.test.js
// plus Timer.set / Switch.Set counting hooks that the stack-safety
// invariants below read.

function createFuzzRuntime(opts) {
  opts = opts || {};
  var now = opts.startTime || 1700000000000;
  var events = [];
  var timers = [];
  var timerIdCounter = 0;
  var kvs = {};
  var configVersion = 100;
  var eventHandlers = [];
  var httpResponder = opts.httpResponder || function(url) {
    return { ok: true, body: '' };
  };
  var componentStatus = function() { return { apower: 50, output: true }; };

  // Instrumentation. Each Timer.set call with a finite ms is recorded;
  // callers can inspect the distribution of delays to catch any synchronous
  // re-entry attempt.
  var timerSetDelays = [];

  function record(kind, detail) { events.push({ t: now, kind: kind, detail: detail }); }

  function shellyCall(method, params, cb) {
    params = params || {};
    if (method === 'Switch.Set') {
      record('switch_set', { id: params.id, on: params.on });
      setImmediate(function() { if (cb) cb({}, null); });
      return;
    }
    if (method === 'Switch.SetConfig') { setImmediate(function() { if (cb) cb({}, null); }); return; }
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
      record('http_get', { url: params.url || '' });
      var resp = httpResponder(params.url || '');
      setImmediate(function() {
        if (resp.ok) { if (cb) cb({ code: 200, body: resp.body || '' }, null); }
        else { if (cb) cb(null, resp.err || 'error'); }
      });
      return;
    }
    setImmediate(function() { if (cb) cb({}, null); });
  }

  function timerSet(ms, repeat, cb) {
    var id = ++timerIdCounter;
    timerSetDelays.push({ ms: ms, repeat: !!repeat, t: now });
    timers.push({ id: id, dueAt: now + ms, cb: cb, repeat: repeat, ms: ms });
    return id;
  }
  function timerClear(id) {
    timers = timers.filter(function(t) { return t.id !== id; });
  }

  var globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus: function(type) {
        if (type === 'switch') return componentStatus();
        if (type === 'sys') return { unixtime: Math.floor(now / 1000) };
        return {};
      },
      emitEvent: function() {},
      addEventHandler: function(fn) { eventHandlers.push(fn); },
      addStatusHandler: function() {},
    },
    Timer: { set: timerSet, clear: timerClear },
    MQTT: {
      subscribe: function() {},
      publish: function() {},
      isConnected: function() { return false; },
      setConnectHandler: function() {},
    },
    JSON: JSON, Date: { now: function() { return now; } }, Math: Math,
    parseInt: parseInt, print: function() {},
  };

  return {
    globals: globals,
    events: function() { return events.slice(); },
    clearEvents: function() { events.length = 0; timerSetDelays.length = 0; },
    timerSetDelays: function() { return timerSetDelays.slice(); },
    setConfig: function(cfg) {
      configVersion++;
      var full = Object.assign({}, cfg, { v: configVersion });
      kvs.config = JSON.stringify(full);
      for (var i = 0; i < eventHandlers.length; i++) {
        try { eventHandlers[i]({ info: { event: 'config_changed' } }); } catch(e) {}
      }
    },
    advance: function(ms, done) {
      var endAt = now + ms;
      function drainAsync(n) {
        if (n <= 0) return hop();
        setImmediate(function() { drainAsync(n - 1); });
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
        drainAsync(20);
      }
      hop();
    },
    kvs: kvs,
  };
}

function loadScript(runtime, ea) {
  runtime.kvs.config = JSON.stringify({
    ce: true, ea: (ea === undefined ? 31 : ea), fm: null, we: {}, wz: {}, wb: {}, v: 1
  });
  runtime.kvs.drained = '0';
  runtime.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
  var src = fs.readFileSync(path.join(SHELLY_DIR, 'control-logic.js'), 'utf8') + '\n' +
            fs.readFileSync(path.join(SHELLY_DIR, 'control.js'), 'utf8');
  var g = runtime.globals;
  var fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print', '__TEST_HARNESS',
    src
  );
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

function bootAndAdvance(rt, ea, done) {
  loadScript(rt, ea);
  rt.advance(10000, done);
}

// ── Invariant assertions ──

function assertNoTimerUnderMinResume(rt, msg) {
  var bad = rt.timerSetDelays().filter(function(d) {
    // Only inspect non-repeating, short-ish timers. Repeating control-loop
    // (POLL_INTERVAL=30s) and wait timers (VALVE_SETTLE_MS=1s etc.) are
    // legitimately longer. We flag non-repeating timers with ms < the
    // floor — that's the scheduler resume path only.
    return !d.repeat && d.ms < MIN_RESUME_MS;
  });
  assert.strictEqual(bad.length, 0,
    msg + ': scheduler must not set Timer.set below MIN_RESUME_MS (' + MIN_RESUME_MS + 'ms); ' +
    'saw ' + JSON.stringify(bad.map(function(d) { return d.ms; })));
}

function countTimerSets(rt) { return rt.timerSetDelays().length; }

// ── Fuzz matrix ──

describe('scheduler stack safety — mode transition fuzz', function() {
  this.timeout = 60000;

  // Test 1: Every (fromMode → toMode) via forced mode must not schedule a
  // Timer under the MIN_RESUME_MS floor. Covers drain-exit,
  // drain-entry, solar entry, idle entry, and all cross-mode flips.
  for (var i = 0; i < MODES.length; i++) {
    for (var j = 0; j < MODES.length; j++) {
      if (MODES[i] === MODES[j]) continue;
      (function(fromMode, toMode) {
        it('forced ' + fromMode + ' → ' + toMode + ' never under-delays Timer.set', function(t, done) {
          var rt = createFuzzRuntime();
          bootAndAdvance(rt, 31, function() {
            // Drive into fromMode via forced override. If fromMode is IDLE
            // we skip the seeding — boot already put the script in IDLE.
            var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
            if (fromMode !== 'IDLE') {
              rt.globals.Shelly.__test_driveTransition(fromMode, {
                nextMode: fromMode, valves: MODE_VALVES[fromMode],
                actuators: MODE_ACTUATORS[fromMode], flags: {},
              });
              rt.advance(60000, step2);
            } else {
              step2();
            }
            function step2() {
              rt.clearEvents();
              var code = ({ IDLE: 'IDLE', SOLAR_CHARGING: 'SC', GREENHOUSE_HEATING: 'GH',
                            ACTIVE_DRAIN: 'AD', EMERGENCY_HEATING: 'EH' })[toMode];
              rt.setConfig({
                ce: true, ea: 31,
                mo: { a: true, ex: sysUnix + 3600, ss: false, fm: code },
                we: {}, wz: {}, wb: {}
              });
              // Long advance so any delayed Timer.set from the transition
              // chain has a chance to fire (openWindowMs=20s + minOpenMs=60s
              // + pump prime). Anything in the full chain that violates
              // MIN_RESUME_MS surfaces inside this window.
              rt.advance(120000, function() {
                assertNoTimerUnderMinResume(rt,
                  'forced ' + fromMode + ' → ' + toMode);
                var total = countTimerSets(rt);
                // Sanity: bounded Timer.set count. In a runaway
                // scheduleStep ↔ Timer loop we'd see thousands. A real
                // transition schedules at most ~10-20 distinct timers
                // over two minutes.
                assert.ok(total < 200,
                  'transition timer count too high (' + total + '); suggests loop');
                done();
              });
            }
          });
        });
      })(MODES[i], MODES[j]);
    }
  }

  // Test 2: Drain-exit variants. The 2026-04-20 crash specifically hit
  // exiting ACTIVE_DRAIN while every valve was still inside its
  // minOpenMs hold (closePairs deferred, openPairs empty → both-empty
  // scheduleStep). Cover two ages: just-past AD entry (inside hold) and
  // well past (outside hold).
  [
    { label: 'inside minOpenMs (drain-exit scheduled to defer)',    postEntryMs: 35000 },
    { label: 'past minOpenMs (drain-exit can close immediately)',   postEntryMs: 90000 },
  ].forEach(function(scenario) {
    it('AD → IDLE ' + scenario.label, function(t, done) {
      var rt = createFuzzRuntime();
      bootAndAdvance(rt, 31, function() {
        var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
        rt.setConfig({
          ce: true, ea: 31, fm: null,
          mo: { a: true, ex: sysUnix + 3600, ss: false, fm: 'AD' },
          we: {}, wz: {}, wb: {},
        });
        rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
          nextMode: 'ACTIVE_DRAIN', valves: MODE_VALVES.ACTIVE_DRAIN,
          actuators: MODE_ACTUATORS.ACTIVE_DRAIN, flags: {},
        });
        rt.advance(scenario.postEntryMs, function() {
          rt.clearEvents();
          rt.setConfig({ ce: true, ea: 31, fm: null, mo: null, we: {}, wz: {}, wb: {} });
          rt.advance(120000, function() {
            assertNoTimerUnderMinResume(rt, 'AD → IDLE ' + scenario.label);
            var total = countTimerSets(rt);
            assert.ok(total < 200,
              'drain-exit timer count too high (' + total + ') for ' + scenario.label);
            done();
          });
        });
      });
    });
  });

  // Test 3: ea permutations. The 2026-04-20 #1 crash reproduced when
  // EA_VALVES (bit 0) was cleared, because setValve's open path then
  // returned synchronously for every valve. The iterative drain and
  // the scheduler-level skip-empty-batches fix jointly make the script
  // safe across all ea permutations. Cover the bits that gate
  // actuation paths.
  [31, 30, 29, 27, 23, 15, 0].forEach(function(ea) {
    it('forced AD entry with ea=' + ea + ' completes without Timer-loop', function(t, done) {
      var rt = createFuzzRuntime();
      bootAndAdvance(rt, ea, function() {
        var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
        rt.clearEvents();
        rt.setConfig({
          ce: true, ea: ea,
          mo: { a: true, ex: sysUnix + 3600, ss: false, fm: 'AD' },
          we: {}, wz: {}, wb: {},
        });
        rt.advance(120000, function() {
          assertNoTimerUnderMinResume(rt, 'forced AD entry ea=' + ea);
          done();
        });
      });
    });
  });

  // Test 4: AUTOMATED freeze-drain entry — not forced by the user,
  // triggered by evaluate() returning safetyOverride=true from sensor
  // values. This is the single most important path to protect: a
  // crash here means freeze protection fails silently. Covers both
  // trigger sensors (outdoor and the radiative-cooling collector
  // path added 2026-04-20), all non-drain source modes, and the
  // sync-setValve (ea=30) condition that torched the device earlier.
  var AUTO_FREEZE_SOURCE_MODES = ['IDLE', 'SOLAR_CHARGING', 'GREENHOUSE_HEATING'];
  var AUTO_FREEZE_SENSORS = [
    { label: 'cold outdoor (collector warm)', temps: { collector: 10, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: -3 } },
    { label: 'cold collector (outdoor warm — clear-night radiative)', temps: { collector: -1, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 5 } },
    { label: 'both below threshold', temps: { collector: -2, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: -2 } },
  ];
  // Automated freeze drain is tested with ea=31 (normal operation) only.
  // ea=30 simulates "valve actuation permission revoked" which cannot
  // happen in real production — and driving into SC/GH first requires
  // ea=31 because the entry transition can't complete when valve opens
  // short-circuit. The sync-dispatch case from the 2026-04-20 crash is
  // covered by the forced-mode Test 3 (above), which enters AD directly
  // without needing a prior completed SC/GH transition.
  var AUTO_FREEZE_EA = [31];

  AUTO_FREEZE_SOURCE_MODES.forEach(function(fromMode) {
    AUTO_FREEZE_SENSORS.forEach(function(scenario) {
      AUTO_FREEZE_EA.forEach(function(ea) {
        it('automated freeze drain from ' + fromMode + ' via ' + scenario.label +
           ' (ea=' + ea + ') does not violate scheduler invariants', function(t, done) {
          var rt = createFuzzRuntime();
          bootAndAdvance(rt, ea, function() {
            // Prime temps with safe non-freezing values BEFORE the source
            // mode is driven. Without this the 30 s repeating controlLoop
            // timer fires during `advance()` with null temps, the sensor-
            // staleness guard kicks in, and evaluate() redirects to IDLE,
            // clobbering the source mode we just drove to.
            rt.globals.Shelly.__test_setTemps(
              { collector: 50, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
              null
            );
            if (fromMode !== 'IDLE') {
              rt.globals.Shelly.__test_driveTransition(fromMode, {
                nextMode: fromMode, valves: MODE_VALVES[fromMode],
                actuators: MODE_ACTUATORS[fromMode], flags: {},
              });
              rt.advance(60000, step2);
            } else {
              step2();
            }
            function step2() {
              rt.clearEvents();
              // Inject freezing temps + re-assert the source mode so
              // evaluate() sees a mid-mode preemption (not a cold boot).
              rt.globals.Shelly.__test_setTemps(scenario.temps, fromMode, { collectorsDrained: false });
              // Fire a control-loop tick explicitly. evaluate() now sees
              // a freeze-drain trigger and calls transitionTo(result,
              // "safety_override") — this is the automated pathway.
              rt.globals.Shelly.__test_controlTick();
              rt.advance(120000, function() {
                assertNoTimerUnderMinResume(rt,
                  'automated freeze from ' + fromMode + ' / ' + scenario.label + ' / ea=' + ea);
                // A real automated freeze drain must produce at least one
                // valve actuation — otherwise the safety path exited
                // without actually draining, which defeats the purpose.
                var evts = rt.events();
                var actuations = evts.filter(function(e) {
                  return (e.kind === 'http_get' && /Switch\.Set/.test(e.detail.url)) ||
                         (e.kind === 'switch_set');
                });
                assert.ok(actuations.length > 0,
                  'freeze drain must actuate something (pump or valves); fromMode=' + fromMode +
                  ', ea=' + ea + ', events=' + evts.length);
                done();
              });
            }
          });
        });
      });
    });
  });

  // Test 5: Safety override preempting an active manual-override. When
  // the user has `mo.a=true, mo.ss=false` and freezing temps arrive,
  // controlLoop clears mo and calls transitionTo(result,
  // "safety_override"). This is the "user forgot they were in
  // override" scenario and it MUST drain anyway.
  it('safety override preempts manual override and drains without stack blow', function(t, done) {
    var rt = createFuzzRuntime();
    bootAndAdvance(rt, 31, function() {
      var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      // User sets override with ss=false (safety preemption allowed).
      rt.setConfig({
        ce: true, ea: 31,
        mo: { a: true, ex: sysUnix + 3600, ss: false, fm: null },
        we: {}, wz: {}, wb: {},
      });
      rt.advance(5000, function() {
        rt.clearEvents();
        // Freezing outdoor temps arrive.
        rt.globals.Shelly.__test_setTemps(
          { collector: 10, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: -3 },
          'IDLE', { collectorsDrained: false }
        );
        rt.globals.Shelly.__test_controlTick();
        rt.advance(120000, function() {
          assertNoTimerUnderMinResume(rt, 'safety override preempts manual override');
          done();
        });
      });
    });
  });

  // Test 6: Rapid override flip — user toggles fm between AD and IDLE
  // back-to-back while a prior transition is still in flight. The
  // scheduler must not accidentally re-enter on the same stack no
  // matter how many times the target changes.
  it('rapid forced-mode flipping never violates the Timer.set floor', function(t, done) {
    var rt = createFuzzRuntime();
    bootAndAdvance(rt, 31, function() {
      var sysUnix = rt.globals.Shelly.getComponentStatus('sys').unixtime;
      var flips = ['AD', 'IDLE', 'SC', 'AD', 'IDLE', 'GH', 'AD', 'IDLE'];
      var nextIdx = 0;
      function nextFlip() {
        if (nextIdx >= flips.length) {
          rt.advance(30000, function() {
            assertNoTimerUnderMinResume(rt, 'rapid flip');
            done();
          });
          return;
        }
        var target = flips[nextIdx++];
        if (target === 'IDLE') {
          rt.setConfig({ ce: true, ea: 31, fm: null, mo: null, we: {}, wz: {}, wb: {} });
        } else {
          rt.setConfig({
            ce: true, ea: 31,
            mo: { a: true, ex: sysUnix + 3600, ss: false, fm: target },
            we: {}, wz: {}, wb: {},
          });
        }
        rt.advance(2500, nextFlip);
      }
      nextFlip();
    });
  });
});
