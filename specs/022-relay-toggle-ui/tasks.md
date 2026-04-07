# Tasks: Manual Relay Toggle UI

**Input**: Design documents from `/specs/022-relay-toggle-ui/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/websocket-commands.md

**Tests**: Included — the spec requires proportional test coverage per Constitution Principle IV.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3, US4)
- Include exact file paths in descriptions

---

## Phase 1: Setup (No Code Changes)

**Purpose**: Verify existing infrastructure and understand current state

- [x] T001 Verify device config JSON size budget — compute current max config size and confirm `mo` field fits within Shelly KVS 256-byte limit by adding `{"mo":{"a":true,"ex":1712505600,"ss":false}}` to a maxed-out config sample
- [x] T002 Run existing test suite (`npm test`) to confirm green baseline before making changes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure changes that ALL user stories depend on — device config extension, MQTT relay command topic, WebSocket bidirectional messaging, and Shelly device-side command handling.

**CRITICAL**: No user story work can begin until this phase is complete.

### Device Config Extension

- [x] T003 Extend `server/lib/device-config.js` — add `mo` field support to `updateConfig()`: validate `mo` object structure (`{a: boolean, ex: integer, ss: boolean}`), allow `mo: null` to clear override, preserve `mo` through config version increments
- [x] T004 Add unit tests for `mo` field in `tests/device-config.test.js` — test: `mo` field accepted and persisted, `mo: null` clears override, invalid `mo` rejected, `mo` preserved through unrelated config updates, config with `mo` fits within 256 bytes

### MQTT Relay Command Topic

- [x] T005 [P] Add `publishRelayCommand(relay, on)` to `server/lib/mqtt-bridge.js` — publish to `greenhouse/relay-command` topic with `{relay, on}` payload, QoS 1, retain false
- [~] T006 [P] Add unit tests for relay command publishing in `tests/mqtt-bridge.test.js` — test: correct topic, payload format, QoS/retain flags, rejection when MQTT disconnected
- [x] T007 [P] Extend state broadcast in `server/lib/mqtt-bridge.js` — include `manual_override` field (derived from device config `mo`) in the state object sent to WebSocket clients: `{active: boolean, expiresAt: number, suppressSafety: boolean}` or `null`

### WebSocket Command Handler

- [x] T008 Add WebSocket message handler in `server/server.js` — on `ws.on('message')`: parse JSON, validate `type` field, dispatch to handler functions for `override-enter`, `override-exit`, `override-update`, and `relay-command` per contracts/websocket-commands.md
- [x] T009 Implement `override-enter` handler in `server/server.js` — validate `ce=true` in current device config, compute `ex = Math.floor(Date.now()/1000) + ttl`, update device config with `mo: {a: true, ex, ss}`, publish config to MQTT, send `override-ack` response. Validate TTL range 60–3600, default 300.
- [x] T010 Implement `override-exit` handler in `server/server.js` — update device config with `mo: null`, publish config to MQTT, send `override-ack` response with `active: false`
- [x] T011 Implement `relay-command` handler in `server/server.js` — validate override is active (check `mo.a` and `mo.ex > now`), validate relay identifier is one of the 10 recognized names, call `mqttBridge.publishRelayCommand(relay, on)`

### Shelly Device: Relay Command Subscription

- [x] T012 [P] Add MQTT subscription for `greenhouse/relay-command` in `shelly/telemetry.js` — parse JSON message, validate `relay` and `on` fields, emit `Shelly.emitEvent("relay_command", {relay: relay, on: on})`. Follow existing pattern from `SENSOR_CONFIG_APPLY_TOPIC` subscription.
- [x] T013 Add relay command event handler in `shelly/control.js` — listen for `relay_command` event, validate `deviceConfig.mo && deviceConfig.mo.a` (override active), validate current time < `deviceConfig.mo.ex` (not expired), dispatch to `setPump(on)`, `setFan(on)`, or `setValve(name, open, cb)` based on relay identifier, call `emitStateUpdate()` after actuation

### Shelly Device: Manual Override Guard in Control Loop

- [x] T014 Add manual override guard at top of `controlLoop()` in `shelly/control.js` — before calling `evaluate()`, check if `deviceConfig.mo && deviceConfig.mo.a`. If active and not expired (`Shelly.getComponentStatus("sys").unixtime < deviceConfig.mo.ex`): skip `evaluate()`, only call `emitStateUpdate()` and `processPendingCommands()`, then return. If `mo.ss === false` (safety not suppressed): still run `evaluate()` but only act on the result if `result.safetyOverride === true` (freeze/overheat protection). If expired: clear `deviceConfig.mo`, save to KVS via `Shelly.call("KVS.Set", ...)`, resume normal `evaluate()` cycle, emit state update.

### Client: WebSocket Send Capability

- [x] T015 [P] Add `sendCommand(command)` method to `LiveSource` class in `playground/js/data-source.js` — send JSON-stringified command over WebSocket if connected (`ws.readyState === WebSocket.OPEN`), return boolean indicating if send succeeded. Add `onCommandResponse` callback registration for receiving `override-ack` and `override-error` responses in `ws.onmessage` handler.

### Foundational Tests

- [x] T016 Add unit tests for manual override guard logic in `tests/control-logic.test.js` — test: control loop skips evaluate() when `mo` active, control loop resumes evaluate() when `mo` expired, safety override still triggers when `mo.ss=false`, safety override suppressed when `mo.ss=true`, `ce=false` overrides `mo` (controls disabled takes precedence)
- [x] T017 Run full test suite (`npm test`) to verify all foundational changes pass with existing tests

**Checkpoint**: Foundation ready — WebSocket commands flow from browser → server → MQTT → Shelly device, relay commands are processed, control loop respects manual override. User story implementation can now begin.

---

## Phase 3: User Story 1 — Enter Manual Override and Toggle Individual Relays (Priority: P1)

**Goal**: Operator can enter manual override from Device view and toggle any of the 10 relays via a soundboard-style grid.

**Independent Test**: Enter manual override, tap relay buttons, verify hardware actuates. Verify override button disabled when `ce=false`.

### Implementation for User Story 1

- [x] T018 [US1] Add relay toggle board HTML to Device view in `playground/index.html` — create a new section below the existing device config form (`#device-config-card`). Include: "Enter Manual Override" button (disabled when `ce=false`, with explanation text), "Suppress Safety Overrides" toggle (defaults OFF), countdown timer display, and a CSS grid of 10 toggle buttons — one per actuator with human-readable label + technical ID: Pump (`pump`), Fan (`fan`), Tank Bottom In (`vi_btm`), Reservoir In (`vi_top`), Collector In (`vi_coll`), To Collector (`vo_coll`), To Radiator (`vo_rad`), To Tank (`vo_tank`), Return (`v_ret`), Air Intake (`v_air`). Board hidden/inactive until override entered.
- [x] T019 [US1] Add soundboard grid CSS in `playground/css/style.css` — grid layout: 2 columns on mobile (<768px), 5 columns on desktop. Button styles: min 64x64px touch targets, Stitch theme colors (gold `#e9c349` for ON, muted dark `#1a1c22` for OFF, teal `#43aea4` for override controls). State transitions with CSS transitions. Disabled state styling for when override not active or `ce=false`.
- [x] T020 [US1] Implement override entry logic in `playground/index.html` — on "Enter Manual Override" click: read suppress-safety toggle state, call `liveSource.sendCommand({type: 'override-enter', ttl: 300, suppressSafety: bool})`, on `override-ack` response: show toggle board, start countdown display, enable relay buttons. On `override-error`: show inline error text (e.g., "Controls not enabled").
- [x] T021 [US1] Implement relay toggle button handlers in `playground/index.html` — on relay button click: read current state from button, send `{type: 'relay-command', relay: id, on: !currentState}` via `liveSource.sendCommand()`, update button visual state immediately (optimistic). On next state broadcast from server: reconcile button state with actual hardware state.
- [x] T022 [US1] Wire state broadcasts to toggle board in `playground/index.html` — in the existing state update callback: if `manual_override` field present in state data, update all relay button states from `data.valves` and `data.actuators`. If `manual_override` is null but board was active, deactivate board (override ended externally). Update `ce` gate — disable override button if `controls_enabled` is false.
- [~] T023 [US1] Add e2e test for manual override entry in `tests/e2e/device-config.spec.js` — test: override button visible in Device view, disabled when ce=false, clicking enters override mode (mock WebSocket), toggle board appears with 10 buttons, buttons show correct labels
- [~] T024 [US1] Add e2e test for relay toggling in `tests/e2e/device-config.spec.js` — test: clicking a relay button sends correct WebSocket command, button visual state updates on click (optimistic), button state reconciles with mock server state broadcast

