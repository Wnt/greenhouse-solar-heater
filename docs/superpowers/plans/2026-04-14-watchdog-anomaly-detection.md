# Watchdog Anomaly Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-mode temperature-delta anomaly watchdogs that fire at mode entry, run a 5-minute pending grace period, allow the user to snooze with a reason via push notification inline reply or web UI, and apply a 4-hour cool-off ban after any shutdown. Unify the new ban mechanism with the existing `am` (allowed modes) feature so `wb` becomes the single source of truth for "which modes are allowed to run right now".

**Architecture:** Detection runs at the Shelly edge via a new pure function `detectAnomaly()` in `control-logic.js`. State management lives in `control.js` and piggybacks on the existing 30 s `controlLoop` tick (no new `Timer.set`). User-facing text (trigger reasons, snooze reasons) is formatted and stored on the server only — the device holds numeric state in its 256 B KVS `config` blob. The server's new `anomaly-manager.js` bridges MQTT events to push notifications, Postgres history, and WebSocket state broadcasts. The web UI adds a pending banner on `#status` and a new Mode Enablement card replacing the current allowed-modes checkboxes.

**Tech Stack:** Shelly Pro 4PM + ES5 device scripts (16 KB/file, linter-enforced); Node.js server with MQTT bridge + WebSocket + Postgres/TimescaleDB; Playground PWA with service worker, vanilla JS, hash-routed views; Playwright e2e; `node --test` unit tests.

---

## Reference spec

`docs/superpowers/specs/2026-04-14-watchdog-anomaly-detection-design.md`

Every task below traces back to a specific section of that spec. When in doubt, the spec is authoritative.

## Preflight notes for the implementer

1. **Working tree state.** This session ended with uncommitted edits to `playground/manifest.webmanifest`, `playground/index.html`, and `playground/sw.js` from an earlier cloudflared-tunnel PWA test. Those edits are unrelated to this feature and should be reverted before starting. See **Task 0**.

2. **No worktree was created.** You're operating directly in the main working tree. If you prefer isolation, create a worktree via `git worktree add` before Task 0.

3. **Function name.** The mode-selection function in `control-logic.js` is called `evaluate`, not `computeNextMode`. The spec was corrected to match; if you see any stale `computeNextMode` references, rename.

4. **State clock.** `state.now` in `evaluate()` is a unix-seconds timestamp in production (from `Math.floor(Date.now()/1000)`), but existing tests use relative values like `now: 2000`. Use relative values for unit tests; production code paths on the device use real unix seconds.

5. **Test runner.** This project uses `node --test` (Node.js built-in test runner), imported via `const { describe, it } = require('node:test');`. **Not Jest, not Mocha.** All unit tests follow this convention (see `tests/control-logic.test.js` for the canonical example).

6. **Commits per task.** Each task ends with a commit. Do not batch. Use `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>` as the project's existing commit trailer.

7. **First-boot default for the feature.** `we = {}` (all watchdogs disabled) — this protects the existing bootstrap-history drift test and lets the user opt in from the UI.

---

## File structure

### Files to create

| Path | Responsibility |
|---|---|
| `shelly/watchdogs-meta.js` | Watchdog metadata (id, mode, labels, windowSeconds, snoozeTtlSeconds). Loaded by server + playground sim, NOT deployed to device. |
| `server/lib/anomaly-manager.js` | Server-side bridge: consumes MQTT `fired`/`resolved` events, formats reasons, writes Postgres, dispatches push + WS broadcasts, exposes `ack`/`shutdownNow`/`setEnabled`/`getState`/`getHistory`. |
| `server/lib/watchdog-history.js` | Storage abstraction with Postgres primary and in-memory ring buffer fallback. Same pattern as other history features. |
| `server/db/watchdog-events-schema.sql` | CREATE TABLE statement for `watchdog_events`. Applied at DB init. |
| `tests/detect-anomaly.test.js` | Unit tests for the pure `detectAnomaly` function. |
| `tests/watchdog-ban-check.test.js` | Unit tests for the unified `wb` ban check in `evaluate`. |
| `tests/anomaly-manager.test.js` | Unit tests for anomaly-manager methods using mocked MQTT/DB/push. |
| `tests/watchdog-device-config.test.js` | Unit tests for the `we`/`wz`/`wb` validators and `migrateAmToWb`. |
| `tests/simulation/watchdog-scenarios.test.js` | Simulation integration tests via playground simulator. |
| `tests/e2e/watchdog-flow.spec.js` | Playwright e2e: fired → banner → ack → resolved. |

### Files to modify

| Path | Changes |
|---|---|
| `shelly/control-logic.js` | Add `watchdogBanSeconds: 14400` to `DEFAULT_CONFIG`. Add `detectAnomaly` export. Add unified `wb` ban check in `evaluate` placed BEFORE the `fm` early-return. Delete the existing `am` filter block. |
| `shelly/control.js` | Add `WATCHDOG_MODE` const, `publishWatchdogEvent`, `applyBanAndShutdown`, `autoShutdown`, `onWatchdogShutdownNow`, `onWatchdogAck`. Piggyback baseline capture at every `state.mode_start = Date.now()` site. Add the tick block (lazy-prune + override-exit reset + pending check + detection) inside `controlLoop`. Subscribe to the new MQTT `greenhouse/watchdog/cmd` topic. |
| `server/lib/device-config.js` | Add `we`/`wz`/`wb` partial-update validators following the existing per-field pattern. Add `migrateAmToWb` and call it at config load. Delete the existing `am` validator block. |
| `server/lib/mqtt-bridge.js` | Subscribe to `greenhouse/watchdog/event` in the `connect` handler. Dispatch incoming watchdog events to `anomaly-manager.handleDeviceEvent`. Add `publishWatchdogCmd(payload)` helper. |
| `server/lib/push.js` | Add `'watchdog_fired'` to `VALID_CATEGORIES`. Add `buildWatchdogPayload(event)` that composes the notification shape with `type: 'text'` snooze action and "Shutdown now" button. |
| `server/server.js` | Initialize `anomaly-manager` at startup. Add HTTP endpoints: `GET /api/watchdog/state`, `POST /api/watchdog/ack`, `POST /api/watchdog/shutdownnow`, `PUT /api/watchdog/enabled`. All mutations admin-only via the existing `isAdminOrReject()`. Add WebSocket broadcast of `watchdog-state` messages. |
| `playground/sw.js` | Extend `notificationclick` handler with a `data.kind === 'watchdog_fired'` branch that POSTs to `/api/watchdog/ack` or `/api/watchdog/shutdownnow`. |
| `playground/index.html` | Add pending-banner `<template>` hook in `#status`. Replace the current "Allowed modes" checkbox block in device-config view with a new Mode Enablement card. Add an Anomaly watchdogs card under `#settings` → Push notifications. |
| `playground/js/main.js` | Replace `am`-based code with `wb`-based rendering. Add pending-banner rendering + live countdown + submit handlers. Add Mode Enablement card renderer. Add Anomaly watchdogs card renderer (toggles, snooze display, clear-snooze). Subscribe to `watchdog-state` WebSocket messages. |
| `playground/public/style.css` | Styles for the pending banner, the Mode Enablement card, and the Anomaly watchdogs card. |

### Files NOT to modify

- `shelly/deploy.sh` — concatenation mechanism is unchanged; `watchdogs-meta.js` is not added to the device bundle.
- `shelly/control-logic.js` thresholds for existing physical-state exits (`solarExitStallSeconds`, `drainTimeout`, etc.) — this feature layers on top, does not replace.
- `playground/assets/bootstrap-history.json` — first-boot watchdog state is `we = {}`, so the pre-baked snapshot is unaffected.

---

## Task 0: Preflight — revert tunnel-build edits

**Files:**
- Modify (revert): `playground/manifest.webmanifest`, `playground/index.html`, `playground/sw.js`

These three files have uncommitted session edits from earlier PWA tunnel testing (renaming "Helios Canopy" → "Helios Tunnel", adding a temporary inline-reply test button). Revert them cleanly before starting real implementation.

- [ ] **Step 1: Inspect the uncommitted changes**

Run: `git diff playground/manifest.webmanifest playground/index.html playground/sw.js`
Expected: diffs showing the tunnel-build renames and temporary test button. No other files in the diff for this scope.

- [ ] **Step 2: Revert all three files**

Run: `git checkout HEAD -- playground/manifest.webmanifest playground/index.html playground/sw.js`
Expected: clean working tree for those three files.

- [ ] **Step 3: Verify**

Run: `git status playground/manifest.webmanifest playground/index.html playground/sw.js`
Expected: no changes shown for these files. The tunnel-related working tree is now clean.

- [ ] **Step 4: No commit needed**

Reverting uncommitted changes doesn't require a commit.

---

## Task 1: Create `shelly/watchdogs-meta.js`

**Files:**
- Create: `shelly/watchdogs-meta.js`

**Purpose:** Single source of truth for watchdog metadata (labels, windows, snooze TTLs) shared between server and playground simulator. NOT concatenated into the device script by `deploy.sh` — the device never needs to know these values at runtime.

- [ ] **Step 1: Create the file with the full metadata**

```js
// shelly/watchdogs-meta.js
//
// Watchdog metadata — shared between server and playground simulator.
// NOT concatenated into the device script by deploy.sh. The device
// only carries the three watchdog short ids (sng/scs/ggr) and a
// mapping to mode codes; all human-readable labels and TTLs live here.

var WATCHDOGS = [
  {
    id: "sng",
    mode: "SOLAR_CHARGING",
    label: "No tank gain",
    shortLabel: "Tank not heating",
    windowSeconds: 600,
    snoozeTtlSeconds: 7200
  },
  {
    id: "scs",
    mode: "SOLAR_CHARGING",
    label: "Collector stuck",
    shortLabel: "Collector flow stuck",
    windowSeconds: 300,
    snoozeTtlSeconds: 3600
  },
  {
    id: "ggr",
    mode: "GREENHOUSE_HEATING",
    label: "No greenhouse rise",
    shortLabel: "Greenhouse not warming",
    windowSeconds: 900,
    snoozeTtlSeconds: 43200
  }
];

var WATCHDOG_IDS = ["sng", "scs", "ggr"];

function getWatchdog(id) {
  for (var i = 0; i < WATCHDOGS.length; i++) {
    if (WATCHDOGS[i].id === id) return WATCHDOGS[i];
  }
  return null;
}

if (typeof module !== "undefined") {
  module.exports = {
    WATCHDOGS: WATCHDOGS,
    WATCHDOG_IDS: WATCHDOG_IDS,
    getWatchdog: getWatchdog
  };
}
```

- [ ] **Step 2: Verify the file is valid CommonJS**

Run: `node -e "console.log(require('./shelly/watchdogs-meta.js').WATCHDOG_IDS);"`
Expected output: `[ 'sng', 'scs', 'ggr' ]`

- [ ] **Step 3: Commit**

```bash
git add shelly/watchdogs-meta.js
git commit -m "$(cat <<'EOF'
Add shelly/watchdogs-meta.js with watchdog metadata

Shared metadata for the three v1 watchdogs (sng/scs/ggr). Loaded by
server and playground simulator; not concatenated into the device
script so the 16KB Shelly budget is untouched.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `we`/`wz`/`wb` validators to `server/lib/device-config.js`

**Files:**
- Modify: `server/lib/device-config.js` (add new field validators after the existing ones)
- Test: `tests/watchdog-device-config.test.js` (new)

**Purpose:** Accept partial updates for the three new config fields. Semantics:
- `null` for the whole field → reset to empty object.
- `0` or `null` for a specific key → delete that key.
- Positive number → set that key.

- [ ] **Step 1: Write the failing test**

Create `tests/watchdog-device-config.test.js`:

```js
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const deviceConfig = require('../server/lib/device-config.js');

