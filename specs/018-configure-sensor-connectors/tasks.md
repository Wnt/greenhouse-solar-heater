# Tasks: Configure Sensor Connectors

**Input**: Design documents from `/specs/018-configure-sensor-connectors/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Included — the constitution requires proportional test coverage (Principle IV).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Environment configuration and shared infrastructure

- [ ] T001 Add `SENSOR_HOST_IPS` to Terraform app-config ConfigMap in deploy/terraform/main.tf
- [ ] T002 Create sensor config store module in server/lib/sensor-config.js — S3/local persistence (same pattern as server/lib/device-config.js), load/save/updateAssignments functions, default config with empty assignments and hosts from `SENSOR_HOST_IPS` env var

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Server-side API endpoints and RPC proxy extension that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 Extend RPC proxy in server/server.js to support `_host` parameter — if `_host` is present in request body, use it as target IP instead of `CONTROLLER_IP`; validate against allowlist built from `CONTROLLER_IP` + `SENSOR_HOST_IPS` env var; return 403 if not in allowlist
- [ ] T004 Register sensor-config API routes in server/server.js — GET /api/sensor-config (unauthenticated), PUT /api/sensor-config (authenticated), POST /api/sensor-config/apply (authenticated), POST /api/sensor-config/apply/:hostId (authenticated). Wire to sensor-config.js handlers. Load sensor config at startup.
- [ ] T005 [P] Add `publishSensorConfig(config)` method to server/lib/mqtt-bridge.js — publish compact format to `greenhouse/sensor-config` topic (QoS 1, retained), same pattern as existing `publishConfig()`
- [ ] T006 [P] Write unit tests for sensor config store in tests/sensor-config.test.js — test default config generation from SENSOR_HOST_IPS, assignment CRUD, validation (duplicate addrs, invalid component IDs, missing required roles warning), version increment, S3/local persistence
- [ ] T007 [P] Write unit tests for RPC proxy host allowlist in tests/rpc-proxy.test.js — add test cases for `_host` parameter: allowed host passes through, disallowed host returns 403, missing `_host` uses CONTROLLER_IP (existing behavior preserved)

**Checkpoint**: Server APIs ready — sensor config can be read, written, and applied. RPC proxy can target sensor hosts.

---

## Phase 3: User Story 1 — Detect and Identify Sensors (Priority: P1) MVP

**Goal**: Operator can scan sensor hosts and see all connected DS18B20 sensors with hardware addresses and live temperatures.

**Independent Test**: Open `#sensors` view, verify sensors from both hosts appear with addresses and temperatures. Warm a sensor by hand and watch the temperature rise in the UI.

### Tests for User Story 1

- [ ] T008 [P] [US1] Write e2e test for sensor detection view in tests/e2e/sensor-config.spec.js — test that `#sensors` view loads, shows sensor host sections, displays mock sensor data (mock RPC responses via route interception)

### Implementation for User Story 1

- [ ] T009 [US1] Add `#sensors` nav link and view container to playground/index.html — new hash-routed view (visible in live mode only), add sidebar nav entry with `sensors` icon, add `<section id="view-sensors">` with host groups layout, follow Stitch dark theme
- [ ] T010 [US1] Create sensor configuration UI module in playground/js/sensors.js — ES module that: (1) calls RPC proxy with `_host` param to invoke `SensorAddon.OneWireScan` on each sensor host, (2) calls `Temperature.GetStatus` for each detected sensor's component (if bound), (3) calls `Shelly.GetComponents` with `dynamic_only:true` to get current bindings, (4) renders detected sensors grouped by host with addr, component binding, and temperature, (5) auto-refreshes every 30 seconds, (6) shows host error states when unreachable
- [ ] T011 [US1] Wire sensors module into playground/index.html — import sensors.js module, call init on hash change to `#sensors`, pass live mode state, load sensor config from GET /api/sensor-config on view entry

**Checkpoint**: User Story 1 complete — operator can detect and identify sensors from both hosts in the UI.

---

## Phase 4: User Story 2 — Assign Sensors to Roles (Priority: P1)

**Goal**: Operator can assign detected sensors to system roles (t_collector, t_tank_top, etc.) and save the mapping.

**Independent Test**: Detect sensors (US1), assign one to a role, save, refresh the page, verify assignment persists.

### Tests for User Story 2

- [ ] T012 [P] [US2] Extend e2e tests in tests/e2e/sensor-config.spec.js — test assignment UI: select a detected sensor, assign to a role, save, verify PUT /api/sensor-config is called with correct payload, verify UI reflects saved state after reload

