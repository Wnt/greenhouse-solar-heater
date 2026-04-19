# Shelly Platform-Limit Test Harness + Single-Script Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent future Shelly OOM/timer/subscription crashes by (a) introducing a Node-level platform-limit test harness with hard caps, and (b) merging `shelly/telemetry.js` into `shelly/control.js` so only one script runs on the Pro 4PM.

**Architecture:** Extend the existing Shelly runtime mock (`tests/shelly-stability.test.js`) with counters for Timer handles, MQTT subscriptions, in-flight RPCs, and KVS writes. Run a 24-hour virtual-time simulation against it, asserting caps every tick. Then collapse the `control.js` ↔ `telemetry.js` `Shelly.emitEvent` bridge into direct function calls and inline `MQTT.publish`, deploying the merged script to a single Shelly Script slot. No behaviour change; only heap/plumbing reduction.

**Tech Stack:** Node.js `node:test`, Shelly Gen-2 Espruino runtime (ES5 subset), Acorn AST walker for lint, Bash for deploy.

**Spec reference:** `docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md` (sections 1–3 and success criteria).

---

## Files Created or Modified

| Path | Create/Modify | Responsibility |
|---|---|---|
| `tests/shelly/platform-limits.js` | Create | Reusable mock runtime exposing counters + CAP constants + `runtimeProxy()` byte-sum calculator |
| `tests/shelly/CAPS.md` | Create | Table of current measured peaks vs. enforced caps, updated per commit |
| `tests/shelly-platform-limits.test.js` | Create | 24-hour simulation asserting Timer/MQTT/RPC/KVS/proxy caps |
| `shelly/control.js` | Modify | Absorbs all of `telemetry.js`: MQTT subscribe/publish, config KVS load/save, bootstrap HTTP config. Removes every `Shelly.emitEvent`/`addEventHandler` plumbing that was the control↔telemetry IPC |
| `shelly/telemetry.js` | Delete | Folded into control.js |
| `shelly/deploy.sh` | Modify | `EXPECTED_SLOT_COUNT` 2→1; remove slot-2 upload block |
| `tests/deploy.test.js` | Modify | Assert only one script slot is provisioned and uploaded |
| `tests/shelly-stability.test.js` | Modify | Load single merged file; add `MQTT.unsubscribe` to the mock |
| `tests/shelly-telemetry.test.js` | Modify | Rename to `tests/shelly-control-mqtt.test.js`; observe `MQTT.publish` side-effects instead of `Shelly.emitEvent` |
| `tests/shelly-transition.test.js` | Modify | Replace any `Shelly.emitEvent("state_updated")` captures with `MQTT.publish` captures |
| `shelly/lint/rules/index.js` | Modify | Add `SH-LEAK-TIMER`/`SH-LEAK-SUB`/`SH-LEAK-RPC` rules for unbounded loop/callback usage |
| `shelly/lint/rules.test.js` | Create (if absent) | Unit tests for the new lint rules |

File-level boundaries:
- `control-logic.js` stays untouched (pure decision logic, consumed by playground + Node tests).
- `platform-limits.js` is a reusable module, not a test. The test file loads it.
- Lint rules live in one file to match existing convention (`rules/index.js` already contains all rules).

---

## Commit Sequence

The spec mandates five atomic, bisectable commits on a feature branch. Each commit below corresponds to one phase in `Section 3 — Migration`.

1. `shelly: add platform-limit test harness (caps deliberately fail today)`
2. `shelly: merge telemetry into control (single deployed slot)`
3. `shelly: collapse valve bookkeeping + dedupe constants`
4. `shelly: calibrate platform-limit caps to new baseline`
5. `shelly/lint: add static rules for unbounded Timer/RPC/subscribe in callbacks`

Plus a **non-code post-merge verification** step (live `mem_peak` read from Pro 4PM).

---

## Pre-work: Set up worktree

- [ ] **Step 0.1: Create worktree**

Current branch is `main`. This feature is substantial and must not disturb `main` while CI is relied on for other work.

Run:
```bash
git worktree add ../kasvihuone-shelly-merge -b shelly/platform-limits-and-merge
cd ../kasvihuone-shelly-merge
```
Expected: new worktree created at `../kasvihuone-shelly-merge`, branch `shelly/platform-limits-and-merge` checked out.

All subsequent tasks run in that worktree.

- [ ] **Step 0.2: Verify current state is green**

Run: `npm run test:unit`
Expected: all unit tests pass (this is the pre-change baseline).

---

## Commit 1 — Platform-limit test harness

**Goal:** Introduce the harness, counters, and CAPS table. The new test is expected to FAIL against current `control.js`+`telemetry.js` by design — this is the "deliberately fail today" step from the spec.

**Files:**
- Create: `tests/shelly/platform-limits.js`
- Create: `tests/shelly/CAPS.md`
- Create: `tests/shelly-platform-limits.test.js`

### Task 1.1 — Create the counter-instrumented runtime module

- [ ] **Step 1.1.1: Create `tests/shelly/platform-limits.js`**

This module exports:
- `CAPS` — the numeric caps enforced by the test suite.
- `createInstrumentedRuntime(opts)` — returns a mock Shelly runtime whose globals can be passed into `new Function(...)` to host `control.js` + `control-logic.js`. The runtime tracks:
  - Simultaneous live `Timer.set` handles (peak).
  - In-flight `Shelly.call` (peak), across all methods.
  - Active `MQTT.subscribe` topics (peak).
  - KVS value bytes per key (peak).
  - `JSON.stringify(state).length` of the in-script `state` object (sampled via a ticker callback — the test file reads it each tick).
  - Pending closures retained by live timers / in-flight callbacks — approximated by summing `JSON.stringify(captured)` of each live `cb`'s closure scope (we can't introspect closures from Node, so each API wrapper records the outer object view supplied when the test sets up, plus the arguments — see runtimeProxy definition below).
- `runtimeProxy({state, deviceConfig, sensorConfig, liveTimers, liveCalls, minifiedBytecodeSize})` — returns the deterministic byte-sum from the spec's Section 1 formula.

File content (skeleton, fill in fully):

