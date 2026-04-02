# Contract: Server Startup Validation

## Validation Rules

The server validates configuration at startup before binding the HTTP port.

### When `AUTH_ENABLED=true` (cloud mode)

| Variable | Required | Validation | Failure |
|----------|----------|------------|---------|
| `SESSION_SECRET` | Yes | Must be set and not equal to `dev-secret-change-me` | Exit with error |
| `CONTROLLER_IP` | Yes (if RPC proxy used) | Must be set | Log warning, RPC proxy returns 503 |

### When `AUTH_ENABLED` is false or unset (local mode)

| Variable | Required | Validation | Failure |
|----------|----------|------------|---------|
| `SESSION_SECRET` | No | Not checked | Dev default used silently |
| `CONTROLLER_IP` | No | Not checked | RPC proxy returns 503 if called |

### Startup Sequence

1. Read `AUTH_ENABLED`
2. If `AUTH_ENABLED=true`:
   - Validate `SESSION_SECRET` is set and not default → exit(1) on failure
   - Initialize auth middleware
3. Resolve `CONTROLLER_IP` for RPC proxy (optional, 503 if missing)
4. Start HTTP server

### Error Messages

- Missing session secret: `"FATAL: SESSION_SECRET must be set when AUTH_ENABLED=true"`
- Default session secret: `"FATAL: SESSION_SECRET must not use the default value in authenticated mode"`
