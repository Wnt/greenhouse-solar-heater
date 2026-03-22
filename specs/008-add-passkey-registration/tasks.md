# Tasks: Add Passkey Registration via Invitation

**Input**: Design documents from `/specs/008-add-passkey-registration/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md, quickstart.md

**Tests**: Included — constitution principle IV (Proportional Test Coverage) requires tests for behavior changes. Existing test file `tests/auth.test.js` will be extended.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Vendor the QR code library and prepare shared infrastructure

- [ ] T001 Vendor the `qrcode` npm package browser bundle to `monitor/vendor/qrcode.mjs` — download via `npm pack qrcode`, extract the browser-ready ESM/UMD build, copy to vendor directory
- [ ] T002 Add `qrcode.mjs` to the public static routes allowlist in `monitor/server.js` (line ~274, alongside existing vendor entries)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Server-side invitation management and rate limiting — MUST be complete before any user story UI work

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 Implement invitation data structures and CRUD functions in `monitor/auth/webauthn.js`: add `activeInvitations` object (keyed by code), `createInvitation(sessionToken)` (generates 6-digit code via `crypto.randomInt`, sets 5-min expiry, invalidates previous invitation from same session, returns `{ code, expiresAt, expiresInSeconds }`), `validateInvitation(code)` (checks existence and expiry, returns boolean), `consumeInvitation(code)` (deletes from store, returns boolean)
- [ ] T004 Implement rate limiting functions in `monitor/auth/webauthn.js`: add `rateLimits` object (keyed by IP), `checkRateLimit(ip)` (returns boolean — true if allowed, false if blocked; prunes entries older than 60s, checks count < 5), `recordAttempt(ip)` (adds timestamp to attempts array)
- [ ] T005 Add `POST /auth/invite/create` route handler in `monitor/auth/webauthn.js` `handleRequest` router: require authenticated session (check session cookie via `session.verify`), call `createInvitation(sessionToken)`, return `{ code, expiresAt, expiresInSeconds }`; return 401 if not authenticated
- [ ] T006 Add `POST /auth/invite/validate` route handler in `monitor/auth/webauthn.js` `handleRequest` router: parse `{ code }` from body, call `checkRateLimit(clientIp)` (return 429 if blocked), call `recordAttempt(clientIp)`, call `validateInvitation(code)`, return `{ valid: true }` or 400 error
- [ ] T007 Modify `handleRegisterOptions` in `monitor/auth/webauthn.js` (line ~69): extend the authorization check to also accept `invitationCode` from request body — registration allowed if `isRegistrationOpen() || isAuthenticated(req) || validateInvitation(body.invitationCode)`; apply rate limiting to invitation code path
- [ ] T008 Modify `handleRegisterVerify` in `monitor/auth/webauthn.js` (line ~110): if `body.invitationCode` is present, re-validate and consume the invitation on successful verification via `consumeInvitation(body.invitationCode)`; ensure session cookie is set (existing behavior)
- [ ] T009 [P] Write unit tests for invitation CRUD in `tests/auth.test.js`: new `describe('invitations')` block testing `createInvitation` (returns 6-digit code, sets expiry), `validateInvitation` (valid code returns true, expired code returns false, nonexistent code returns false), `consumeInvitation` (deletes code, subsequent validate returns false), and same-session replacement (creating new invitation invalidates previous one)
- [ ] T010 [P] Write unit tests for rate limiting in `tests/auth.test.js`: new `describe('rate limiting')` block testing `checkRateLimit` (allows first 5 attempts, blocks 6th), `recordAttempt` (adds entry), and pruning (attempts older than 60s are ignored)

**Checkpoint**: Server-side invitation API is functional — can be tested via curl/HTTP client

---

## Phase 3: User Story 1 — Generate Invitation from Authenticated Session (Priority: P1) 🎯 MVP

**Goal**: An authenticated user can tap "Add Device" on the monitor page to generate a 6-digit invitation code and QR code

**Independent Test**: Log in on one device, tap "Add Device", verify the 6-digit code and QR code are displayed. Generate a second invitation and verify the first is invalidated.

### Implementation for User Story 1

- [ ] T011 [US1] Add "Add Device" button and invitation modal markup to `monitor/index.html`: add a button in the header area (near the existing logout button), add a hidden modal/overlay div containing: invitation code display (large, monospace, 6 digits), QR code canvas element, expiry countdown text, "Close" button. Use semantic IDs: `invite-btn`, `invite-modal`, `invite-code`, `invite-qr`, `invite-timer`
- [ ] T012 [US1] Add invitation modal styles to `monitor/css/style.css`: modal overlay (centered, semi-transparent backdrop), code display (large monospace font, letter-spacing for readability), QR canvas container, countdown timer text, responsive layout for mobile
- [ ] T013 [US1] Add invitation generation logic to `monitor/js/app.js`: import QR library from importmap, add click handler for `#invite-btn` that calls `POST /auth/invite/create`, displays the returned code in `#invite-code`, generates QR code encoding `${ORIGIN}/login.html?invite=CODE` into `#invite-qr` canvas, starts a countdown timer that updates `#invite-timer` every second and auto-closes the modal on expiry
- [ ] T014 [US1] Add QR code library to importmap in `monitor/index.html`: add `"qrcode": "./vendor/qrcode.mjs"` to the existing importmap script block

