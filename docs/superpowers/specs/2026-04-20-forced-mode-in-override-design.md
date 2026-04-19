# Forced mode folded into manual override

**Date:** 2026-04-20
**Status:** Design approved, pending implementation plan

## Problem

The "Forced mode" selector on the Controls view today lives next to the device-config block. It writes a top-level `fm` field (`"I"|"SC"|"GH"|"AD"|"EH"`) into device config. Control-logic reads it *after* the 5-minute minimum-mode-duration hold (`shelly/control-logic.js:297-307`), so switching forced mode can take up to 5 minutes to take effect. The selector is also detached from the "Manual relay testing" card, which is the natural home for commissioning/testing flows.

Separately: exiting manual override today only clears the `mo` flag. Whatever relays the user left on stay on, and automation resumes from an inconsistent physical state. On a sudden network outage there is no server-driven cleanup — the device must be authoritative.

## Goals

1. Relocate forced-mode selection into the Manual Override / valve-testing card, gated by the override lifecycle.
2. Make forced-mode transitions take effect immediately — bypass the 5-minute minimum-mode-duration hold.
3. On override exit (user-triggered, TTL expiry, safety preemption), force the controller into IDLE with a proper staged valve transition.
4. Reflect forced-mode state on the Status view so it is visually clear that the current mode was chosen by an operator, not by automation.
5. Do not add new MQTT topics (Shelly Pro 4PM subscription budget is saturated).

## Non-goals

- Long-running `fm` outside of a manual-override session. The "staged deployment" use case described in `shelly/control-logic.js:425` is retired; forced mode is always bounded by the override TTL (1 min–1 hr).
- Changes to the watchdog mode-ban (`wb`) mechanism. Bans still block forced modes — selecting a banned mode is rejected in UI and server.
- Changes to the sensor-config flow, the relay-soundboard hardware protection (200 ms queue), or the staged-transition scheduler.

## Schema change

Compact keys in device config (256-byte KVS limit):

| Key | Today | After |
|---|---|---|
| `ce` | controls_enabled | unchanged |
| `ea` | enabled_actuators bitmask | unchanged |
| `fm` | forced_mode `"I|SC|GH|AD|EH"` | **removed** |
| `am` | allowed_modes (legacy) | unchanged |
| `wb` | mode-ban map | unchanged |
| `mo` | `{ a, ex, ss }` | `{ a, ex, ss, fm? }` — **`fm` added** |
| `v` | version | unchanged |

Lifecycle of `mo.fm`:

- Only valid when `mo.a === true`. Server rejects writes that set `mo.fm` outside an active override.
- Cleared with the rest of `mo` on: user exit, TTL expiry (device-side or server-side), safety preemption (freeze-drain / overheat-drain).
- Ban check: selecting `mo.fm = X` while `wb[X]` is active is rejected with `Mode banned`.

Net byte impact of the move: drop `"fm":"SC"` (9 B) from top level, add the same inside `mo` — neutral.

## Behaviour

### Composition of forced mode and relay soundboard

Inside manual override, forced-mode and individual relay toggles compose:

1. User enters override (clicks "Enter Manual Override"). Relays stay at whatever they were; no mode is forced (`mo.fm` unset).
2. User optionally clicks a forced-mode button. The full valve/actuator set snaps to that mode's `MODE_VALVES` + `MODE_ACTUATORS` preset via a staged transition (pump-stop → valves-switch → pump-start). The 5-minute minimum-mode-duration hold is bypassed (see "Control logic" below).
3. User optionally toggles individual relays in the soundboard. The soundboard remains live whether or not a mode is forced.
4. Clicking the active forced-mode button again re-applies the preset (snap-back from any manual deviations). Clicking "Automatic" clears `mo.fm` — relays stay wherever they currently are.

### Exit — force IDLE transition

Every `mo` clear path runs a staged `transitionTo(IDLE)` before resuming automation:

