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
  let now = opts.startTime || 1700000000000; // arbitrary epoch ms
  const events = []; // { t, kind, detail }
  let timers = []; // { id, dueAt, cb, repeat, ms }
  let timerIdCounter = 0;
  const kvs = {};
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
      subscribe: function() {},
      publish: function() {},
      isConnected: function() { return false; },
      setConnectHandler: function() {},
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
    advance: function(ms, done) {
      // Advance the synthetic clock in 1 ms hops and fire any timer whose
      // dueAt has passed. Uses setImmediate between hops so async Shelly.call
      // callbacks (which run via setImmediate in the mock) have a chance to
      // resolve before the next hop. done() is invoked on the next tick after
      // the advance completes.
      const endAt = now + ms;
      function hop() {
        if (now >= endAt) {
          setImmediate(done);
          return;
        }
        now += 1;
        let fired;
        do {
          fired = null;
          for (let i = 0; i < timers.length; i++) {
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

describe('shelly/control.js :: transitionTo() ordering', function() {
  it('non-drain exit: stops pump before issuing any valve HTTP command', function(t, done) {
    // Natural-entry approach: drive the script into GREENHOUSE_HEATING via
    // sensor values, wait for mode to settle, then push sensor values that
    // exit the mode, and capture the ordering.
    //
    // This is covered end-to-end by the simulation harness; for this unit
    // test we use the __test_driveTransition hook added in Task 3 which
    // calls transitionTo() directly with a specified source mode.
    const rt = createOrderingRuntime();
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
                 solarChargePeakTankAvg: null, solarChargePeakTankAvgAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      // Advance through the full transition (pump_stop + settle + scheduleStep
      // + PUMP_PRIME). ≤ 10 s covers everything for non-drain transitions.
      rt.advance(10000, function() {
        const events = rt.events();
        const pumpOff = events.findIndex(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        const firstValve = events.findIndex(function(e) {
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

  it('drain exit: closes valves BEFORE stopping pump', function(t, done) {
    const rt = createOrderingRuntime();
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      // Drop boot events (valve-close on boot, sensor polls) so the
      // transition under test starts from a clean event log.
      rt.clearEvents();
      rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
        nextMode: 'IDLE',
        valves: { vi_btm: false, vi_top: false, vi_coll: false,
                  vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: true, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 solarChargePeakTankAvg: null, solarChargePeakTankAvgAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      // Advance long enough for valves to close AND the 20 s drain-exit wait
      // AND the trailing setActuators. 30 s covers everything.
      rt.advance(30000, function() {
        const events = rt.events();
        const firstValve = events.findIndex(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        const pumpOff = events.findIndex(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        assert.ok(firstValve >= 0, 'expected at least one valve HTTP.GET');
        assert.ok(pumpOff >= 0, 'expected a pump-off Switch.Set');
        assert.ok(firstValve < pumpOff,
          'drain exit must actuate valves (index ' + firstValve + ') BEFORE stopping pump (index ' + pumpOff + ')');
        done();
      });
    });
  });

  it('drain exit: waits ≥ 20 s between last valve close and pump-off', function(t, done) {
    const rt = createOrderingRuntime();
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      // Drop boot events (valve-close on boot, sensor polls) so the
      // transition under test starts from a clean event log.
      rt.clearEvents();
      rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
        nextMode: 'IDLE',
        valves: { vi_btm: false, vi_top: false, vi_coll: false,
                  vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: true, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 solarChargePeakTankAvg: null, solarChargePeakTankAvgAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      rt.advance(30000, function() {
        const events = rt.events();
        const valveCloses = events.filter(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        const pumpOff = events.find(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        assert.ok(valveCloses.length > 0, 'expected at least one valve HTTP.GET');
        assert.ok(pumpOff, 'expected a pump-off Switch.Set');
        const lastValveAt = valveCloses[valveCloses.length - 1].t;
        const gap = pumpOff.t - lastValveAt;
        assert.ok(gap >= 20000,
          'pump-off must be ≥ 20 000 ms after last valve close (got ' + gap + ' ms)');
        done();
      });
    });
  });

  it('drain exit: valve HTTP failure → pump stops immediately, no 20 s wait', function(t, done) {
    const rt = createOrderingRuntime({
      httpResponder: function(_url) {
        // Fail every HTTP.GET (valve command) on both primary AND retry.
        return { ok: false, err: 'http fail' };
      }
    });
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      // Drop boot events (valve-close on boot, sensor polls) so the
      // transition under test starts from a clean event log.
      rt.clearEvents();
      rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
        nextMode: 'IDLE',
        valves: { vi_btm: false, vi_top: false, vi_coll: false,
                  vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: true, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 solarChargePeakTankAvg: null, solarChargePeakTankAvgAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      // Advance 5 s — well under 20 s. If the failure path waits 20 s, the
      // pump-off event won't be recorded yet and the assertion fails.
      rt.advance(5000, function() {
        const events = rt.events();
        const firstValve = events.find(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        const pumpOff = events.find(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        assert.ok(firstValve, 'expected a valve HTTP.GET attempt');
        assert.ok(pumpOff, 'expected a pump-off Switch.Set within 5 s');
        const gap = pumpOff.t - firstValve.t;
        assert.ok(gap < 5000,
          'on valve HTTP failure, pump-off must be within 5 s (got ' + gap + ' ms)');
        done();
      });
    });
  });

  // Issue #135: the fan is electrically + logically independent of the pump
  // (commit 15f598f), so a pump-mode swap must NOT toggle the fan off→on
  // when the post-transition state still calls for fan_on. Cycling the fan
  // every mode change shortens its life and produces noticeable
  // temperature/airflow blips during the warmest part of the day.
  it('non-drain transition: fan stays ON across transition when next state still wants fan_on', function(t, done) {
    const rt = createOrderingRuntime();
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      rt.clearEvents();
      // Source: GREENHOUSE_HEATING (fan ON via mode actuators).
      // Target: SOLAR_CHARGING with fan-cool overlay active — actuators.fan
      // is true because greenhouse is hot. Without the fix, transitionTo's
      // pump_stop step indiscriminately fired Switch.Set(id:1, on:false),
      // producing an off→on flicker once finalize re-asserted fan=true.
      rt.globals.Shelly.__test_driveTransition('GREENHOUSE_HEATING', {
        nextMode: 'SOLAR_CHARGING',
        valves: { vi_btm: true, vi_top: false, vi_coll: false,
                  vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: true, fan: true, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: false, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 greenhouseFanCoolingActive: true,
                 solarChargePeakTankAvg: null, solarChargePeakTankAvgAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      rt.advance(10000, function() {
        const events = rt.events();
        const fanEvents = events.filter(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 1;
        });
        const fanOff = fanEvents.find(function(e) { return e.detail.on === false; });
        assert.ok(!fanOff,
          'Fan must NOT toggle off when the post-transition state still calls for fan_on. ' +
          'Got fan switch_set events: ' + JSON.stringify(fanEvents));
        done();
      });
    });
  });

  it('non-drain transition: fan still stops when next state wants fan_off', function(t, done) {
    const rt = createOrderingRuntime();
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      rt.clearEvents();
      // Source: GREENHOUSE_HEATING (fan ON). Target: IDLE (fan OFF, no
      // overlay). The fan must be stopped during the pump_stop step.
      rt.globals.Shelly.__test_driveTransition('GREENHOUSE_HEATING', {
        nextMode: 'IDLE',
        valves: { vi_btm: false, vi_top: false, vi_coll: false,
                  vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: false, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 greenhouseFanCoolingActive: false,
                 solarChargePeakTankAvg: null, solarChargePeakTankAvgAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      rt.advance(10000, function() {
        const events = rt.events();
        const fanOff = events.find(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 1 && e.detail.on === false;
        });
        const firstValve = events.findIndex(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        assert.ok(fanOff,
          'Fan must stop when the post-transition state has fan_off');
        const fanOffIdx = events.findIndex(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 1 && e.detail.on === false;
        });
        assert.ok(firstValve >= 0, 'expected valve HTTP.GET events');
        assert.ok(fanOffIdx < firstValve,
          'Fan-off must precede valve commands when target wants fan_off');
        done();
      });
    });
  });
});
