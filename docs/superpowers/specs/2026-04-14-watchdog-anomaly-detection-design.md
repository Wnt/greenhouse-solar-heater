# Watchdog anomaly detection — design

**Date:** 2026-04-14
**Status:** Design approved, pending user review
**Author:** Brainstormed with Claude Code

## 1. Overview

Add per-mode "anomaly watchdogs" that fire when the expected temperature effect of an active mode fails to materialize within a fixed window after mode entry. Firing starts a 5-minute grace period during which the user can:

1. **Snooze with a reason** (via push notification inline reply or web UI), which keeps the mode running for a per-watchdog TTL.
2. **Shut down now** (button in notification or web UI), which immediately safe-shuts the mode and bans re-entry for a cool-off period.
3. **Do nothing**, after which the system auto-safe-shuts the mode and applies the same cool-off ban.

The feature layers on top of the existing physical-state exits in `control-logic.js` — it does not replace them. The existing stall/timeout/threshold exits remain the safety floor and continue to run at the edge autonomously.

The "expected temperature delta didn't materialize" detection is new logic. The shutdown/ban interaction merges with, and replaces, the existing `am` (allowed_modes) filter to become a unified `wb` (mode ban) mechanism covering both user-set permanent disables and watchdog temporary cool-offs.

## 2. Motivation and goals

Current behavior on a mode where the physics should be working but the expected effect doesn't show up (e.g., greenhouse heating engaged but greenhouse air temperature not rising because a door is open) is to keep running indefinitely until the existing physical-state exits fire — or to waste stored thermal energy without benefit. A door-open scenario in particular has no automatic recovery: the system will pump heat out of the tank into an open-air environment for hours.

Goals:

- **Detect** the "expected effect missing" cases per mode, using only temperature-sensor data (no flow, level, or pressure sensors exist on this system).
- **Alert the user** via push notification with a useful inline action — "snooze with reason" — so a known benign cause can be recorded and the mode can keep running without the user needing to open the app.
- **Fail safe if the user is unavailable** — auto-shutdown after 5 min with no response.
- **Cool-off after shutdown** so a shut-down mode can't immediately re-enter and start the same failure loop; the mode is banned for a few hours, then auto-allowed again.
- **Unify mode bans** with the existing "allowed modes" config mechanism so there is one source of truth for "is this mode allowed to run right now".
- **Stay within Shelly constraints** — ES5, 16 KB concatenated script budget, 256-byte KVS entries, the SH-014 banned-method list, 5 concurrent timer slots. Watchdog additions must not add any new `Timer.set` and must not store string data on the device.

Non-goals:

- Not a replacement for the existing physical-state exits.
- Not a generic alerting / commands platform. Scoped narrowly to "expected temperature delta failed to materialize" at mode entry.
- Not a remote-control mechanism — "Shutdown now" is a safe-shutdown trigger, not a general mode switcher.

## 3. V1 scope

### In v1

- **Three watchdogs**, all triggering on mode-entry window:
  - `sng` — SOLAR_CHARGING: `tank_top` has not risen ≥ 0.5 °C within 10 min. Snooze TTL 2 h.
  - `scs` — SOLAR_CHARGING: `collector` has not dropped ≥ 3 °C within 5 min. Snooze TTL 1 h.
  - `ggr` — GREENHOUSE_HEATING: `greenhouse` has not risen ≥ 0.5 °C within 15 min. Snooze TTL 12 h.
- **5-minute pending grace period** after any fire, enforced by the existing 30 s `controlLoop` tick (no new `Timer.set`).
- **Three resolution paths**: user ack (snooze), user shutdown-now, auto-shutdown.
- **Uniform 4 h mode cool-off ban** after any shutdown, via `DEFAULT_CONFIG.watchdogBanSeconds` in `control-logic.js`.
- **Unified `wb` ban field** replacing `am`. Handles both user-set permanent bans (sentinel `9999999999`) and watchdog temporary bans (real unix timestamps).
- **Push notification** with Android-Chrome inline reply for snooze + plain button for shutdown-now.
- **Web UI** — pending banner on `#status`, watchdog enable/disable + live state in `#settings`, mode enablement card with ban display + clear actions.
- **Postgres-backed event history** with in-memory ring-buffer fallback.
- **Respects existing flags**: `ce=false` suspends detection; `mo.ss=true` suspends detection but does NOT clear bans; `fm` respects bans (strict — cannot force a banned mode).
- **Default first-boot state**: all watchdogs disabled (`we = {}`), so existing simulator/bootstrap tests are unaffected and the user opts in from the UI.
- **One-time migration** of legacy `am` configs to `wb` in `server/lib/device-config.js`.

### Not in v1 (deferred)

- `ACTIVE_DRAIN` and `EMERGENCY_HEATING` watchdogs.
- Mid-mode drift detection (only entry-window triggers in v1; conditions that develop mid-mode are out of scope).
- User-tunable thresholds (`0.5 °C`, `3 °C`) and windows (`300s`, `600s`, `900s`) — all hardcoded.
- Per-watchdog ban TTL overrides — uniform 4 h for v1.
- Per-watchdog snooze TTL overrides beyond the three defaults — all in metadata, requires redeploy to tune.
- Multi-watchdog concurrent pending — at most one pending per mode at a time.
- Readonly role ack capability — admin-only mutations.
- Notification when a ban auto-expires (silent re-enable).
- Ban extension / explicit re-fire while banned.
- History export (CSV, webhooks, etc.).
- Per-user notification routing beyond the existing category toggle.

## 4. User-facing behavior

### 4.1 Normal operation — no watchdog fire

The user configures which watchdogs they want enabled from Settings → Anomaly watchdogs. Each watchdog is independently toggleable and applies to the mode named in the row. Nothing else changes: modes enter and exit on their existing physical-state rules.

### 4.2 Watchdog fires

Scenario: GREENHOUSE_HEATING entered at 21:00. Window is 15 min. Greenhouse air temp measured at mode entry is 6.4 °C. At 21:15 (window elapsed), greenhouse temp is 6.6 °C — delta 0.2 °C, below the 0.5 °C threshold. `ggr` fires.