**Checkpoint**: Authenticated user can generate and view invitation codes with QR on the monitor page

---

## Phase 4: User Story 2 — Register Passkey on New Device via Invitation Code (Priority: P1)

**Goal**: An unauthenticated user on a new device can enter a 6-digit invitation code on the login page, register a passkey, and be automatically logged in

**Independent Test**: Navigate to login page on a new device, tap "Have an invitation code?", enter a valid code, complete passkey registration, verify redirect to monitor page. Also test: expired code shows error, invalid code shows error, rate limiting blocks after 5 attempts.

### Implementation for User Story 2

- [ ] T015 [US2] Add invitation code input section to `monitor/login.html`: below the login button, add a "Have an invitation code?" link/button (`#invite-link`), a hidden section (`#invite-section`) containing a 6-digit numeric input field (`#invite-code-input`, inputmode="numeric", maxlength=6, pattern="[0-9]{6}"), a "Register" button (`#invite-register-btn`), and an inline error/status area. Add `"qrcode": "./vendor/qrcode.mjs"` to the importmap (needed only for index.html, but keep importmaps consistent)
- [ ] T016 [US2] Add invitation code input styles to `monitor/css/style.css`: invite link styling, collapsible invite section, numeric input field (centered, large, monospace, letter-spacing), register button styling consistent with existing login button, error message styling
- [ ] T017 [US2] Implement invitation-based registration flow in `monitor/js/login.js`: add toggle handler for `#invite-link` (shows/hides `#invite-section`), add handler for `#invite-register-btn` that: (1) reads 6-digit code from input, (2) calls `POST /auth/invite/validate` with `{ code }`, (3) on success calls `POST /auth/register/options` with `{ invitationCode: code }`, (4) calls `startRegistration(options)` from @simplewebauthn/browser, (5) calls `POST /auth/register/verify` with attestation response + `{ invitationCode: code }`, (6) on success redirects to `/`. Handle errors: show "Invalid or expired code" for 400, "Too many attempts" for 429, "Registration failed" for verification errors
- [ ] T018 [US2] Handle `?invite=CODE` URL parameter in `monitor/js/login.js`: on page load, check `URLSearchParams` for `invite` param, if present pre-fill `#invite-code-input`, show `#invite-section`, and auto-trigger validation (used by QR code flow in US3)
- [ ] T019 [US2] Write unit tests for invitation API endpoint behavior in `tests/auth.test.js`: test `POST /auth/invite/create` returns code + expiry (mock authenticated session), test `POST /auth/invite/validate` returns valid/invalid, test `POST /auth/register/options` accepts invitationCode, test `POST /auth/register/verify` consumes invitation on success, test 429 response after 5 rapid validate attempts

**Checkpoint**: Full invitation redemption flow works — new device can register a passkey via numeric code entry

---

## Phase 5: User Story 3 — Register Passkey on New Device via QR Code (Priority: P2)