```js
// tests/shelly/platform-limits.js
// Counter-instrumented Shelly runtime mock. Consumed by
// tests/shelly-platform-limits.test.js for the 24-hour simulation.

const CAPS = {
  DEPLOYED_BYTES: 65535,          // Shelly Script.PutCode hard limit, error -103
  RUNTIME_PROXY_PEAK: 0,          // set by calibrateProxyCap() at test bootstrap
  STATE_BYTES: 600,               // JSON.stringify(state).length peak
  LIVE_TIMERS: 3,                 // simultaneous Timer.set handles (5 - 2 reserve)
  MQTT_SUBS: 3,                   // active MQTT.subscribe topics
  INFLIGHT_CALLS: 3,              // in-flight Shelly.call (5 - 2 reserve)
  KVS_VALUE_BYTES: 256,           // empirical Pro 4PM cap (2026-04-20)
};

function createInstrumentedRuntime(opts) {
  opts = opts || {};
  // counters
  let timerHandles = 0, peakTimers = 0;
  let inflightCalls = 0, peakCalls = 0;
  let peakSubs = 0;
  const liveTimers = new Map();     // id -> {ms, cb}
  const liveCalls = new Map();      // id -> {method, params, cb}
  const kvs = {};
  const mqttSubs = new Map();       // topic -> cb
  let peakKvsBytes = 0;
  let kvsTooLarge = null;           // {key, bytes} first violation
  let mqttConnected = !!opts.mqttConnected;
  let mqttConnectHandler = null;
  const eventHandlers = [];
  const kvsWrites = [];             // for value-bytes assertion per key

  let callIdSeq = 0;
  function shellyCall(method, params, cb) {
    const id = ++callIdSeq;
    inflightCalls++;
    if (inflightCalls > peakCalls) peakCalls = inflightCalls;
    liveCalls.set(id, { method, params, cb });

    // Synthesise responses per method.
    let response = null;
    if (method === 'KVS.Get') {
      const val = kvs[(params || {}).key] || null;
      response = val ? { value: val } : null;
    } else if (method === 'KVS.Set') {
      const key = (params || {}).key;
      const value = String((params || {}).value || '');
      const bytes = Buffer.byteLength(value, 'utf8');
      kvsWrites.push({ key, bytes });
      if (bytes > peakKvsBytes) peakKvsBytes = bytes;
      if (bytes > CAPS.KVS_VALUE_BYTES && !kvsTooLarge) {
        kvsTooLarge = { key, bytes };
      }
      kvs[key] = value;
      response = {};
    } else if (method === 'Switch.Set' || method === 'Switch.SetConfig') {
      response = {};
    } else if (method === 'HTTP.GET' || method === 'HTTP.POST') {
      const responder = opts.httpResponder || (() => ({ code: 0, body: '' }));
      const httpRes = responder((params || {}).url || '');
      setImmediate(() => {
        inflightCalls--;
        liveCalls.delete(id);
        if (cb) cb(null, httpRes);
      });
      return;
    }
    setImmediate(() => {
      inflightCalls--;
      liveCalls.delete(id);
      if (cb) cb(response, null);
    });
  }

  let timerIdSeq = 0;
  function timerSet(ms, repeat, cb) {
    const id = ++timerIdSeq;
    liveTimers.set(id, { ms, repeat, cb, dueAt: opts.now() + ms });
    timerHandles = liveTimers.size;
    if (timerHandles > peakTimers) peakTimers = timerHandles;
    return id;
  }

  function timerClear(id) {
    liveTimers.delete(id);
    timerHandles = liveTimers.size;
  }

  const mqtt = {
    subscribe(topic, cb) {
      if (mqttSubs.has(topic)) throw new Error('Invalid topic');
      mqttSubs.set(topic, cb);
      if (mqttSubs.size > peakSubs) peakSubs = mqttSubs.size;
    },
    unsubscribe(topic) {
      mqttSubs.delete(topic);
    },
    publish(topic, payload, qos, retain) {
      if (opts.onPublish) opts.onPublish(topic, payload, qos, retain);
    },
    isConnected() { return mqttConnected; },
    setConnectHandler(cb) { mqttConnectHandler = cb; },
  };

  function emitEvent(name, data) {
    for (const h of eventHandlers) {
      try { h({ info: { event: name, data } }); } catch (_e) {}
    }
  }

  return {
    globals: {
      Shelly: {
        call: shellyCall,
        emitEvent,
        addEventHandler: fn => eventHandlers.push(fn),
        addStatusHandler: () => {},
        getComponentStatus(type) {
          if (type === 'switch') return { apower: 50, output: true };
          if (type === 'sys') return { unixtime: Math.floor(opts.now() / 1000) };
          return {};
        },
      },
      Timer: { set: timerSet, clear: timerClear },
      MQTT: mqtt,
      JSON, Date, Math, parseInt,
      print: () => {},
    },
    stats() {
      return {
        peakTimers, peakCalls, peakSubs, peakKvsBytes,
        kvsTooLarge,
        liveTimers: new Map(liveTimers),
        liveCalls: new Map(liveCalls),
        mqttSubs: new Map(mqttSubs),
      };
    },
    advance(ms) {
      // Fire timers whose dueAt <= now + ms, in order. Caller advances opts.now().
      const targetNow = opts.now() + ms;
      const fired = [];
      // one-ms hops so callback side-effects can schedule fresh timers mid-hop
      while (opts.now() < targetNow) {
        opts.setNow(opts.now() + 1);
        for (const [id, t] of liveTimers) {
          if (t.dueAt <= opts.now()) {
            if (t.repeat) t.dueAt = opts.now() + t.ms;
            else liveTimers.delete(id);
            fired.push({ id, cb: t.cb });
          }
        }
        for (const f of fired.splice(0)) {
          try { f.cb(); } catch (_e) {}
        }
      }
    },
    triggerMqttConnect() {
      mqttConnected = true;
      if (mqttConnectHandler) mqttConnectHandler();
    },
    deliverMqtt(topic, message) {
      const cb = mqttSubs.get(topic);
      if (cb) cb(topic, message);
    },
    kvs,
  };
}

function runtimeProxy({state, deviceConfig, sensorConfig, liveTimers, liveCalls, minifiedBytecodeSize}) {
  let bytes = minifiedBytecodeSize;
  bytes += JSON.stringify(state).length;
  bytes += JSON.stringify(deviceConfig).length;
  bytes += JSON.stringify(sensorConfig).length;
  for (const t of liveTimers.values()) {
    try { bytes += JSON.stringify(t).length; } catch (_e) { bytes += 64; }
  }
  for (const c of liveCalls.values()) {
    try { bytes += JSON.stringify({method: c.method, params: c.params}).length; } catch (_e) { bytes += 64; }
  }
  return bytes;
}

module.exports = { CAPS, createInstrumentedRuntime, runtimeProxy };
```

- [ ] **Step 1.1.2: Sanity-check the module loads**

Run: `node -e "console.log(Object.keys(require('./tests/shelly/platform-limits.js')))"`
Expected: `[ 'CAPS', 'createInstrumentedRuntime', 'runtimeProxy' ]`

### Task 1.2 — Write the 24-hour simulation test

- [ ] **Step 1.2.1: Write `tests/shelly-platform-limits.test.js` skeleton with a 24-hour loop**

File content:

