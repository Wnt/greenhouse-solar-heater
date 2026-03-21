# Tasks: Organize Repository Structure

**Input**: Design documents from `/specs/006-organize-repo-structure/`
**Prerequisites**: plan.md (required), spec.md (required), research.md

**Tests**: No new tests — this is a structural reorganization. Existing tests must pass after all moves.

**Organization**: US1 (Navigate to logical units) and US2 (Everything keeps working) are inseparable — directory moves and cross-reference updates deliver both simultaneously. They share phases. US3 (Documentation) is independent.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

---

## Phase 1: Foundational — Directory Moves

**Purpose**: Execute all `git mv` operations to establish the new directory structure. No cross-reference updates yet — those come in Phase 2.

**⚠️ CRITICAL**: All moves must complete before cross-reference updates begin. Use `git mv` to preserve history.

- [ ] T001 Move `scripts/` contents to `shelly/` — `git mv scripts/control.js scripts/control-logic.js scripts/deploy.sh scripts/devices.conf` to `shelly/`
- [ ] T002 Move `tools/shelly-lint/` to `shelly/lint/` — `git mv tools/shelly-lint` to `shelly/lint`, then remove empty `tools/` directory
- [ ] T003 Move `poc/` to `monitor/` — `git mv poc monitor`
- [ ] T004 [P] Move `docs/` to `design/docs/` — `git mv docs design/docs`
- [ ] T005 [P] Move `diagrams/` to `design/diagrams/` — `git mv diagrams design/diagrams`
- [ ] T006 [P] Move `construction/` to `design/construction/` — `git mv construction design/construction`
- [ ] T007 [P] Move `existing-hardware/` to `design/photos/` — `git mv existing-hardware design/photos`

**Checkpoint**: All directories moved. `ls` shows: `shelly/`, `playground/`, `monitor/`, `deploy/`, `design/`, `tests/` plus root files. Tests will NOT pass yet (broken cross-references).

---

## Phase 2: US1+US2 — Cross-Reference Updates (Priority: P1) 🎯 MVP

**Goal**: Update every file path reference so all tests, CI, Docker builds, and GH Pages work with the new structure.

**Independent Test**: Run `npm run test:unit` — all unit and simulation tests pass.

### Move 1 cross-refs: scripts/ → shelly/

- [ ] T008 [P] [US2] Update require path in `tests/control-logic.test.js` — change `../scripts/control-logic.js` to `../shelly/control-logic.js`
- [ ] T009 [P] [US2] Update require path in `tests/simulation/simulator.js` — change `../../scripts/control-logic.js` to `../../shelly/control-logic.js`
- [ ] T010 [P] [US2] Update require path in `tests/simulation/scenarios.js` — change `../../scripts/control-logic.js` to `../../shelly/control-logic.js`
- [ ] T011 [P] [US2] Update require paths in `tests/deploy.test.js` — change `../scripts/deploy.sh` to `../shelly/deploy.sh` and `../scripts/devices.conf` to `../shelly/devices.conf`

### Move 2 cross-refs: tools/shelly-lint/ → shelly/lint/ + scripts/ → shelly/ (CI workflow)

- [ ] T012 [US2] Update `.github/workflows/lint-shelly.yml` — change all path references: `scripts/**` → `shelly/**`, `tools/shelly-lint/**` → `shelly/lint/**`, working-directory `tools/shelly-lint` → `shelly/lint`, linter command `node tools/shelly-lint/bin/shelly-lint.js` → `node shelly/lint/bin/shelly-lint.js`, target files `scripts/control-logic.js` → `shelly/control-logic.js` and `scripts/control.js` → `shelly/control.js`

### Move 3 cross-refs: poc/ → monitor/

- [ ] T013 [P] [US2] Update `deploy/docker/Dockerfile` — change `COPY poc/ ./poc/` to `COPY monitor/ ./monitor/` and `CMD ["node", "poc/server.js"]` to `CMD ["node", "monitor/server.js"]`
- [ ] T014 [P] [US2] Update `deploy/deployer/deploy.sh` — change both occurrences of `node poc/lib/vpn-config.js` to `node monitor/lib/vpn-config.js`
- [ ] T015 [P] [US2] Update require path in `tests/auth.test.js` — change `../poc/auth/session` to `../monitor/auth/session`
- [ ] T016 [P] [US2] Update require path in `tests/s3-storage.test.js` — change `../poc/lib/s3-storage` to `../monitor/lib/s3-storage`
- [ ] T017 [P] [US2] Update require path in `tests/vpn-config.test.js` — change `../poc/lib/vpn-config` to `../monitor/lib/vpn-config`
- [ ] T018 [P] [US2] Update require path in `tests/push-storage.test.js` — change `../poc/lib/push-storage` to `../monitor/lib/push-storage`
- [ ] T019 [P] [US2] Update require path in `tests/valve-poller.test.js` — change `../poc/lib/valve-poller` to `../monitor/lib/valve-poller`
- [ ] T020 [P] [US2] Update URL path in `tests/e2e/poc-login.spec.js` — change `/poc/login.html` to `/monitor/login.html`
- [ ] T021 [P] [US2] Update URL path in `tests/e2e/logout.spec.js` — change `/poc/` to `/monitor/`
- [ ] T022 [P] [US2] Update link in `playground/index.html` — change `../poc/index.html` to `../monitor/index.html`

### .dockerignore consolidation

- [ ] T023 [US1] Update `.dockerignore` — replace `scripts/` with `shelly/`, remove `tools/`, replace `docs/` with `design/`, remove `diagrams/`, `construction/`, `existing-hardware/` (now inside `design/`), replace `!poc/**/*.md` with `!monitor/**/*.md`

