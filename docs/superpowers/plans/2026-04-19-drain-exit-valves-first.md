# Drain exit — close valves first, then stop pump — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverse the exit sequence for `ACTIVE_DRAIN` mode so valves close while the pump keeps running, then after a 20 s wait the pump stops. Every other mode keeps the default "pump-off first, then actuate valves" ordering. Covers both freeze drain and overheat drain (both route through `MODES.ACTIVE_DRAIN`).

**Architecture:** Single branch in `shelly/control.js :: transitionTo()` keyed on the captured source mode. `finalizeTransitionOK()` swaps its post-valve wait between `PUMP_PRIME_MS` (5 s, default) and a new `DRAIN_EXIT_PUMP_RUN_MS` (20 s, drain exit). The valve-failure path in `finalizeTransitionFail()` is unchanged — immediate pump stop on confirmed hardware failure, relying on the existing one-retry in `setValve()`.

**Tech Stack:** ES5 Shelly Espruino runtime (no `class`/`const`/`let`/promises), Node.js `node:test` harness with in-process Shelly runtime mock, `js-yaml` via `npm test:unit`.

**Design doc:** `docs/superpowers/specs/2026-04-19-drain-exit-valves-first-design.md`

---

## File Map

### Modified
- `shelly/control.js` — add `DRAIN_EXIT_PUMP_RUN_MS` constant, `state.transitionFromMode` field, branch in `transitionTo`, dynamic wait in `finalizeTransitionOK`, cleanup in both finalize paths.
- `system.yaml` — rewrite `active_drain.sequence` step 8.
- `CLAUDE.md` — extend the "Safety: stop pump BEFORE switching valves" paragraph with the one named exception.

### Created
- `tests/shelly-transition.test.js` — new shell-level test file with a richer Shelly runtime mock that captures call ordering with timestamps.

---

## Task 1: Scaffold the transition-ordering test harness

**Why:** The existing `tests/shelly-stability.test.js` runtime mock captures concurrent-call violations but does not record call ordering or timestamps. Add a sibling test file with a runtime mock tailored to ordering assertions.

**Files:**
- Create: `tests/shelly-transition.test.js`

- [ ] **Step 1: Write the scaffold (no tests yet).** Full file contents:

```javascript
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
  // Tests added in later tasks.
});
```

- [ ] **Step 2: Run the scaffold to confirm it loads.**

Run: `npx --yes node --test tests/shelly-transition.test.js`
Expected: PASS (0 tests, 0 failures).

- [ ] **Step 3: Commit.**

```bash
git add tests/shelly-transition.test.js
git commit -m "Scaffold shelly-transition ordering test harness"
```

---

## Task 2: Regression test — non-drain exit still stops pump before actuating valves

**Why:** Guard the default pump-first ordering. Must pass against current code and continue to pass after the change.

**Files:**
- Modify: `tests/shelly-transition.test.js`

- [ ] **Step 1: Add test inside the existing describe block.** Insert this `it` block at the end of the `describe` callback (replace the `// Tests added in later tasks.` comment with it):

```javascript
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
      rt.globals.__test_driveTransition('SOLAR_CHARGING', {
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
```

- [ ] **Step 2: Run the test and confirm it fails with "`__test_driveTransition` is not a function".**

Run: `npx --yes node --test tests/shelly-transition.test.js`
Expected: FAIL. This is expected — the hook is added in Task 3.

- [ ] **Step 3: Commit.**

```bash
git add tests/shelly-transition.test.js
git commit -m "Add failing non-drain transition ordering regression test"
```

---

## Task 3: Add `__test_driveTransition` hook to control.js

