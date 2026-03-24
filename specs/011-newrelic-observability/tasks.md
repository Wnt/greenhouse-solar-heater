# Tasks: New Relic Observability

**Input**: Design documents from `/specs/011-newrelic-observability/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, quickstart.md

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install OTel packages, create the S3 persistence helper, and wire up Terraform + deployer for the license key

- [ ] T001 Install OpenTelemetry packages: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/api` in package.json
- [ ] T002 [P] Create New Relic license key S3 persistence helper in monitor/lib/nr-config.js (clone pattern from monitor/lib/db-config.js — store/load CLI, S3 key `newrelic-config.json`, exports `load()` and `store()`)
- [ ] T003 [P] Add `new_relic_license_key` variable (sensitive, default `""`) in deploy/terraform/variables.tf
- [ ] T004 Add `null_resource.store_nr_key` in deploy/terraform/main.tf — runs `node monitor/lib/nr-config.js store` with S3 env vars, triggers on key change, depends on S3 policy (same pattern as `null_resource.store_db_url`)
- [ ] T005 Add NR license key fetch step in deploy/deployer/deploy.sh — after DB_URL fetch (Step 6b), run `node monitor/lib/nr-config.js load`, add `NEW_RELIC_LICENSE_KEY` and `NRIA_LICENSE_KEY` to .env if non-empty
- [ ] T006 Add conditional `--profile monitoring` to `docker compose up` command in deploy/deployer/deploy.sh — if `NEW_RELIC_LICENSE_KEY` is set in .env, append `--profile monitoring`
- [ ] T007 [P] Add `OTEL_SERVICE_NAME=greenhouse-monitor` and `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.nr-data.net` to deploy/deployer/config.env

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Create the core tracing module and update the Docker CMD — these must be complete before any user story work

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T008 Create OTel tracing initialization module in monitor/lib/tracing.js — check `NEW_RELIC_LICENSE_KEY` env var; if empty, exit immediately (no-op); if set, init `NodeSDK` with auto-instrumentations, OTLP trace/metrics/logs exporters, set `api-key` header to the license key, configure service name from `OTEL_SERVICE_NAME`
- [ ] T009 Update Dockerfile CMD in deploy/docker/Dockerfile — change `CMD ["node", "monitor/server.js"]` to `CMD ["node", "--require", "./monitor/lib/tracing.js", "monitor/server.js"]`
- [ ] T010 Add unit tests for tracing initialization in tests/tracing.test.js — test: graceful no-op when `NEW_RELIC_LICENSE_KEY` is unset, verify no errors thrown, verify module exports expected interface

**Checkpoint**: Foundation ready — OTel SDK initializes conditionally, app works with and without tracing

---

## Phase 3: User Story 1 - Application Traces and Performance (Priority: P1) 🎯 MVP

**Goal**: All HTTP requests, PostgreSQL queries, S3 operations, and MQTT calls produce distributed traces visible in New Relic

**Independent Test**: Make HTTP requests to the monitor app and verify traces appear in New Relic with correct span hierarchy

### Implementation for User Story 1

- [ ] T011 [US1] Verify auto-instrumentation works for HTTP incoming requests by starting the app with `--require monitor/lib/tracing.js` and confirming `http` module is patched (check `@opentelemetry/instrumentation-http` in tracing.js configuration — enabled by default via auto-instrumentations-node, no code needed beyond T008)
- [ ] T012 [US1] Verify auto-instrumentation works for `pg` (PostgreSQL) queries — the `@opentelemetry/instrumentation-pg` is included in auto-instrumentations-node; verify by running a query and checking span output in tests/tracing.test.js
- [ ] T013 [US1] Add manual MQTT spans in monitor/lib/mqtt-bridge.js — wrap `mqtt.connect()` callback with a span (`mqtt.connect`), wrap `client.subscribe()` callback with a span (`mqtt.subscribe`), wrap `client.publish()` with a span (`mqtt.publish`), and wrap the `message` event handler (`handleStateMessage`) with a span (`mqtt.message`). Use `@opentelemetry/api` tracer. ~5 lines of span creation code.
- [ ] T014 [US1] Add unit test for MQTT spans in tests/tracing.test.js — verify spans are created when OTel is initialized, verify no-op when OTel is not initialized (import `@opentelemetry/api` and check tracer behavior)

