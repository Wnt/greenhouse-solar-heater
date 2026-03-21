# Tasks: Mutable Server Configuration

**Input**: Design documents from `/specs/005-fix-vpn-immutable-config/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md

**Tests**: Not explicitly requested in the specification. Verification is via `terraform plan` output and deployer behavior. No automated test tasks included.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the new config file and update the deployer image to include it

- [x] T001 Create mutable service config file at `deploy/deployer/config.env` with all non-secret environment variables (PORT, AUTH_ENABLED, RPID, ORIGIN, DOMAIN, GITHUB_REPO, VPN_CHECK_HOST, VPN_CONFIG_KEY, SETUP_WINDOW_MINUTES, NODE_ENV, COMPOSE_PROFILES) using placeholder values for domain/repo
- [x] T002 Update deployer image to include config.env by adding `COPY config.env /config/config.env` to `deploy/deployer/Dockerfile`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Implement the deployer merge logic that combines secrets and config into a single `.env` file. This is the core mechanism that all user stories depend on.

**CRITICAL**: No user story work can begin until this phase is complete

- [x] T003 Add env merge step to `deploy/deployer/deploy.sh`: copy `config.env` from image to host, then merge `.env.secrets` + `config.env` → `.env` (secrets win on duplicate keys). Must use POSIX shell (Alpine). Must handle legacy fallback: if `.env.secrets` does not exist but `.env` does, skip merge and use existing `.env` as-is.

**Checkpoint**: Deployer can now merge two config sources into a single `.env`. Legacy servers continue working unchanged.

---

## Phase 3: User Story 1 - Enable VPN Without Server Recreation (Priority: P1) MVP

**Goal**: Decouple VPN enablement from server lifecycle. Toggling `enable_vpn` changes only firewall rules and deployer config — never the server resource.

**Independent Test**: Run `terraform plan -var="enable_vpn=true"` and confirm zero changes to `upcloud_server.monitor`. Only `upcloud_firewall_rules.monitor` should change.

### Implementation for User Story 1

- [x] T004 [P] [US1] Update `deploy/terraform/cloud-init.yaml`: change file path from `/opt/app/.env` to `/opt/app/.env.secrets`, remove all non-secret variables (PORT, AUTH_ENABLED, RPID, ORIGIN, DOMAIN, GITHUB_REPO, VPN_CHECK_HOST, VPN_CONFIG_KEY, SETUP_WINDOW_MINUTES, NODE_ENV), keep only SESSION_SECRET, S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION
- [x] T005 [P] [US1] Update `deploy/terraform/main.tf` templatefile call: remove `domain`, `github_repo`, `vpn_check_host` from template variables passed to cloud-init.yaml, keep only secret-related variables (session_secret, s3_endpoint, s3_bucket, s3_access_key_id, s3_secret_key, s3_region)
- [x] T006 [US1] Verify terraform validates: run `terraform validate` in `deploy/terraform/` to confirm the HCL is syntactically correct after the template variable removal

**Checkpoint**: Cloud-init now writes only secrets. `enable_vpn` changes cannot trigger server recreation. VPN toggle works: firewall via Terraform, container via `COMPOSE_PROFILES` in `deploy/deployer/config.env`.

---

## Phase 4: User Story 2 - Add New Components Without Server Recreation (Priority: P2)

**Goal**: Ensure the config split architecture is extensible — adding any new service-level environment variable or optional component follows the same pattern without modifying cloud-init.

**Independent Test**: Add a hypothetical new variable to `deploy/deployer/config.env` and confirm `terraform plan` shows no server changes.

### Implementation for User Story 2

- [x] T007 [US2] Review `deploy/deployer/config.env` and add inline comments documenting the purpose of each variable and how to add new ones (operator guidance for future extensibility)
- [x] T008 [US2] Update GitHub Actions CD workflow (`.github/workflows/deploy.yml`) if needed: ensure the deployer image build includes `config.env`. If `GITHUB_REPO` should be injected at build time via Docker build arg rather than hardcoded, add `ARG GITHUB_REPO` to `deploy/deployer/Dockerfile` and pass it from the workflow

**Checkpoint**: Any future service-level config change can be made by editing `deploy/deployer/config.env` and pushing — no cloud-init or Terraform server changes needed.

---

## Phase 5: User Story 3 - Maintain Security of Secrets (Priority: P2)

**Goal**: Verify that the config split does not weaken security. Secrets must never appear in the deployer image, git repository, or container logs.

**Independent Test**: Inspect `deploy/deployer/config.env` and `deploy/deployer/Dockerfile` to confirm no secret values are present. Verify `.env.secrets` permissions remain 0600 in cloud-init.

### Implementation for User Story 3

- [x] T009 [US3] Audit `deploy/deployer/config.env` to confirm it contains zero secret values (no SESSION_SECRET, no S3_ACCESS_KEY_ID, no S3_SECRET_ACCESS_KEY). Add a comment header warning not to add secrets to this file.
- [x] T010 [US3] Verify `deploy/terraform/cloud-init.yaml` preserves `permissions: "0600"` on the `.env.secrets` file and that the file ownership is correct (deploy user, not root)
- [x] T011 [US3] Verify the merge logic in `deploy/deployer/deploy.sh` does not log secret values — ensure the merge step does not echo `.env.secrets` contents to stdout

**Checkpoint**: Security posture is equivalent or better than the original single `.env` approach.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Documentation updates and final validation

- [x] T012 Update `CLAUDE.md` to document the new config architecture: `.env.secrets` (cloud-init, secrets only), `config.env` (deployer image, mutable service config), `.env` (deployer merge output, consumed by Docker Compose). Update the File Relationships and Cloud Deployment Architecture sections.
- [x] T013 Update `specs/005-fix-vpn-immutable-config/quickstart.md` with actual domain and repo values once config.env is finalized
- [x] T014 Validate the full flow end-to-end: confirm `terraform plan` with `enable_vpn=true` shows zero server changes, only firewall rule changes

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup (T001, T002) — BLOCKS all user stories
- **User Story 1 (Phase 3)**: Depends on Foundational (T003) — core VPN decoupling
- **User Story 2 (Phase 4)**: Depends on Foundational (T003) — can run in parallel with US1
- **User Story 3 (Phase 5)**: Depends on US1 (T004, T005) and Foundational (T003) — security audit of the final state
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Phase 2. No dependencies on other stories.
- **User Story 2 (P2)**: Can start after Phase 2. Can run in parallel with US1.
- **User Story 3 (P2)**: Depends on US1 completion (needs the final cloud-init and deploy.sh to audit).

### Within Each User Story

- T004 and T005 can run in parallel (different files)
- T006 depends on T004 and T005 (validates their changes)
- T009, T010, T011 can run in parallel (different files, read-only audits)

### Parallel Opportunities

- T001 and T002: Different files, can run in parallel (but T002 is trivial)
- T004 and T005: Different Terraform files, can run in parallel
- T007 and T008: Different files (config.env vs workflow YAML), can run in parallel
- T009, T010, T011: Independent audit tasks, can run in parallel

---

## Parallel Example: User Story 1

```text
# These two tasks modify different files and can run in parallel:
Task T004: Update cloud-init.yaml (secrets-only .env.secrets)
Task T005: Update main.tf (remove non-secret template variables)

# Then validate sequentially:
Task T006: Run terraform validate (depends on T004 + T005)
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Create config.env, update Dockerfile (T001-T002)
2. Complete Phase 2: Implement merge logic in deploy.sh (T003)
3. Complete Phase 3: Update cloud-init and main.tf (T004-T006)
4. **STOP and VALIDATE**: Run `terraform plan -var="enable_vpn=true"` — confirm zero server changes
5. This alone solves the original problem: VPN can be toggled without server recreation

### Incremental Delivery

1. Setup + Foundational → Deployer can merge configs (backward compatible with existing servers)
2. Add User Story 1 → VPN toggle decoupled from server lifecycle (MVP!)
3. Add User Story 2 → Extensibility documented, CD workflow updated
4. Add User Story 3 → Security audit confirms no regressions
5. Polish → Documentation updated, quickstart validated

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- The cloud-init change (T004) WILL trigger one final server recreation on existing deployments — this is the migration cost documented in plan.md
- After that migration, all future service-level config changes are non-destructive
- Total: 14 tasks across 6 phases
- Commit after each phase or logical group