**Why:** Tests need to enter `transitionTo()` with a specified source mode deterministically. Natural-entry would require a full simulated-time day with sensor values — too fragile and too slow for a unit test. A narrow exported hook keeps the production flow untouched while giving tests a deterministic entry point. Only exported on the `globalThis`-equivalent (the `Shelly` global's host scope) for Node-mock use; the Shelly device doesn't have that host-scope attachment so there's no production surface area.

**Files:**
- Modify: `shelly/control.js` (add hook near the bottom, before `boot()`)

- [ ] **Step 1: Add the hook.** Find the line `boot();` at the end of `shelly/control.js` (last line of the file). Immediately before it, insert:

```javascript
// ── Test hook ──
// Only used by Node unit tests running control.js under a mocked Shelly host.
// The real Shelly device does not expose `globalThis`/the outer function scope,
// so this is a no-op there (the assignment lands in local scope and is GC'd).
// The Function-constructor wrapper used by the test runner passes
// `this === undefined` in strict mode, so we bind to the `Shelly` mock object
// which is always present.
if (typeof Shelly !== "undefined" && Shelly) {
  Shelly.__test_driveTransition = function(fromMode, result) {
    state.mode = MODES[fromMode] || fromMode;
    state.transitioning = false;
    transitionTo(result);
  };
}
```

- [ ] **Step 2: Update the test file to read the hook from `Shelly`.** In `tests/shelly-transition.test.js`, change `rt.globals.__test_driveTransition(...)` to `rt.globals.Shelly.__test_driveTransition(...)` in the test from Task 2.

- [ ] **Step 3: Run the test.**

Run: `npx --yes node --test tests/shelly-transition.test.js`
Expected: PASS (1 test passes — current code already stops pump before valves for non-drain exit).

- [ ] **Step 4: Run the full unit test suite to confirm no regressions from the hook.**

Run: `npm run test:unit`
Expected: All previously passing tests still pass. The hook is additive.

- [ ] **Step 5: Commit.**

```bash
git add shelly/control.js tests/shelly-transition.test.js
git commit -m "Add test hook for driving transitionTo with a specified source mode"
```

---

## Task 4: Failing test — drain exit closes valves BEFORE stopping pump

**Why:** Primary behavioral assertion. Will fail against current code (which stops pump first) and pass after the implementation change in Task 6.

**Files:**
- Modify: `tests/shelly-transition.test.js`

- [ ] **Step 1: Add the test inside the existing describe block.** Append after the existing `it('non-drain exit: ...')` block:

```javascript
  it('drain exit: closes valves BEFORE stopping pump', function(t, done) {
    var rt = createOrderingRuntime();
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
        nextMode: 'IDLE',
        valves: { vi_btm: false, vi_top: false, vi_coll: false,
                  vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: true, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 solarChargePeakTankTop: null, solarChargePeakTankTopAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      // Advance long enough for valves to close AND the 20 s drain-exit wait
      // AND the trailing setActuators. 30 s covers everything.
      rt.advance(30000, function() {
        var events = rt.events();
        var firstValve = events.findIndex(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        var pumpOff = events.findIndex(function(e) {
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
```

- [ ] **Step 2: Run the test and confirm it FAILS.**

Run: `npx --yes node --test tests/shelly-transition.test.js`
Expected: FAIL. The assertion `firstValve < pumpOff` is violated because current code runs setActuators(pump=false) first, then valves.

- [ ] **Step 3: Commit.**

```bash
git add tests/shelly-transition.test.js
git commit -m "Add failing test: drain exit must close valves before pump-off"
```

---

## Task 5: Failing test — drain exit waits ≥ 20 s between valve close and pump off

**Why:** Asserts the timing portion of the spec, not just ordering. Fails against current code; passes after Task 6.

**Files:**
- Modify: `tests/shelly-transition.test.js`

- [ ] **Step 1: Add test after the previous one.**

```javascript
  it('drain exit: waits ≥ 20 s between last valve close and pump-off', function(t, done) {
    var rt = createOrderingRuntime();
    rt.kvs.config = JSON.stringify({
      ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1
    });
    rt.kvs.drained = '0';
    rt.kvs.sensor_config = JSON.stringify({ s: {}, h: {}, version: 1 });
    loadScript(rt, ['control-logic.js', 'control.js']);
    rt.advance(10000, function() {
      rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
        nextMode: 'IDLE',
        valves: { vi_btm: false, vi_top: false, vi_coll: false,
                  vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: true, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 solarChargePeakTankTop: null, solarChargePeakTankTopAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      rt.advance(30000, function() {
        var events = rt.events();
        var valveCloses = events.filter(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        var pumpOff = events.find(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        assert.ok(valveCloses.length > 0, 'expected at least one valve HTTP.GET');
        assert.ok(pumpOff, 'expected a pump-off Switch.Set');
        var lastValveAt = valveCloses[valveCloses.length - 1].t;
        var gap = pumpOff.t - lastValveAt;
        assert.ok(gap >= 20000,
          'pump-off must be ≥ 20 000 ms after last valve close (got ' + gap + ' ms)');
      });
      done();
    });
  });
```

- [ ] **Step 2: Run the test. Expect FAIL** with a gap much smaller than 20 000 ms (probably negative, since current code pumps off before valves).

Run: `npx --yes node --test tests/shelly-transition.test.js`
Expected: FAIL with a gap < 20 000 ms.

- [ ] **Step 3: Commit.**

```bash
git add tests/shelly-transition.test.js
git commit -m "Add failing test: drain exit ≥20 s gap between valve close and pump off"
```

---

## Task 5b: Regression test — valve hardware failure triggers immediate pump stop

**Why:** Spec section 6 step 3. On valve HTTP failure (after the built-in retry in `setValve`), `finalizeTransitionFail()` must call `setPump(false)` immediately — no 20 s wait. Current code already does this; this test is a regression guard.

**Files:**
- Modify: `tests/shelly-transition.test.js`

- [ ] **Step 1: Add test after the previous one.**

```javascript
  it('drain exit: valve HTTP failure → pump stops immediately, no 20 s wait', function(t, done) {
    var rt = createOrderingRuntime({
      httpResponder: function(url) {
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
      rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
        nextMode: 'IDLE',
        valves: { vi_btm: false, vi_top: false, vi_coll: false,
                  vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
        flags: { collectorsDrained: true, lastRefillAttempt: 0,
                 emergencyHeatingActive: false,
                 solarChargePeakTankTop: null, solarChargePeakTankTopAt: 0 },
        suppressed: false, safetyOverride: false,
      });
      // Advance 5 s — well under 20 s. If the failure path waits 20 s, the
      // pump-off event won't be recorded yet and the assertion fails.
      rt.advance(5000, function() {
        var events = rt.events();
        var firstValve = events.find(function(e) {
          return e.kind === 'http_get' && e.detail.url.indexOf('/rpc/Switch.Set') >= 0;
        });
        var pumpOff = events.find(function(e) {
          return e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false;
        });
        assert.ok(firstValve, 'expected a valve HTTP.GET attempt');
        assert.ok(pumpOff, 'expected a pump-off Switch.Set within 5 s');
        var gap = pumpOff.t - firstValve.t;
        assert.ok(gap < 5000,
          'on valve HTTP failure, pump-off must be within 5 s (got ' + gap + ' ms)');
        done();
      });
    });
  });
```

- [ ] **Step 2: Run the test.**

Run: `npx --yes node --test tests/shelly-transition.test.js`
Expected: PASS. Current code's `finalizeTransitionFail()` calls `setPump(false)` synchronously, so the gap is milliseconds. Task 7 preserves this behavior (only adds `transitionFromMode = null` cleanup).

- [ ] **Step 3: Commit.**

```bash
git add tests/shelly-transition.test.js
git commit -m "Add regression test: valve failure → immediate pump stop (no 20 s wait)"
```

---

## Task 6: Implement — `DRAIN_EXIT_PUMP_RUN_MS` and `transitionFromMode`

**Why:** Smallest implementation step — add the config constant and state field without changing behavior. Makes Task 7 a clean behavior-only diff.

**Files:**
- Modify: `shelly/control.js`

- [ ] **Step 1: Add `DRAIN_EXIT_PUMP_RUN_MS` to `SHELL_CFG`.** Edit `shelly/control.js` around lines 4-10. Change:

```javascript
var SHELL_CFG = {
  POLL_INTERVAL: 30000,
  VALVE_SETTLE_MS: 1000,
  PUMP_PRIME_MS: 5000,
  DRAIN_MONITOR_INTERVAL: 200,
  DRAIN_POWER_THRESHOLD: 20,
};
```

To:

```javascript
var SHELL_CFG = {
  POLL_INTERVAL: 30000,
  VALVE_SETTLE_MS: 1000,
  PUMP_PRIME_MS: 5000,
  DRAIN_MONITOR_INTERVAL: 200,
  DRAIN_POWER_THRESHOLD: 20,
  // Post-valve pump-run window on ACTIVE_DRAIN exit. See CLAUDE.md
  // "Safety: stop pump BEFORE switching valves" for the one-sentence rule
  // and system.yaml active_drain.sequence step 8 for the physical reason.
  DRAIN_EXIT_PUMP_RUN_MS: 20000,
};
```

- [ ] **Step 2: Add `transitionFromMode: null` to `state`.** In the `var state = { ... }` block (around lines 36-84), add the field near the other transition fields. Find the line `transition_step: null,` and add `transitionFromMode: null,` right before it:

```javascript
  targetValves: null,       // target valve map (scheduler polarity) during a transition
  targetResult: null,       // full evaluate() result held for end-of-transition finalization
  transitionTimer: null,    // transition-scoped timer handle
  transitionFromMode: null, // mode snapshot at transitionTo() entry; drives drain-exit branch
  transition_step: null,
```

- [ ] **Step 3: Run existing tests to confirm no regressions.**

Run: `npm run test:unit`
Expected: Tasks 4 and 5 still fail (no behavior change yet). Everything else passes.

- [ ] **Step 4: Commit.**

```bash
git add shelly/control.js
git commit -m "Add DRAIN_EXIT_PUMP_RUN_MS config + transitionFromMode state field"
```

---

## Task 7: Implement — branch `transitionTo()` and dynamic wait in `finalizeTransitionOK()`

**Why:** The behavior change. Tasks 4 and 5 should pass after this step; Task 2 (non-drain regression) must continue to pass.

**Files:**
- Modify: `shelly/control.js`

- [ ] **Step 1: Replace `transitionTo(result)`.** Find the function at lines ~690-720:

```javascript
function transitionTo(result) {
  if (state.transitioning) {
    // Allow in-place target change during an in-flight staged transition.
    if (state.targetValves !== null) {
      state.targetValves = toSchedulerView(result.valves);
      state.targetResult = result;
      // Do not interrupt any live opening windows — the next resume will
      // re-plan against the new target.
    }
    return;
  }
  state.transitioning = true;
  state.transition_step = "pump_stop";
  state.targetResult = result;
  state.targetValves = toSchedulerView(result.valves);

  if (state.drain_timer !== null) {
    Timer.clear(state.drain_timer);
    state.drain_timer = null;
  }

  // Turn off all non-valve actuators sequentially (one Shelly.call at a
  // time) before starting the valve transition. See setActuators comment
  // for the concurrency-budget rationale.
  setActuators({ pump: false, fan: false, space_heater: false, immersion_heater: false }, function() {
    emitStateUpdate();
    Timer.set(SHELL_CFG.VALVE_SETTLE_MS, false, function() {
      scheduleStep();
    });
  });
}
```

With:

```javascript
function transitionTo(result) {
  if (state.transitioning) {
    // Allow in-place target change during an in-flight staged transition.
    if (state.targetValves !== null) {
      state.targetValves = toSchedulerView(result.valves);
      state.targetResult = result;
      // Do not interrupt any live opening windows — the next resume will
      // re-plan against the new target.
    }
    return;
  }
  // Snapshot the source mode BEFORE state.transitioning flips — used by
  // the drain-exit branch below and by finalizeTransitionOK() to pick the
  // post-valve wait.
  state.transitionFromMode = state.mode;
  state.transitioning = true;
  state.targetResult = result;
  state.targetValves = toSchedulerView(result.valves);

  if (state.drain_timer !== null) {
    Timer.clear(state.drain_timer);
    state.drain_timer = null;
  }

  // ── Drain-exit ordering (exception to pump-first rule) ──
  // When exiting ACTIVE_DRAIN, close valves WHILE the pump is still
  // running so residual water in the manifold piping is pushed out to
  // the tank before the valves seal. The 20 s post-valve wait inside
  // finalizeTransitionOK() is what actually stops the pump.
  if (state.transitionFromMode === MODES.ACTIVE_DRAIN) {
    state.transition_step = "valves_opening";
    emitStateUpdate();
    scheduleStep();
    return;
  }

  // Default path: stop pump/fan/heaters first, then actuate valves.
  state.transition_step = "pump_stop";
  setActuators({ pump: false, fan: false, space_heater: false, immersion_heater: false }, function() {
    emitStateUpdate();
    Timer.set(SHELL_CFG.VALVE_SETTLE_MS, false, function() {
      scheduleStep();
    });
  });
}
```

- [ ] **Step 2: Replace `finalizeTransitionOK(result)`.** Find at lines ~509-541:

```javascript
function finalizeTransitionOK(result) {
  state.transition_step = "pump_start";
  emitStateUpdate();
  Timer.set(SHELL_CFG.PUMP_PRIME_MS, false, function() {
    state.mode = result.nextMode;
    state.mode_start = Date.now();
    captureWatchdogBaseline();
    state.transitioning = false;
    state.transition_step = null;
    state.targetValves = null;
    state.targetResult = null;
    state.valvePendingOpen = [];
    state.valvePendingClose = [];
    applyFlags(result.flags);

    // Turn the requested actuators on via setActuators so only one
    // Shelly.call is in flight at a time (same concurrency-budget
    // reasoning as transitionTo's stop step).
    setActuators({
      pump: !!result.actuators.pump,
      fan: !!result.actuators.fan,
      space_heater: !!result.actuators.space_heater,
      immersion_heater: !!result.actuators.immersion_heater
    }, function() {
      if (result.nextMode === MODES.SOLAR_CHARGING) {
        Shelly.call("KVS.Set", {key: "drained", value: "0"});
      } else if (result.nextMode === MODES.ACTIVE_DRAIN) {
        startDrainMonitor();
      }
      emitStateUpdate();
    });
  });
}
```

With:

```javascript
function finalizeTransitionOK(result) {
  state.transition_step = "pump_start";
  emitStateUpdate();
  // Default wait is pump-prime (5 s). For ACTIVE_DRAIN exit, extend to
  // DRAIN_EXIT_PUMP_RUN_MS (20 s) — see transitionTo() for the rule.
  var postValveWaitMs = (state.transitionFromMode === MODES.ACTIVE_DRAIN)
    ? SHELL_CFG.DRAIN_EXIT_PUMP_RUN_MS
    : SHELL_CFG.PUMP_PRIME_MS;
  Timer.set(postValveWaitMs, false, function() {
    state.mode = result.nextMode;
    state.mode_start = Date.now();
    captureWatchdogBaseline();
    state.transitioning = false;
    state.transition_step = null;
    state.targetValves = null;
    state.targetResult = null;
    state.transitionFromMode = null;
    state.valvePendingOpen = [];
    state.valvePendingClose = [];
    applyFlags(result.flags);

    // Turn the requested actuators on via setActuators so only one
    // Shelly.call is in flight at a time (same concurrency-budget
    // reasoning as transitionTo's stop step).
    setActuators({
      pump: !!result.actuators.pump,
      fan: !!result.actuators.fan,
      space_heater: !!result.actuators.space_heater,
      immersion_heater: !!result.actuators.immersion_heater
    }, function() {
      if (result.nextMode === MODES.SOLAR_CHARGING) {
        Shelly.call("KVS.Set", {key: "drained", value: "0"});
      } else if (result.nextMode === MODES.ACTIVE_DRAIN) {
        startDrainMonitor();
      }
      emitStateUpdate();
    });
  });
}
```

- [ ] **Step 3: Replace `finalizeTransitionFail()`.** Find at lines ~543-556:

```javascript
function finalizeTransitionFail() {
  clearTransitionTimer();
  state.targetValves = null;
  state.targetResult = null;
  state.valvePendingOpen = [];
  state.valvePendingClose = [];
  setPump(false);
  state.mode = MODES.IDLE;
  state.mode_start = Date.now();
  captureWatchdogBaseline();
  state.transitioning = false;
  state.transition_step = null;
  emitStateUpdate();
}
```

With (just add the `transitionFromMode` reset):

```javascript
function finalizeTransitionFail() {
  clearTransitionTimer();
  state.targetValves = null;
  state.targetResult = null;
  state.transitionFromMode = null;
  state.valvePendingOpen = [];
  state.valvePendingClose = [];
  setPump(false);
  state.mode = MODES.IDLE;
  state.mode_start = Date.now();
  captureWatchdogBaseline();
  state.transitioning = false;
  state.transition_step = null;
  emitStateUpdate();
}
```

- [ ] **Step 4: Run the transition test suite.**

Run: `npx --yes node --test tests/shelly-transition.test.js`
Expected: All 3 tests pass (non-drain ordering regression + drain ordering + 20 s gap).

- [ ] **Step 5: Run the full unit test suite to confirm no regressions.**

Run: `npm run test:unit`
Expected: All tests pass.

- [ ] **Step 6: Commit.**

```bash
git add shelly/control.js
git commit -m "Reverse drain-exit sequence: close valves, wait 20 s, then stop pump"
```

---

## Task 8: Update `system.yaml` `active_drain.sequence` step 8

**Files:**
- Modify: `system.yaml`

- [ ] **Step 1: Edit step 8.** Find lines 560-561 in `system.yaml`:

```yaml
      - step: 8
        action: "Power drops below threshold → stop pump → close all valves"
```

Replace with:

```yaml
      - step: 8
        action: >
          Power drops below threshold → close all valves → wait 20 s →
          stop pump. Exception to the stop-pump-first rule: keeps the pump
          pushing residual water out of the manifold piping while the
          valves seal, so water is not trapped between closed valves
          (where it could freeze in the freeze-drain case).
```

- [ ] **Step 2: Run the full test suite** — topology and system-yaml drift tests read `system.yaml`; make sure the edit didn't break parsing.

Run: `npm run test:unit`
Expected: All tests pass.

- [ ] **Step 3: Commit.**

```bash
git add system.yaml
git commit -m "system.yaml: document valves-first drain-exit sequence"
```

---

## Task 9: Update `CLAUDE.md` safety-rule paragraph

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Edit the safety paragraph.** Find lines 50-52:

```markdown
### Safety: stop pump BEFORE switching valves

Generally true, enforced by `transitionTo()` in `shelly/control.js` (stops pump/fan/heaters, then actuates valves). A few specific sequences intentionally deviate — don't simplify the transition scheduler assuming pump-first is always safe.
```

Replace with:

```markdown
### Safety: stop pump BEFORE switching valves

Generally true, enforced by `transitionTo()` in `shelly/control.js` (stops pump/fan/heaters, then actuates valves). **The one named exception is exit from `ACTIVE_DRAIN`**, which reverses the order (close valves → wait 20 s via `DRAIN_EXIT_PUMP_RUN_MS` → stop pump) so the pump evacuates residual water from the manifold before the valves seal. Don't simplify the transition scheduler assuming pump-first is always safe.
```

- [ ] **Step 2: Commit.**

```bash
git add CLAUDE.md
git commit -m "CLAUDE.md: name ACTIVE_DRAIN exit as the one pump-first exception"
```

---

## Task 10: Final verification

- [ ] **Step 1: Run the full test suite** (unit + simulation + e2e if configured).

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Run the Shelly lint.**

Run: `node shelly/lint/cli.mjs shelly/control.js`
Expected: No new errors or warnings introduced by the changes.

- [ ] **Step 3: Verify git status is clean.**

Run: `git status`
Expected: `(clean)` — no untracked or uncommitted files.

- [ ] **Step 4: Verify the branch diff.**

Run: `git log --oneline main..HEAD`
Expected: 10 commits corresponding to tasks 1-9 (scaffold → non-drain test → hook → drain-ordering test → 20 s gap test → failure-path test → constants → behavior → yaml → CLAUDE.md).

---

## Notes for the executing agent

- **ES5 discipline:** `shelly/control.js` runs on Espruino. Use `var`, no arrow functions in the production script, no `const`/`let`, no template literals. The lint CLI will flag violations; test files are plain Node.js and may use modern JS.
- **Shelly script 16 KB budget:** The spec's additions are a handful of lines. If the lint complains about size, note it and stop — but this should not trigger.
- **Don't touch `control-logic.js`:** The behavior change is orchestration-layer only. `evaluate()` already correctly handles ACTIVE_DRAIN exit (returns IDLE after `drainTimeout`); no decision change is needed.
- **Why `__test_driveTransition` instead of a simulation-based test:** The simulation harness drives the decision layer, not `transitionTo()`'s timer chain. Shell-orchestration ordering is not observable without either (a) a test hook or (b) real hardware. We chose the hook because the alternative is a brittle multi-second setTimeout dance.
- **`transitionFromMode` naming:** Past tense, distinguishes from `mode`/`nextMode`. Must be set BEFORE `state.transitioning = true` so that a caller reading the field mid-flight sees the source mode, not `null`.