### Implementation for User Story 2

- [ ] T013 [US2] Add sensor role definitions to playground/js/sensors.js — define roles list (collector, tank_top, tank_bottom, greenhouse, outdoor, radiator_in, radiator_out) with labels, locations, and optional flag; derive from system.yaml sensor definitions
- [ ] T014 [US2] Add assignment UI to playground/js/sensors.js and playground/index.html — for each role, show current assignment (addr + live temp) or "unassigned" state; add dropdown/select to assign a detected sensor to a role; validate no duplicate addresses across roles; show unassigned detected sensors in a separate "Available" section
- [ ] T015 [US2] Add save functionality to playground/js/sensors.js — collect all assignments into the server-side format (role → {addr, hostIndex, componentId}); call PUT /api/sensor-config; update UI with response (version, status message); handle 400 validation errors
- [ ] T016 [US2] Implement PUT /api/sensor-config handler in server/lib/sensor-config.js — validate assignments (no duplicate addrs, valid component ID range 100-199, valid hostIndex), merge with current config, increment version, persist, return updated config

**Checkpoint**: User Stories 1 AND 2 complete — operator can detect sensors and assign them to roles with persistence.

---

## Phase 5: User Story 3 — Swap or Reconfigure Sensors (Priority: P2)

**Goal**: Operator can replace a faulty sensor or reorganize wiring without manual file editing.

**Independent Test**: Assign a sensor to a role, "unplug" it (mock disconnect), verify warning shown, assign a new sensor to the same role, save.

### Implementation for User Story 3

- [ ] T017 [US3] Add disconnected sensor detection to playground/js/sensors.js — when scanning, compare detected sensors against saved assignments; if an assigned sensor's addr is no longer detected, show the role with a "sensor missing" warning and the last known address; allow the operator to unassign the missing sensor or assign a new one
- [ ] T018 [US3] Add unassign action to playground/js/sensors.js — allow clearing a role's assignment back to "unassigned" state; update UI and enable save

**Checkpoint**: Sensor replacement workflow works — operator can handle disconnected sensors and reassign roles.

---

## Phase 6: User Story 4 — Apply Full Configuration (Priority: P2)

**Goal**: Operator pushes finalized sensor mapping to sensor hosts (via SensorAddon RPC) and control system (via MQTT).

**Independent Test**: Complete assignments, click "Apply", verify sensor hosts are configured (peripherals match assignments) and control system receives sensor routing config via MQTT.

### Tests for User Story 4

- [ ] T019 [P] [US4] Write unit tests for apply logic in tests/sensor-config.test.js — test apply handler: builds correct SensorAddon.RemovePeripheral + AddPeripheral RPC sequence per host, publishes compact sensor config to MQTT, handles partial failures (one host unreachable), tracks per-target status
- [ ] T020 [P] [US4] Extend e2e tests in tests/e2e/sensor-config.spec.js — test apply button: mock RPC calls to sensor hosts, verify per-target success/failure display, test retry for failed targets

### Implementation for User Story 4

- [ ] T021 [US4] Implement POST /api/sensor-config/apply handler in server/lib/sensor-config.js — for each sensor host: (1) call SensorAddon.GetPeripherals via RPC proxy to get existing bindings, (2) call SensorAddon.RemovePeripheral for each existing binding, (3) call SensorAddon.AddPeripheral for each sensor assigned to this host (with cid and addr), (4) track success/failure per host; then publish compact sensor config to MQTT via mqttBridge.publishSensorConfig(); return per-target results
- [ ] T022 [US4] Implement POST /api/sensor-config/apply/:hostId handler in server/lib/sensor-config.js — retry apply for a single target (sensor host by id, or "control" for MQTT publish); same logic as full apply but for one target only
- [ ] T023 [US4] Add apply UI to playground/js/sensors.js and playground/index.html — "Apply Configuration" button (enabled only when all required roles assigned); show per-target status (success/error/pending) for each sensor host and control system; show retry button for failed targets; warn if required roles are unassigned
- [ ] T024 [US4] Add sensor config subscription to shelly/telemetry.js — subscribe to `greenhouse/sensor-config` MQTT topic (same pattern as `greenhouse/config` subscription); on message: version-gate, persist to KVS key `sensor_config`, emit `sensor_config_changed` event to control script
- [ ] T025 [US4] Update shelly/control.js to use dynamic sensor config from KVS — remove hardcoded `SENSOR_IP` and `SENSOR_IDS`; load `sensor_config` from KVS at boot (alongside device config); on `sensor_config_changed` event, update sensor polling config; build polling list from config: for each sensor name, resolve host IP from `h` array and component ID from `i` field; update `pollSensor()` URL to use dynamic host + id; if no sensor config in KVS, skip polling (all temps null → IDLE mode, safe default)
- [ ] T026 [US4] Update unit tests for dynamic sensor routing in tests/control-logic.test.js — verify that control-logic.js evaluate() still works correctly when sensor names remain the same (collector, tank_top, etc.); add tests that confirm no-sensor-config → IDLE behavior