1. Device transitions to `watchdogPending { id: "ggr", firedAt: <21:15> }`. Mode remains GREENHOUSE_HEATING; the pump keeps running.
2. Device publishes MQTT `greenhouse/watchdog/event` with payload `{ t: "fired", id: "ggr", mode: "GREENHOUSE_HEATING", el: 900, dT: 0.3, dC: 0.0, dG: 0.2, ts: <unix> }`.
3. Server formats the human-readable reason `"Greenhouse only +0.2°C after 15:00 (expected ≥+0.5°C)"`, writes a Postgres row, dispatches a push notification, and broadcasts `watchdog-state` on the WebSocket.
4. The user sees a push notification with **title** "Watchdog fired — Greenhouse not warming", **body** "Greenhouse only +0.2°C after 15:00. Auto-shutdown in 5 min.", two **actions**: plain button "Shutdown now", and inline-reply text input "Snooze" with placeholder "Reason (e.g. door open)".
5. Simultaneously, any open web UI shows a prominent pending banner on `#status` with a live countdown, the same two actions, and a reason input field.

### 4.3 User acks with reason (snooze path)

User types `"door open, visiting today"` into the inline reply (or the web UI form) and submits.

1. Service worker (or web UI JS) POSTs to `/api/watchdog/ack` with `{ id: "ggr", eventId: <row>, reason: "door open, visiting today" }`.
2. Server validates admin role, looks up `snoozeTtlSeconds` (12 h for `ggr`), computes `snoozeUntil = now + 12h`, updates the Postgres row (`snooze_reason`, `snooze_until`, `resolved_by`, leaves `resolution` NULL until the device confirms).
3. Server publishes MQTT `greenhouse/watchdog/cmd` with `{ t: "ack", id: "ggr", u: <unix snoozeUntil> }`.
4. Device receives the ack, validates `state.watchdogPending.id === msg.id`, writes `deviceConfig.wz["ggr"] = msg.u` to KVS, clears pending state, and publishes a `resolved` event back with `how: "snoozed"`.
5. Server updates the row with `resolution = "snoozed"`, `resolved_at = now`.
6. WebSocket broadcasts the new state. UIs update — banner disappears, settings card shows "snoozed until 09:00".
7. Mode keeps running. Next mode entry within the snooze window skips `ggr` detection for that mode. After 12 h, snooze expires; detection resumes on the next mode entry.

### 4.4 User taps "Shutdown now"

1. Service worker / web UI POSTs to `/api/watchdog/shutdownnow` with `{ id: "ggr", eventId: <row> }`.
2. Server publishes MQTT `greenhouse/watchdog/cmd` with `{ t: "shutdownnow", id: "ggr" }`.
3. Device receives, validates pending, applies ban (`wb.GH = now + watchdogBanSeconds`), clears pending, transitions to IDLE, publishes `resolved` with `how: "shutdown_user"`.
4. The server-stored `trigger_reason` is what gets logged, not any user-typed text (the user did not type anything in this path).
5. Mode re-entry is blocked by the `wb.GH` check until the 4 h ban expires or an admin clears it manually.

### 4.5 User does nothing — auto-shutdown

1. 5 minutes elapse (±30 s granularity from the tick interval). The `controlLoop` tick sees `now - firedAt >= 300` and calls `autoShutdown("ggr")`.
2. Device applies the 4 h ban, clears pending, transitions to IDLE, publishes `resolved` with `how: "shutdown_auto"`.
3. The server-stored `trigger_reason` is what gets logged. No user reason exists.

### 4.6 Admin clears a ban

User navigates to Settings → Mode enablement, sees "GREENHOUSE_HEATING ⏸ cooling off — 3h 12m remaining", clicks "Clear cool-off". Web UI PUTs `/api/device-config` with the `wb.GH` entry removed. Server pushes the updated config via MQTT; device writes to KVS; mode becomes eligible on the next `controlLoop` tick.

### 4.7 Admin permanently disables a mode

Same screen, user clicks "Disable" next to a currently-allowed mode. Web UI PUTs `/api/device-config` with `wb.<mode> = 9999999999`. Server pushes; device writes; mode is permanently banned until explicitly re-enabled.

### 4.8 Mode is banned — all paths denied

- `evaluate` returns `IDLE` if `wb[targetMode] > now`.
- `fm = "GH"` is blocked — the ban check runs before `fm` is honored.
- `mo.ss=true` does not bypass the ban — the user must explicitly clear it first.
- Individual relay commands (`handleRelayCommand`) operate outside of `evaluate` and are gated only by `ce` and `ea` — they work freely. This is the intended commissioning escape hatch: set `ce=false`, drive relays directly, no ban gets in the way.

## 5. Data model

### 5.1 Device KVS `config` blob — new fields

All additions are compact-keyed to respect the 256-byte KVS entry limit. Existing fields (`ce`, `ea`, `fm`, `mo`, `v`) are unchanged. `am` is removed (migrated to `wb` at server side — see §11).

| Key | Type | Meaning |
|---|---|---|
| `we` | object | `{ <watchdogId>: 1 }` — presence & truthy = enabled. First-boot default: `{}`. |
| `wz` | object | `{ <watchdogId>: <unixSecondsSnoozeUntil> }` — absent entry = not snoozed. Numbers only. |
| `wb` | object | `{ <modeCode>: <unixSecondsBanUntil> }` — absent entry = allowed. Sentinel `9999999999` = user-set permanent ban. Watchdog temporary bans use real timestamps. |

**Worst-case size calculation** (all three watchdogs enabled + snoozed + all three modes banned):
`"we":{"sng":1,"scs":1,"ggr":1}` ≈ 28 B +
`"wz":{"sng":1713050000,"scs":1713050000,"ggr":1713053400}` ≈ 62 B +
`"wb":{"SC":9999999999,"GH":1713094215,"AD":9999999999}` ≈ 52 B
= **142 B total addition**, plus the existing ~90 B of pre-existing fields ≈ 232 B. Comfortably within the 256 B limit.

### 5.2 Device RAM (ephemeral, per-boot)

