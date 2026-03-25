# Tasks: Secure RPC API

**Input**: Design documents from `/specs/012-secure-rpc-api/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, contracts/rpc-proxy-api.md, quickstart.md

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup

**Purpose**: Verify baseline and prepare for changes

- [x] T001 Run existing test suite to confirm baseline passes (`npm run test:unit`)

---

## Phase 2: User Story 1+2 — CSRF Marker Header + POST Method (Priority: P1) 🎯 MVP

**Goal**: Reject requests without the `X-Requested-With: greenhouse-monitor` header (403), reject GET requests (405), accept POST with JSON body containing `_host` and RPC params.

**Independent Test**: Send requests with/without marker header, with GET/POST methods, verify correct accept/reject behavior.

> Note: US1 and US2 are tightly coupled (both modify the same server function and client module), so they are combined into a single phase.

### Tests

- [x] T002 [US1] Create unit tests for marker header validation and method enforcement in tests/rpc-proxy.test.js — test cases: POST with correct header (200 proxy), POST without header (403), POST with wrong header value (403), GET request (405), missing `_host` in body (400)

### Server Implementation

- [x] T003 [US1] Add `X-Requested-With` header validation to `/api/rpc/` route in monitor/server.js — reject 403 if header missing or value !== `greenhouse-monitor`
- [x] T004 [US2] Add method enforcement to `/api/rpc/` route in monitor/server.js — reject GET with 405 (Allow: POST, OPTIONS), only accept POST
- [x] T005 [US2] Modify `proxyRpc` function in monitor/server.js to read `_host` and RPC params from parsed JSON request body instead of query string, translate to GET query string for Shelly device forwarding

### Client Implementation

- [x] T006 [P] [US2] Modify `rpcTo()` in monitor/js/shelly-api.js — change from GET with query params to POST with JSON body (`{_host, ...params}`), add `Content-Type: application/json` header
- [x] T007 [US1] Add `X-Requested-With: greenhouse-monitor` header to all fetch calls in monitor/js/shelly-api.js

### Validation

- [x] T008 [US1] Run unit tests to verify marker header and method enforcement pass (`npm run test:unit`)

**Checkpoint**: RPC proxy rejects unauthorized requests (no header → 403, GET → 405) and accepts valid POST requests with marker header. Client sends correct format.

---

## Phase 3: User Story 3 — Restrictive CORS (Priority: P2)

**Goal**: Replace `Access-Control-Allow-Origin: *` with the app's configured origin. Handle CORS preflight (OPTIONS) requests properly.

**Independent Test**: Send OPTIONS preflight to `/api/rpc/` and verify response headers; verify `Access-Control-Allow-Origin` on POST responses uses configured origin.

### Tests

- [x] T009 [US3] Add CORS preflight test cases to tests/rpc-proxy.test.js — OPTIONS returns 204 with correct `Allow-Origin`, `Allow-Methods: POST`, `Allow-Headers: Content-Type, X-Requested-With`, `Max-Age: 86400`; POST response has restrictive `Allow-Origin` (not `*`)

### Implementation

- [x] T010 [US3] Add OPTIONS handler for `/api/rpc/` preflight requests in monitor/server.js — respond 204 with CORS headers using `ORIGIN` env var
- [x] T011 [US3] Replace `Access-Control-Allow-Origin: *` with `ORIGIN` env var value in `proxyRpc` response headers in monitor/server.js

### Validation

- [x] T012 [US3] Run full test suite to verify all tests pass (`npm run test:unit`)

**Checkpoint**: CORS preflight handled correctly, `Access-Control-Allow-Origin` uses configured origin.

---

## Phase 4: Polish & Cross-Cutting Concerns

**Purpose**: Ensure nothing is broken and documentation is updated

- [x] T013 Run full test suite including e2e tests (`npm test`)
- [x] T014 Update CLAUDE.md if any structural changes affect documented conventions

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **US1+US2 (Phase 2)**: Depends on Phase 1 baseline passing
- **US3 (Phase 3)**: Depends on Phase 2 (CORS headers are set in the same `proxyRpc` function modified in Phase 2)
- **Polish (Phase 4)**: Depends on all user stories complete

### Within Phase 2

- T002 (tests) → T003, T004, T005 (server changes, sequential — same file) → T006 (client, parallel with server) → T007 (client, after T006) → T008 (validation)

### Within Phase 3

- T009 (tests) → T010, T011 (server changes, sequential — same file) → T012 (validation)

### Parallel Opportunities

- T006 (client-side POST change) can run in parallel with T003-T005 (server-side changes) since they modify different files

---

## Implementation Strategy

### MVP First (Phase 2 Only)

1. Complete Phase 1: Verify baseline
2. Complete Phase 2: Marker header + POST method
3. **STOP and VALIDATE**: All unauthorized requests rejected, client works with new format
4. This alone closes the critical CSRF vulnerability

### Full Delivery

1. Phase 1: Baseline ✓
2. Phase 2: CSRF + POST (MVP) ✓
3. Phase 3: Restrictive CORS ✓
4. Phase 4: Polish ✓

---

## Notes

- US1 and US2 are combined because they modify the same functions (`proxyRpc` in server.js, `rpcTo` in shelly-api.js)
- Valve poller (`monitor/lib/valve-poller.js`) is NOT modified — it calls Shelly devices directly
- The server translates POST JSON body → GET query string for Shelly device forwarding
- `ORIGIN` env var already exists in `config.env` for WebAuthn — reused for CORS
