# Implementation Plan: Manual Relay Toggle UI

**Branch**: `022-relay-toggle-ui` | **Date**: 2026-04-07 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/022-relay-toggle-ui/spec.md`

## Summary

Add a soundboard-style manual relay toggle UI to the Device view that allows operators to individually control each valve, pump, and fan relay during commissioning and testing. Communication uses WebSocket → MQTT for low-latency actuation. Manual override mode suspends automation with a configurable TTL (default 5 minutes) enforced on the Shelly device itself (checked every control loop iteration, no new timer needed), with an option to suppress safety overrides. The server tracks TTL as a secondary measure. Tactile feedback via Vibration API and optimistic UI updates.

## Technical Context

**Language/Version**: JavaScript ES5 (Shelly device scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS)  
**Primary Dependencies**: `ws` (WebSocket), `mqtt` (MQTT client), `pg` (PostgreSQL) — all existing  
**Storage**: Device config in S3/local JSON (existing), override state transient in device config `mo` field  
**Testing**: `node:test` (unit), Playwright 1.56.0 (e2e)  
**Target Platform**: Browser (mobile + desktop), Shelly Pro 4PM + Pro 2PM devices, Node.js server  
**Project Type**: Full-stack IoT web application  
**Performance Goals**: Relay toggle feedback within 1 second end-to-end  
**Constraints**: Shelly KVS 256-byte config limit, 5 timer limit, ES5-only device scripts, MQTT-only device communication  
**Scale/Scope**: Single operator, 10 relays (8 valves + pump + fan), single Shelly controller

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Design Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. system.yaml as Source of Truth | PASS | No hardware spec changes. Relay mappings already defined in system.yaml. Feature only adds a new UI/software control path. |
| II. Pure Logic / IO Separation | PASS | Manual override bypasses `evaluate()` entirely — it's an I/O-layer concern in `control.js`, not a change to the pure decision logic in `control-logic.js`. |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | Override defaults: safety overrides ON, TTL 5 minutes, auto-revert to automation. Suppress-safety is opt-in with explicit flag. `ce=false` immediately terminates override. |
| IV. Proportional Test Coverage | PASS | Plan includes unit tests for config extension, MQTT commands, control loop guard; e2e tests for UI toggle board and override flow. |
| V. Token-Based Cloud Auth | N/A | No UpCloud authentication changes. |
| VI. Durable Data Persistence | PASS | Override state is transient by design (TTL-bounded). Device config persistence uses existing S3/local mechanism. |
| VII. No Secrets in Cloud-Init | N/A | No new secrets or infrastructure provisioning. |

### Post-Design Check

| Principle | Status | Notes |
|-----------|--------|-------|
| II. Pure Logic / IO Separation | PASS | `control-logic.js` unchanged. All manual override logic is in the I/O layer (`control.js`). Safety override detection still uses `evaluate()` when `mo.ss=false`. |
| III. Safe by Default | PASS | Research R2–R4 confirm: device-side TTL enforcement (works offline, no server dependency), safe defaults for all override parameters, `ce=false` kills override immediately. Suppress-safety requires explicit opt-in. |
| IV. Proportional Test Coverage | PASS | Quickstart lists all test files. Unit tests cover config extension, MQTT publishing, control loop guard. E2e tests cover UI flow. |

## Project Structure

### Documentation (this feature)

```text
specs/022-relay-toggle-ui/
├── plan.md              # This file
├── research.md          # Phase 0: 7 research decisions
├── data-model.md        # Phase 1: entity definitions, state transitions
├── quickstart.md        # Phase 1: dev setup guide
├── contracts/
│   └── websocket-commands.md  # WebSocket + MQTT message contracts
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
# Modified files (existing)
server/
├── server.js                    # + WebSocket message handler, secondary TTL tracking
├── lib/
│   ├── mqtt-bridge.js           # + publishRelayCommand(), override state in broadcasts
│   └── device-config.js         # + mo field support, override enter/exit/update

shelly/
├── control.js                   # + manual override guard, relay command handler
└── telemetry.js                 # + greenhouse/relay-command subscription

playground/
├── index.html                   # + relay toggle board UI in Device view
├── js/
│   └── data-source.js           # + sendCommand() method on LiveSource
└── css/
    └── style.css                # + soundboard grid, button states, shake animation

tests/
├── control-logic.test.js        # + manual override guard tests
├── device-config.test.js        # + mo field validation tests
├── mqtt-bridge.test.js          # + relay command publishing tests
└── e2e/
    └── device-config.spec.js    # + toggle board UI e2e tests
```

**Structure Decision**: All changes fit within the existing project structure. No new directories or modules needed beyond the contracts directory in specs. The feature extends existing files across all three layers (device, server, UI).

## Complexity Tracking

No constitution violations to justify.
