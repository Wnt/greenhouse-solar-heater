# Tasks: MQTT-Only Shelly Communication API

**Input**: Design documents from `/specs/019-mqtt-only-shelly-api/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mqtt-api.md

**Tests**: Included — the spec requires proportional test coverage per Constitution Principle IV.

**Organization**: Tasks grouped by user story. US1 (state monitoring) is the MVP.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story (US1, US2, US3)
- Exact file paths included in descriptions

---

## Phase 1: Setup

**Purpose**: Prepare the branch and understand current state before making changes.

- [ ] T001 Verify all existing tests pass by running `npm test` from repository root
- [ ] T002 Read current source files to understand baseline: `shelly/control.js`, `shelly/telemetry.js`, `server/server.js`, `server/lib/valve-poller.js`, `server/lib/mqtt-bridge.js`, `server/lib/sensor-config.js`, `playground/js/sensors.js`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Remove the valve poller and RPC proxy — these are prerequisites for all user stories since they enforce the "no direct RPC" constraint.

**CRITICAL**: No user story work can begin until this phase is complete.

- [ ] T003 Remove `server/lib/valve-poller.js` — delete the file entirely
- [ ] T004 Remove valve poller imports and startup from `server/server.js` — remove `require('./lib/valve-poller')`, `startValvePoller()` call, and related configuration (CONTROLLER_IP for polling, CONTROLLER_SCRIPT_ID)
- [ ] T005 Remove or update `tests/valve-poller.test.js` — delete the test file since the module no longer exists
- [ ] T006 Remove the RPC proxy endpoint (`/api/rpc/*`) from `server/server.js` — delete `handleRpcRequest()`, `proxyRpc()`, and the route handler. Remove the `X-Shelly-Proxy` marker header validation, method allowlist, and CORS preflight handling for this path.
- [ ] T007 Remove or update `tests/rpc-proxy.test.js` — delete the test file since the RPC proxy endpoint no longer exists
- [ ] T008 Update `playground/js/sensors.js` — remove any direct RPC calls via `/api/rpc/*` proxy. Sensor discovery and config apply will be re-implemented in US2/US3 phases via new API endpoints.
- [ ] T009 Run `npm test` to verify all remaining tests pass after removals

**Checkpoint**: Server no longer makes any direct HTTP calls to Shelly devices. MQTT bridge still delivers state to WebSocket clients.

---

## Phase 3: User Story 1 — Reliable State Monitoring Without Script.Eval (Priority: P1) MVP

**Goal**: The monitoring dashboard receives system state purely through MQTT. No `Script.Eval` or HTTP polling of the controller. The controller operates fully without cloud.

**Independent Test**: Disconnect the cloud server entirely. Verify the Shelly controller continues operating. Reconnect and verify the dashboard receives state within one update cycle (30s).

### Tests for User Story 1

- [ ] T010 [P] [US1] Update `tests/mqtt-bridge.test.js` — add tests verifying that state reception, database persistence, WebSocket broadcast, and state change detection all work without valve poller. Ensure the MQTT bridge is the sole source of state data.
- [ ] T011 [P] [US1] Update `tests/data-source.test.js` — verify LiveSource (WebSocket) correctly handles state messages and connection status without any fallback to RPC polling.

### Implementation for User Story 1

- [ ] T012 [US1] Review and verify `server/lib/mqtt-bridge.js` handles all state reception correctly now that valve-poller is removed — ensure connection status events (`connected`, `reconnecting`, `disconnected`) are broadcast to WebSocket clients so the dashboard shows MQTT connectivity status.
- [ ] T013 [US1] Verify `playground/js/data-source.js` LiveSource correctly displays connection state to the user — when MQTT is disconnected, the dashboard should show a clear "disconnected" indicator rather than stale data.
- [ ] T014 [US1] Run `npm test` to verify all US1 tests pass

**Checkpoint**: Dashboard receives live state via MQTT only. No Script.Eval calls exist anywhere in the codebase.

---

## Phase 4: User Story 2 — Configuration Push Without Direct RPC (Priority: P2)

**Goal**: Device configuration and sensor configuration changes are delivered to the Shelly controller exclusively through MQTT. The controller applies sensor config to sensor hosts via local network RPC.

**Independent Test**: Change a device configuration setting in the dashboard. Verify the Shelly device receives and applies it via MQTT, with no HTTP RPC from the cloud.

### Tests for User Story 2

- [ ] T015 [P] [US2] Add unit tests for the new sensor-config-apply MQTT flow in `tests/sensor-config.test.js` — test that `applyConfig()` and `applySingleTarget()` publish to `greenhouse/sensor-config-apply` and wait for a correlated response on `greenhouse/sensor-config-result` instead of making direct HTTP RPC calls.
- [ ] T016 [P] [US2] Add unit tests for MQTT request/response correlation in `tests/mqtt-bridge.test.js` — test that `publishSensorConfigApply()` publishes the request with a correlation ID, subscribes to the result topic, resolves on matching ID, and rejects on timeout (30s).

### Implementation for User Story 2

- [ ] T017 [US2] Add MQTT publish/subscribe for sensor-config-apply in `server/lib/mqtt-bridge.js` — add `publishSensorConfigApply(request)` that publishes to `greenhouse/sensor-config-apply` (QoS 1, no retain), subscribes to `greenhouse/sensor-config-result`, and returns a Promise that resolves when a matching correlation ID arrives or rejects after 30s timeout.
- [ ] T018 [US2] Refactor `server/lib/sensor-config.js` — replace direct HTTP RPC in `applyToHost()` and `applyConfig()` with calls to the new `mqttBridge.publishSensorConfigApply()`. The `rpcCall()` function and direct HTTP logic should be removed. Update `applySingleTarget()` similarly.
- [ ] T019 [US2] Update `/api/sensor-config/apply` and `/api/sensor-config/apply/:targetId` handlers in `server/server.js` — ensure they use the refactored sensor-config.js which now routes through MQTT. Return MQTT response results to the HTTP caller. Handle 30s timeout with HTTP 504.
- [ ] T020 [US2] Add sensor-config-apply subscription to `shelly/telemetry.js` — subscribe to `greenhouse/sensor-config-apply` topic. On message, emit a `"sensor_config_apply"` inter-script event to the control script with the parsed request payload.
- [ ] T021 [US2] Add sensor-config-apply handler to `shelly/control.js` — listen for `"sensor_config_apply"` events. When received, set a `pendingConfigApply` flag with the request data. In the control loop, after sensor polling completes, check the flag. If set, execute `SensorAddon.RemovePeripheral` and `SensorAddon.AddPeripheral` RPC calls to each target sensor host sequentially (reusing the existing HTTP call pattern from `pollSensor()`). Collect results per host. Emit a `"sensor_config_apply_result"` event back to the telemetry script with the results.
- [ ] T022 [US2] Add result publishing to `shelly/telemetry.js` — listen for `"sensor_config_apply_result"` events and publish the result payload to `greenhouse/sensor-config-result` (QoS 1, no retain).
- [ ] T023 [US2] Update `playground/js/sensors.js` — ensure the "Apply" button calls the existing `/api/sensor-config/apply` endpoint (which now routes through MQTT internally). Update any direct RPC fallback paths. Display results from the MQTT-routed response.
- [ ] T024 [US2] Run `npm test` to verify all US2 tests pass

**Checkpoint**: Sensor config apply works end-to-end via MQTT. The controller applies config to sensor hosts on the local network. No direct cloud-to-sensor-host RPC.

---

## Phase 5: User Story 3 — Sensor Discovery as a Local-Only Operation (Priority: P3)

**Goal**: Sensor discovery is performed by the Shelly controller on the local network. The cloud sends a discovery request via MQTT, the controller scans sensor hosts locally, and publishes results back.

**Independent Test**: Trigger sensor discovery from the dashboard. Verify the controller performs the scan locally and reports results via MQTT. No direct cloud-to-sensor-host HTTP calls.

### Tests for User Story 3

- [ ] T025 [P] [US3] Add unit tests for discovery MQTT flow in `tests/mqtt-bridge.test.js` — test `publishDiscoveryRequest(hosts)` publishes to `greenhouse/discover-sensors`, subscribes to `greenhouse/discover-sensors-result`, correlates by ID, and handles timeout.
- [ ] T026 [P] [US3] Add unit tests for the discovery endpoint in `tests/sensor-config.test.js` or a new `tests/sensor-discovery.test.js` — test the server-side `/api/sensor-discovery` handler publishes an MQTT request and returns the correlated response.

### Implementation for User Story 3

- [ ] T027 [US3] Add MQTT publish/subscribe for discovery in `server/lib/mqtt-bridge.js` — add `publishDiscoveryRequest(hosts)` that publishes to `greenhouse/discover-sensors` (QoS 1, no retain) with a correlation ID, subscribes to `greenhouse/discover-sensors-result`, and returns a Promise resolving on match or rejecting on 30s timeout.
- [ ] T028 [US3] Add `/api/sensor-discovery` POST endpoint in `server/server.js` — accepts `{"hosts": ["ip1", "ip2"]}`, calls `mqttBridge.publishDiscoveryRequest(hosts)`, returns results on success or HTTP 504 on timeout.
- [ ] T029 [US3] Add discovery request subscription to `shelly/telemetry.js` — subscribe to `greenhouse/discover-sensors` topic. On message, emit a `"discover_sensors"` inter-script event to the control script with the parsed request payload.
- [ ] T030 [US3] Add discovery handler to `shelly/control.js` — listen for `"discover_sensors"` events. When received, set a `pendingDiscovery` flag with the request data. In the control loop, after sensor polling completes, check the flag. If set, iterate through requested hosts, call `SensorAddon.GetPeripherals` on each (HTTP GET to `http://{host}/rpc/SensorAddon.GetPeripherals`), collect sensor addresses and current temperatures. Emit a `"discover_sensors_result"` event back to the telemetry script with per-host results.
- [ ] T031 [US3] Add discovery result publishing to `shelly/telemetry.js` — listen for `"discover_sensors_result"` events and publish the result payload to `greenhouse/discover-sensors-result` (QoS 1, no retain).
- [ ] T032 [US3] Update `playground/js/sensors.js` — change the discovery trigger to call the new `/api/sensor-discovery` POST endpoint instead of direct RPC via the (now removed) proxy. Display discovered sensors from the MQTT-routed response.
- [ ] T033 [US3] Run `npm test` to verify all US3 tests pass

**Checkpoint**: Sensor discovery works end-to-end via MQTT. Controller scans locally, results return through MQTT to the dashboard.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, documentation, and cleanup across all stories.

- [ ] T034 Run full test suite `npm test` — all unit, simulation, and e2e tests must pass
- [ ] T035 Run Shelly linter `node shelly/lint/bin/shelly-lint.js shelly/control.js shelly/telemetry.js` — verify ES5 compliance of modified Shelly scripts
- [ ] T036 [P] Verify Shelly script sizes are under 16KB limit — check concatenated `control-logic.js + control.js` and `telemetry.js` file sizes
- [ ] T037 [P] Update `CLAUDE.md` — remove references to valve-poller.js, RPC proxy, and Script.Eval polling. Update the server description to reflect MQTT-only communication. Update file relationships section.
- [ ] T038 [P] Update `playground/js/sensors.js` — remove any dead code paths that referenced the old RPC proxy or direct Shelly HTTP calls
- [ ] T039 Verify e2e tests pass: `npm run test:e2e` — confirm sensor config and discovery UI flows work through the new MQTT path
- [ ] T040 Run `npm test` one final time to confirm everything passes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — can start immediately after
- **US2 (Phase 4)**: Depends on Phase 2 — can run in parallel with US1 (different files)
- **US3 (Phase 5)**: Depends on Phase 2 — can run in parallel with US1 and US2 (different files)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Independent. Only requires foundational removals. Server-side only.
- **US2 (P2)**: Independent of US1. Modifies `shelly/telemetry.js`, `shelly/control.js`, `server/lib/sensor-config.js`, `server/lib/mqtt-bridge.js`. Shares Shelly script files with US3.
- **US3 (P3)**: Independent of US1. Shares Shelly script files with US2 — if running in parallel, coordinate edits to `shelly/control.js` and `shelly/telemetry.js`. Otherwise, run US2 before US3.

### Within Each User Story

- Tests before implementation (TDD)
- Server-side MQTT infrastructure before Shelly script changes
- Shelly telemetry subscription before control script handler
- Control script handler before result publishing
- Backend complete before playground UI updates

### Parallel Opportunities

- T010 and T011 (US1 tests) can run in parallel
- T015 and T016 (US2 tests) can run in parallel
- T025 and T026 (US3 tests) can run in parallel
- US1 can run in parallel with US2/US3 (different files)
- T036, T037, T038 (polish) can run in parallel

---

## Parallel Example: User Story 2

```bash
# Launch US2 tests in parallel:
Task: "T015 — sensor-config apply MQTT flow tests in tests/sensor-config.test.js"
Task: "T016 — MQTT request/response correlation tests in tests/mqtt-bridge.test.js"

# Then implement server-side first:
Task: "T017 — MQTT publish/subscribe for sensor-config-apply in server/lib/mqtt-bridge.js"
Task: "T018 — Refactor sensor-config.js to route through MQTT"

# Then Shelly-side (sequential — same files):
Task: "T020 — telemetry.js subscription"
Task: "T021 — control.js handler"
Task: "T022 — telemetry.js result publishing"

# Finally UI:
Task: "T023 — Update playground/js/sensors.js"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (verify baseline)
2. Complete Phase 2: Foundational (remove valve poller + RPC proxy)
3. Complete Phase 3: US1 (verify MQTT-only state monitoring)
4. **STOP and VALIDATE**: Dashboard shows live state via MQTT. No Script.Eval calls exist. Controller operates independently.
5. Deploy to hardware for 24h stability test.

### Incremental Delivery

1. Setup + Foundational → No more direct RPC from cloud
2. US1 → State monitoring verified via MQTT only (MVP)
3. US2 → Sensor config apply routed through controller
4. US3 → Sensor discovery routed through controller
5. Polish → Documentation, final validation, script size checks

### Recommended Execution Order

Single developer: Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US2) → Phase 5 (US3) → Phase 6
This order minimizes Shelly script merge conflicts since US2 and US3 both modify `control.js` and `telemetry.js`.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- Shelly scripts must be ES5-compatible — run the linter after every change
- KVS 256-byte limit applies to any new config stored on the device
- The 5-concurrent-call limit is the core constraint — all new HTTP operations must be serialized
- Commit after each task or logical group
- Stop at any checkpoint to validate independently
