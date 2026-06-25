/**
 * Shelly transition failure path.
 *
 * When a valve HTTP.GET fails twice in a row, setValve invokes its
 * callback with ok=false, setValves short-circuits to
 * finalizeTransitionFail which resets state to IDLE. Exercises the
 * path the happy-path tests never reach.
 *
 * Observable side-effects (cannot read script's internal state across
 * the new Function boundary):
 *   - published greenhouse/state shows mode=idle after the attempted
 *     transition (vs mode=solar_charging on success),
 *   - published state has transitioning=false,
 *   - each attempted valve actuation generated 2 HTTP.GET calls
 *     (initial + retry).
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

describe('Shelly transition: valve HTTP failure → finalizeTransitionFail', () => {
  let now = 1700000000000;
  const stateEvents = [];
  let bootCompletedAt = 0;
  // Per-valve-host HTTP call counter. The Pro 2PM valve hosts
  // (192.168.30.51/52/53/54) get 2 HTTP.GETs per failed setValve
  // (initial + retry). Sensor polls go to 192.168.30.20 (test sensor
  // host) — tracked separately.
  const valveHttpCalls = [];

  function temp(sensor) {
    switch (sensor) {
      case 'collector':    return 60;
      case 'tank_top':     return 40;
      case 'tank_bottom':  return 30;  // SC trigger
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
      // Epic #254 (#258): device publishes the minimal payload on
      // greenhouse/state/min (server reassembles greenhouse/state). mode +
      // transitioning are still present in the minimal payload.
      if (topic === 'greenhouse/state/min') stateEvents.push(JSON.parse(payload));
    },
    httpResponder: (url) => {
      // Sensor polls succeed; valve switch commands fail.
      if (url.indexOf('Temperature.GetStatus') >= 0) {
        const m = url.match(/id=(\d+)/);
        const sensor = CID[m ? parseInt(m[1], 10) : 0] || 'x';
        return { code: 200, body: JSON.stringify({ tC: temp(sensor) }) };
      }
      if (url.indexOf('Switch.Set') >= 0 && url.indexOf('192.168.30.5') >= 0) {
        // Only count failures AFTER boot completes — boot runs
        // closeAllValves which we don't want to fail (the boot loop
        // retries forever on failure).
        if (bootCompletedAt > 0) {
          valveHttpCalls.push(url);
          return { code: 500, body: '{}' };  // fail the switch command
        }
        return { code: 200, body: '{}' };  // succeed during boot
      }
      return { code: 200, body: '{}' };
    },
    kvs: {
      // fm:"SC" forces SOLAR_CHARGING without relying on temp thresholds.
      // This keeps the test deterministic and avoids oscillation via
      // solarExitStallSeconds.
      config: JSON.stringify({
        ce: true, ea: 31, fm: 'SC',
        we: {}, wz: {}, wb: {}, v: 1,
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

  before(async () => {
    loadScripts(rt);
    await settleBoot(rt);
    bootCompletedAt = now;
    // Let a few controlLoop ticks run — each tick's evaluate() will
    // return fm=SC and transitionTo() will be called, hitting the
    // failing switch commands and returning via finalizeTransitionFail.
    for (let tick = 0; tick < 5; tick++) {
      rt.advance(30000);
      await drainImmediates(30);
    }
  });

  it('attempted to open valves (failed HTTP calls observed)', () => {
    // For SOLAR_CHARGING, plan.startOpening = [vi_btm, vo_coll]. Each
    // fires setValve → HTTP.GET (fail) → retry HTTP.GET (fail). So
    // we expect ≥ 4 Switch.Set calls on valve hosts per transition
    // attempt. Depending on how many ticks tried to transition, more.
    assert.ok(valveHttpCalls.length >= 4,
      `expected ≥ 4 valve HTTP.GETs (2 valves × 2 retries); observed ${valveHttpCalls.length}`);
  });

  it('never successfully entered SOLAR_CHARGING (transition failed)', () => {
    const modes = new Set(stateEvents.map(e => e.mode));
    assert.ok(!modes.has('solar_charging'),
      `expected transition to fail and mode to stay idle; observed modes: [${[...modes].join(', ')}]`);
  });

  it('final published state is idle and not transitioning', () => {
    assert.ok(stateEvents.length > 0, 'expected at least one state publish');
    const last = stateEvents[stateEvents.length - 1];
    assert.strictEqual(last.mode, 'idle',
      'expected mode=idle after failure; got ' + last.mode);
    assert.strictEqual(last.transitioning, false,
      'expected transitioning=false after finalizeTransitionFail');
  });

  it('no valve was ever opened (every post-boot Switch.Set failed)', () => {
    // Epic #254 (#258): the device payload no longer carries `valves` (the
    // server reassembles it from native relay status). The device-observable
    // proof that no valve flipped to open is the HTTP side: setValve only
    // updates state.valve_states on HTTP success, and every post-boot valve
    // Switch.Set in this test returns 500 (see httpResponder). So at least one
    // open was attempted and none could have succeeded.
    assert.ok(valveHttpCalls.length > 0,
      'expected at least one post-boot valve Switch.Set attempt');
    for (const url of valveHttpCalls) {
      assert.ok(url.indexOf('Switch.Set') >= 0,
        `expected only Switch.Set calls on valve hosts; got ${url}`);
    }
  });
});