```js
state.mode_start              // EXISTING — unix milliseconds, set at existing transition sites
state.watchdog_baseline = {   // NEW — piggybacks on each mode_start assignment
  at:         <unix seconds>,
  tankTop:    <float>,
  collector:  <float>,
  greenhouse: <float>
};
state.watchdogPending = null  // NEW — or { id: "ggr", firedAt: <unix seconds> }
state.prev_ss = false         // NEW — tracks previous mo.ss state for baseline re-capture on ss-exit
```

No timer handle is stored, because no timer is started. No strings are stored. The device only holds the id literal (`"ggr"`, `"sng"`, `"scs"`) and numeric timestamps.

**Lost on reboot**: `watchdog_baseline`, `watchdogPending`, `prev_ss`. This is intentional — after a reboot the mode is re-initialized via the existing boot flow, a fresh baseline is captured on the next transition, and detection restarts from scratch. Any in-flight pending is abandoned (the server will see the device reconnect and can re-fire if conditions still hold). Snoozes survive in `wz` and bans survive in `wb` because both are in KVS.

### 5.3 Server-side Postgres schema

```sql
CREATE TABLE watchdog_events (
  id              BIGSERIAL PRIMARY KEY,
  watchdog_id     TEXT NOT NULL,            -- 'sng' / 'scs' / 'ggr'
  mode            TEXT NOT NULL,            -- full mode name at fire time
  fired_at        TIMESTAMPTZ NOT NULL,
  trigger_reason  TEXT NOT NULL,            -- server-formatted, e.g. "Greenhouse only +0.2°C after 15:00 (expected ≥+0.5°C)"
  resolution      TEXT,                     -- 'snoozed' / 'shutdown_user' / 'shutdown_auto' / NULL while pending
  resolved_at     TIMESTAMPTZ,
  snooze_until    TIMESTAMPTZ,              -- only for resolution='snoozed'
  snooze_reason   TEXT,                     -- user-typed; only for resolution='snoozed'
  resolved_by     TEXT                      -- passkey username, or 'auto' for auto-shutdown
);
CREATE INDEX ON watchdog_events (fired_at DESC);
```

If Postgres is unavailable (local mode without DATABASE_URL), an in-memory ring buffer of the most recent 200 events serves the same API surface. This matches the existing history pattern in `server/lib/db.js`.

### 5.4 Shared metadata — `shelly/watchdogs-meta.js`

New file, NOT concatenated into the Shelly script by `deploy.sh`. Loaded by the Node.js server via CommonJS `require` and by the playground simulator via the importmap. Single source of truth for what the device does not need at runtime.

```js
var WATCHDOGS = [
  { id: "sng", mode: "SOLAR_CHARGING",
    label: "No tank gain",
    shortLabel: "Tank not heating",
    windowSeconds: 600,   snoozeTtlSeconds:  7200 },
  { id: "scs", mode: "SOLAR_CHARGING",
    label: "Collector stuck",
    shortLabel: "Collector flow stuck",
    windowSeconds: 300,   snoozeTtlSeconds:  3600 },
  { id: "ggr", mode: "GREENHOUSE_HEATING",
    label: "No greenhouse rise",
    shortLabel: "Greenhouse not warming",
    windowSeconds: 900,   snoozeTtlSeconds: 43200 }
];
if (typeof module !== "undefined") module.exports = { WATCHDOGS: WATCHDOGS };
```

Thresholds (0.5 °C / 3 °C) remain inline in `detectAnomaly()` for v1. They can be pulled into this metadata later if tuning requires it without a code deploy.

## 6. Pure detection function — `control-logic.js`

New export in `control-logic.js`, approximately 20 lines, no strings, no allocations on the hot path.

```js
function detectAnomaly(entry, now, s, cfg) {
  if (!entry) return null;
  if (!cfg.ce) return null;                              // skip during commissioning / manual
  if (cfg.mo && cfg.mo.a && cfg.mo.ss) return null;      // suppressSafety suspends detection
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

**Properties:**

- Returns exactly one of `"sng"`, `"scs"`, `"ggr"`, or `null`. No object construction.
- First-fires-wins by shortest window: at t=600 in SOLAR_CHARGING where both `scs` and `sng` conditions hold, `scs` fires first (5-min window). This is intentional — co-firing on the same mode usually means one root cause.
- At most 6 comparisons + 6 property lookups per invocation. CPU cost negligible on the 30 s tick.
- Zero allocations on the hot path.
- All string formatting (human-readable `trigger_reason`) happens on the server after receiving the MQTT `fired` event.

**Unit-testable** via the existing simulator shim (`playground/js/control-logic-loader.js`).

**Also added to `control-logic.js`**: `DEFAULT_CONFIG.watchdogBanSeconds: 14400` (4 h uniform ban TTL).

## 7. Device state machine — `control.js`

### 7.1 Mode-entry baseline capture

At every existing `state.mode_start = Date.now()` site in `control.js` (currently at lines 181, 360, 396, 928 per the `mode_start` grep), add three lines to capture the baseline and clear any in-flight pending:

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

`state.mode_start` remains in milliseconds (unchanged for other consumers); `state.watchdog_baseline.at` is in unix seconds for the pure detection function's convenience.

### 7.2 Tick-based pending check and detection

Folded into `controlLoop()` after the existing pure-function call. No new `Timer.set`.

```js
var now = Math.floor(Date.now() / 1000);

// (a) Lazy prune of expired bans — cheap, at most 3 entries
if (deviceConfig.wb) {
  var changed = false;
  for (var m in deviceConfig.wb) {
    if (deviceConfig.wb[m] <= now) { delete deviceConfig.wb[m]; changed = true; }
  }
  if (changed) {
    Shelly.call("KVS.Set", { key: "config", value: JSON.stringify(deviceConfig) });
  }
}

