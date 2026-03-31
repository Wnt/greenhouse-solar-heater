# Tasks: Fix Padding and Status Display Inconsistencies

**Input**: Design documents from `/specs/015-fix-padding-status-display/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: E2e tests explicitly requested. Tests are included in the relevant user story phases.

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: No project setup needed — all changes are within existing files. This phase is empty.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add `hasReceivedData` flag to LiveSource, which is needed by US3 (overlays) and US4 (device push).

- [x] T001 Add `hasReceivedData` property to LiveSource class in playground/js/data-source.js — initialize as `false` in constructor, set to `true` in `_handleState()`, reset to `false` in `stop()`

**Checkpoint**: LiveSource now exposes `hasReceivedData` for downstream use.

---

## Phase 3: User Story 1 - Consistent Spacing Across All Views (Priority: P1) 🎯 MVP

**Goal**: Fix all CSS spacing violations across Status, Controls, and Device views to conform to Stitch design system tokens (8/12/16/24/32px).

**Independent Test**: Navigate through Status, Controls, and Device views and verify all padding/margin values match the Stitch spacing scale.

### Implementation for User Story 1

- [x] T002 [P] [US1] Fix `.device-config-row` padding from `10px 0` to `12px 0` in playground/css/style.css
- [x] T003 [P] [US1] Remove `border-bottom: 1px solid var(--outline-variant)` from `.device-config-row` in playground/css/style.css — replace with spacing gap per Stitch No-Line rule
- [x] T004 [P] [US1] Fix `.mode-card-inactive` horizontal padding from `16px 20px` to `16px 24px` in playground/css/style.css
- [x] T005 [P] [US1] Fix `.tank-gauge-title` margin from `20px` to `16px` in playground/css/style.css
- [x] T006 [P] [US1] Fix `.tank-gauge-message` margin from `20px` to `16px` in playground/css/style.css
- [x] T007 [P] [US1] Fix button base padding from `10px 20px` to `12px 24px` in playground/css/style.css
- [x] T008 [P] [US1] Fix `.preset-btn` padding from `6px 14px` to `8px 12px` in playground/css/style.css
- [x] T009 [P] [US1] Fix select element padding from `8px 14px` to `8px 16px` in playground/css/style.css
- [x] T010 [P] [US1] Fix `.graph-inspector` padding from `10px 14px` to `8px 12px` in playground/css/style.css
- [x] T011 [P] [US1] Fix `.graph-inspector-time` margin from `6px` to `8px` in playground/css/style.css
- [x] T012 [P] [US1] Fix `.device-select` vertical padding from `6px` to `8px` in playground/css/style.css
- [x] T013 [P] [US1] Fix `.time-range-pills` padding from `3px` to `4px` and button padding from `5px 12px` to `8px 12px` in playground/css/style.css
- [x] T014 [P] [US1] Fix `.log-dot` margin-top from `6px` to `8px` in playground/css/style.css
- [x] T015 [P] [US1] Fix `.view-header` margin-bottom from `20px` to `24px` in playground/css/style.css
- [x] T016 [P] [US1] Fix `.tank-gauge-status` margin-top from `4px` to `8px` in playground/css/style.css
- [x] T017 [P] [US1] Fix inline `margin-top:20px` on Device save button container in playground/index.html — change to `margin-top:24px`

**Checkpoint**: All spacing values across Status, Controls, and Device views match the Stitch 8/12/16/24/32px token scale. No arbitrary pixel values remain.

---

## Phase 4: User Story 2 - Properly Positioned Live/Simulation Toggle (Priority: P1)

**Goal**: Fix the mode toggle, connection status, and controls indicator to have proper horizontal padding matching sidebar nav items.

**Independent Test**: Open the app in live mode and verify the toggle label, connection dot, and controls indicator are fully visible with 24px left padding.

### Implementation for User Story 2

- [x] T018 [P] [US2] Fix `.mode-toggle` padding from `8px 0` to `8px 24px` in playground/css/style.css
- [x] T019 [P] [US2] Fix `.connection-status` padding from `4px 0` to `4px 24px` in playground/css/style.css
- [x] T020 [P] [US2] Fix `.controls-indicator` padding from `2px 0` to `2px 24px` in playground/css/style.css

### E2e Test for User Story 2

- [x] T021 [US2] Add e2e test "mode toggle is fully visible with proper padding" in tests/e2e/connection-status.spec.js

**Checkpoint**: Toggle, connection status, and controls indicator have consistent 24px horizontal padding matching sidebar nav items.

---

## Phase 5: User Story 3 - Connection-Aware Status View with Three Distinct States (Priority: P1)

**Goal**: Add glassmorphic overlays to Status view cards showing editorial messages for three connection states: never_connected, disconnected, stale.

**Independent Test**: Open the app in live mode (no WebSocket server) and verify the "never connected" overlay appears on Status view cards with editorial message and subtitle.

### Implementation for User Story 3

- [x] T022 [US3] Add `.connection-overlay` CSS styles in playground/css/style.css
- [x] T023 [US3] Add `position: relative` to Status view card containers that need overlays in playground/index.html
- [x] T024 [US3] Add overlay HTML elements inside the three Status view card groups in playground/index.html
- [x] T025 [US3] Implement `updateConnectionOverlays()` function in playground/index.html inline script
- [x] T026 [US3] Call `updateConnectionOverlays()` from `updateConnectionUI()`, `checkStaleness()`, `switchToLive()`, and `switchToSimulation()`
- [x] T027 [US3] Integrate stale detection into the overlay system (staleness-banner retained for backwards compat, overlays added)

### E2e Tests for User Story 3

- [x] T028 [US3] Add e2e test "never-connected overlay appears in live mode" in tests/e2e/connection-status.spec.js
- [x] T029 [US3] Add e2e test "overlays removed when switching to simulation" in tests/e2e/connection-status.spec.js

**Checkpoint**: Status view shows glassmorphic overlays with editorial messages when in live mode without connection. Overlays clear on simulation switch.

---

## Phase 6: User Story 4 - Device Config Push Disabled Without Connection (Priority: P1)

**Goal**: Disable the "Save & Push to Device" button when disconnected, with explanation and "try anyway" override.

**Independent Test**: Navigate to Device view in live mode without connection and verify the button is disabled with explanation text and a "try anyway" link.

### Implementation for User Story 4

- [x] T030 [US4] Add disabled button and "try anyway" link HTML below `#dc-save` button in playground/index.html
- [x] T031 [US4] Add CSS styles for disabled save button state and "try anyway" link in playground/css/style.css
- [x] T032 [US4] Implement `updateDevicePushState()` function in playground/index.html inline script
- [x] T033 [US4] Call `updateDevicePushState()` from `updateConnectionUI()`, `switchToLive()`, and `switchToSimulation()`
- [x] T034 [US4] Wire "try anyway" click handler in playground/index.html

