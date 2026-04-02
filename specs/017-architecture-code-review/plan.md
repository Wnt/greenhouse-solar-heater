# Implementation Plan: Architecture Code Review (P1 Security)

**Branch**: `017-architecture-code-review` | **Date**: 2026-04-02 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/017-architecture-code-review/spec.md`

**Note**: This plan covers P1 (security) items only. P2/P3 items (code duplication, async patterns, routing, config validation) are deferred.

## Summary

Fix three security vulnerabilities identified in the architectural review: SQL injection in the history API, SSRF via client-supplied RPC proxy host, and a hardcoded session secret default. All fixes use existing dependencies and patterns already established in the codebase.

## Technical Context

**Language/Version**: Node.js 20 LTS (CommonJS)
**Primary Dependencies**: `pg` (PostgreSQL driver), `@simplewebauthn/server`, native `http`/`crypto`
**Storage**: PostgreSQL with TimescaleDB (sensor data), S3-compatible object storage (credentials)
**Testing**: `node:test` (unit), Playwright (e2e)
**Target Platform**: Linux server (UpCloud Managed Kubernetes)
**Project Type**: Web service (HTTP server + WebSocket + MQTT bridge)
**Constraints**: Single-controller system (one Shelly Pro 4PM), single-instance deployment

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as SSOT | N/A | No hardware spec changes |
| II. Pure Logic / IO Separation | PASS | Changes are in IO layer (server), not control logic |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | All three fixes make the default path safer: parameterized queries, server-side host resolution, secret enforcement |
| IV. Proportional Test Coverage | PASS | Each fix includes corresponding test updates |
| V. Token-Based Cloud Auth | N/A | No UpCloud auth changes |
| VI. Durable Data Persistence | N/A | No new persistent data |
| VII. No Secrets in Cloud-Init | PASS | SESSION_SECRET is already a bootstrap secret in cloud-init; this change adds runtime validation, not a new secret |

**Post-Phase 1 re-check**: All gates still pass. The design adds safety validations without introducing new patterns that could violate the constitution.

## Project Structure

### Documentation (this feature)

```text
specs/017-architecture-code-review/
├── plan.md              # This file
├── research.md          # Phase 0: vulnerability analysis + remediation decisions
├── data-model.md        # Phase 1: affected entities (no schema changes)
├── quickstart.md        # Phase 1: files to modify + verification
├── contracts/
│   ├── rpc-proxy.md     # Updated RPC proxy API contract (_host removed)
│   └── startup-validation.md  # New startup validation rules
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (files modified)

```text
server/
├── server.js            # RPC proxy host resolution, startup validation
├── auth/
│   └── session.js       # Export validation function for secret check
└── lib/
    └── db.js            # Parameterized queries in getHistory(), getEvents()

tests/
├── rpc-proxy.test.js    # Updated: server-side host, 503 on missing config
├── db.test.js           # Added: parameterized query verification
└── auth.test.js         # Added: startup secret validation tests
```

**Structure Decision**: No new files or directories. All changes are modifications to existing server modules and their corresponding test files.

## Complexity Tracking

No constitution violations — no justifications needed.
