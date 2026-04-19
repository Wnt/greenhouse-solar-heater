# Forced mode folded into manual override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Forced-mode selector out of the device-config card and into the Manual Override card so it is gated by the override TTL, skips the 5-minute minimum-mode-duration hold, and forces an IDLE staged transition on every override exit path.

**Architecture:** Move `fm` from a top-level device-config field into `mo.fm`. The device-side config event handler watches `mo.fm` transitions and drives `transitionTo(MODE_VALVES[mo.fm], MODE_ACTUATORS[mo.fm])` directly — bypassing `evaluate()` entirely (which is already skipped whenever `mo.a === true`). Override exit (user, TTL, safety) runs a staged `transitionTo(IDLE)`. The new valves-first drain-exit sequence that landed on main is reused automatically via `state.transitionFromMode`.

**Tech Stack:** ES5 Shelly Espruino runtime, Node.js test harness (`node:test`), Playwright e2e fixtures that block Google Fonts, vanilla-JS playground SPA, PostgreSQL/TimescaleDB optional.

**Design doc:** `docs/superpowers/specs/2026-04-20-forced-mode-in-override-design.md`

---

## File Map

### Modified

- `server/lib/device-config.js` — drop `fm` from `DEFAULT_CONFIG`, strip legacy `fm` on load, extend `mo` validation to accept optional `fm`, reject `mo.fm` when `mo.a === false`.
- `server/server.js` — add `override-set-mode` WS handler; extend existing override handlers to carry `forcedMode` in the ack.
- `server/lib/mqtt-bridge.js` — extend the `manual_override` broadcast shape with `forcedMode`.
- `shelly/control-logic.js` — delete the `fm` branch in `evaluate()` and the `fm`-aware watchdog-ban precheck. Update the compact-key comment block.
- `shelly/control.js` — extend `handleConfigDrivenResolution()` with (a) `mo.fm` change → `transitionTo(makeModeResult(mo.fm))`; (b) `mo` cleared while previously active → `transitionTo(buildIdleTransitionResult())`. Add `makeModeResult()` helper. Extend the `isManualOverrideActive()` TTL-expiry path to enqueue the same IDLE transition.
- `shelly/telemetry.js` — update `isSafetyCritical()` to watch `mo.fm` instead of top-level `fm`.
- `playground/index.html` — delete the Mode Override block inside the device-config card; insert the forced-mode button row inside the override card between TTL presets and the relay soundboard.
- `playground/js/main.js` — wire forced-mode button click handlers, optimistic soundboard preview, banned-mode state, status-view forced-mode indicator, readonly gating.
- `playground/style.css` — style the forced-mode button group (reuses `.ttl-btn` pattern with a new modifier).
- `tests/control-logic.test.js` — delete tests that rely on top-level `fm` driving `evaluate()`.
- `tests/device-config.test.js` — extend to cover `mo.fm` validation and legacy `fm` stripping.
- `tests/e2e/device-config.spec.js` — remove selector assertions for `#dc-fm`.
- `tests/e2e/auth-actions.spec.js` — extend readonly coverage.
- `playground/assets/bootstrap-history.json` — regenerate via `npm run bootstrap-history`.

### Created

- `tests/override-forced-mode.test.js` — new Node test using the ordering runtime from `tests/shelly-transition.test.js` plus the `__TEST_HARNESS` / `Shelly.__test_driveTransition` hook.
- `tests/e2e/override.spec.js` — new Playwright spec covering the forced-mode button group, status indicator, and TTL expiry.

---

## Task 1: Server schema — drop `fm`, accept `mo.fm`, strip legacy

**Why:** The spec moves `fm` from top-level device config into `mo.fm`. Do this first so the rest of the server/device code has a clean schema to build on.

**Files:**
- Modify: `server/lib/device-config.js`
- Modify: `tests/device-config.test.js`

- [ ] **Step 1: Write the failing test** — append to `tests/device-config.test.js`. Use the existing `describe('device-config updateConfig', ...)` block's setup pattern (look at the top of the file for how `require('../server/lib/device-config')` is wired and any `reset()` helper — reuse exactly that pattern). Add:

```javascript
describe('device-config mo.fm', () => {
  it('accepts mo.fm when mo.a is true', (t, done) => {
    deviceConfig.reset();
    deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' } }, (err, cfg) => {
      assert.ifError(err);
      assert.deepStrictEqual(cfg.mo, { a: true, ex: 9999999999, ss: false, fm: 'SC' });
      done();
    });
  });

  it('accepts mo.fm update while override is active', (t, done) => {
    deviceConfig.reset();
    deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, ss: false } }, (err) => {
      assert.ifError(err);
      deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, ss: false, fm: 'GH' } }, (err2, cfg) => {
        assert.ifError(err2);
        assert.strictEqual(cfg.mo.fm, 'GH');
        done();
      });
    });
  });

  it('rejects mo.fm when mo.a is false', (t, done) => {
    deviceConfig.reset();
    deviceConfig.updateConfig({ mo: { a: false, ex: 0, ss: false, fm: 'SC' } }, (err) => {
      assert.ok(err);
      assert.match(err.message, /mo\.fm/);
      assert.strictEqual(err.code, 'VALIDATION');
      done();
    });
  });

  it('rejects unknown mode codes in mo.fm', (t, done) => {
    deviceConfig.reset();
    deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, ss: false, fm: 'XX' } }, (err) => {
      assert.ok(err);
      assert.match(err.message, /mo\.fm/);
      done();
    });
  });

  it('clears mo.fm when mo is cleared', (t, done) => {
    deviceConfig.reset();
    deviceConfig.updateConfig({ mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' } }, (err) => {
      assert.ifError(err);
      deviceConfig.updateConfig({ mo: null }, (err2, cfg) => {
        assert.ifError(err2);
        assert.strictEqual(cfg.mo, null);
        done();
      });
    });
  });

  it('strips legacy top-level fm from loaded config', (t, done) => {
    deviceConfig.reset();
    // Simulate a config that still has legacy fm (would come from S3/local storage written before this change).
    deviceConfig.loadForTest({ ce: true, ea: 31, fm: 'SC', we: {}, wz: {}, wb: {}, v: 42 });
    var cfg = deviceConfig.getConfig();
    assert.strictEqual(cfg.fm, undefined);
    done();
  });
});
```

If `deviceConfig.reset` or `deviceConfig.loadForTest` doesn't exist yet, add a minimal test-only helper in `server/lib/device-config.js` that sets `currentConfig` directly. Don't invent fancy names — match what `device-config.test.js` already uses. If the file does not export a `reset`, read the existing test file's setup and mimic it (re-require with cache-busting, or a helper — whatever pattern already works).

- [ ] **Step 2: Run tests — confirm failure**

```bash
npm run test:unit -- --grep "device-config mo.fm"
```

Expected: FAIL. Errors will be variants of "mo.fm unexpected" / "no such helper reset" / stripping not applied.

