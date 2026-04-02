# Quickstart: Architecture Code Review (P1 Security)

## Files to Modify

### 1. SQL Injection Fix
- `server/lib/db.js` — Convert `getHistory()` and `getEvents()` to parameterized queries
- `tests/db.test.js` — Add tests for parameterized query behavior

### 2. RPC Proxy Server-Side Host
- `server/server.js` — Remove `_host` extraction from request body; use `CONTROLLER_IP` env var
- `tests/rpc-proxy.test.js` — Update tests: remove `_host` from bodies, verify server-side resolution, test 503 when `CONTROLLER_IP` not set

### 3. Session Secret Validation
- `server/server.js` — Add validation before auth init (line ~544)
- `server/auth/session.js` — Export validation function or the default secret constant for comparison
- `tests/auth.test.js` — Add tests for startup validation behavior

## Verification

```bash
# Run existing tests (must all pass)
npm run test:unit

# Run e2e tests
npm run test:e2e

# Full suite
npm test
```

## Key Constraints

- **No new dependencies** — all fixes use existing `pg` parameterized queries and Node.js stdlib
- **ES5 constraint does NOT apply** — these are server-side Node.js files (CommonJS), not Shelly scripts
- **Backward compatibility**: The `_host` removal is a breaking change for any external RPC proxy consumers. The playground frontend does not use it. Deploy scripts (`shelly/deploy.sh`) call devices directly, not through the proxy.
