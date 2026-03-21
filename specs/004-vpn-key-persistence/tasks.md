# Tasks: VPN Key Persistence

**Input**: Design documents from `/specs/004-vpn-key-persistence/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md

**Tests**: Included — unit tests for the S3 helper script (proportional coverage per constitution principle IV).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Add the VPN config S3 helper and environment variable

- [x] T001 Create VPN config S3 helper script in poc/lib/vpn-config.js — CLI that accepts `download <path>` and `upload <path>` commands, reuses S3 client config from existing env vars, uses `VPN_CONFIG_KEY` (default: `wg0.conf`) as object key
- [x] T002 [P] Add `VPN_CONFIG_KEY` env var to deploy/terraform/cloud-init.yaml in the .env template (default: `wg0.conf`)

---

## Phase 2: Foundational (Unit Tests)

**Purpose**: Tests for the S3 helper — must pass before integration into deployer

- [x] T003 Create unit tests for vpn-config.js in tests/vpn-config.test.js — test download (S3 hit, S3 miss, S3 error), upload (success, already-exists skip, S3 error), and CLI argument parsing. Mock S3 calls following the pattern in tests/s3-storage.test.js

**Checkpoint**: vpn-config.js works correctly in isolation (`npm run test:unit` passes)

---

## Phase 3: User Story 1 - Survive Server Recreation (Priority: P1) — MVP

**Goal**: Deployer downloads VPN config from S3 on every run, so a recreated server gets the config automatically.

**Independent Test**: Destroy and recreate server; verify VPN tunnel re-establishes without manual steps.

### Implementation for User Story 1

- [x] T004 [US1] Add VPN config download step to deploy/deployer/deploy.sh — after image pull (step 3), run `docker run --rm --env-file "$APP_DIR/.env" -v "$APP_DIR:/opt/app" "$APP_IMAGE" node poc/lib/vpn-config.js download /opt/app/wg0.conf`. Log result. Continue on failure (non-fatal).
- [x] T005 [US1] Determine APP_IMAGE name in deploy/deployer/deploy.sh — extract the app image reference from docker-compose.yml (e.g., via `docker compose config` or grep) so the one-shot container uses the correct image.
- [x] T006 [US1] Handle S3 download errors gracefully in deploy/deployer/deploy.sh — if the docker run command fails (S3 unreachable, image issue), log a warning and continue deployment without VPN config.

**Checkpoint**: Deployer restores VPN config from S3 on fresh server. Existing deploys without VPN unaffected.

---

## Phase 4: User Story 2 - Initial Key Provisioning (Priority: P2)

**Goal**: When an operator places a `wg0.conf` on the server, the deployer uploads it to S3 for future rebuilds.

**Independent Test**: Place a wg0.conf on server, run deployer, verify config appears in S3.

### Implementation for User Story 2

- [x] T007 [US2] Add VPN config upload step to deploy/deployer/deploy.sh — after download step, check if `/opt/app/wg0.conf` exists locally. If yes, run upload via `docker run --rm --env-file "$APP_DIR/.env" -v "$APP_DIR:/opt/app" "$APP_IMAGE" node poc/lib/vpn-config.js upload /opt/app/wg0.conf`. The script should skip upload if S3 already has the config (avoid unnecessary writes).
- [x] T008 [US2] Handle upload errors gracefully in deploy/deployer/deploy.sh — log warning on failure, continue deployment.

**Checkpoint**: Full round-trip works: operator places config → deployer uploads to S3 → server recreated → deployer downloads from S3 → VPN starts.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and validation

- [x] T009 [P] Update CLAUDE.md to document vpn-config.js and the VPN persistence flow
- [x] T010 [P] Update deploy/wireguard/wg0.conf.example comments to mention S3 persistence (config is now automatically persisted after first manual setup)
- [x] T011 Run full test suite (`npm test`) and verify all existing tests still pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — T001 and T002 can run in parallel
- **Foundational (Phase 2)**: T003 depends on T001 (tests need the script)
- **US1 (Phase 3)**: T004-T006 depend on T001 (need vpn-config.js) and T003 (tests should pass first)
- **US2 (Phase 4)**: T007-T008 depend on T004-T006 (upload logic builds on download flow in deploy.sh)
- **Polish (Phase 5)**: T009-T011 depend on all implementation being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Phase 2 — no dependency on US2
- **User Story 2 (P2)**: Builds on deploy.sh changes from US1 (same file), so should follow US1

### Parallel Opportunities

- T001 and T002 can run in parallel (different files)
- T009 and T010 can run in parallel (different files)
- T004 and T005 touch the same file (deploy.sh), so must be sequential

---

## Parallel Example: Phase 1 Setup

```bash
# Launch both setup tasks together:
Task: "Create VPN config S3 helper in poc/lib/vpn-config.js"
Task: "Add VPN_CONFIG_KEY env var to deploy/terraform/cloud-init.yaml"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001, T002)
2. Complete Phase 2: Tests (T003)
3. Complete Phase 3: US1 — Download flow (T004-T006)
4. **STOP and VALIDATE**: Deploy to server, verify download from S3 works
5. Server recreation now restores VPN config automatically

### Incremental Delivery

1. Setup + Tests → Foundation ready
2. Add US1 (download) → Server recreation works → Deploy (MVP!)
3. Add US2 (upload) → Bootstrap works → Deploy
4. Polish → Docs updated, all tests pass

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- The vpn-config.js script is a CLI tool, not a library — it exits with code 0 on success, non-zero on failure
- deploy.sh changes must preserve the existing non-fatal error handling pattern (log + continue)
- All S3 operations reuse existing env vars (S3_ENDPOINT, S3_BUCKET, etc.) — no new credentials needed
