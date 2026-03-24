# Implementation Plan: Connect Playground to Live System

**Branch**: `010-live-system-playground` | **Date**: 2026-03-24 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/010-live-system-playground/spec.md`

## Summary

Connect the playground's Status, Components, and Schematic views to the real greenhouse system via MQTT. The Shelly Pro 4PM control script publishes consolidated state snapshots to a Mosquitto broker on the cloud server. The Node.js server subscribes to MQTT, persists data in UpCloud Managed PostgreSQL with TimescaleDB (tiered retention: 48h full resolution via retention policy, automatic 30s continuous aggregates for long-term, state events forever), and forwards live state to browser clients via WebSocket. The playground becomes the unified app (replacing the monitor), with deployment-aware mode detection: simulation-only on GitHub Pages, live-with-toggle on greenhouse.madekivi.com. The database is provisioned via Terraform alongside existing infrastructure.

All actuator control is disabled by default — a freshly deployed device monitors only (reads sensors, publishes MQTT). The Shelly queries a cloud config endpoint on startup for runtime settings (which actuators are enabled), persists config in KVS for offline resilience, and re-checks periodically. Shelly scripts are deployed remotely via the VPN tunnel as part of the CD pipeline.

## Technical Context

**Language/Version**: JavaScript ES5 (Shelly scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS)
**Primary Dependencies**: `pg` (node-postgres), `mqtt` (MQTT client), `ws` (WebSocket server), Mosquitto 2.x (broker), existing: `@simplewebauthn/server`, `@aws-sdk/client-s3`, `web-push`
**Storage**: UpCloud Managed PostgreSQL with TimescaleDB extension (plan `1x1xCPU-2GB-25GB`, zone `fi-hel1`), provisioned via Terraform
**Testing**: `node:test` (unit), Playwright (e2e), existing test infrastructure
**Target Platform**: Linux server (UpCloud DEV-1xCPU-1GB-10GB), Shelly Pro 4PM (ES5), browsers (ES6+)
**Project Type**: IoT monitoring web application + embedded device scripts
**Performance Goals**: <5s end-to-end latency (sensor change → UI update), 60 FPS UI rendering
**Constraints**: 1 GB RAM server (shared with Caddy + OpenVPN + Mosquitto), 16 KB Shelly per-script size limit (control script already at 19.4 KB — needs trimming), ~3 concurrent Shelly scripts on Pro 4PM (2 currently used), 5 Shelly timers per script (6 static in control.js), 10 MQTT subscriptions per script, ES5-only on Shelly
**Scale/Scope**: 1-3 concurrent browser clients, 5 sensors at ~5s intervals, indefinite data retention

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Research Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | PASS | No hardware spec changes. MQTT topics and data shapes derive from existing `system.yaml` sensor/valve/actuator definitions. |
| II. Pure Logic / IO Separation | PASS | MQTT publishing isolated in a separate telemetry script. Config is a data parameter to `evaluate()`, not I/O. Control script I/O layer handles actuator guards. |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | MQTT is fire-and-forget — `MQTT.publish()` returns false if disconnected but control logic continues unaffected (FR-006). All actuator control disabled by default (FR-019) — device must receive explicit config to enable hardware commands. No new actuation paths. |
| IV. Proportional Test Coverage | PASS | New code requires: unit tests for DB module + MQTT bridge + data source abstraction, e2e tests for live/simulation toggle. Existing simulation tests must not regress. |
| V. Token-Based Cloud Auth | PASS | UpCloud Managed Database uses Terraform-provisioned credentials. UpCloud API access continues via `UPCLOUD_TOKEN`. |
| VI. Durable Data Persistence | PASS | UpCloud Managed PostgreSQL with automated backups and PITR. Data survives container recreation by design — external managed service. |

### Post-Design Re-Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | PASS | MQTT message schema derives from `system.yaml` entities. Topic name (`greenhouse/state`) is new but doesn't conflict. |
| II. Pure Logic / IO Separation | PASS | `control-logic.js` gains a `config` parameter but remains pure (config is data input, not I/O). MQTT publishing and config fetch/subscribe are in `control.js` I/O layer. Actuator enable guards in I/O boundary. |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | All actuator control disabled by default — device monitors only until config explicitly enables controls (FR-019, FR-022). MQTT failure = silent skip. WebSocket is read-only (server→client). DB failure = log error, continue serving live data without history. |
| IV. Proportional Test Coverage | PASS | Test plan: unit tests for `db.js`, `mqtt-bridge.js`, `data-source.js`; e2e tests for mode toggle, live data display, history graph. |
| V. Token-Based Cloud Auth | PASS | UpCloud Managed Database provisioned via Terraform using `UPCLOUD_TOKEN`. Database credentials passed to app via cloud-init `.env.secrets`. |
| VI. Durable Data Persistence | PASS | UpCloud Managed PostgreSQL — external managed service with automated backups, PITR, and 25 GB storage. No container-local data. |

## Project Structure

### Documentation (this feature)

```text
specs/010-live-system-playground/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: technology research
├── data-model.md        # Phase 1: data model
├── quickstart.md        # Phase 1: development quickstart
├── contracts/
│   ├── mqtt-topics.md   # MQTT topic and payload contract
│   └── websocket-api.md # WebSocket and history HTTP API contract
├── checklists/
│   └── requirements.md  # Specification quality checklist
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
shelly/
├── control.js              # MODIFIED: add config reading from KVS, event handler for config_changed, actuator enable guards, emit state_updated events
├── control-logic.js        # MODIFIED: evaluate() accepts config parameter — disabled actuators marked as suppressed
├── telemetry.js            # NEW: MQTT publish/subscribe, config bootstrap (HTTP GET), KVS config persistence, inter-script events
├── deploy.sh               # MODIFIED: support VPN IPs, configure MQTT on device, deploy telemetry.js as separate script
└── devices.conf            # MODIFIED: add VPN-reachable IPs alongside LAN IPs