- [ ] **Step 3: Implement** — edit `server/lib/device-config.js`:

  a) In `DEFAULT_CONFIG` (around line 25-33), **remove** the `fm: null,` line.

  b) In the comment block above `DEFAULT_CONFIG`, replace:

  ```
  //   fm = forced_mode ("I","SC","GH","AD","EH", or null)
  ```

  with nothing (delete the line), and change:

  ```
  //   mo = manual override session ({a, ex, ss} or null)
  ```

  to:

  ```
  //   mo = manual override session ({a, ex, ss, fm?} or null)
  //        fm is optional, only valid when a === true
  ```

  c) In `updateConfig()` (around line 190-192), **delete** the `fm` handling block:

  ```javascript
  if (newConfig.fm !== undefined) {
    config.fm = newConfig.fm || null;
  }
  ```

  d) In the `mo` handling block (around lines 253-265), replace the current body with:

  ```javascript
  if (newConfig.mo !== undefined) {
    if (newConfig.mo === null) {
      config.mo = null;
    } else if (typeof newConfig.mo === 'object') {
      var mo = newConfig.mo;
      if (typeof mo.a !== 'boolean' || typeof mo.ex !== 'number' || typeof mo.ss !== 'boolean') {
        callback(validationError('Invalid mo: requires {a: bool, ex: int, ss: bool}'));
        return;
      }
      var newMo = { a: mo.a, ex: Math.floor(mo.ex), ss: mo.ss };
      if (mo.fm !== undefined && mo.fm !== null) {
        var VALID_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];
        if (VALID_MODES.indexOf(mo.fm) === -1) {
          callback(validationError('Invalid mo.fm: must be one of I,SC,GH,AD,EH'));
          return;
        }
        if (!mo.a) {
          callback(validationError('mo.fm cannot be set when mo.a is false'));
          return;
        }
        newMo.fm = mo.fm;
      }
      config.mo = newMo;
    }
  }
  ```

  e) Add a helper near the top of the file (right below `migrateAmToWb`) that strips the legacy top-level `fm`:

  ```javascript
  function stripLegacyFm(cfg) {
    if (cfg && cfg.fm !== undefined) delete cfg.fm;
    return cfg;
  }
  ```

  Call `stripLegacyFm(parsed)` in every place config is loaded from S3, local disk, or `PUT` body. Grep for `currentConfig = parsed` / `migrateAmToWb(parsed)` and insert `stripLegacyFm(parsed);` immediately after each `migrateAmToWb(parsed);` call.

  f) If the tests expect `deviceConfig.loadForTest` and it doesn't already exist, add it right before `module.exports`:

  ```javascript
  function loadForTest(cfg) {
    currentConfig = deepCopy(cfg);
    migrateAmToWb(currentConfig);
    stripLegacyFm(currentConfig);
  }
  ```

  and export it alongside `updateConfig`, `getConfig`, `reset`.

- [ ] **Step 4: Run tests — confirm pass**

```bash
npm run test:unit -- --grep "device-config"
```

Expected: all device-config tests pass, including the new `mo.fm` block.

- [ ] **Step 5: Run the full unit suite to catch collateral damage**

```bash
npm run test:unit
```

Expected: 100% pass. If any test references `config.fm` or `cfg.fm` at top level and fails, those are spec-driven removals that will be addressed in later tasks — leave the failures, note them in a comment line in this plan file at the top of the task, and move on. (Exception: if the breakage is in shared helpers, fix inline.)

- [ ] **Step 6: Commit**

```bash
git add server/lib/device-config.js tests/device-config.test.js
git commit -m "Move fm into mo.fm; strip legacy top-level fm on load

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Server — `override-set-mode` WebSocket handler

**Why:** UI needs a command to set `mo.fm` while override is active. Existing WS override handlers manage enter/update/exit; add a sibling handler for the forced-mode selection.

**Files:**
- Modify: `server/server.js`
- Modify: `tests/mqtt-bridge.test.js` OR a dedicated `tests/server-ws.test.js` — pick whichever already covers the other `override-*` WS handlers. Grep for `override-enter` in `tests/` to locate.

- [ ] **Step 1: Locate the existing override WS test file**

```bash
grep -rln "override-enter" tests/
```

Use whichever file already exercises `handleWsCommand` / `handleOverrideEnter`. If nothing covers WS commands in unit tests today, create `tests/server-ws-override.test.js` following the `describe / it / node:test` pattern and mocking `deviceConfig.updateConfig` + `mqttBridge.publishConfig` the same way other handler tests do.

- [ ] **Step 2: Write the failing test(s)** — append these cases to the chosen file:

```javascript
describe('override-set-mode WS command', () => {
  it('requires admin role', async () => {
    var ws = makeFakeWs({ role: 'readonly' });
    await handleWsCommand(ws, { type: 'override-set-mode', mode: 'SC' });
    assert.deepStrictEqual(sent(ws).pop(), { type: 'override-error', message: 'Admin role required' });
  });

  it('rejects when override is not active', async () => {
    deviceConfig.reset();
    var ws = makeFakeWs({ role: 'admin' });
    await handleWsCommand(ws, { type: 'override-set-mode', mode: 'SC' });
    assert.match(sent(ws).pop().message, /Override not active/);
  });

  it('rejects banned modes', async () => {
    deviceConfig.reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false }, wb: { SC: 9999999999 }, we: {}, wz: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    await handleWsCommand(ws, { type: 'override-set-mode', mode: 'SC' });
    assert.match(sent(ws).pop().message, /Mode banned/);
  });

  it('rejects unknown mode codes', async () => {
    deviceConfig.reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false }, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    await handleWsCommand(ws, { type: 'override-set-mode', mode: 'XX' });
    assert.match(sent(ws).pop().message, /mo\.fm/);
  });

  it('sets mo.fm and acks on success', async () => {
    deviceConfig.reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false }, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    await handleWsCommand(ws, { type: 'override-set-mode', mode: 'SC' });
    var ack = sent(ws).pop();
    assert.strictEqual(ack.type, 'override-ack');
    assert.strictEqual(ack.forcedMode, 'SC');
    assert.strictEqual(deviceConfig.getConfig().mo.fm, 'SC');
  });

  it('clears mo.fm when mode is null', async () => {
    deviceConfig.reset();
    deviceConfig.loadForTest({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, we: {}, wz: {}, wb: {}, v: 1 });
    var ws = makeFakeWs({ role: 'admin' });
    await handleWsCommand(ws, { type: 'override-set-mode', mode: null });
    var ack = sent(ws).pop();
    assert.strictEqual(ack.forcedMode, null);
    assert.strictEqual(deviceConfig.getConfig().mo.fm, undefined);
  });
});
```

If helper shapes (`makeFakeWs`, `sent`, `handleWsCommand`) don't match what the existing test file uses, adapt the snippet to the file's conventions — keep the six assertions. Export `handleWsCommand` from `server/server.js` if it isn't already exported (add it to `module.exports` at the bottom; leave the existing exports alone).

- [ ] **Step 3: Run tests — confirm failure**

```bash
npm run test:unit -- --grep "override-set-mode"
```

Expected: FAIL — handler doesn't exist yet.

- [ ] **Step 4: Implement** — edit `server/server.js`:

  a) In `handleWsCommand()` (around the existing `if (msg.type === 'override-enter')` chain at line ~650), add the new branch:

  ```javascript
  } else if (msg.type === 'override-set-mode') {
    handleOverrideSetMode(ws, msg);
  }
  ```

  Place it before the final `else if (msg.type === 'relay-command')` branch.

  b) Add the handler function right after `handleOverrideUpdate()`:

  ```javascript
  function handleOverrideSetMode(ws, msg) {
    var cfg = deviceConfig.getConfig();
    if (!cfg.mo || !cfg.mo.a) {
      wsSend(ws, { type: 'override-error', message: 'Override not active' });
      return;
    }

    var mode = msg.mode;
    var VALID_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];
    if (mode !== null && VALID_MODES.indexOf(mode) === -1) {
      wsSend(ws, { type: 'override-error', message: 'Invalid mo.fm: must be one of I,SC,GH,AD,EH' });
      return;
    }
    if (mode !== null && cfg.wb && cfg.wb[mode] && cfg.wb[mode] > Math.floor(Date.now() / 1000)) {
      wsSend(ws, { type: 'override-error', message: 'Mode banned' });
      return;
    }

    var newMo = { a: cfg.mo.a, ex: cfg.mo.ex, ss: cfg.mo.ss };
    if (mode !== null) newMo.fm = mode;

    deviceConfig.updateConfig({ mo: newMo }, function (err, updated) {
      if (err) {
        wsSend(ws, { type: 'override-error', message: err.message });
        return;
      }
      mqttBridge.publishConfig(updated);
      wsSend(ws, {
        type: 'override-ack',
        active: true,
        expiresAt: updated.mo.ex,
        suppressSafety: updated.mo.ss,
        forcedMode: updated.mo.fm || null,
      });
    });
  }
  ```

  c) Extend the existing `override-ack` responses in `handleOverrideEnter`, `handleOverrideUpdate`, and `handleOverrideExit` to include `forcedMode: (updated.mo && updated.mo.fm) || null`. For `handleOverrideExit`, `forcedMode` is always `null` (override is ending).

- [ ] **Step 5: Run tests — confirm pass**

```bash
npm run test:unit -- --grep "override"
```

Expected: all override-related tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/server.js tests/
git commit -m "Add override-set-mode WS command, include forcedMode in acks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: State broadcast — include `forcedMode`

**Why:** The UI renders the status-view forced-mode indicator from the WebSocket state snapshot. `server/lib/mqtt-bridge.js:197` currently emits `manual_override: { active, expiresAt, suppressSafety }`. Extend it.

**Files:**
- Modify: `server/lib/mqtt-bridge.js`
- Modify: `tests/mqtt-bridge.test.js`

- [ ] **Step 1: Write the failing test** — append to the existing `describe` block in `tests/mqtt-bridge.test.js` that covers `manual_override` shape (grep for `manual_override` in that file to find it). Add:

```javascript
it('includes forcedMode in manual_override when mo.fm is set', () => {
  var snapshot = buildStateSnapshot({
    config: { ce: true, mo: { a: true, ex: 1700000000, ss: false, fm: 'SC' } },
    /* other minimum fields as required by the existing test's fixtures */
  });
  assert.deepStrictEqual(snapshot.manual_override, {
    active: true,
    expiresAt: 1700000000,
    suppressSafety: false,
    forcedMode: 'SC',
  });
});

