# Implementation Plan: Limit Concurrent Valve Operations

**Branch**: `023-limit-valve-operations` | **Date**: 2026-04-09 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/023-limit-valve-operations/spec.md`

## Summary

Enforce two hardware-protection rules in the Shelly control script so that mode transitions never exceed the 24 V PSU's current budget and so that every motorized valve has enough time to charge its closing-motion capacitor before being commanded closed. Specifically: at most two valves may be in the "closed → open" energizing phase simultaneously (20 s window per valve), and every valve must remain open for at least 60 seconds before a close command is issued to it. The logic is added to the device shell (`shelly/control.js`) with a pure, unit-testable scheduler helper in `shelly/control-logic.js`. Safety-triggered mode transitions still honor both rules because they are physical constraints, but they apply no other throttles on top of them. The playground UI's Status and Device views surface the staged opening progress (currently opening, queued, deferred closes) via the existing state-broadcast path.

## Technical Context

**Language/Version**: JavaScript ES5 (Shelly device scripts), Node.js 20 LTS (server + tests, CommonJS), ES6+ (browser modules)
**Primary Dependencies**: Existing — `mqtt` (MQTT client), `ws` (WebSocket), `pg` (PostgreSQL), `node:test` (unit tests), Playwright 1.56.0 (e2e). No new dependencies.
**Storage**: Valve open-since timestamps and the staged-opening state machine are in-memory on the Shelly device (non-persisted across reboot by design, see FR-015). The concurrent-open limit, opening-window duration, and minimum-open-hold are defined as named constants in `shelly/control-logic.js` so they can be adjusted without code hunting.
**Testing**: `node:test` unit tests for the new pure scheduler helper in `shelly/control-logic.js`; simulation-level tests for mode transitions; Playwright e2e tests to verify the playground surfaces staged-opening state.
**Target Platform**: Shelly Pro 4PM (main controller) + Shelly Pro 2PM devices (valve actuators), Node.js server, browser.
**Project Type**: IoT hardware control with web UI — device scripts + server + SPA.
**Performance Goals**: A 4-open mode transition completes in ≈40–45 s wall-clock (two 20 s batches plus scheduling overhead). Pending-close deferrals never delay a transition by more than 60 s beyond the corresponding valve's original open moment.
**Constraints**: Shelly ES5-only device scripts (no `const`/`let`, arrow functions, classes, template literals). Shelly resource limits: 16 KB max script size, 5 timers, 5 concurrent HTTP calls, 5 event subscriptions. Control-loop polling interval is 30 s — the staged-opening state machine uses its own short-lived Timer rather than waiting for the next control tick. KVS 256-byte limit per key applies if any of the new constants ever move into device config (default is in-code constants, no KVS bump).
**Scale/Scope**: 8 motorized valves across 4 Shelly Pro 2PM devices, single Pro 4PM controller, mode transitions at most a few times per hour during normal operation.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Design Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. system.yaml as Source of Truth | PASS | No hardware spec changes. Valves, modes, and relay mappings remain authoritative in `system.yaml`. This feature only adds software-level timing rules on top of the existing valve set. |
| II. Pure Logic / IO Separation | PASS | Mode decisions stay in `control-logic.js` and are unchanged. The new scheduler helper (`planValveTransition`) is a pure function added to `control-logic.js` and is unit-testable in Node.js. All real-time I/O (Timer.set, HTTP.GET, KVS) stays in `control.js`. |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | Rules are physical hardware protections. Safety overrides (freeze drain, overheat drain) still flow through the same scheduler — they must respect the PSU and capacitor limits because those are physical, but no other throttles apply. The default code path for every mode transition uses the scheduler; there is no "bypass the scheduler" option. |
| IV. Proportional Test Coverage | PASS | Plan adds unit tests for every scheduler decision branch (initial batch sizing, cross-tick queuing, deferred closes, safety-override interactions, reboot recovery) plus a simulation test that runs a full mode transition timeline and an e2e test that verifies the playground UI shows staged-open state. |
| V. Token-Based Cloud Auth | N/A | No UpCloud authentication changes. |
| VI. Durable Data Persistence | PASS | Valve timing state is intentionally transient (see spec FR-015: reboot treats already-open valves as past the hold, newly opened ones track fresh timestamps). No new persistent data is created. |
| VII. No Secrets in Cloud-Init | N/A | No new secrets or infrastructure. |

### Post-Design Check

| Principle | Status | Notes |
|-----------|--------|-------|
| II. Pure Logic / IO Separation | PASS | Post-design confirms the scheduler is exported from `control-logic.js` with no Shelly-API calls. Time inputs are passed in via arguments (`now`, `openSince`, `opening`) rather than read from `Date.now()` inside the helper, keeping the function pure and deterministic under tests. |
| III. Safe by Default | PASS | Research R1–R5 confirm: (a) the scheduler enforces both rules for every caller including safety overrides; (b) the shell never bypasses the scheduler; (c) a valve inside its 20 s opening window is never commanded closed; (d) reboot recovery defaults to "hold satisfied for already-open valves" so the system can always get back to IDLE. |
| IV. Proportional Test Coverage | PASS | Contracts file lists every scheduler input/output shape. Quickstart enumerates the test files. No UI-only change escapes an e2e test since the Status and Device views show new state fields. |

## Project Structure

### Documentation (this feature)

```text
specs/023-limit-valve-operations/
├── plan.md              # This file
├── research.md          # Phase 0: scheduling decisions and alternatives
├── data-model.md        # Phase 1: scheduler state entities and transitions
├── quickstart.md        # Phase 1: dev workflow and file-touch list
├── contracts/
│   └── valve-scheduler.md   # Pure-function contract for planValveTransition
└── tasks.md             # Phase 2 output (created by /speckit.tasks — NOT this command)
```

### Source Code (repository root)

```text
# Modified files (existing)
shelly/
├── control-logic.js          # + planValveTransition() pure helper,
│                             #   + VALVE_TIMING constants, exports
└── control.js                # + valve timing state (openSince, opening slots),
                              #   + staged transitionTo state machine,
                              #   + deferred-close scheduler timer,
                              #   + state snapshot fields (opening, queued, pending_closes)

tests/
├── control-logic.test.js     # + 15-20 scheduler unit tests covering every branch
├── simulation/
│   └── scenarios.js          # + multi-batch transition scenario
└── e2e/
    └── device-config.spec.js # + assertion that staged-open state appears in UI

playground/
├── index.html                # + staged-open indicator in Status view, details in Device view
├── js/
│   └── data-source.js        # + surface opening/queued/pending_closes from state snapshot
└── css/
    └── style.css             # + styling for the staged-open indicator

# Unchanged (for clarity, not modified by this feature)
shelly/telemetry.js           # state snapshot fields pass through existing publish path
server/lib/mqtt-bridge.js     # state broadcast forwards new fields unchanged
```

**Structure Decision**: All changes fit inside existing files. The only new artifacts are inside `specs/023-limit-valve-operations/`. The new scheduler helper lives in the existing `control-logic.js` module because that file is already concatenated into the deployed Shelly script at deploy time and is already the home for the existing pure logic — placing the scheduler there keeps the pure/IO split intact and makes the logic unit-testable without any new build step.

## Complexity Tracking

No constitution violations to justify. The scheduler adds non-trivial state-machine complexity to `control.js`, but that complexity is intrinsic to the hardware rules — it cannot be simplified away without violating FR-001 or FR-007. The pure-helper split is specifically chosen to keep the complexity unit-testable.
