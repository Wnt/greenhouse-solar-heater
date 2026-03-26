# Implementation Plan: Remove Monitor App, Promote Playground

**Branch**: `013-remove-monitor-app` | **Date**: 2026-03-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/013-remove-monitor-app/spec.md`

## Summary

Remove the monitor web app UI (gauges, charts, push notifications, PoC Shelly scripts, PWA artifacts) from the project while retaining passkey authentication to protect the control system. Restructure so the playground app is the sole web application served at `/` behind auth. Add URL fragment-based deep linking for all views, add explanatory descriptions to the Device configuration view, and integrate Shelly script deployment into the deploy pipeline with the Pro 4PM at 192.168.1.174.

## Technical Context

**Language/Version**: JavaScript ES6+ (browser modules), Node.js 20 LTS (CommonJS server), ES5 (Shelly scripts), POSIX shell (deploy scripts)
**Primary Dependencies**: `ws` (WebSocket), `mqtt` (MQTT client), `pg` (PostgreSQL), `@aws-sdk/client-s3`, `@opentelemetry/*`, `@simplewebauthn/server` (retained for passkey auth) — removing `web-push`
**Storage**: PostgreSQL/TimescaleDB (sensor history), UpCloud S3-compatible Object Storage (config persistence)
**Testing**: `node:test` (unit), Playwright (e2e), `serve` (static server for tests)
**Target Platform**: Linux server (Docker), modern browsers (ES6+ modules)
**Project Type**: Web application (IoT monitoring/control SPA + Node.js API server)
**Performance Goals**: N/A — single-user system, existing performance is adequate
**Constraints**: Shelly ES5 compatibility, vendored browser dependencies (no CDN), single Docker image
**Scale/Scope**: Single-user system, 5 views, ~15 files to delete, ~10 files to modify

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | PASS | No hardware spec changes. `system.yaml` unchanged. |
| II. Pure Logic / IO Separation | PASS | No control logic changes. `control-logic.js` unchanged. |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | No safety-critical changes. Shelly deploy already has stop-before-upload safety. Deploy failure is non-fatal. |
| IV. Proportional Test Coverage | PASS | Removing monitor tests proportional to removing monitor code. Existing playground tests preserved. New e2e tests for deep linking. |
| V. Token-Based Cloud Auth | PASS | No UpCloud auth changes. |
| VI. Durable Data Persistence | PASS | No persistence changes. S3 and PostgreSQL usage unchanged. |
| VII. No Secrets in Cloud-Init | PASS | No cloud-init changes. Shelly deploy uses existing `CONTROLLER_VPN_IP` from `.env`. |
| Platform: Shelly ES5 | PASS | No Shelly script changes. |
| Platform: Vendored deps | PASS | Removing monitor vendored deps; playground vendored deps unchanged. |

All gates pass. No violations to justify.

## Project Structure

### Documentation (this feature)

```text
specs/013-remove-monitor-app/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

**After this feature, the project structure becomes:**

```text
# Server (retained from monitor/ — server.js, lib/, auth/)
server/
├── server.js            # Simplified: static files, auth, WebSocket, RPC proxy, device-config, history
├── auth/
│   ├── credentials.js   # Passkey credential store (S3-backed)
│   ├── invitations.js   # Invitation-based registration
│   ├── session.js       # HMAC session cookies
│   └── webauthn.js      # WebAuthn registration/authentication handlers
└── lib/
    ├── logger.js
    ├── s3-storage.js
    ├── db.js
    ├── db-config.js
    ├── mqtt-bridge.js
    ├── device-config.js
    ├── tracing.js
    ├── nr-config.js
    ├── vpn-config.js
    └── valve-poller.js

# Frontend (playground promoted to root-level app, behind auth)
playground/
├── index.html           # Modified: deep linking, device config descriptions
├── login.html           # Moved from monitor/ — passkey login page
├── css/style.css
├── js/
│   ├── control-logic-loader.js
│   ├── control.js
│   ├── data-source.js
│   ├── login.js         # Moved from monitor/js/ — passkey auth client
│   ├── physics.js
│   ├── ui.js
│   └── yaml-loader.js
└── vendor/
    ├── js-yaml.mjs
    ├── material-symbols-outlined.woff2
    ├── material-symbols.css
    ├── simplewebauthn-browser.mjs  # Moved from monitor/vendor/
    └── qrcode-generator.mjs       # Moved from monitor/vendor/ (invitation QR codes)

# Shelly device scripts (unchanged)
shelly/
├── control-logic.js
├── control.js
├── telemetry.js
├── deploy.sh
├── devices.conf
└── lint/

# Tests (push/SW tests removed, auth tests preserved)
tests/
├── control-logic.test.js
├── playground-control.test.js
├── auth.test.js            # Preserved — path updates for server/auth/
├── s3-storage.test.js
├── db.test.js
├── tracing.test.js
├── mqtt-bridge.test.js
├── device-config.test.js
├── device-config-integration.test.js
├── data-source.test.js
├── rpc-proxy.test.js       # Preserved — path updates for server/
├── valve-poller.test.js
├── vpn-config.test.js
├── simulation/
└── e2e/
    ├── fixtures.js
    ├── thermal-sim.spec.js
    ├── device-config.spec.js
    ├── pwa.spec.js         # Remove or simplify (no more SW/manifest)
    ├── live-mode.spec.js
    └── take-screenshots.spec.js

# Deployment
deploy/
├── docker/Dockerfile    # Updated: no monitor/, use server/
├── deployer/
│   ├── deploy.sh        # Updated: server/ paths, shelly deploy step
│   └── docker-compose.yml
└── ...
```

**Structure Decision**: The `monitor/` directory is split: `server.js`, `auth/`, and `lib/` move to a new `server/` directory. Login page and auth client JS move to `playground/`. Monitor UI files, push notifications, PoC Shelly scripts, and PWA artifacts are deleted. The playground remains at `playground/`. This avoids the confusing `monitor/` name while preserving the server/frontend separation and retaining passkey auth.

## Complexity Tracking

No constitution violations to justify. The restructuring reduces complexity by removing ~25 files and simplifying the server.
