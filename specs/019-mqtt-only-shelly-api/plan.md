# Implementation Plan: MQTT-Only Shelly Communication API

**Branch**: `019-mqtt-only-shelly-api` | **Date**: 2026-04-06 | **Spec**: `specs/019-mqtt-only-shelly-api/spec.md`
**Input**: Feature specification from `/specs/019-mqtt-only-shelly-api/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Eliminate all direct HTTP RPC calls from the cloud server to Shelly devices by routing all communication through MQTT. Currently the server uses `Script.Eval` for state polling (valve-poller.js) and direct HTTP RPC for sensor configuration/discovery (sensor-config.js). The telemetry script already publishes state via MQTT and receives config via MQTT — this feature extends that pattern to cover the remaining direct-RPC code paths: valve polling removal, sensor config apply via MQTT→controller→local RPC, and sensor discovery via MQTT request/response.

## Technical Context

**Language/Version**: JavaScript ES5 (Shelly device scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS)
**Primary Dependencies**: `mqtt` (MQTT client), `ws` (WebSocket server), `pg` (PostgreSQL), `@aws-sdk/client-s3`, Mosquitto 2.x (sidecar broker)
**Storage**: PostgreSQL/TimescaleDB (sensor history, state events), S3-compatible object storage (config persistence), Shelly KVS (device-side config, 256-byte limit per key)
**Testing**: `node:test` (unit), Playwright (e2e), custom simulation harness
**Target Platform**: Shelly Pro 4PM (ES5 runtime, 16KB script limit, 5 concurrent calls), Node.js server on K8s, browser SPA
**Project Type**: IoT control system with cloud monitoring dashboard
**Performance Goals**: State updates within 30 seconds of change; config delivery within 5 seconds
**Constraints**: 5 concurrent HTTP calls per Shelly script, 16KB max script size, 5 timers, 5 event subscriptions, KVS 256 bytes/key, system must operate fully without cloud connection
**Scale/Scope**: Single Shelly controller, 2 sensor hosts, 8 valves, 5 temperature sensors, 1 monitoring dashboard

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Status | Notes |
|---|-----------|--------|-------|
| I | Hardware Spec as Single Source of Truth | ✅ PASS | No hardware changes. MQTT topics and message formats are software-level; `system.yaml` is unaffected. |
| II | Pure Logic / IO Separation | ✅ PASS | `control-logic.js` (pure `evaluate()`) is unchanged. New MQTT handlers for sensor discovery and config apply belong in the I/O layer (`control.js` / `telemetry.js`), not in decision logic. |
| III | Safe by Default (NON-NEGOTIABLE) | ✅ PASS | Pump/valve safety ordering unchanged. Sensor discovery and config apply are non-safety-critical paths. Controller continues operating independently when cloud/MQTT is unavailable. No new override paths. |
| IV | Proportional Test Coverage | ✅ PASS | Unit tests for new MQTT message handlers, updated integration tests for sensor-config flow, e2e tests for discovery UI. Existing control-logic tests unaffected. |
| V | Token-Based Cloud Auth | ✅ N/A | No UpCloud API changes. |
| VI | Durable Data Persistence | ✅ PASS | Sensor config persisted to S3/local (existing). Discovery results are transient (displayed in UI, not persisted). |
| VII | No Secrets in Cloud-Init | ✅ N/A | No new secrets or infrastructure. MQTT broker already configured. |

**Gate result: PASS** — No violations. Proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/019-mqtt-only-shelly-api/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
shelly/
├── control-logic.js     # UNCHANGED — pure decision logic
├── control.js           # MODIFIED — add sensor discovery handler, sensor config apply handler
├── telemetry.js         # MODIFIED — add discovery request/response MQTT topics, sensor config apply forwarding
└── deploy.sh            # UNCHANGED

server/
├── server.js            # MODIFIED — remove valve poller startup, remove/gate RPC proxy for sensor hosts, add discovery API endpoints
├── lib/
│   ├── mqtt-bridge.js   # MODIFIED — add discovery request publish, discovery result subscription, sensor config publish routing
│   ├── sensor-config.js # MODIFIED — remove direct RPC apply, route through MQTT→controller
│   ├── valve-poller.js  # REMOVED — no longer needed (state arrives via MQTT)
│   └── device-config.js # UNCHANGED

playground/
└── js/
    └── sensors.js       # MODIFIED — discovery triggers via server API (which uses MQTT), not direct RPC

tests/
├── valve-poller.test.js # REMOVED or UPDATED — poller no longer exists
├── sensor-config.test.js # UPDATED — test MQTT-based apply flow
├── mqtt-bridge.test.js  # UPDATED — test discovery topics
└── e2e/
    └── sensor-config.spec.js # UPDATED — test discovery via MQTT path
```

**Structure Decision**: Existing directory structure preserved. Changes are modifications to existing files — no new directories or packages. The valve-poller module is removed entirely. Server RPC proxy endpoint restricted to block sensor host RPC from cloud.

## Complexity Tracking

> No constitution violations to justify.

No new abstractions introduced. The approach extends the existing MQTT pub/sub pattern (already proven for state and device config) to the remaining two direct-RPC paths (sensor config apply and sensor discovery).