- User clicks "Exit Override".
- TTL expires (device-side `isManualOverrideActive` clears on expiry; server's fallback timer clears via config publish).
- Safety watchdog fires during override with `mo.ss === false`.
- User picks "Automatic" then exits (two steps; each clears its own scope).

After the staged transition, `state.currentMode === IDLE`, all valves are at `MODE_VALVES.IDLE`, pump and fan are off. The next control tick then lets automation re-pick a mode naturally from IDLE (IDLE is exempt from the min-duration hold, so there is no artificial delay).

### TTL — device is authoritative

- **Device** is the source of truth. `isManualOverrideActive()` (`shelly/control.js:774`) already clears `mo` on `now >= mo.ex`. The clear path is extended to enqueue `transitionTo(IDLE)`. The Shelly's own `sys.unixtime` keeps running through network outages.
- **Server** retains its fallback `overrideTtlTimer` (`server/server.js:682-690`). On fire, it writes `mo: null` and publishes on the existing `greenhouse/config` topic — no new topic, no device nudge.
- **UI** keeps the existing 1 s countdown (`playground/js/main.js:2334`). On reaching 0, it switches to an "expired" label and waits for the next state snapshot to confirm IDLE.

## UI

### Device-config card (Controls view)

Delete the "Mode Override" block (`playground/index.html:425-437`). The "Mode enablement" block directly below stays; its helper copy is reworded to refer to override-scoped forced mode rather than top-level `fm`.

### Manual Override card — entry state

Unchanged: "Enter Manual Override" primary button, "Suppress Safety" toggle, gate message.

### Manual Override card — active state

Section order:

1. **Active header** (existing): "Manual Override Active" · countdown · "Exit Override" button.
2. **TTL presets** (existing): 1 min / 5 min / 15 min / 30 min / 1 hr.
3. **Forced mode** (new): own heading, own button row separated by a top border / margin. Six buttons — `Automatic` / `Idle` / `Solar charging` / `Greenhouse heating` / `Active drain` / `Emergency heating`. Single-select, same visual treatment as the existing `.ttl-btn.active` pattern. Helper line below: *"Immediate transition — ignores the 5-min minimum mode duration."*. A banned mode's button is disabled with a " · banned" suffix. Clicking a different button sends `override-set-mode` (debounced ~300 ms), optimistically snaps the soundboard preview, and un-lights the previously active button.
4. **Horizontal divider**.
5. **Relay soundboard** (existing): heading + 9-button grid. Always live whether or not a mode is forced.
6. **Expired** line (existing).

### Status view — forced-mode indicator

- `mo.a && mo.fm` → two-line chip in accent colour: first line `Forced · {mode}`, second line `{countdown} left · Exit override` where "Exit override" is an inline link. Readonly/unauthenticated sessions see the chip but no link.
- `mo.a && !mo.fm` → `Manual override · {countdown} left`. Readonly: no link.
- Bottom-nav status dot is tinted in accent colour whenever `mo.a` is true, regardless of role.

### Readonly role

- Forced-mode buttons: disabled.
- "Exit override" link on status view: not rendered.
- Role is read from the same source the WebSocket authorisation uses (`ws._role`), routed through the UI's existing auth state.

## Control logic (`shelly/control-logic.js`)

- Delete the `fm` application branch (`shelly/control-logic.js:425-437`) and the `fm`-aware watchdog-ban precheck (`shelly/control-logic.js:410-423`). Both are dead once `fm` is no longer a top-level field; `mo.a` already causes `evaluate()` to be skipped entirely on the device (`shelly/control.js:867`).
- Update the compact-key comment block (`shelly/control-logic.js:139-144`): remove the `fm` row, add `mo.fm` to the `mo` description.
- Retain `expandModeCode()`, `shortCodeOf()`, `MODE_CODE` — reused by the device-side `mo.fm` handler and the UI.

## Device handlers

### `shelly/control.js`

- The `config_changed` event handler (anonymous handler at `shelly/control.js:988`) calls `handleConfigDrivenResolution(prevDeviceConfig, deviceConfig)`. Extend that function with a forced-mode branch: if `prev.mo?.fm !== new.mo?.fm` and `new.mo?.a` is true and `new.mo.fm` is a known mode code, call `transitionTo(makeModeResult(new.mo.fm))` where `makeModeResult()` is a small helper returning `{ nextMode, valves: MODE_VALVES[mode], actuators: MODE_ACTUATORS[mode], flags: {} }` — the shape `transitionTo` expects. The `safety_critical` branch that otherwise triggers `controlLoop()` is short-circuited because `evaluate()` is skipped whenever `mo.a` is true — we drive the transition directly.
- `isManualOverrideActive()` TTL-expiry path (`shelly/control.js:774`): after `deviceConfig.mo = null` + KVS persist, enqueue `transitionTo(buildIdleTransitionResult())`. The server-driven exit path (server publishes `mo: null` → `config_changed` event) converges on the same result by extending `handleConfigDrivenResolution()` with a "`mo` cleared while `prev.mo?.a` was true" branch that also enqueues `transitionTo(buildIdleTransitionResult())`.
- Safety-during-override branch (existing `if (!deviceConfig.mo.ss)` at `shelly/control.js:868`): no change — it already clears the whole `mo` on preemption and runs a transition, which now drops `mo.fm` along with it.

### `shelly/telemetry.js`

- `isSafetyCritical()` at `shelly/telemetry.js:49-67`: remove the `oldCfg.fm !== newCfg.fm` check (line 53), replace with a `mo.fm` change check. Use ES5-safe access: `var oldMf = (oldCfg && oldCfg.mo) ? oldCfg.mo.fm : null; var newMf = (newCfg && newCfg.mo) ? newCfg.mo.fm : null; if (oldMf !== newMf) return true;`. The flag drives whether a safety-critical re-eval is queued — for `mo.fm` changes we want the device to notice immediately so the new transition fires on the same tick.

## Server

### WebSocket commands

New command:

```
{ type: "override-set-mode", mode: "I"|"SC"|"GH"|"AD"|"EH"|null }
```

Handler (`server/server.js`):

- Require admin (`ws._role === "admin"`); return `override-error "Admin role required"` otherwise.
- Require `cfg.mo.a === true`; return `override-error "Override not active"` otherwise.
- If `mode` is set and `wb[mode]` is active, return `override-error "Mode banned"`.
- Reject unknown mode codes.
- Update `mo.fm`, bump `v`, publish on `greenhouse/config`.
- Ack with `{ type: "override-ack", active: true, expiresAt, suppressSafety, forcedMode: mode }`.

Existing commands:

- `override-enter`: unchanged. Initial `mo.fm` is `null`.
- `override-update`: unchanged — extends TTL, leaves `mo.fm` as-is.
- `override-exit`: unchanged — clears the whole `mo` including `mo.fm`.
- `relay-command`: unchanged — works identically whether `mo.fm` is set or not.

### Config validation (`server/lib/device-config.js`)

- Reject any update that sets `mo.fm` when `mo.a === false` or the same update is clearing `mo.a`.
- Reject unknown `mo.fm` values.
- On load (device-config bootstrap), strip legacy top-level `fm` if present. One-shot migration: the first config write after deploy drops it.

### State broadcast (`server/lib/mqtt-bridge.js:197`)

Extend `manual_override`:

```diff
- manual_override: { active: true, expiresAt: cfg.mo.ex, suppressSafety: cfg.mo.ss }
+ manual_override: { active: true, expiresAt: cfg.mo.ex, suppressSafety: cfg.mo.ss, forcedMode: cfg.mo.fm || null }
```

## MQTT topics

No new subscriptions. No removals (see topic-removal survey below). All changes ride on the existing `greenhouse/config` (bidirectional via retained payload) and `greenhouse/state` (device → server) topics.

### Topic-removal survey

The device subscribes to three topics today: `greenhouse/config`, `greenhouse/sensor-config`, `greenhouse/relay-command`. The only plausible candidate for removal while implementing this work is `relay-command` — conceptually it could be folded into `mo.r = { pump, fan, … }` carried on `greenhouse/config`, making the override fully declarative. Rejected for two reasons:

1. The 200 ms relay-command queue (`shelly/control.js:836`) exists specifically because rapid relay churn crashed the Pro 4PM firmware. Re-routing that same churn through KVS-backed config writes would be worse on the device.
2. A 9-flag relay map plus `"r":{}` overhead inside `mo` pressures the 256-byte KVS budget.

If a topic does turn out to be obsolete post-design, it can be removed in a follow-up rather than dragged into this change.

## Tests

- **`tests/control-logic.test.js`**: remove `fm`-drives-`evaluate()` tests (dead code). Extend coverage that `evaluate()` is not entered when `mo.a === true`.
- **`tests/override-forced-mode.test.js`** (new): sim harness — enter override, set `mo.fm = "SC"`, assert valves snap to `MODE_VALVES.SOLAR_CHARGING` and pump on; switch to `"AD"`, assert staged transition runs and min-duration is ignored (elapsed < 300 s); exit override, assert transition to `MODES.IDLE` with all valves at `MODE_VALVES.IDLE` and pump/fan off. Also: TTL expiry triggers the same IDLE transition without a user action.
- **`tests/e2e/device-config.spec.js`**: remove forced-mode selector assertions tied to the device-config card.
- **`tests/e2e/override.spec.js`** (new or extend `live-mode.spec.js`): enter override, click a forced-mode button, assert soundboard reflects the preset and status chip shows `Forced · …`; advance sim time past TTL, assert chip reverts and relays go to IDLE.
- **`tests/e2e/auth-actions.spec.js`** (extend): readonly login sees the forced-mode buttons as disabled and no "Exit override" link in the status view.
- **`tests/shelly-stability.test.js`**: cover the new `mo.fm` config-update path so the linter's banned-method scan runs over the new handler code.
- **`playground/assets/bootstrap-history.json`**: regenerate via `npm run bootstrap-history`. The drift test fails otherwise.

## Migration

No manual migration needed for end users. On the first deploy after this change:

- Server strips any top-level `fm` from the config on load.
- Device's control-logic no longer reads top-level `fm`; any value left in KVS from a pre-migration config becomes inert. The next config publish (from server startup or any admin action) writes a clean config back to KVS.
- Any active `mo` from a pre-migration session will lack `mo.fm`; this is benign — the override runs in "no mode forced" mode until the user picks one or exits.

## Open questions

None. Ready for implementation plan.
