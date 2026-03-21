# Implementation Plan: Add Logout Feature

**Branch**: `004-add-logout-feature` | **Date**: 2026-03-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-add-logout-feature/spec.md`

## Summary

Add a logout button to the Shelly Monitor PoC dashboard header. The server-side logout endpoint (`POST /auth/logout`) already exists but has no UI trigger. The implementation adds a button to `poc/index.html`, auth-awareness logic to `poc/js/app.js` (calling `GET /auth/status` on init), and conditional visibility so the button only appears when authentication is enabled.

## Technical Context

**Language/Version**: JavaScript ES6+ (browser modules), Node.js 20 LTS (server, CommonJS)
**Primary Dependencies**: None new — uses existing auth endpoints and vendored libs
**Storage**: N/A (sessions already managed by existing credential store)
**Testing**: `node:test` for unit tests, Playwright for e2e tests
**Target Platform**: Browser (ES6 modules) + Node.js server
**Project Type**: Web application (PoC)
**Performance Goals**: Logout flow < 2 seconds (SC-004)
**Constraints**: No CDN URLs; vendored dependencies only; match existing CSS patterns
**Scale/Scope**: Single-user system, one button addition

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applicable? | Status |
|-----------|-------------|--------|
| I. Hardware Spec as SSOT | No | N/A — no hardware changes |
| II. Pure Logic / IO Separation | No | N/A — PoC UI code, not control logic |
| III. Safe by Default (NON-NEGOTIABLE) | No | N/A — no actuation or control actions |
| IV. Proportional Test Coverage | **Yes** | MUST add tests for logout UI behavior |
| V. Token-Based Cloud Auth | No | N/A — not UpCloud API auth |

**Gate result**: PASS. One applicable principle (IV) — tests required.

### Post-Phase 1 Re-check

| Principle | Status |
|-----------|--------|
| IV. Proportional Test Coverage | Plan includes auth unit tests and e2e logout flow test |

**Gate result**: PASS.

## Project Structure

### Documentation (this feature)

```text
specs/004-add-logout-feature/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
poc/
├── index.html           # MODIFY: add logout button to header nav
├── js/
│   └── app.js           # MODIFY: add auth status check + logout handler
├── css/
│   └── style.css        # MODIFY: add logout button styles (if needed)
├── auth/
│   └── webauthn.js      # NO CHANGE: logout endpoint already exists
├── server.js            # MODIFY: add /auth/status endpoint for non-auth mode
tests/
├── auth.test.js         # MODIFY: add logout-related test cases
└── e2e/
    └── (new or existing) # ADD: e2e test for logout flow
```

**Structure Decision**: Existing PoC structure. Changes are minimal additions to existing files. No new directories needed.