it('forcedMode is null when mo.fm is unset', () => {
  var snapshot = buildStateSnapshot({
    config: { ce: true, mo: { a: true, ex: 1700000000, ss: false } },
  });
  assert.strictEqual(snapshot.manual_override.forcedMode, null);
});
```

If `buildStateSnapshot` is not the actual name used — grep for how existing tests construct the snapshot — match the existing fixture pattern. The two assertions are what matters.

- [ ] **Step 2: Run tests — confirm failure**

```bash
npm run test:unit -- --grep "manual_override"
```

- [ ] **Step 3: Implement** — in `server/lib/mqtt-bridge.js:197`, change:

```javascript
manual_override: { active: true, expiresAt: cfg.mo.ex, suppressSafety: cfg.mo.ss },
```

to:

```javascript
manual_override: {
  active: true,
  expiresAt: cfg.mo.ex,
  suppressSafety: cfg.mo.ss,
  forcedMode: cfg.mo.fm || null,
},
```

- [ ] **Step 4: Run tests — confirm pass**

```bash
npm run test:unit -- --grep "mqtt-bridge"
```

- [ ] **Step 5: Commit**

```bash
git add server/lib/mqtt-bridge.js tests/mqtt-bridge.test.js
git commit -m "Broadcast mo.fm as forcedMode in manual_override state

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Remove `fm` from `evaluate()` in control-logic

**Why:** Top-level `fm` no longer exists, so its handling in `evaluate()` is dead. The `mo.a === true` guard in `shelly/control.js:867` already prevents `evaluate()` from running during override, so removing this code is semantics-preserving.

**Files:**
- Modify: `shelly/control-logic.js`
- Modify: `tests/control-logic.test.js`

- [ ] **Step 1: Identify and delete tests that rely on top-level `fm`**

```bash
grep -n "\.fm\b\|fm:\|forcedMode\|forced_mode" tests/control-logic.test.js
```

For each match, decide: (a) if the test sets `deviceConfig.fm = 'SC'` and asserts `evaluate()` returns `MODES.SOLAR_CHARGING`, DELETE the test — the behaviour is being removed. (b) If the test asserts watchdog ban interaction with `fm`, DELETE it — `mo.fm` bans are enforced at the server, not in `evaluate()`, and `evaluate()` doesn't run during override.

- [ ] **Step 2: Run tests — confirm tests that touch `fm` are gone, others pass**

```bash
npm run test:unit -- --grep "control-logic"
```

Expected: pass. No mention of fm in test output.

- [ ] **Step 3: Implement — edit `shelly/control-logic.js`**:

  a) Delete the entire block at lines 410-423 (the "Unified mode ban check (wb)" block keyed on `dc.fm`):

  ```javascript
  if (dc && dc.wb && dc.fm) {
    var fmCode = dc.fm;
    if (dc.wb[fmCode] && dc.wb[fmCode] > state.now) {
      flags.solarChargePeakTankTop = null;
      flags.solarChargePeakTankTopAt = 0;
      return makeResult(MODES.IDLE, flags, dc);
    }
  }
  ```

  b) Delete the "Forced mode override" block at lines 425-437:

  ```javascript
  if (dc && dc.fm) {
    var forcedMode = expandModeCode(dc.fm);
    if (MODES[forcedMode]) {
      pumpMode = MODES[forcedMode];
      flags.emergencyHeatingActive = false;
      if (pumpMode !== MODES.SOLAR_CHARGING) {
        flags.solarChargePeakTankTop = null;
        flags.solarChargePeakTankTopAt = 0;
      }
      return makeResult(pumpMode, flags, dc);
    }
  }
  ```

  c) In the compact-key comment block (around lines 139-144), replace:

  ```
  //   fm (string) = forced_mode: "I","SC","GH","AD","EH", or null
  ```

  with:

  ```
  //   mo (obj)    = manual override: {a, ex, ss, fm?} or null
  //                 a=active, ex=expiry unix, ss=suppress safety, fm=forced mode
  ```

  Keep `expandModeCode`, `shortCodeOf`, `MODE_CODE` — they are reused by the device-side `mo.fm` handler.

  d) Scan the rest of the file for any remaining references to `.fm` that are NOT `.mo.fm`. There should be none after the above deletions.

