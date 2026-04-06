# Implementation Plan: Configure Sensor Connectors

**Branch**: `018-configure-sensor-connectors` | **Date**: 2026-04-06 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/018-configure-sensor-connectors/spec.md`

## Summary

Add a sensor commissioning UI to the playground that discovers DS18B20 sensors on Shelly sensor hosts, lets the operator assign them to system roles, and pushes the configuration to both sensor hosts (via `SensorAddon.*` RPC) and the control system (via MQTT/KVS). This replaces the hardcoded sensor IDs in the control script with a dynamic, configurable mapping that supports multiple sensor hosts.

## Technical Context

**Language/Version**: JavaScript ES5 (Shelly scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS)  
**Primary Dependencies**: Existing — `ws`, `mqtt`, `pg`, `@aws-sdk/client-s3`, `@simplewebauthn/server`. No new dependencies.  
**Storage**: S3-compatible object storage (UpCloud) / local filesystem fallback (sensor-config.json). Shelly KVS for device-side config.  
**Testing**: `node:test` (unit), Playwright 1.56.0 (e2e), `npx serve` (static server)  
**Target Platform**: Browser (playground SPA) + Node.js server + Shelly Pro 4PM + Shelly 1 Gen3 devices  
**Project Type**: Web application (SPA + API server + IoT device scripts)  
**Performance Goals**: Sensor scan completes in <5s per host. Temperature readings update every 30s.  
**Constraints**: Shelly KVS 256-byte limit per key. ES5-only for Shelly scripts. Sensor host RPC timeout 5s.  
**Scale/Scope**: 2 sensor hosts, 7 sensors max, 1 operator at a time.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Phase 0 Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as SSOT | PASS | Sensor roles derived from `system.yaml`. Runtime config (assignments) is software config, not hardware spec — does not need to be in system.yaml per constitution. |
| II. Pure Logic / IO Separation | PASS | Control logic in `control-logic.js` remains pure — sensor routing config is loaded by the I/O layer (`control.js`) and passed as state. |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | If no sensor config exists, all temps are null → IDLE mode (safe). Safety overrides (freeze/overheat) remain unaffected. |
| IV. Proportional Test Coverage | PASS | Plan includes unit tests for config store, integration tests for config flow, and e2e tests for UI. |
| V. Token-Based Cloud Auth | N/A | No UpCloud API interaction. |
| VI. Durable Data Persistence | PASS | Sensor config persisted to S3 (production) / local file (dev). Not container-local only. |
| VII. No Secrets in Cloud-Init | PASS | `SENSOR_HOST_IPS` is non-secret config, added to K8s ConfigMap via Terraform. No cloud-init changes. |

### Post-Phase 1 Re-check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as SSOT | PASS | Sensor roles list (names, locations, optional flag) derived from system.yaml. Runtime assignments stored separately. |
| II. Pure Logic / IO Separation | PASS | `control-logic.js` unchanged. `control.js` I/O layer reads sensor config from KVS and builds polling list. |
| III. Safe by Default | PASS | No sensor config → no polling → all temps null → IDLE. Partial config → only configured sensors polled. Safety drains still trigger on stale sensors. |
| IV. Proportional Test Coverage | PASS | New tests for: sensor-config store (unit), RPC proxy allowlist (unit), control script dynamic routing (unit), sensors UI (e2e). |
| V-VII | Same as pre-check | No changes. |

## Project Structure

### Documentation (this feature)

```text
specs/018-configure-sensor-connectors/
├── plan.md              # This file
├── research.md          # Phase 0: Shelly RPC API, persistence strategy, architecture decisions
├── data-model.md        # Phase 1: Entity definitions, config formats, validation rules
├── quickstart.md        # Phase 1: Dev setup, key files, testing commands
├── contracts/
│   └── api.md           # Phase 1: API endpoints, MQTT topics, env vars
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
server/
├── server.js                  # Extended: sensor-config routes, RPC proxy _host allowlist
└── lib/
    ├── sensor-config.js       # New: sensor config store (S3/local, API handlers, MQTT publish)
    └── mqtt-bridge.js         # Extended: publishSensorConfig() method

shelly/
├── control.js                 # Modified: dynamic sensor routing from KVS config
└── telemetry.js               # Modified: subscribe greenhouse/sensor-config, persist to KVS

playground/
├── index.html                 # Extended: new #sensors view, nav link
└── js/
    └── sensors.js             # New: sensor discovery, assignment, apply logic

tests/
├── sensor-config.test.js      # New: unit tests for sensor config store
├── control-logic.test.js      # Extended: tests for dynamic sensor routing
└── e2e/
    └── sensor-config.spec.js  # New: e2e tests for sensors view

deploy/terraform/
└── main.tf                    # Extended: SENSOR_HOST_IPS in app-config ConfigMap
```

**Structure Decision**: Follows existing project structure. New server module (`sensor-config.js`) mirrors the pattern of `device-config.js`. New UI module (`sensors.js`) follows the ES module pattern in `playground/js/`. No new directories needed beyond the contracts folder in specs.

## Complexity Tracking

No constitution violations to justify. All design decisions follow existing patterns in the codebase.
