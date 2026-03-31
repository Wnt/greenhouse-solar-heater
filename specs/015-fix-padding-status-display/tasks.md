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

- [ ] T001 Add `hasReceivedData` property to LiveSource class in playground/js/data-source.js — initialize as `false` in constructor, set to `true` in `_handleState()`, reset to `false` in `stop()`

**Checkpoint**: LiveSource now exposes `hasReceivedData` for downstream use.

---

## Phase 3: User Story 1 - Consistent Spacing Across All Views (Priority: P1) 🎯 MVP

**Goal**: Fix all CSS spacing violations across Status, Controls, and Device views to conform to Stitch design system tokens (8/12/16/24/32px).

**Independent Test**: Navigate through Status, Controls, and Device views and verify all padding/margin values match the Stitch spacing scale.

### Implementation for User Story 1

- [ ] T002 [P] [US1] Fix `.device-config-row` padding from `10px 0` to `12px 0` in playground/css/style.css
- [ ] T003 [P] [US1] Remove `border-bottom: 1px solid var(--outline-variant)` from `.device-config-row` in playground/css/style.css — replace with `margin-bottom: 12px` or spacing gap to maintain visual separation per Stitch No-Line rule
- [ ] T004 [P] [US1] Fix `.mode-card-inactive` horizontal padding from `16px 20px` to `16px 24px` in playground/css/style.css
- [ ] T005 [P] [US1] Fix `.tank-gauge-title` margin from `20px` to `16px` in playground/css/style.css
- [ ] T006 [P] [US1] Fix `.tank-gauge-message` margin from `20px` to `16px` in playground/css/style.css
- [ ] T007 [P] [US1] Fix button base padding from `10px 20px` to `12px 24px` in playground/css/style.css
- [ ] T008 [P] [US1] Fix `.preset-btn` padding from `6px 14px` to `8px 12px` in playground/css/style.css
- [ ] T009 [P] [US1] Fix select element padding from `8px 14px` to `8px 16px` in playground/css/style.css
- [ ] T010 [P] [US1] Fix `.graph-inspector` padding from `10px 14px` to `8px 12px` in playground/css/style.css
- [ ] T011 [P] [US1] Fix `.graph-inspector-time` margin from `6px` to `8px` in playground/css/style.css
- [ ] T012 [P] [US1] Fix `.device-select` vertical padding from `6px` to `8px` in playground/css/style.css
- [ ] T013 [P] [US1] Fix `.time-range-pills` padding from `3px` to `4px` and button padding from `5px 12px` to `8px 12px` in playground/css/style.css
- [ ] T014 [P] [US1] Fix `.log-dot` margin-top from `6px` to `8px` in playground/css/style.css
- [ ] T015 [P] [US1] Fix `.view-header` margin-bottom from `20px` to `24px` in playground/css/style.css
- [ ] T016 [P] [US1] Fix `.tank-gauge-status` margin-top from `4px` to `8px` in playground/css/style.css
- [ ] T017 [P] [US1] Fix inline `margin-top:20px` on Device save button container in playground/index.html — change to `margin-top:24px`

**Checkpoint**: All spacing values across Status, Controls, and Device views match the Stitch 8/12/16/24/32px token scale. No arbitrary pixel values remain.

---

## Phase 4: User Story 2 - Properly Positioned Live/Simulation Toggle (Priority: P1)

**Goal**: Fix the mode toggle, connection status, and controls indicator to have proper horizontal padding matching sidebar nav items.

**Independent Test**: Open the app in live mode and verify the toggle label, connection dot, and controls indicator are fully visible with 24px left padding.

### Implementation for User Story 2

- [ ] T018 [P] [US2] Fix `.mode-toggle` padding from `8px 0` to `8px 24px` in playground/css/style.css
- [ ] T019 [P] [US2] Fix `.connection-status` padding from `4px 0` to `4px 24px` in playground/css/style.css
- [ ] T020 [P] [US2] Fix `.controls-indicator` padding from `2px 0` to `2px 24px` in playground/css/style.css

### E2e Test for User Story 2