// (b) Override-exit baseline reset — watchdog-related state only
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
    mode: state.currentMode,
    at:   state.watchdog_baseline.at,
    tankTop:    state.watchdog_baseline.tankTop,
    collector:  state.watchdog_baseline.collector,
    greenhouse: state.watchdog_baseline.greenhouse
  };
  var fired = detectAnomaly(entry, now, sensorValues, deviceConfig);
  if (fired) {
    state.watchdogPending = { id: fired, firedAt: now };
    publishWatchdogEvent({
      t: "fired", id: fired, mode: entry.mode,
      el: now - entry.at,
      dT: sensorValues.tank_top  - entry.tankTop,
      dC: entry.collector        - sensorValues.collector,
      dG: sensorValues.greenhouse - entry.greenhouse,
      ts: now
    });
  }
}
```

Branch (c) is mutually exclusive: a tick either checks pending OR runs detection, never both. When pending is active, detection is suppressed (the "at most one pending per mode" rule).

### 7.3 Resolution paths — three compact functions

```js
var WATCHDOG_MODE = { sng: "SC", scs: "SC", ggr: "GH" };

function applyBanAndShutdown(id, how) {
  var modeCode = WATCHDOG_MODE[id];
  deviceConfig.wb = deviceConfig.wb || {};
  var newUntil = Math.floor(Date.now() / 1000) + (deviceConfig.watchdogBanSeconds || 14400);
  var existing = deviceConfig.wb[modeCode] || 0;
  // max() so an existing permanent ban (sentinel) is never downgraded
  deviceConfig.wb[modeCode] = (existing > newUntil) ? existing : newUntil;
  Shelly.call("KVS.Set", { key: "config", value: JSON.stringify(deviceConfig) });
  state.watchdogPending = null;
  transitionTo(MODES.IDLE);
  publishWatchdogEvent({ t: "resolved", id: id, how: how });
}

function autoShutdown(id) {
  applyBanAndShutdown(id, "shutdown_auto");
}

function onWatchdogShutdownNow(id) {
  if (!state.watchdogPending || state.watchdogPending.id !== id) return;
  applyBanAndShutdown(id, "shutdown_user");
}

