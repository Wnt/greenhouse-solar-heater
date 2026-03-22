# Tasks: Add Home Screen Support

**Input**: Design documents from `/specs/009-add-home-screen-support/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: Test tasks are included per Constitution Principle IV (Proportional Test Coverage).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: No new project setup needed — this feature modifies existing files only.

*No setup tasks required.*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core changes that MUST be complete before user story features work correctly.

**⚠️ CRITICAL**: Both user stories depend on the auth whitelist and manifest updates.

- [x] T001 Whitelist PWA resources in auth gate — add `/manifest.json`, `/sw.js`, `/offline.html`, and `/icons/*` paths to the unauthenticated route list in `monitor/server.js` (around line 274)
- [x] T002 [P] Add `id` field (`"/"`) and `"purpose": "any maskable"` to the 512px icon entry in `monitor/manifest.json`

**Checkpoint**: PWA resources are accessible without authentication; manifest is complete for installability.

---

## Phase 3: User Story 1 — Install from Android Browser (Priority: P1) 🎯 MVP

**Goal**: Chrome on Android recognizes the app as installable and users can add it to their home screen.

**Independent Test**: Open the monitor URL in Chrome on Android → browser shows install prompt → install → app launches in standalone mode from home screen.

### Implementation for User Story 1

- [x] T003 [US1] Add service worker fetch handler to `monitor/sw.js` — use network-first strategy for navigation requests, falling back to cached `/offline.html` when network fails; pass through non-navigation requests unchanged; preserve existing push notification handlers
- [x] T004 [P] [US1] Add offline page pre-caching to `monitor/sw.js` install event — cache `/offline.html` and `/icons/icon-192.png` in a named cache (e.g., `greenhouse-offline-v1`); keep existing `skipWaiting()` call
- [x] T005 [P] [US1] Create branded offline fallback page at `monitor/offline.html` — display app name "Greenhouse Monitor", "You are offline" message, retry button, auto-retry with `navigator.onLine` check, styled to match `monitor/css/style.css` theme

**Checkpoint**: App is installable on Android. Offline fallback works. Push notifications still function.

---

## Phase 4: User Story 2 — Install from iOS Safari (Priority: P1)

**Goal**: Safari on iOS shows correct icon and name when adding to home screen, and app launches in standalone mode.

**Independent Test**: Open the monitor URL in Safari on iOS → Share → "Add to Home Screen" → correct icon/name → launches in standalone mode.

### Implementation for User Story 2

- [x] T006 [P] [US2] Add Apple meta tags to `monitor/index.html` `<head>` — add `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style` (value: `default`), and `apple-touch-icon` link pointing to `/icons/icon-192.png`
- [x] T007 [P] [US2] Add PWA metadata to `monitor/login.html` `<head>` — add `<link rel="manifest" href="/manifest.json">`, `<meta name="theme-color" content="#0056b2">`, and the same Apple meta tags as index.html

**Checkpoint**: App is installable on iOS with correct icon, name, and standalone mode. Login page also has full PWA metadata.

---

## Phase 5: User Story 3 — Offline Feedback (Priority: P2)

**Goal**: When offline, installed app shows a branded offline page instead of a browser error.

**Independent Test**: Install app → disconnect from network → open app → see branded offline page → reconnect → page auto-reloads.

### Implementation for User Story 3

*All implementation tasks for offline support are already covered by T003, T004, and T005 in Phase 3. This user story is satisfied by the Android installability work.*

**Checkpoint**: Offline fallback page displays when server is unreachable; auto-retries when connectivity returns.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Testing, validation, and documentation updates.

- [x] T008 [P] Write unit tests for SW fetch handler logic in `tests/sw.test.js` — test that navigation requests fall back to offline page on network error; test that non-navigation requests pass through; test that push handlers are preserved
- [x] T009 [P] Write e2e test for PWA installability in `tests/e2e/pwa.spec.js` — verify manifest link present, SW registered, apple meta tags present on index.html and login.html, offline page served when server unreachable
- [x] T010 Run full test suite (`npm test`) and fix any regressions
- [x] T011 [P] Update `CLAUDE.md` to document offline.html, SW fetch handler, and Apple meta tags in the File Relationships and Temperature Monitor sections
- [x] T012 Run quickstart.md validation — verify all manual test scenarios from `specs/009-add-home-screen-support/quickstart.md`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No dependencies — can start immediately
- **User Story 1 (Phase 3)**: Depends on T001 (auth whitelist) and T002 (manifest update)
- **User Story 2 (Phase 4)**: Depends on T001 (auth whitelist) and T002 (manifest update); can run in parallel with Phase 3
- **User Story 3 (Phase 5)**: Satisfied by Phase 3 tasks — no additional work
- **Polish (Phase 6)**: Depends on Phases 3 and 4 completion

### User Story Dependencies

- **User Story 1 (P1)**: Depends on Foundational only — no dependencies on other stories
- **User Story 2 (P1)**: Depends on Foundational only — independent of User Story 1
- **User Story 3 (P2)**: Fully covered by User Story 1 implementation — no additional tasks

### Parallel Opportunities

- T001 and T002 can run in parallel (different files)
- T003/T004/T005 — T004 and T005 are parallel (different files); T003 can be combined with T004 since both modify sw.js
- T006 and T007 can run in parallel (different files)
- Phase 3 and Phase 4 can run in parallel after Phase 2 completes
- T008, T009, and T011 can all run in parallel (different files)

---

## Parallel Example: Foundational + User Stories

```bash
# Phase 2 — run in parallel:
Task T001: "Whitelist PWA resources in monitor/server.js"
Task T002: "Update manifest.json with id and maskable purpose"

# After Phase 2, run Phase 3 and Phase 4 in parallel:
# Phase 3 (Android):
Task T003: "Add fetch handler to monitor/sw.js"
Task T004: "Add offline pre-caching to monitor/sw.js"  # combine with T003
Task T005: "Create monitor/offline.html"                # parallel with T003/T004

# Phase 4 (iOS) — parallel with Phase 3:
Task T006: "Add Apple meta tags to monitor/index.html"
Task T007: "Add PWA metadata to monitor/login.html"     # parallel with T006
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational (T001, T002)
2. Complete Phase 3: User Story 1 (T003–T005)
3. **STOP and VALIDATE**: App installable on Android, offline fallback works
4. This also completes User Story 3 (offline feedback)

### Incremental Delivery

1. Phase 2 → Foundational ready
2. Phase 3 → Android install + offline fallback → Test → **MVP complete**
3. Phase 4 → iOS install → Test → **Full feature complete**
4. Phase 6 → Tests, docs, validation → **Production ready**

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- T003 and T004 both modify `monitor/sw.js` — implement together to avoid conflicts
- User Story 3 requires no additional implementation beyond User Story 1
- Total: 12 tasks (2 foundational, 3 US1, 2 US2, 0 US3, 5 polish)
