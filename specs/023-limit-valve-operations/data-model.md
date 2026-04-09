# Data Model: Limit Concurrent Valve Operations

**Feature**: 023-limit-valve-operations
**Date**: 2026-04-09

## Entities

### Valve Timing Constants (`VALVE_TIMING`)

Plain object literal defined in `shelly/control-logic.js` and exported alongside the other pure-logic exports. Serves as the default `cfg` for the scheduler.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `maxConcurrentOpens` | integer | 2 | Maximum number of valves that may be inside their energizing window at the same time. Corresponds to the 24 V PSU current budget. |
| `openWindowMs` | integer | 20000 | Duration of the energizing window that protects the PSU. The scheduler treats a valve as "still opening" for this many milliseconds after its open command is issued. |
| `minOpenMs` | integer | 60000 | Minimum time a valve must remain energized (holding open) before a close command may be issued. Corresponds to the capacitor charging time. |

**Validation**: All three must be positive integers. `minOpenMs` must be at least as large as `openWindowMs` (otherwise a valve could be closed before its open window ends). The tests assert both invariants.

### Valve Timing State (in-memory on Shelly device)

Lives in `control.js` as properties of the existing `state` object. Reset on boot. Not persisted to KVS.

| Field | Type | Description |
|-------|------|-------------|
| `valveOpenSince` | `{ [valveName: string]: number }` | Map of valve name to the epoch-millisecond timestamp at which the valve most recently completed its 20 s opening window. Value `0` means "unknown / zero-age" and is treated as "hold already satisfied" so boot recovery works. |
| `valveOpening` | `{ [valveName: string]: number }` | Map of valve name to the epoch-millisecond timestamp at which the valve's current opening window will end. A valve is "currently in the opening phase" iff its entry exists and `now < entry`. Entry is removed when the window ends. |
| `valvePendingOpen` | `string[]` | Ordered FIFO queue of valves that still need to be opened for the current target state but could not start yet because all opening slots were occupied. |
| `valvePendingClose` | `string[]` | List of valves that the current target state says must be closed but whose minimum-open hold has not yet elapsed. |
| `targetValves` | `{ [valveName: string]: boolean } \| null` | The target valve configuration for the current transition. Set when a transition begins, cleared when the transition completes. While non-null, the scheduler drives the shell toward this target on each tick. |
| `transitionTimer` | `Timer handle \| null` | The transition-scoped Shelly timer used to resume the state machine when an opening window ends or a deferred close becomes ready. Exactly one is active at any time during a transition. |

**Lifecycle (per valve)**:

1. Valve starts in `closed` state, `valveOpenSince[v] = 0`, no entry in `valveOpening`.
2. Scheduler decides to open it → `valveOpening[v] = now + openWindowMs`, open HTTP command issued.
3. Window ends → `valveOpening[v]` deleted, `valveOpenSince[v] = now` (the window-end moment).
4. Scheduler decides to close it → checks `now - valveOpenSince[v] >= minOpenMs`:
   - Yes → close HTTP command issued, `valveOpenSince[v] = 0` (or left alone, since the valve is closed again).
   - No → valve added to `valvePendingClose`, scheduler schedules a resume timer for `valveOpenSince[v] + minOpenMs`.
5. On next resume, if the valve is still in the target's closed set, the deferred close fires.

**Invariants**:

- A valve is never in `valveOpening` and `valvePendingClose` at the same time (FR-017).
- A valve is never in `valvePendingOpen` if the current target says it should be closed.
- At most `maxConcurrentOpens` valves are in `valveOpening` at any given instant (FR-001).
- `|valveOpening|` ≤ `maxConcurrentOpens`.
- Every entry in `valvePendingClose` has `valveOpenSince[v] > 0` (else the hold would be trivially satisfied).

### Transition Plan (return type of `planValveTransition`)

Pure data returned by the scheduler. Never persisted, never mutated after being returned.

