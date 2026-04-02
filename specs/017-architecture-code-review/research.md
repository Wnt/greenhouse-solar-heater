# Research: Architecture Code Review (P1 Security)

**Branch**: `017-architecture-code-review` | **Date**: 2026-04-02

## Decision 1: SQL Injection Remediation Strategy

**Decision**: Convert all string-interpolated queries in `server/lib/db.js` to parameterized queries using `$N` placeholders.

**Rationale**: The `pg` driver already supports parameterized queries — `insertSensorReadings()` and `insertStateEvent()` use them correctly. The vulnerable `getHistory()` and `getEvents()` functions just need the same treatment. No new dependencies required.

**Vulnerable locations** (all in `server/lib/db.js`):
- `getHistory()` lines 251, 256, 262, 264 — `sensor` parameter from URL query string is interpolated directly into SQL
- `getEvents()` line 283 — `entityType` parameter is currently hardcoded to `'mode'` in server.js but uses the vulnerable pattern

**Already secure** (reference pattern):
- `insertSensorReadings()` lines 212-213 — uses `$1, $2, $3` placeholders with params array
- `insertStateEvent()` lines 220-221 — uses `$1, $2, $3, $4, $5` placeholders

**User input path**: `server/server.js` line 250 → `parsed.searchParams.get('sensor')` → passed unsanitized to `db.getHistory()`.

**Alternatives considered**:
- Input validation/whitelist in server.js: Rejected — defense-in-depth means the DB layer should be safe regardless of caller
- Query builder library (knex/pg-promise): Rejected — overkill for 6 queries; parameterized queries are sufficient

## Decision 2: RPC Proxy Host Resolution

**Decision**: Remove `_host` from client request body entirely. The server resolves the target host from `CONTROLLER_IP` environment variable.

**Rationale**: The current design passes `_host` from the client, creating an SSRF vector. The server already has `CONTROLLER_IP` for the valve poller (`server/lib/valve-poller.js`). There is only one controller device, so the client never needs to specify a host.

**Current flow** (server/server.js lines 128-180):
1. Client POSTs to `/api/rpc/...` with `{ _host: "192.168.x.x", ...params }`
2. Server extracts `_host` from body
3. Server builds `http://{_host}/rpc/...` and proxies

**New flow**:
1. Client POSTs to `/api/rpc/...` with `{ ...params }` (no `_host`)
2. Server reads `CONTROLLER_IP` from env (already available)
3. Server builds `http://{CONTROLLER_IP}/rpc/...` and proxies
4. If `CONTROLLER_IP` is not configured, return 503

**Impact on frontend**: The playground frontend does NOT currently use the RPC proxy (confirmed by search). The device config UI uses `/api/device-config` instead. Only `shelly/deploy.sh` and potential external tools use the RPC proxy.

**Impact on tests**: `tests/rpc-proxy.test.js` currently tests `_host` in body — tests need updating to verify server-side host resolution.

**Alternatives considered**:
- Host allowlist: Rejected — adds complexity for a single-device system; the clarification explicitly chose server-side resolution
- Keep `_host` but validate: Rejected — unnecessary attack surface when the server knows the target

## Decision 3: Session Secret Enforcement

**Decision**: When `AUTH_ENABLED=true`, require `SESSION_SECRET` to be explicitly set. Refuse to start if it's missing or matches the default. When auth is disabled, allow startup without it.

**Rationale**: The current default `'dev-secret-change-me'` (session.js line 10) silently compromises all session security in cloud mode. The enforcement should be tied to `AUTH_ENABLED` (not `NODE_ENV`) per the clarification — this ensures local dev works seamlessly.

**Current behavior** (server/auth/session.js line 10):
```javascript
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
```
No warning, no validation, server starts normally.

**New behavior**:
- `AUTH_ENABLED=true` + no `SESSION_SECRET` → startup error with clear message
- `AUTH_ENABLED=true` + `SESSION_SECRET=dev-secret-change-me` → startup error
- `AUTH_ENABLED=false` or unset → no validation, dev default is fine
- Validation happens in server.js startup sequence, before `authMiddleware.init()`

**Files affected**:
- `server/server.js` — add validation before auth init (around line 544)
- `server/auth/session.js` — export a validation function or make SECRET settable

**Alternatives considered**:
- Validate in session.js module load: Rejected — module doesn't know if auth is enabled
- Minimum entropy check: Rejected — over-engineering; just blocking the known default is sufficient
