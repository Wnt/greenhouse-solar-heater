# Tasks: Architecture Code Review (P1 Security)

**Input**: Design documents from `/specs/017-architecture-code-review/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: Included — constitution principle IV (Proportional Test Coverage) requires test updates for each behavioral change.

**Organization**: Tasks grouped by the three P1 security fixes from User Story 1. Each fix is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story sub-fix this task belongs to (US1a = SQL injection, US1b = RPC proxy, US1c = session secret)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: No project setup needed — this is a refactoring of existing code. Verify baseline.

- [x] T001 Run existing test suite to establish green baseline: `npm test`

---

## Phase 2: Foundational

**Purpose**: No foundational/blocking tasks — each fix is independent and modifies different code paths.

**Checkpoint**: Baseline tests pass — fix implementation can begin.

---

## Phase 3: Fix SQL Injection in History API (Priority: P1a) 🎯 MVP

**Goal**: Convert all string-interpolated database queries to parameterized queries so user-provided input never reaches the SQL engine as raw text.

**Independent Test**: Run `npm run test:unit` — new db tests verify parameterized queries. Manual test: `curl "/api/history?sensor=collector' OR '1'='1"` returns normal results (no injection).

### Tests for US1a

- [x] T002 [US1a] Add test in tests/db.test.js: verify `getHistory()` with a sensor value containing SQL metacharacters (`'`, `--`, `;`) returns results safely without error or injection
- [x] T003 [US1a] Add test in tests/db.test.js: verify `getEvents()` with an entityType containing SQL metacharacters behaves safely

### Implementation for US1a

- [x] T004 [US1a] In server/lib/db.js `getHistory()`: replace string interpolation of `sensor` parameter at lines 251, 256, 262, 264 with `$N` parameterized placeholders and a params array, following the existing pattern from `insertSensorReadings()`
- [x] T005 [US1a] In server/lib/db.js `getEvents()`: replace string interpolation of `entityType` parameter at line 283 with `$N` parameterized placeholder and a params array
- [x] T006 [US1a] Run `npm run test:unit` to verify all db tests pass including new parameterized query tests

**Checkpoint**: SQL injection vulnerability eliminated. All database queries use parameterized queries.

---

## Phase 4: Fix RPC Proxy SSRF (Priority: P1b)

**Goal**: Remove client-supplied `_host` from the RPC proxy. The server resolves the target device from its own `CONTROLLER_IP` environment variable.

**Independent Test**: Run `npm run test:unit` — updated rpc-proxy tests verify server-side host resolution. Manual test: POST to `/api/rpc/Shelly.GetDeviceInfo` without `_host` in body succeeds when `CONTROLLER_IP` is set.

### Tests for US1b

- [x] T007 [US1b] Update tests/rpc-proxy.test.js: remove `_host` from all request bodies; set `CONTROLLER_IP` env var in test setup; verify requests are proxied to the configured controller IP
- [x] T008 [US1b] Add test in tests/rpc-proxy.test.js: verify that when `CONTROLLER_IP` is not set, the proxy returns 503 with a clear error message
- [x] T009 [US1b] Add test in tests/rpc-proxy.test.js: verify that a `_host` field in the request body is ignored (not forwarded as a query parameter to the device)

### Implementation for US1b

- [x] T010 [US1b] In server/server.js RPC handler (~line 128-141): remove `_host` extraction from `parsed` body; instead read `process.env.CONTROLLER_IP`; return 503 `{"error": "Controller IP not configured"}` if env var is missing
- [x] T011 [US1b] In server/server.js `proxyRpc()` function (~line 147): update to receive `host` from the caller (server config) instead of from the client request; ensure `_host` key is still excluded from forwarded query parameters
- [x] T012 [US1b] Run `npm run test:unit` to verify all rpc-proxy tests pass including updated host resolution tests

**Checkpoint**: SSRF vector eliminated. RPC proxy uses server-configured host only.

---

## Phase 5: Enforce Session Secret When Auth Enabled (Priority: P1c)

**Goal**: Prevent the server from starting with the default session secret when authentication is active, while keeping local dev mode (auth off) working without configuration.