**Checkpoint**: User Story 1 complete. Operator can enter manual override and toggle individual relays. Override button gated by `ce=true`.

---

## Phase 4: User Story 2 — Auto-Revert to Automation After TTL Expires (Priority: P2)

**Goal**: Override automatically expires after configurable TTL, reverting to automation. TTL enforced on device (works offline). User can adjust TTL during override.

**Independent Test**: Enter override, wait for TTL expiry (or use short TTL), verify automation resumes and board deactivates.

### Implementation for User Story 2

- [x] T025 [US2] Implement countdown timer display in `playground/index.html` — show remaining time (mm:ss) in the override section header, update every second using `setInterval`. Compute remaining from `manual_override.expiresAt - Date.now()/1000`. When reaches 0, show "Override expired" message and deactivate toggle board.
- [x] T026 [US2] Add TTL adjustment control in `playground/index.html` — add a TTL selector (preset buttons: 1min, 5min, 15min, 30min, 1hr) visible during active override. On selection: send `{type: 'override-update', ttl: seconds}` via WebSocket. On `override-ack` response: restart countdown with new expiry.
- [x] T027 [US2] Implement `override-update` handler in `server/server.js` — validate override is active, compute new `ex`, update device config `mo.ex`, publish config to MQTT, send `override-ack` with new expiry
- [x] T028 [US2] Add device-side TTL expiry unit test in `tests/control-logic.test.js` — test: when `mo.ex` is in the past, control loop clears `mo` and resumes `evaluate()`. Test: when `mo.ex` is in the future, control loop skips `evaluate()`. Test with mock `Shelly.getComponentStatus("sys").unixtime`.
- [~] T029 [US2] Add e2e test for TTL countdown and expiry in `tests/e2e/device-config.spec.js` — test: countdown timer visible during override, TTL adjustment buttons visible, selecting new TTL sends correct WebSocket command, board deactivates when override state changes to inactive (mock state broadcast with `manual_override: null`)