- [ ] **Step 4: Run unit tests**

```bash
npm run test:unit -- --grep "control-logic"
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add shelly/control-logic.js tests/control-logic.test.js
git commit -m "Remove top-level fm from evaluate(); mo.fm now drives override

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: telemetry — `isSafetyCritical` watches `mo.fm`

**Why:** `shelly/telemetry.js:53` currently marks a config update as safety-critical if `oldCfg.fm !== newCfg.fm`. With top-level `fm` gone, switch the watch to `mo.fm`. Safety-critical means the device re-runs the control loop immediately; we want that when the operator picks a new forced mode.

**Files:**
- Modify: `shelly/telemetry.js`
- Modify: `tests/shelly-telemetry.test.js` (or whatever file covers `isSafetyCritical`; grep first)

- [ ] **Step 1: Locate the test**

```bash
grep -rln "isSafetyCritical" tests/
```

- [ ] **Step 2: Write the failing test** — in the located file, add two cases inside the existing `isSafetyCritical` describe block:

```javascript
it('flags a change to mo.fm as safety-critical', () => {
  var oldCfg = { ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, wb: {}, we: {}, wz: {} };
  var newCfg = { ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'GH' }, wb: {}, we: {}, wz: {} };
  assert.strictEqual(isSafetyCritical(oldCfg, newCfg), true);
});

it('flags adding mo.fm to an otherwise-unchanged mo as safety-critical', () => {
  var oldCfg = { ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false }, wb: {}, we: {}, wz: {} };
  var newCfg = { ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, wb: {}, we: {}, wz: {} };
  assert.strictEqual(isSafetyCritical(oldCfg, newCfg), true);
});

it('does not flag an unchanged mo.fm', () => {
  var oldCfg = { ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, wb: {}, we: {}, wz: {} };
  var newCfg = { ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, wb: {}, we: {}, wz: {} };
  assert.strictEqual(isSafetyCritical(oldCfg, newCfg), false);
});
```

Also DELETE any existing test that asserts top-level `fm` triggers safety-critical — the spec removes that field.

- [ ] **Step 3: Run tests — confirm failure**

```bash
npm run test:unit -- --grep "isSafetyCritical"
```

- [ ] **Step 4: Implement** — in `shelly/telemetry.js` around lines 49-67, replace the `fm` check with a `mo.fm` check. The surrounding block looks like:

```javascript
function isSafetyCritical(oldCfg, newCfg) {
  if (!oldCfg) return true;
  if (oldCfg.ce !== newCfg.ce) return true;
  if (oldCfg.ea !== newCfg.ea) return true;
  if (oldCfg.fm !== newCfg.fm) return true;    // ← DELETE THIS LINE
  // Mode bans (wb) gate evaluate() immediately — changes must trigger a
  // safety-critical re-eval so a newly-enforced ban takes effect on the
  // next tick rather than after an unrelated mode change.
  if (JSON.stringify(oldCfg.wb) !== JSON.stringify(newCfg.wb)) return true;
  ...
}
```

Replace with:

```javascript
function isSafetyCritical(oldCfg, newCfg) {
  if (!oldCfg) return true;
  if (oldCfg.ce !== newCfg.ce) return true;
  if (oldCfg.ea !== newCfg.ea) return true;
  // mo.fm drives the forced-mode transition on-device. Mark changes
  // safety-critical so the config_changed handler fires immediately.
  var oldMf = (oldCfg.mo) ? oldCfg.mo.fm : null;
  var newMf = (newCfg.mo) ? newCfg.mo.fm : null;
  if (oldMf !== newMf) return true;
  // Mode bans (wb) gate evaluate() immediately — changes must trigger a
  // safety-critical re-eval so a newly-enforced ban takes effect on the
  // next tick rather than after an unrelated mode change.
  if (JSON.stringify(oldCfg.wb) !== JSON.stringify(newCfg.wb)) return true;
  ...
}
```

Leave the rest of the function untouched.

- [ ] **Step 5: Run tests — confirm pass**

```bash
npm run test:unit -- --grep "isSafetyCritical|telemetry"
```

- [ ] **Step 6: Commit**

```bash
git add shelly/telemetry.js tests/
git commit -m "telemetry: mo.fm change is safety-critical (replaces fm)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Device — `mo.fm` drives `transitionTo`, exit forces IDLE

**Why:** The behavioural core. When `mo.a` is active and `mo.fm` changes, the device must staged-transition into that mode (bypassing min-duration because `evaluate()` is skipped). When `mo` clears (user exit, TTL, safety), the device must staged-transition to IDLE — automatically using the new valves-first 20 s path if the source mode was `ACTIVE_DRAIN`.

**Files:**
- Modify: `shelly/control.js`
- Create: `tests/override-forced-mode.test.js`

