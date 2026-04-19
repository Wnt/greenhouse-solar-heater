/**
 * Shelly transition-ordering tests.
 *
 * Exercises shelly/control.js transitionTo() for the two orderings the
 * system uses:
 *   - Default: stop pump/fan/heaters → 1 s settle → actuate valves.
 *   - ACTIVE_DRAIN exit: actuate valves (pump still running) → 20 s →
 *     stop pump/fan/heaters.
 *
 * The runtime mock records every Shelly.call and HTTP valve command with
 * a synthetic-clock timestamp so tests can assert both ordering and
 * elapsed delay between events.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

function createOrderingRuntime(opts) {
  opts = opts || {};
  var now = opts.startTime || 1700000000000; // arbitrary epoch ms
  var events = []; // { t, kind, detail }
  var timers = []; // { id, dueAt, cb, repeat, ms }
  var timerIdCounter = 0;
  var kvs = {};
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
      subscribe: function() {},
      publish: function() {},
      isConnected: function() { return false; },
      setConnectHandler: function() {},
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
    setComponentStatus: function(fn) { componentStatus = fn; },
    setHttpResponder: function(fn) { httpResponder = fn; },
    advance: function(ms, done) {
      // Advance the synthetic clock in 1 ms hops and fire any timer whose
      // dueAt has passed. Uses setImmediate between hops so async Shelly.call
      // callbacks (which run via setImmediate in the mock) have a chance to
      // resolve before the next hop. done() is invoked on the next tick after
      // the advance completes.
      var endAt = now + ms;
      function hop() {
        if (now >= endAt) {
          setImmediate(done);
          return;
        }
        now += 1;
        var fired;
        do {
          fired = null;
          for (var i = 0; i < timers.length; i++) {
            if (timers[i].dueAt <= now) {
              fired = timers[i];
              if (fired.repeat) {
                fired.dueAt = now + fired.ms;
              } else {
                timers.splice(i, 1);
              }
              break;
            }
          }
          if (fired) {
            try { fired.cb(); } catch(e) {}
          }
        } while (fired);
        setImmediate(hop);
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
  var fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    src
  );
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print);
}

describe('shelly/control.js :: transitionTo() ordering', function() {
  // Helper: boot the script into a known mode by pre-seeding KVS before load,
  // then waiting for boot's delayed (VALVE_SETTLE_MS+5000ms) startup chain to
  // resolve. Config has all-modes-allowed and actuators enabled.
  function bootScriptInMode(runtime, mode, collectorsDrained, done) {
    runtime.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    runtime.kvs.drained = collectorsDrained ? '1' : '0';
    runtime.kvs.sensor_config = JSON.stringify({
      s: {}, h: {}, version: 1
    });
    loadScript(runtime, ['control-logic.js', 'control.js']);
    // Boot fires closeAllValves then a 5 s delay before the control loop
    // starts. Advance 10 s to clear all boot timers.
    runtime.advance(10000, function() {
      // Force the mode via Shelly.emitEvent of a synthetic ... not possible
      // without script cooperation. Instead, we drive the script's mode via
      // the config_changed path: push a safety_critical config that triggers
      // an immediate control loop run, with a controlled sensor-set pushed
      // into the script's telemetry via direct KVS replay.
      //
      // For these tests we do not need the script to actually BE in `mode` —
      // we stub state via the exported __test_setMode hook installed by
      // Task 3 / Task 4 changes. Until those exist, the tests use the
      // script's natural entry path. See task-specific notes.
      done();
    });
  }

  it('non-drain exit: stops pump before issuing any valve HTTP command', function(t, done) {
    // Natural-entry approach: drive the script into GREENHOUSE_HEATING via
    // sensor values, wait for mode to settle, then push sensor values that
    // exit the mode, and capture the ordering.
    //
    // This is covered end-to-end by the simulation harness; for this unit
    // test we use the __test_driveTransition hook added in Task 3 which
    // calls transitionTo() directly with a specified source mode.
    var rt = createOrderingRuntime();
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      // __test_driveTransition(fromMode, idleResult) is the testing hook
      // added in Task 3. It sets state.mode, clears state.transitioning,
      // and calls transitionTo(idleResult).
      rt.globals.Shelly.__test_driveTransition('SOLAR_CHARGING', {
        nextMode: 'IDLE',
        valves: { vi_btm: false, vi_top: false, vi_coll: false,
                  vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: false, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 solarChargePeakTankTop: null, solarChargePeakTankTopAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      // Advance through the full transition (pump_stop + settle + scheduleStep
      // + PUMP_PRIME). ≤ 10 s covers everything for non-drain transitions.
      rt.advance(10000, function() {
        var events = rt.events();
        var pumpOff = events.findIndex(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        var firstValve = events.findIndex(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        assert.ok(pumpOff >= 0, 'expected a pump-off Switch.Set event');
        assert.ok(firstValve >= 0, 'expected at least one valve HTTP.GET event');
        assert.ok(pumpOff < firstValve,
          'non-drain exit must stop pump (index ' + pumpOff + ') before any valve command (index ' + firstValve + ')');
        done();
      });
    });
  });
});