**Checkpoint**: User Story 2 complete. Override auto-reverts on device side, countdown visible, TTL adjustable.

---

## Phase 5: User Story 3 — Tactile Feedback on Relay Toggle (Priority: P3)

**Goal**: Relay button taps produce immediate optimistic visual feedback, haptic vibration on mobile, and graceful error indication on failure.

**Independent Test**: Tap relay buttons on mobile — feel vibration and see instant color change. On desktop — see instant color change, no errors. Simulate failure — see shake animation.

### Implementation for User Story 3

- [x] T030 [P] [US3] Add Vibration API integration to relay button handler in `playground/index.html` — on relay button tap: call `navigator.vibrate(50)` (50ms pulse) if `navigator.vibrate` exists, wrapped in try/catch for graceful degradation. Trigger vibration BEFORE sending WebSocket command for instant feedback.
- [x] T031 [P] [US3] Add CSS shake animation and error flash in `playground/css/style.css` — define `@keyframes relay-shake` (horizontal shake, ~300ms), `.relay-btn--error` class (brief red flash `#ef5350` then revert). Define `.relay-btn--pending` class for optimistic state (slightly dimmed to indicate unconfirmed).
- [x] T032 [US3] Implement failure reconciliation in relay button handler in `playground/index.html` — after optimistic state update, set a 2-second reconciliation timeout. If the next state broadcast confirms the expected state, clear timeout. If state broadcast shows different state (command failed), revert button to actual state and apply shake animation class + error flash. Remove animation class after animation completes.
- [~] T033 [US3] Add e2e test for tactile feedback in `tests/e2e/device-config.spec.js` — test: button gets optimistic state class on click, button gets error/shake class when mock state broadcast contradicts optimistic state, shake animation class removed after animation duration

**Checkpoint**: User Story 3 complete. Relay toggles feel tactile with vibration, instant visual feedback, and graceful error indication.

---

## Phase 6: User Story 4 — Exit Manual Override Voluntarily (Priority: P3)

**Goal**: Operator can exit manual override at any time, returning to automation immediately.

**Independent Test**: Enter override, toggle some relays, exit override, verify automation resumes.

### Implementation for User Story 4