- [ ] T021 [US2] Add e2e test "mode toggle is fully visible with proper padding" in tests/e2e/connection-status.spec.js — verify `#mode-toggle` is visible, label text is not clipped (bounding box within sidebar width), and has non-zero left offset

**Checkpoint**: Toggle, connection status, and controls indicator have consistent 24px horizontal padding matching sidebar nav items.

---

## Phase 5: User Story 3 - Connection-Aware Status View with Three Distinct States (Priority: P1)

**Goal**: Add glassmorphic overlays to Status view cards showing editorial messages for three connection states: never_connected, disconnected, stale.

**Independent Test**: Open the app in live mode (no WebSocket server) and verify the "never connected" overlay appears on Status view cards with editorial message and subtitle.

### Implementation for User Story 3

- [ ] T022 [US3] Add `.connection-overlay` CSS styles in playground/css/style.css — glassmorphism recipe: `position: absolute; inset: 0; background: rgba(17,19,25,0.6); backdrop-filter: blur(20px); border-radius: 1.5rem; z-index: 10;` with editorial message (Newsreader italic) and subtitle (Manrope) styling
- [ ] T023 [US3] Add `position: relative` to Status view card containers that need overlays in playground/css/style.css — mode cards area (`.bento-span-2` in status), tank gauge card (`.tank-gauge-card`), critical components section
- [ ] T024 [US3] Add overlay HTML elements inside the three Status view card groups in playground/index.html — each overlay contains an editorial `<h3>` primary message and a `<p>` subtitle, hidden by default with a `.connection-overlay` class
- [ ] T025 [US3] Implement `updateConnectionOverlays()` function in playground/index.html inline script — derives display state (never_connected/disconnected/stale/active) from `connectionStatus`, `liveSource.hasReceivedData`, `lastDataTime`; shows/hides overlays and sets correct messages for each state
- [ ] T026 [US3] Call `updateConnectionOverlays()` from `updateConnectionUI()`, `checkStaleness()`, `switchToLive()`, and `switchToSimulation()` in playground/index.html — ensure overlays appear on live mode entry, update on connection changes, clear on sim switch
- [ ] T027 [US3] Replace the existing `staleness-banner` with the stale overlay state in playground/index.html — remove the standalone banner element and integrate stale detection into the overlay system

### E2e Tests for User Story 3

- [ ] T028 [US3] Add e2e test "never-connected overlay appears in live mode" in tests/e2e/connection-status.spec.js — navigate to `/playground/`, verify `.connection-overlay` is visible on Status view cards with editorial text containing "sanctuary"
- [ ] T029 [US3] Add e2e test "overlays removed when switching to simulation" in tests/e2e/connection-status.spec.js — switch to simulation via `#mode-toggle-switch` click, verify `.connection-overlay` elements are hidden

**Checkpoint**: Status view shows glassmorphic overlays with editorial messages when in live mode without connection. Overlays clear on simulation switch.

---

## Phase 6: User Story 4 - Device Config Push Disabled Without Connection (Priority: P1)

**Goal**: Disable the "Save & Push to Device" button when disconnected, with explanation and "try anyway" override.

**Independent Test**: Navigate to Device view in live mode without connection and verify the button is disabled with explanation text and a "try anyway" link.

### Implementation for User Story 4

- [ ] T030 [US4] Add disabled button and "try anyway" link HTML below `#dc-save` button in playground/index.html — add `<p id="dc-connection-warning">` explanation text and `<a id="dc-try-anyway">` link, both hidden by default
- [ ] T031 [US4] Add CSS styles for disabled save button state and "try anyway" link in playground/css/style.css — `.primary.disabled` style (reduced opacity, no pointer events), warning text style, link style
- [ ] T032 [US4] Implement `updateDevicePushState()` function in playground/index.html inline script — when `connectionStatus !== 'connected'`: disable button, show warning "Cannot reach the controller", show "try anyway" link; when connected: enable button, hide warning/link
- [ ] T033 [US4] Call `updateDevicePushState()` from `updateConnectionUI()` in playground/index.html — ensures button state updates on every connection change
- [ ] T034 [US4] Wire "try anyway" click handler in playground/index.html — calls `saveDeviceConfig()` directly, bypassing the connection check

