# Implementation Plan: JS Reload Prompt

**Branch**: `016-js-reload-prompt` | **Date**: 2026-03-31 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/016-js-reload-prompt/spec.md`

## Summary

Add a background version-check mechanism to the playground app that detects when a new version has been deployed and presents an editorial-tone toast prompt inviting the user to reload. The server exposes a lightweight `/version` endpoint returning the git commit hash (baked into the Docker image at build time via `GIT_COMMIT` env var); the client polls it and compares against the hash captured at page load.

## Technical Context

**Language/Version**: JavaScript ES6+ (browser modules), Node.js 20 LTS (CommonJS server)
**Primary Dependencies**: None new — uses existing `server/server.js` HTTP handler and browser `fetch` API
**Storage**: N/A — version hash comes from GIT_COMMIT env var (baked into Docker image at build time)
**Testing**: `node:test` (unit), Playwright (e2e)
**Target Platform**: Browser (ES6 modules) + Node.js server
**Project Type**: Web application (single-page app + Node.js API server)
**Performance Goals**: Version check must complete in <100ms; zero visible impact on dashboard
**Constraints**: No new dependencies; editorial tone; Stitch design system conformance
**Scale/Scope**: 1 new server endpoint, 1 new browser module, CSS additions, e2e test

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. system.yaml as source of truth | N/A | No hardware changes |
| II. Pure Logic / IO Separation | PASS | Version checking is purely client-side UI; no control logic changes |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | No actuation or safety-critical behavior; read-only check |
| IV. Proportional Test Coverage | PASS | Plan includes unit tests for hash computation + e2e test for prompt behavior |
| V. Token-Based Cloud Auth | N/A | No UpCloud authentication involved |
| VI. Durable Data Persistence | N/A | No persistent data — hash is computed on each request |
| VII. No Secrets in Cloud-Init | N/A | No secrets or infrastructure changes |

All gates pass. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/016-js-reload-prompt/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── version-endpoint.md
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
server/
└── server.js            # Add /version endpoint (returns GIT_COMMIT env var)

playground/
├── index.html           # Import new version-check module
├── js/
│   └── version-check.js # NEW: polls /version, shows/hides toast
└── css/
    └── style.css        # Add toast banner styles (Stitch design system)

tests/
├── version-check.test.js    # Unit tests for version endpoint (GIT_COMMIT env var)
└── e2e/
    └── version-check.spec.js # E2e test for prompt appearance and dismissal
```

**Structure Decision**: This feature touches the existing server and playground directories. One new browser module (`version-check.js`), one new server endpoint in the existing `server.js`, CSS additions to the existing `style.css`, and test files following established patterns.