```js
// tests/shelly-platform-limits.test.js
// 24-hour virtual-time simulation of control.js + (today) telemetry.js
// against the instrumented runtime. Enforces every platform cap from
// docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md.
//
// This test is DELIBERATELY FAILING at introduction. The Section 2 merge
// brings the peak-runtime-proxy cap into compliance; Section 3 (Commit 3)
// collapses valve bookkeeping to hit the 0.7× reduction; Commit 4
// recalibrates the cap to the achieved number + 512 B.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { CAPS, createInstrumentedRuntime, runtimeProxy } = require('./shelly/platform-limits.js');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

function minify(src) {
  return src.split('\n').map(l => l.replace(/^\s+/, '')).filter(l => l && !l.startsWith('//')).join('\n') + '\n';
}

function loadShellyScripts(runtime, files) {
  const src = files.map(f => fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8')).join('\n');
  const fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    '__TEST_HARNESS',
    src
  );
  const g = runtime.globals;
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

function deployedBytecodeSize(files) {
  return files.map(f => minify(fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8')).length).reduce((a, b) => a + b, 0);
}

describe('Shelly platform-limit 24 h simulation', () => {
  let now = 1700000000000;
  const runtime = createInstrumentedRuntime({
    now: () => now,
    setNow: n => { now = n; },
    mqttConnected: true,
    httpResponder: url => {
      // Any Temperature.GetStatus returns synthetic values so pollSensor has fresh data.
      if (url.includes('Temperature.GetStatus')) {
        return { code: 200, body: JSON.stringify({ tC: 20 + Math.random() * 5 }) };
      }
      return { code: 200, body: '' };
    },
  });

  // Pre-seed KVS with a minimal viable config.
  runtime.kvs.config = JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 });
  runtime.kvs.sensor_config = JSON.stringify({
    s: { collector: { h: 0, i: 100 }, tank_top: { h: 0, i: 101 } },
    h: ['192.168.30.20'],
    v: 1,
  });

  // Today's layout: load both control + telemetry. After Commit 2 the second
  // file is removed; update FILES accordingly in that commit.
  const FILES = ['control-logic.js', 'control.js', 'telemetry.js'];
  const minifiedBytes = deployedBytecodeSize(FILES);

  loadShellyScripts(runtime, FILES);

  // 24 h @ 30 s tick = 2880 ticks; we advance in 30-second hops and sample
  // counters after each hop.
  const TICK_MS = 30000;
  const SAMPLES = 24 * 60 * 60 * 1000 / TICK_MS; // 2880
  const proxySamples = [];

  it('runs the 24 h simulation', t => {
    let tick = 0;
    for (; tick < SAMPLES; tick++) {
      // Every 90 ticks (~45 min) push a new device-config (bumps .v) via MQTT.
      if (tick > 0 && tick % 90 === 0) {
        const cfg = JSON.parse(runtime.kvs.config);
        cfg.v = cfg.v + 1;
        runtime.deliverMqtt('greenhouse/config', JSON.stringify(cfg));
      }
      // Every 300 ticks (~2.5 h) fire a 4-command relay storm while manual
      // override is inactive — serialised rejection path.
      if (tick > 0 && tick % 300 === 0) {
        ['pump', 'fan', 'fan', 'pump'].forEach((relay, i) => {
          runtime.deliverMqtt('greenhouse/relay-command', JSON.stringify({ relay, on: i % 2 === 0 }));
        });
      }
      runtime.advance(TICK_MS);

      const state = getScriptStateSnapshot(runtime); // helper below
      proxySamples.push(runtimeProxy({
        state: state.control,
        deviceConfig: JSON.parse(runtime.kvs.config),
        sensorConfig: JSON.parse(runtime.kvs.sensor_config),
        liveTimers: runtime.stats().liveTimers,
        liveCalls: runtime.stats().liveCalls,
        minifiedBytecodeSize: minifiedBytes,
      }));
    }
  });

  it('timer handles stay within cap', () => {
    const s = runtime.stats();
    assert.ok(s.peakTimers <= CAPS.LIVE_TIMERS,
      `peakTimers=${s.peakTimers} > cap ${CAPS.LIVE_TIMERS}`);
  });

  it('in-flight Shelly.call stays within cap', () => {
    const s = runtime.stats();
    assert.ok(s.peakCalls <= CAPS.INFLIGHT_CALLS,
      `peakCalls=${s.peakCalls} > cap ${CAPS.INFLIGHT_CALLS}`);
  });

  it('MQTT subscriptions stay within cap', () => {
    const s = runtime.stats();
    assert.ok(s.peakSubs <= CAPS.MQTT_SUBS,
      `peakSubs=${s.peakSubs} > cap ${CAPS.MQTT_SUBS}`);
  });

  it('no KVS value exceeded 256 B', () => {
    const s = runtime.stats();
    assert.strictEqual(s.kvsTooLarge, null,
      'KVS write rejected: ' + JSON.stringify(s.kvsTooLarge));
  });

  it('runtime proxy peak is under cap (BASELINE PRINT ON FAIL)', () => {
    const peak = Math.max.apply(null, proxySamples);
    if (CAPS.RUNTIME_PROXY_PEAK === 0) {
      console.log(`[BASELINE] runtimeProxy peak over 24 h simulation: ${peak} B`);
      console.log('[BASELINE] Set CAPS.RUNTIME_PROXY_PEAK in tests/shelly/platform-limits.js to', Math.floor(peak * 0.7));
      assert.fail('RUNTIME_PROXY_PEAK cap is unset — rerun with the baseline number above.');
    }
    assert.ok(peak <= CAPS.RUNTIME_PROXY_PEAK,
      `peak=${peak} > cap ${CAPS.RUNTIME_PROXY_PEAK}`);
  });
});

function getScriptStateSnapshot(runtime) {
  // The script does not expose `state` across the `new Function` boundary.
  // We can read it only via its public side-effects. For the proxy, we
  // approximate state bytes by reading the last published MQTT state topic.
  // The runtime mock records publishes via the onPublish option — wire it
  // up if accuracy matters. For the initial failing run, a coarse
  // approximation is enough to trip the cap.
  return { control: {} };
}
```

**Note:** `getScriptStateSnapshot` is a stub. Accurate `state` byte sampling requires capturing `MQTT.publish(STATE_TOPIC, json, ...)` via the `onPublish` option. Wire this up as Step 1.2.2.

- [ ] **Step 1.2.2: Wire `onPublish` → captured state bytes**

In `tests/shelly-platform-limits.test.js`, change the runtime creation to capture publishes:

```js
let lastStateJson = '{}';
const runtime = createInstrumentedRuntime({
  now: () => now,
  setNow: n => { now = n; },
  mqttConnected: true,
  onPublish: (topic, payload) => {
    if (topic === 'greenhouse/state') lastStateJson = payload;
  },
  httpResponder: /* unchanged */,
});
```

And replace `getScriptStateSnapshot`:

```js
function getScriptStateSnapshot(_runtime) {
  try { return { control: JSON.parse(lastStateJson) }; }
  catch (_e) { return { control: {} }; }
}
```

Also add an explicit STATE_BYTES assertion:

```js
it('state object stays under STATE_BYTES cap', () => {
  assert.ok(lastStateJson.length <= CAPS.STATE_BYTES,
    `state snapshot=${lastStateJson.length} B > cap ${CAPS.STATE_BYTES}`);
});
```

- [ ] **Step 1.2.3: Run the test — expect the runtime-proxy assertion to fail with the baseline printout**

Run: `node --test tests/shelly-platform-limits.test.js`
Expected: the "runtime proxy peak is under cap" test fails with a line like:
```
[BASELINE] runtimeProxy peak over 24 h simulation: 42137 B
[BASELINE] Set CAPS.RUNTIME_PROXY_PEAK in tests/shelly/platform-limits.js to 29495
```

Record the printed baseline number.

### Task 1.3 — Commit the baseline cap

- [ ] **Step 1.3.1: Set `CAPS.RUNTIME_PROXY_PEAK = Math.floor(baseline * 0.7)`**

Edit `tests/shelly/platform-limits.js`:
```js
RUNTIME_PROXY_PEAK: <the 0.7×baseline number you recorded>,  // calibrated on main 2026-04-20
```

- [ ] **Step 1.3.2: Run the test again — expect deliberate failure on the new cap**

Run: `node --test tests/shelly-platform-limits.test.js`
Expected: "runtime proxy peak is under cap" fails with `peak=<baseline> > cap <0.7×baseline>`. Other cap tests (timer, call, subs, KVS, state bytes) may pass or fail — record results.

### Task 1.4 — Create CAPS.md

- [ ] **Step 1.4.1: Create `tests/shelly/CAPS.md`**

Content (fill real measured numbers from Step 1.2.3):

```markdown
# Shelly platform-limit caps

Single source of truth for the numbers enforced by `tests/shelly-platform-limits.test.js`.
Updated whenever a commit in the migration sequence moves the peak — see the
spec's Section 3 commit sequence for which commit touches which cap.

| Counter | Cap | Current peak | Notes |
|---|---|---|---|
| Deployed slot-1 source (minified) | ≤ 65 535 B | ≈ <measure> | Shelly Script.PutCode limit, enforced by `tests/deploy.test.js` |
| Runtime proxy peak (Node byte-sum) | ≤ <0.7×baseline> B | <baseline> B | Calibrated 2026-04-20. Currently FAILING by design — will pass after Commit 3. |
| `JSON.stringify(state).length` | ≤ 600 B | <measure> | |
| Live `Timer.set` handles (simultaneous) | ≤ 3 | <measure> | 2-timer reserve against the Shelly 5-handle limit |
| Active MQTT.subscribe topics | ≤ 3 | <measure> | Merge must land on ≤ 3: config, sensor-config, relay-command |
| In-flight `Shelly.call` | ≤ 3 | <measure> | 2-call reserve against the Shelly 5-RPC limit |
| KVS value bytes per key | ≤ 256 | <measure> | Empirical Pro 4PM fw 1.7.5 cap |
```

### Task 1.5 — Commit 1

- [ ] **Step 1.5.1: Stage and commit**