### Verification

- [ ] T024 [US2] Run `npm run test:unit` to verify all unit and simulation tests pass with updated paths
- [ ] T025 [US2] Run `npm run test:e2e` to verify all e2e tests pass with updated paths

**Checkpoint**: All tests pass. Directory structure is clean. CI workflows, Docker builds, and GH Pages config reference correct paths.

---

## Phase 3: US3 — Documentation Updates (Priority: P2)

**Goal**: CLAUDE.md and README.md accurately describe the new repository structure with no stale path references.

**Independent Test**: Grep CLAUDE.md and README.md for old directory names (`scripts/`, `tools/`, `poc/`, `docs/`, `diagrams/`, `construction/`, `existing-hardware/`) — zero matches.

- [ ] T026 [US3] Rewrite the "File Relationships" section in `CLAUDE.md` — update all directory paths to reflect new structure (`shelly/`, `monitor/`, `design/docs/`, `design/diagrams/`, `design/construction/`, `design/photos/`, `shelly/lint/`)
- [ ] T027 [US3] Update "Shelly Control Scripts" section in `CLAUDE.md` — change all `scripts/` references to `shelly/`
- [ ] T028 [US3] Update "Shelly Linter" section in `CLAUDE.md` — change `tools/shelly-lint/` references to `shelly/lint/`
- [ ] T029 [US3] Update "PoC Temperature Monitor" section in `CLAUDE.md` — rename section to "Temperature Monitor", change all `poc/` references to `monitor/`
- [ ] T030 [US3] Update "Playground Architecture" section in `CLAUDE.md` — verify paths are still correct (playground/ unchanged, but cross-links to monitor/)
- [ ] T031 [US3] Update "Running Tests" and "Test Structure" sections in `CLAUDE.md` — update any test file paths that reference old directories
- [ ] T032 [US3] Update "SVG Diagram Conventions" section in `CLAUDE.md` — change `diagrams/` references to `design/diagrams/`
- [ ] T033 [US3] Update "Cloud Deployment Architecture" section in `CLAUDE.md` — verify deploy paths still correct, update any `poc/` references to `monitor/`
- [ ] T034 [US3] Update "Platform Constraints" references in `CLAUDE.md` — change `scripts/devices.conf` to `shelly/devices.conf`, `tools/shelly-lint/` to `shelly/lint/`, `playground/vendor/` stays
- [ ] T035 [US3] Update `README.md` — update any directory structure descriptions or path references to match new layout
- [ ] T036 [US3] Update constitution path references in `.specify/memory/constitution.md` — change `tools/shelly-lint/` to `shelly/lint/`, `poc/lib/s3-storage.js` to `monitor/lib/s3-storage.js`, `scripts/devices.conf` to `shelly/devices.conf`

**Checkpoint**: All documentation accurately reflects the new structure.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Final verification and cleanup

- [ ] T037 Verify no remaining references to old directory names in any source file — grep for `scripts/control`, `tools/shelly-lint`, `poc/`, `docs/design.md`, `diagrams/`, `construction/`, `existing-hardware/` across the entire repo
- [ ] T038 Run full test suite `npm test` (unit + simulation + e2e) to confirm zero regressions
- [ ] T039 Run quickstart.md verification steps to validate the reorganization

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Foundational)**: No dependencies — start immediately. T004-T007 can run in parallel.
- **Phase 2 (US1+US2)**: Depends on Phase 1 completion. Most cross-ref tasks (T008-T022) can run in parallel since they edit different files.
- **Phase 3 (US3)**: Depends on Phase 2 completion (need final paths to document correctly).
- **Phase 4 (Polish)**: Depends on Phase 3 completion.

### User Story Dependencies

- **US1+US2 (P1)**: Delivered together by Phase 1 + Phase 2. Cannot be separated — structure and functionality are interdependent.
- **US3 (P2)**: Independent of US1+US2 implementation but depends on knowing the final structure.

### Within Phase 2

- T008-T011 (Move 1 cross-refs): All parallel — different test files
- T012 (Move 2 cross-refs): Single CI workflow file, no conflicts
- T013-T022 (Move 3 cross-refs): All parallel — different files
- T023 (.dockerignore): Independent file
- T024-T025 (verification): Sequential, after all cross-ref edits

### Parallel Opportunities

```
Phase 1 parallel group:
  T004 (docs → design/docs)
  T005 (diagrams → design/diagrams)
  T006 (construction → design/construction)
  T007 (existing-hardware → design/photos)

Phase 2 parallel group (after Phase 1):
  T008, T009, T010, T011  (shelly cross-refs)
  T013-T022               (monitor cross-refs)
  T012                    (CI workflow)
  T023                    (.dockerignore)
```

---

## Implementation Strategy

### MVP First (Phase 1 + Phase 2)

1. Complete Phase 1: Move all directories
2. Complete Phase 2: Update all cross-references
3. **STOP and VALIDATE**: Run `npm test` — all tests must pass
4. This delivers both US1 and US2 (P1 stories)

### Incremental Delivery

1. Phase 1 + Phase 2 → Structure clean, everything works (MVP!)
2. Phase 3 → Documentation accurate
3. Phase 4 → Final verification complete

---

## Notes

- All `git mv` operations preserve history — do NOT use `mv` + `git add`
- T001 and T002 must be sequential (T001 creates `shelly/`, T002 moves lint into it)
- T003 is independent and can run alongside T001+T002
- T004-T007 require creating `design/` first, then moving subdirectories into it
- The `design/` directory is new — create it before moving contents
- After Phase 1, the repo will be in a broken state (tests fail) — this is expected
- Commit after each phase, not after each task
