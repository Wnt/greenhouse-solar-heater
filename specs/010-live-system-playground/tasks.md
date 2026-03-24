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

- [ ] T001 Add `pg`, `mqtt`, and `ws` dependencies to package.json via `npm install pg mqtt ws`
- [ ] T002 [P] Create dev Docker Compose file for local Mosquitto and TimescaleDB at deploy/deployer/docker-compose.dev.yml
- [ ] T003 [P] Add `test:db` and `test:mqtt` scripts to package.json for new unit test files

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Database, MQTT broker infrastructure, and server-side modules that ALL user stories depend on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

### Infrastructure

- [ ] T004 Add UpCloud Managed PostgreSQL resource (`upcloud_managed_database_postgresql.timeseries`) and database user to deploy/terraform/main.tf per research.md Terraform config
- [ ] T005 [P] Add `db_password` variable to deploy/terraform/variables.tf
- [ ] T006 [P] Add database connection outputs (`database_url`, `database_host`, `database_port`) to deploy/terraform/outputs.tf
- [ ] T007 Add `DATABASE_URL` to `.env.secrets` template in deploy/terraform/cloud-init.yaml
- [ ] T008 Add Mosquitto service to deploy/deployer/docker-compose.yml (eclipse-mosquitto:2-openssl, port 1883, persistence enabled, anonymous access)
- [ ] T009 [P] Add `MQTT_HOST` to deploy/deployer/config.env

### Database Module

- [ ] T010 Create PostgreSQL/TimescaleDB module at monitor/lib/db.js — schema initialization (CREATE EXTENSION timescaledb, hypertables for sensor_readings and state_events, continuous aggregate sensor_readings_30s, retention policy, indexes per data-model.md), connection pool, insert functions, `--init` CLI entry point
- [ ] T011 Create unit tests for db module at tests/db.test.js — schema initialization, sensor reading inserts, state event inserts, history query (raw + downsampled resolution selection)

### MQTT Bridge Module

- [ ] T012 Create MQTT-to-WebSocket bridge module at monitor/lib/mqtt-bridge.js — subscribes to `greenhouse/state` topic, parses JSON payload per mqtt-topics.md contract, decomposes into sensor_readings and state_events via db.js, broadcasts to WebSocket clients per websocket-api.md contract, tracks MQTT connection status
- [ ] T013 Create unit tests for MQTT bridge at tests/mqtt-bridge.test.js — message parsing, state change detection (diff previous vs current for state_events), WebSocket broadcast, connection status tracking, graceful MQTT disconnect handling

**Checkpoint**: Database schema, MQTT bridge, and infrastructure configs ready. User story implementation can begin.

---

## Phase 3: User Story 2 — Shelly Devices Publish State via MQTT (Priority: P2)

**Goal**: The Shelly Pro 4PM publishes consolidated JSON state snapshots via MQTT at regular intervals and on state changes.

**Independent Test**: Subscribe to `greenhouse/state` with any MQTT client and verify state messages arrive at ~30s intervals and immediately on mode transitions.

**Why before US1**: MQTT publishing is the data source that US1 consumes. Without it, there's no live data.

### Implementation

- [ ] T014 [US2] Modify shelly/control.js to add MQTT.publish() call at end of existing poll cycle — publish consolidated JSON state snapshot to `greenhouse/state` with QoS 1 and retain flag, per mqtt-topics.md payload schema (ts, mode, transitioning, transition_step, temps, valves, actuators, flags)
- [ ] T015 [US2] Add immediate MQTT.publish() calls in shelly/control.js during mode transition steps (pump_stop, valves_closing, valves_opening, pump_start) so each transition step is published
- [ ] T016 [US2] Add MQTT failure guard in shelly/control.js — wrap MQTT.publish() so false return (broker unavailable) is silently ignored; control logic continues unaffected (FR-006)
- [ ] T017 [US2] Update shelly/deploy.sh to configure MQTT on the Shelly device (`Mqtt.SetConfig` RPC call with broker address from devices.conf or env var) before deploying scripts
- [ ] T018 [US2] Run Shelly linter (`node shelly/lint/bin/shelly-lint.js shelly/control.js`) to verify ES5 compliance of MQTT additions

