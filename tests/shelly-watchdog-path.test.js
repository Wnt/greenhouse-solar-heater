/**
 * Shelly watchdog fire + auto-shutdown path.
 *
 * Exercises the on-device watchdog orchestration that the pure
 * detectAnomaly() unit tests (tests/detect-anomaly.test.js) cannot
 * reach: baseline capture at mode entry, per-tick detection, `fired`
 * MQTT event, 5-minute grace period, auto-shutdown publishing wb
 * config to KVS.
 *
 * Scenario driven here is `scs` (SOLAR_CHARGING collector stall) —
 * shortest window of the three watchdogs at 5 min, plus 5 min grace
 * = ~10 min sim.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createInstrumentedRuntime } = require('./shelly/platform-limits.js');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');
const FILES = ['control-logic.js', 'control.js'];

function loadScripts(runtime) {
  const src = FILES.map(f => fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8')).join('\n');
  const fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    '__TEST_HARNESS',
    src
  );
  const g = runtime.globals;
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

async function drainImmediates(rounds = 30) {
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function settleBoot(rt) {
  for (let i = 0; i < 40; i++) {
    await drainImmediates(1);
    rt.advance(1);
  }
  rt.advance(15000);
  for (let i = 0; i < 60; i++) {
    await drainImmediates(1);
    rt.advance(1);
  }
}

describe('Shelly watchdog: scs fire → auto-shutdown', () => {
  let now = 1700000000000;
  let bootAnchor = 0;
  const watchdogEvents = [];
  const stateEvents = [];

  // Sensor readings designed to:
  //   1. Trigger SOLAR_CHARGING entry (collector > tank_bottom + 10).
  //   2. Stay flat on collector so `scs` fires at 5 min:
  //      `entry.collector - s.collector < 3` (collector NOT cooling).
  //   3. Tank_top rises slowly so SC does NOT exit (solarExitStallSeconds
  //      would otherwise drop us back to IDLE before grace expires).
  //      Rise is small enough that `sng` (tank-no-gain, 10 min window)
  //      still fires but `scs` (5 min window) fires first.
  function temp(sensor) {
    const elapsedMin = (now - bootAnchor) / 60000;
    switch (sensor) {
      case 'collector':    return 60;
      case 'tank_top':     return 40 + elapsedMin * 0.5;  // slow rise → SC stays entered
      case 'tank_bottom':  return 30;
      case 'greenhouse':   return 15;
      case 'outdoor':      return 10;
      default:             return 20;
    }
  }
  const CID = { 100: 'collector', 101: 'tank_top', 102: 'tank_bottom', 103: 'greenhouse', 104: 'outdoor' };

  const rt = createInstrumentedRuntime({
    now: () => now,
    setNow: n => { now = n; },
    mqttConnected: true,
    onPublish: (topic, payload) => {
      if (topic === 'greenhouse/watchdog/event') watchdogEvents.push(JSON.parse(payload));
      else if (topic === 'greenhouse/state') stateEvents.push(JSON.parse(payload));
    },
    httpResponder: (url) => {
      if (url.indexOf('Temperature.GetStatus') >= 0) {
        const m = url.match(/id=(\d+)/);
        const sensor = CID[m ? parseInt(m[1], 10) : 0] || 'x';
        return { code: 200, body: JSON.stringify({ tC: temp(sensor) }) };
      }
      return { code: 200, body: '{}' };
    },
    kvs: {
      // Enable the scs watchdog only so the test isolates it. we.scs=true,
      // we.sng / we.ggr unset.
      config: JSON.stringify({
        ce: true, ea: 31, fm: null,
        we: { scs: true }, wz: {}, wb: {}, v: 1,
      }),
      sensor_config: JSON.stringify({
        s: {
          collector:   { h: 0, i: 100 },
          tank_top:    { h: 0, i: 101 },
          tank_bottom: { h: 0, i: 102 },
          greenhouse:  { h: 0, i: 103 },
          outdoor:     { h: 0, i: 104 },
        },
        h: ['192.168.30.20'],
        v: 1,
      }),
    },
  });

  let firedAtTick = null;
  let shutdownAtTick = null;

  before(async () => {
    loadScripts(rt);
    await settleBoot(rt);
    bootAnchor = now;

    // Advance 25 min of sim time: ~2 min to enter SC + finish transition,
    // then 5 min collector-stall before scs fires, then 5 min grace period
    // before auto-shutdown, plus slack. One tick = 30 s.
    const TICKS = 50;
    for (let tick = 0; tick < TICKS; tick++) {
      rt.advance(30000);
      await drainImmediates(30);

      const fired = watchdogEvents.find(e => e.t === 'fired');
      const resolved = watchdogEvents.find(e => e.t === 'resolved' && e.how === 'shutdown_auto');
      if (fired && firedAtTick === null) firedAtTick = tick;
      if (resolved && shutdownAtTick === null) shutdownAtTick = tick;
    }
  });

  it('transitions into SOLAR_CHARGING during the first few ticks', () => {
    const modes = new Set(stateEvents.map(e => e.mode));
    assert.ok(modes.has('solar_charging'),
      'expected solar_charging to be entered; observed: ' + [...modes].join(', '));
  });

  it('publishes a `fired` watchdog event for scs within ~5-7 min', () => {
    const fired = watchdogEvents.filter(e => e.t === 'fired');
    assert.ok(fired.length >= 1,
      'expected ≥ 1 fired event, observed ' + fired.length);
    assert.strictEqual(fired[0].id, 'scs',
      'expected scs watchdog; got ' + fired[0].id);
    assert.strictEqual(fired[0].mode, 'SOLAR_CHARGING');
    assert.ok(firedAtTick !== null && firedAtTick <= 14,
      `expected fire by tick 14 (~7 min); fired at tick ${firedAtTick}`);
  });

  it('after 5-minute grace, auto-shuts down with wb ban persisted', () => {
    const resolved = watchdogEvents.filter(e => e.t === 'resolved' && e.how === 'shutdown_auto');
    assert.ok(resolved.length >= 1,
      'expected auto-shutdown resolution event; observed: ' +
      JSON.stringify(watchdogEvents.map(e => ({ t: e.t, how: e.how }))));

    // KVS config was re-written with wb.SC set to a future timestamp
    // (cool-off ban). The merged control calls Shelly.call("KVS.Set",
    // {key:"config", value:...}) without a callback; the mock persists
    // synchronously via setImmediate.
    const persisted = JSON.parse(rt.kvs.config);
    assert.ok(persisted.wb && typeof persisted.wb.SC === 'number' && persisted.wb.SC > 0,
      'expected wb.SC cool-off ban persisted to KVS; got wb=' + JSON.stringify(persisted.wb));
  });

  it('mode returns to idle after auto-shutdown', () => {
    const lastMode = stateEvents.length ? stateEvents[stateEvents.length - 1].mode : null;
    assert.strictEqual(lastMode, 'idle',
      'expected final mode idle after auto-shutdown; got ' + lastMode);
  });
});
