# Implementation Plan: Add Home Screen Support

**Branch**: `009-add-home-screen-support` | **Date**: 2026-03-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-add-home-screen-support/spec.md`

## Summary

Make the Greenhouse Monitor PWA installable on Android (Chrome) and iOS (Safari) home screens by extending the existing manifest, adding Apple-specific meta tags, implementing a service worker fetch handler with offline fallback, and whitelisting PWA resources in the auth gate.

## Technical Context

**Language/Version**: JavaScript ES6+ (browser modules), Node.js 20 LTS (server, CommonJS)
**Primary Dependencies**: None new — extends existing service worker and manifest
**Storage**: N/A — no new persistent data
**Testing**: Node.js unit tests (`node:test`), Playwright e2e tests
**Target Platform**: Android (Chrome), iOS (Safari), desktop browsers
**Project Type**: Web application (PWA)
**Performance Goals**: N/A — configuration changes only, no runtime performance impact
**Constraints**: Must not break existing push notification functionality; auth gate must allow PWA resources for unauthenticated users
**Scale/Scope**: Single-user monitoring app, ~6 files modified/created

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applicable? | Status | Notes |
|-----------|------------|--------|-------|
| I. Hardware Spec as Source of Truth | No | PASS | No hardware changes |
| II. Pure Logic / IO Separation | No | PASS | No control logic changes |
| III. Safe by Default (NON-NEGOTIABLE) | No | PASS | No actuation or safety-critical changes |
| IV. Proportional Test Coverage | Yes | PASS | SW fetch handler and auth whitelist changes need tests |
| V. Token-Based Cloud Auth | No | PASS | No cloud auth changes |
| VI. Durable Data Persistence | No | PASS | No new persistent data; SW cache is ephemeral by design |

**Post-Design Re-check**: All gates still pass. The offline page is cached in the service worker (ephemeral, not persistent data), which is appropriate — it's a static asset pre-cached on SW install, not application state.

## Project Structure

### Documentation (this feature)

```text
specs/009-add-home-screen-support/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
monitor/
├── manifest.json        # MODIFY — add id, maskable icon purpose
├── index.html           # MODIFY — add Apple meta tags
├── login.html           # MODIFY — add manifest link, theme-color, Apple meta tags
├── sw.js                # MODIFY — add fetch handler, offline cache
├── offline.html         # NEW — branded offline fallback page
├── server.js            # MODIFY — whitelist PWA resources in auth gate
├── icons/
│   ├── icon-192.png     # EXISTING — used as apple-touch-icon
│   └── icon-512.png     # EXISTING — declared maskable in manifest
├── css/style.css        # EXISTING — referenced by offline page
└── js/                  # EXISTING — no changes

tests/
├── sw.test.js           # NEW — unit tests for SW fetch handler logic
└── e2e/
    └── pwa.spec.js      # NEW — e2e tests for PWA installability
```

**Structure Decision**: No new directories. Changes are confined to the existing `monitor/` directory and `tests/` directory, following the established project layout.