**Checkpoint**: Shelly device publishes complete state snapshots via MQTT. Verifiable with `mosquitto_sub -t greenhouse/state`.

---

## Phase 4: User Story 1 — View Live System State in Playground (Priority: P1) 🎯 MVP

**Goal**: The playground displays real-time data from the physical system — temperatures, valves, actuators, mode — updated continuously via WebSocket.

**Independent Test**: Open the playground on greenhouse.madekivi.com, verify all five temperatures, eight valves, four actuators, and current mode display and update when physical state changes.

### Server Integration

- [ ] T019 [US1] Modify monitor/server.js to initialize MQTT bridge (mqtt-bridge.js) and WebSocket server (`ws` attached to existing http.Server at path `/ws`) with auth middleware — WebSocket upgrade rejected without valid session cookie per websocket-api.md
- [ ] T020 [US1] Modify monitor/server.js to initialize db.js connection pool on startup (if DATABASE_URL set) and call schema init; pass db reference to MQTT bridge for persistence
- [ ] T021 [US1] Modify monitor/server.js to serve playground/ static files as the primary app (replacing or alongside monitor/ static files)

### Browser Data Source

- [ ] T022 [US1] Create data source abstraction at playground/js/data-source.js — DataSource interface with `start()`, `stop()`, `onUpdate(callback)`, `onConnectionChange(callback)` methods; SimulationSource wrapping existing ThermalModel + ControlStateMachine; LiveSource using native WebSocket to `/ws` with auto-reconnect and connection status tracking
- [ ] T023 [US1] Create unit tests for data source at tests/data-source.test.js — SimulationSource produces state updates, LiveSource parses WebSocket messages per websocket-api.md contract, connection status transitions (connected → disconnected → reconnecting → connected)

### Playground UI Updates

- [ ] T024 [US1] Modify playground/index.html to import data-source.js and wire DataSource updates into existing `updateDisplay(state, result)` — map MQTT state snapshot shape to the playground's internal state/result format used by Status, Components, and Schematic views
- [ ] T025 [P] [US1] Add connection status indicator to playground/js/ui.js — show connected/disconnected/reconnecting state in the UI header (FR-012), with staleness indicator when no data received for >60s
- [ ] T026 [P] [US1] Add connection status and live mode indicator styles to playground/css/style.css — status dot (green/yellow/red), staleness warning banner

**Checkpoint**: Playground shows live system data from MQTT via WebSocket. Status, Components, and Schematic views all update in real time.

---

## Phase 5: User Story 3 — Switch Between Live and Simulation Modes (Priority: P3)

**Goal**: Users on greenhouse.madekivi.com can toggle between live monitoring and simulation. GitHub Pages runs simulation-only.

**Independent Test**: Visit GitHub Pages (simulation only, no toggle visible) and greenhouse.madekivi.com (defaults to live, toggle visible, switching works without reload).

### Implementation

- [ ] T027 [US3] Add deployment context detection to playground/index.html — detect GitHub Pages (`*.github.io` hostname) vs deployed app vs localhost; set `isLiveCapable` flag (FR-001)
- [ ] T028 [US3] Add live/simulation mode toggle UI to playground/index.html — visible only when `isLiveCapable` is true; toggles between LiveSource and SimulationSource without page reload (FR-008); Controls view available only in simulation mode
- [ ] T029 [US3] Add mode toggle styles to playground/css/style.css — toggle switch component, active mode indicator, Controls view show/hide based on mode
- [ ] T030 [US3] Ensure GitHub Pages mode works fully statically — SimulationSource has no WebSocket dependency, no server requests, existing simulation unchanged (FR-009, FR-018)

**Checkpoint**: Mode toggle works. GitHub Pages = simulation only. Deployed app = live default with toggle.

---

## Phase 6: User Story 4 — View Transition Sequences in Real Time (Priority: P4)

**Goal**: During mode transitions, users see step-by-step visualization — pump stops, valves close, new valves open, pump restarts — with real hardware timing.