**Independent Test**: Run `npm run test:unit` — new auth tests verify startup validation. Manual test: start server with `AUTH_ENABLED=true` and no `SESSION_SECRET` — server should exit with error.

### Tests for US1c

- [x] T013 [US1c] Add test in tests/auth.test.js: verify that `validateSessionSecret()` (or equivalent) throws/returns error when secret is missing and auth is enabled
- [x] T014 [US1c] Add test in tests/auth.test.js: verify that `validateSessionSecret()` throws/returns error when secret equals `'dev-secret-change-me'` and auth is enabled
- [x] T015 [US1c] Add test in tests/auth.test.js: verify that `validateSessionSecret()` succeeds when auth is disabled regardless of secret value

### Implementation for US1c

- [x] T016 [US1c] In server/auth/session.js: export the default secret string as a named constant (e.g., `DEV_SECRET`) so it can be referenced for validation without hardcoding in multiple places
- [x] T017 [US1c] In server/server.js startup sequence (~line 544, before `authMiddleware.init()`): add validation that checks `SESSION_SECRET` is set and not equal to `DEV_SECRET` when `AUTH_ENABLED` is true; call `process.exit(1)` with a `log.error()` message on failure
- [x] T018 [US1c] Run `npm run test:unit` to verify all auth tests pass including new validation tests

**Checkpoint**: Session secret enforced in cloud mode. Local dev mode unaffected.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation across all fixes.

- [x] T019 Run full test suite: `npm test` (unit + simulation + e2e)
- [x] T020 Update CLAUDE.md if any conventions or architecture descriptions changed
- [x] T021 Verify all three fixes work together: start server with `AUTH_ENABLED=true`, valid `SESSION_SECRET`, and `CONTROLLER_IP` set; confirm RPC proxy works, history API works, and auth is enforced

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — run baseline tests
- **Phase 2 (Foundational)**: Depends on Phase 1 passing
- **Phases 3, 4, 5 (Fixes)**: All depend on Phase 2 — but are **independent of each other**
- **Phase 6 (Polish)**: Depends on all fix phases completing

### Fix Independence

- **US1a (SQL injection)**: Modifies `server/lib/db.js` and `tests/db.test.js` only
- **US1b (RPC proxy)**: Modifies `server/server.js` and `tests/rpc-proxy.test.js` only
- **US1c (Session secret)**: Modifies `server/server.js` and `server/auth/session.js` and `tests/auth.test.js`
- **Conflict**: US1b and US1c both modify `server/server.js` but in different sections (RPC handler vs. startup sequence). Can be parallelized if working on different functions.

### Within Each Fix

- Tests written first (T002-T003, T007-T009, T013-T015)
- Implementation follows (T004-T005, T010-T011, T016-T017)
- Verification last (T006, T012, T018)

### Parallel Opportunities

All three fixes can run in parallel since they touch different code paths:

```
Phase 3 (SQL injection)  ─┐
Phase 4 (RPC proxy)      ─┼─→ Phase 6 (Polish)
Phase 5 (Session secret) ─┘
```

---

## Parallel Example: All Three Fixes

```bash
# These three fix phases can be launched simultaneously:
# Agent 1: SQL injection (db.js + tests/db.test.js)
# Agent 2: RPC proxy (server.js RPC handler + tests/rpc-proxy.test.js)
# Agent 3: Session secret (server.js startup + session.js + tests/auth.test.js)
```

---

## Implementation Strategy

### MVP First (SQL Injection Only)

1. Complete Phase 1: Verify baseline
2. Complete Phase 3: Fix SQL injection (highest severity)
3. **STOP and VALIDATE**: Run tests, verify parameterized queries
4. Deploy if urgent

### Incremental Delivery

1. Fix SQL injection → Test → Commit (critical security fix)
2. Fix RPC proxy → Test → Commit (SSRF elimination)
3. Fix session secret → Test → Commit (auth hardening)
4. Polish → Full test suite → Deploy

---

## Notes

- All fixes are in existing files — no new files created
- ES5 constraint does NOT apply (these are server-side Node.js CommonJS files)
- The `_host` removal is a breaking change for external RPC proxy consumers (none known in the codebase)
- Commit after each fix phase to maintain atomic, revertible changes