- [ ] **Step 1: Create the new test file** using the ordering runtime from `tests/shelly-transition.test.js`. Copy the `createOrderingRuntime` function verbatim (or `require('./shelly-transition.test-helpers')` if that file already exports it — check first with `grep -n "module.exports" tests/shelly-transition.test.js`; if it doesn't export anything, duplicate the helper into this file with a `// Copied from tests/shelly-transition.test.js — keep in sync when the runtime mock changes.` comment at the top).

Full test file content:

```javascript
/**
 * Manual-override forced-mode transition tests.
 *
 * Covers:
 *   - Forcing SC inside override drives transitionTo with MODE_VALVES.SOLAR_CHARGING.
 *   - Switching forced mode bypasses the min-duration hold.
 *   - Exiting override from a non-AD forced mode runs the default pump-first transition to IDLE.
 *   - Exiting override from forced AD uses the valves-first + DRAIN_EXIT_PUMP_RUN_MS path.
 *   - TTL expiry triggers the same IDLE transition without a user action.
 *
 * Uses the __TEST_HARNESS / Shelly.__test_driveTransition hook shipped in
 * shelly/control.js so we can drive transitions directly without setting
 * up an MQTT broker.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

// [Paste createOrderingRuntime here — copy verbatim from tests/shelly-transition.test.js.]
// [Paste loadScript helper that invokes the script with __TEST_HARNESS=true — copy verbatim.]

function bootDevice(opts) {
  opts = opts || {};
  var runtime = createOrderingRuntime(opts);
  loadScript(path.join(SHELLY_DIR, 'control.js'), runtime, { __TEST_HARNESS: true });
  runtime.advanceMs(1000);
  runtime.clearEvents();
  return runtime;
}

describe('forced mode inside manual override', () => {
  it('drives transition to MODE_VALVES.SOLAR_CHARGING when mo.fm = SC', () => {
    var rt = bootDevice();
    rt.setConfig({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false }, we: {}, wz: {}, wb: {}, v: 2 });
    rt.driveTransition('IDLE', { nextMode: 'SOLAR_CHARGING', valves: { vi_btm: true, vi_coll: false, vi_top: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false }, actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false }, flags: {} });
    rt.runUntilIdle();
    var valveEvents = rt.events.filter(e => e.kind === 'http_get' && /valve/.test(e.detail.url));
    assert.ok(valveEvents.length > 0, 'expected valve actuation');
    var switchEvents = rt.events.filter(e => e.kind === 'switch_set');
    var pumpOn = switchEvents.find(e => e.detail.id === 0 && e.detail.on === true);
    assert.ok(pumpOn, 'pump should be turned on for SC');
  });

  it('bypasses min-duration when switching forced modes mid-override', () => {
    var rt = bootDevice();
    rt.setConfig({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, we: {}, wz: {}, wb: {}, v: 2 });
    rt.driveTransition('IDLE', /* SC result */ { nextMode: 'SOLAR_CHARGING', valves: {}, actuators: { pump: true }, flags: {} });
    rt.runUntilIdle();
    rt.advanceMs(30 * 1000); // only 30s — well below the 300s min-duration hold.
    rt.clearEvents();
    rt.setConfig({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'GH' }, we: {}, wz: {}, wb: {}, v: 3 });
    rt.driveTransition('SOLAR_CHARGING', { nextMode: 'GREENHOUSE_HEATING', valves: {}, actuators: { pump: true }, flags: {} });
    rt.runUntilIdle();
    var switchEvents = rt.events.filter(e => e.kind === 'switch_set');
    assert.ok(switchEvents.some(e => e.detail.id === 0), 'pump should actuate in transition');
  });

  it('exits override from SC via pump-first transition to IDLE', () => {
    var rt = bootDevice();
    rt.setConfig({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'SC' }, we: {}, wz: {}, wb: {}, v: 2 });
    rt.driveTransition('IDLE', { nextMode: 'SOLAR_CHARGING', valves: {}, actuators: { pump: true }, flags: {} });
    rt.runUntilIdle();
    rt.clearEvents();
    rt.setConfig({ ce: true, ea: 31, mo: null, we: {}, wz: {}, wb: {}, v: 3 });
    rt.runUntilIdle();
    var pumpOff = rt.events.find(e => e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false);
    var firstValveOff = rt.events.find(e => e.kind === 'http_get' && /valve/.test(e.detail.url));
    assert.ok(pumpOff && firstValveOff, 'both pump-off and valve move should occur');
    assert.ok(pumpOff.t < firstValveOff.t, 'pump-off must precede valve moves (default ordering)');
  });

  it('exits override from AD via valves-first + DRAIN_EXIT_PUMP_RUN_MS path', () => {
    var rt = bootDevice();
    rt.setConfig({ ce: true, ea: 31, mo: { a: true, ex: 9999999999, ss: false, fm: 'AD' }, we: {}, wz: {}, wb: {}, v: 2 });
    rt.driveTransition('IDLE', { nextMode: 'ACTIVE_DRAIN', valves: {}, actuators: { pump: true }, flags: {} });
    rt.runUntilIdle();
    rt.clearEvents();
    rt.setConfig({ ce: true, ea: 31, mo: null, we: {}, wz: {}, wb: {}, v: 3 });
    rt.runUntilIdle();
    var pumpOff = rt.events.find(e => e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false);
    var lastValve = [...rt.events].reverse().find(e => e.kind === 'http_get' && /valve/.test(e.detail.url));
    assert.ok(pumpOff && lastValve, 'both pump-off and valve moves should occur');
    assert.ok(lastValve.t < pumpOff.t, 'valve moves must precede pump-off (drain exit ordering)');
    assert.ok(pumpOff.t - lastValve.t >= 20000 - 50, 'at least ~20s gap between last valve move and pump off');
  });

  it('triggers IDLE transition on TTL expiry without a user command', () => {
    var rt = bootDevice();
    var exAt = Math.floor(Date.now() / 1000) + 60;
    rt.setConfig({ ce: true, ea: 31, mo: { a: true, ex: exAt, ss: false, fm: 'SC' }, we: {}, wz: {}, wb: {}, v: 2 });
    rt.driveTransition('IDLE', { nextMode: 'SOLAR_CHARGING', valves: {}, actuators: { pump: true }, flags: {} });
    rt.runUntilIdle();
    rt.clearEvents();
    rt.advanceMs(61 * 1000); // past TTL
    rt.runControlLoopTick(); // whatever helper exists to invoke the tick; see shelly-transition.test.js for pattern
    var pumpOff = rt.events.find(e => e.kind === 'switch_set' && e.detail.id === 0 && e.detail.on === false);
    assert.ok(pumpOff, 'TTL expiry must stop the pump');
  });
});
```

The `rt.setConfig(cfg)` helper is whatever the existing runtime exposes. If it is not yet in `createOrderingRuntime`, add a method that:

1. Updates the runtime's KVS `config` key to `JSON.stringify(cfg)`.
2. Emits a `config_changed` synthetic event: `eventHandlers.forEach(h => h({ info: { event: 'config_changed', data: { config: cfg, safety_critical: true } } }))`.

Same treatment for `rt.runUntilIdle()` — run all due timers until there are none, or a safety cap of 60 s of synthetic time.

- [ ] **Step 2: Run tests — confirm failure**

```bash
node --test tests/override-forced-mode.test.js
```

Expected: FAIL — `transitionTo` doesn't react to `mo.fm` yet, IDLE on mo-clear doesn't happen.

- [ ] **Step 3: Implement `makeModeResult` helper in `shelly/control.js`**

Somewhere near the other result helpers (e.g. just below `buildIdleTransitionResult`), add:

```javascript
// Build a transitionTo-shaped result for a forced mode inside manual
// override. Bypasses evaluate() — we already hand the scheduler the
// mode's canonical valve + actuator table, no sensor logic required.
function makeModeResult(modeCode) {
  var expanded = (typeof expandModeCode === 'function') ? expandModeCode(modeCode) : null;
  if (!expanded || !MODES[expanded]) return null;
  var mode = MODES[expanded];
  var valves = {};
  var k;
  var mv = MODE_VALVES[mode];
  for (k in mv) valves[k] = mv[k];
  var actuators = {};
  var ma = MODE_ACTUATORS[mode];
  for (k in ma) actuators[k] = ma[k];
  return { nextMode: mode, valves: valves, actuators: actuators, flags: {} };
}
```

If `expandModeCode`, `MODES`, `MODE_VALVES`, `MODE_ACTUATORS` aren't already available from `control-logic.js` in the `control.js` module scope, grep for how they're consumed (e.g. `var expandModeCode = ControlLogic.expandModeCode`) and reuse the existing accessor.

- [ ] **Step 4: Extend `handleConfigDrivenResolution`** to react to `mo.fm` and `mo` clear. Grep for the function body (`function handleConfigDrivenResolution`) and at the end of it, before the closing brace, add:

```javascript
// mo.fm diff: forced-mode change inside an active override.
var prevMo = prev && prev.mo;
var nextMo = next && next.mo;
var prevFm = prevMo && prevMo.fm ? prevMo.fm : null;
var nextFm = nextMo && nextMo.fm ? nextMo.fm : null;
if (nextMo && nextMo.a && nextFm && nextFm !== prevFm) {
  var result = makeModeResult(nextFm);
  if (result) {
    transitionTo(result);
    return;
  }
}

// mo cleared while it was previously active → force IDLE transition so
// the greenhouse does not linger in whatever relay state the user left.
if (prevMo && prevMo.a && (!nextMo || !nextMo.a)) {
  transitionTo(buildIdleTransitionResult());
  return;
}
```

If the function already returns early on some branches, place the new logic before those early returns only if they'd otherwise shadow the forced-mode change. Err on the side of inserting right before the function's final return/end.

- [ ] **Step 5: Extend TTL-expiry path** in `isManualOverrideActive()` (around `shelly/control.js:774`). Current code:

```javascript
if (now >= deviceConfig.mo.ex) {
  deviceConfig.mo = null;
  Shelly.call("KVS.Set", {key: "config", value: JSON.stringify(deviceConfig)});
  return false;
}
```

Change to:

```javascript
if (now >= deviceConfig.mo.ex) {
  deviceConfig.mo = null;
  Shelly.call("KVS.Set", {key: "config", value: JSON.stringify(deviceConfig)});
  // TTL-expiry exit path. Enqueue an IDLE transition so relays don't
  // linger in whatever state the user left. For AD→IDLE this uses the
  // valves-first + DRAIN_EXIT_PUMP_RUN_MS sequence automatically via
  // state.transitionFromMode.
  if (!state.transitioning) {
    transitionTo(buildIdleTransitionResult());
  }
  return false;
}
```

The `!state.transitioning` guard prevents double-scheduling if the control loop interleaves with an in-flight transition.

- [ ] **Step 6: Run the new tests — confirm pass**

```bash
node --test tests/override-forced-mode.test.js
```

- [ ] **Step 7: Run the FULL Shelly transition suite to guard against regression in the drain-exit work**

```bash
node --test tests/shelly-transition.test.js tests/override-forced-mode.test.js
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add shelly/control.js tests/override-forced-mode.test.js
git commit -m "Device: mo.fm drives transitionTo; exit from override forces IDLE

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: UI — remove Mode Override block from device-config card

**Why:** The spec moves the selector. Delete the old location first so we don't accidentally end up with two selectors in play.

**Files:**
- Modify: `playground/index.html`
- Modify: `playground/js/main.js` — remove the `#dc-fm` event handlers and any save-path wiring.
- Modify: `tests/e2e/device-config.spec.js`

- [ ] **Step 1: Write the failing e2e test**

In `tests/e2e/device-config.spec.js`, add (or adapt an existing test) that asserts `#dc-fm` is NOT present:

```javascript
test('Mode Override block is removed from the device-config card', async ({ page }) => {
  await page.goto('/#controls');
  await expect(page.locator('#dc-fm')).toHaveCount(0);
  await expect(page.locator('text=Mode Override')).toHaveCount(0);
});
```

And DELETE any existing test that depends on `#dc-fm` being present.

- [ ] **Step 2: Run the e2e test**

```bash
npm run test:e2e -- --grep "Mode Override block is removed"
```

Expected: FAIL — `#dc-fm` still in DOM.

- [ ] **Step 3: Implement**

  a) In `playground/index.html` at lines 425-437, DELETE the entire `<h4>Mode Override</h4>` block including the `<p>` description and the `<select id="dc-fm">` element. Leave the surrounding Mode enablement block (which starts at the next `<h4>Mode enablement</h4>`) untouched.

  b) In `playground/js/main.js`, grep for `dc-fm` and `fm:` — remove:
  - Any event listener on `#dc-fm`.
  - Any code that reads `#dc-fm` when constructing the device-config save payload (look in whatever handler handles the `#dc-save` click).
  - Any ready-state initialisation that sets `#dc-fm`'s selected option from incoming state.

  Reword the existing "Mode enablement" helper paragraph (it mentions `fm` today at `playground/index.html:440`):

  ```
  Each mode can be permanently disabled, on a watchdog cool-off (temporary auto-ban), or allowed. Forced mode respects bans: a banned mode cannot be forced.
  ```

  Change to:

  ```
  Each mode can be permanently disabled, on a watchdog cool-off (temporary auto-ban), or allowed. The manual-override Forced mode selector respects bans: a banned mode cannot be forced.
  ```

