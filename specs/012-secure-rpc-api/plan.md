# Implementation Plan: Secure RPC API

**Branch**: `012-secure-rpc-api` | **Date**: 2026-03-25 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/012-secure-rpc-api/spec.md`

## Summary

Harden the monitor app's RPC proxy (`/api/rpc/`) against CSRF and parameter leakage by switching from GET to POST, adding a mandatory `X-Requested-With` marker header, and replacing the permissive `Access-Control-Allow-Origin: *` with restrictive CORS tied to the app's configured origin.

## Technical Context

**Language/Version**: JavaScript — Node.js 20 LTS (CommonJS server), ES6+ (browser modules)
**Primary Dependencies**: Node.js `http` module (server), browser `fetch` API (client). No new dependencies.
**Storage**: N/A — no data model changes
**Testing**: `node:test` (unit tests), Playwright (e2e)
**Target Platform**: Linux server (Node.js) + modern browsers (ES6+)
**Project Type**: Web service (monitor app) with browser client
**Performance Goals**: No degradation from current response times
**Constraints**: Shelly devices only accept GET — server must translate POST body to GET query
**Scale/Scope**: Single RPC proxy endpoint, ~3 files modified, 1 new test file

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | N/A | No hardware changes |
| II. Pure Logic / IO Separation | PASS | Changes are in the I/O layer (server routing, client fetch), not control logic |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | Default behavior rejects unauthorized requests (403/405). Marker header required. |
| IV. Proportional Test Coverage | PASS | New unit tests for middleware; e2e tests verify client integration |
| V. Token-Based Cloud Auth | N/A | No UpCloud auth changes |
| VI. Durable Data Persistence | N/A | No new persistent data |
| VII. No Secrets in Cloud-Init | N/A | No new secrets; marker header value is not a secret |

All gates pass. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/012-secure-rpc-api/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Design decisions and rationale
├── data-model.md        # Request format changes (no persistent data)
├── quickstart.md        # Development guide
├── contracts/
│   └── rpc-proxy-api.md # New POST API contract
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
monitor/
├── server.js            # MODIFY: POST handling, marker header check, CORS preflight, body parsing
├── js/
│   └── shelly-api.js    # MODIFY: POST + JSON body + X-Requested-With header
└── lib/
    └── valve-poller.js  # UNCHANGED: direct Shelly calls, not proxied

tests/
└── rpc-proxy.test.js    # NEW: unit tests for RPC proxy security middleware
```

**Structure Decision**: Minimal changes to existing files. One new test file. No new directories or dependencies.

## Complexity Tracking

No constitution violations. Table not needed.