function onWatchdogAck(msg) {
  // msg = { t:"ack", id:"ggr", u:<unix seconds> } from MQTT
  if (!state.watchdogPending || state.watchdogPending.id !== msg.id) return;
  deviceConfig.wz = deviceConfig.wz || {};
  deviceConfig.wz[msg.id] = msg.u;
  Shelly.call("KVS.Set", { key: "config", value: JSON.stringify(deviceConfig) });
  state.watchdogPending = null;
  publishWatchdogEvent({ t: "resolved", id: msg.id, how: "snoozed" });
  // NOTE: mode is NOT transitioned — snooze keeps it running
}
```

**Idempotency**: the `state.watchdogPending.id !== msg.id` guard in `onWatchdogAck` / `onWatchdogShutdownNow` makes duplicate MQTT deliveries a no-op. Safe under QoS 1.

### 7.4 Ban enforcement in `evaluate` — `control-logic.js`

One block added to `evaluate`, placed **before** the existing `fm` check at `control-logic.js:396` so that forced mode also respects bans (strict semantics).

```js
// ── Unified mode ban check ──
// Applies regardless of fm / mo. Only 'ce=false' and explicit ban clearing bypass.
// Runs BEFORE the fm early-return so that fm cannot force a banned mode.
var nextModeCode = /* compute from pumpMode via shortCodeOf() */;
if (dc && dc.wb && dc.wb[nextModeCode] && dc.wb[nextModeCode] > state.now) {
  return makeResult(MODES.IDLE, flags, dc);
}
```

**Deleted**: the old `am` filter block at `control-logic.js:420-433` is removed — its semantics are now carried by `wb` with the sentinel permanent-ban value.

### 7.5 Footprint summary

| File | Lines added | Lines removed |
|---|---|---|
| `control-logic.js` | ~25 (detectAnomaly + ban check + DEFAULT_CONFIG entry) | ~15 (old `am` filter block) |
| `control.js` | ~40 (baseline capture × 4 + tick block + 3 resolution fns + publish helper + WATCHDOG_MODE const) | 0 |
| `shelly/watchdogs-meta.js` | ~20 (new file, not deployed to device) | — |

**Hot-path allocations per tick**: 0 when nothing fires, 1 short object when firing (rare event, not hot).
**New `Timer.set` calls**: 0.
**New KVS keys**: 0 (extends existing `config` blob).
**Banned SH-014 methods used**: 0.

## 8. MQTT protocol

Three new topics, following the existing `greenhouse/*` convention.

| Topic | Direction | Payloads |
|---|---|---|
| `greenhouse/watchdog/event` | device → server | `{t:"fired", id, mode, el, dT, dC, dG, ts}` or `{t:"resolved", id, how, ts}` where `how ∈ {snoozed, shutdown_user, shutdown_auto}` |
| `greenhouse/watchdog/cmd`   | server → device | `{t:"ack", id, u}` or `{t:"shutdownnow", id}` |

No new topic is needed for enable/disable toggles or ban changes — those ride on the existing `config` push stream.

**Ordering**: per-topic FIFO is preserved by MQTT QoS 1. A `fired → ack → resolved` chain stays ordered.

**Idempotency**: duplicate deliveries are no-ops on the device side thanks to the pending-id guard (see §7.3).

**Reconnect behavior**: when the device reconnects after a brief disconnect, any pending event it publishes (e.g., if the fire happened during the gap) will be delivered as soon as MQTT reestablishes. The server's anomaly-manager treats a `fired` event with no prior pending as a new event, and a `resolved` event with no corresponding server-side pending as a terminal log entry (UPDATE by id + most-recent-fire-at).

## 9. Server-side anomaly manager — `server/lib/anomaly-manager.js`

New module, approximately 180 lines. Wires into `mqtt-bridge`, Postgres (with ring-buffer fallback), the push notification dispatcher, and the existing WebSocket broadcast path.

### 9.1 Public API

```js
module.exports = {
  init(opts),                    // wire MQTT subscriptions + DB init
  handleDeviceEvent(msg),        // called from mqtt-bridge on watchdog/event
  getState(),                    // for GET /api/watchdog/state
  ack(id, reason, user),         // user ack path — called from HTTP endpoint
  shutdownNow(id, user),         // user shutdown-now path
  setEnabled(id, enabled, user), // flip we[id] in deviceConfig
  getHistory(limit)              // for UI history list
};
```

### 9.2 Internal state

```js
{
  pending: null | {
    id, firedAt, mode, triggerReason, dbEventId,
    /* cached from fire event for UI/notification use */
  },
  lastConfigSnapshot: { we, wz, wb },   // mirror from latest device config push
  historyRingBuffer: [/* last 200 events, used only if no DB */]
}
```

### 9.3 `handleDeviceEvent(msg)` flow

**On `{t:"fired", ...}`:**
1. Format `trigger_reason` via `formatReason(msg)`.
2. Insert Postgres row with `resolution=NULL`. Get back row id → `dbEventId`.
3. Set `this.pending = { id, firedAt: msg.ts, mode: msg.mode, triggerReason, dbEventId }`.
4. Call `push.sendByCategory("watchdog_fired", buildNotificationPayload(...))`.
5. Broadcast `{type:"watchdog-state", pending: this.pending, ...}` on WebSocket.

**On `{t:"resolved", id, how, ts}`:**
1. Find the Postgres row with `watchdog_id = id AND resolution IS NULL` ordered by `fired_at DESC LIMIT 1`. There is normally exactly one such row (the pending one). If none exists (e.g. server restarted mid-pending and lost the pending-state), find the most recent row for that watchdog id and update it anyway for audit completeness.
2. Set `resolution = how`, `resolved_at = ts`. For `how = "snoozed"`, the `snooze_until` and `snooze_reason` columns were already populated by the ack path (§9.4); this step just flips `resolution` from NULL to `"snoozed"` to mark the cycle complete.
3. Clear `this.pending` if `this.pending.id === id`.
4. Broadcast `{type:"watchdog-state", pending: null, ...}` on WebSocket.

### 9.4 `ack(id, reason, user)`

1. If `user.role !== "admin"`, return 403 at the HTTP layer (before `ack` is called).
2. If `this.pending === null || this.pending.id !== id`, return 409 "no matching pending".
3. Look up `snoozeTtlSeconds` from `WATCHDOGS` metadata (default fallback: 3600 if unknown).
4. Compute `snoozeUntil = now + snoozeTtlSeconds`.
5. Update Postgres row: `snooze_reason = reason`, `snooze_until = snoozeUntil`, `resolved_by = user.name`. Leave `resolution` NULL — the device's `resolved` event completes it.
6. Publish MQTT `greenhouse/watchdog/cmd` → `{t:"ack", id, u: snoozeUntil}`.
7. Return 200 with `{ snoozeUntil }`.

### 9.5 `shutdownNow(id, user)`

1. Admin-only (HTTP layer).
2. If no matching pending, 409.
3. Update Postgres row: `resolved_by = user.name`. (`resolution` will be set to `"shutdown_user"` when the device's `resolved` event arrives.)
4. Publish MQTT `greenhouse/watchdog/cmd` → `{t:"shutdownnow", id}`.
5. Return 200.

### 9.6 `setEnabled(id, enabled, user)`

1. Admin-only.
2. Validate `id` is one of the known watchdog ids.
3. Call `deviceConfig.updateConfig({ we: { ...current, [id]: enabled ? 1 : 0 } })` (or use the existing partial-update path).
4. Publish via `mqttBridge.publishConfig(updated)`.
5. Return 200.

### 9.7 `formatReason(msg)` — single authoritative text formatter

```js
function formatReason(e) {
  var m = Math.floor(e.el / 60) + ":" + pad2(e.el % 60);
  if (e.id === "sng") return "Tank only +"       + f1(e.dT) + "°C after " + m + " (expected ≥+0.5°C)";
  if (e.id === "scs") return "Collector only -"  + f1(e.dC) + "°C after " + m + " (expected ≥-3°C)";
  if (e.id === "ggr") return "Greenhouse only +" + f1(e.dG) + "°C after " + m + " (expected ≥+0.5°C)";
  return "Unknown watchdog: " + e.id;
}
```

Called once on `fired` receipt. Result stored in `trigger_reason` column and reused everywhere.

### 9.8 `server/lib/device-config.js` — new partial-update field validators

`device-config.js` has explicit per-field validators at `lines 157-186` for `ce`, `ea`, `fm`, `am`, `mo`. Three new validators must be added for the watchdog fields:

```js
// we (watchdogs_enabled): object with 0/1 values per watchdog id
if (newConfig.we !== undefined) {
  if (newConfig.we === null) {
    config.we = {};
  } else if (typeof newConfig.we === 'object') {
    var we = {};
    var knownIds = ['sng', 'scs', 'ggr'];
    for (var i = 0; i < knownIds.length; i++) {
      if (newConfig.we[knownIds[i]] !== undefined) {
        we[knownIds[i]] = newConfig.we[knownIds[i]] ? 1 : 0;
      } else if (config.we && config.we[knownIds[i]] !== undefined) {
        we[knownIds[i]] = config.we[knownIds[i]];   // preserve existing
      }
    }
    config.we = we;
  }
}

// wz (watchdog_snooze): object with unix-seconds values; 0 or null removes entry
if (newConfig.wz !== undefined) {
  if (newConfig.wz === null) {
    config.wz = {};
  } else if (typeof newConfig.wz === 'object') {
    config.wz = config.wz || {};
    var knownIds = ['sng', 'scs', 'ggr'];
    for (var i = 0; i < knownIds.length; i++) {
      var v = newConfig.wz[knownIds[i]];
      if (v === 0 || v === null) {
        delete config.wz[knownIds[i]];
      } else if (typeof v === 'number' && v > 0) {
        config.wz[knownIds[i]] = v;
      }
    }
  }
}