**Checkpoint**: User Story 1 complete — HTTP, DB, S3, and MQTT operations produce traces. App works normally without license key.

---

## Phase 4: User Story 2 - Log Correlation with Traces (Priority: P2)

**Goal**: Application logs include trace context and are forwarded to New Relic, enabling click-through from traces to logs

**Independent Test**: Trigger a request, find the trace in New Relic, confirm correlated log entries appear with matching trace IDs

### Implementation for User Story 2

- [ ] T015 [US2] Modify monitor/lib/logger.js to inject OTel trace context — import `@opentelemetry/api`, get active span context in each log method (info/warn/error), add `trace.id` and `span.id` fields to the JSON output when context is available. When no active span, omit these fields (no-op).
- [ ] T016 [US2] Verify OTel logs exporter is configured in monitor/lib/tracing.js — the `@opentelemetry/exporter-logs-otlp-http` should already be wired in T008; confirm it sends the `api-key` header and targets the OTLP endpoint
- [ ] T017 [US2] Add unit test for log trace context injection in tests/tracing.test.js — verify logger output includes `trace.id` and `span.id` when within an active span, verify they are absent when no span is active

**Checkpoint**: User Story 2 complete — logs include trace context and are forwarded to New Relic

---

## Phase 5: User Story 3 - Host and Container Health (Priority: P2)

**Goal**: Host-level and per-container metrics visible in New Relic via the infrastructure agent

**Independent Test**: Check New Relic Infrastructure view for CPU, memory, disk metrics and per-container resource usage

### Implementation for User Story 3

- [ ] T018 [P] [US3] Add `newrelic-infra` service to deploy/deployer/docker-compose.yml — image: `newrelic/infrastructure:latest`, profile: `monitoring`, privileged: true, network_mode: host, pid: host, volumes: `/sys:/sys:ro`, `/proc:/proc:ro`, `/etc:/etc:ro`, `/var/run/docker.sock:/var/run/docker.sock:ro`, env: `NRIA_LICENSE_KEY=${NRIA_LICENSE_KEY}`, `NRIA_DISPLAY_NAME=${DOMAIN}`
- [ ] T019 [US3] Verify the deployer `--profile monitoring` logic from T006 correctly starts the newrelic-infra container only when `NEW_RELIC_LICENSE_KEY` is present

**Checkpoint**: User Story 3 complete — host and container metrics flow to New Relic when license key is configured

---

## Phase 6: User Story 4 - Application Runtime Metrics (Priority: P3)

**Goal**: Node.js runtime metrics (heap, GC, event loop lag) visible in New Relic

**Independent Test**: Check New Relic for Node.js runtime metric charts showing heap size, GC duration, and event loop lag

### Implementation for User Story 4

- [ ] T020 [US4] Verify runtime metrics are exported by the OTel SDK configured in T008 — the `@opentelemetry/auto-instrumentations-node` includes `@opentelemetry/instrumentation-runtime-node` which reports heap, GC, and event loop metrics. Confirm the metrics OTLP exporter (`@opentelemetry/exporter-metrics-otlp-http`) sends these to New Relic. May need to explicitly add `@opentelemetry/instrumentation-runtime-node` if not included in the auto-instrumentation bundle.

**Checkpoint**: User Story 4 complete — Node.js runtime metrics charted in New Relic

---

## Phase 7: User Story 5 - PostgreSQL Database Health (Priority: P3)

**Goal**: PostgreSQL health metrics (connections, throughput, cache hit ratio) visible in New Relic

**Independent Test**: Check New Relic for a PostgreSQL dashboard showing active connections, rows read/written, buffer cache hit ratio

### Implementation for User Story 5

- [ ] T021 [P] [US5] Add `nri-postgresql` service to deploy/deployer/docker-compose.yml — image: `newrelic/infrastructure-bundle:latest`, profile: `monitoring`, network_mode: `service:openvpn` (same as app, for DB access), env: `NRIA_LICENSE_KEY=${NRIA_LICENSE_KEY}`, volume mount a postgresql config YAML that defines the connection to the managed PG instance using `DATABASE_URL`
- [ ] T022 [US5] Create nri-postgresql integration config file at deploy/deployer/nri-postgresql-config.yml — define the PostgreSQL connection (host, port, user, password parsed from DATABASE_URL), enable collection of `pg_stat_database`, `pg_stat_user_tables`, `pg_stat_bgwriter`
- [ ] T023 [US5] Update deploy/deployer/deploy.sh to template the nri-postgresql config with DATABASE_URL credentials extracted from .env before starting containers