- [x] T034 [US4] Add "Exit Manual Override" button to override section in `playground/index.html` — visible only during active override, positioned prominently. On click: send `{type: 'override-exit'}` via WebSocket. On `override-ack` with `active: false`: deactivate toggle board, clear countdown, show brief "Returning to automation" message.
- [~] T035 [US4] Add e2e test for voluntary exit in `tests/e2e/device-config.spec.js` — test: exit button visible during override, clicking sends correct WebSocket command, board deactivates on override-ack response

**Checkpoint**: All user stories complete. Full manual override lifecycle works: enter → toggle → adjust TTL → exit (or auto-expire).

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, integration testing, documentation

- [x] T036 Handle WebSocket reconnection during active override in `playground/index.html` — on LiveSource reconnect: check if `manual_override` is present in first state broadcast, if so restore toggle board state and countdown from server state. If absent, deactivate board.
- [x] T037 Handle `ce=false` during active override in `playground/index.html` — on state broadcast with `controls_enabled: false`: immediately deactivate toggle board, clear countdown, show "Controls disabled — override ended" message
- [x] T038 [P] Lint Shelly scripts — run `node shelly/lint/bin/shelly-lint.js shelly/control.js shelly/telemetry.js` to verify ES5 compliance of all device script changes
- [x] T039 [P] Verify device config size budget — after all changes, compute maximum possible config JSON size with `mo` field and confirm ≤ 256 bytes
- [x] T040 Run full test suite (`npm test`) to verify all changes pass together
- [x] T041 Update `CLAUDE.md` — add relay toggle UI to playground architecture section, document new MQTT topic `greenhouse/relay-command`, document WebSocket command protocol, note `mo` field in device config

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup — BLOCKS all user stories
- **User Stories (Phase 3–6)**: All depend on Foundational phase completion
  - US1 (Phase 3): No dependencies on other stories
  - US2 (Phase 4): No dependencies on other stories (but naturally builds on US1 UI)
  - US3 (Phase 5): No dependencies on other stories (enhances US1 buttons)
  - US4 (Phase 6): No dependencies on other stories (adds exit to US1 flow)
- **Polish (Phase 7)**: Depends on all user stories being complete

### Within Each User Story

- Implementation tasks are sequential within a story (UI → logic → tests)
- Tasks marked [P] can run in parallel with other [P] tasks in the same phase

### Parallel Opportunities

**Phase 2 (Foundational)**:
- T005, T006, T007 (MQTT bridge changes) can run in parallel
- T012 (telemetry.js) and T015 (data-source.js) can run in parallel with each other and with server changes

**Phase 5 (US3)**:
- T030 (vibration) and T031 (CSS animations) can run in parallel

---

## Parallel Example: Phase 2 Foundational

```bash
# Batch 1: Independent file changes
Task T005: "Add publishRelayCommand() to server/lib/mqtt-bridge.js"
Task T006: "Add relay command unit tests to tests/mqtt-bridge.test.js"
Task T007: "Extend state broadcast in server/lib/mqtt-bridge.js"
Task T012: "Add relay-command MQTT subscription to shelly/telemetry.js"
Task T015: "Add sendCommand() to LiveSource in playground/js/data-source.js"

# Batch 2: Depends on mqtt-bridge changes
Task T008: "Add WebSocket message handler in server/server.js"
Task T013: "Add relay command event handler in shelly/control.js"
Task T014: "Add manual override guard in shelly/control.js"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (verify baseline)
2. Complete Phase 2: Foundational (config + MQTT + WebSocket + device-side)
3. Complete Phase 3: User Story 1 (toggle board UI + entry + relay toggling)
4. **STOP and VALIDATE**: Test override entry and relay toggling end-to-end
5. Deploy — operators can already use manual override for commissioning

### Incremental Delivery

1. Setup + Foundational → Infrastructure ready
2. Add User Story 1 → Test independently → Deploy (MVP!)
3. Add User Story 2 → TTL countdown + adjustment → Deploy
4. Add User Story 3 → Haptic + visual polish → Deploy
5. Add User Story 4 → Voluntary exit → Deploy
6. Polish → Edge cases, docs → Deploy

### Single Developer Strategy

Work sequentially in priority order (P1 → P2 → P3). Each phase delivers a working increment. US3 and US4 are low-risk additions to the existing US1 UI.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Shelly scripts MUST be ES5-only — run linter (T038) after all device changes
- Device config with `mo` field MUST fit in 256 bytes — verify (T039) after all changes
- Constitution Principle III (Safe by Default): all safe defaults are established in T009 (server) and T014 (device)
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