### E2e Tests for User Story 4

- [x] T035 [US4] Add e2e test "save button disabled without connection" in tests/e2e/connection-status.spec.js
- [x] T036 [US4] Add e2e test "try-anyway link is present and clickable" in tests/e2e/connection-status.spec.js

**Checkpoint**: Device view save button disables with explanation when disconnected, re-enables on connection, and "try anyway" bypasses the check.

---

## Phase 7: User Story 5 - Consistent Spacing on Components and Schematic Views (Priority: P2)

**Goal**: Fix remaining spacing inconsistencies in Components and Schematic views.

**Independent Test**: Navigate to Components and Schematic views and verify grid gaps and card padding match the Stitch design system.

### Implementation for User Story 5

- [x] T037 [P] [US5] Fix valve grid gap from 8px to 12px in playground/css/style.css
- [x] T038 [P] [US5] Component-card padding (16px) — kept as-is (appropriate for compact nested cards within the grid)
- [x] T039 [P] [US5] Fix `.log-item:not(:last-child)` border-bottom — removed per No-Line rule, gap provides separation
- [x] T040 [P] [US5] Schematic view SVG container — verified consistent (uses card padding 24px)

**Checkpoint**: Components and Schematic views have consistent spacing matching the Stitch design system.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [x] T041 Run full e2e test suite (`npm run test:e2e`) — 35 passed in 12.1s
- [x] T042 Run unit tests (`npm run test:unit`) — data-source tests pass (45 pre-existing auth failures unrelated)
- [ ] T043 Visual audit: manually check all 5 views on desktop (1280px) for spacing consistency
- [ ] T044 Update CLAUDE.md if any structural changes affect project documentation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: Empty — nothing to do
- **Phase 2 (Foundational)**: T001 — `hasReceivedData` flag. BLOCKS Phase 5 (US3) and Phase 6 (US4)
- **Phase 3 (US1)**: No dependencies on T001 — can run in parallel with Phase 2
- **Phase 4 (US2)**: No dependencies on T001 — can run in parallel with Phase 2
- **Phase 5 (US3)**: Depends on T001 (needs `hasReceivedData`)
- **Phase 6 (US4)**: Depends on T001 (needs `hasReceivedData` for connection state)
- **Phase 7 (US5)**: No dependencies — can run in parallel with any phase
- **Phase 8 (Polish)**: Depends on all previous phases

### User Story Dependencies

- **US1 (Spacing)**: Independent — CSS-only changes
- **US2 (Toggle)**: Independent — CSS-only changes
- **US3 (Overlays)**: Depends on T001 (hasReceivedData flag)
- **US4 (Device push)**: Depends on T001 (hasReceivedData flag)
- **US5 (Components/Schematic)**: Independent — CSS-only changes

---

## Notes

- All US1, US2, US5 tasks modify only `playground/css/style.css` — these are safe CSS-only changes
- US3 and US4 modify both `playground/index.html` (JS + HTML) and `playground/css/style.css`
- T001 modifies `playground/js/data-source.js` — the only JS module change
- E2e tests in `tests/e2e/connection-status.spec.js` must import from `./fixtures.js` (not `@playwright/test`)
- All e2e tests complete within 5s individual timeout
- Existing device-config tests updated to enable save button via page.evaluate (button disabled in test env due to no WebSocket)