**Independent Test**: Trigger a mode transition on the live system and verify intermediate steps appear sequentially in the UI.

### Implementation

- [ ] T031 [US4] Update playground/js/data-source.js LiveSource to detect transition states from MQTT snapshots — track `transitioning` and `transition_step` fields, emit transition step events to UI
- [ ] T032 [US4] Update playground/js/ui.js to render transition sequence in Components view — show each valve/actuator state change step-by-step as they arrive from LiveSource, with visual indication of in-progress transition
- [ ] T033 [US4] Update Schematic view rendering in playground/index.html to animate valve and pump state changes during transitions — highlight changing components, show transition_step label (FR-011)

**Checkpoint**: Mode transitions show intermediate steps in real time on Components and Schematic views.

---

## Phase 7: User Story 5 — View Historical Data in Live Mode (Priority: P5)

**Goal**: Status view shows real historical temperature data from the database with browsable time ranges.

**Independent Test**: Let system run for several hours, verify history graph shows real temperature trends and mode transitions across selected time ranges.

### Server History API

- [ ] T034 [US5] Add `GET /api/history` endpoint to monitor/server.js — accepts `range` and optional `sensor` query params per websocket-api.md contract; queries db.js for sensor readings (raw for ≤6h, blended for 24h/48h, 30s aggregate for ≥7d) and state events; returns JSON response
- [ ] T035 [US5] Add history query functions to monitor/lib/db.js — `getHistory(range, sensor)` that selects from `sensor_readings` (raw) or `sensor_readings_30s` (aggregate) based on range; `getEvents(range, entityType)` for state_events; pivot sensor rows into `{ts, collector, tank_top, ...}` response format

### Browser History Integration

- [ ] T036 [US5] Update playground Status view chart in playground/index.html to fetch historical data from `/api/history` API when in live mode — replace simulation time-series with real data; add time range selector (1h, 6h, 24h, 7d, 30d, 1y, all) per websocket-api.md
- [ ] T037 [US5] Update chart rendering to show mode transition event markers from history API `events` array — vertical lines or annotations at mode change timestamps on the time-series graph
- [ ] T038 [US5] Handle empty history state — show "Data collection started" message when no historical data exists yet; handle seamless resolution blending at 48h boundary

**Checkpoint**: History graph shows real temperature trends and mode transitions with browsable time ranges.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: E2E tests, integration verification, and cleanup.

- [ ] T039 [P] Create e2e test for live mode toggle and WebSocket connection at tests/e2e/live-mode.spec.js — verify mode toggle visibility based on deployment, WebSocket connection, live data display
- [ ] T040 [P] Verify existing e2e tests pass unchanged (tests/e2e/thermal-sim.spec.js) — simulation mode must not regress (SC-004)
- [ ] T041 Verify existing monitor features preserved in unified app — WebAuthn auth, push notifications, PWA installability (FR-017)
- [ ] T042 Run full test suite (`npm test`) and fix any regressions
- [ ] T043 Update quickstart.md if any development workflow steps changed during implementation
- [ ] T044 Run Shelly linter on all shelly/ files to confirm no ES5 violations

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
- **Phase 2**: T005, T006, T009 can run in parallel; T010 and T012 can run in parallel (different files)
- **Phase 4**: T025 and T026 can run in parallel (ui.js and style.css)
- **Phase 5–7**: US3, US4, US5 can run in parallel after US1 is complete (different files and concerns)
- **Phase 8**: T039 and T040 can run in parallel (different test files)

---

## Parallel Example: After US1 Completion

```
# These three user stories can proceed in parallel after US1:

Stream 1 (US3): T027 → T028 → T029 → T030
Stream 2 (US4): T031 → T032 → T033
Stream 3 (US5): T034 → T035 → T036 → T037 → T038
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
- Shelly script changes (US2) must pass the ES5 linter — no const/let, no arrow functions, no template literals
- Database module supports graceful degradation — if DATABASE_URL is not set, history features are disabled but live WebSocket still works
- Existing simulation tests must not regress — SC-004 is a hard requirement