### E2e Tests for User Story 4

- [ ] T035 [US4] Add e2e test "save button disabled without connection" in tests/e2e/connection-status.spec.js — navigate to Device view in live mode, mock `/api/device-config` GET, verify `#dc-save` has disabled state and `#dc-connection-warning` is visible
- [ ] T036 [US4] Add e2e test "try-anyway link is present and clickable" in tests/e2e/connection-status.spec.js — verify `#dc-try-anyway` link is visible when button is disabled

**Checkpoint**: Device view save button disables with explanation when disconnected, re-enables on connection, and "try anyway" bypasses the check.

---

## Phase 7: User Story 5 - Consistent Spacing on Components and Schematic Views (Priority: P2)

**Goal**: Fix remaining spacing inconsistencies in Components and Schematic views.

**Independent Test**: Navigate to Components and Schematic views and verify grid gaps and card padding match the Stitch design system.

### Implementation for User Story 5

- [ ] T037 [P] [US5] Fix valve grid gap to minimum 12px in playground/css/style.css — check `.valve-grid` gap property and update if below 12px
- [ ] T038 [P] [US5] Fix `.component-card` padding to 24px if inconsistent in playground/css/style.css
- [ ] T039 [P] [US5] Fix `.log-item:not(:last-child)` border-bottom in playground/css/style.css — assess if structural (remove per No-Line rule, replace with gap) or data-related (keep)
- [ ] T040 [P] [US5] Verify schematic view SVG container padding is consistent with other views in playground/css/style.css

**Checkpoint**: Components and Schematic views have consistent spacing matching the Stitch design system.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T041 Run full e2e test suite (`npm run test:e2e`) and verify all tests pass within 30s total
- [ ] T042 Run unit tests (`npm run test:unit`) and verify no regressions
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

### Parallel Opportunities

- **T002–T017** (US1): All parallelizable — different CSS selectors, same file but non-overlapping
- **T018–T020** (US2): All parallelizable — different CSS selectors
- **T037–T040** (US5): All parallelizable — different CSS selectors
- **US1, US2, US5** can all run in parallel (CSS-only, no JS dependencies)
- **US3, US4** can run in parallel after T001 completes (different DOM areas)

---

## Parallel Example: Sprint 1 (CSS fixes)

```text
# These can all run in parallel (different CSS selectors, no JS dependencies):
T002–T017: All US1 spacing fixes in style.css
T018–T020: All US2 toggle padding fixes in style.css
T037–T040: All US5 Components/Schematic fixes in style.css
```

## Parallel Example: Sprint 2 (JS features, after T001)

```text
# These can run in parallel (different DOM areas and functions):
T022–T029: US3 overlays (Status view cards + overlay JS logic + tests)
T030–T036: US4 device push disabled (Device view + save handler + tests)
```

---

## Implementation Strategy

### MVP First (US1 + US2 Only)

1. Complete T002–T017 (US1 spacing fixes) + T018–T020 (US2 toggle padding)
2. **STOP and VALIDATE**: Visual audit of all views
3. These are pure CSS changes with zero risk of breaking functionality

### Incremental Delivery

1. US1 + US2 (CSS fixes) → Visual improvement immediately visible
2. T001 (foundational) → hasReceivedData flag
3. US3 (overlays) → Connection-aware Status view
4. US4 (device push) → Safe device config push
5. US5 (Components/Schematic polish) → Complete consistency
6. Polish phase → Full test suite validation

---

## Notes

- All US1, US2, US5 tasks modify only `playground/css/style.css` — these are safe CSS-only changes
- US3 and US4 modify both `playground/index.html` (JS + HTML) and `playground/css/style.css`
- T001 modifies `playground/js/data-source.js` — the only JS module change
- E2e tests in `tests/e2e/connection-status.spec.js` must import from `./fixtures.js` (not `@playwright/test`)
- All e2e tests must complete within 5s individual timeout
- The static server (`npx serve`) has no WebSocket, so live mode naturally shows "never connected" — perfect for testing overlays