monitor/
├── server.js               # MODIFIED: add MQTT subscriber, WebSocket server, history API, device config API, serve playground
├── lib/
│   ├── db.js               # NEW: PostgreSQL/TimescaleDB module (schema, CRUD, queries)
│   ├── mqtt-bridge.js      # NEW: MQTT subscription + WebSocket broadcast
│   ├── device-config.js    # NEW: device configuration store (S3/local persistence, GET/PUT API handler)
│   ├── s3-storage.js       # EXISTING: unchanged
│   ├── push-storage.js     # EXISTING: unchanged
│   ├── valve-poller.js     # DEPRECATED: replaced by MQTT subscription
│   └── logger.js           # EXISTING: unchanged
├── auth/                    # EXISTING: unchanged
└── vendor/                  # EXISTING: unchanged

playground/
├── index.html              # MODIFIED: data source toggle, deployment detection, WebSocket client
├── js/
│   ├── data-source.js      # NEW: DataSource interface (SimulationSource, LiveSource)
│   ├── control.js          # EXISTING: unchanged (used by SimulationSource)
│   ├── physics.js          # EXISTING: unchanged (used by SimulationSource)
│   ├── ui.js               # EXISTING: minor updates for connection status indicator
│   ├── control-logic-loader.js  # EXISTING: unchanged
│   └── yaml-loader.js      # EXISTING: unchanged
├── css/style.css           # MODIFIED: connection status, mode toggle styles
└── vendor/                  # EXISTING: unchanged

deploy/
├── terraform/
│   ├── main.tf             # MODIFIED: add managed PostgreSQL + TimescaleDB resource
│   ├── variables.tf        # MODIFIED: add db_plan variable
│   ├── outputs.tf          # MODIFIED: add database connection outputs
│   └── cloud-init.yaml     # MODIFIED: add DATABASE_URL to .env.secrets
└── deployer/
    ├── docker-compose.yml  # MODIFIED: add mosquitto service
    ├── deploy.sh           # MODIFIED: add Shelly script deployment step (via VPN)
    └── config.env          # MODIFIED: add MQTT_HOST, CONTROLLER_VPN_IP env vars

tests/
├── db.test.js              # NEW: PostgreSQL/TimescaleDB module unit tests
├── mqtt-bridge.test.js     # NEW: MQTT bridge unit tests
├── data-source.test.js     # NEW: data source abstraction tests
├── device-config.test.js   # NEW: device config store unit tests
├── control-logic.test.js   # MODIFIED: add tests for config-gated actuator control
├── playground-control.test.js  # EXISTING: unchanged
└── e2e/
    ├── thermal-sim.spec.js # EXISTING: unchanged (simulation regression)
    └── live-mode.spec.js   # NEW: live mode toggle, WebSocket, history
```

**Structure Decision**: Follows the existing project layout. No new top-level directories. New server-side modules go in `monitor/lib/`, new browser modules in `playground/js/`, new tests in `tests/`. The Mosquitto broker is added as a Docker Compose service. The PostgreSQL+TimescaleDB database is provisioned via Terraform as an UpCloud Managed Database (external to the server). Device configuration is persisted via the existing S3/local storage adapter pattern (same as credentials and push subscriptions). Remote Shelly deployment is integrated into the deployer, reusing the existing `deploy.sh` with VPN-routable IPs. The `control-logic.js` pure logic layer gains a `config` parameter to respect enabled/disabled flags while keeping the function pure (config is data, not I/O). MQTT and config management are in a separate `shelly/telemetry.js` script to stay within the 16 KB per-script limit — the control script is already 19.4 KB and needs trimming before first hardware deployment. Inter-script communication uses `Shelly.emitEvent()`/`Shelly.addEventHandler()`.

## Complexity Tracking

No constitution violations requiring justification. All principles pass cleanly.
