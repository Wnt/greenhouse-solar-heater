# Tasks: Reactive State Core UI Rewrite

**Input**: Design documents from `/specs/021-reactive-state-ui/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included — the spec requires proportional test coverage (Constitution Principle IV) and SC-001 mandates all existing e2e tests pass.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Playground UI**: `playground/js/`, `playground/css/`, `playground/index.html`
- **Tests**: `tests/` (unit), `tests/e2e/` (Playwright)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the reactive store module and app state — the foundation all other work depends on.

- [x] T001 Create reactive state store module implementing createStore(), get(), set(), update(), subscribe(), subscribeAll(), snapshot() per contracts/store.md in `playground/js/store.js`
- [x] T002 Create unit tests for the store module verifying: synchronous notification, no spurious notifications on same-value set, atomic batch update, subscription cleanup, re-entrant set() in `tests/store.test.js`
- [x] T003 Create app state instance with initial state shape (phase, currentView, wsStatus, mqttStatus, lastDataTime, hasReceivedData, wsConnectedAt, running, graphRange, sensorConfig, detectedSensors, sensorScanPending, deviceConfig, baselineHash, serverHash, versionDismissed) and derived getters (scanning, availableViews, connectionDisplay, missingRoles, updateAvailable) per data-model.md in `playground/js/app-state.js`
- [x] T004 Create unit tests for derived state getters verifying: scanning derived from detectedSensors/sensorScanPending, availableViews changes with phase, connectionDisplay state machine, missingRoles from sensorConfig, updateAvailable from hash comparison in `tests/app-state.test.js`
- [x] T005 Add `playground/js/store.js` and `playground/js/app-state.js` to the importmap in `playground/index.html` and import them in the inline script module block (coexist with existing code, no behavior changes yet)

**Checkpoint**: Store infrastructure is in place and tested. No UI changes yet — existing behavior unchanged.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the subscription wiring and action infrastructure that all user story phases depend on.

**CRITICAL**: No user story work can begin until this phase is complete.

- [x] T006 Create global subscriptions module that wires store changes to DOM: nav link visibility (subscribe to `phase` → show/hide nav items), nav link active state (subscribe to `currentView` → toggle active class), view container active state (subscribe to `currentView` → toggle view visibility), and calls view mount/unmount lifecycle on `currentView` change, in `playground/js/subscriptions.js`
- [x] T007 Create navigation action module with initNavigation(store) that binds the hashchange listener and sets initial currentView from URL hash, and navigateTo(store, viewId) that validates against derived availableViews and sets currentView in store, in `playground/js/actions/navigation.js`
- [x] T008 Create connection action module with switchToLive(store), switchToSimulation(store), startStalenessCheck(store), stopStalenessCheck() that update phase, manage LiveSource start/stop, and manage the staleness timer, in `playground/js/actions/connection.js`
- [x] T009 Modify LiveSource in `playground/js/data-source.js` to accept an optional store parameter and write wsStatus, mqttStatus, hasReceivedData, lastDataTime, wsConnectedAt to the store on connection/message events (while keeping existing callback API for backward compatibility during migration)
- [x] T010 Wire the store, subscriptions, and actions into the init() function in `playground/index.html`: replace setupNavigation() with initNavigation(store), replace switchToLive/switchToSimulation with connection actions, replace manual nav visibility toggles with store subscriptions. Remove the old setupNavigation(), switchToLive(), switchToSimulation() functions and their ~120 lines of inline code
- [x] T011 Run the full e2e test suite (`npm run test:e2e`) to verify navigation, mode switching, and view routing work correctly after the migration. Fix any regressions.

**Checkpoint**: Navigation and mode switching are fully store-driven. The refresh bug (US1) and mode-switch redirect (US1) are structurally fixed. Existing e2e tests pass.

---

## Phase 3: User Story 1 — Dashboard Remains Consistent Across Mode Switches (Priority: P1) MVP

**Goal**: Bookmarking any view and refreshing the browser restores the correct view. Mode switches redirect away from unavailable views.

**Independent Test**: Bookmark each view, refresh, verify correct view loads. Switch modes, verify redirect.

### Tests for User Story 1

- [ ] T012 [US1] Write e2e test in `tests/e2e/navigation.spec.js`: verify that navigating to #sensors in live mode, refreshing the page, and waiting for load results in the Sensors view being active (not Status). Verify switching to simulation mode from Sensors redirects to Status. Verify invalid hash falls back to Status. Verify browser back/forward work across mode switches.

### Implementation for User Story 1

- [x] T013 [US1] Verify the derived `availableViews` getter in `playground/js/app-state.js` is used by the navigation subscription in `playground/js/subscriptions.js` — confirm that navigating to a live-only view before phase='live' queues the view and resolves it when phase changes
- [x] T014 [US1] Verify that the `phase` subscription in `playground/js/subscriptions.js` re-evaluates `currentView` against `availableViews` when phase changes, redirecting to 'status' if the current view is no longer available
- [x] T015 [US1] Remove the old `navigateToView()` function and `.live-only` style.display toggle logic from the inline script in `playground/index.html` — confirm all navigation now flows through the store
- [x] T016 [US1] Run `npm run test:e2e` to confirm all existing e2e tests plus new navigation tests pass

**Checkpoint**: User Story 1 is complete. Bookmarked views survive refresh. Mode switches redirect correctly.

---

## Phase 4: User Story 2 — Sensor Scanning Shows Immediate Feedback (Priority: P1)

**Goal**: Scan button shows activity indicator on every scan including initial load. Detected sensors show temperature readings.

**Independent Test**: Navigate to Sensors tab, observe spinner appears immediately, results show temperatures.

### Tests for User Story 2

- [ ] T017 [US2] Write e2e test in `tests/e2e/sensor-config.spec.js` (extend existing file): verify that when the Sensors view mounts, the scan button shows a scanning state before any results arrive. Verify the scan button is disabled during scan and re-enables after.

### Implementation for User Story 2

- [ ] T018 [US2] Create sensor actions module with loadSensorConfig(store), scanSensors(store), saveSensorAssignments(store, assignments), applySensorConfig(store) that write to sensorConfig, detectedSensors, sensorScanPending in the store, per contracts/actions.md, in `playground/js/actions/sensors.js`
- [ ] T019 [US2] Create sensors view component with mount(container, store) and unmount() lifecycle per contracts/views.md in `playground/js/views/sensors-view.js`. Mount subscribes to sensorConfig, detectedSensors, sensorScanPending. Render uses derived `scanning` and `missingRoles` getters. Scan button state and "Scanning..." text are driven by store state. Unmount cleans up subscriptions and auto-refresh timer.
- [ ] T020 [US2] Wire sensors-view mount/unmount into the `currentView` subscription in `playground/js/subscriptions.js` — when currentView changes to 'sensors', call mount(); when leaving sensors, call unmount()
- [ ] T021 [US2] Remove the old `sensors.js` module-level state variables (scanning, sensorConfig, detectedSensors, refreshTimer) and the old initSensorsView()/destroySensorsView() exports from `playground/js/sensors.js`. Replace with re-exports from the new modules or delete the file if fully superseded.
- [ ] T022 [US2] Update `playground/index.html` to import the new sensors view and actions instead of the old sensors.js exports. Remove any inline sensor-related code.
- [ ] T023 [US2] Run `npm run test:e2e` to confirm all sensor config e2e tests pass with the new store-driven implementation

**Checkpoint**: Sensor scanning shows immediate feedback on every scan. Temperature readings appear for unbound sensors. Auto-refresh works via store subscriptions.

---

## Phase 5: User Story 3 — Connection Status Reflects Reality (Priority: P2)

**Goal**: Connection indicator, staleness banner, and overlays are driven by store state and derived connectionDisplay.

**Independent Test**: Simulate WebSocket disconnect/reconnect, verify correct indicators appear.

### Implementation for User Story 3

- [ ] T024 [US3] Create connection overlay subscription in `playground/js/subscriptions.js` that subscribes to wsStatus, mqttStatus, hasReceivedData, lastDataTime and uses derived `connectionDisplay` to update: connection dot class/label, staleness banner visibility, overlay messages on status/gauge/components sections
- [ ] T025 [US3] Remove the old connectionStatus variable, updateConnectionUI(), refreshConnectionIndicator(), updateConnectionOverlays(), checkStaleness(), getConnectionDisplayState() functions (~100 lines) from the inline script in `playground/index.html`
- [ ] T026 [US3] Remove the old stalenessTimer variable and its setInterval/clearInterval management from switchToLive/switchToSimulation in `playground/index.html` — staleness checking is now managed by connection actions
- [ ] T027 [US3] Update the LiveSource data callback in `playground/index.html` to write lastDataTime to the store instead of the old module variable. Verify the liveSource.onUpdate callback still calls updateDisplay() for 60fps rendering (this path stays outside the store).
- [ ] T028 [US3] Run `npm run test:e2e` — verify live-mode.spec.js tests pass with store-driven connection state

**Checkpoint**: Connection status, staleness, and overlays are fully reactive. No manual updateConnectionUI() calls needed.

---

## Phase 6: User Story 4 — Simulation Performance Stays Smooth (Priority: P2)

**Goal**: Verify and enforce that the simulation loop remains outside the reactive store with no performance regression.

**Independent Test**: Run 24h simulation, measure frame rate, compare to baseline.

### Implementation for User Story 4

- [ ] T029 [US4] Migrate the `running` and `graphRange` variables from the inline script to store keys in `playground/js/app-state.js`. Subscribe to `running` in `playground/js/subscriptions.js` to update the FAB icon. Subscribe to `graphRange` to trigger graph redraws.
- [ ] T030 [US4] Update the FAB toggle handler and time range pill handlers in `playground/index.html` to use store.set('running', ...) and store.set('graphRange', ...) instead of direct variable assignment
- [ ] T031 [US4] Verify simLoop() in `playground/index.html` reads `store.get('running')` to check play state but continues to call updateDisplay() and model.step() directly (not through the store). Ensure no store.set() calls occur inside the RAF loop.
- [ ] T032 [US4] Run the screenshot generation test (`npm run screenshots`) to verify the 24h simulation completes without timeout regression. Run `npm run test:e2e` for the thermal-sim spec.

**Checkpoint**: Simulation performance is equivalent to pre-rewrite baseline. No store overhead in the hot path.

---

## Phase 7: User Story 5 — Device Configuration Round-Trips (Priority: P3)

**Goal**: Device config form reads from store, saves via action, no DOM-as-state.

**Independent Test**: Save config, refresh, verify form matches saved values.

### Implementation for User Story 5

- [ ] T033 [US5] Create device config actions with loadDeviceConfig(store) and saveDeviceConfig(store, config) that read/write deviceConfig in the store, per contracts/actions.md, in `playground/js/actions/device-config.js`
- [ ] T034 [US5] Create device config view component with mount(container, store)/unmount() lifecycle in `playground/js/views/device-view.js`. Mount subscribes to deviceConfig, renders form from store state, binds save handler that collects form inputs and calls saveDeviceConfig action. Shows loading state while deviceConfig is null.
- [ ] T035 [US5] Wire device-view mount/unmount into the `currentView` subscription in `playground/js/subscriptions.js`
- [ ] T036 [US5] Remove the old deviceConfigData variable, loadDeviceConfig(), populateDeviceForm(), collectDeviceConfig(), saveDeviceConfig() functions (~200 lines) from the inline script in `playground/index.html`
- [ ] T037 [US5] Run `npm run test:e2e` — verify device-config.spec.js tests pass with the new store-driven implementation

**Checkpoint**: Device config is fully store-driven. No DOM-as-state reads.

---

## Phase 8: User Story 6 — Version Update Notification (Priority: P3)

**Goal**: Version check uses store keys instead of module-level variables.

**Independent Test**: Change server hash, verify toast appears. Dismiss, verify stays dismissed.

### Implementation for User Story 6

- [ ] T038 [US6] Create version check action module with startVersionCheck(store) and dismissVersionUpdate(store) that poll /version endpoint, write baselineHash/serverHash/versionDismissed to store, in `playground/js/actions/version-check.js`
- [ ] T039 [US6] Create version toast subscription in `playground/js/subscriptions.js` that subscribes to derived `updateAvailable` and shows/hides the update toast DOM element
- [ ] T040 [US6] Remove the old version-check.js module (`playground/js/version-check.js`) — its state and logic are now in the action and subscription modules. Update imports in `playground/index.html`.
- [ ] T041 [US6] Run `npm run test:e2e` — verify version-check.spec.js tests pass

**Checkpoint**: Version notification is store-driven. Module-level state eliminated.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Final cleanup, code reduction, and validation.

- [ ] T042 Audit the inline script in `playground/index.html` and remove all variables, functions, and event bindings that have been migrated to the store, actions, subscriptions, or views. Target: reduce inline script from ~1139 lines to ~300 lines (simLoop, updateDisplay, model/controller setup, graph drawing, slider setup, schematic building).
- [ ] T043 Remove the old `playground/js/sensors.js` file if it has been fully superseded by `playground/js/actions/sensors.js` and `playground/js/views/sensors-view.js`. Update all imports.
- [ ] T044 [P] Run the Shelly linter (`node shelly/lint/bin/shelly-lint.js shelly/control.js`) to confirm no Shelly files were accidentally modified
- [ ] T045 [P] Run the full test suite (`npm test`) — all unit, simulation, and e2e tests must pass
- [ ] T046 Count remaining mutable state variables outside the store across all playground JS modules. Verify the count is reduced by at least 50% compared to the pre-rewrite baseline of ~30 variables (SC-006).
- [ ] T047 Update CLAUDE.md: document the new module structure (store.js, app-state.js, subscriptions.js, actions/, views/), the reactive state pattern, and the simulation performance boundary. Update the Playground Architecture section.

**Checkpoint**: All tests pass. Inline script is significantly reduced. CLAUDE.md is current.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (store and app-state must exist)
- **User Stories (Phase 3-8)**: All depend on Phase 2 (subscriptions and actions infrastructure must exist)
  - US1 (Phase 3) and US2 (Phase 4) can proceed in parallel after Phase 2
  - US3 (Phase 5) can proceed in parallel with US1/US2 after Phase 2
  - US4 (Phase 6) depends on Phase 2 only
  - US5 (Phase 7) depends on Phase 2 only
  - US6 (Phase 8) depends on Phase 2 only
- **Polish (Phase 9)**: Depends on all user story phases being complete

### User Story Dependencies

- **US1 (Navigation)**: Independent — uses only store + subscriptions from Phase 2
- **US2 (Sensors)**: Independent — creates new action/view modules
- **US3 (Connection)**: Independent — subscribes to store keys set by LiveSource (Phase 2)
- **US4 (Simulation)**: Independent — migrates two simple variables to store
- **US5 (Device Config)**: Independent — creates new action/view modules
- **US6 (Version Check)**: Independent — replaces standalone module with action + subscription

### Within Each User Story

- Actions/modules before view components (views import actions)
- View wiring in subscriptions.js after view module exists
- Old code removal after new code is verified working
- E2e test run at end of each story to catch regressions

### Parallel Opportunities

- T001 and T002 can run in parallel (store module + its tests)
- T003 and T004 can run in parallel (app-state + its tests)
- T006, T007, T008 can run in parallel (subscriptions, nav actions, connection actions — different files)
- All user story phases (3-8) can run in parallel after Phase 2 (different files, independent modules)
- T044 and T045 can run in parallel (linter + test suite)

---

## Parallel Example: Phase 2 (Foundational)

```bash
# These three create different files and can run in parallel:
Task: "T006 — Create global subscriptions module in playground/js/subscriptions.js"
Task: "T007 — Create navigation action module in playground/js/actions/navigation.js"
Task: "T008 — Create connection action module in playground/js/actions/connection.js"