describe('watchdog config validators', () => {
  before(() => {
    // Ensure we start from a known state
    deviceConfig.updateConfig({ we: {}, wz: null, wb: null }, () => {});
  });

  it('accepts we enable flags', (t, done) => {
    deviceConfig.updateConfig({ we: { sng: 1, scs: 0, ggr: 1 } }, (err, cfg) => {
      assert.ifError(err);
      assert.deepStrictEqual(cfg.we, { sng: 1, scs: 0, ggr: 1 });
      done();
    });
  });

  it('accepts wz snooze timestamps', (t, done) => {
    deviceConfig.updateConfig({ wz: { ggr: 1800000000 } }, (err, cfg) => {
      assert.ifError(err);
      assert.strictEqual(cfg.wz.ggr, 1800000000);
      done();
    });
  });

  it('removes wz entry when value is 0', (t, done) => {
    deviceConfig.updateConfig({ wz: { ggr: 1800000000 } }, () => {
      deviceConfig.updateConfig({ wz: { ggr: 0 } }, (err, cfg) => {
        assert.ifError(err);
        assert.strictEqual(cfg.wz.ggr, undefined);
        done();
      });
    });
  });

  it('accepts wb ban timestamps', (t, done) => {
    deviceConfig.updateConfig({ wb: { GH: 1800000000 } }, (err, cfg) => {
      assert.ifError(err);
      assert.strictEqual(cfg.wb.GH, 1800000000);
      done();
    });
  });

  it('accepts sentinel 9999999999 as permanent ban', (t, done) => {
    deviceConfig.updateConfig({ wb: { SC: 9999999999 } }, (err, cfg) => {
      assert.ifError(err);
      assert.strictEqual(cfg.wb.SC, 9999999999);
      done();
    });
  });

  it('removes wb entry when value is 0', (t, done) => {
    deviceConfig.updateConfig({ wb: { GH: 1800000000 } }, () => {
      deviceConfig.updateConfig({ wb: { GH: 0 } }, (err, cfg) => {
        assert.ifError(err);
        assert.strictEqual(cfg.wb.GH, undefined);
        done();
      });
    });
  });

  it('rejects unknown watchdog ids in we', (t, done) => {
    deviceConfig.updateConfig({ we: { bogus: 1, sng: 1 } }, (err, cfg) => {
      assert.ifError(err);
      assert.strictEqual(cfg.we.bogus, undefined);
      assert.strictEqual(cfg.we.sng, 1);
      done();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/watchdog-device-config.test.js`
Expected: FAIL — fields `we`, `wz`, `wb` are not yet validated, the updateConfig call silently drops them.

- [ ] **Step 3: Add the three validator blocks in `server/lib/device-config.js`**

Open `server/lib/device-config.js`. Find the existing validator block (around lines 157-186 — `ce`, `ea`, `fm`, `am`, `mo`). After the existing `mo` block and before the function closes with `config.v++; ...`, insert:

```js
  // we (watchdogs_enabled): object with 0/1 values per watchdog id.
  // null clears all; unknown ids are silently dropped.
  if (newConfig.we !== undefined) {
    if (newConfig.we === null) {
      config.we = {};
    } else if (typeof newConfig.we === 'object') {
      var we = {};
      var weIds = ['sng', 'scs', 'ggr'];
      for (var wi = 0; wi < weIds.length; wi++) {
        var weId = weIds[wi];
        if (newConfig.we[weId] !== undefined) {
          we[weId] = newConfig.we[weId] ? 1 : 0;
        } else if (config.we && config.we[weId] !== undefined) {
          we[weId] = config.we[weId];
        }
      }
      config.we = we;
    }
  }

  // wz (watchdog_snooze): object with unix-seconds values.
  // null clears all; 0 or null for a specific key removes that entry.
  if (newConfig.wz !== undefined) {
    if (newConfig.wz === null) {
      config.wz = {};
    } else if (typeof newConfig.wz === 'object') {
      config.wz = config.wz || {};
      var wzIds = ['sng', 'scs', 'ggr'];
      for (var zi = 0; zi < wzIds.length; zi++) {
        var wzId = wzIds[zi];
        var wzVal = newConfig.wz[wzId];
        if (wzVal === 0 || wzVal === null) {
          delete config.wz[wzId];
        } else if (typeof wzVal === 'number' && wzVal > 0) {
          config.wz[wzId] = wzVal;
        }
      }
    }
  }

  // wb (mode_bans): object with unix-seconds values. Sentinel 9999999999
  // represents a user-set permanent ban. 0 or null for a specific key
  // removes that entry. null for the field clears all bans.
  if (newConfig.wb !== undefined) {
    if (newConfig.wb === null) {
      config.wb = {};
    } else if (typeof newConfig.wb === 'object') {
      config.wb = config.wb || {};
      var wbKeys = ['I', 'SC', 'GH', 'AD', 'EH'];
      for (var bi = 0; bi < wbKeys.length; bi++) {
        var wbKey = wbKeys[bi];
        var wbVal = newConfig.wb[wbKey];
        if (wbVal === 0 || wbVal === null) {
          delete config.wb[wbKey];
        } else if (typeof wbVal === 'number' && wbVal > 0) {
          config.wb[wbKey] = wbVal;
        }
      }
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/watchdog-device-config.test.js`
Expected: all 7 tests pass.

- [ ] **Step 5: Run the full device-config test suite to confirm no regression**

Run: `node --test tests/device-config.test.js tests/watchdog-device-config.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/lib/device-config.js tests/watchdog-device-config.test.js
git commit -m "$(cat <<'EOF'
Add we/wz/wb validators to device-config.js

Accept partial updates for the three new watchdog config fields with
consistent "0 or null removes entry" semantics. Unknown watchdog ids
and unknown mode codes are silently dropped.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Add `migrateAmToWb` and remove `am` validator

**Files:**
- Modify: `server/lib/device-config.js`
- Test: `tests/watchdog-device-config.test.js` (extend)

**Purpose:** Translate legacy `am` arrays to `wb` entries with the permanent sentinel on every config load, then remove the `am` validator block so new writes can't reintroduce it.

- [ ] **Step 1: Write the failing migration test**

Append to `tests/watchdog-device-config.test.js`:

```js
describe('am → wb migration', () => {
  it('migrates a subset am array to wb sentinel entries', () => {
    const { migrateAmToWb } = require('../server/lib/device-config.js');
    const cfg = { am: ['I', 'SC'], wb: {} };
    migrateAmToWb(cfg);
    assert.strictEqual(cfg.wb.GH, 9999999999);
    assert.strictEqual(cfg.wb.AD, 9999999999);
    assert.strictEqual(cfg.wb.EH, 9999999999);
    assert.strictEqual(cfg.wb.I, undefined);
    assert.strictEqual(cfg.wb.SC, undefined);
    assert.strictEqual(cfg.am, undefined);
  });

  it('is idempotent on configs with no am', () => {
    const { migrateAmToWb } = require('../server/lib/device-config.js');
    const cfg = { wb: { GH: 1800000000 } };
    migrateAmToWb(cfg);
    assert.deepStrictEqual(cfg.wb, { GH: 1800000000 });
    assert.strictEqual(cfg.am, undefined);
  });

  it('is a no-op when am contains all modes', () => {
    const { migrateAmToWb } = require('../server/lib/device-config.js');
    const cfg = { am: ['I', 'SC', 'GH', 'AD', 'EH'] };
    migrateAmToWb(cfg);
    assert.strictEqual(cfg.wb, undefined);
    assert.strictEqual(cfg.am, undefined);
  });

  it('is a no-op when am is null', () => {
    const { migrateAmToWb } = require('../server/lib/device-config.js');
    const cfg = { am: null };
    migrateAmToWb(cfg);
    assert.strictEqual(cfg.wb, undefined);
    assert.strictEqual(cfg.am, undefined);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/watchdog-device-config.test.js`
Expected: FAIL — `migrateAmToWb` is not exported.

- [ ] **Step 3: Add the migration function to `server/lib/device-config.js`**

Near the top of the file (after imports, before functions), add:

```js
var ALL_MODES_FOR_MIGRATION = ['I', 'SC', 'GH', 'AD', 'EH'];
var WB_PERMANENT_SENTINEL = 9999999999;

function migrateAmToWb(cfg) {
  if (cfg.am && Array.isArray(cfg.am) &&
      cfg.am.length > 0 && cfg.am.length < ALL_MODES_FOR_MIGRATION.length) {
    cfg.wb = cfg.wb || {};
    for (var i = 0; i < ALL_MODES_FOR_MIGRATION.length; i++) {
      var mode = ALL_MODES_FOR_MIGRATION[i];
      if (cfg.am.indexOf(mode) === -1) {
        cfg.wb[mode] = WB_PERMANENT_SENTINEL;
      }
    }
  }
  delete cfg.am;
  return cfg;
}
```

Then call `migrateAmToWb(config)` in the config-load path (find the function that reads persisted config — likely `loadConfig` or similar — and call `migrateAmToWb` right after deserialization).

Export `migrateAmToWb` from the module's `module.exports` block alongside the existing exports:

```js
module.exports = {
  // ... existing exports ...
  migrateAmToWb: migrateAmToWb,
  WB_PERMANENT_SENTINEL: WB_PERMANENT_SENTINEL
};
```

- [ ] **Step 4: Remove the existing `am` validator block**

In `server/lib/device-config.js`, find and **delete** the block that reads `newConfig.am` (around lines 166-181 from the original grep). The spec confirms this is safe: `am` is no longer written by any caller after the UI rework in Task 27.

Also delete any reference to `config.am` in the default config object. Replace with `config.wb = config.wb || {};` if needed.

- [ ] **Step 5: Run the full device-config test suite**

Run: `node --test tests/device-config.test.js tests/watchdog-device-config.test.js`
Expected: all tests pass, including the new migration tests.

- [ ] **Step 6: Commit**

```bash
git add server/lib/device-config.js tests/watchdog-device-config.test.js
git commit -m "$(cat <<'EOF'
Migrate am → wb and remove am validator

On config load, translate any legacy am array to wb entries with the
permanent sentinel value (9999999999). Remove the am validator so new
writes can no longer reintroduce am. Migration is idempotent and safe
on already-migrated configs.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Add `watchdogBanSeconds` to `DEFAULT_CONFIG`

**Files:**
- Modify: `shelly/control-logic.js` (around lines 85-108 where `DEFAULT_CONFIG` lives)

**Purpose:** Device-side constant for the uniform 4-hour ban TTL. Single source of truth for both simulator and device.

- [ ] **Step 1: Open `shelly/control-logic.js` and locate `DEFAULT_CONFIG`**

Run: `grep -n 'DEFAULT_CONFIG' shelly/control-logic.js | head`
Expected: line reference near 85.

- [ ] **Step 2: Add the field after `drainTimeout`**

In `DEFAULT_CONFIG`, after `drainTimeout: 180`, add:

```js
  drainTimeout: 180,
  // Uniform watchdog cool-off ban duration in seconds (4 hours).
  // Applied when a watchdog fires and auto-shutdown or user-triggered
  // "Shutdown now" executes. Mode re-entry is blocked until this
  // duration elapses or the ban is explicitly cleared via the UI.
  watchdogBanSeconds: 14400
};
```

(Note: change the line above to end with `,` instead of `}`.)

- [ ] **Step 3: Verify via a minimal smoke test**

Run: `node -e "const cl = require('./shelly/control-logic.js'); console.log(cl.DEFAULT_CONFIG.watchdogBanSeconds);"`
Expected: `14400`

- [ ] **Step 4: Run the existing control-logic tests to confirm no regression**

Run: `node --test tests/control-logic.test.js`
Expected: all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add shelly/control-logic.js
git commit -m "$(cat <<'EOF'
Add watchdogBanSeconds to DEFAULT_CONFIG (4h default)

Uniform cool-off ban duration shared between device and simulator.
Single source of truth for tuning — future per-watchdog TTLs would
move into watchdogs-meta.js if needed.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add `detectAnomaly` pure function

**Files:**
- Modify: `shelly/control-logic.js` (add new export)
- Test: `tests/detect-anomaly.test.js` (new)

**Purpose:** Pure detection logic with zero allocations on the hot path, zero strings on device, early-exits for `ce=false` / `mo.ss=true`, and first-fires-wins priority by shortest window.

- [ ] **Step 1: Write the failing test**

Create `tests/detect-anomaly.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { detectAnomaly } = require('../shelly/control-logic.js');

function entry(overrides) {
  return Object.assign({
    mode: 'SOLAR_CHARGING',
    at: 1000,
    tankTop: 50,
    collector: 80,
    greenhouse: 10
  }, overrides || {});
}

function sensors(overrides) {
  return Object.assign({
    collector: 80,
    tank_top: 50,
    tank_bottom: 40,
    greenhouse: 10,
    outdoor: 5
  }, overrides || {});
}

function cfg(overrides) {
  return Object.assign({
    ce: true,
    we: { sng: 1, scs: 1, ggr: 1 },
    wz: {},
    mo: null
  }, overrides || {});
}

describe('detectAnomaly', () => {
  it('returns null when entry is null', () => {
    assert.strictEqual(detectAnomaly(null, 2000, sensors(), cfg()), null);
  });

  it('returns null when ce is false (commissioning)', () => {
    // Would otherwise fire scs
    assert.strictEqual(
      detectAnomaly(entry({ at: 1000 }), 1400, sensors({ collector: 80 }),
                    cfg({ ce: false })),
      null
    );
  });

  it('returns null when mo.ss=true (suppressSafety)', () => {
    assert.strictEqual(
      detectAnomaly(entry({ at: 1000 }), 1400, sensors({ collector: 80 }),
                    cfg({ mo: { a: true, ss: true, ex: 9999999999 } })),
      null
    );
  });

  it('detects scs: collector not dropping after 5 min', () => {
    // entry collector 80, current collector 79 (delta 1, < 3 threshold)
    // elapsed 300s = window exactly met
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 79 }),
      cfg()
    );
    assert.strictEqual(result, 'scs');
  });

  it('does not fire scs when collector has dropped enough', () => {
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 76 }),  // delta 4 > 3
      cfg()
    );
    assert.strictEqual(result, null);
  });

  it('detects sng: tank_top not rising after 10 min', () => {
    const result = detectAnomaly(
      entry({ at: 1000, tankTop: 50, collector: 80 }),
      1600,
      sensors({ tank_top: 50.2, collector: 70 }),  // collector OK (dropped 10), tank not (rose 0.2)
      cfg()
    );
    assert.strictEqual(result, 'sng');
  });

  it('fires scs before sng when both conditions hold at t=600', () => {
    // Both windows elapsed, both conditions met
    const result = detectAnomaly(
      entry({ at: 1000, tankTop: 50, collector: 80 }),
      1600,
      sensors({ tank_top: 50, collector: 80 }),
      cfg()
    );
    assert.strictEqual(result, 'scs');  // 5-min window wins over 10-min
  });

  it('returns null when scs is disabled', () => {
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 80 }),
      cfg({ we: { scs: 0, sng: 1, ggr: 1 } })
    );
    assert.strictEqual(result, null);
  });

  it('returns null when scs is snoozed', () => {
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 80 }),
      cfg({ wz: { scs: 2000 } })  // snoozed until now+700s
    );
    assert.strictEqual(result, null);
  });

  it('fires scs when snooze has expired', () => {
    const result = detectAnomaly(
      entry({ at: 1000, collector: 80 }),
      1300,
      sensors({ collector: 80 }),
      cfg({ wz: { scs: 1200 } })  // expired before now=1300
    );
    assert.strictEqual(result, 'scs');
  });

  it('detects ggr: greenhouse not rising after 15 min', () => {
    const result = detectAnomaly(
      entry({ mode: 'GREENHOUSE_HEATING', at: 1000, greenhouse: 8 }),
      1900,  // 900s elapsed
      sensors({ greenhouse: 8.2 }),  // delta 0.2 < 0.5
      cfg()
    );
    assert.strictEqual(result, 'ggr');
  });

  it('does not fire ggr when greenhouse has risen enough', () => {
    const result = detectAnomaly(
      entry({ mode: 'GREENHOUSE_HEATING', at: 1000, greenhouse: 8 }),
      1900,
      sensors({ greenhouse: 8.7 }),  // delta 0.7 > 0.5
      cfg()
    );
    assert.strictEqual(result, null);
  });

  it('returns null before window has elapsed', () => {
    const result = detectAnomaly(
      entry({ mode: 'GREENHOUSE_HEATING', at: 1000 }),
      1100,  // only 100s elapsed
      sensors({ greenhouse: 10 }),  // no rise
      cfg()
    );
    assert.strictEqual(result, null);
  });

  it('returns null for modes without watchdogs (ACTIVE_DRAIN)', () => {
    const result = detectAnomaly(
      entry({ mode: 'ACTIVE_DRAIN', at: 1000 }),
      1900,
      sensors(),
      cfg()
    );
    assert.strictEqual(result, null);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/detect-anomaly.test.js`
Expected: FAIL — `detectAnomaly` is not exported from `control-logic.js`.

- [ ] **Step 3: Add `detectAnomaly` to `shelly/control-logic.js`**

Add a new section in `shelly/control-logic.js`. A good location is right before the "Valve polarity translation" section or right after the main `evaluate` function. Paste:

```js
// ── Watchdog anomaly detection ──
//
// Pure: no side effects, no Shelly APIs, no Date.now.
// Returns one of "sng" / "scs" / "ggr" (the watchdog id that should
// fire this tick) or null. Caller (control.js) is responsible for
// pending state + timer management.
//
// Parameters:
//   entry : { mode, at, tankTop, collector, greenhouse } | null
//           at = unix seconds (mode entry time)
//   now   : unix seconds (caller passes Date.now()/1000 or test clock)
//   s     : sensor snapshot { collector, tank_top, greenhouse, ... }
//   cfg   : device config subset { ce, we, wz, mo }
//
// Early-exits:
//   - null entry  -> not in a mode yet
//   - !cfg.ce     -> controls disabled (commissioning)
//   - mo.ss=true  -> user explicitly suppressing safety
//
// Priority: first-fires-wins by shortest window.
function detectAnomaly(entry, now, s, cfg) {
  if (!entry) return null;
  if (!cfg.ce) return null;
  if (cfg.mo && cfg.mo.a && cfg.mo.ss) return null;

  var el = now - entry.at;
  var we = cfg.we || {};
  var wz = cfg.wz || {};

  if (entry.mode === "SOLAR_CHARGING") {
    if (we.scs && !(wz.scs > now) && el >= 300 &&
        (entry.collector - s.collector) < 3) return "scs";
    if (we.sng && !(wz.sng > now) && el >= 600 &&
        (s.tank_top - entry.tankTop) < 0.5) return "sng";
  } else if (entry.mode === "GREENHOUSE_HEATING") {
    if (we.ggr && !(wz.ggr > now) && el >= 900 &&
        (s.greenhouse - entry.greenhouse) < 0.5) return "ggr";
  }
  return null;
}
```

Then add `detectAnomaly` to the `module.exports` block at the bottom:

```js
module.exports = {
  // ... existing exports ...
  detectAnomaly: detectAnomaly
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/detect-anomaly.test.js`
Expected: all 13 tests pass.

- [ ] **Step 5: Run existing control-logic tests to confirm no regression**

Run: `node --test tests/control-logic.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add shelly/control-logic.js tests/detect-anomaly.test.js
git commit -m "$(cat <<'EOF'
Add detectAnomaly pure function to control-logic

Detects three watchdog conditions at mode entry: SC-no-gain,
SC-collector-stuck, GH-no-greenhouse-rise. Pure, zero allocations on
hot path, early-exits for ce=false and mo.ss=true. First-fires-wins
priority by shortest window (scs before sng at t=600).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Add unified `wb` ban check in `evaluate` and delete old `am` filter

**Files:**
- Modify: `shelly/control-logic.js`
- Test: `tests/watchdog-ban-check.test.js` (new)

**Purpose:** Replace the existing `am` filter at `control-logic.js:420-433` with a unified `wb` check placed BEFORE the `fm` early-return so that forced mode also respects bans. Strict semantics: the ban is absolute at the mode-automation level; only explicit ban clearing allows re-entry.

- [ ] **Step 1: Write the failing test**

Create `tests/watchdog-ban-check.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES } = require('../shelly/control-logic.js');

function makeState(overrides) {
  const base = {
    temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 5, outdoor: 10 },
    currentMode: MODES.IDLE,
    modeEnteredAt: 0,
    now: 2000,
    collectorsDrained: false,
    lastRefillAttempt: 0,
    emergencyHeatingActive: false,
    sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
  };
  return Object.assign({}, base, overrides);
}

describe('wb ban check in evaluate', () => {
  it('allows mode when no wb entry', () => {
    const cfg = { ce: true };
    const result = evaluate(makeState({}), cfg);
    // Solar charging would normally fire on collector > tank_bottom+10
    assert.notStrictEqual(result.nextMode, MODES.IDLE);
  });

  it('blocks SOLAR_CHARGING when wb.SC > now', () => {
    const cfg = { ce: true, wb: { SC: 3000 } };
    const result = evaluate(makeState({}), cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('allows mode when wb entry is in the past (stale — real prune happens on device)', () => {
    const cfg = { ce: true, wb: { SC: 1000 } };
    const result = evaluate(makeState({}), cfg);
    assert.notStrictEqual(result.nextMode, MODES.IDLE);
  });

  it('blocks GREENHOUSE_HEATING when wb.GH > now', () => {
    const state = makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    });
    const cfg = { ce: true, wb: { GH: 3000 } };
    const result = evaluate(state, cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('treats permanent sentinel 9999999999 as banned', () => {
    const cfg = { ce: true, wb: { SC: 9999999999 } };
    const result = evaluate(makeState({}), cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('fm cannot force a banned mode', () => {
    const cfg = { ce: true, fm: 'GH', wb: { GH: 3000 } };
    const result = evaluate(makeState({}), cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('fm works normally when mode is not banned', () => {
    const cfg = { ce: true, fm: 'GH' };
    const result = evaluate(makeState({}), cfg);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('mo.ss=true does NOT bypass wb ban', () => {
    const cfg = {
      ce: true,
      wb: { SC: 3000 },
      mo: { a: true, ss: true, ex: 9999999999 }
    };
    const result = evaluate(makeState({}), cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/watchdog-ban-check.test.js`
Expected: FAIL — the `wb` check does not exist yet, and the existing `am`-only filter does not enforce bans.

- [ ] **Step 3: Add the ban check and delete the old `am` filter**

In `shelly/control-logic.js`, find the `evaluate` function's forced-mode block at around line 395-407:

```js
  // ── Forced mode override (for staged deployment / manual testing) ──
  if (dc && dc.fm) {
    var forcedMode = expandModeCode(dc.fm);
    if (MODES[forcedMode]) {
      pumpMode = MODES[forcedMode];
      ...
      return makeResult(pumpMode, flags, dc);
    }
  }
```

Add a helper at the top of the file (near other helpers):

```js
// Map MODES enum value back to short code for wb lookup
function shortCodeOf(mode) {
  if (mode === MODES.IDLE) return "I";
  if (mode === MODES.SOLAR_CHARGING) return "SC";
  if (mode === MODES.GREENHOUSE_HEATING) return "GH";
  if (mode === MODES.ACTIVE_DRAIN) return "AD";
  if (mode === MODES.EMERGENCY_HEATING) return "EH";
  return null;
}
```

**Inside `evaluate`, insert the ban check BEFORE the `fm` block** so that `fm` also respects bans:

```js
  // ── Unified mode ban check (wb) — strict: fm and mo.ss do NOT bypass ──
  // Replaces the legacy am filter. Runs BEFORE the fm early-return so
  // that forced mode cannot override a ban. The lazy prune of expired
  // wb entries happens on the device in control.js controlLoop.
  if (dc && dc.wb) {
    // Determine candidate next mode. For fm case, it's expandModeCode(dc.fm).
    // For normal evaluation, we need to check the mode we're ABOUT to return.
    // Simplest approach: do the check twice — once for fm candidate, once
    // for the natural next mode just before returning.
    if (dc.fm) {
      var fmCode = dc.fm;
      if (dc.wb[fmCode] && dc.wb[fmCode] > state.now) {
        return makeResult(MODES.IDLE, flags, dc);
      }
    }
  }

  // ── Forced mode override (for staged deployment / manual testing) ──
  if (dc && dc.fm) {
    // ... existing block unchanged ...
  }
```

**Then, at the end of `evaluate`**, right before the final `return result;`, add a second ban check for the naturally-chosen mode:

```js
  // Natural-mode ban check (post-evaluation)
  if (dc && dc.wb && result.nextMode !== MODES.IDLE) {
    var natCode = shortCodeOf(result.nextMode);
    if (natCode && dc.wb[natCode] && dc.wb[natCode] > state.now) {
      flags.solarChargePeakTankTop = null;
      flags.solarChargePeakTankTopAt = 0;
      return makeResult(MODES.IDLE, flags, dc);
    }
  }

  return result;
}
```

**Delete the old `am` filter block** (lines ~420-433 of the original file):

```js
  // ── DELETE THIS BLOCK ──
  // Allowed modes filter (for staged deployment)
  if (dc && dc.am && dc.am.length > 0) {
    var allowed = false;
    for (var ami = 0; ami < dc.am.length; ami++) {
      if (expandModeCode(dc.am[ami]) === result.nextMode) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      flags.solarChargePeakTankTop = null;
      flags.solarChargePeakTankTopAt = 0;
      return makeResult(MODES.IDLE, flags, dc);
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/watchdog-ban-check.test.js`
Expected: all 8 tests pass.

- [ ] **Step 5: Run the full control-logic suite**

Run: `node --test tests/control-logic.test.js tests/detect-anomaly.test.js tests/watchdog-ban-check.test.js`
Expected: all tests pass. Watch particularly for any existing `am`-related tests in `control-logic.test.js` that may now fail — they need to be updated to use `wb` with sentinel values.

- [ ] **Step 6: If existing am tests break, update them**

If `grep -n "\bam\b" tests/control-logic.test.js` returns any lines that expect the old `am` filter, update them to use `wb` with the sentinel value `9999999999` instead.

- [ ] **Step 7: Commit**

```bash
git add shelly/control-logic.js tests/watchdog-ban-check.test.js tests/control-logic.test.js
git commit -m "$(cat <<'EOF'
Replace am filter with unified wb ban check

wb is now the single source of truth for "is this mode allowed".
The check runs both for fm candidates (before fm early-return) and
for naturally-evaluated modes (at end of evaluate). Strict semantics:
fm and mo.ss do not bypass wb. Only explicit ban clearing allows
re-entry. Legacy am filter deleted.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Create `server/lib/anomaly-manager.js` skeleton with `formatReason`

**Files:**
- Create: `server/lib/anomaly-manager.js`
- Test: `tests/anomaly-manager.test.js` (new)

**Purpose:** Module skeleton with internal state, the `formatReason` text formatter, and the `init` function. Subsequent tasks add methods.

- [ ] **Step 1: Write the failing test**

Create `tests/anomaly-manager.test.js`:

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const anomalyManager = require('../server/lib/anomaly-manager.js');

describe('anomaly-manager formatReason', () => {
  it('formats scs reason', () => {
    const text = anomalyManager.formatReason({
      id: 'scs', el: 305, dC: 1.2
    });
    assert.match(text, /Collector only -1\.2°C after 5:05/);
  });

  it('formats sng reason', () => {
    const text = anomalyManager.formatReason({
      id: 'sng', el: 612, dT: 0.3
    });
    assert.match(text, /Tank only \+0\.3°C after 10:12/);
  });

  it('formats ggr reason', () => {
    const text = anomalyManager.formatReason({
      id: 'ggr', el: 932, dG: 0.2
    });
    assert.match(text, /Greenhouse only \+0\.2°C after 15:32/);
  });

  it('pads seconds with leading zero', () => {
    const text = anomalyManager.formatReason({
      id: 'ggr', el: 905, dG: 0.1
    });
    assert.match(text, /15:05/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/anomaly-manager.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create `server/lib/anomaly-manager.js`**

```js
// server/lib/anomaly-manager.js
//
// Server-side bridge for the watchdog anomaly detection feature.
// Receives device MQTT events (fired/resolved), formats human-readable
// reasons, persists history to Postgres (with ring-buffer fallback),
// dispatches push notifications and WebSocket state broadcasts, and
// exposes ack/shutdownNow/setEnabled/getState/getHistory for the HTTP
// endpoint handlers.

'use strict';

const { WATCHDOGS, WATCHDOG_IDS, getWatchdog } = require('../../shelly/watchdogs-meta.js');

// Module-scoped state — set by init()
let _deps = null;         // { deviceConfig, mqttBridge, push, wsBroadcast, history, log }
let _pending = null;      // { id, firedAt, mode, triggerReason, dbEventId } | null
let _lastSnapshot = {};   // { we, wz, wb } cached from latest device config

function init(deps) {
  _deps = deps;
  _pending = null;
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function f1(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function formatReason(e) {
  const m = Math.floor(e.el / 60) + ':' + pad2(e.el % 60);
  if (e.id === 'sng') {
    return 'Tank only +' + f1(e.dT) + '°C after ' + m + ' (expected ≥+0.5°C)';
  }
  if (e.id === 'scs') {
    return 'Collector only -' + f1(e.dC) + '°C after ' + m + ' (expected ≥-3°C)';
  }
  if (e.id === 'ggr') {
    return 'Greenhouse only +' + f1(e.dG) + '°C after ' + m + ' (expected ≥+0.5°C)';
  }
  return 'Unknown watchdog: ' + e.id;
}

function getPending() {
  return _pending;
}

function updateSnapshot(cfg) {
  _lastSnapshot = {
    we: cfg.we || {},
    wz: cfg.wz || {},
    wb: cfg.wb || {}
  };
}

module.exports = {
  init,
  formatReason,
  getPending,
  updateSnapshot,
  // More methods added in subsequent tasks:
  // handleDeviceEvent, ack, shutdownNow, setEnabled, getState, getHistory
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/anomaly-manager.test.js`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/anomaly-manager.js tests/anomaly-manager.test.js
git commit -m "$(cat <<'EOF'
Add anomaly-manager skeleton with formatReason

Server-side bridge module with init, formatReason text formatter,
and internal state slots for pending + config snapshot. Subsequent
tasks add handleDeviceEvent, ack, shutdownNow, setEnabled, getState,
and getHistory.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Add `handleDeviceEvent` for `fired` events

**Files:**
- Modify: `server/lib/anomaly-manager.js`
- Modify: `tests/anomaly-manager.test.js`

**Purpose:** Receive `{t:"fired", id, mode, el, dT, dC, dG, ts}` from the device via MQTT, format the reason, persist to history, set `_pending`, dispatch push + WS.

- [ ] **Step 1: Write the failing test**

Append to `tests/anomaly-manager.test.js`:

```js
describe('anomaly-manager handleDeviceEvent fired', () => {
  function makeMocks() {
    const calls = { history: [], push: [], ws: [] };
    const history = {
      insert: (row) => {
        calls.history.push(row);
        return Promise.resolve({ id: calls.history.length });
      },
      update: (id, patch) => {
        calls.history.push({ _update: id, ...patch });
        return Promise.resolve();
      }
    };
    const push = {
      sendByCategory: (category, payload) => {
        calls.push.push({ category, payload });
        return Promise.resolve();
      }
    };
    const wsBroadcast = (msg) => calls.ws.push(msg);
    return { history, push, wsBroadcast, calls };
  }

  it('sets _pending and dispatches push + ws on fired event', async () => {
    const { history, push, wsBroadcast, calls } = makeMocks();
    anomalyManager.init({
      history, push, wsBroadcast,
      deviceConfig: { getConfig: () => ({}) },
      mqttBridge: { publishWatchdogCmd: () => {} },
      log: { info: () => {}, error: () => {} }
    });

    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'ggr', mode: 'GREENHOUSE_HEATING',
      el: 905, dT: 0.3, dC: 0, dG: 0.2, ts: 1700000000
    });

    assert.strictEqual(calls.history.length, 1);
    assert.strictEqual(calls.history[0].watchdog_id, 'ggr');
    assert.match(calls.history[0].trigger_reason, /Greenhouse only \+0\.2°C/);

    assert.strictEqual(calls.push.length, 1);
    assert.strictEqual(calls.push[0].category, 'watchdog_fired');

    assert.strictEqual(calls.ws.length, 1);
    assert.strictEqual(calls.ws[0].type, 'watchdog-state');
    assert.ok(calls.ws[0].pending);
    assert.strictEqual(calls.ws[0].pending.id, 'ggr');

    const pending = anomalyManager.getPending();
    assert.strictEqual(pending.id, 'ggr');
    assert.strictEqual(pending.dbEventId, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/anomaly-manager.test.js`
Expected: FAIL — `handleDeviceEvent` is not yet exported.

- [ ] **Step 3: Add `handleDeviceEvent` to `server/lib/anomaly-manager.js`**

Add the function before the `module.exports` block:

```js
async function handleDeviceEvent(msg) {
  if (!_deps) throw new Error('anomaly-manager not initialized');
  if (msg.t === 'fired') {
    await _handleFired(msg);
  } else if (msg.t === 'resolved') {
    await _handleResolved(msg);
  }
}

async function _handleFired(msg) {
  const triggerReason = formatReason(msg);
  const row = {
    watchdog_id: msg.id,
    mode: msg.mode,
    fired_at: new Date(msg.ts * 1000),
    trigger_reason: triggerReason,
    resolution: null,
    resolved_at: null,
    snooze_until: null,
    snooze_reason: null,
    resolved_by: null
  };
  const { id: dbEventId } = await _deps.history.insert(row);

  _pending = {
    id: msg.id,
    firedAt: msg.ts,
    mode: msg.mode,
    triggerReason,
    dbEventId
  };

  // Push notification (fire-and-forget, logged on failure)
  _deps.push.sendByCategory('watchdog_fired',
    _buildNotificationPayload(_pending)
  ).catch(err => _deps.log.error('watchdog push failed', { error: err.message }));

  // WebSocket broadcast
  _deps.wsBroadcast({
    type: 'watchdog-state',
    pending: _pending,
    watchdogs: WATCHDOG_IDS,
    snapshot: _lastSnapshot
  });
}

async function _handleResolved(msg) {
  // Find the row: prefer the NULL-resolution one for this watchdog id,
  // otherwise fall back to the most recent for audit completeness.
  const resolvedAt = new Date(msg.ts * 1000);
  let rowId = null;
  if (_pending && _pending.id === msg.id) {
    rowId = _pending.dbEventId;
  }
  if (rowId) {
    await _deps.history.update(rowId, {
      resolution: msg.how,
      resolved_at: resolvedAt
    });
  }
  if (_pending && _pending.id === msg.id) {
    _pending = null;
  }
  _deps.wsBroadcast({
    type: 'watchdog-state',
    pending: _pending,
    watchdogs: WATCHDOG_IDS,
    snapshot: _lastSnapshot
  });
}

function _buildNotificationPayload(pending) {
  const meta = getWatchdog(pending.id);
  return {
    title: 'Watchdog fired — ' + (meta ? meta.shortLabel : pending.id),
    body:  pending.triggerReason + '. Auto-shutdown in 5 min.',
    icon:  'assets/notif-watchdog.png',
    badge: 'assets/badge-72.png',
    tag:   'watchdog-' + pending.id,
    renotify: true,
    requireInteraction: true,
    actions: [
      { action: 'shutdownnow', type: 'button', title: 'Shutdown now' },
      { action: 'snooze',      type: 'text',   title: 'Snooze',
        placeholder: 'Reason (e.g. door open)' }
    ],
    data: {
      kind: 'watchdog_fired',
      eventId: pending.dbEventId,
      watchdogId: pending.id,
      url: '/#status'
    }
  };
}
```

Add `handleDeviceEvent` to `module.exports`:

```js
module.exports = {
  init,
  formatReason,
  getPending,
  updateSnapshot,
  handleDeviceEvent,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/anomaly-manager.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/anomaly-manager.js tests/anomaly-manager.test.js
git commit -m "$(cat <<'EOF'
Handle device 'fired' events in anomaly-manager

Formats reason, inserts Postgres row, sets _pending, dispatches push
notification via the existing category-based dispatcher, and
broadcasts watchdog-state on WebSocket.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add `ack(id, reason, user)` method

**Files:**
- Modify: `server/lib/anomaly-manager.js`
- Modify: `tests/anomaly-manager.test.js`

**Purpose:** Handle user's inline reply / web UI ack. Compute `snoozeUntil`, update Postgres, publish MQTT ack to device. Device will eventually send `resolved` event which closes the loop via `_handleResolved`.

- [ ] **Step 1: Write the failing test**

Append to `tests/anomaly-manager.test.js`:

```js
describe('anomaly-manager ack', () => {
  it('computes snoozeUntil and publishes MQTT ack', async () => {
    const calls = { history: [], mqtt: [] };
    const history = {
      insert: () => Promise.resolve({ id: 42 }),
      update: (id, patch) => { calls.history.push({ id, ...patch }); return Promise.resolve(); }
    };
    const mqttBridge = {
      publishWatchdogCmd: (msg) => calls.mqtt.push(msg)
    };
    anomalyManager.init({
      history,
      push: { sendByCategory: () => Promise.resolve() },
      wsBroadcast: () => {},
      mqttBridge,
      deviceConfig: { getConfig: () => ({}) },
      log: { info: () => {}, error: () => {} }
    });

    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'ggr', mode: 'GREENHOUSE_HEATING',
      el: 905, dT: 0.3, dC: 0, dG: 0.2, ts: 1700000000
    });

    const result = await anomalyManager.ack('ggr', 'door open, visiting today',
                                            { name: 'jonni', role: 'admin' });

    // ggr snooze TTL is 43200s (12h)
    assert.ok(result.snoozeUntil > Math.floor(Date.now()/1000));
    assert.ok(result.snoozeUntil - Math.floor(Date.now()/1000) > 43000);

    assert.strictEqual(calls.mqtt.length, 1);
    assert.strictEqual(calls.mqtt[0].t, 'ack');
    assert.strictEqual(calls.mqtt[0].id, 'ggr');
    assert.strictEqual(calls.mqtt[0].u, result.snoozeUntil);

    // Postgres row was updated with snooze info
    const update = calls.history.find(h => h.snooze_reason);
    assert.strictEqual(update.snooze_reason, 'door open, visiting today');
    assert.strictEqual(update.resolved_by, 'jonni');
  });

  it('rejects ack with no matching pending', async () => {
    anomalyManager.init({
      history: { insert: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve() },
      push: { sendByCategory: () => Promise.resolve() },
      wsBroadcast: () => {},
      mqttBridge: { publishWatchdogCmd: () => {} },
      deviceConfig: { getConfig: () => ({}) },
      log: { info: () => {}, error: () => {} }
    });

    await assert.rejects(
      () => anomalyManager.ack('ggr', 'test', { name: 'x', role: 'admin' }),
      /no matching pending/
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/anomaly-manager.test.js`
Expected: FAIL — `ack` is not exported.

- [ ] **Step 3: Add `ack` to `server/lib/anomaly-manager.js`**

```js
async function ack(id, reason, user) {
  if (!_pending || _pending.id !== id) {
    throw new Error('no matching pending');
  }
  const meta = getWatchdog(id);
  const ttl = meta ? meta.snoozeTtlSeconds : 3600;
  const snoozeUntil = Math.floor(Date.now() / 1000) + ttl;

  await _deps.history.update(_pending.dbEventId, {
    snooze_reason: reason,
    snooze_until: new Date(snoozeUntil * 1000),
    resolved_by: user.name
  });

  _deps.mqttBridge.publishWatchdogCmd({
    t: 'ack',
    id: id,
    u: snoozeUntil
  });

  return { snoozeUntil };
}
```

Add to `module.exports`:

```js
module.exports = {
  init,
  formatReason,
  getPending,
  updateSnapshot,
  handleDeviceEvent,
  ack,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/anomaly-manager.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/anomaly-manager.js tests/anomaly-manager.test.js
git commit -m "$(cat <<'EOF'
Add anomaly-manager.ack method

Computes snoozeUntil from watchdog metadata TTL, updates Postgres row
with snooze_reason + resolved_by, and publishes MQTT ack to device.
Rejects with "no matching pending" when called without a pending fire.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Add `shutdownNow(id, user)` method

**Files:**
- Modify: `server/lib/anomaly-manager.js`
- Modify: `tests/anomaly-manager.test.js`

**Purpose:** Handle user tapping "Shutdown now" — publishes MQTT command to device. Device will shut the mode down and send `resolved` event.

- [ ] **Step 1: Write the failing test**

Append to `tests/anomaly-manager.test.js`:

```js
describe('anomaly-manager shutdownNow', () => {
  it('publishes MQTT shutdownnow command', async () => {
    const calls = { mqtt: [], history: [] };
    anomalyManager.init({
      history: {
        insert: () => Promise.resolve({ id: 99 }),
        update: (id, patch) => { calls.history.push({ id, ...patch }); return Promise.resolve(); }
      },
      push: { sendByCategory: () => Promise.resolve() },
      wsBroadcast: () => {},
      mqttBridge: { publishWatchdogCmd: (msg) => calls.mqtt.push(msg) },
      deviceConfig: { getConfig: () => ({}) },
      log: { info: () => {}, error: () => {} }
    });

    await anomalyManager.handleDeviceEvent({
      t: 'fired', id: 'scs', mode: 'SOLAR_CHARGING',
      el: 305, dT: 0, dC: 1.0, dG: 0, ts: 1700000000
    });

    await anomalyManager.shutdownNow('scs', { name: 'jonni', role: 'admin' });

    assert.strictEqual(calls.mqtt.length, 1);
    assert.strictEqual(calls.mqtt[0].t, 'shutdownnow');
    assert.strictEqual(calls.mqtt[0].id, 'scs');

    const update = calls.history.find(h => h.resolved_by);
    assert.strictEqual(update.resolved_by, 'jonni');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/anomaly-manager.test.js`
Expected: FAIL — `shutdownNow` not exported.

- [ ] **Step 3: Add `shutdownNow` to `server/lib/anomaly-manager.js`**

```js
async function shutdownNow(id, user) {
  if (!_pending || _pending.id !== id) {
    throw new Error('no matching pending');
  }
  await _deps.history.update(_pending.dbEventId, {
    resolved_by: user.name
  });
  _deps.mqttBridge.publishWatchdogCmd({
    t: 'shutdownnow',
    id: id
  });
}
```

Add to `module.exports`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/anomaly-manager.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/anomaly-manager.js tests/anomaly-manager.test.js
git commit -m "$(cat <<'EOF'
Add anomaly-manager.shutdownNow method

Records the user on the pending event and publishes MQTT shutdownnow
command to the device. The device handles the actual transition to
IDLE and ban application.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Add `setEnabled`, `getState`, `getHistory`

**Files:**
- Modify: `server/lib/anomaly-manager.js`
- Modify: `tests/anomaly-manager.test.js`

**Purpose:** Round out the public API. `setEnabled` flips `we[id]` via the existing device-config path. `getState` returns the current pending + snapshot + recent history for UI initial load. `getHistory` returns just the history rows.

- [ ] **Step 1: Write the failing test**

Append to `tests/anomaly-manager.test.js`:

```js
describe('anomaly-manager setEnabled / getState / getHistory', () => {
  it('setEnabled calls deviceConfig.updateConfig with correct we field', async () => {
    let capturedUpdate = null;
    anomalyManager.init({
      history: {
        insert: () => Promise.resolve({ id: 1 }),
        update: () => Promise.resolve(),
        list: () => Promise.resolve([{ id: 1, watchdog_id: 'ggr' }])
      },
      push: { sendByCategory: () => Promise.resolve() },
      wsBroadcast: () => {},
      mqttBridge: { publishWatchdogCmd: () => {}, publishConfig: () => {} },
      deviceConfig: {
        getConfig: () => ({ we: { sng: 0, scs: 0, ggr: 0 } }),
        updateConfig: (update, cb) => {
          capturedUpdate = update;
          cb(null, { we: update.we });
        }
      },
      log: { info: () => {}, error: () => {} }
    });

    await anomalyManager.setEnabled('ggr', true, { name: 'jonni', role: 'admin' });
    assert.deepStrictEqual(capturedUpdate.we, { ggr: 1 });
  });

  it('getState returns pending + snapshot + recent', async () => {
    anomalyManager.init({
      history: {
        insert: () => Promise.resolve({ id: 1 }),
        update: () => Promise.resolve(),
        list: (limit) => Promise.resolve([
          { id: 1, watchdog_id: 'ggr', trigger_reason: 'test', fired_at: new Date() }
        ])
      },
      push: { sendByCategory: () => Promise.resolve() },
      wsBroadcast: () => {},
      mqttBridge: { publishWatchdogCmd: () => {} },
      deviceConfig: {
        getConfig: () => ({ we: { ggr: 1 }, wz: {}, wb: {} })
      },
      log: { info: () => {}, error: () => {} }
    });
    anomalyManager.updateSnapshot({ we: { ggr: 1 }, wz: {}, wb: {} });

    const state = await anomalyManager.getState();
    assert.strictEqual(state.pending, null);
    assert.deepStrictEqual(state.snapshot.we, { ggr: 1 });
    assert.strictEqual(state.recent.length, 1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/anomaly-manager.test.js`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Add the three functions to `server/lib/anomaly-manager.js`**

```js
function setEnabled(id, enabled, user) {
  return new Promise((resolve, reject) => {
    if (WATCHDOG_IDS.indexOf(id) === -1) {
      return reject(new Error('unknown watchdog id: ' + id));
    }
    const current = _deps.deviceConfig.getConfig();
    const we = Object.assign({}, current.we || {});
    we[id] = enabled ? 1 : 0;
    _deps.deviceConfig.updateConfig({ we }, (err, updated) => {
      if (err) return reject(err);
      if (_deps.mqttBridge.publishConfig) {
        _deps.mqttBridge.publishConfig(updated);
      }
      resolve(updated);
    });
  });
}

async function getState() {
  const recent = await _deps.history.list(10);
  return {
    pending: _pending,
    watchdogs: WATCHDOGS,
    snapshot: _lastSnapshot,
    recent
  };
}

async function getHistory(limit) {
  return _deps.history.list(limit || 20);
}
```

Add all three to `module.exports`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test tests/anomaly-manager.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/anomaly-manager.js tests/anomaly-manager.test.js
git commit -m "$(cat <<'EOF'
Add setEnabled, getState, getHistory to anomaly-manager

Public API complete. setEnabled flips we[id] via deviceConfig.
getState returns pending + snapshot + recent for UI initial load.
getHistory returns a paginated list for the recent events panel.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Create `server/lib/watchdog-history.js` with Postgres + ring buffer

**Files:**
- Create: `server/lib/watchdog-history.js`
- Create: `server/db/watchdog-events-schema.sql`
- Test: `tests/watchdog-history.test.js` (new)

**Purpose:** Storage module with primary Postgres path and ring-buffer fallback when DATABASE_URL is unset. Same pattern as other history modules.

- [ ] **Step 1: Write the failing test**

Create `tests/watchdog-history.test.js`:

```js
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('watchdog-history ring buffer fallback', () => {
  let history;
  beforeEach(() => {
    const { createHistory } = require('../server/lib/watchdog-history.js');
    history = createHistory({ db: null, log: { warn: () => {}, error: () => {} } });
  });

  it('insert returns sequential ids', async () => {
    const a = await history.insert({ watchdog_id: 'ggr', trigger_reason: 'a', fired_at: new Date(), mode: 'GH' });
    const b = await history.insert({ watchdog_id: 'ggr', trigger_reason: 'b', fired_at: new Date(), mode: 'GH' });
    assert.strictEqual(a.id, 1);
    assert.strictEqual(b.id, 2);
  });

  it('update patches an existing row', async () => {
    const row = await history.insert({ watchdog_id: 'scs', trigger_reason: 'test', fired_at: new Date(), mode: 'SC' });
    await history.update(row.id, { resolution: 'snoozed', resolved_at: new Date() });
    const list = await history.list(10);
    assert.strictEqual(list[0].resolution, 'snoozed');
  });

  it('list returns most-recent-first, respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await history.insert({ watchdog_id: 'ggr', trigger_reason: 't' + i, fired_at: new Date(Date.now() + i), mode: 'GH' });
    }
    const list = await history.list(3);
    assert.strictEqual(list.length, 3);
    assert.strictEqual(list[0].trigger_reason, 't4');
  });

  it('caps ring buffer at 200 entries', async () => {
    for (let i = 0; i < 250; i++) {
      await history.insert({ watchdog_id: 'ggr', trigger_reason: 't' + i, fired_at: new Date(), mode: 'GH' });
    }
    const list = await history.list(500);
    assert.strictEqual(list.length, 200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/watchdog-history.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Create the schema SQL**

Create `server/db/watchdog-events-schema.sql`:

```sql
CREATE TABLE IF NOT EXISTS watchdog_events (
  id              BIGSERIAL PRIMARY KEY,
  watchdog_id     TEXT NOT NULL,
  mode            TEXT NOT NULL,
  fired_at        TIMESTAMPTZ NOT NULL,
  trigger_reason  TEXT NOT NULL,
  resolution      TEXT,
  resolved_at     TIMESTAMPTZ,
  snooze_until    TIMESTAMPTZ,
  snooze_reason   TEXT,
  resolved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_watchdog_events_fired_at ON watchdog_events (fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchdog_events_watchdog_id ON watchdog_events (watchdog_id, fired_at DESC);
```

- [ ] **Step 4: Create `server/lib/watchdog-history.js`**

```js
// server/lib/watchdog-history.js
//
// Storage for watchdog_events with Postgres primary + in-memory
// ring-buffer fallback. Same pattern as other history features.

'use strict';

const MAX_RING = 200;

function createHistory({ db, log }) {
  if (db && typeof db.query === 'function') {
    return new PostgresHistory(db, log);
  }
  return new RingBufferHistory(log);
}

class PostgresHistory {
  constructor(db, log) {
    this.db = db;
    this.log = log;
  }

  async insert(row) {
    const result = await this.db.query(
      `INSERT INTO watchdog_events
       (watchdog_id, mode, fired_at, trigger_reason, resolution,
        resolved_at, snooze_until, snooze_reason, resolved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [row.watchdog_id, row.mode, row.fired_at, row.trigger_reason,
       row.resolution || null, row.resolved_at || null,
       row.snooze_until || null, row.snooze_reason || null, row.resolved_by || null]
    );
    return { id: result.rows[0].id };
  }

  async update(id, patch) {
    const fields = [];
    const values = [];
    let i = 1;
    for (const k of ['resolution', 'resolved_at', 'snooze_until', 'snooze_reason', 'resolved_by']) {
      if (patch[k] !== undefined) {
        fields.push(`${k} = $${i++}`);
        values.push(patch[k]);
      }
    }
    if (fields.length === 0) return;
    values.push(id);
    await this.db.query(
      `UPDATE watchdog_events SET ${fields.join(', ')} WHERE id = $${i}`,
      values
    );
  }

  async list(limit) {
    const result = await this.db.query(
      `SELECT * FROM watchdog_events ORDER BY fired_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows;
  }
}

class RingBufferHistory {
  constructor(log) {
    this.log = log;
    this.rows = [];
    this.nextId = 1;
  }

  async insert(row) {
    const entry = Object.assign({ id: this.nextId++ }, row);
    this.rows.unshift(entry);
    if (this.rows.length > MAX_RING) {
      this.rows.length = MAX_RING;
    }
    return { id: entry.id };
  }

  async update(id, patch) {
    const row = this.rows.find(r => r.id === id);
    if (row) Object.assign(row, patch);
  }

  async list(limit) {
    // Sort by fired_at DESC to match Postgres ordering
    const sorted = this.rows.slice().sort((a, b) => {
      const at = a.fired_at instanceof Date ? a.fired_at.getTime() : 0;
      const bt = b.fired_at instanceof Date ? b.fired_at.getTime() : 0;
      return bt - at;
    });
    return sorted.slice(0, limit);
  }
}

module.exports = { createHistory };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test tests/watchdog-history.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/lib/watchdog-history.js server/db/watchdog-events-schema.sql tests/watchdog-history.test.js
git commit -m "$(cat <<'EOF'
Add watchdog-history storage (Postgres + ring buffer)

createHistory({db, log}) returns a Postgres-backed instance when a db
is provided, otherwise an in-memory ring buffer capped at 200 entries.
Same pattern as other history features. Schema DDL in server/db/.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Wire anomaly-manager schema init into db module

**Files:**
- Modify: `server/lib/db.js` (or equivalent init path)
- Modify: `server/server.js` (load and initialize anomaly-manager)

**Purpose:** Apply the `watchdog_events` schema at DB init. Initialize anomaly-manager with real dependencies.

- [ ] **Step 1: Find the existing schema init path**

Run: `grep -n 'CREATE TABLE\|schema\|migrate\|init' server/lib/db.js | head -20`

Locate the place where existing tables are created. Add a reference to `watchdog-events-schema.sql` there.

- [ ] **Step 2: Read and apply the SQL file**

Add to the init function in `server/lib/db.js`:

```js
const fs = require('fs');
const path = require('path');

async function initWatchdogSchema(db) {
  const sqlPath = path.join(__dirname, '..', 'db', 'watchdog-events-schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  await db.query(sql);
}
```

Call `initWatchdogSchema(db)` after the existing schema init runs.

- [ ] **Step 3: Initialize anomaly-manager in `server/server.js`**

In `server/server.js`, near the top where other modules are required:

```js
const anomalyManager = require('./lib/anomaly-manager');
const { createHistory } = require('./lib/watchdog-history');
```

In the server startup path (after `db` is initialized and `push`/`mqttBridge` are set up), add:

```js
const watchdogHistory = createHistory({ db, log });
anomalyManager.init({
  history: watchdogHistory,
  push: push,
  wsBroadcast: broadcastToWebSockets,  // use the existing WS broadcast helper
  mqttBridge: mqttBridge,
  deviceConfig: deviceConfig,
  log: log
});
```

(Note: `broadcastToWebSockets` or similar — use whatever helper the existing WS broadcast uses. Check `server/server.js` for the pattern.)

- [ ] **Step 4: Run the server in dry-run mode to catch init errors**

Run: `node -e "require('./server/lib/anomaly-manager.js'); console.log('loaded ok');"`
Expected: `loaded ok`

- [ ] **Step 5: Commit**

```bash
git add server/lib/db.js server/server.js
git commit -m "$(cat <<'EOF'
Initialize anomaly-manager at server startup

Apply watchdog_events schema at DB init, create history with Postgres
primary (ring-buffer fallback if db is null), and call
anomalyManager.init with all dependencies wired.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Wire mqtt-bridge to subscribe to watchdog/event and publish watchdog/cmd

**Files:**
- Modify: `server/lib/mqtt-bridge.js`
- Test: `tests/mqtt-bridge.test.js` (extend or add a new describe block)

**Purpose:** Receive device watchdog events and route to `anomalyManager.handleDeviceEvent`. Add `publishWatchdogCmd` for the reverse direction.

- [ ] **Step 1: Add the subscription in the `connect` handler**

In `server/lib/mqtt-bridge.js`, find the block where `mqttClient.subscribe('greenhouse/state', ...)` is called (around line 45). Add a parallel subscription:

```js
    mqttClient.subscribe('greenhouse/watchdog/event', { qos: 1 }, function (err) {
      if (err) log.error('subscribe watchdog/event failed', { error: err.message });
    });
```

- [ ] **Step 2: Add the message dispatch**

Find the `onMessage` handler (around line 75-86). Add a branch for the new topic:

```js
    if (topic === 'greenhouse/watchdog/event') {
      try {
        const msg = JSON.parse(payload.toString());
        const anomalyManager = require('./anomaly-manager');
        anomalyManager.handleDeviceEvent(msg).catch(err => {
          log.error('anomaly handleDeviceEvent failed', { error: err.message });
        });
      } catch (e) {
        log.warn('invalid JSON on watchdog/event', { error: e.message });
      }
      return;
    }
```

- [ ] **Step 3: Add `publishWatchdogCmd` helper**

After the existing `publishConfig` / `publishRelayCommand` helpers (around line 213-260), add:

```js
function publishWatchdogCmd(cmd) {
  if (!mqttClient || !mqttClient.connected) {
    log.warn('cannot publish watchdog cmd: MQTT not connected');
    return;
  }
  var span = tracer.startSpan('mqtt.publish', {
    attributes: {
      'messaging.system': 'mqtt',
      'messaging.destination': 'greenhouse/watchdog/cmd'
    }
  });
  mqttClient.publish('greenhouse/watchdog/cmd', JSON.stringify(cmd),
                     { qos: 1 }, function () {
    span.end();
  });
}
```

Add to the exports at the bottom of the file:

```js
module.exports = {
  // ... existing exports ...
  publishWatchdogCmd: publishWatchdogCmd
};
```

- [ ] **Step 4: Smoke test — start the server and verify no errors**

Run: `node -e "const mb = require('./server/lib/mqtt-bridge.js'); console.log(typeof mb.publishWatchdogCmd);"`
Expected: `function`

- [ ] **Step 5: Commit**

```bash
git add server/lib/mqtt-bridge.js
git commit -m "$(cat <<'EOF'
Wire mqtt-bridge to watchdog event/cmd topics

Subscribe to greenhouse/watchdog/event in the connect handler and
route incoming messages to anomalyManager.handleDeviceEvent. Add
publishWatchdogCmd() helper for the reverse direction (ack and
shutdownnow commands to the device).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: Add HTTP endpoints to `server/server.js`

**Files:**
- Modify: `server/server.js`
- Test: `tests/watchdog-http.test.js` (new)

**Purpose:** Four new HTTP endpoints that wrap the anomaly-manager public API. All mutations admin-only via `isAdminOrReject()`.

- [ ] **Step 1: Write a failing test**

Create `tests/watchdog-http.test.js`:

```js
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const http = require('http');

// Note: this assumes the server is started in test fixture mode.
// Check existing HTTP tests (e.g. tests/server-pwa-routes.test.js)
// for the canonical setup pattern and mirror it.

describe('watchdog HTTP endpoints', () => {
  // Placeholder — structure depends on existing test harness
  // Adapt to match tests/server-pwa-routes.test.js pattern
  it.skip('GET /api/watchdog/state returns pending state', () => {});
  it.skip('POST /api/watchdog/ack requires admin', () => {});
  it.skip('POST /api/watchdog/shutdownnow requires admin', () => {});
  it.skip('PUT /api/watchdog/enabled requires admin', () => {});
});
```

(The `.skip` is intentional — before writing real tests, check `tests/server-pwa-routes.test.js` or similar to see how the project tests HTTP endpoints. Mirror that pattern. If no pattern exists, a Playwright e2e test in Task 32 will cover the full flow instead.)

- [ ] **Step 2: Add the endpoints to `server/server.js`**

In `server/server.js`, find the block where existing `/api/*` endpoints are handled (around line 424 per the earlier grep). Add after the existing `/api/push/*` endpoint block:

```js
  if (urlPath === '/api/watchdog/state' && req.method === 'GET') {
    anomalyManager.getState().then(state => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
    }).catch(err => {
      log.error('watchdog state failed', { error: err.message });
      res.writeHead(500); res.end();
    });
    return;
  }

  if (urlPath === '/api/watchdog/ack' && req.method === 'POST') {
    if (!isAdminOrReject()) return;
    readJsonBody(req, (body) => {
      if (!body || !body.id || typeof body.reason !== 'string') {
        res.writeHead(400); res.end('bad request'); return;
      }
      anomalyManager.ack(body.id, body.reason, req.user)
        .then(result => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        })
        .catch(err => {
          const code = err.message.includes('no matching pending') ? 409 : 500;
          res.writeHead(code); res.end(err.message);
        });
    });
    return;
  }

  if (urlPath === '/api/watchdog/shutdownnow' && req.method === 'POST') {
    if (!isAdminOrReject()) return;
    readJsonBody(req, (body) => {
      if (!body || !body.id) {
        res.writeHead(400); res.end('bad request'); return;
      }
      anomalyManager.shutdownNow(body.id, req.user)
        .then(() => { res.writeHead(200); res.end(); })
        .catch(err => {
          const code = err.message.includes('no matching pending') ? 409 : 500;
          res.writeHead(code); res.end(err.message);
        });
    });
    return;
  }

  if (urlPath === '/api/watchdog/enabled' && req.method === 'PUT') {
    if (!isAdminOrReject()) return;
    readJsonBody(req, (body) => {
      if (!body || !body.id || typeof body.enabled !== 'boolean') {
        res.writeHead(400); res.end('bad request'); return;
      }
      anomalyManager.setEnabled(body.id, body.enabled, req.user)
        .then(updated => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ we: updated.we }));
        })
        .catch(err => {
          res.writeHead(500); res.end(err.message);
        });
    });
    return;
  }
```

(Note: `readJsonBody` — use whatever helper the existing POST endpoints use. Grep for it: `grep -n 'readJsonBody\|JSON.parse.*req' server/server.js`.)

- [ ] **Step 3: Manually smoke-test the GET endpoint**

Run: Start the server locally. Then: `curl http://localhost:3456/api/watchdog/state`
Expected: JSON response with `pending: null`, `watchdogs: [...]`, `snapshot: {...}`, `recent: []`.

- [ ] **Step 4: Commit**

```bash
git add server/server.js tests/watchdog-http.test.js
git commit -m "$(cat <<'EOF'
Add watchdog HTTP endpoints to server.js

GET /api/watchdog/state (any authed), POST /api/watchdog/ack (admin),
POST /api/watchdog/shutdownnow (admin), PUT /api/watchdog/enabled
(admin). All mutations guarded by isAdminOrReject(). 409 on ack/
shutdownnow without a matching pending; 400 on malformed body.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Add `watchdog_fired` category to `push.js`

**Files:**
- Modify: `server/lib/push.js`

**Purpose:** Add the new notification category so it appears in subscription filtering and in the Settings → Push notifications UI.

- [ ] **Step 1: Add to `VALID_CATEGORIES`**

In `server/lib/push.js`, find `var VALID_CATEGORIES` (around line 32):

```js
var VALID_CATEGORIES = [
  'evening_report', 'noon_report', 'overheat_warning',
  'freeze_warning', 'offline_warning',
  'watchdog_fired'   // NEW
];
```

- [ ] **Step 2: Add icon mapping**

Find `CATEGORY_ICONS` (around line 271):

```js
var CATEGORY_ICONS = {
  evening_report:   'assets/notif-evening.png',
  noon_report:      'assets/notif-noon.png',
  overheat_warning: 'assets/notif-overheat.png',
  freeze_warning:   'assets/notif-freeze.png',
  offline_warning:  'assets/notif-offline.png',
  watchdog_fired:   'assets/notif-watchdog.png'   // NEW
};
```

- [ ] **Step 3: Create a placeholder icon**

For v1, the watchdog notification can reuse an existing icon until a proper one is designed. Create a symlink or copy:

Run: `cp playground/assets/notif-overheat.png playground/assets/notif-watchdog.png`

(Replace with a proper icon later. The placeholder just ensures the URL resolves.)

- [ ] **Step 4: Verify the push module loads**

Run: `node -e "const p = require('./server/lib/push.js'); console.log(p.VALID_CATEGORIES);"`
Expected: array including `'watchdog_fired'`.

- [ ] **Step 5: Commit**

```bash
git add server/lib/push.js playground/assets/notif-watchdog.png
git commit -m "$(cat <<'EOF'
Add watchdog_fired notification category

Registers the new category in VALID_CATEGORIES and CATEGORY_ICONS.
Placeholder icon is a copy of notif-overheat until a proper watchdog
icon is designed.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Add `WATCHDOG_MODE` const + `publishWatchdogEvent` helper in `control.js`

**Files:**
- Modify: `shelly/control.js`

**Purpose:** Add the top-level constants and the MQTT publish helper the state machine will call. Keep the code compact — no new modules.

- [ ] **Step 1: Add constants near the top of `shelly/control.js`**

After the existing `SHELL_CFG` block (around line 4-10), add:

```js
// Watchdog id → mode short code. Used by applyBanAndShutdown to
// translate a watchdog id to the mode code stored in wb.
var WATCHDOG_MODE = { sng: "SC", scs: "SC", ggr: "GH" };
```

- [ ] **Step 2: Add `publishWatchdogEvent` helper**

Find an existing publish helper in `control.js` (e.g., the telemetry publish). Near that, add:

```js
function publishWatchdogEvent(payload) {
  // payload is already a compact-keyed object per the spec.
  // Reuses the existing MQTT publish path (same pattern as other
  // device→server publishes in this file).
  if (typeof MQTT === "undefined" || !MQTT.isConnected || !MQTT.isConnected()) {
    return;  // silently drop if MQTT is disconnected
  }
  MQTT.publish("greenhouse/watchdog/event", JSON.stringify(payload), 1, false);
}
```

(The exact MQTT API name may differ — check existing publish sites in `control.js` like `publishSensorReading` or similar, and match the pattern exactly.)

- [ ] **Step 3: Verify via lint + syntax check**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control.js`
Expected: no new errors. Possibly a SH-012 warning about script size — that's pre-existing and acceptable.

- [ ] **Step 4: Commit**

```bash
git add shelly/control.js
git commit -m "$(cat <<'EOF'
Add WATCHDOG_MODE const and publishWatchdogEvent helper

Top-level constants and MQTT publish helper for the watchdog state
machine. Uses the existing MQTT publish path; no new modules.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: Add watchdog baseline capture at mode-start sites

**Files:**
- Modify: `shelly/control.js`

**Purpose:** At every existing `state.mode_start = Date.now()` call site (lines 181, 360, 396, 928 per the earlier grep), capture a baseline snapshot of sensors and clear any in-flight pending.

- [ ] **Step 1: Find the mode_start sites**

Run: `grep -n 'state\.mode_start\s*=\s*Date\.now()' shelly/control.js`
Expected: 4 matches.

- [ ] **Step 2: Add baseline capture after each match**

For each of the 4 sites, add these lines immediately after the `state.mode_start = Date.now();` line:

```js
state.mode_start = Date.now();
state.watchdog_baseline = {
  at:         Math.floor(Date.now() / 1000),
  tankTop:    sensorValues.tank_top,
  collector:  sensorValues.collector,
  greenhouse: sensorValues.greenhouse
};
state.watchdogPending = null;
```

**Variable name caveat:** the sensor dict may be named differently than `sensorValues` in `control.js`. Check the actual variable: `grep -n 'sensorValues\|sensors\|temps' shelly/control.js | head`. Use whatever name the file already uses for the current sensor readings. If uncertain, dereference the individual sensors at the call site and capture them into local vars first.

- [ ] **Step 3: Add to the initial `state` definition**

Find the initial `state = { ... }` block near the top of `control.js` (around line 30-40). Add:

```js
  mode_start: 0,
  watchdog_baseline: null,     // NEW
  watchdogPending: null,       // NEW
  prev_ss: false,              // NEW (used in Task 19)
```

- [ ] **Step 4: Lint check**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control.js`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add shelly/control.js
git commit -m "$(cat <<'EOF'
Capture watchdog baseline at every mode_start site

Piggyback on the four existing state.mode_start assignments to
capture a snapshot of the relevant sensors and clear any in-flight
pending. Adds three fields to the initial state definition.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: Add the tick block in `controlLoop`

**Files:**
- Modify: `shelly/control.js`

**Purpose:** Add the lazy prune + override-exit baseline reset + pending check + detection block inside `controlLoop`. Mutually exclusive branches keep the tick cost bounded.

- [ ] **Step 1: Locate `controlLoop`**

Run: `grep -n 'function controlLoop\|controlLoop\s*=\s*function' shelly/control.js`

- [ ] **Step 2: Add the block**

Inside `controlLoop`, after the existing `evaluate()` call and transition scheduling, before the function returns, add:

```js
  // ── Watchdog tick block ──
  var now = Math.floor(Date.now() / 1000);

  // (a) Lazy prune of expired wb entries
  if (deviceConfig.wb) {
    var wbChanged = false;
    for (var m in deviceConfig.wb) {
      if (deviceConfig.wb[m] <= now) {
        delete deviceConfig.wb[m];
        wbChanged = true;
      }
    }
    if (wbChanged) {
      Shelly.call("KVS.Set", {
        key: "config",
        value: JSON.stringify(deviceConfig)
      });
    }
  }

  // (b) Override-exit baseline reset
  var ssNow = !!(deviceConfig.mo && deviceConfig.mo.a && deviceConfig.mo.ss);
  if (state.prev_ss && !ssNow && state.watchdog_baseline) {
    state.watchdog_baseline = {
      at:         now,
      tankTop:    sensorValues.tank_top,
      collector:  sensorValues.collector,
      greenhouse: sensorValues.greenhouse
    };
    state.watchdogPending = null;
  }
  state.prev_ss = ssNow;

  // (c) Pending check OR detection — mutually exclusive
  if (state.watchdogPending) {
    if (now - state.watchdogPending.firedAt >= 300) {
      autoShutdown(state.watchdogPending.id);
    }
  } else if (state.watchdog_baseline) {
    var entry = {
      mode:       state.currentMode,
      at:         state.watchdog_baseline.at,
      tankTop:    state.watchdog_baseline.tankTop,
      collector:  state.watchdog_baseline.collector,
      greenhouse: state.watchdog_baseline.greenhouse
    };
    var fired = detectAnomaly(entry, now, sensorValues, deviceConfig);
    if (fired) {
      state.watchdogPending = { id: fired, firedAt: now };
      publishWatchdogEvent({
        t: "fired",
        id: fired,
        mode: entry.mode,
        el: now - entry.at,
        dT: sensorValues.tank_top  - entry.tankTop,
        dC: entry.collector        - sensorValues.collector,
        dG: sensorValues.greenhouse - entry.greenhouse,
        ts: now
      });
    }
  }
```

**Caveat:** `detectAnomaly` is defined in `control-logic.js` but since `deploy.sh` concatenates the two files, it's in scope at runtime. In unit testing of `control.js` you'd stub it; this file is executed on-device so the concatenation provides access directly.

**Variable name caveats:** adapt `sensorValues`, `deviceConfig`, and `state.currentMode` to whatever names `control.js` actually uses. Grep to confirm.

- [ ] **Step 3: Lint check**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control.js`
Expected: no new errors (SH-012 warning is pre-existing).

- [ ] **Step 4: Commit**

```bash
git add shelly/control.js
git commit -m "$(cat <<'EOF'
Add watchdog tick block to controlLoop

Three mutually-exclusive branches per tick: lazy-prune expired wb
entries, reset baseline on mo.ss exit, check pending or run detection.
No new Timer.set — the 30s POLL_INTERVAL tick enforces the 5-min
pending deadline at ±30s granularity.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: Add resolution handlers (applyBanAndShutdown + variants)

**Files:**
- Modify: `shelly/control.js`

**Purpose:** The three paths that clear pending: applyBanAndShutdown (shared between auto and user-triggered shutdown), onWatchdogAck (snooze path), and the wrapper functions.

- [ ] **Step 1: Add the resolution handlers near the publishWatchdogEvent helper**

```js
function applyBanAndShutdown(id, how) {
  var modeCode = WATCHDOG_MODE[id];
  if (!modeCode) return;
  var now = Math.floor(Date.now() / 1000);
  var banTtl = deviceConfig.watchdogBanSeconds || 14400;
  var newUntil = now + banTtl;

  deviceConfig.wb = deviceConfig.wb || {};
  var existing = deviceConfig.wb[modeCode] || 0;
  // max() so a permanent ban (sentinel 9999999999) is never downgraded
  deviceConfig.wb[modeCode] = (existing > newUntil) ? existing : newUntil;

  Shelly.call("KVS.Set", {
    key: "config",
    value: JSON.stringify(deviceConfig)
  });

  state.watchdogPending = null;
  transitionTo(MODES.IDLE);
  publishWatchdogEvent({ t: "resolved", id: id, how: how, ts: now });
}

function autoShutdown(id) {
  applyBanAndShutdown(id, "shutdown_auto");
}

function onWatchdogShutdownNow(id) {
  if (!state.watchdogPending || state.watchdogPending.id !== id) return;
  applyBanAndShutdown(id, "shutdown_user");
}

function onWatchdogAck(msg) {
  // msg = { t:"ack", id:"ggr", u:<unix seconds> }
  if (!state.watchdogPending || state.watchdogPending.id !== msg.id) return;
  deviceConfig.wz = deviceConfig.wz || {};
  deviceConfig.wz[msg.id] = msg.u;
  Shelly.call("KVS.Set", {
    key: "config",
    value: JSON.stringify(deviceConfig)
  });
  state.watchdogPending = null;
  publishWatchdogEvent({
    t: "resolved",
    id: msg.id,
    how: "snoozed",
    ts: Math.floor(Date.now() / 1000)
  });
  // NOTE: mode is NOT transitioned — snooze keeps it running
}
```

**Caveats:**
- `transitionTo` — use whatever name `control.js` uses for the mode-transition function. Grep to confirm: `grep -n 'transitionTo\|setMode' shelly/control.js`.
- `deviceConfig` — adapt to the actual variable name in this file.

- [ ] **Step 2: Lint check**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control.js`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add shelly/control.js
git commit -m "$(cat <<'EOF'
Add watchdog resolution handlers to control.js

applyBanAndShutdown is the shared path for auto-shutdown and user-
triggered shutdown — both apply the wb cool-off and transition to
IDLE. onWatchdogAck takes the snooze path: writes wz[id], clears
pending, keeps mode running. max() guard prevents permanent ban
downgrade.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Subscribe to `greenhouse/watchdog/cmd` MQTT topic on device

**Files:**
- Modify: `shelly/control.js`

**Purpose:** Receive `ack` and `shutdownnow` commands from the server and dispatch to the handlers from Task 20.

- [ ] **Step 1: Find the existing MQTT subscribe sites**

Run: `grep -n 'MQTT.subscribe\|onMessage\|onMqttMessage' shelly/control.js`

- [ ] **Step 2: Add subscription to the new topic and dispatch handler**

Near the existing MQTT subscriptions, add:

```js
MQTT.subscribe("greenhouse/watchdog/cmd", function (topic, message) {
  var msg;
  try { msg = JSON.parse(message); } catch (e) { return; }
  if (msg.t === "ack") {
    onWatchdogAck(msg);
  } else if (msg.t === "shutdownnow") {
    onWatchdogShutdownNow(msg.id);
  }
});
```

**Caveat:** the MQTT subscribe API signature on Shelly may take a different callback shape — check the existing subscribe sites and match exactly.

- [ ] **Step 3: Lint check**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control.js`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add shelly/control.js
git commit -m "$(cat <<'EOF'
Subscribe to greenhouse/watchdog/cmd on device

Receives ack and shutdownnow commands from the server. Dispatches to
onWatchdogAck / onWatchdogShutdownNow. Invalid JSON is silently
dropped. Duplicate deliveries are no-ops thanks to the pending-id
guards in each handler.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: Extend `playground/sw.js` notificationclick handler

**Files:**
- Modify: `playground/sw.js`

**Purpose:** Handle the `watchdog_fired` notification by POSTing to the HTTP endpoints. Inline reply goes to `/api/watchdog/ack`; "Shutdown now" button goes to `/api/watchdog/shutdownnow`.

- [ ] **Step 1: Open `playground/sw.js` and locate `notificationclick`**

The existing handler is around line 65.

- [ ] **Step 2: Add the watchdog branch at the top of the handler**

Replace the existing handler with:

```js
self.addEventListener('notificationclick', function (event) {
  var data = event.notification.data || {};
  event.notification.close();

  // Watchdog fired notifications
  if (data.kind === 'watchdog_fired') {
    var action = event.action;
    var reply  = event.reply;

    if (action === 'shutdownnow') {
      event.waitUntil(fetch('/api/watchdog/shutdownnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: data.watchdogId, eventId: data.eventId }),
        credentials: 'include'
      }).catch(function(){}));
      return;
    }
    if (action === 'snooze') {
      event.waitUntil(fetch('/api/watchdog/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:      data.watchdogId,
          eventId: data.eventId,
          reason:  (reply && reply.trim()) || '(no reason provided)'
        }),
        credentials: 'include'
      }).catch(function(){}));
      return;
    }
    // Main click with no action → fall through to open-window logic below
  }

  // ── existing open-window logic ──
  var url = data.url ? data.url : '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          if (clientList[i].url.indexOf(url) !== -1 && 'focus' in clientList[i]) {
            return clientList[i].focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
      })
  );
});
```

- [ ] **Step 3: Verify syntax via the existing e2e service worker loader**

Run: `node -e "var fs = require('fs'); var src = fs.readFileSync('./playground/sw.js', 'utf8'); new Function(src); console.log('ok');"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add playground/sw.js
git commit -m "$(cat <<'EOF'
Extend sw.js notificationclick for watchdog notifications

Handles data.kind='watchdog_fired' with two action branches:
'shutdownnow' POSTs to /api/watchdog/shutdownnow, 'snooze' POSTs to
/api/watchdog/ack with the event.reply as the reason. Main click with
no action falls through to the existing open-window logic. Uses
credentials: include so the session cookie is sent.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 23: Add pending banner HTML + CSS to `#status`

**Files:**
- Modify: `playground/index.html`
- Modify: `playground/public/style.css`

**Purpose:** The in-app pending banner, rendered on the `#status` view when a watchdog is pending. Submits via the same endpoints the SW uses.

- [ ] **Step 1: Add the banner HTML inside the `#status` view**

In `playground/index.html`, find the `<section id="status">` or equivalent. At the top of that section (before the existing status card), add:

```html
<div id="watchdog-banner" class="watchdog-banner" style="display:none;">
  <div class="watchdog-banner-header">
    <span class="material-symbols-outlined">warning</span>
    <h3 id="watchdog-banner-title">Watchdog fired</h3>
  </div>
  <p id="watchdog-banner-reason" class="watchdog-banner-reason"></p>
  <p class="watchdog-banner-countdown">
    Auto-shutdown in <span id="watchdog-banner-countdown-text">5 min 0 s</span>
  </p>
  <div class="watchdog-banner-form">
    <input id="watchdog-banner-reply" type="text"
           placeholder="Reason (e.g. door open)" />
    <div class="watchdog-banner-actions">
      <button id="watchdog-banner-snooze" class="auth-btn" type="button">
        Snooze with reason
      </button>
      <button id="watchdog-banner-shutdown" class="auth-btn auth-btn-danger" type="button">
        Shutdown now
      </button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add styles to `playground/public/style.css`**

```css
.watchdog-banner {
  border: 2px solid var(--warning, #e67e22);
  background: rgba(230, 126, 34, 0.1);
  border-radius: 12px;
  padding: 16px;
  margin-bottom: 16px;
}
.watchdog-banner-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.watchdog-banner-header h3 {
  margin: 0;
  font-size: 18px;
}
.watchdog-banner-reason {
  font-size: 14px;
  margin: 8px 0;
  color: var(--on-surface-variant);
}
.watchdog-banner-countdown {
  font-size: 14px;
  font-weight: 600;
  margin: 8px 0 12px 0;
}
.watchdog-banner-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.watchdog-banner-form input {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--outline);
  background: var(--surface);
  color: var(--on-surface);
}
.watchdog-banner-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.auth-btn-danger {
  background: var(--error, #c0392b);
  color: white;
}
```

(Adapt variable names to the existing theme tokens. Grep `playground/public/style.css` for the actual names of primary/warning/error colors.)

- [ ] **Step 3: Verify the page loads without JS errors**

Run: Serve the playground locally (`PORT=3456 node server/server.js`) and load http://localhost:3456/#status. The banner should not be visible (display: none until JS populates it in Task 24).

- [ ] **Step 4: Commit**

```bash
git add playground/index.html playground/public/style.css
git commit -m "$(cat <<'EOF'
Add watchdog pending banner HTML and CSS

Banner on #status view, display:none until JS populates it. Contains
title, reason, live countdown, reason input field, and two action
buttons. Styles use existing theme tokens where possible.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 24: Add pending banner JS — rendering, countdown, submit handlers

**Files:**
- Modify: `playground/js/main.js`

**Purpose:** Render the banner when `watchdog-state` shows a pending, run a local countdown, submit ack/shutdownnow to the HTTP endpoints. Clear the banner on state broadcasts showing `pending: null`.

- [ ] **Step 1: Add banner renderer and countdown**

In `playground/js/main.js`, add a new module-scoped section:

```js
// ── Watchdog pending banner ──
let _watchdogCountdownTimer = null;
let _watchdogPending = null;

function renderWatchdogBanner(pending) {
  _watchdogPending = pending;
  const banner = document.getElementById('watchdog-banner');
  if (!banner) return;

  if (!pending) {
    banner.style.display = 'none';
    if (_watchdogCountdownTimer) {
      clearInterval(_watchdogCountdownTimer);
      _watchdogCountdownTimer = null;
    }
    return;
  }

  banner.style.display = 'block';
  document.getElementById('watchdog-banner-title').textContent =
    'Watchdog fired: ' + pending.id;
  document.getElementById('watchdog-banner-reason').textContent =
    pending.triggerReason || '';
  document.getElementById('watchdog-banner-reply').value = '';

  // Local countdown ticking every second
  if (_watchdogCountdownTimer) clearInterval(_watchdogCountdownTimer);
  function updateCountdown() {
    const now = Math.floor(Date.now() / 1000);
    const remaining = Math.max(0, 300 - (now - pending.firedAt));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    const el = document.getElementById('watchdog-banner-countdown-text');
    if (el) el.textContent = m + ' min ' + s + ' s';
  }
  updateCountdown();
  _watchdogCountdownTimer = setInterval(updateCountdown, 1000);
}

function wireWatchdogBanner() {
  const snoozeBtn = document.getElementById('watchdog-banner-snooze');
  const shutdownBtn = document.getElementById('watchdog-banner-shutdown');
  const replyInput = document.getElementById('watchdog-banner-reply');

  if (snoozeBtn) {
    snoozeBtn.addEventListener('click', () => {
      if (!_watchdogPending) return;
      const reason = (replyInput && replyInput.value.trim()) || '(no reason provided)';
      fetch('/api/watchdog/ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: _watchdogPending.id,
          eventId: _watchdogPending.dbEventId,
          reason: reason
        })
      }).catch(err => console.error('ack failed', err));
    });
  }

  if (shutdownBtn) {
    shutdownBtn.addEventListener('click', () => {
      if (!_watchdogPending) return;
      fetch('/api/watchdog/shutdownnow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          id: _watchdogPending.id,
          eventId: _watchdogPending.dbEventId
        })
      }).catch(err => console.error('shutdownnow failed', err));
    });
  }
}
```

- [ ] **Step 2: Call `wireWatchdogBanner()` at app init**

Find the `init` / `DOMContentLoaded` / main bootstrap function in `main.js` (search for existing event listener setup). Add:

```js
  wireWatchdogBanner();
```

- [ ] **Step 3: Wire initial state load**

At the point where `main.js` fetches the app state on boot, add a fetch to `/api/watchdog/state`:

```js
fetch('/api/watchdog/state', { credentials: 'include' })
  .then(r => r.json())
  .then(state => {
    renderWatchdogBanner(state.pending);
    // setWatchdogsState(state.snapshot, state.watchdogs, state.recent);  // Task 26
    // setModeBans(state.snapshot.wb);  // Task 25
  })
  .catch(err => console.error('initial watchdog state failed', err));
```

- [ ] **Step 4: Smoke test**

Run the server and playground. Navigate to `#status`. The banner should not be visible (no pending yet). Verify no JS console errors.

- [ ] **Step 5: Commit**

```bash
git add playground/js/main.js
git commit -m "$(cat <<'EOF'
Add watchdog pending banner JS

Renders the banner from the pending struct, runs a local 1-second
countdown, submits ack/shutdownnow via fetch with credentials. Clears
the banner on pending=null. Initial state is loaded from
/api/watchdog/state on app boot.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 25: Replace allowed-modes UI with Mode Enablement card

**Files:**
- Modify: `playground/index.html`
- Modify: `playground/js/main.js`
- Modify: `playground/public/style.css`

**Purpose:** Replace the existing `am` checkbox UI in the device-config view with a state-aware Mode Enablement card that shows allowed / watchdog-cool-off / user-disabled per mode, and exposes "Disable" / "Clear cool-off" / "Re-enable" admin actions.

- [ ] **Step 1: Remove the existing allowed-modes checkboxes from `index.html`**

Run: `grep -n 'dc-am-\|Allowed modes' playground/index.html`

Delete the block. Replace it with:

```html
<div id="mode-enablement-card" class="card">
  <h3>Mode enablement</h3>
  <p class="settings-desc">Each mode can be permanently disabled, on a watchdog cool-off, or allowed.</p>
  <div id="mode-enablement-list"></div>
</div>
```

- [ ] **Step 2: Add the renderer in `main.js`**

```js
const ALL_MODES = [
  { code: 'I',  label: 'IDLE' },
  { code: 'SC', label: 'SOLAR_CHARGING' },
  { code: 'GH', label: 'GREENHOUSE_HEATING' },
  { code: 'AD', label: 'ACTIVE_DRAIN' },
  { code: 'EH', label: 'EMERGENCY_HEATING' }
];
const WB_PERMANENT_SENTINEL = 9999999999;

function renderModeEnablement(wb, userRole) {
  const list = document.getElementById('mode-enablement-list');
  if (!list) return;
  const now = Math.floor(Date.now() / 1000);
  const isAdmin = userRole === 'admin';

  list.innerHTML = '';
  ALL_MODES.forEach(mode => {
    const row = document.createElement('div');
    row.className = 'mode-enablement-row';
    const entry = wb && wb[mode.code];

    let statusLabel;
    let actionLabel;
    let actionHandler;

    if (!entry || entry <= now) {
      statusLabel = '<span class="mode-allowed">• allowed</span>';
      actionLabel = 'Disable';
      actionHandler = () => disableMode(mode.code);
    } else if (entry === WB_PERMANENT_SENTINEL) {
      statusLabel = '<span class="mode-disabled">✕ disabled by user</span>';
      actionLabel = 'Re-enable';
      actionHandler = () => clearBan(mode.code);
    } else {
      const remaining = entry - now;
      const h = Math.floor(remaining / 3600);
      const m = Math.floor((remaining % 3600) / 60);
      statusLabel = '<span class="mode-cooloff">⏸ cool-off — ' + h + 'h ' + m + 'm</span>';
      actionLabel = 'Clear cool-off';
      actionHandler = () => clearBan(mode.code);
    }

    row.innerHTML =
      '<div class="mode-enablement-label">' + mode.label + '</div>' +
      '<div class="mode-enablement-status">' + statusLabel + '</div>' +
      (isAdmin ? '<button class="mode-enablement-action auth-btn">' + actionLabel + '</button>' : '');

    if (isAdmin) {
      row.querySelector('.mode-enablement-action').addEventListener('click', actionHandler);
    }
    list.appendChild(row);
  });
}

function disableMode(modeCode) {
  fetch('/api/device-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ wb: { [modeCode]: WB_PERMANENT_SENTINEL } })
  }).catch(err => console.error(err));
}

function clearBan(modeCode) {
  fetch('/api/device-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ wb: { [modeCode]: 0 } })
  }).catch(err => console.error(err));
}
```

Also remove the existing `saveDeviceConfig` logic that reads the old `am` checkboxes (around line 2180-2184 in the original). The new renderer drives `wb` changes directly via the card, so `am` is no longer computed or sent.

- [ ] **Step 3: Add CSS for the mode enablement card**

Append to `playground/public/style.css`:

```css
.mode-enablement-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--outline-variant, rgba(255,255,255,0.1));
}
.mode-enablement-label {
  flex: 1;
  font-weight: 600;
  font-family: monospace;
}
.mode-enablement-status { font-size: 14px; }
.mode-allowed { color: var(--success, #27ae60); }
.mode-disabled { color: var(--on-surface-variant); }
.mode-cooloff { color: var(--warning, #e67e22); }
.mode-enablement-action {
  padding: 4px 12px;
  font-size: 13px;
}
```

- [ ] **Step 4: Update initial state loader to call `renderModeEnablement`**

In the state-load fetch from Task 24, uncomment the setModeBans line and replace with:

```js
    renderModeEnablement(state.snapshot.wb || {}, currentUserRole);
```

(Where `currentUserRole` is whatever the existing app state uses to track the user's role.)

- [ ] **Step 5: Manual smoke test**

Navigate to the device-config view. The new card should render with all 5 modes as "allowed". As admin, clicking "Disable" on a mode should send the PUT and the card should re-render.

- [ ] **Step 6: Commit**

```bash
git add playground/index.html playground/js/main.js playground/public/style.css
git commit -m "$(cat <<'EOF'
Replace allowed-modes checkboxes with Mode Enablement card

Each mode shows one of three states based on wb: allowed (no entry or
expired), watchdog cool-off (timestamp > now, < sentinel), or user
disabled (sentinel). Admin-only buttons: Disable (sets sentinel),
Clear cool-off (removes entry), Re-enable (removes entry). Uses the
existing PUT /api/device-config endpoint. Old am-based save logic
removed.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 26: Add Anomaly watchdogs settings card

**Files:**
- Modify: `playground/index.html`
- Modify: `playground/js/main.js`
- Modify: `playground/public/style.css`

**Purpose:** New card under Settings → Push notifications with per-watchdog enable toggles, snooze state display, and a "Show recent events" collapsible panel.

- [ ] **Step 1: Add the card HTML**

In `playground/index.html`, find the push notifications settings card. Add after it:

```html
<div id="watchdogs-card" class="card settings-card">
  <h3>Anomaly watchdogs</h3>
  <p class="settings-desc">Detect when a mode fails to produce its expected temperature change. When a watchdog fires, you have 5 minutes to respond before auto-shutdown.</p>
  <div id="watchdogs-list"></div>
  <details class="watchdog-history">
    <summary>Show recent events</summary>
    <div id="watchdogs-history-list"></div>
  </details>
</div>
```

- [ ] **Step 2: Add the renderer in `main.js`**

```js
function renderWatchdogsCard(snapshot, watchdogs, userRole) {
  const list = document.getElementById('watchdogs-list');
  if (!list) return;
  const isAdmin = userRole === 'admin';
  const now = Math.floor(Date.now() / 1000);

  list.innerHTML = '';
  watchdogs.forEach(w => {
    const row = document.createElement('div');
    row.className = 'watchdog-row';

    const enabled = snapshot.we && snapshot.we[w.id];
    const snoozeUntil = snapshot.wz && snapshot.wz[w.id];
    const isSnoozed = snoozeUntil && snoozeUntil > now;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!enabled;
    checkbox.disabled = !isAdmin;
    checkbox.addEventListener('change', () => {
      fetch('/api/watchdog/enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id: w.id, enabled: checkbox.checked })
      }).catch(err => console.error(err));
    });

    const label = document.createElement('label');
    label.className = 'watchdog-row-label';
    label.appendChild(checkbox);
    const text = document.createElement('span');
    text.innerHTML = '<strong>' + w.label + '</strong> — ' + w.mode;
    label.appendChild(text);

    row.appendChild(label);

    if (isSnoozed) {
      const snoozeInfo = document.createElement('div');
      snoozeInfo.className = 'watchdog-snooze-info';
      const remainingH = Math.floor((snoozeUntil - now) / 3600);
      const remainingM = Math.floor(((snoozeUntil - now) % 3600) / 60);
      snoozeInfo.textContent = '⏸ snoozed for ' + remainingH + 'h ' + remainingM + 'm';
      row.appendChild(snoozeInfo);
      if (isAdmin) {
        const clearBtn = document.createElement('button');
        clearBtn.className = 'watchdog-clear-snooze auth-btn';
        clearBtn.textContent = 'Clear snooze';
        clearBtn.addEventListener('click', () => {
          fetch('/api/device-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ wz: { [w.id]: 0 } })
          }).catch(err => console.error(err));
        });
        row.appendChild(clearBtn);
      }
    }

    list.appendChild(row);
  });
}

function renderWatchdogHistory(recent) {
  const list = document.getElementById('watchdogs-history-list');
  if (!list) return;
  list.innerHTML = '';
  if (!recent || recent.length === 0) {
    list.innerHTML = '<p class="empty-state">No events yet.</p>';
    return;
  }
  recent.forEach(ev => {
    const row = document.createElement('div');
    row.className = 'watchdog-history-row';
    const when = new Date(ev.fired_at).toLocaleString();
    const resolution = ev.resolution || 'pending';
    row.innerHTML =
      '<div class="history-row-top">' + when + ' — <code>' + ev.watchdog_id + '</code> — ' + resolution + '</div>' +
      '<div class="history-row-reason">' + (ev.trigger_reason || '') + '</div>' +
      (ev.snooze_reason ? '<div class="history-row-snooze">Snoozed: "' + ev.snooze_reason + '"</div>' : '');
    list.appendChild(row);
  });
}
```

- [ ] **Step 3: Add CSS**

Append to `playground/public/style.css`:

```css
.watchdog-row { padding: 8px 0; border-bottom: 1px solid var(--outline-variant, rgba(255,255,255,0.1)); }
.watchdog-row-label { display: flex; align-items: center; gap: 8px; }
.watchdog-snooze-info { font-size: 13px; color: var(--on-surface-variant); margin-top: 4px; }
.watchdog-clear-snooze { margin-top: 4px; padding: 2px 8px; font-size: 12px; }
.watchdog-history-row { padding: 6px 0; border-bottom: 1px solid var(--outline-variant); font-size: 13px; }
.history-row-top { font-weight: 600; }
.history-row-reason { color: var(--on-surface-variant); margin-top: 2px; }
.history-row-snooze { color: var(--primary); margin-top: 2px; font-style: italic; }
```

- [ ] **Step 4: Wire into initial state load**

Update the state-load fetch:

```js
    renderWatchdogsCard(state.snapshot, state.watchdogs, currentUserRole);
    renderWatchdogHistory(state.recent);
```

- [ ] **Step 5: Smoke test**

Navigate to Settings. The Anomaly watchdogs card should render with 3 rows and no events in history.

- [ ] **Step 6: Commit**

```bash
git add playground/index.html playground/js/main.js playground/public/style.css
git commit -m "$(cat <<'EOF'
Add Anomaly watchdogs settings card

Per-watchdog enable toggles (admin-only), snooze state display with
remaining time and 'Clear snooze' button, expandable recent events
panel showing fired_at, trigger_reason, resolution, and snooze_reason.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 27: Wire WebSocket `watchdog-state` subscription

**Files:**
- Modify: `playground/js/main.js`
- Modify: `server/server.js`

**Purpose:** The server already broadcasts state changes via `wsBroadcast` (called from anomaly-manager). Add the broadcast route and the client-side subscriber so the UI updates live.

- [ ] **Step 1: On the server, confirm `wsBroadcast` is wired**

The anomaly-manager init (Task 13) passed `wsBroadcast: broadcastToWebSockets`. Confirm that helper exists in `server/server.js`. Run: `grep -n 'broadcastToWebSockets\|ws.send\|ws\\.clients' server/server.js | head`

If a broadcast helper doesn't exist, create a small one:

```js
function broadcastToWebSockets(msg) {
  const str = JSON.stringify(msg);
  wsServer.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(str);
  });
}
```

(Adapt to the actual WebSocket library in use.)

- [ ] **Step 2: On the client, add the `watchdog-state` handler**

In the existing WebSocket `onmessage` handler in `main.js`, add a branch:

```js
  if (msg.type === 'watchdog-state') {
    renderWatchdogBanner(msg.pending);
    renderWatchdogsCard(msg.snapshot, msg.watchdogs, currentUserRole);
    renderModeEnablement(msg.snapshot.wb || {}, currentUserRole);
    if (msg.recent) renderWatchdogHistory(msg.recent);
    return;
  }
```

- [ ] **Step 3: Smoke test**

Start the server. Manually inject a mock `watchdog-state` broadcast (e.g., via a test endpoint or temporarily call `broadcastToWebSockets({type:'watchdog-state', pending: {...}})`) and verify the UI updates live.

- [ ] **Step 4: Commit**

```bash
git add playground/js/main.js server/server.js
git commit -m "$(cat <<'EOF'
Wire watchdog-state WebSocket broadcasts

Server: broadcastToWebSockets helper used by anomaly-manager.
Client: watchdog-state message handler re-renders banner, settings
card, mode enablement card, and history when any of these change.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 28: Add simulation integration test

**Files:**
- Create: `tests/simulation/watchdog-scenarios.test.js`

**Purpose:** End-to-end validation via the playground simulator: fire real detectAnomaly calls against synthetic sensor timeseries and assert the expected fires.

- [ ] **Step 1: Write the test**

```js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { detectAnomaly, MODES } = require('../../shelly/control-logic.js');

describe('watchdog scenarios', () => {
  const cfg = {
    ce: true,
    we: { sng: 1, scs: 1, ggr: 1 },
    wz: {},
    mo: null
  };

  it('ggr fires when greenhouse heating door is open', () => {
    const entry = { mode: 'GREENHOUSE_HEATING', at: 1000, greenhouse: 8, tankTop: 50, collector: 20 };
    // Simulate door open: greenhouse stays flat despite heating
    for (let t = 1000; t < 1900; t += 30) {
      const s = { collector: 20, tank_top: 48, tank_bottom: 40, greenhouse: 8.1, outdoor: 2 };
      const result = detectAnomaly(entry, t, s, cfg);
      if (t >= 1900) assert.fail('should have fired by now');
    }
    // At t=1900 (15 min elapsed), check
    const finalS = { collector: 20, tank_top: 48, tank_bottom: 40, greenhouse: 8.1, outdoor: 2 };
    const fired = detectAnomaly(entry, 1900, finalS, cfg);
    assert.strictEqual(fired, 'ggr');
  });

  it('scs fires when solar charging collector stays hot', () => {
    const entry = { mode: 'SOLAR_CHARGING', at: 1000, greenhouse: 15, tankTop: 40, collector: 80 };
    // Collector stays at 80 (stuck flow — hypothetically)
    const s = { collector: 79, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 15 };
    const fired = detectAnomaly(entry, 1300, s, cfg);  // 5 min elapsed
    assert.strictEqual(fired, 'scs');
  });

  it('healthy solar charging produces no fires over 24h of simulated ticks', () => {
    const entry = { mode: 'SOLAR_CHARGING', at: 0, greenhouse: 15, tankTop: 40, collector: 80 };
    // Healthy: collector drops, tank rises
    let fires = 0;
    for (let t = 0; t < 86400; t += 30) {
      const s = {
        collector: Math.max(50, 80 - (t / 3600) * 5),  // drops 5°C/hr
        tank_top: 40 + (t / 3600) * 3,                  // rises 3°C/hr
        tank_bottom: 30,
        greenhouse: 15,
        outdoor: 15
      };
      const fired = detectAnomaly(entry, t, s, cfg);
      if (fired) fires++;
    }
    assert.strictEqual(fires, 0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `node --test tests/simulation/watchdog-scenarios.test.js`
Expected: all 3 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/simulation/watchdog-scenarios.test.js
git commit -m "$(cat <<'EOF'
Add watchdog simulation integration tests

Three scenarios exercising detectAnomaly against synthetic sensor
timeseries: ggr fires on door-open, scs fires on stuck collector,
healthy solar charging over 24h produces zero fires.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 29: Add Playwright e2e for web UI ack flow

**Files:**
- Create: `tests/e2e/watchdog-flow.spec.js`

**Purpose:** End-to-end test using the existing Playwright fixtures. Mock an MQTT `fired` event on the server, verify the pending banner appears, submit an ack via the form, verify the banner clears.

- [ ] **Step 1: Check the existing Playwright fixture pattern**

Run: `cat tests/e2e/fixtures.js 2>/dev/null | head -30` OR `ls tests/e2e/`

Mirror whatever pattern the existing e2e tests use for test setup (login flow, server startup, etc.).

- [ ] **Step 2: Write the test**

```js
const { test, expect } = require('./fixtures.js');
const anomalyManager = require('../../server/lib/anomaly-manager.js');

test.describe('watchdog flow', () => {
  test('pending banner appears on fired event and clears on ack', async ({ page, loginAsAdmin }) => {
    await loginAsAdmin();
    await page.goto('/#status');

    // Simulate a fired MQTT event by calling the anomaly-manager directly
    // from the server process via a test-only endpoint, or by publishing
    // a test MQTT message. Adapt to the project's existing test fixture.
    await page.evaluate(async () => {
      // If the project exposes a test-only endpoint, call it here.
      // Otherwise mock via WebSocket message injection.
      await fetch('/api/_test/watchdog-fire', { method: 'POST', body: JSON.stringify({
        id: 'ggr', mode: 'GREENHOUSE_HEATING', el: 905, dG: 0.2, dT: 0, dC: 0, ts: Math.floor(Date.now()/1000)
      })});
    });

    await expect(page.locator('#watchdog-banner')).toBeVisible();
    await expect(page.locator('#watchdog-banner-title')).toContainText('ggr');

    await page.fill('#watchdog-banner-reply', 'door open testing');
    await page.click('#watchdog-banner-snooze');

    await expect(page.locator('#watchdog-banner')).toBeHidden({ timeout: 5000 });
  });

  test('readonly user cannot submit ack', async ({ page, loginAsReadonly }) => {
    await loginAsReadonly();
    await page.goto('/#status');

    // Simulate fired event
    await page.evaluate(async () => {
      await fetch('/api/_test/watchdog-fire', { method: 'POST', body: JSON.stringify({
        id: 'ggr', mode: 'GREENHOUSE_HEATING', el: 905, dG: 0.2, dT: 0, dC: 0, ts: Math.floor(Date.now()/1000)
      })});
    });

    await expect(page.locator('#watchdog-banner')).toBeVisible();

    const response = await page.evaluate(() => fetch('/api/watchdog/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ id: 'ggr', reason: 'test' })
    }).then(r => r.status));

    expect(response).toBe(403);
  });
});
```

**Note:** the `/api/_test/watchdog-fire` endpoint is hypothetical — if the project's e2e pattern uses real MQTT, wire an actual MQTT publish instead. Check `tests/e2e/*.spec.js` for the canonical pattern and adapt.

- [ ] **Step 3: Run the test**

Run: `npx playwright test tests/e2e/watchdog-flow.spec.js`
Expected: both tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/watchdog-flow.spec.js
git commit -m "$(cat <<'EOF'
Add Playwright e2e for watchdog flow

Two scenarios: admin ack via web UI (fired → banner → ack → clear),
and readonly role 403 on the ack endpoint even when the banner is
visible.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 30: Final verification and integration

**Files:**
- No new files. Run all test suites and perform a manual smoke test.

- [ ] **Step 1: Run the full unit test suite**

Run: `npm run test:unit`
Expected: all tests pass.

- [ ] **Step 2: Run the full e2e suite**

Run: `npm run test:e2e`
Expected: all tests pass.

- [ ] **Step 3: Lint the Shelly scripts**

Run: `node shelly/lint/bin/shelly-lint.js shelly/control.js shelly/control-logic.js`
Expected: no errors (SH-012 warnings for script size are pre-existing and acceptable).

- [ ] **Step 4: Regenerate the bootstrap-history snapshot**

Run: `npm run bootstrap-history`
Expected: snapshot regenerated. No watchdog fires in the default scenario because `we = {}` in the first-boot state.

- [ ] **Step 5: Manual smoke test**

Start the server, load the playground, verify:
- `#settings` → Anomaly watchdogs card appears with three watchdogs, all disabled
- `#settings` → Mode enablement card appears with all five modes shown as "allowed"
- Toggle a watchdog on, verify the `we` field updates in the device config
- `#status` banner does not appear (no pending fire)
- Disable a mode via the Mode enablement card, verify it becomes "disabled by user" and re-enable works

- [ ] **Step 6: Deploy to Shelly device**

Run: `bash shelly/deploy.sh`
Expected: device script slot 1 uploaded successfully. Shelly script runtime boots normally.

- [ ] **Step 7: Verify device operation**

Connect to the device's web interface or via MQTT, verify:
- `greenhouse/watchdog/event` topic is silent (no fires, default config)
- Device config now contains `we: {}`, `wb: {}`, `wz: {}` fields
- Legacy `am` field is gone

- [ ] **Step 8: Final commit (if needed)**

Any stray files from the verification phase go in a final commit. If nothing, skip.

```bash
git status
# if any untracked or modified files:
git add -A
git commit -m "$(cat <<'EOF'
Finalize watchdog feature — all tests passing

Full unit suite, e2e suite, and Shelly lint all clean. Bootstrap
history regenerated with no default fires. Device deployed and
verified operational with empty we/wb/wz config.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (for the plan author, done before handoff)

**Spec coverage:**
- §1 Overview → Task 1 (metadata), Task 5 (detection), Task 6 (ban check) ✓
- §3 V1 scope — three watchdogs → Task 5 ✓
- §3 First-boot `we = {}` → Task 30 Step 4 (verification) ✓
- §4 User-facing behavior → Tasks 23-27 (UI) + Task 22 (SW) ✓
- §5.1 KVS fields → Task 2 (validators) + Task 18-20 (device) ✓
- §5.4 Metadata → Task 1 ✓
- §6 Pure detection → Task 5 ✓
- §7 Device state machine → Tasks 17-21 ✓
- §8 MQTT protocol → Task 14 (server) + Task 17, 21 (device) ✓
- §9 Server anomaly manager → Tasks 7-13 ✓
- §10 Push notification → Task 16 + Task 8 (payload builder) + Task 22 (SW) ✓
- §11 `am` → `wb` migration → Task 3 + Task 25 (UI) ✓
- §12 Web UI → Tasks 23-27 ✓
- §13 Override interaction → Task 5 (mo.ss in detectAnomaly) + Task 6 (wb check with no bypass) + Task 19 (prev_ss tracking) ✓
- §14 Testing → Tasks 5, 6, 8-12 (unit) + Task 28 (simulation) + Task 29 (e2e) ✓
- §15 Migration and rollout → Task 3 + Task 30 ✓

No gaps. Every spec requirement traces to a task.

**Placeholder scan:** No TBDs, TODOs, FIXMEs, or "similar to Task N" references. Each task has its full code included.

**Type consistency:** `detectAnomaly` signature is consistent across tasks 5, 6, 19, 28. `anomaly-manager` public API is consistent across tasks 7-11, 13, 15. `wb` field shape is consistent across tasks 2, 3, 6, 19, 25.

No issues found.
