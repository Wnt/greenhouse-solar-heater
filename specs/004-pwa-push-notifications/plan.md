# Implementation Plan: PWA Push Notifications for Valve Changes

**Branch**: `004-pwa-push-notifications` | **Date**: 2026-03-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/004-pwa-push-notifications/spec.md`

## Summary

Add PWA installability (manifest + service worker) to the Shelly monitor PoC and implement server-side valve state polling with Web Push notifications. When a valve changes position, all subscribed devices receive a push notification. VAPID keys and push subscriptions are persisted in S3-compatible object storage using the existing storage adapter pattern.

## Technical Context

**Language/Version**: Node.js 20 LTS (CommonJS) + ES6+ browser modules
**Primary Dependencies**: `web-push` (new, v3.6.7) + existing `@aws-sdk/client-s3`, `@simplewebauthn/server`
**Storage**: S3-compatible object storage (UpCloud Managed Object Storage) — two new keys: `push-config.json`, `push-subscriptions.json`
**Testing**: `node:test` (unit), Playwright (e2e)
**Target Platform**: Node.js server + modern browsers (Chrome, Edge, Firefox, Safari 16.4+)
**Project Type**: Web application (PoC monitor)
**Performance Goals**: Notification delivery within one polling cycle (~10s) of valve state change
**Constraints**: No new infrastructure; all persistence in existing S3 bucket; no offline caching
**Scale/Scope**: Single user, 1-5 device subscriptions

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as SSOT | PASS | Feature does not modify hardware specs; valve state is read-only from Shelly controller |
| II. Pure Logic / IO Separation | PASS | Valve state change detection will be a pure function (compare previous vs current state). Push delivery and Shelly polling are IO-layer concerns in server.js |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | Feature is read-only observation + notification. No actuation, no valve control, no override capability |
| IV. Proportional Test Coverage | PASS | Unit tests for state change detection logic, API contract tests for push endpoints, e2e test for subscribe/unsubscribe UI flow |
| V. Token-Based Cloud Auth | N/A | Feature does not interact with UpCloud API; uses S3 storage which is already configured via access key |

**Post-Phase 1 re-check**: All gates still pass. The data model and contracts introduce no new concerns.

## Project Structure

### Documentation (this feature)

```text
specs/004-pwa-push-notifications/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: technology decisions
├── data-model.md        # Phase 1: entity definitions
├── quickstart.md        # Phase 1: developer setup guide
├── contracts/           # Phase 1: API contracts
│   └── push-api.md      # Push subscription REST endpoints
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
poc/
├── server.js            # MODIFY: add push API endpoints, valve polling loop
├── manifest.json        # NEW: PWA manifest
├── sw.js                # NEW: service worker (push + notificationclick)
├── icons/               # NEW: PWA icons (192x192, 512x512)
│   ├── icon-192.png
│   └── icon-512.png
├── index.html           # MODIFY: add manifest link, SW registration, subscribe UI
├── js/
│   ├── app.js           # MODIFY: add notification subscribe/unsubscribe logic
│   └── push.js          # NEW: push subscription management (browser-side)
├── lib/
│   ├── s3-storage.js    # EXISTING: reuse pattern (no changes needed)
│   ├── push-storage.js  # NEW: S3 adapter for push subscriptions + VAPID keys
│   └── valve-poller.js  # NEW: server-side valve state polling + change detection
└── css/
    └── style.css        # MODIFY: notification toggle button styles

tests/
├── push-storage.test.js # NEW: unit tests for push storage adapter
├── valve-poller.test.js # NEW: unit tests for valve state change detection
└── e2e/
    └── thermal-sim.spec.js  # EXISTING (no changes)
```

**Structure Decision**: All new code lives within the existing `poc/` directory structure, following established patterns. New server-side modules go in `poc/lib/`, new browser modules in `poc/js/`. No new top-level directories.

## Complexity Tracking

No constitution violations to justify. The feature adds straightforward modules following existing patterns.