// wb (mode bans): object with unix-seconds values; 0 or null removes entry
if (newConfig.wb !== undefined) {
  if (newConfig.wb === null) {
    config.wb = {};
  } else if (typeof newConfig.wb === 'object') {
    config.wb = config.wb || {};
    var modeKeys = ['I', 'SC', 'GH', 'AD', 'EH'];
    for (var i = 0; i < modeKeys.length; i++) {
      var v = newConfig.wb[modeKeys[i]];
      if (v === 0 || v === null) {
        delete config.wb[modeKeys[i]];
      } else if (typeof v === 'number' && v > 0) {
        config.wb[modeKeys[i]] = v;
      }
    }
  }
}
```

**Semantics of `null` / `0`**: passing `null` or `0` for a specific key **removes** that entry (clears snooze or clears ban). Passing `null` for the whole field resets it to empty. This is what the UI uses for "Clear snooze" and "Clear cool-off" / "Re-enable" actions.

**`am` field validator removal**: the existing `am` validator block at `lines 166-181` is deleted after the `migrateAmToWb` runs once. The migration is idempotent and safe to run on any config load; removing the `am` validator prevents new writes from bringing `am` back.

### 9.9 HTTP endpoints — added to `server/server.js`

| Method | Path | Body | Role | Purpose |
|---|---|---|---|---|
| `GET`  | `/api/watchdog/state`        | —                     | any authed | Returns `{ pending, watchdogs: [...], recent: [...] }` for initial UI load |
| `POST` | `/api/watchdog/ack`          | `{id, eventId, reason}` | admin      | Calls `anomalyManager.ack()` |
| `POST` | `/api/watchdog/shutdownnow`  | `{id, eventId}`       | admin      | Calls `anomalyManager.shutdownNow()` |
| `PUT`  | `/api/watchdog/enabled`      | `{id, enabled}`       | admin      | Calls `anomalyManager.setEnabled()` |

Admin enforcement uses the existing `isAdminOrReject()` helper (per CLAUDE.md). `PUT /api/device-config` remains the endpoint for ban mutations (`wb` field) — no new endpoint needed for "Clear cool-off" or "Disable mode".

## 10. Push notification and inline reply

### 10.1 New notification category

Add `watchdog_fired` to `VALID_CATEGORIES` in `server/lib/push.js`. Add a row to Settings → Push notifications with a per-category toggle, following the existing pattern. Icon asset: `assets/notif-watchdog.png` (new — to be designed).

### 10.2 Notification payload

```js
{
  title: "Watchdog fired — Greenhouse not warming",
  body:  "Greenhouse only +0.2°C after 15:00. Auto-shutdown in 5 min.",
  icon:  "assets/notif-watchdog.png",
  badge: "assets/badge-72.png",
  tag:   "watchdog-" + id,                // e.g. "watchdog-ggr"
  renotify: true,
  requireInteraction: true,               // do not auto-dismiss
  actions: [
    { action: "shutdownnow", type: "button", title: "Shutdown now" },
    { action: "snooze",      type: "text",   title: "Snooze",
      placeholder: "Reason (e.g. door open)" }
  ],
  data: {
    kind: "watchdog_fired",
    eventId: 42,                          // Postgres row id — primary correlation key
    watchdogId: "ggr",
    url: "/#status"
  }
}
```

### 10.3 Service worker extension — `playground/sw.js`

Extended `notificationclick` handler (grafted onto the existing one):

```js
self.addEventListener('notificationclick', function (event) {
  var data = event.notification.data || {};
  event.notification.close();

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
    // Main click (no action) falls through to the existing "open window at url" logic
  }

  // ... existing open-window logic for regular notifications ...
});
```

### 10.4 Platform fallback

- **Android Chrome**: full behavior — both the "Shutdown now" button and the inline-reply text field work.
- **iOS Safari, Firefox desktop/Android, any platform without notification action rendering**: the notification is still shown; tapping it is a main click → opens `/#status` → the user acks via the web UI. Same backend endpoints. No user is stuck.
- **No notification permission at all**: the web UI banner on `#status` remains the canonical path. Auto-shutdown still fires at the 5 min mark.

## 11. Mode ban unification — merging `am` into `wb`

The existing `am` (allowed_modes) field is deprecated and replaced by `wb`. This gives one source of truth for "is this mode allowed to run right now".

### 11.1 Sentinel convention

A `wb[mode]` entry with value `9999999999` (year 2286 in unix seconds) represents a user-set permanent ban. Any other positive value represents a watchdog temporary ban expiring at that timestamp.

- Ban check: `wb[mode] && wb[mode] > now` — sentinel passes naturally.
- Lazy prune: `wb[mode] <= now` — sentinel fails naturally (stays).

No special-case code needed; the sentinel is just a very large timestamp.

### 11.2 Migration

On config load in `server/lib/device-config.js`, detect legacy `am` and translate to `wb`:

```js
var ALL_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];

function migrateAmToWb(cfg) {
  if (cfg.am && Array.isArray(cfg.am) &&
      cfg.am.length > 0 && cfg.am.length < ALL_MODES.length) {
    cfg.wb = cfg.wb || {};
    for (var i = 0; i < ALL_MODES.length; i++) {
      if (cfg.am.indexOf(ALL_MODES[i]) === -1) {
        cfg.wb[ALL_MODES[i]] = 9999999999;
      }
    }
  }
  delete cfg.am;
  return cfg;
}
```

Migration runs once per config load. After the first server push with the migrated config, the device no longer has `am` in its KVS.

### 11.3 Device-side filter replacement

`control-logic.js:420-433` (the existing `am` filter block) is deleted. Replaced with the unified `wb` check (§7.4), placed BEFORE the `fm` early-return at line 396 so that `fm` also respects bans.

### 11.4 UI rework — Mode enablement card

The existing "Allowed modes" checkbox UI in `main.js:2144-2150, 2180-2184` is replaced with a more explicit Mode enablement card. Per-mode rendering:

| Current `wb[mode]` state | Display | Admin actions |
|---|---|---|
| absent or 0 | `• allowed` | `[ Disable ]` — sets `wb[mode] = 9999999999` |
| `= 9999999999` | `✕ disabled by user` | `[ Re-enable ]` — deletes `wb[mode]` |
| `> now` and `< 9999999999` | `⏸ cool-off — N h M m remaining` + "Triggered: <reason>" | `[ Clear cool-off ]` — deletes `wb[mode]` |