# Then sequentially:
Task: "T009 — Modify LiveSource in playground/js/data-source.js"
Task: "T010 — Wire store into init() in playground/index.html"
Task: "T011 — Run e2e tests"
```

## Parallel Example: User Stories After Phase 2

```bash
# These user stories create entirely different files and can run in parallel:
Task: "US2 — Sensor actions + view (playground/js/actions/sensors.js, playground/js/views/sensors-view.js)"
Task: "US5 — Device actions + view (playground/js/actions/device-config.js, playground/js/views/device-view.js)"
Task: "US6 — Version check action (playground/js/actions/version-check.js)"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Store infrastructure + tests
2. Complete Phase 2: Subscriptions, navigation, connection actions
3. Complete Phase 3: User Story 1 (navigation consistency)
4. **STOP and VALIDATE**: Bookmark #sensors, refresh, verify it loads. Switch modes, verify redirect.
5. Deploy — the core architectural problem is solved

### Incremental Delivery

1. Phase 1 + 2 → Foundation ready (store exists, navigation is reactive)
2. Add US1 → Navigation works correctly (MVP!)
3. Add US2 → Sensor scanning shows feedback
4. Add US3 → Connection status is reactive
5. Add US4 → Simulation verified (performance gate)
6. Add US5 → Device config is store-driven
7. Add US6 → Version check is store-driven
8. Phase 9 → Cleanup, validation, documentation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story is independently completable and testable
- The simulation hot path (simLoop/updateDisplay) NEVER goes through the store — this is the critical performance boundary (research.md R5)
- Existing e2e tests are the primary regression safety net — run after every phase
- Target: reduce inline script from ~1139 lines to ~300 lines by Phase 9