```bash
git add tests/shelly/platform-limits.js tests/shelly/CAPS.md tests/shelly-platform-limits.test.js
git commit -m "$(cat <<'EOF'
shelly: add platform-limit test harness (caps deliberately fail today)

24 h simulation asserting Timer, Shelly.call, MQTT.subscribe, KVS value,
state-bytes, and runtime-proxy caps. Runtime proxy peak currently exceeds
the 0.7×baseline cap by design — subsequent commits in the
Section 2/3 merge bring it under.

See docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md
sections 1 and 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 1.5.2: Verify other tests still pass** (sanity — the new test is expected to fail)

Run: `node --test $(ls tests/*.test.js | grep -v platform-limits)` (or `npm run test:unit` and accept the one expected failure)
Expected: pre-existing tests unchanged.

---

## Commit 2 — Merge telemetry into control (single deployed slot)

**Goal:** Collapse `telemetry.js` into `control.js`. Remove every `Shelly.emitEvent`/`addEventHandler` IPC bridge between the two. Replace `safeSubscribe`/`mqttSubscribed` with the explicit `MQTT.unsubscribe`-before-subscribe boot dance. Update `deploy.sh` to ship one slot. All existing behaviour tests must continue to pass.

**Files:**
- Modify: `shelly/control.js` (absorb telemetry.js; remove event-IPC plumbing)
- Delete: `shelly/telemetry.js`
- Modify: `shelly/deploy.sh:39` (`EXPECTED_SLOT_COUNT`) and `shelly/deploy.sh:183-201` (remove telemetry slot block)
- Modify: `tests/deploy.test.js` (assert single slot)
- Modify: `tests/shelly-stability.test.js` (single-file load; add `MQTT.unsubscribe`)
- Rename: `tests/shelly-telemetry.test.js` → `tests/shelly-control-mqtt.test.js` (and adapt to observe `MQTT.publish` instead of `Shelly.emitEvent`)
- Modify: `tests/shelly-transition.test.js` (replace any `emitEvent("state_updated")` observations with `MQTT.publish` captures, if any)

### Task 2.1 — Failing test: deploy ships a single slot

- [ ] **Step 2.1.1: Write the failing deploy.sh assertion**

In `tests/deploy.test.js`:

Replace the existing "also deploys telemetry script" test at lines 218–225:

```js
  it('does NOT create a second script slot (single merged script)', () => {
    const putCalls = mock.calls.filter(c => {
      if (!c.url.includes('Script.PutCode')) return false;
      const body = JSON.parse(c.body);
      return body.id === 2;
    });
    assert.strictEqual(putCalls.length, 0,
      'No id=2 PutCode should occur after the telemetry merge');
  });

  it('provisions exactly one script slot', () => {
    const createCalls = mock.calls.filter(c => c.url.includes('Script.Create'));
    // After the merge, `ensure_script_slots` resets to 1 slot, so between 0
    // and 1 Create calls are acceptable depending on the prior state.
    assert.ok(createCalls.length <= 1,
      'should create at most one script slot, got ' + createCalls.length);
  });
```

Also update the "reassembles control script" test at lines 161–176 to use the merged source — once telemetry.js is gone, the expected content drops that file:

```js
  it('reassembles control script to the minified concatenated source', () => {
    const logicContent = fs.readFileSync(path.join(SCRIPTS_DIR, 'control-logic.js'), 'utf8');
    const controlContent = fs.readFileSync(path.join(SCRIPTS_DIR, 'control.js'), 'utf8');
    const expected = minify(logicContent) + minify(controlContent);
    // ...unchanged body
  });
```
(This one requires no change — control.js will just grow.)

- [ ] **Step 2.1.2: Run test — expect failure**

Run: `node --test tests/deploy.test.js`
Expected: the new "does NOT create a second script slot" test fails because `shelly/deploy.sh` still uploads to `id=2`.

### Task 2.2 — Make deploy.sh pass: single slot

- [ ] **Step 2.2.1: Edit `shelly/deploy.sh`**

Change line 39:
```bash
EXPECTED_SLOT_COUNT=1  # slot 1: merged control+telemetry
```

Delete lines 107 (`TELEMETRY_SCRIPT_ID=2`) and the entire block lines 183–201 (the `if [ -f "$TELEMETRY_JS" ]; then ... fi` telemetry upload block). Also delete the `TELEMETRY_JS="$SCRIPT_DIR/telemetry.js"` assignment at line 11 — unused after the merge.

- [ ] **Step 2.2.2: Run deploy.test.js — expect pass**

Run: `node --test tests/deploy.test.js`
Expected: all deploy tests pass, including the new assertions.

### Task 2.3 — Failing test: merged control has exactly 3 MQTT subscriptions and no `Shelly.emitEvent` for IPC

- [ ] **Step 2.3.1: Update `tests/shelly-stability.test.js` — add `MQTT.unsubscribe` to the mock**

In the `createShellyRuntime` mock (around `tests/shelly-stability.test.js:104`), add to the `mqtt` object:
```js
    unsubscribe: function(topic) {
      mqttSubscriptions = mqttSubscriptions.filter(function(s) { return s.topic !== topic; });
    },
```

Also relax the "Invalid topic throws" behaviour now that the new boot dance unsubscribes first — change the `subscribe` handler so that *duplicate* subscribe still throws (preserving the existing defence-in-depth assertion from the connectHandler crash test), but add this assertion:

In the `describe('Shelly control script stability', ...)` block, replace the file list from `['control-logic.js', 'control.js']` to `['control-logic.js', 'control.js']` (unchanged) but expand assertions:

```js
  it('subscribes to exactly 3 MQTT topics (config, sensor-config, relay-command)', function() {
    var rt = createShellyRuntime({ mqttConnected: true });
    loadScript(rt, ['control-logic.js', 'control.js']);
    var stats = rt.stats();
    var topics = stats.mqttTopics.sort();
    assert.deepStrictEqual(topics,
      ['greenhouse/config', 'greenhouse/relay-command', 'greenhouse/sensor-config'],
      'Unexpected topics: ' + topics.join(', '));
  });

  it('uses MQTT.publish for state snapshots (no Shelly.emitEvent IPC bridge)', function(t, done) {
    var rt = createShellyRuntime({ mqttConnected: true });
    var publishes = [];
    var realPublish = rt.globals.MQTT.publish;
    rt.globals.MQTT.publish = function(topic, payload, qos, retain) {
      publishes.push({ topic: topic, payload: payload });
      realPublish.apply(null, arguments);
    };
    loadScript(rt, ['control-logic.js', 'control.js']);
    setTimeout(function() {
      var stateTopics = publishes.filter(function(p) { return p.topic === 'greenhouse/state'; });
      assert.ok(stateTopics.length >= 1,
        'control script must publish greenhouse/state directly via MQTT.publish — observed: ' +
        publishes.map(function(p) { return p.topic; }).join(', '));
      done();
    }, 50);
  });

  it('survives connectHandler firing after boot already subscribed (orphan-fix via MQTT.unsubscribe)', function() {
    // Ports the 2026-04-09/10 "Invalid topic" crash assertion from the
    // deleted tests/shelly-stability.test.js telemetry block. After the
    // merge, the boot dance calls MQTT.unsubscribe on each topic before
    // subscribing, so a connectHandler re-invocation on the same session
    // must NOT crash.
    var rt = createShellyRuntime({ mqttConnected: true });
    assert.doesNotThrow(function() {
      loadScript(rt, ['control-logic.js', 'control.js']);
      rt.triggerMqttConnect();
      rt.triggerMqttConnect();
    }, 'merged control script must not crash on duplicate connectHandler invocations');
    var stats = rt.stats();
    // After two extra connectHandler runs, subscription count must still
    // be exactly 3 (unsubscribe-first keeps us at steady state).
    var uniq = {};
    stats.mqttTopics.forEach(function(t) { uniq[t] = true; });
    assert.strictEqual(Object.keys(uniq).length, 3,
      'expected 3 unique subscriptions after repeated connectHandler, got: ' + stats.mqttTopics.join(', '));
  });
```

- [ ] **Step 2.3.2: Delete the telemetry-only stability describe block**

Remove the entire `describe('Shelly telemetry script stability', ...)` block at `tests/shelly-stability.test.js:279-346`. Its assertions will be reborn inside `tests/shelly-control-mqtt.test.js` in Task 2.6.

- [ ] **Step 2.3.3: Run — expect failure**

Run: `node --test tests/shelly-stability.test.js`
Expected: the new "subscribes to exactly 3 MQTT topics" and "uses MQTT.publish for state snapshots" tests fail — today's `control.js` subscribes to 0 topics (telemetry.js owns them), and state is emitted via `Shelly.emitEvent`, not published directly.

### Task 2.4 — Perform the merge

- [ ] **Step 2.4.1: Add MQTT topic and version constants to the top of `shelly/control.js`**

After `SHELL_CFG` (around line 14), insert:

```js
// ── MQTT topics (previously in telemetry.js) ──
var CONFIG_TOPIC = "greenhouse/config";
var SENSOR_CONFIG_TOPIC = "greenhouse/sensor-config";
var RELAY_COMMAND_TOPIC = "greenhouse/relay-command";
var STATE_TOPIC = "greenhouse/state";
var WATCHDOG_EVENT_TOPIC = "greenhouse/watchdog/event";
var CONFIG_KVS_KEY = "config";
var SENSOR_CONFIG_KVS_KEY = "sensor_config";
```

Note: `deviceConfig.v` already holds the config version (see the existing declaration at line 38). The `currentVersion` / `currentSensorVersion` variables from telemetry.js are deleted — we compare directly against `deviceConfig.v` and `sensorConfig.v`.

- [ ] **Step 2.4.2: Replace `emitStateUpdate` with a direct MQTT publish**

Replace the function body at `shelly/control.js:323-325`:

```js
function emitStateUpdate() {
  if (!MQTT.isConnected()) return;
  MQTT.publish(STATE_TOPIC, JSON.stringify(buildStateSnapshot()), 1, true);
}
```

(Function name stays — every call site inside `control.js` continues to work.)

- [ ] **Step 2.4.3: Replace `publishWatchdogEvent` with a direct MQTT publish**

Replace at `shelly/control.js:356-358`:

```js
function publishWatchdogEvent(payload) {
  if (!MQTT.isConnected()) return;
  MQTT.publish(WATCHDOG_EVENT_TOPIC, JSON.stringify(payload), 1, false);
}
```

- [ ] **Step 2.4.4: Remove the `Shelly.addEventHandler` IPC bridge**

Delete the entire handler block at `shelly/control.js:1014-1041` (the `Shelly.addEventHandler(function(ev) { if (ev.info.event === "config_changed") ... })` block). Its three branches will become direct calls from the MQTT subscribe callbacks in Step 2.4.6.

- [ ] **Step 2.4.5: Add the config-apply helpers (absorbed from telemetry.js)**

After the deleted handler block (i.e. after line 1041), insert:

```js
// ── Config apply (absorbed from former telemetry.js) ──

function isSafetyCritical(oldCfg, newCfg) {
  if (!oldCfg) return true;
  if (oldCfg.ce !== newCfg.ce) return true;
  if (oldCfg.ea !== newCfg.ea) return true;
  if (oldCfg.fm !== newCfg.fm) return true;
  if (JSON.stringify(oldCfg.wb) !== JSON.stringify(newCfg.wb)) return true;
  // we/wz changes are not safety-critical; next POLL_INTERVAL tick
  // picks them up via evaluate(). Still compared here so
  // tests/shelly-control-mqtt.test.js catches schema drift.
  if (JSON.stringify(oldCfg.we) !== JSON.stringify(newCfg.we)) return false;
  if (JSON.stringify(oldCfg.wz) !== JSON.stringify(newCfg.wz)) return false;
  return false;
}

function applyConfig(newCfg) {
  if (newCfg.v === deviceConfig.v) return;
  var prev = deviceConfig;
  var critical = isSafetyCritical(prev, newCfg);
  deviceConfig = newCfg;
  Shelly.call("KVS.Set", { key: CONFIG_KVS_KEY, value: JSON.stringify(newCfg) });
  handleConfigDrivenResolution(prev, newCfg);
  if (critical) controlLoop();
}

function applySensorConfig(newCfg) {
  if (sensorConfig && newCfg.v === sensorConfig.v) return;
  sensorConfig = newCfg;
  Shelly.call("KVS.Set", { key: SENSOR_CONFIG_KVS_KEY, value: JSON.stringify(newCfg) });
}
```

- [ ] **Step 2.4.6: Add MQTT setup with the unsubscribe-first boot dance**

After the helpers above, insert:

```js
// ── MQTT setup (absorbed from former telemetry.js) ──

function setupMqttSubscriptions() {
  if (!MQTT.isConnected()) return;

  // Subscribe-orphan fix: after Script.Stop/Start (but not Shelly.Reboot)
  // the device retains topic subscriptions while the JS callback is
  // garbage-collected. Calling MQTT.subscribe on a still-registered topic
  // then throws "Invalid topic". Explicitly unsubscribe first — wrapped
  // in try/catch for the first-boot case where there is nothing to
  // unsubscribe. See 2026-04-20 investigation notes in the spec.
  var topics = [CONFIG_TOPIC, SENSOR_CONFIG_TOPIC, RELAY_COMMAND_TOPIC];
  for (var i = 0; i < topics.length; i++) {
    try { MQTT.unsubscribe(topics[i]); } catch (e) {}
  }

  MQTT.subscribe(CONFIG_TOPIC, function(topic, message) {
    try {
      var newCfg = JSON.parse(message);
      if (newCfg.v && newCfg.v !== deviceConfig.v) applyConfig(newCfg);
    } catch (e) {}
  });
  MQTT.subscribe(SENSOR_CONFIG_TOPIC, function(topic, message) {
    try {
      var newCfg = JSON.parse(message);
      if (newCfg.v && (!sensorConfig || newCfg.v !== sensorConfig.v)) applySensorConfig(newCfg);
    } catch (e) {}
  });
  MQTT.subscribe(RELAY_COMMAND_TOPIC, function(topic, message) {
    try {
      var cmd = JSON.parse(message);
      if (cmd && typeof cmd.relay === "string" && typeof cmd.on === "boolean") {
        handleRelayCommand(cmd.relay, cmd.on);
      }
    } catch (e) {}
  });
}

MQTT.setConnectHandler(function() { setupMqttSubscriptions(); });
```

- [ ] **Step 2.4.7: Add HTTP config bootstrap (absorbed from telemetry.js)**

After MQTT setup, insert:

```js
function bootstrapConfig() {
  Shelly.call("KVS.Get", { key: "config_url" }, function(res) {
    var url = (res && res.value) ? res.value : "";
    if (!url) return;
    Shelly.call("HTTP.GET", { url: url, timeout: 10 }, function(httpRes, err) {
      if (err || !httpRes || httpRes.code !== 200 || !httpRes.body) return;
      try {
        var cfg = JSON.parse(httpRes.body);
        if (cfg.v && cfg.v !== deviceConfig.v) applyConfig(cfg);
      } catch (e) {}
    });
  });
}
```

- [ ] **Step 2.4.8: Replace `loadConfig`/`loadSensorConfig` with a single `loadPersistedState`**

Replace the boot sequence inside `bootCloseValves` at `shelly/control.js:1057-1090`. Change the nested KVS.Get chain to read both keys via one helper, then call the new bootstrap:

```js
function loadPersistedState(cb) {
  Shelly.call("KVS.Get", { key: CONFIG_KVS_KEY }, function(cfgRes) {
    if (cfgRes && cfgRes.value) {
      try { deviceConfig = JSON.parse(cfgRes.value); } catch (e) {}
    }
    Shelly.call("KVS.Get", { key: SENSOR_CONFIG_KVS_KEY }, function(scRes) {
      if (scRes && scRes.value) {
        try { sensorConfig = JSON.parse(scRes.value); } catch (e) {}
      }
      Shelly.call("KVS.Get", { key: "drained" }, function(dRes) {
        if (dRes && dRes.value === "1") state.collectors_drained = true;
        if (cb) cb();
      });
    });
  });
}

function bootCloseValves() {
  closeAllValves(function(ok) {
    if (!ok) {
      Timer.set(5000, false, function() { bootCloseValves(); });
      return;
    }
    Timer.set(5000, false, function() {
      loadPersistedState(function() {
        pollAllSensors(function() {
          state.mode_start = Date.now();
          captureWatchdogBaseline();
          Timer.set(SHELL_CFG.POLL_INTERVAL, true, controlLoop);
          controlLoop();
          bootstrapConfig();
          if (MQTT.isConnected()) setupMqttSubscriptions();
        });
      });
    });
  });
}
```

- [ ] **Step 2.4.9: Delete `shelly/telemetry.js`**

```bash
git rm shelly/telemetry.js
```

- [ ] **Step 2.4.10: Run stability test — expect pass on the new merge assertions**

Run: `node --test tests/shelly-stability.test.js`
Expected: "subscribes to exactly 3 MQTT topics" passes; "uses MQTT.publish for state snapshots" passes; existing `control script` assertions still pass.

### Task 2.5 — Rename and adapt `tests/shelly-telemetry.test.js`

- [ ] **Step 2.5.1: Rename the file**

```bash
git mv tests/shelly-telemetry.test.js tests/shelly-control-mqtt.test.js
```

- [ ] **Step 2.5.2: Rewrite the test to load control.js and observe MQTT publish/subscribe side-effects**

Open `tests/shelly-control-mqtt.test.js`. Replace the TELEMETRY_PATH constant at line 18 and the `loadTelemetry` helper at `tests/shelly-control-mqtt.test.js:93-100`:

```js
const SCRIPTS = [
  path.join(__dirname, '..', 'shelly', 'control-logic.js'),
  path.join(__dirname, '..', 'shelly', 'control.js'),
];

function loadControl() {
  const src = SCRIPTS.map(p => fs.readFileSync(p, 'utf8')).join('\n');
  const fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print', '__TEST_HARNESS',
    src
  );
  fn(globals.Shelly, globals.Timer, globals.MQTT, globals.JSON, globals.Date, globals.Math,
     globals.parseInt, globals.print, false);
}
```

(Rename the one call site `loadTelemetry()` → `loadControl()`.)

Update the runtime mock to add `MQTT.unsubscribe`:
```js
const mqtt = {
  subscribe: function (topic, cb) { mqttSubscriptions.push({ topic, cb }); },
  unsubscribe: function (topic) {
    for (let i = mqttSubscriptions.length - 1; i >= 0; i--) {
      if (mqttSubscriptions[i].topic === topic) mqttSubscriptions.splice(i, 1);
    }
  },
  publish: function (topic, payload) { publishes.push({ topic, payload }); },
  isConnected: function () { return mqttConnected; },
  setConnectHandler: function (cb) { mqttConnectHandler = cb; },
};
```

Also add a `publishes` array captured inside the closure and expose `getPublishes` in the `return { ... }` block of `createTelemetryRuntime` (rename that helper `createRuntime`).

Change all existing tests that asserted `Shelly.emitEvent` observations — the schema-drift test in particular (look for `emitEvent` / `addEventHandler` within `describe` blocks). Rewrite them to observe:
- `MQTT.publish(STATE_TOPIC, ...)` for state updates.
- The `applyConfig` side effect on `deviceConfig` (no direct emit anymore).

- [ ] **Step 2.5.3: Run the renamed file — expect pass**

Run: `node --test tests/shelly-control-mqtt.test.js`
Expected: all tests pass. Any assertion that still references `Shelly.emitEvent` is a leftover — rewrite it.

### Task 2.6 — Update `tests/shelly-transition.test.js`

- [ ] **Step 2.6.1: Audit for `emitEvent` observation points**

Run: `grep -n 'emitEvent\|state_updated' tests/shelly-transition.test.js`
For each hit, replace the observation with MQTT publish capture. The existing `events` array already records `switch_set` and `http_get`; add `mqtt_publish` too. Update the mock's `MQTT.publish` (around `tests/shelly-transition.test.js:107`):

```js
MQTT: {
  subscribe: function() {},
  unsubscribe: function() {},
  publish: function(topic, payload, qos, retain) {
    events.push({ t: now, kind: 'mqtt_publish', detail: { topic: topic, payload: payload, qos: qos, retain: retain } });
  },
  isConnected: function() { return true; },  // flip to true so publishes fire
  setConnectHandler: function() {},
},
```

- [ ] **Step 2.6.2: Run — expect pass**

Run: `node --test tests/shelly-transition.test.js`
Expected: transition ordering tests still pass.

### Task 2.7 — Run the full unit suite

- [ ] **Step 2.7.1: Run**

Run: `npm run test:unit`
Expected: every test in the suite except `tests/shelly-platform-limits.test.js` passes. The platform-limits test's runtime-proxy assertion may still fail — that is acceptable for this commit (spec Section 3, step 2: "Platform-limits test may still fail — acceptable at this step").

- [ ] **Step 2.7.2: Run the Shelly lint against the merged file**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js --config system.yaml`
Expected: no errors (warnings on template-literal/destructuring/etc. are fine as long as they were there before).

### Task 2.8 — Commit 2

- [ ] **Step 2.8.1: Stage and commit**

```bash
git add shelly/control.js shelly/deploy.sh shelly/telemetry.js tests/deploy.test.js tests/shelly-stability.test.js tests/shelly-control-mqtt.test.js tests/shelly-transition.test.js
git commit -m "$(cat <<'EOF'
shelly: merge telemetry into control (single deployed slot)

Collapse Shelly.emitEvent/addEventHandler IPC bridge between control.js and
telemetry.js into direct function calls and inline MQTT.publish. Deduplicate
config-version bookkeeping to deviceConfig.v / sensorConfig.v. Replace the
mqttSubscribed guard + safeSubscribe try/catch with an explicit
MQTT.unsubscribe-then-subscribe boot dance (subscribe-orphan fix). deploy.sh
ships one slot; ensure_script_slots auto-wipes the old slot-2.

Existing behaviour tests pass. Platform-limits runtime-proxy cap still
fails pending Commit 3.

See docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md
Section 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 3 — Collapse valve bookkeeping + dedupe constants

**Goal:** Squeeze the runtime-proxy under `0.7 × baseline`. Target the four valve-keyed maps on `state` (biggest single in-RAM allocation in `state`) and remove helpers reduced to single call sites by the merge.

**Files:**
- Modify: `shelly/control.js`

### Task 3.1 — Run the failing proxy test to capture the current number

- [ ] **Step 3.1.1: Re-run the failing test**

Run: `node --test tests/shelly-platform-limits.test.js 2>&1 | grep -E 'peak=|BASELINE'`
Expected: the "runtime proxy peak is under cap" line prints the current post-merge peak (lower than the pre-merge baseline, but still likely above `0.7 × baseline`).

Record the number.

### Task 3.2 — Collapse the four valve-keyed maps

- [ ] **Step 3.2.1: Replace the four maps with one struct-valued map**

At `shelly/control.js:80-87`, `state` currently holds:
```js
valveOpenSince: {}, valveOpening: {}, valvePendingOpen: [], valvePendingClose: [],
```

Replace with a single map and two arrays:
```js
// Per-valve tracking: {openSince, openingUntil} per valve. Pending
// queues remain separate — `for (v in valves)` iteration over a
// struct-valued map is not on any hot path.
valves: {},          // name → { openSince, openingUntil }
valvePending: { open: [], close: [] },
```

Propagate the rename through every reader/writer:
- `seedValveOpenSinceOnBoot` (around line 222): populates `state.valves[name] = { openSince: 0, openingUntil: 0 }`; `state.valvePending = { open: [], close: [] }`.
- `scheduleStep` (around line 581): `state.valveOpening[ov] = ...` → `state.valves[ov].openingUntil = ...`; `state.valveOpenSince[cv] = 0` → `state.valves[cv].openSince = 0`.
- `resumeTransition` (around line 678): iterate `for (var v in state.valves) { if (state.valves[v].openingUntil > 0 && state.valves[v].openingUntil <= now) ... }`.
- `currentSchedulerView` (around line 572): unchanged (still reads `state.valve_states`).
- `finalizeTransitionOK` / `finalizeTransitionFail` (around line 531, 555): reset `state.valvePending = { open: [], close: [] }`.
- `planValveTransition` callers: update the two arguments (pass `state.valves` twice, once for openSince, once for openingUntil — or add a thin adapter that splits the struct back into two maps before calling the pure scheduler in control-logic.js).

Prefer the adapter: **don't** modify `control-logic.js` (keep it pure-frozen per the spec's non-goals). Instead add locally:

```js
function valveOpenSinceView() {
  var out = {};
  for (var v in state.valves) out[v] = state.valves[v].openSince;
  return out;
}
function valveOpeningView() {
  var out = {};
  for (var v in state.valves) out[v] = state.valves[v].openingUntil;
  return out;
}
```

Pass `valveOpenSinceView()` and `valveOpeningView()` into `planValveTransition`.

- [ ] **Step 3.2.2: Run transition + stability tests**

Run: `node --test tests/shelly-transition.test.js tests/shelly-stability.test.js`
Expected: all tests pass — transitions still honour the min-open hold, max-concurrent opens, and bounded pool.

### Task 3.3 — Inline single-call-site helpers

- [ ] **Step 3.3.1: Inline `emitStateUpdate`**

Every caller of `emitStateUpdate()` becomes:
```js
if (MQTT.isConnected()) MQTT.publish(STATE_TOPIC, JSON.stringify(buildStateSnapshot()), 1, true);
```

Delete the helper definition.

- [ ] **Step 3.3.2: Inline `publishWatchdogEvent`**

Two call sites (watchdog fire + resolved). Inline at each:
```js
if (MQTT.isConnected()) MQTT.publish(WATCHDOG_EVENT_TOPIC, JSON.stringify(payload), 1, false);
```
Delete the helper.

- [ ] **Step 3.3.3: Inline `buildStateSnapshot`**

One caller (now the inlined publish above). Replace the body inline:
```js
MQTT.publish(STATE_TOPIC, JSON.stringify(buildSnapshotFromState(state, deviceConfig, Date.now())), 1, true);
```
Delete the wrapper.

- [ ] **Step 3.3.4: Run the full test suite**

Run: `npm run test:unit`
Expected: all tests pass. The platform-limits runtime-proxy test should now be under the `0.7 × baseline` cap — if not, identify the next biggest contributor (look at `lastStateJson` length, and the largest `state.*` members) and trim before continuing.

If the cap is still exceeded, add a diagnostic:
```js
console.log('state keys by size:', Object.keys(lastState).map(k => [k, JSON.stringify(lastState[k]).length]).sort((a,b) => b[1]-a[1]));
```
and iterate.

### Task 3.4 — Commit 3

- [ ] **Step 3.4.1: Stage and commit**

```bash
git add shelly/control.js
git commit -m "$(cat <<'EOF'
shelly: collapse valve bookkeeping + dedupe constants

Merge state.valveOpenSince + state.valveOpening + state.valvePendingOpen +
state.valvePendingClose into state.valves (struct per name) +
state.valvePending. Inline emitStateUpdate / publishWatchdogEvent /
buildStateSnapshot — all reduced to single call sites by Commit 2.

Runtime-proxy peak now under the 0.7× baseline cap set in Commit 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 4 — Calibrate caps to new baseline

**Goal:** Lock in the achieved number with a small 512 B margin. Future regressions that add ≥ 512 B trip the test.

**Files:**
- Modify: `tests/shelly/platform-limits.js`
- Modify: `tests/shelly/CAPS.md`

### Task 4.1 — Measure achieved peak

- [ ] **Step 4.1.1: Read the current peak**

Run: `node --test tests/shelly-platform-limits.test.js 2>&1 | grep peak`
Expected: prints something like `peak=19842 <= cap 29495`. Record the `peak` value.

### Task 4.2 — Update the cap

- [ ] **Step 4.2.1: Edit `tests/shelly/platform-limits.js`**

Change:
```js
RUNTIME_PROXY_PEAK: 29495,  // calibrated on main 2026-04-20 (0.7×baseline)
```
to:
```js
RUNTIME_PROXY_PEAK: <peak> + 512,  // calibrated post-merge 2026-04-20 (achieved + 512 B margin)
```

- [ ] **Step 4.2.2: Update `tests/shelly/CAPS.md`**

Change the "Runtime proxy peak" row's "Cap" column to the new number and "Current peak" to the measured value.

- [ ] **Step 4.2.3: Run — expect pass with near-zero slack**

Run: `node --test tests/shelly-platform-limits.test.js`
Expected: all caps green.

### Task 4.3 — Commit 4

- [ ] **Step 4.3.1: Stage and commit**

```bash
git add tests/shelly/platform-limits.js tests/shelly/CAPS.md
git commit -m "$(cat <<'EOF'
shelly: calibrate platform-limit caps to new baseline

Runtime-proxy peak now measured post-merge + post-valve-collapse. Cap is
measured_peak + 512 B — future regression of ≥ 512 B trips the test.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Commit 5 — Lint: static rules for callback-leak patterns

**Goal:** Belt-and-suspenders. Acorn AST check at CI time for the specific class of bug where `Timer.set`/`MQTT.subscribe`/`Shelly.call` is called inside an unbounded loop or inside a callback without a matching cleanup in every exit path.

**Files:**
- Modify: `shelly/lint/rules/index.js`
- Create (if absent): `shelly/lint/rules.test.js`

### Task 5.1 — Write failing lint rule tests

- [ ] **Step 5.1.1: Check whether a rules test file exists**

Run: `ls shelly/lint/`
Expected: directory listing shows `rules/` but no `rules.test.js`. If one exists, extend it; otherwise create.

- [ ] **Step 5.1.2: Create `shelly/lint/rules.test.js`**

```js
// Unit tests for Shelly lint rules. Node.js built-in test runner.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as acorn from 'acorn';
import { lintScript } from './rules/index.js';

function lintIds(source) {
  return lintScript(source, { acorn }).map(f => f.rule);
}

describe('SH-LEAK-TIMER: Timer.set inside unbounded loop', () => {
  it('flags Timer.set inside for-loop', () => {
    const src = 'for (var i = 0; i < n; i++) { Timer.set(1000, false, function() {}); }';
    assert.ok(lintIds(src).includes('SH-LEAK-TIMER'));
  });

  it('flags Timer.set inside while-loop', () => {
    const src = 'while (cond) { Timer.set(1000, false, function() {}); }';
    assert.ok(lintIds(src).includes('SH-LEAK-TIMER'));
  });

  it('does NOT flag Timer.set outside a loop', () => {
    const src = 'Timer.set(1000, false, function() {});';
    assert.ok(!lintIds(src).includes('SH-LEAK-TIMER'));
  });

  it('does NOT flag Timer.set with matching Timer.clear in all exit paths', () => {
    const src = `
      var id = Timer.set(1000, false, function() {});
      function cleanup() { Timer.clear(id); }
    `;
    assert.ok(!lintIds(src).includes('SH-LEAK-TIMER'));
  });
});

describe('SH-LEAK-SUB: MQTT.subscribe inside unbounded loop', () => {
  it('flags MQTT.subscribe inside a loop', () => {
    const src = 'for (var i = 0; i < topics.length; i++) { MQTT.subscribe(topics[i], cb); }';
    assert.ok(lintIds(src).includes('SH-LEAK-SUB'));
  });
});

describe('SH-LEAK-RPC: Shelly.call inside unbounded loop', () => {
  it('flags Shelly.call inside a loop', () => {
    const src = 'while (cond) { Shelly.call("Switch.Set", { id: 0, on: true }); }';
    assert.ok(lintIds(src).includes('SH-LEAK-RPC'));
  });

  it('does NOT flag Shelly.call inside a bounded recursion helper (for..next pattern)', () => {
    // The setActuators / setValves pattern in control.js: recursion via `next()`
    // instead of a loop. Must not be flagged.
    const src = `
      function next(i) { if (i >= arr.length) return; Shelly.call("Switch.Set", { id: i, on: true }, function() { next(i + 1); }); }
      next(0);
    `;
    assert.ok(!lintIds(src).includes('SH-LEAK-RPC'));
  });
});
```

- [ ] **Step 5.1.3: Run — expect all failures**

Run: `node --test shelly/lint/rules.test.js`
Expected: every SH-LEAK-TIMER / SH-LEAK-SUB / SH-LEAK-RPC assertion fails — the rules don't exist yet.

### Task 5.2 — Implement the rules

- [ ] **Step 5.2.1: Edit `shelly/lint/rules/index.js`**

Extend `walkNode` to track loop ancestry (depth-first, maintain a stack of `ForStatement`/`WhileStatement`/`DoWhileStatement`/`ForInStatement`/`ForOfStatement` ancestors). On a `CallExpression` matching `Timer.set`/`MQTT.subscribe`/`Shelly.call`, if the loop stack is non-empty, emit the corresponding finding.

Replace the `walkNode` signature and call site with a variant that passes parent chain:

```js
function walkNodeWithParents(node, visitor, parents) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visitor(node, parents);
  const nextParents = node.type ? parents.concat([node]) : parents;
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkNodeWithParents(item, visitor, nextParents);
    } else if (child && typeof child === 'object' && child.type) {
      walkNodeWithParents(child, visitor, nextParents);
    }
  }
}
```

Add inside `lintScript`, alongside the existing `walkNode`:

```js
const LOOP_TYPES = new Set(['ForStatement', 'WhileStatement', 'DoWhileStatement', 'ForInStatement', 'ForOfStatement']);

walkNodeWithParents(ast, (node, parents) => {
  if (node.type !== 'CallExpression') return;
  const name = callExprName(node);
  if (!name) return;
  const inLoop = parents.some(p => LOOP_TYPES.has(p.type));
  if (!inLoop) return;
  if (name === 'Timer.set') {
    findings.push({ rule: 'SH-LEAK-TIMER', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0,
      message: 'Timer.set inside a loop — a forgotten Timer.clear here crashes the script with a 5-handle overflow' });
  } else if (name === 'MQTT.subscribe') {
    findings.push({ rule: 'SH-LEAK-SUB', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0,
      message: 'MQTT.subscribe inside a loop — duplicate topic throws "Invalid topic" on the second iteration' });
  } else if (name === 'Shelly.call') {
    findings.push({ rule: 'SH-LEAK-RPC', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0,
      message: 'Shelly.call inside a loop — concurrent calls can exceed the 5-RPC budget' });
  }
}, []);
```

- [ ] **Step 5.2.2: Run the new tests — expect pass**

Run: `node --test shelly/lint/rules.test.js`
Expected: all `SH-LEAK-*` tests green.

- [ ] **Step 5.2.3: Run the linter against the merged control.js**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js --config system.yaml`
Expected: no new SH-LEAK-* findings. (The `setActuators`/`setValves` pattern uses recursion, not loops — the `processRelayCmdQueue` uses an index-pointer Timer.set inside the `done` callback, not inside a loop.)

If the linter reports a finding in `control.js` or `control-logic.js`, audit the reported line:
- Real bug: fix the code first, keep the lint rule.
- False positive: tighten the rule (e.g. require the loop bound to be non-constant), do not silence with an ignore comment.

### Task 5.3 — Commit 5

- [ ] **Step 5.3.1: Stage and commit**

```bash
git add shelly/lint/rules/index.js shelly/lint/rules.test.js
git commit -m "$(cat <<'EOF'
shelly/lint: add static rules for unbounded Timer/RPC/subscribe in callbacks

SH-LEAK-TIMER / SH-LEAK-SUB / SH-LEAK-RPC flag Timer.set, MQTT.subscribe,
and Shelly.call inside ForStatement/WhileStatement/etc. loops — the class
of bug that caused the 2026-04-09 and 2026-04-20 crashes. Recursion via
callback chaining (setActuators, setValves) is not flagged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Pre-merge verification

- [ ] **Step V.1: Run the full unit suite**

Run: `npm run test:unit`
Expected: every test passes, including `tests/shelly-platform-limits.test.js`.

- [ ] **Step V.2: Run the e2e suite**

Run: `npm run test:e2e`
Expected: pass. (The playground simulator loads `control-logic.js` only; merge should not affect it. But the e2e tests may invoke server → MQTT → device-config paths — sanity check.)

- [ ] **Step V.3: Run the Shelly lint**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js --config system.yaml --format terminal`
Expected: zero errors.

- [ ] **Step V.4: Sanity-check the merged minified size**

Run: `python3 -c "print(len(open('shelly/control.js').read()) + len(open('shelly/control-logic.js').read()))"` (rough upper bound)
Then run: `python3 <<'PY'` with the same `minify()` as `shelly/deploy.sh`:
```python
def minify(src):
    out = []
    for line in src.split('\n'):
        s = line.lstrip()
        if not s or s.startswith('//'): continue
        out.append(s)
    return '\n'.join(out) + '\n'
a = open('shelly/control-logic.js').read()
b = open('shelly/control.js').read()
print('minified:', len(minify(a) + minify(b)))
PY
```
Expected: well under 65 535 B (the Shelly PutCode limit, already enforced by `tests/deploy.test.js`).

- [ ] **Step V.5: Open the PR**

```bash
gh pr create --base main --title "Shelly: platform-limit harness + single-script merge" --body "$(cat <<'EOF'
## Summary
- New 24 h Node simulation (tests/shelly-platform-limits.test.js) asserts Timer, MQTT, RPC, KVS, state-bytes, and runtime-proxy caps.
- control.js absorbs telemetry.js — Shelly.emitEvent/addEventHandler IPC bridge removed, MQTT subscribe/publish moved inline. Deploy ships one Script slot (EXPECTED_SLOT_COUNT=1).
- Runtime-proxy peak dropped ≥ 30 % from the pre-merge baseline; calibrated cap locks in the achieved number + 512 B margin.
- New Shelly lint rules (SH-LEAK-TIMER/SUB/RPC) flag Timer.set / MQTT.subscribe / Shelly.call inside loops.

Spec: docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md

## Test plan
- [ ] `npm run test:unit` — all green
- [ ] `npm run test:e2e` — all green
- [ ] `node shelly/lint/bin/shelly-lint.js shelly/control.js --config system.yaml` — zero errors
- [ ] Post-merge: `curl -s http://192.168.30.50/rpc/Script.GetStatus?id=1 | jq '{mem_used, mem_peak, mem_free, errors}'` — mem_peak ≤ 16 000, mem_free ≥ 9 000
EOF
)"
```

---

## Post-merge: on-device verification

**Not a commit — a manual verification against the live Pro 4PM after CD completes.**

- [ ] **Step P.1: Wait for CD**

Watch the GitHub Actions run triggered by the merge. Expected: `shelly/deploy.sh` runs inside the CD job and uploads the new single slot to `192.168.30.50`.

- [ ] **Step P.2: Read `Script.GetStatus` from the live device**

Run (over VPN):
```bash
curl -s "http://192.168.30.50/rpc/Script.GetStatus?id=1" | python3 -m json.tool
```
Record `mem_used`, `mem_peak`, `mem_free`, `errors`.

Target: `mem_peak ≤ 16 000` and `mem_free ≥ 9 000` (success criterion 2 in the spec).

- [ ] **Step P.3: Observe for ≥ 24 h**

Check `errors` stays empty and `mem_peak` stays below 16 000 for at least one full day with at least one mode transition.

- [ ] **Step P.4: If `mem_peak ≥ 22 000`**

The proxy-based refactor did not translate to on-device gains. Open a follow-up issue. Options from the spec:
- Revisit Section 2 for more aggressive trims.
- Escalate to Section 4 (rewrite from scratch — explicitly deferred).

- [ ] **Step P.5: Seven-day silent-crash watch**

At day 7 post-deploy, re-read `Script.GetStatus` and confirm `errors == []`. This fulfils success criterion 4.

---

## Done criteria

- [ ] `tests/shelly-platform-limits.test.js` passes.
- [ ] All pre-existing unit tests pass (`shelly-transition`, `shelly-control-mqtt` (née shelly-telemetry), `shelly-stability`, `control-logic`, `sensor-config`, `device-config-integration`, `mqtt-bridge`, `deploy`).
- [ ] `shelly/control.js` + `shelly/control-logic.js` pass `shelly-lint` with zero errors.
- [ ] `shelly/telemetry.js` is deleted.
- [ ] `shelly/deploy.sh` ships one script slot.
- [ ] Live Pro 4PM `mem_peak ≤ 16 000` and no silent-crash incidents over 7 days post-deploy.