- [ ] **Step 4: Run e2e**

```bash
npm run test:e2e -- --grep "Mode Override block is removed"
```

- [ ] **Step 5: Run the broader device-config e2e to catch collateral damage**

```bash
npm run test:e2e -- tests/e2e/device-config.spec.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add playground/index.html playground/js/main.js tests/e2e/device-config.spec.js
git commit -m "Remove Mode Override block from device-config card

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: UI — forced-mode button group inside override card

**Why:** The heart of the feature's UI. Six buttons (Automatic, Idle, Solar charging, Greenhouse heating, Active drain, Emergency heating), visually separated from the relay soundboard, only visible after entering override, send `override-set-mode` on click, optimistically preview the mode's relay preset, and disable banned modes.

**Files:**
- Modify: `playground/index.html`
- Modify: `playground/js/main.js`
- Modify: `playground/style.css`
- Create: `tests/e2e/override.spec.js`

- [ ] **Step 1: Create the Playwright spec**

```javascript
// tests/e2e/override.spec.js
import { test, expect } from './fixtures.js';

test.describe('manual override forced-mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/#controls');
  });

  test('forced-mode buttons appear only after entering override', async ({ page }) => {
    await expect(page.locator('#forced-mode-group')).toBeHidden();
    // Enable controls + enter override via the existing enter flow
    // (use the test harness the rest of the override spec uses —
    // grep existing tests/e2e/*.spec.js for "override-enter-btn" to
    // reuse the setup helper).
    await enterOverride(page);
    await expect(page.locator('#forced-mode-group')).toBeVisible();
    await expect(page.locator('#forced-mode-btns .fm-btn')).toHaveCount(6);
  });

  test('clicking a forced-mode button snaps the soundboard preset', async ({ page }) => {
    await enterOverride(page);
    await page.click('#forced-mode-btns .fm-btn[data-mode="SC"]');
    await expect(page.locator('#forced-mode-btns .fm-btn[data-mode="SC"]')).toHaveClass(/active/);
    // Pump button reflects SC preset (pump on)
    await expect(page.locator('.relay-btn[data-relay="pump"]')).toHaveClass(/on/);
  });

  test('banned mode button is disabled', async ({ page }) => {
    // Arrange: bay SC via device-config, then enter override
    await setModeBan(page, 'SC');
    await enterOverride(page);
    await expect(page.locator('#forced-mode-btns .fm-btn[data-mode="SC"]')).toBeDisabled();
    await expect(page.locator('#forced-mode-btns .fm-btn[data-mode="SC"]')).toContainText(/banned/);
  });
});

// Helpers — if enterOverride / setModeBan aren't already in a shared module,
// inline a minimal version here. Use the same pattern as tests/e2e/live-mode.spec.js.
```

If a helper file already wraps entering override, reuse it. Do not copy-paste a bespoke WebSocket mock — the spec must exercise the real flow via the test harness.

- [ ] **Step 2: Run the spec — confirm failure**

```bash
npm run test:e2e -- tests/e2e/override.spec.js
```

Expected: FAIL — `#forced-mode-group` doesn't exist.

- [ ] **Step 3: Implement — insert the button group in `playground/index.html`**

Locate the override card's active-state block (around lines 469-485 — the `#override-active-header` + `#override-ttl-btns` region) and insert immediately AFTER the closing `</div>` of `#override-ttl-btns` and BEFORE the `<!-- Relay soundboard grid -->` comment:

