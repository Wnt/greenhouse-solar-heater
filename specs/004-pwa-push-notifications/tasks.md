# Tasks: PWA Push Notifications for Valve Changes

**Input**: Design documents from `/specs/004-pwa-push-notifications/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/push-api.md

**Tests**: Included — the project constitution (Principle IV: Proportional Test Coverage) requires tests for behavioral changes.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Install dependencies and create shared infrastructure files

- [x] T001 Add `web-push` dependency to package.json and run `npm install`
- [x] T002 [P] Create push storage adapter in poc/lib/push-storage.js — S3/local persistence for VAPID keys (key: `push-config.json`) and push subscriptions (key: `push-subscriptions.json`), reusing the pattern from poc/lib/s3-storage.js. Exports: `loadVapidKeys(callback)`, `saveVapidKeys(data, callback)`, `loadSubscriptions(callback)`, `saveSubscriptions(data, callback)`, `addSubscription(sub, callback)`, `removeSubscription(endpoint, callback)`
- [x] T003 [P] Create valve poller module in poc/lib/valve-poller.js — polls Shelly controller via HTTP GET to `/rpc/Script.Eval?id={scriptId}&code=getStatus()` at 10s interval. Compares valve states (v1, v2) against previous poll. Emits a callback on change with `{valve, state, mode, timestamp}`. Skips first poll (no previous state). Skips comparison on poll error (retains previous state). Reads `CONTROLLER_IP` and `CONTROLLER_SCRIPT_ID` env vars. Exports: `start(onChange)`, `stop()`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Unit tests for the new modules — MUST pass before user story implementation begins

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T004 [P] Write unit tests in tests/push-storage.test.js — test loadVapidKeys returns null when no data, saveVapidKeys round-trips data, addSubscription appends and deduplicates by endpoint, removeSubscription removes by endpoint and returns boolean, loadSubscriptions returns empty array when no data. Use local filesystem fallback mode (no S3 env vars)
- [x] T005 [P] Write unit tests in tests/valve-poller.test.js — test that: first poll stores baseline without calling onChange, second poll with same state does not call onChange, second poll with v1 changed calls onChange with correct payload, poll error retains previous state without calling onChange, stop() clears the interval. Mock HTTP calls to Shelly controller
- [x] T006 Run `npm run test:unit` and verify all existing + new tests pass

**Checkpoint**: Foundation ready — push-storage and valve-poller modules work correctly in isolation

---

## Phase 3: User Story 1 — Install Monitor as App (Priority: P1) MVP

**Goal**: Add PWA manifest, service worker, and icons so the monitor is installable as a standalone app

**Independent Test**: Visit the PoC URL in Chrome, verify install prompt appears, install the app, and confirm standalone launch with correct name and theme

### Implementation for User Story 1

- [x] T007 [P] [US1] Create PWA manifest in poc/manifest.json — name: "Greenhouse Monitor", short_name: "Monitor", start_url: "/", display: "standalone", theme_color and background_color matching poc/css/style.css, icons array pointing to /icons/icon-192.png and /icons/icon-512.png
- [x] T008 [P] [US1] Create PWA icons in poc/icons/ — generate icon-192.png (192x192) and icon-512.png (512x512). Simple green/plant-themed placeholder icons (can be programmatically generated or minimal SVG-to-PNG)
- [x] T009 [P] [US1] Create service worker in poc/sw.js — handle `install` event (skip waiting), `activate` event (claim clients), `push` event (parse JSON payload, call `self.registration.showNotification(title, options)`), `notificationclick` event (focus existing client or open new window to `/`). No fetch interception or offline caching
- [x] T010 [US1] Add manifest link and service worker registration to poc/index.html — add `<link rel="manifest" href="/manifest.json">` in `<head>`, add `<meta name="theme-color">` tag, add SW registration script in a `<script>` block after page load: `navigator.serviceWorker.register('/sw.js')`
- [x] T011 [US1] Add `.webmanifest` MIME type to MIME map in poc/server.js and ensure `/manifest.json` is served with `application/manifest+json` content type
- [x] T012 [US1] Update npm test script in package.json to include `node tests/push-storage.test.js && node tests/valve-poller.test.js` in both `test` and `test:unit` commands

**Checkpoint**: The monitor app is installable as a PWA. Service worker is registered. No push functionality yet but the SW is ready to receive push events.

---

## Phase 4: User Story 2 — Subscribe to Valve Change Notifications (Priority: P1)

**Goal**: Users can subscribe/unsubscribe to push notifications via UI. Server stores subscriptions in S3.

**Independent Test**: Click subscribe button, grant permission, verify subscription stored on server via API. Refresh page, verify UI shows subscribed state. Unsubscribe, verify removed.

### Implementation for User Story 2

- [x] T013 [P] [US2] Create browser-side push module in poc/js/push.js — ES module that exports: `async subscribe(vapidPublicKey)` (calls `pushManager.subscribe()`, POSTs to `/api/push/subscribe`), `async unsubscribe()` (calls `pushSubscription.unsubscribe()`, POSTs to `/api/push/unsubscribe`), `async getSubscriptionState()` (returns current subscription from `pushManager.getSubscription()`), `async getVapidKey()` (fetches from `/api/push/vapid-public-key`)
- [x] T014 [P] [US2] Add push API endpoints to poc/server.js — `GET /api/push/vapid-public-key` (returns public key from push-storage), `POST /api/push/subscribe` (validates body, calls addSubscription), `POST /api/push/unsubscribe` (calls removeSubscription). All behind existing auth gate. Initialize VAPID keys on server startup: load from S3, generate if missing, save back. Use `web-push.setVapidDetails()` to configure the library
- [x] T015 [US2] Add notification subscribe/unsubscribe UI to poc/index.html — add a notification toggle section (button + status text) below the connection bar. Import poc/js/push.js. On page load, check subscription state and update button text ("Subscribe" / "Unsubscribe"). On click: subscribe or unsubscribe accordingly. Show error message if permission denied. Add minimal styles to poc/css/style.css for the notification toggle
- [x] T016 [US2] Wire push.js into poc/js/app.js — after service worker registration succeeds, check if push is supported (`'PushManager' in window`), then initialize the notification UI by calling into push.js functions

**Checkpoint**: Users can subscribe and unsubscribe. Subscriptions are persisted in S3. No notifications sent yet.

---

## Phase 5: User Story 3 — Receive Valve Change Notification (Priority: P1)

**Goal**: Server polls Shelly controller, detects valve changes, sends push notifications to all subscribers

**Independent Test**: Subscribe to notifications, trigger a valve state change (via override), verify push notification appears within ~10 seconds

### Implementation for User Story 3

- [x] T017 [US3] Integrate valve poller into poc/server.js — import valve-poller.js, start polling on server startup if `CONTROLLER_IP` is set. On valve change callback: load subscriptions from push-storage, send notification to each via `web-push.sendNotification()`. Build payload per contracts/push-api.md format (`{title, body, tag, data}`). On send failure with status 404 or 410: remove stale subscription via `removeSubscription()`
- [x] T018 [US3] Add notification payload handling to poc/sw.js — in the `push` event listener, parse the JSON payload, extract `title` and build notification options (`body`, `tag`, `icon`, `data`). In `notificationclick`, use `clients.matchAll()` to find and focus existing window, or `clients.openWindow('/')` if none open
- [x] T019 [US3] Log valve polling and notification events in poc/server.js — use existing logger (`createLogger('push')`) to log: poller start/stop, valve state changes detected, notifications sent (count), stale subscriptions removed, poll errors

**Checkpoint**: Full push notification flow works end-to-end. Valve changes trigger notifications to all subscribers.

---

## Phase 6: User Story 4 — Unsubscribe from Notifications (Priority: P2)

**Goal**: Users can opt out and stop receiving notifications

**Independent Test**: Subscribe, verify notifications arrive, unsubscribe, trigger valve change, verify no notification

### Implementation for User Story 4

- [x] T020 [US4] Verify unsubscribe flow end-to-end — the unsubscribe UI (T015) and API endpoint (T014) are already implemented in Phase 4. This task validates that after unsubscribing: the subscription is removed from S3, the server no longer sends notifications to that endpoint, and re-subscribing creates a fresh subscription. Fix any issues found during validation

**Checkpoint**: Complete subscribe/unsubscribe lifecycle works. Users can opt in and out freely.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Deployment config, documentation, final validation

- [x] T021 [P] Update deploy/docker/Dockerfile — ensure `npm install` picks up the new `web-push` dependency
- [x] T022 [P] Update deploy/deployer/docker-compose.yml — add `CONTROLLER_IP`, `CONTROLLER_SCRIPT_ID`, and `VAPID_SUBJECT` environment variables to the app service
- [x] T023 [P] Update CLAUDE.md — document new files (manifest.json, sw.js, push.js, push-storage.js, valve-poller.js), new env vars (CONTROLLER_IP, CONTROLLER_SCRIPT_ID, VAPID_SUBJECT), new S3 keys (push-config.json, push-subscriptions.json), and new test files
- [x] T024 Run full test suite (`npm test`) and verify all tests pass including existing ones
- [x] T025 Run quickstart.md validation — start server with `CONTROLLER_IP` set, verify PWA manifest loads, service worker registers, subscribe flow works, and VAPID keys persist in S3/local storage

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on T002, T003 from Setup — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 completion — no dependencies on other stories
- **US2 (Phase 4)**: Depends on Phase 2 + US1 (needs SW registered from T010 for pushManager access)
- **US3 (Phase 5)**: Depends on Phase 2 + US2 (needs subscribe endpoints and stored subscriptions)
- **US4 (Phase 6)**: Depends on US3 (needs working notification delivery to validate unsubscribe stops notifications)
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (Install as App)**: Independent — only needs foundational modules
- **US2 (Subscribe)**: Depends on US1 (service worker must be registered for PushManager)
- **US3 (Receive Notifications)**: Depends on US2 (subscriptions must exist to send notifications to)
- **US4 (Unsubscribe)**: Depends on US3 (needs working notifications to validate opt-out)

**Note**: Unlike typical features, these user stories have a linear dependency chain because each builds on the previous capability.

### Within Each User Story

- Models/modules before services
- Server endpoints before client integration
- Core implementation before UI wiring

### Parallel Opportunities

- **Phase 1**: T002 and T003 can run in parallel (different files, no shared state)
- **Phase 2**: T004 and T005 can run in parallel (different test files)
- **Phase 3**: T007, T008, T009 can run in parallel (manifest, icons, SW are independent files)
- **Phase 4**: T013 and T014 can run in parallel (browser module + server endpoints are independent)
- **Phase 7**: T021, T022, T023 can run in parallel (different config files)

---

## Parallel Example: Phase 3 (User Story 1)

```bash
# Launch these three tasks in parallel (all create new, independent files):
Task: "Create PWA manifest in poc/manifest.json"
Task: "Create PWA icons in poc/icons/"
Task: "Create service worker in poc/sw.js"

# Then sequentially:
Task: "Add manifest link and SW registration to poc/index.html"
Task: "Add manifest MIME type to poc/server.js"
Task: "Update test scripts in package.json"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. Complete Phase 2: Foundational tests (T004–T006)
3. Complete Phase 3: US1 — Install as App (T007–T012)
4. **STOP and VALIDATE**: Verify PWA installability in Chrome DevTools
5. Deploy if ready — app is installable even without push notifications

### Incremental Delivery

1. Setup + Foundational → Modules tested in isolation
2. Add US1 → PWA installable, SW registered (MVP!)
3. Add US2 → Subscribe flow works, subscriptions stored in S3
4. Add US3 → Valve changes trigger push notifications
5. Add US4 → Validate full subscribe/unsubscribe lifecycle
6. Polish → Deployment config, docs, final validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- User stories have linear dependencies (US1 → US2 → US3 → US4) due to the nature of the feature
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- The valve-poller module is the only component that interacts with Shelly hardware — all other components are standard Web Push