| Field | Type | Description |
|-------|------|-------------|
| `startOpening` | `string[]` | Valves to begin energizing **right now** (at most `maxConcurrentOpens - |currently opening|` of them). The shell issues the open command and records `valveOpening[v] = now + openWindowMs`. |
| `closeNow` | `string[]` | Valves to close **right now** — already satisfied the minimum-open hold. The shell issues the close command and clears `valveOpenSince[v]`. |
| `queuedOpens` | `string[]` | Valves that still need to be opened but could not start this tick (slots full). The shell stores these in `valvePendingOpen`. |
| `deferredCloses` | `{ [valveName: string]: number }` | Map of valve name to the epoch-ms timestamp at which the close becomes allowed. The shell stores these in `valvePendingClose` and uses the earliest as part of the resume-timer computation. |
| `nextResumeAt` | `number \| null` | The earliest future timestamp at which the scheduler wants to be invoked again. Equal to `min(earliest valveOpening window end, earliest deferred close ready)`. Null if the target is fully reached and no deferrals remain. |
| `targetReached` | `boolean` | True iff the current physical valve state equals the target AND there are no queued opens or deferred closes. Signals the shell to complete the transition (start pump). |

### State Snapshot (extended for UI)

Existing entity returned by `buildStateSnapshot()` in `control.js`. Extended with three new fields. Already broadcast via `greenhouse/state` MQTT topic, already relayed by the server to the playground WebSocket, so no new plumbing is needed.

| Field | Type | Description |
|-------|------|-------------|
| `opening` | `string[]` | List of valves currently inside their 20 s opening window. Sourced from `valveOpening`. |
| `queued_opens` | `string[]` | Ordered list of valves waiting for an opening slot. Sourced from `valvePendingOpen`. |
| `pending_closes` | `Array<{ valve: string, readyAt: number }>` | List of deferred closes with their ready timestamps (unix seconds). Sourced from `valvePendingClose` and `valveOpenSince`. |

## State Transitions

### Transition state machine (replaces parts of the existing `transitionTo`)

```
IDLE
  │ evaluate() returns new target
  ▼
PUMP_STOP          (set pump/fan/heaters off, set settle timer)
  │ after VALVE_SETTLE_MS
  ▼
SCHEDULE ─────────────┐
  │                   │
  │ call planValveTransition(target, current, openSince, opening, now, cfg)
  │ plan.closeNow → issue close commands in parallel
  │ plan.startOpening → issue open commands (record opening windows)
  │ plan.queuedOpens → store in valvePendingOpen
  │ plan.deferredCloses → store in valvePendingClose
  │                   │
  │ plan.targetReached = false
  │ schedule transitionTimer at plan.nextResumeAt
  │                   │
  │ (timer fires, recompute)
  │                   │
  └───────────────────┘
  │ plan.targetReached = true
  ▼
PUMP_PRIME         (wait PUMP_PRIME_MS)
  │
  ▼
RUNNING
```

### Guards

- **Mid-transition target change**: If `evaluate()` returns a new mode while `targetValves` is non-null (transition in progress), the shell updates `targetValves` in place. It does **not** abort the opening windows already in progress — those complete naturally (FR-012). The next SCHEDULE step computes a fresh plan against the new target.
- **Already-open valve re-commanded open**: Scheduler observes that `current[v] === true` and skips it. No slot consumed, no timer reset (FR-013).
- **Already-closed valve re-commanded closed**: Scheduler observes that `current[v] === false` and skips it. Not added to `valvePendingClose`.
- **Safety override while mid-transition**: Same as mid-transition target change. The safety target flows through the same SCHEDULE step.

## Configuration

No configuration changes at the device-config level. The feature introduces three in-code constants (`VALVE_TIMING`) that are not currently exposed through the KVS device config. If operators ever need to tune them remotely, a future feature can add them to the compact device config format — that is explicitly out of scope here to keep the KVS 256-byte budget intact.
