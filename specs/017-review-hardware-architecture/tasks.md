# Tasks: Review Hardware Architecture

**Input**: Design documents from `/specs/017-review-hardware-architecture/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/safety-override-contract.md

**Tests**: Included for safety override code changes (US2) per Constitution Principle IV (Proportional Test Coverage) and spec FR-011/FR-012.

**Organization**: Tasks grouped by user story. US2 (safety override fix) is the primary code deliverable; other stories are documentation deliverables.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: No project initialization needed — all files exist. This phase creates the new documentation files.

- [x] T001 Create findings document skeleton with Critical/Warning/Informational sections in design/docs/findings-017.md
- [x] T002 [P] Create commissioning guide skeleton with Stage 1 and Progressive Enablement sections in design/docs/commissioning-guide.md

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Fix the sensor IP mismatch (C-002) and document Pro 2PM IPs — these block commissioning and consistency verification.

**⚠️ CRITICAL**: IP alignment must be done before safety override testing can be validated on hardware.

- [x] T003 Align sensor hub IP address: update SENSOR_IP in shelly/control.js:24 to match shelly/devices.conf SENSOR value (or vice versa — confirm correct DHCP reservation with user). Reference finding C-002 in research.md.
- [x] T004 [P] Add all Pro 2PM unit IPs (192.168.1.11, .12, .13, .14) as documented entries in shelly/devices.conf. Reference finding W-003.

**Checkpoint**: IP addresses are consistent across all files.

---

## Phase 3: User Story 1 - Validate Hardware-Software Consistency (Priority: P1) 🎯 MVP

**Goal**: Produce the consistency verification sections of the findings document, confirming all valve/sensor/actuator mappings match between system.yaml and code.

**Independent Test**: Read findings-017.md and verify every valve name, sensor name, actuator assignment, and safety rule is cross-referenced with specific file paths and line numbers.

### Implementation for User Story 1

- [x] T005 [US1] Write Informational findings I-001 through I-004 (valve names, actuator assignments, Pro 2PM mappings, sensor mappings) with cross-reference evidence in design/docs/findings-017.md
- [x] T006 [US1] Write Informational findings I-005 through I-007 (flow path validation, safety rule enforcement, deploy script verification) with evidence in design/docs/findings-017.md
- [x] T007 [US1] Write Critical finding C-002 (sensor IP mismatch) and Warning finding W-003 (Pro 2PM IPs) with remediation status in design/docs/findings-017.md

**Checkpoint**: Findings document covers FR-001 through FR-009 (consistency verification). All 11 Informational + C-002 + W-003 documented.

---

## Phase 4: User Story 2 - Hard Safety Overrides (Priority: P1)

**Goal**: Fix the safety override suppression bug (C-001) so freeze/overheat drain cannot be suppressed by device config. Add tests per the safety override contract.

**Independent Test**: Run `npm run test:unit` — all new safety override tests pass. Verify that `evaluate()` returns `suppressed: false` and `safetyOverride: true` for freeze/overheat drain regardless of device config.

### Tests for User Story 2

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T008 [P] [US2] Add test: freeze drain with ce=false returns ACTIVE_DRAIN, suppressed=false, safetyOverride=true in tests/control-logic.test.js
- [x] T009 [P] [US2] Add test: freeze drain with am=["SC"] (excluding AD) still returns ACTIVE_DRAIN in tests/control-logic.test.js
- [x] T010 [P] [US2] Add test: overheat drain with ce=false returns ACTIVE_DRAIN, suppressed=false, safetyOverride=true in tests/control-logic.test.js
- [x] T011 [P] [US2] Add test: overheat drain with am=["I"] (excluding AD) still returns ACTIVE_DRAIN in tests/control-logic.test.js
- [x] T012 [P] [US2] Add test: sensor staleness with ce=false returns IDLE, suppressed=true (safe state, no actuation needed) in tests/control-logic.test.js
- [x] T013 [P] [US2] Add test: normal solar charging with ce=false returns SOLAR_CHARGING, suppressed=true (non-safety modes still suppressed) in tests/control-logic.test.js
- [x] T014 [P] [US2] Add test: freeze drain with ce=true returns ACTIVE_DRAIN, suppressed=false, safetyOverride=true (safety flag set even when controls enabled) in tests/control-logic.test.js

### Implementation for User Story 2

- [x] T015 [US2] Modify makeResult() in shelly/control-logic.js to accept a safetyOverride parameter. When safetyOverride=true: set result.safetyOverride=true, do NOT set suppressed=true, do NOT apply ea/valve bitmask suppression. Per contract in specs/017-review-hardware-architecture/contracts/safety-override-contract.md
- [x] T016 [US2] Update freeze drain call at shelly/control-logic.js:198 to pass safetyOverride=true to makeResult(). Update overheat drain call at line 204 similarly.
- [x] T017 [US2] Ensure sensor staleness path at shelly/control-logic.js:183 does NOT pass safetyOverride (IDLE is safe — suppression OK). Verify emergency heating is cleared.
- [x] T018 [US2] Export safetyOverride-related constants/flags in the module.exports block at shelly/control-logic.js:354-372 so tests can assert on them.
- [x] T019 [US2] Update controlLoop() in shelly/control.js:348-354 to check result.safetyOverride: if true, always call transitionTo(result) even when result.suppressed is true. Per contract shell script behavior.
- [x] T020 [US2] Add actuator state tracking: add state.fan_on, state.space_heater_on, state.immersion_heater_on variables to shelly/control.js state object. Update setFan(), setSpaceHeater(), setImmersion() to track state. Update buildStateSnapshot() at lines 215-220 to use tracked values instead of hardcoded false. Reference finding W-001.
- [x] T021 [US2] Run Shelly linter: `node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js` — ensure all changes are ES5-compliant.
- [x] T022 [US2] Run unit tests: `npm run test:unit` — verify all 7 new tests pass plus all existing tests still pass.
- [x] T023 [US2] Write Critical finding C-001 (safety override suppression) with before/after code references and remediation status "Fixed" in design/docs/findings-017.md

**Checkpoint**: Safety overrides are unsuppressible. All tests pass. FR-011, FR-012, FR-013 satisfied.

---

## Phase 5: User Story 3 - Staged Commissioning Plan (Priority: P1)

**Goal**: Produce a commissioning guide that documents how to progressively enable modes as hardware is installed, starting with solar collector loop + 3 sensors.

**Independent Test**: Read commissioning guide and verify it covers: sensor identity verification, Stage 1 config, manual freeze test procedure, progressive enablement steps.

### Implementation for User Story 3

- [x] T024 [US3] Write sensor identity verification procedure in design/docs/commissioning-guide.md: deploy with ce=false, read sensors in playground UI, warm/cool each sensor to confirm identity, document wire-to-sensor mapping.
- [x] T025 [US3] Write Stage 1 configuration section in design/docs/commissioning-guide.md: device config JSON (`ce: true, ea: 3, am: ["SC"]`), expected behavior (solar charging + automatic freeze/overheat drain), manual freeze test via fm="AD".
- [x] T026 [US3] Write Progressive Enablement section in design/docs/commissioning-guide.md: add greenhouse heating (sensors + am + ea), add emergency heating (sensors + am + ea), full system (am: null). Per plan.md Staged Commissioning Plan.
- [x] T027 [US3] Write Warning finding W-004 (missing safety override tests — now fixed) and Warning finding W-002 (V_air inverted logic undocumented) in design/docs/findings-017.md

**Checkpoint**: Commissioning guide complete. FR-013, FR-014, SC-007, SC-008 satisfied.

---

## Phase 6: User Story 4 - Verify Electrical and Communication Architecture (Priority: P2)

**Goal**: Document the electrical topology verification and communication reliability assessment in the findings document.

**Independent Test**: Read findings document and verify every actuator-to-relay mapping is documented, and communication failure behavior is assessed.

### Implementation for User Story 4

- [x] T028 [US4] Write Informational findings I-008 through I-011 (V_air fail-safe design, reservoir overflow risk, air vent rationale, am mechanism) in design/docs/findings-017.md
- [x] T029 [US4] Write communication reliability assessment: HTTP RPC retry logic in control.js setValve(), safe fallback on failure (pump stop + IDLE), sensor hub WiFi vs Ethernet reliability considerations. Add to design/docs/findings-017.md

**Checkpoint**: All findings documented. FR-005, FR-008 satisfied. SC-004 verified.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates, V_air comment, final validation.

- [x] T030 [P] Add explanatory comment for V_air inverted relay logic at shelly/control.js:85 explaining the normally-open actuator wiring and fail-safe rationale.
- [x] T031 [P] Add V_air physical wiring note to system.yaml valves.collector_top.v_air section: document that the physical actuator is normally-open (de-energized=open) for fail-safe drain on power loss, and that control.js inverts the relay command.
- [x] T032 Run full test suite: `npm test` — verify all tests pass (unit + simulation + e2e).
- [x] T033 Validate findings-017.md completeness: confirm all 2 Critical, 4 Warning, 11 Informational findings are documented with severity, file references, and remediation status.
- [x] T034 Update CLAUDE.md if any project structure, file relationships, or conventions changed.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (needs findings doc skeleton)
- **US1 (Phase 3)**: Depends on Phase 2 (IP alignment informs findings)
- **US2 (Phase 4)**: Depends on Phase 2 (IP alignment); independent of US1
- **US3 (Phase 5)**: Depends on US2 completion (commissioning guide assumes safety fix is deployed)
- **US4 (Phase 6)**: Depends on Phase 2; independent of US1/US2/US3
- **Polish (Phase 7)**: Depends on all user stories complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2. No code changes — documentation only.
- **US2 (P1)**: Can start after Phase 2. Primary code deliverable. Tests first, then implementation.
- **US3 (P1)**: Depends on US2 (commissioning guide references safety override fix). Documentation only.
- **US4 (P2)**: Can start after Phase 2 — independent of other stories. Documentation only.

### Within User Story 2 (Code Changes)

1. Tests T008-T014 MUST be written and FAIL before implementation
2. Pure logic change (T015-T018) before shell script change (T019-T020)
3. Lint check (T021) before test run (T022)
4. Findings documentation (T023) after code is verified

### Parallel Opportunities

- T001 + T002: Setup tasks can run in parallel
- T003 + T004: Foundational tasks can run in parallel
- T005 + T006 + T007: US1 findings sections can run in parallel
- T008 through T014: All US2 test tasks can run in parallel (different test cases, same file)
- T024 + T025 + T026: US3 commissioning guide sections can run in parallel
- T028 + T029: US4 findings sections can run in parallel
- T030 + T031: Polish documentation tasks can run in parallel
- US1 (Phase 3) and US4 (Phase 6) can run in parallel (different findings sections)

---

## Parallel Example: User Story 2 Tests

```bash
# Launch all 7 safety override test tasks together (all [P]):
Task T008: "freeze drain ce=false test"
Task T009: "freeze drain am filter bypass test"
Task T010: "overheat drain ce=false test"
Task T011: "overheat drain am filter bypass test"
Task T012: "sensor staleness ce=false test"
Task T013: "solar charging ce=false still suppressed test"
Task T014: "freeze drain ce=true safetyOverride flag test"
```

---

## Implementation Strategy

### MVP First (User Story 2 — Safety Override Fix)

1. Complete Phase 1: Setup (create doc skeletons)
2. Complete Phase 2: Foundational (fix IP, add Pro 2PM IPs)
3. Complete Phase 4: US2 (safety override fix + tests)
4. **STOP and VALIDATE**: `npm run test:unit` passes, `shelly-lint` passes
5. This is the minimum viable safety fix — deployable immediately

### Incremental Delivery

1. Setup + Foundational → IP addresses aligned
2. US2 (safety override fix) → Deploy to hardware → **Critical safety issue resolved**
3. US1 (consistency findings) → Findings document started
4. US3 (commissioning guide) → Operator can follow staged rollout
5. US4 (electrical verification) → Findings document complete
6. Polish → V_air documentation, final validation

### Single Developer Strategy

Execute in priority order: Phase 1 → Phase 2 → Phase 4 (US2, code) → Phase 3 (US1, docs) → Phase 5 (US3, docs) → Phase 6 (US4, docs) → Phase 7 (polish).

---

## Notes

- [P] tasks = different files or different sections, no dependencies
- US2 is the only story with code changes; US1/US3/US4 are documentation
- All Shelly code must be ES5-compliant — run linter after every change
- The `safetyOverride` flag is a new field on the evaluate() result — keep it minimal (boolean)
- Sensor IP mismatch (T003) requires user confirmation of correct DHCP reservation
- Commit after each task or logical group to maintain reviewable history