```html
        <!-- Forced mode group (gated by override) -->
        <div id="forced-mode-group" style="display:none;margin-bottom:16px;padding-top:12px;border-top:1px solid var(--outline-variant);">
          <h4 style="margin:0 0 8px;font-family:'Newsreader',Georgia,serif;font-style:italic;color:var(--on-surface);font-size:14px;">Forced mode</h4>
          <div id="forced-mode-btns" style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="fm-btn active" data-mode="">Automatic</button>
            <button class="fm-btn" data-mode="I">Idle</button>
            <button class="fm-btn" data-mode="SC">Solar charging</button>
            <button class="fm-btn" data-mode="GH">Greenhouse heating</button>
            <button class="fm-btn" data-mode="AD">Active drain</button>
            <button class="fm-btn" data-mode="EH">Emergency heating</button>
          </div>
          <p style="font-size:11px;color:var(--on-surface-variant);margin:8px 0 0;">Immediate transition — ignores the 5-min minimum mode duration.</p>
        </div>
```

- [ ] **Step 4: Add CSS in `playground/style.css`**

Locate the existing `.ttl-btn` definitions and add, in the same section:

```css
.fm-btn {
  background: var(--surface-variant);
  color: var(--on-surface-variant);
  border: 1px solid var(--outline-variant);
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}
.fm-btn:hover:not(:disabled) {
  background: var(--surface);
}
.fm-btn.active {
  background: var(--primary);
  color: var(--on-primary);
  border-color: var(--primary);
}
.fm-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

(If the existing `.ttl-btn` uses slightly different tokens, match those — the goal is the same visual language. Check the existing `:root` token set and reuse matching names.)

- [ ] **Step 5: Wire click handlers in `playground/js/main.js`**

Add alongside the existing override wiring in `initRelayBoard()`:

```javascript
var forcedModeSendTimer = null;
var currentForcedMode = null;

document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(btn => {
  btn.addEventListener('click', function () {
    if (this.disabled || !overrideActive) return;
    var mode = this.dataset.mode || null;
    if (mode === currentForcedMode) return;

    // Optimistic UI: light this button, dim the others, snap relay preview
    document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    applyForcedModePreview(mode);

    // Debounce rapid taps
    if (forcedModeSendTimer) clearTimeout(forcedModeSendTimer);
    forcedModeSendTimer = setTimeout(function () {
      if (liveSource) liveSource.sendCommand({ type: 'override-set-mode', mode: mode });
    }, 300);
    currentForcedMode = mode;
  });
});
```

Where `applyForcedModePreview(mode)` snaps the `.relay-btn` `on` classes to the mode's MODE_VALVES + MODE_ACTUATORS table. Reuse the table via the existing `control-logic-loader.js` import — grep for how it exposes `MODE_VALVES`. If that helper isn't already imported in `main.js`, import it the same way `playground/js/simulator.js` does.

Also:

- Extend `activateOverrideUI()` to show `#forced-mode-group` (`style.display = ''`).
- Extend `deactivateOverrideUI()` to hide `#forced-mode-group`, reset `currentForcedMode = null`, clear the `active` class from all `.fm-btn` except the `data-mode=""` (Automatic) button.
- Extend `updateRelayBoard(result)` to read `result.manual_override.forcedMode` and sync the active `.fm-btn` accordingly when the server confirms the selection. Also iterate `result.config.wb` (or the existing equivalent state field for bans) and `toggle disabled + ' · banned' suffix` on banned buttons.

- [ ] **Step 6: Run e2e — confirm pass**

```bash
npm run test:e2e -- tests/e2e/override.spec.js
```

If the banned-mode test needs a fixture to set `wb.SC`, hit `PUT /api/device-config` from the test's `beforeEach` with `wb: { SC: 9999999999 }`. This matches how other e2e tests seed state.

- [ ] **Step 7: Commit**

```bash
git add playground/index.html playground/js/main.js playground/style.css tests/e2e/override.spec.js
git commit -m "Forced-mode button group inside override card

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: UI — Status view forced-mode indicator

**Why:** The operator should see from any view that the current mode is forced, not automatic. Status view is the obvious place.

**Files:**
- Modify: `playground/index.html`
- Modify: `playground/js/main.js`
- Modify: `playground/style.css`
- Modify: `tests/e2e/override.spec.js`

- [ ] **Step 1: Extend the e2e spec** — append to `tests/e2e/override.spec.js`:

```javascript
test.describe('status-view forced-mode indicator', () => {
  test('shows Forced · Mode when mo.fm is set', async ({ page }) => {
    await enterOverride(page);
    await page.click('#forced-mode-btns .fm-btn[data-mode="SC"]');
    await page.goto('/#status');
    await expect(page.locator('#mode-chip')).toContainText('Forced');
    await expect(page.locator('#mode-chip')).toContainText('Solar charging');
    await expect(page.locator('#mode-chip-exit-link')).toBeVisible();
  });

  test('shows Manual override when mo.fm is null', async ({ page }) => {
    await enterOverride(page);
    await page.goto('/#status');
    await expect(page.locator('#mode-chip')).toContainText('Manual override');
    await expect(page.locator('#mode-chip')).not.toContainText('Forced');
  });

  test('hides forced indicator once override expires', async ({ page }) => {
    await enterOverride(page, { ttl: 60 });
    await page.click('#forced-mode-btns .fm-btn[data-mode="SC"]');
    // Advance beyond TTL — reuse the existing clock-advance helper used by other override TTL tests.
    await advanceClock(page, 70 * 1000);
    await page.goto('/#status');
    await expect(page.locator('#mode-chip')).not.toContainText('Forced');
  });
});
```

If `#mode-chip` is not the actual element id — grep `playground/index.html` for the current status-view mode display element id and use that. Same for `#mode-chip-exit-link`. Keep the assertions semantic: "a node with the text Forced exists in the status-view mode area; a clickable link to exit override exists".

- [ ] **Step 2: Run — confirm failure**

```bash
npm run test:e2e -- --grep "status-view forced-mode indicator"
```