**Goal**: The QR code displayed in the invitation modal (US1) encodes a URL that opens the login page with the invitation code pre-filled, triggering automatic validation

**Independent Test**: Generate an invitation on Device A, scan the QR with Device B's camera, verify the login page opens with the code pre-filled and passkey registration is prompted.

### Implementation for User Story 3

- [ ] T020 [US3] Verify QR code URL format in `monitor/js/app.js`: ensure the QR code generated in T013 encodes `${window.location.origin}/login.html?invite=CODE` — the `?invite=` parameter is read by the handler implemented in T018. No additional server-side changes needed.
- [ ] T021 [US3] Test QR→login page flow end-to-end: manually verify that scanning the QR code (or clicking the encoded URL) opens the login page with the code pre-filled and the invitation section visible. Document any adjustments needed to the auto-validation timing in `monitor/js/login.js`

**Checkpoint**: QR code scanning completes the full registration flow without manual code entry

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Cleanup, edge cases, documentation

- [ ] T022 [P] Add invitation expiry cleanup: in `monitor/auth/webauthn.js`, add a periodic cleanup that removes expired invitations from `activeInvitations` (e.g., on each `handleRequest` call or via a simple interval). Also add rate limit entry cleanup for IPs with no recent attempts
- [ ] T023 [P] Update CLAUDE.md: add invitation-related files to the File Relationships section, document the new auth endpoints in the Monitor section, note the vendored qrcode library
- [ ] T024 Run `npm run test:unit` to verify all existing and new tests pass
- [ ] T025 Run quickstart.md validation: follow the manual test flow described in `specs/008-add-passkey-registration/quickstart.md` to verify the end-to-end invitation flow

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (T001-T002) — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Phase 2 — server APIs must exist before UI
- **User Story 2 (Phase 4)**: Depends on Phase 2 — server APIs must exist before login page UI
- **User Story 3 (Phase 5)**: Depends on US1 (T013 QR generation) and US2 (T018 URL param handler)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Phase 2 — independent of US2/US3
- **User Story 2 (P1)**: Can start after Phase 2 — independent of US1 (both P1, can run in parallel)
- **User Story 3 (P2)**: Depends on US1 (QR display) and US2 (URL param handler) — cannot start until both are complete

### Within Each Phase

- Phase 2: T003-T004 (data structures) → T005-T008 (route handlers). T009-T010 (tests) can run in parallel with T003-T004
- Phase 3: T011 (markup) → T012 (styles) can parallel, T013 (logic) depends on T011, T014 (importmap) parallel with T011
- Phase 4: T015 (markup) → T016 (styles) can parallel, T017 (logic) depends on T015, T018 (URL param) depends on T015

### Parallel Opportunities

```bash
# Phase 2: Tests can be written while implementing data structures
T003 + T009  # invitation CRUD implementation + tests (parallel files)
T004 + T010  # rate limiting implementation + tests (parallel files)

# Phase 3 + 4: US1 and US2 can run in parallel (different files)
T011-T014 (index.html, app.js) + T015-T018 (login.html, login.js)
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 1: Setup (vendor QR lib, update routes)
2. Complete Phase 2: Foundational (invitation CRUD, rate limiting, route handlers, tests)
3. Complete Phase 3: User Story 1 (invitation generation UI on monitor page)
4. Complete Phase 4: User Story 2 (invitation redemption on login page)
5. **STOP and VALIDATE**: Test the full flow with two devices/browsers
6. Deploy if ready — QR (US3) is a P2 enhancement

### Incremental Delivery

1. Setup + Foundational → Server-side invitation API works (testable via curl)
2. Add US1 → Authenticated user can generate codes + QR
3. Add US2 → New device can register via code entry → **Full MVP complete**
4. Add US3 → QR scanning auto-fills code → Convenience enhancement
5. Polish → Cleanup, docs, edge case handling

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Invitation logic extends `monitor/auth/webauthn.js` (not a new module) per plan.md structure decision
- QR code library vendored per project convention (no CDN URLs)
- All new passkeys use existing `addCredential()` / `createSession()` — no credential schema changes
- In-memory storage for invitations/rate limits per research.md R1/R4 decisions
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
