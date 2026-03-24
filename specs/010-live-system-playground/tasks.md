# Tasks: Connect Playground to Live System

**Input**: Design documents from `/specs/010-live-system-playground/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (mqtt-topics.md, websocket-api.md), quickstart.md

**Tests**: Included — plan.md specifies test files and Constitution IV requires proportional test coverage.

**Organization**: Tasks grouped by user story. US2 (Shelly MQTT) is implemented before US1 (Live View) because MQTT publishing is the transport layer that enables live data.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Exact file paths included in descriptions

---

## Phase 1: Setup

**Purpose**: Install dependencies and prepare project structure for new modules.

- [x] T001 Add `pg`, `mqtt`, and `ws` dependencies to package.json via `npm install pg mqtt ws`
- [x] T002 [P] Create dev Docker Compose file for local Mosquitto and TimescaleDB at deploy/deployer/docker-compose.dev.yml
- [x] T003 [P] Add `test:db` and `test:mqtt` scripts to package.json for new unit test files

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database, MQTT broker infrastructure, and server-side modules that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Infrastructure

- [x] T004 Add UpCloud Managed PostgreSQL resource (`upcloud_managed_database_postgresql.timeseries`) and database user to deploy/terraform/main.tf per research.md Terraform config
- [x] T005 [P] Add `db_password` variable to deploy/terraform/variables.tf
- [x] T006 [P] Add database connection outputs (`database_url`, `database_host`, `database_port`) to deploy/terraform/outputs.tf
- [x] T007 Add `DATABASE_URL` to `.env.secrets` template in deploy/terraform/cloud-init.yaml
- [x] T008 Add Mosquitto service to deploy/deployer/docker-compose.yml (eclipse-mosquitto:2-openssl, port 1883, persistence enabled, anonymous access)
- [x] T009 [P] Add `MQTT_HOST` and `CONTROLLER_VPN_IP` to deploy/deployer/config.env

### Database Module

- [x] T010 Create PostgreSQL/TimescaleDB module at monitor/lib/db.js — schema initialization (CREATE EXTENSION timescaledb, hypertables for sensor_readings and state_events, continuous aggregate sensor_readings_30s, retention policy, indexes per data-model.md), connection pool, insert functions, `--init` CLI entry point
- [x] T011 Create unit tests for db module at tests/db.test.js — schema initialization, sensor reading inserts, state event inserts, history query (raw + downsampled resolution selection)

### MQTT Bridge Module

- [x] T012 Create MQTT-to-WebSocket bridge module at monitor/lib/mqtt-bridge.js — subscribes to `greenhouse/state` topic, parses JSON payload per mqtt-topics.md contract, decomposes into sensor_readings and state_events via db.js, broadcasts to WebSocket clients per websocket-api.md contract, tracks MQTT connection status
- [x] T013 Create unit tests for MQTT bridge at tests/mqtt-bridge.test.js — message parsing, state change detection (diff previous vs current for state_events), WebSocket broadcast, connection status tracking, graceful MQTT disconnect handling

### Device Configuration Module

- [x] T014 Create device configuration store at monitor/lib/device-config.js — S3/local persistence (same adapter pattern as credentials), default config with all controls disabled, `GET /api/device-config` handler (unauthenticated — VPN-only access), `PUT /api/device-config` handler (auth required), auto-increment version on updates; on PUT: persist to S3, then publish to `greenhouse/config` MQTT topic (retained, QoS 1) for instant push to device per contracts/mqtt-topics.md
- [x] T015 Create unit tests for device config at tests/device-config.test.js — default config (all disabled), GET returns current config, PUT updates and increments version, PUT publishes to MQTT, persistence round-trip

### Remote Deployment

- [x] T016 [P] Add VPN-reachable IP entries to shelly/devices.conf (e.g., `PRO4PM_VPN` alongside existing LAN IPs)
- [x] T017 Update shelly/deploy.sh to support VPN deployment and telemetry script — accept `DEPLOY_VIA_VPN=true` env var to select VPN IPs from devices.conf, deploy telemetry.js as a separate script (different script ID), add MQTT configuration step (`Mqtt.SetConfig` RPC call with broker address)
- [x] T018 Add Shelly script deployment step to deploy/deployer/deploy.sh — run shelly/deploy.sh inside the VPN network namespace after `docker compose up -d` (uses app container which shares openvpn network)

**Checkpoint**: Database schema, MQTT bridge, device config, remote deployment, and infrastructure configs ready. User story implementation can begin.

---

## Phase 3: User Story 2 — Shelly Devices Publish State via MQTT (Priority: P2)

**Goal**: The Shelly Pro 4PM publishes consolidated JSON state snapshots via MQTT at regular intervals and on state changes.

**Independent Test**: Subscribe to `greenhouse/state` with any MQTT client and verify state messages arrive at ~30s intervals and immediately on mode transitions.

**Why before US1**: MQTT publishing is the data source that US1 consumes. Without it, there's no live data.

### Control Script Changes (shelly/control.js + control-logic.js)

- [x] T019 [US2] Modify shelly/control-logic.js evaluate() to accept config parameter — when controls disabled, return mode decisions as usual but mark actuator commands as suppressed in the result, so I/O layer knows to skip them while still reporting the logical mode
- [x] T020 [US2] Add config reading from KVS to shelly/control.js boot sequence — read `config` key from KVS on startup (default: all controls disabled if not found); pass config to evaluate() (FR-022)
- [x] T021 [US2] Add event handler in shelly/control.js for `config_changed` events from telemetry script — update local config; if event.safety_critical is true, call controlLoop() immediately; non-critical changes wait for regular 30s cycle (FR-020, FR-021)
- [x] T022 [US2] Add actuator enable guards to shelly/control.js — before any setPump/setFan/setImmersion/setSpaceHeater/setValve call, check config.controls_enabled and per-actuator flags; if disabled, skip hardware command but still track logical state (FR-019)
- [x] T023 [US2] Add state_updated event emission in shelly/control.js — emit `Shelly.emitEvent("state_updated", stateSnapshot)` at end of each poll cycle and during each transition step, so telemetry script can publish to MQTT
- [x] T024 [US2] Trim shelly/control.js to fit within 16 KB limit when concatenated with control-logic.js — remove comments, shorten status endpoint (or move to telemetry script), minimize variable names in non-critical paths. Current: 19.4 KB, target: ≤16 KB

### Telemetry Script (shelly/telemetry.js — NEW)

- [x] T025 [P] [US2] Create shelly/telemetry.js — MQTT config subscription: subscribe to `greenhouse/config`, on message compare version with KVS, update KVS if different, emit `Shelly.emitEvent("config_changed", {config, safety_critical})` where safety_critical is true if controls_enabled or any enabled_actuators flag changed
- [x] T026 [P] [US2] Add HTTP config bootstrap to shelly/telemetry.js — on boot, HTTP GET cloud config endpoint; if version differs from KVS, update KVS and emit config_changed event (FR-021)
- [x] T027 [US2] Add MQTT state publishing to shelly/telemetry.js — listen for `state_updated` events from control script via Shelly.addEventHandler(); publish state to `greenhouse/state` with QoS 1 and retain flag per mqtt-topics.md; guard with MQTT.isConnected() (FR-005, FR-006)

### Tests and Verification

- [x] T028 [US2] Update tests/control-logic.test.js to verify config-gated actuator behavior — evaluate() with controls disabled returns suppressed actuator commands; evaluate() with partial actuator enables respects per-actuator flags
- [x] T029 [US2] Run Shelly linter on shelly/control.js and shelly/telemetry.js — verify ES5 compliance and per-script size ≤16 KB

**Checkpoint**: Control script reads config from KVS and respects actuator flags. Telemetry script publishes state via MQTT and pushes config changes via events. Config changes take effect immediately for safety-critical fields. Verifiable with `mosquitto_sub -t greenhouse/state` and `mosquitto_pub -t greenhouse/config`.

---

## Phase 4: User Story 1 — View Live System State in Playground (Priority: P1) 🎯 MVP

**Goal**: The playground displays real-time data from the physical system — temperatures, valves, actuators, mode — updated continuously via WebSocket.

**Independent Test**: Open the playground on greenhouse.madekivi.com, verify all five temperatures, eight valves, four actuators, and current mode display and update when physical state changes.

### Server Integration

- [x] T030 [US1] Modify monitor/server.js to initialize MQTT bridge (mqtt-bridge.js) and WebSocket server (`ws` attached to existing http.Server at path `/ws`) with auth middleware — WebSocket upgrade rejected without valid session cookie per websocket-api.md
- [x] T031 [US1] Modify monitor/server.js to initialize db.js connection pool on startup (if DATABASE_URL set) and call schema init; pass db reference to MQTT bridge for persistence
- [x] T032 [US1] Modify monitor/server.js to register device-config.js API handlers and serve playground/ static files as the primary app (replacing or alongside monitor/ static files)

### Browser Data Source

- [x] T033 [US1] Create data source abstraction at playground/js/data-source.js — DataSource interface with `start()`, `stop()`, `onUpdate(callback)`, `onConnectionChange(callback)` methods; SimulationSource wrapping existing ThermalModel + ControlStateMachine; LiveSource using native WebSocket to `/ws` with auto-reconnect and connection status tracking
- [x] T034 [US1] Create unit tests for data source at tests/data-source.test.js — SimulationSource produces state updates, LiveSource parses WebSocket messages per websocket-api.md contract, connection status transitions (connected → disconnected → reconnecting → connected)

### Playground UI Updates

- [x] T035 [US1] Modify playground/index.html to import data-source.js and wire DataSource updates into existing `updateDisplay(state, result)` — map MQTT state snapshot shape to the playground's internal state/result format used by Status, Components, and Schematic views
- [x] T036 [P] [US1] Add connection status indicator to playground/js/ui.js — show connected/disconnected/reconnecting state in the UI header (FR-012), with staleness indicator when no data received for >60s, controls_enabled status visible
- [x] T037 [P] [US1] Add connection status and live mode indicator styles to playground/css/style.css — status dot (green/yellow/red), staleness warning banner, controls-disabled indicator

**Checkpoint**: Playground shows live system data from MQTT via WebSocket. Status, Components, and Schematic views all update in real time.

---

## Phase 5: User Story 3 — Switch Between Live and Simulation Modes (Priority: P3)

**Goal**: Users on greenhouse.madekivi.com can toggle between live monitoring and simulation. GitHub Pages runs simulation-only.

**Independent Test**: Visit GitHub Pages (simulation only, no toggle visible) and greenhouse.madekivi.com (defaults to live, toggle visible, switching works without reload).

### Implementation

- [x] T038 [US3] Add deployment context detection to playground/index.html — detect GitHub Pages (`*.github.io` hostname) vs deployed app vs localhost; set `isLiveCapable` flag (FR-001)
- [x] T039 [US3] Add live/simulation mode toggle UI to playground/index.html — visible only when `isLiveCapable` is true; toggles between LiveSource and SimulationSource without page reload (FR-008); Controls view available only in simulation mode
- [x] T040 [US3] Add mode toggle styles to playground/css/style.css — toggle switch component, active mode indicator, Controls view show/hide based on mode
- [x] T041 [US3] Ensure GitHub Pages mode works fully statically — SimulationSource has no WebSocket dependency, no server requests, existing simulation unchanged (FR-009, FR-018)

**Checkpoint**: Mode toggle works. GitHub Pages = simulation only. Deployed app = live default with toggle.

---

## Phase 6: User Story 4 — View Transition Sequences in Real Time (Priority: P4)

**Goal**: During mode transitions, users see step-by-step visualization — pump stops, valves close, new valves open, pump restarts — with real hardware timing.

**Independent Test**: Trigger a mode transition on the live system and verify intermediate steps appear sequentially in the UI.

### Implementation

- [x] T042 [US4] Update playground/js/data-source.js LiveSource to detect transition states from MQTT snapshots — track `transitioning` and `transition_step` fields, emit transition step events to UI
- [x] T043 [US4] Update playground/js/ui.js to render transition sequence in Components view — show each valve/actuator state change step-by-step as they arrive from LiveSource, with visual indication of in-progress transition
- [x] T044 [US4] Update Schematic view rendering in playground/index.html to animate valve and pump state changes during transitions — highlight changing components, show transition_step label (FR-011)

**Checkpoint**: Mode transitions show intermediate steps in real time on Components and Schematic views.

---

## Phase 7: User Story 5 — View Historical Data in Live Mode (Priority: P5)

**Goal**: Status view shows real historical temperature data from the database with browsable time ranges.

**Independent Test**: Let system run for several hours, verify history graph shows real temperature trends and mode transitions across selected time ranges.

### Server History API

- [x] T045 [US5] Add `GET /api/history` endpoint to monitor/server.js — accepts `range` and optional `sensor` query params per websocket-api.md contract; queries db.js for sensor readings (raw for ≤6h, blended for 24h/48h, 30s aggregate for ≥7d) and state events; returns JSON response
- [x] T046 [US5] Add history query functions to monitor/lib/db.js — `getHistory(range, sensor)` that selects from `sensor_readings` (raw) or `sensor_readings_30s` (aggregate) based on range; `getEvents(range, entityType)` for state_events; pivot sensor rows into `{ts, collector, tank_top, ...}` response format

### Browser History Integration

- [x] T047 [US5] Update playground Status view chart in playground/index.html to fetch historical data from `/api/history` API when in live mode — replace simulation time-series with real data; add time range selector (1h, 6h, 24h, 7d, 30d, 1y, all) per websocket-api.md
- [x] T048 [US5] Update chart rendering to show mode transition event markers from history API `events` array — vertical lines or annotations at mode change timestamps on the time-series graph
- [x] T049 [US5] Handle empty history state — show "Data collection started" message when no historical data exists yet; handle seamless resolution blending at 48h boundary

**Checkpoint**: History graph shows real temperature trends and mode transitions with browsable time ranges.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: E2E tests, integration verification, and cleanup.

- [x] T050 [P] Create e2e test for live mode toggle and WebSocket connection at tests/e2e/live-mode.spec.js — verify mode toggle visibility based on deployment, WebSocket connection, live data display
- [x] T051 [P] Verify existing e2e tests pass unchanged (tests/e2e/thermal-sim.spec.js) — simulation mode must not regress (SC-004)
- [x] T052 Verify existing monitor features preserved in unified app — WebAuthn auth, push notifications, PWA installability (FR-017)
- [x] T053 Verify device config safety — fresh device with no KVS config starts in monitoring-only mode (SC-009); safety-critical config change via PUT triggers immediate controlLoop() on device within seconds via event from telemetry script (SC-010); disabling controls while mode is active triggers safe shutdown without 30s wait
- [x] T054 Run full test suite (`npm test`) and fix any regressions
- [x] T055 Update quickstart.md if any development workflow steps changed during implementation
- [x] T056 Run Shelly linter on all shelly/ files (control.js, telemetry.js) to confirm ES5 compliance and per-script size ≤16 KB

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **US2 (Phase 3)**: Depends on Phase 2 (Mosquitto infra). BLOCKS US1.
- **US1 (Phase 4)**: Depends on Phase 2 (db, mqtt-bridge) + Phase 3 (MQTT data source)
- **US3 (Phase 5)**: Depends on Phase 4 (data-source.js must exist with both LiveSource and SimulationSource)
- **US4 (Phase 6)**: Depends on Phase 4 (LiveSource must be working). Can parallel with Phase 5.
- **US5 (Phase 7)**: Depends on Phase 2 (db.js history queries) + Phase 4 (live mode UI). Can parallel with Phase 5 and 6.
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US2 (P2)**: After Foundational — no other story dependencies. **Must complete before US1.**
- **US1 (P1)**: After Foundational + US2 — core live data pipeline
- **US3 (P3)**: After US1 — needs both data sources implemented
- **US4 (P4)**: After US1 — can parallel with US3 and US5
- **US5 (P5)**: After US1 — can parallel with US3 and US4

### Within Each User Story

- Server-side modules before browser-side consumers
- Data source/abstraction before UI integration
- Core functionality before edge cases and polish

### Parallel Opportunities

- **Phase 1**: T002 and T003 can run in parallel
- **Phase 2**: T005, T006, T009, T016 can run in parallel; T010, T012, T014 can run in parallel (different files)
- **Phase 3**: T025 and T026 can run in parallel (telemetry.js features, independent sections)
- **Phase 4**: T036 and T037 can run in parallel (ui.js and style.css)
- **Phase 5–7**: US3, US4, US5 can run in parallel after US1 is complete (different files and concerns)
- **Phase 8**: T050 and T051 can run in parallel (different test files)

---

## Parallel Example: After US1 Completion

```
# These three user stories can proceed in parallel after US1:

Stream 1 (US3): T038 → T039 → T040 → T041
Stream 2 (US4): T042 → T043 → T044
Stream 3 (US5): T045 → T046 → T047 → T048 → T049
```

---

## Implementation Strategy

### MVP First (US2 + US1)

1. Complete Phase 1: Setup (dependencies, dev infra)
2. Complete Phase 2: Foundational (Terraform DB, Mosquitto, db.js, mqtt-bridge.js)
3. Complete Phase 3: US2 (Shelly MQTT publishing)
4. Complete Phase 4: US1 (Live data in playground)
5. **STOP and VALIDATE**: Verify live temperatures, valves, actuators, mode display and update in real time
6. Deploy to greenhouse.madekivi.com

### Incremental Delivery

1. Setup + Foundational → Infrastructure ready
2. US2 → MQTT data flowing → Verifiable with mosquitto_sub
3. US1 → Live playground → Deploy MVP!
4. US3 → Mode toggle → Preserves simulation on GitHub Pages
5. US4 + US5 (parallel) → Transitions + History → Full feature complete
6. Polish → E2E tests, regression verification

### Suggested MVP Scope

**MVP = Phase 1 + Phase 2 + Phase 3 (US2) + Phase 4 (US1)**: Live system state visible in playground. This delivers the core value proposition (SC-001, SC-002) and validates the entire data pipeline end-to-end.

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps task to specific user story for traceability
- US2 is implemented before US1 despite lower business priority because it's the data source US1 depends on
- Shelly scripts split across two files: control.js (+ control-logic.js) for safety-critical control loop, telemetry.js for MQTT and config — each must be ≤16 KB and ES5 compliant
- The existing control script (19.4 KB) needs trimming to fit the 16 KB limit — this is a pre-existing issue, the scripts have not yet run on hardware
- Inter-script communication via Shelly.emitEvent()/addEventHandler() — events are instant, no polling
- Database module supports graceful degradation — if DATABASE_URL is not set, history features are disabled but live WebSocket still works
- Existing simulation tests must not regress — SC-004 is a hard requirement
- All actuator control is disabled by default — a fresh device only monitors (reads sensors, publishes MQTT) until explicitly configured
- Device config endpoint (`/api/device-config` GET) is unauthenticated because Shelly can't do WebAuthn — access control relies on VPN/network boundary
- Config updates are pushed instantly via MQTT (`greenhouse/config` retained topic) — no polling. Safety-critical changes (actuator enables) trigger immediate `controlLoop()` call — no 30s wait. Non-critical changes (thresholds) wait for next regular cycle
- Config is persisted in Shelly KVS so the device survives reboots and internet outages; HTTP bootstrap on boot, MQTT push for live updates
- Remote Shelly deployment uses the same HTTP RPC protocol as LAN deployment — only the target IP changes (VPN-routable)
