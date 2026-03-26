# Tasks: Remove Monitor App, Promote Playground

**Input**: Design documents from `/specs/013-remove-monitor-app/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Tests**: Not explicitly requested. Test tasks limited to updating existing tests for new paths and removing obsolete tests.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Server**: `server/` (moved from `monitor/`)
- **Frontend**: `playground/`
- **Shelly scripts**: `shelly/`
- **Tests**: `tests/`
- **Deploy**: `deploy/`

---

## Phase 1: Setup

**Purpose**: Create target directory structure and move files before making modifications

- [x] T001 Create `server/` directory structure: `mkdir -p server/auth server/lib`
- [x] T002 Move server files from `monitor/` to `server/`: move `monitor/server.js` → `server/server.js`, `monitor/auth/*` → `server/auth/`, `monitor/lib/logger.js`, `monitor/lib/s3-storage.js`, `monitor/lib/db.js`, `monitor/lib/db-config.js`, `monitor/lib/mqtt-bridge.js`, `monitor/lib/device-config.js`, `monitor/lib/tracing.js`, `monitor/lib/nr-config.js`, `monitor/lib/vpn-config.js`, `monitor/lib/valve-poller.js` → `server/lib/`
- [x] T003 Move auth frontend files from `monitor/` to `playground/`: move `monitor/login.html` → `playground/login.html`, `monitor/js/login.js` → `playground/js/login.js`, `monitor/vendor/simplewebauthn-browser.mjs` → `playground/vendor/simplewebauthn-browser.mjs`, `monitor/vendor/qrcode-generator.mjs` → `playground/vendor/qrcode-generator.mjs`
- [x] T004 Delete monitor UI files: remove `monitor/index.html`, `monitor/offline.html`, `monitor/sw.js`, `monitor/manifest.json`, `monitor/css/`, `monitor/js/app.js`, `monitor/js/chart.js`, `monitor/js/gauge.js`, `monitor/js/push.js`, `monitor/js/shelly-api.js`, `monitor/icons/`
- [x] T005 Delete PoC Shelly scripts: remove `monitor/shelly/` directory (contains `sensor-display.js` and `deploy-poc.sh`)
- [x] T006 Delete push notification storage: remove `monitor/lib/push-storage.js`
- [x] T007 Remove empty `monitor/` directory after all moves and deletes

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Fix all internal references broken by the `monitor/` → `server/` move. MUST complete before user story work.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T008 Update all `require()` paths in `server/server.js`: change `./auth/` → `./auth/`, `./lib/` → `./lib/` (verify relative paths still work), remove `push-storage` require, remove `web-push` require, remove push notification route handlers, remove monitor static file serving. Update `MONITOR_DIR` / `PLAYGROUND_DIR` path constants to serve playground at `/` root
- [x] T009 Update `server/auth/credentials.js` internal require paths: change any `../lib/` references to resolve correctly from `server/auth/`
- [x] T010 Update `server/auth/webauthn.js` internal require paths: change any `../lib/` references to resolve correctly from `server/auth/`
- [x] T011 [P] Update `server/lib/db-config.js` — verify `require()` paths resolve from new location
- [x] T012 [P] Update `server/lib/nr-config.js` — verify `require()` paths resolve from new location
- [x] T013 [P] Update `server/lib/vpn-config.js` — verify `require()` paths resolve from new location
- [x] T014 Update auth middleware in `server/server.js`: update the login page asset allowlist to use playground paths (`/login.html`, `/js/login.js`, `/vendor/simplewebauthn-browser.mjs`, `/vendor/qrcode-generator.mjs`) instead of monitor paths
- [x] T015 Update `playground/login.html` importmap: change `./vendor/simplewebauthn-browser.mjs` and `./vendor/qrcode-generator.mjs` paths to match new vendored locations in `playground/vendor/`
- [x] T016 Remove `web-push` from dependencies in `package.json` (keep `@simplewebauthn/server`)
- [x] T017 [P] Update `tests/auth.test.js` — change import paths from `../monitor/auth/` to `../server/auth/`
- [x] T018 [P] Update `tests/s3-storage.test.js` — change import paths from `../monitor/lib/` to `../server/lib/`
- [x] T019 [P] Update `tests/db.test.js` — change import paths from `../monitor/lib/` to `../server/lib/`
- [x] T020 [P] Update `tests/tracing.test.js` — change import paths from `../monitor/lib/` to `../server/lib/`
- [x] T021 [P] Update `tests/mqtt-bridge.test.js` — change import paths from `../monitor/lib/` to `../server/lib/`
- [x] T022 [P] Update `tests/device-config.test.js` — change import paths from `../monitor/lib/` to `../server/lib/`
- [x] T023 [P] Update `tests/device-config-integration.test.js` — change import paths from `../monitor/lib/` to `../server/lib/`
- [x] T024 [P] Update `tests/data-source.test.js` — change import paths if referencing `monitor/`
- [x] T025 [P] Update `tests/rpc-proxy.test.js` — change import paths from `../monitor/` to `../server/`
- [x] T026 [P] Update `tests/valve-poller.test.js` — change import paths from `../monitor/lib/` to `../server/lib/`
- [x] T027 [P] Update `tests/vpn-config.test.js` — change import paths from `../monitor/lib/` to `../server/lib/`
- [x] T028 Delete `tests/push-storage.test.js` — push storage is removed
- [x] T029 Delete `tests/sw.test.js` — service worker is removed
- [x] T030 Delete or simplify `tests/e2e/pwa.spec.js` — PWA manifest and service worker are removed
- [x] T031 Update `deploy/docker/Dockerfile`: replace `COPY monitor/ ./monitor/` with `COPY server/ ./server/`, add `COPY shelly/ ./shelly/` (full directory for deploy), keep `COPY playground/ ./playground/`, update CMD to `node --require ./server/lib/tracing.js server/server.js`
- [x] T032 Update `deploy/deployer/deploy.sh`: change all `monitor/lib/` references to `server/lib/` (vpn-config.js, db-config.js, nr-config.js paths)
- [x] T033 Run `npm test` to verify all tests pass with new paths

**Checkpoint**: All file moves complete, paths updated, tests passing. Foundation ready for user story work.

---

## Phase 3: User Story 1 — Remove Monitor UI, Promote Playground (Priority: P1) 🎯 MVP

**Goal**: Playground is served at `/` behind passkey auth. Monitor UI fully removed. All APIs (WebSocket, RPC proxy, device config, history) work through the playground.

**Independent Test**: Start server (`node server/server.js`), open `http://localhost:3000/` — should redirect to login page. After authentication, playground loads with all 5 views functional.

### Implementation for User Story 1

- [x] T034 [US1] Update static file serving in `server/server.js`: serve `playground/` directory at root `/` instead of at `/playground/` sub-path. Keep serving `shelly/control-logic.js` and `system.yaml` at their current paths.
- [x] T035 [US1] Remove push notification routes from `server/server.js`: delete `/api/push/vapid-public-key`, `/api/push/subscribe`, `/api/push/unsubscribe` handlers and the valve-change push notification logic
- [x] T036 [US1] Remove push notification references from valve poller integration in `server/server.js`: remove the code that sends push notifications on valve state change (keep the valve poller itself as it may feed data to the UI)
- [x] T037 [US1] Update `server/server.js` playground path routing: ensure `/shelly/control-logic.js` is still served (playground loads this for simulation mode), and `/system.yaml` is still served from repo root
- [x] T038 [US1] Verify auth middleware protects playground routes: unauthenticated requests to `/` should redirect to `/login.html`. Login page and its assets must remain accessible without auth.
- [x] T039 [US1] Run the full test suite (`npm test`) and verify all unit, simulation, and e2e tests pass

**Checkpoint**: Playground is the sole app at `/`, protected by passkey auth. No monitor UI code remains.

---

## Phase 4: User Story 2 — Deep Bookmarkable Views (Priority: P2)

**Goal**: Each view has a unique URL fragment (`#status`, `#components`, `#schematic`, `#controls`, `#device`). Browser back/forward works. Direct URL access loads the correct view.

**Independent Test**: Navigate to `http://localhost:3000/#schematic` — Schematic view should load. Click Components nav link — URL changes to `#components`. Press browser Back — returns to `#schematic`.

### Implementation for User Story 2

- [x] T040 [US2] Refactor view switching in `playground/index.html`: extract a `navigateToView(viewId)` function that handles activating the view, updating nav link active states, and respects live-only visibility rules
- [x] T041 [US2] Add hash-based navigation in `playground/index.html`: on nav link click, set `window.location.hash = viewId` instead of only toggling classes. The `navigateToView()` function is called from the hash change handler, not the click handler directly.
- [x] T042 [US2] Add `hashchange` event listener in `playground/index.html`: listen for `window.onhashchange` and call `navigateToView()` with the hash value (handles browser back/forward)
- [x] T043 [US2] Add initial view load from hash in `playground/index.html`: on `DOMContentLoaded`, read `window.location.hash` and navigate to the matching view. Default to `#status` if hash is empty or unknown.
- [x] T044 [US2] Handle edge case: Device view hash when not in live mode. If user navigates to `#device` but live mode is not active, fall back to `#status` (or show the view with its existing "not connected" state).

**Checkpoint**: All 5 views are deep-linkable. Browser history navigation works.

---

## Phase 5: User Story 3 — Device Configuration Explanations (Priority: P3)

**Goal**: Every configuration option in the Device view has a clear, visible description explaining its purpose and effect.

**Independent Test**: Open Device configuration view. Verify each toggle, dropdown, and checkbox group has explanatory text visible below or beside it.

### Implementation for User Story 3

- [x] T045 [US3] Add description for "Controls Enabled" toggle in `playground/index.html`: add a `<p>` element with muted style below the toggle explaining it is the master switch for all hardware actuation
- [x] T046 [US3] Add section description and per-actuator descriptions for "Enabled Actuators" in `playground/index.html`: add intro text explaining selective actuator control, then add descriptions for each toggle — Valves (direct water flow), Pump (circulation), Fan (ventilation), Space Heater (backup heating), Immersion Heater (electric water heating)
- [x] T047 [US3] Add description for "Forced Mode" dropdown in `playground/index.html`: add text explaining it overrides automatic mode selection, and add brief descriptions for each mode option (Idle, Solar Charging, Greenhouse Heating, Active Drain, Emergency Heating)
- [x] T048 [US3] Update "Allowed Modes" description in `playground/index.html`: enhance existing description to include brief explanation of each mode's normal use case, note that forced mode override is not affected by this setting

**Checkpoint**: All Device configuration options have visible explanations.

---

## Phase 6: User Story 4 — Shelly Script Deployment on App Deploy (Priority: P4)

**Goal**: Shelly Pro 4PM control scripts are automatically updated during deployment. The device IP is 192.168.1.174. Failure is non-fatal.

**Independent Test**: Verify `shelly/devices.conf` has `PRO4PM=192.168.1.174`. Verify `deploy/deployer/deploy.sh` includes the Shelly deploy step. Verify the Docker image includes the full `shelly/` directory.

### Implementation for User Story 4

- [x] T049 [US4] Verify `shelly/devices.conf` has `PRO4PM=192.168.1.174` — confirm the IP is already set correctly (it should be based on existing config)
- [x] T050 [US4] Verify `deploy/deployer/deploy.sh` Shelly deploy step: confirm the existing Shelly deploy step (around line 189-201) runs `shelly/deploy.sh` inside the app container with `DEPLOY_VIA_VPN=true` and `CONTROLLER_VPN_IP`. Ensure it is non-fatal (uses `|| echo "[WARN]..."` pattern).
- [x] T051 [US4] Ensure `CONTROLLER_VPN_IP` is set in `deploy/deployer/config.env` so the Shelly deploy step actually triggers during deployment
- [x] T052 [US4] Verify the Dockerfile (updated in T031) includes `COPY shelly/ ./shelly/` so the deploy script and all Shelly scripts are available inside the container
- [x] T053 [US4] Verify the Docker image has `python3` available (required by `shelly/deploy.sh` upload helper) — if not, add `apk add python3` to `deploy/docker/Dockerfile`

**Checkpoint**: Shelly scripts deploy automatically during app deployment. Failure is graceful.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates and final validation

- [x] T054 Update `CLAUDE.md`: remove all monitor app documentation (file relationships, auth section, push notifications, PWA, monitor-specific test descriptions). Update file paths from `monitor/` to `server/`. Document new project structure with playground as main app behind auth.
- [x] T055 Update `CLAUDE.md` Active Technologies section: remove `web-push` reference, keep `@simplewebauthn/server`, update paths
- [x] T056 Run full test suite (`npm test`) and verify all tests pass
- [x] T057 Run Shelly linter (`node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js shelly/telemetry.js`) to verify no regressions
- [x] T058 Verify Docker build succeeds: `docker build -f deploy/docker/Dockerfile -t test-build .`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (all file moves must complete before path updates)
- **User Stories (Phase 3-6)**: All depend on Foundational phase completion
  - US1 (P1): Can start after Phase 2
  - US2 (P2): Independent of US1 — can run in parallel after Phase 2
  - US3 (P3): Independent of US1/US2 — can run in parallel after Phase 2
  - US4 (P4): Depends on T031 (Dockerfile update in Phase 2) but otherwise independent
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (Remove Monitor UI)**: Depends on Phase 2 only — no other story dependencies
- **US2 (Deep Linking)**: Depends on Phase 2 only — modifies `playground/index.html` (potential conflict with US3 if run in parallel)
- **US3 (Device Config Descriptions)**: Depends on Phase 2 only — modifies `playground/index.html` (potential conflict with US2 if run in parallel)
- **US4 (Shelly Deploy)**: Depends on T031 from Phase 2 — otherwise independent

**Note**: US2 and US3 both modify `playground/index.html` but touch different sections (navigation JS vs Device view HTML), so conflicts are unlikely but possible. Recommend sequential execution: US2 then US3.

### Parallel Opportunities

**Phase 2** (after Phase 1):
- T011, T012, T013 can run in parallel (independent lib files)
- T017-T027 can ALL run in parallel (each modifies a different test file)
- T028, T029, T030 can run in parallel (deleting independent test files)

**After Phase 2**:
- US1 and US4 can run in parallel (different files entirely)
- US2 and US3 can run in parallel with care (same file, different sections)

---

## Parallel Example: Phase 2 Test Updates

```bash
# All test path updates can run in parallel (each file is independent):
Task T017: "Update tests/auth.test.js paths"
Task T018: "Update tests/s3-storage.test.js paths"
Task T019: "Update tests/db.test.js paths"
Task T020: "Update tests/tracing.test.js paths"
Task T021: "Update tests/mqtt-bridge.test.js paths"
Task T022: "Update tests/device-config.test.js paths"
Task T023: "Update tests/device-config-integration.test.js paths"
Task T025: "Update tests/rpc-proxy.test.js paths"
Task T026: "Update tests/valve-poller.test.js paths"
Task T027: "Update tests/vpn-config.test.js paths"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (file moves and deletes)
2. Complete Phase 2: Foundational (path updates, test fixes)
3. Complete Phase 3: User Story 1 (server simplification, playground at `/`)
4. **STOP and VALIDATE**: Start server, verify playground loads at `/` behind auth
5. Deploy if ready — playground is the main app

### Incremental Delivery

1. Setup + Foundational → All paths work, tests pass
2. Add US1 → Playground is main app behind auth → Deploy (MVP!)
3. Add US2 → Deep linking works → Deploy
4. Add US3 → Device config has explanations → Deploy
5. Add US4 → Shelly scripts auto-deploy → Deploy
6. Polish → Documentation updated, final validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Auth (passkey/WebAuthn) is retained and protects the playground app
- `web-push` is the only dependency being removed
- The `monitor/` directory is completely eliminated after Phase 1
- Shelly deploy mechanism already exists — US4 is mostly verification
- Commit after each phase or logical group of tasks