**Checkpoint**: Full commissioning workflow works end-to-end — sensor hosts configured, control system has routing, temperatures flow correctly.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [ ] T027 [P] Run Shelly linter on modified scripts — `node shelly/lint/bin/shelly-lint.js shelly/control.js shelly/telemetry.js` to verify ES5 compliance of all changes
- [ ] T028 [P] Update CLAUDE.md with new file relationships — add sensor-config.js, sensors.js, sensor-config.test.js, sensor-config.spec.js entries
- [ ] T029 Run full test suite — `npm test` to verify no regressions across all unit, simulation, and e2e tests
- [ ] T030 Update system.yaml sensor section with note about runtime sensor configuration — add a note that sensor-to-role assignments are managed at runtime via the playground UI, not hardcoded in this file

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2 — can start after foundational APIs are ready
- **User Story 2 (Phase 4)**: Depends on Phase 3 (US1) — builds on the detection UI
- **User Story 3 (Phase 5)**: Depends on Phase 4 (US2) — extends assignment with disconnect/unassign
- **User Story 4 (Phase 6)**: Depends on Phase 4 (US2) — needs assignments to apply
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (Detect)**: Depends only on foundational phase. MVP deliverable.
- **US2 (Assign)**: Depends on US1 (needs detection UI to select sensors). Core value add.
- **US3 (Swap)**: Depends on US2 (extends assignment with disconnect handling). Can run in parallel with US4.
- **US4 (Apply)**: Depends on US2 (needs assignments to push). Can run in parallel with US3.

### Within Each User Story

- Tests written first (if included in that phase)
- UI structure before logic
- Client-side before server-side validation
- Core implementation before integration

### Parallel Opportunities

- T001 and T002 can run in parallel (different files)
- T005, T006, T007 can run in parallel with each other (different files)
- T008 can run in parallel with T009 (test vs implementation, different files)
- US3 and US4 can run in parallel after US2 is complete
- T019, T020 can run in parallel (different test files)
- T024 and T025 can run in parallel (different Shelly scripts)
- T027, T028 can run in parallel (different concerns)

---

## Parallel Example: User Story 1

```bash
# After Phase 2 complete, launch US1 tests and structure in parallel:
Task T008: "Write e2e test for sensor detection view in tests/e2e/sensor-config.spec.js"
Task T009: "Add #sensors nav link and view container to playground/index.html"

# Then sequentially:
Task T010: "Create sensor configuration UI module in playground/js/sensors.js"
Task T011: "Wire sensors module into playground/index.html"
```

## Parallel Example: User Story 4

```bash
# After US2 complete, launch US4 tests in parallel:
Task T019: "Write unit tests for apply logic in tests/sensor-config.test.js"
Task T020: "Extend e2e tests in tests/e2e/sensor-config.spec.js"

# Server-side apply:
Task T021: "Implement POST /api/sensor-config/apply handler"
Task T022: "Implement POST /api/sensor-config/apply/:hostId handler"

# UI and Shelly scripts in parallel:
Task T023: "Add apply UI to playground/js/sensors.js"
Task T024: "Add sensor config subscription to shelly/telemetry.js"
Task T025: "Update shelly/control.js to use dynamic sensor config"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup (T001-T002)
2. Complete Phase 2: Foundational (T003-T007)
3. Complete Phase 3: US1 — Detect Sensors (T008-T011)
4. Complete Phase 4: US2 — Assign to Roles (T012-T016)
5. **STOP and VALIDATE**: Sensor detection and assignment working end-to-end
6. This alone delivers significant value — operator can see and map sensors

### Full Delivery

7. Complete Phase 5: US3 — Swap/Reconfigure (T017-T018) — in parallel with Phase 6
8. Complete Phase 6: US4 — Apply Configuration (T019-T026) — in parallel with Phase 5
9. Complete Phase 7: Polish (T027-T030)
10. Full commissioning workflow operational

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Shelly script changes (T024, T025) MUST pass the ES5 linter before commit
- Sensor config KVS payload must stay under 256 bytes — verify with 7-sensor config
- The control script safe default (no config → IDLE) must be tested explicitly (T026)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
