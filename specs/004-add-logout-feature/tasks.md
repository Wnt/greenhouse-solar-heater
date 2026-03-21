# Tasks: Add Logout Feature

**Input**: Design documents from `/specs/004-add-logout-feature/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included — Constitution Principle IV (Proportional Test Coverage) requires tests for this security-relevant UI change.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: User Story 1 - Log Out from Shelly Monitor (Priority: P1) MVP

**Goal**: Authenticated users can click a logout button in the header, ending their session and redirecting to the login page.

**Independent Test**: Authenticate, click the logout button, verify redirect to login page, verify protected pages are inaccessible.

### Implementation for User Story 1

- [ ] T001 [P] [US1] Add logout button markup (hidden by default) to the header nav in poc/index.html
- [ ] T002 [P] [US1] Add logout button styles matching existing nav link appearance in poc/css/style.css
- [ ] T003 [US1] Add auth status check on app init and logout click handler in poc/js/app.js — on load, fetch GET /auth/status; if authenticated, show the logout button; on click, POST /auth/logout, then redirect to /login.html on success or show error message on failure
- [ ] T004 [US1] Handle edge case: if session is already expired when logout is clicked, treat the response as success and redirect to /login.html in poc/js/app.js

**Checkpoint**: At this point, User Story 1 should be fully functional — an authenticated user can log out via the header button.

---

## Phase 2: User Story 2 - Logout Button Visibility Based on Auth State (Priority: P2)

**Goal**: The logout button only appears when authentication is enabled (cloud mode). In local/LAN mode (auth disabled), the button stays hidden.

**Independent Test**: Load the monitor with AUTH_ENABLED=false and verify no logout button; load with AUTH_ENABLED=true and verify the button appears.

### Implementation for User Story 2

- [ ] T005 [US2] Ensure the auth status check in poc/js/app.js handles the 404 case (auth disabled) by keeping the logout button hidden — no additional action needed if T003 already treats non-200 as "auth disabled"

**Checkpoint**: Both user stories work independently — button appears only when auth is enabled, and clicking it terminates the session.

---

## Phase 3: Tests (Constitution Principle IV)

**Purpose**: Proportional test coverage for the logout feature.

- [ ] T006 [P] Add unit test for the logout endpoint behavior (session removal, cookie clearing) in tests/auth.test.js
- [ ] T007 [P] Add e2e Playwright test for the logout flow: verify logout button visibility when authenticated, click logout, verify redirect to login page, verify protected page access denied — create tests/e2e/logout.spec.js or extend tests/e2e/thermal-sim.spec.js

**Checkpoint**: All tests pass. Feature is complete.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and cleanup.

- [ ] T008 Verify existing tests still pass (npm run test:unit and npm run test:e2e)
- [ ] T009 Run quickstart.md validation — start server in both auth and non-auth modes, verify logout behavior

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (US1)**: No dependencies — can start immediately
- **Phase 2 (US2)**: Depends on T003 (auth check logic from US1)
- **Phase 3 (Tests)**: Depends on US1 and US2 completion
- **Phase 4 (Polish)**: Depends on all prior phases

### Within User Story 1

- T001 and T002 can run in parallel (different files: HTML vs CSS)
- T003 depends on T001 (needs the button element to show/hide)
- T004 depends on T003 (extends the logout handler)

### Parallel Opportunities

- T001 + T002: HTML and CSS changes are independent
- T006 + T007: Unit test and e2e test are independent

---

## Parallel Example: User Story 1

```text
# Launch markup and styles in parallel:
Task T001: "Add logout button markup in poc/index.html"
Task T002: "Add logout button styles in poc/css/style.css"

# Then sequentially:
Task T003: "Add auth check + logout handler in poc/js/app.js" (needs T001)
Task T004: "Handle expired session edge case in poc/js/app.js" (needs T003)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: US1 (T001–T004)
2. **STOP and VALIDATE**: Test logout flow manually
3. Feature is usable at this point

### Full Delivery

1. Complete Phase 1: US1 → core logout works
2. Complete Phase 2: US2 → conditional visibility
3. Complete Phase 3: Tests → proportional coverage satisfied
4. Complete Phase 4: Polish → all tests pass, quickstart validated

---

## Notes

- No new dependencies required
- Server-side logout endpoint (`POST /auth/logout`) already exists — no backend changes needed
- `GET /auth/status` already exists — returns `{ authenticated, setupMode, registrationOpen }`
- When `AUTH_ENABLED=false`, `/auth/` routes are not registered, so `/auth/status` returns 404
- The client treats 404 from `/auth/status` as "auth disabled" — natural signal, no server changes
- Commit after each task or logical group
