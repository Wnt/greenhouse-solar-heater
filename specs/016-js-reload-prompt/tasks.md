# Tasks: JS Reload Prompt

**Input**: Design documents from `/specs/016-js-reload-prompt/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/version-endpoint.md

**Tests**: Included — the spec and plan explicitly call for unit and e2e tests (Constitution Principle IV: Proportional Test Coverage).

**Organization**: Tasks grouped by user story. US2 and US3 are co-implemented with US1 since all three share the same files (version-check.js, style.css, index.html).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: No new project setup needed — this feature extends existing files. This phase is a no-op.

---

## Phase 2: Foundational — Server Version Endpoint

**Purpose**: The `/version` endpoint must exist before the client can poll it.

- [ ] T001 Add `GET /version` endpoint that computes SHA-256 hash of JS file stats (mtime+size) for all files in `playground/js/` and returns `{ hash, ts }` JSON response in `server/server.js`
- [ ] T002 Add unit tests for the version hash computation and endpoint response format in `tests/version-check.test.js`

**Checkpoint**: `GET /version` returns a valid hash that changes when JS files are modified.

---

## Phase 3: User Story 1 — Notified of Available Update (Priority: P1) MVP

**Goal**: The app detects JS source changes and shows an editorial-tone toast prompt inviting the user to refresh.

**Independent Test**: Modify a JS file on the server while the page is open; toast appears within 30 seconds.

### Implementation for User Story 1

- [ ] T003 [P] [US1] Create `playground/js/version-check.js` — ES6 module that fetches `/version` on load (baseline hash), polls every 30s, and creates/shows a toast DOM element when hash differs. Include "Refresh now" button that calls `location.reload()`.
- [ ] T004 [P] [US1] Add toast banner CSS styles to `playground/css/style.css` — fixed position bottom-center, Stitch design system (gold #e9c349 on dark #574500 container, Newsreader serif heading, Manrope body, 8px border-radius, slide-up animation, z-index between FAB and nav)
- [ ] T005 [US1] Import and initialize version-check module in `playground/index.html` — add `import` statement in the main `<script type="module">` block

**Checkpoint**: Toast appears when server JS files change; clicking "Refresh now" reloads the page.

---

## Phase 4: User Story 2 — Dismissing the Prompt (Priority: P2)

**Goal**: User can dismiss the toast; it reappears on the next poll cycle, not immediately.

**Independent Test**: Trigger toast, click "Later", verify it disappears and reappears only after the next 30s poll.

### Implementation for User Story 2

- [ ] T006 [US2] Add dismiss ("Later") button to the toast in `playground/js/version-check.js` — clicking sets `isDismissed` flag, hides toast. On next poll cycle, if hash still differs from baseline, clear `isDismissed` and re-show toast.

**Checkpoint**: Dismiss works; toast reappears after next interval, not immediately.

---

## Phase 5: User Story 3 — Prompt Appearance and Tone (Priority: P2)

**Goal**: Toast uses editorial language and matches the Stitch design system visually.

**Independent Test**: Visual inspection that toast uses Newsreader heading, Manrope body, gold/dark palette, editorial copy.

### Implementation for User Story 3

- [ ] T007 [US3] Refine toast copy and typography in `playground/js/version-check.js` — heading: "A new edition is available" (Newsreader serif), body: "We've made some improvements. Refresh to see the latest." (Manrope), actions: "Refresh now" / "Later"

**Checkpoint**: Toast looks and reads like a native part of the Stitch dark editorial theme.

---

## Phase 6: E2E Tests & Polish

**Purpose**: Validate the full feature end-to-end and handle edge cases.

- [ ] T008 Add Playwright e2e test in `tests/e2e/version-check.spec.js` — verify toast appears when version hash changes (mock `/version` endpoint), verify dismiss behavior, verify refresh action, import from `./fixtures.js`
- [ ] T009 Verify silent failure: confirm no errors shown when `/version` returns network error or malformed response in `tests/version-check.test.js` (add edge case tests)
- [ ] T010 Run full test suite (`npm test`) and fix any failures
- [ ] T011 Update CLAUDE.md if any structural changes affect project documentation

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 2 (Foundational)**: No dependencies — start immediately
- **Phase 3 (US1)**: Depends on T001 (endpoint must exist for client to poll)
- **Phase 4 (US2)**: Depends on T003 (dismiss extends the version-check module)
- **Phase 5 (US3)**: Depends on T003 (refines copy in the same module)
- **Phase 6 (Polish)**: Depends on all user stories being complete

### Parallel Opportunities

- T003 and T004 can run in parallel (different files: JS module vs CSS)
- T001 and T002 are sequential (endpoint before its tests)
- US2 and US3 tasks (T006, T007) modify the same file so must be sequential

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Server endpoint + unit tests
2. Complete Phase 3: Client module + CSS + HTML import
3. **STOP and VALIDATE**: Manually test that toast appears on JS file change
4. If working, proceed to US2 + US3 + e2e tests

### Incremental Delivery

1. T001-T002 → Server endpoint ready
2. T003-T005 → Full detection + toast display (MVP)
3. T006 → Dismiss behavior
4. T007 → Editorial refinement
5. T008-T011 → Tests and polish

---

## Notes

- All browser code must be ES6+ modules (no CommonJS)
- Server code is CommonJS (existing pattern in server.js)
- No new npm dependencies
- Toast must not appear on login.html (version-check.js is only imported in index.html)
- Commit after each phase completion