- [ ] **Step 3: Implement**

  a) In `playground/index.html`, locate the status view's mode-display element (search for `view-status` section and the element that renders the current mode). Add an exit-link span inside it (or wrap the existing mode text):

  ```html
  <div id="mode-chip">
    <span class="mode-chip-label">—</span>
    <a id="mode-chip-exit-link" href="#" style="display:none;margin-left:8px;font-size:12px;color:var(--error);">Exit override</a>
  </div>
  ```

  (Replace the existing mode element's structure if needed — preserve any selectors other code depends on.)

  b) In `playground/js/main.js`, add/extend the status-view update path to react to `manual_override`:

  ```javascript
  function updateStatusModeChip(state) {
    var chip = document.getElementById('mode-chip');
    if (!chip) return;
    var label = chip.querySelector('.mode-chip-label');
    var exitLink = document.getElementById('mode-chip-exit-link');
    var mo = state && state.manual_override;
    if (mo && mo.active) {
      chip.classList.add('mode-chip--override');
      if (mo.forcedMode) {
        label.textContent = 'Forced · ' + prettyModeName(mo.forcedMode) + ' · ' + remainingStr(mo.expiresAt) + ' left';
      } else {
        label.textContent = 'Manual override · ' + remainingStr(mo.expiresAt) + ' left';
      }
      exitLink.style.display = (getCurrentUserRole() === 'admin') ? '' : 'none';
    } else {
      chip.classList.remove('mode-chip--override');
      label.textContent = prettyModeName(state.mode);
      exitLink.style.display = 'none';
    }
  }
  ```

  Wire `updateStatusModeChip(state)` into whatever central state-dispatch function already runs on every snapshot. Grep for `state.mode` reads in `main.js` to find the current update path.

  Add handlers:

  ```javascript
  document.getElementById('mode-chip-exit-link').addEventListener('click', function (ev) {
    ev.preventDefault();
    if (liveSource) liveSource.sendCommand({ type: 'override-exit' });
  });
  ```

  Helpers:

  ```javascript
  var MODE_NAMES = { I: 'Idle', SC: 'Solar charging', GH: 'Greenhouse heating', AD: 'Active drain', EH: 'Emergency heating' };
  function prettyModeName(code) {
    if (!code) return 'Idle';
    // Handle long-form too (SOLAR_CHARGING → Solar charging)
    if (MODE_NAMES[code]) return MODE_NAMES[code];
    return code.toLowerCase().replace(/_/g, ' ').replace(/\b./, c => c.toUpperCase());
  }
  function remainingStr(expiresAt) {
    var remaining = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
    var m = Math.floor(remaining / 60);
    var s = remaining % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function getCurrentUserRole() {
    // appState.userRole, or whatever the codebase uses. Check playground/js/app-state.js.
    return (window.appState && window.appState.getUserRole) ? window.appState.getUserRole() : 'admin';
  }
  ```

  c) CSS in `playground/style.css`:

  ```css
  .mode-chip--override .mode-chip-label {
    color: var(--primary);
    font-weight: 600;
  }
  ```

- [ ] **Step 4: Run — confirm pass**

```bash
npm run test:e2e -- --grep "status-view forced-mode indicator"
```

- [ ] **Step 5: Commit**

```bash
git add playground/index.html playground/js/main.js playground/style.css tests/e2e/override.spec.js
git commit -m "Status view forced-mode indicator with exit link

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: UI — readonly gating

**Why:** Readonly users must see the forced-mode state but not be able to change it. The spec requires: buttons disabled, exit-override link hidden. The existing `ws._role` server gate rejects writes already; this is the UI-side guard so they never see an error.

**Files:**
- Modify: `playground/js/main.js`
- Modify: `tests/e2e/auth-actions.spec.js`

- [ ] **Step 1: Extend the auth spec**

In `tests/e2e/auth-actions.spec.js`, add:

```javascript
test('readonly users see forced-mode buttons disabled', async ({ page }) => {
  await loginAsReadonly(page); // reuse existing helper — grep for "readonly" in this file
  await page.goto('/#controls');
  await enterOverrideAsAdminFirst(page); // if readonly cannot enter override at all, skip this test; otherwise seed state from the test harness
  await expect(page.locator('#forced-mode-btns .fm-btn')).toHaveCount(6);
  for (const btn of await page.locator('#forced-mode-btns .fm-btn').all()) {
    await expect(btn).toBeDisabled();
  }
});

test('readonly users do not see the exit-override link on the status view', async ({ page }) => {
  await loginAsReadonly(page);
  await enterOverrideAsAdminFirst(page);
  await page.goto('/#status');
  await expect(page.locator('#mode-chip-exit-link')).toBeHidden();
});
```

If readonly can't trigger override entry via UI (spec says they can't — override-enter is admin-only), seed `mo.a=true` via the test-only API route used by other tests in this file. Grep the file for any existing "seed state" pattern.

- [ ] **Step 2: Run — confirm failure**

```bash
npm run test:e2e -- --grep "readonly users see forced-mode buttons disabled"
```

- [ ] **Step 3: Implement**

In `activateOverrideUI()` (playground/js/main.js), after showing `#forced-mode-group`, add:

```javascript
var isAdmin = getCurrentUserRole() === 'admin';
document.querySelectorAll('#forced-mode-btns .fm-btn').forEach(btn => {
  if (!isAdmin) btn.disabled = true;
});
```

And in `updateStatusModeChip()`, the exit-link visibility already uses `getCurrentUserRole()` — confirm the role is read fresh on every snapshot (otherwise role changes mid-session wouldn't reflect).

- [ ] **Step 4: Run — confirm pass**

```bash
npm run test:e2e -- --grep "readonly users"
```

- [ ] **Step 5: Commit**

```bash
git add playground/js/main.js tests/e2e/auth-actions.spec.js
git commit -m "Readonly role: disable forced-mode buttons, hide exit link

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: Regenerate bootstrap-history + full suite run

**Why:** `playground/assets/bootstrap-history.json` is a pre-baked 12 h sim snapshot (generated from `shelly/control-logic.js` thresholds). Removing the `fm` branches changes nothing in the simulation path (it wasn't exercised there), but `tests/bootstrap-history-drift.test.js` will fail anyway if anything shifts. Regenerate to be safe. Finally, run the entire suite.

**Files:**
- Modify: `playground/assets/bootstrap-history.json` (generated)

- [ ] **Step 1: Regenerate**

```bash
npm run bootstrap-history
```

Expected: `playground/assets/bootstrap-history.json` is rewritten. If git shows no diff, the removal was byte-clean.

- [ ] **Step 2: Run bootstrap-history drift test**

```bash
npm run test:unit -- --grep "bootstrap-history"
```

- [ ] **Step 3: Run the full unit suite**

```bash
npm run test:unit
```

Expected: 100% pass.

- [ ] **Step 4: Run the Shelly lint**

```bash
node shelly/lint/index.js shelly/control.js shelly/control-logic.js shelly/telemetry.js
```

Expected: no errors. If any warning appears about `.fm` — something was missed in an earlier task.

- [ ] **Step 5: Run the e2e suite**

```bash
npm run test:e2e
```

Expected: 100% pass.

- [ ] **Step 6: Commit**

```bash
git add playground/assets/bootstrap-history.json
git diff --cached --quiet || git commit -m "Regenerate bootstrap-history after mo.fm migration

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

If there's no diff to commit, skip this step (the `git diff --cached --quiet` in the shell one-liner is defensive, not strictly required).

---

## Done

At the end of Task 11, this branch contains:

1. `fm` removed from top-level device config; `mo.fm` added.
2. `override-set-mode` WS command + `forcedMode` in state broadcast.
3. `evaluate()` no longer consults `fm` (never runs during override anyway).
4. `isSafetyCritical` watches `mo.fm`.
5. Device-side config handler transitions the staged scheduler on `mo.fm` change, forces IDLE staged transition on every `mo` clear path.
6. UI: Mode Override block removed from device-config card, new forced-mode button group inside override card with optimistic relay preview + banned-mode disabling, status-view forced-mode indicator with exit link, readonly gating.
7. Full test coverage: `tests/override-forced-mode.test.js`, `tests/e2e/override.spec.js`, `tests/e2e/auth-actions.spec.js` extensions; drain-exit ordering regression guard.
8. Lint clean, unit + e2e + drift tests pass.