While a temporary cool-off is active, there is no "Re-enable" button — per user intent, the cool-off must be cleared explicitly first. (A mode can't be simultaneously user-disabled and watchdog-cool-off because `wb` holds one value per mode; the "max" guard in `applyBanAndShutdown` ensures a user-set permanent ban is never downgraded by a subsequent watchdog fire.)

All mutations use the existing `PUT /api/device-config` endpoint (admin-only via `isAdminOrReject`). No new endpoints needed for ban control.

## 12. Web UI

### 12.1 `#status` — pending banner

Rendered only when `watchdog-state.pending !== null`. Appears above the main status card; cannot be dismissed.

```
┌─────────────────────────────────────────────┐
│  ⚠  Watchdog fired: No greenhouse rise       │
│  Greenhouse only +0.2 °C after 15:00         │
│  (expected ≥ +0.5 °C)                        │
│                                              │
│  Auto-shutdown in 3 min 42 s                 │   ← ticks locally from firedAt
│                                              │
│  [ Reason (e.g. door open)            ]      │
│  [ Snooze with reason ]   [ Shutdown now ]   │
└─────────────────────────────────────────────┘
```

- Countdown ticks locally on the client using `firedAt + 300`.
- Banner disappears on the next `watchdog-state` broadcast showing `pending: null`.
- Admin role: both buttons active.
- Readonly role: buttons rendered but disabled; informational only.
- If the ban was already active when the server sends state (e.g., page load after auto-shutdown), the banner is not shown; the cool-off indicator in the settings card and a smaller status-card inline indicator show the cool-off state.

### 12.2 `#status` — cool-off inline indicator

Small indicator below the main status card, visible when any mode has `wb[mode] > now` (and the mode is one that would otherwise be allowed by physics):

```
⏸ Greenhouse heating cooling off until 18:32 (3h 12m remaining)
```

Purely informational on `#status`. Admin actions live in the settings card.

### 12.3 `#settings` — Anomaly watchdogs card

```
Anomaly watchdogs
─────────────────────────────────────────────
  [x] Solar charging: No tank gain       • enabled
      Tank top must rise ≥ 0.5 °C within 10 min of mode start.

  [x] Solar charging: Collector stuck    ⏸ snoozed until 14:32 (1h)
      "collector flow noisy, bleeding radiator"              ← user's snooze reason
      Collector must drop ≥ 3 °C within 5 min of mode start.

  [x] Greenhouse heating: No rise        • enabled
      Greenhouse must rise ≥ 0.5 °C within 15 min.

  [ Show recent events (10)  ▼ ]
```

- Checkbox toggles `we[id]` via `PUT /api/watchdog/enabled`.
- Snooze display shows `snooze_reason` from the DB row if available.
- "Clear snooze" affordance is an admin-only link next to each snoozed row (shown only on hover or expanded state): sends `PUT /api/device-config` with body `{wz: {[id]: 0}}`. The `wz` validator (§9.8) interprets `0` as "remove this entry".
- Recent events panel (expandable): paginated list of the last 10 `watchdog_events` rows showing `fired_at`, `mode`, `trigger_reason`, `resolution`, `snooze_reason` (if present), `resolved_by`.

### 12.4 `#settings` — Mode enablement card

Replaces the current "Allowed modes" checkbox UI. Rendered per §11.4.

### 12.5 Live state synchronization

Server broadcasts `{type: "watchdog-state", pending, watchdogs, modeBans, recent}` on:
- `fired` event from device.
- `resolved` event from device.
- `setEnabled` (enable/disable toggle).
- `device-config` update containing changes to `wb`.

Web UI subscribes on the existing WebSocket connection and re-renders the banner, the watchdogs card, and the mode enablement card reactively. On initial page load and on WebSocket reconnect, UI calls `GET /api/watchdog/state` as a safety net against missed events.

## 13. Interaction with existing override and commissioning

### 13.1 `mo` (manual override) — §8 amended

| `mo.a` | `mo.ss` | Watchdog detection | Ban enforcement |
|---|---|---|---|
| false | — | Normal | Enforced |
| true  | false | Normal | Enforced |
| true  | true  | **Suspended** (no new fires, pending cleared on entry) | **Still enforced** (ban is not bypassed or cleared) |

Entering override does NOT clear any `wb` entry. The only way to run a banned mode is to explicitly clear the ban via the Mode enablement card.

**Baseline re-capture on `mo.ss=true` → false transition**: at the next `controlLoop` tick after override exits, the watchdog baseline is re-captured from current sensors, so detection resumes against a fresh baseline rather than stale values from mode entry potentially hours earlier. Implemented via the `state.prev_ss` tracking flag in §7.2.

### 13.2 `fm` (forced mode) — strict

`fm` respects `wb`. The ban check at §7.4 runs before the `fm` early-return. Forcing a banned mode is denied; mode falls to IDLE.

Escape hatch: admin clears the ban via the Mode enablement card, then sets `fm`.

### 13.3 `ce` (controls enabled) — existing commissioning escape

When `ce = false`:
- The existing actuator guards (`control.js:73-96`) refuse to energize pump/fan/heater.
- `evaluate` short-circuits to `result.suppressed = true` (`control-logic.js:182`).
- `detectAnomaly` short-circuits (§6 — new early-exit `if (!cfg.ce) return null;`).
- Watchdogs do not fire; no bans get set.
- Individual relay commands via `handleRelayCommand` continue to work, subject only to `ea` (enabled_actuators) gates.

This preserves the existing commissioning workflow unchanged: set `ce=false`, exercise valves/pump individually through the relay controls view, then set `ce=true` to return to automated operation. No watchdog interaction.

## 14. Testing strategy

### 14.1 Unit tests — `tests/unit/detect-anomaly.test.js`

Pure function tests, table-driven, no mocks:

| Case | Inputs | Expected |
|---|---|---|
| no entry | `entry=null` | `null` |
| `ce=false` | firable | `null` |
| `mo.ss=true` | firable | `null` |
| `mo.a=true, mo.ss=false` | firable | fires (manual mode ≠ suppress) |
| window not elapsed | `el=120`, thresholds met | `null` |
| SC threshold not met (sng) | `el=700, dT=0.8` | `null` |
| SC threshold met (sng) | `el=700, dT=0.2` | `"sng"` |
| SC priority (both fire at t=600) | `el=600`, both conditions true | `"scs"` (5-min wins) |
| `we.sng=0` (disabled) | firable | `null` |
| `wz.sng > now` (snoozed) | firable | `null` |
| `wz.sng <= now` (snooze expired) | firable | `"sng"` |
| mode not matched | mode = ACTIVE_DRAIN | `null` |

### 14.2 Ban check tests — extends existing `control-logic` tests

| Case | `wb`/`mo`/`fm` state | Target next mode | Expected |
|---|---|---|---|
| no ban | `wb={}` | `GH` | `GH` |
| ban active | `wb.GH = now + 1000` | `GH` | `IDLE` |
| ban expired | `wb.GH = now - 1000` | `GH` | `GH` *(lazy prune removes it elsewhere)* |
| permanent ban | `wb.GH = 9999999999` | `GH` | `IDLE` |
| ban + `mo.ss=true` | `wb.GH > now`, ss=true | `GH` | `IDLE` *(ban still enforced)* |
| ban + `fm="GH"` | `wb.GH > now`, fm=GH | — | `IDLE` *(fm cannot force banned mode)* |

### 14.3 Simulation integration — `tests/simulation/watchdog-scenarios.test.js`

End-to-end via the existing playground simulator (loads `control-logic.js` through the CommonJS shim):

- Solar charging with stuck flow → `scs` fires at t ≈ 300 s.
- Greenhouse heating with simulated "door open" (greenhouse temp held constant) → `ggr` fires at t ≈ 900 s.
- Healthy solar charging over 24 h → no fires.
- Auto-shutdown → ban set → advance clock 4 h + 1 s → lazy prune removes entry → mode re-enters if physics permits.
- `mo.ss=true` → exit → baseline re-captured → no spurious fire.
- Snooze applied → subsequent mode entry within snooze window → no fire.

### 14.4 End-to-end — `tests/e2e/watchdog-flow.spec.js` (Playwright)

- Mock MQTT bridge publishes a `fired` event → assert pending banner appears on `#status` → submit ack form → assert `POST /api/watchdog/ack` is called with expected body → assert banner disappears on broadcast.
- Synthetic `notificationclick` in SW with `event.action='snooze'` and `event.reply='door open'` → assert fetch call to `/api/watchdog/ack` fires with expected body.
- Readonly role: same `fired` event shows the banner but the buttons are disabled; direct call to `POST /api/watchdog/ack` returns 403.
- Mode enablement card: admin clicks "Disable" → `wb.GH` set to sentinel → mode blocked.
- Mode enablement card: admin clicks "Clear cool-off" → `wb.GH` removed → mode becomes allowed.
- Migration test: load a config fixture with old `am` → assert it's translated to `wb` with sentinel entries for missing modes.

### 14.5 CI guardrails

- **`shelly/lint`** enforces SH-014, script size, template literal / arrow function / destructuring bans, timer/handler caps. Feature complies by construction.
- **Bootstrap-history drift test** (`tests/bootstrap-history-drift.test.js`): default first-boot state is `we = {}` so no watchdogs fire in the default bootstrap scenario and the pre-baked snapshot is unaffected.

## 15. Migration and rollout

### 15.1 Configuration migration

- First deployment with this feature: `server/lib/device-config.js` runs `migrateAmToWb` on the next config load. Any existing `am` array is translated to `wb` entries with the permanent sentinel; `am` is deleted.
- Migration is idempotent — running it on a config that has no `am` is a no-op.
- The device's KVS will contain the old `am` until the first server push after migration. Both fields coexist temporarily but the device-side filter block that reads `am` has been deleted — so `am` has no effect once the new code is deployed, regardless of whether the migration has written yet.

### 15.2 First-boot watchdog state

Default is `we = {}` (all disabled). The user opts in from Settings → Anomaly watchdogs once they're ready to start exercising the feature. This protects the existing simulator bootstrap-history scenario and gives the user a controlled rollout during commissioning.

### 15.3 Deploying to device

Standard `deploy.sh` flow (concatenates `control-logic.js + control.js` into slot 1 via `Script.PutCode` in 512-byte chunks). The Shelly linter's `SH-012` script-size rule emits a **warning** above 16 KB but does not block deployment; the existing `control-logic.js` is already ~29 KB and `control.js` is ~33 KB, so adding ~65 lines (~2 KB) is well within the actual operational envelope.

The linter still runs before deploy and strictly blocks:
- SH-014 banned array methods (`shift`, `unshift`, `splice`, `sort`, `flat`, `flatMap`, `findLast`, `findLastIndex`)
- `class`, `async`/`await`, `Promise`/`.then`/`.catch`
- `fetch`/`XMLHttpRequest`/`WebSocket`/`Worker`/`localStorage`
- Resource limits (5 timers, 5 event handlers, 5 concurrent RPC calls)

And warns on:
- Template literals
- Destructuring
- Arrow functions with implicit return

The design respects all of these by construction: no class syntax, no promises, no fetch (device→server via MQTT only), no banned array methods, no new timers, no template literals in added code.

### 15.4 Rollback

Rolling back is straightforward: revert the code, redeploy via `deploy.sh`. The device's KVS will still contain `we`, `wz`, `wb` fields — they'll simply be ignored by the reverted code. No data migration needed on rollback. The server-side `watchdog_events` table stays in place as historical data.

## 16. Open questions and deferred items

None blocking v1. The following are v2+ candidates captured for future work:

- Mid-mode drift detection (conditions developing after the entry window).
- Per-watchdog ban TTL overrides (currently uniform 4 h).
- User-tunable thresholds/windows without a device redeploy.
- `ACTIVE_DRAIN` and `EMERGENCY_HEATING` watchdogs (each requiring its own detection rule).
- Readonly role ack capability.
- Snooze extension (user can refresh a snooze TTL without re-firing).
- History analytics ("door open" has been used 12 times this month — suggest mode disable).
- Notification on ban auto-expiry ("GREENHOUSE_HEATING is allowed again").