**Checkpoint**: User Story 5 complete — PostgreSQL health dashboard populated in New Relic

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Documentation, CI validation, and cleanup

- [ ] T024 [P] Update CLAUDE.md with New Relic observability section — document tracing.js, nr-config.js, environment variables, Docker Compose monitoring profile, and how to enable/disable
- [ ] T025 [P] Copy quickstart content from specs/011-newrelic-observability/quickstart.md into the appropriate project documentation location (design/docs/ or README section) — document the `terraform apply -var="new_relic_license_key=..."` enablement flow
- [ ] T026 Run full test suite (`npm test`) to verify no regressions — all existing tests must pass with OTel packages installed but no license key configured
- [ ] T027 Verify Dockerfile builds successfully with new OTel dependencies in deploy/docker/Dockerfile
- [ ] T028 Verify Shelly linter still passes (`node shelly/lint/bin/shelly-lint.js`) — OTel changes should not affect Shelly scripts

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on T001 (packages installed) — BLOCKS all user stories
- **User Stories (Phase 3-7)**: All depend on Foundational phase completion
  - US1 (Phase 3): Can start after Phase 2
  - US2 (Phase 4): Can start after Phase 2 (independent of US1)
  - US3 (Phase 5): Can start after Phase 2 (independent of US1/US2, only needs deployer changes from Phase 1)
  - US4 (Phase 6): Can start after Phase 2 (depends only on tracing.js from T008)
  - US5 (Phase 7): Can start after Phase 2 + Phase 1 deployer changes (T005, T006)
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Requires T008 (tracing.js). No dependency on other stories.
- **US2 (P2)**: Requires T008 (tracing.js). Independent of US1 — logger changes don't affect tracing.
- **US3 (P2)**: Requires T005-T007 (deployer). Independent of US1/US2 — infrastructure agent is a separate container.
- **US4 (P3)**: Requires T008 (tracing.js). Independent — runtime metrics are exported by the SDK.
- **US5 (P3)**: Requires T005-T007 (deployer) + DATABASE_URL in .env. Independent of other stories.

### Within Each User Story

- Core implementation before verification
- Tests alongside or after implementation

### Parallel Opportunities

- T002, T003, T007 can all run in parallel (different files)
- T018 and T021 can run in parallel (different sections of docker-compose.yml, but same file — may need sequential)
- US1, US2, US3, US4 can all be developed in parallel after Phase 2
- T024, T025, T027, T028 can run in parallel (different files)

---

## Parallel Example: Phase 1 Setup

```bash
# These tasks modify different files and can run in parallel:
Task T002: "Create monitor/lib/nr-config.js"
Task T003: "Add variable to deploy/terraform/variables.tf"
Task T007: "Add OTEL vars to deploy/deployer/config.env"
```

## Parallel Example: User Stories After Foundation

```bash
# After Phase 2, these user stories can proceed in parallel:
US1 (T011-T014): "MQTT spans in monitor/lib/mqtt-bridge.js"
US2 (T015-T017): "Logger trace context in monitor/lib/logger.js"
US3 (T018-T019): "Infra agent in deploy/deployer/docker-compose.yml"
US4 (T020):      "Runtime metrics verification"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T007)
2. Complete Phase 2: Foundational (T008-T010)
3. Complete Phase 3: User Story 1 (T011-T014)
4. **STOP and VALIDATE**: Deploy with license key, verify traces appear in New Relic
5. The app works without license key — zero impact on existing functionality

### Incremental Delivery

1. Setup + Foundational → Tracing infrastructure ready
2. Add US1 (traces) → Deploy, verify traces in New Relic (MVP!)
3. Add US2 (logs) → Deploy, verify trace-log correlation
4. Add US3 (infra) → Deploy, verify host/container metrics
5. Add US4 (runtime) → Deploy, verify Node.js metrics
6. Add US5 (PG health) → Deploy, verify database dashboard
7. Polish → Documentation, test validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- All user stories are independently testable after Phase 2 completion
- The OTel API is designed for no-op behavior when no SDK is registered — this is the core mechanism for graceful degradation
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
