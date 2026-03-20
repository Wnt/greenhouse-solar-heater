# Implementation Plan: Deploy PoC Web UI to Cloud

**Branch**: `001-deploy-web-ui-cloud` | **Date**: 2026-03-20 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/001-deploy-web-ui-cloud/spec.md`

## Summary

Deploy the existing PoC Shelly Monitor web UI to an UpCloud cloud server so it is accessible from the internet. The Node.js proxy server runs in a Docker container, connects to on-site Shelly devices via a WireGuard VPN tunnel (UniFi gateway as client), and is protected by WebAuthn passkey authentication. All infrastructure is defined with Terraform, and GitHub Actions deploys automatically on merge to main after tests pass.

## Technical Context

**Language/Version**: Node.js 20 LTS (existing `server.js` uses CommonJS `http` module)
**Primary Dependencies**: @simplewebauthn/server, @simplewebauthn/browser (vendored), Caddy (reverse proxy)
**Storage**: JSON file for passkey credentials and sessions (single-user, no database)
**Testing**: node:test (unit), Playwright (e2e) — existing test infrastructure extended
**Target Platform**: Linux server (Ubuntu 24.04 LTS on UpCloud, Docker containers)
**Project Type**: Web service (single-page monitoring UI + API proxy)
**Performance Goals**: Page load with live data within 10 seconds, valve commands within 5 seconds
**Constraints**: Single-user system, minimal resource usage (1xCPU-2GB server), structured logging
**Scale/Scope**: 1 user, 3 Shelly devices, 1 cloud server

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as SSOT | PASS | This feature does not modify hardware specs. `system.yaml` is not affected. Device IPs are read from `devices.conf`. |
| II. Pure Logic / IO Separation | PASS | The existing `server.js` is I/O (HTTP proxy). New auth middleware is I/O. No new control logic is added — control decisions remain in `control-logic.js`. |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | Valve commands pass through unchanged — the existing safety logic in `control-logic.js` on the Shelly device is unaffected. VPN adds network transport only. Auth blocks unauthorized access by default (no access without passkey). |
| IV. Proportional Test Coverage | PASS | New auth logic will have unit tests. E2e tests will cover the login flow. CD pipeline runs full test suite before deploy. |

**Post-Phase 1 re-check**: All principles remain satisfied. The deployment wraps existing code in containers without modifying control logic.

## Project Structure

### Documentation (this feature)

```text
specs/001-deploy-web-ui-cloud/
├── plan.md              # This file
├── research.md          # Phase 0 output — technology decisions
├── data-model.md        # Phase 1 output — entity definitions
├── quickstart.md        # Phase 1 output — local dev & deploy guide
├── contracts/           # Phase 1 output — API contracts
│   └── api.md           # Auth + proxy API endpoints
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
deploy/
├── terraform/
│   ├── main.tf              # UpCloud server, firewall, Cloudflare DNS
│   ├── variables.tf         # Configurable parameters
│   ├── outputs.tf           # Server IP, domain
│   └── cloud-init.yaml      # Docker + WireGuard bootstrap
├── docker/
│   ├── Dockerfile           # Node.js app container (poc/ + auth layer)
│   ├── docker-compose.yml   # App + Caddy services
│   └── Caddyfile            # Reverse proxy + TLS config
└── wireguard/
    └── wg0.conf.example     # WireGuard server config template

poc/
├── server.js                # Extended: auth middleware, structured logging
├── auth/
│   ├── webauthn.js          # WebAuthn registration + authentication handlers
│   ├── session.js           # Signed cookie session management
│   └── credentials.json     # Passkey credential store (created at runtime)
├── js/
│   ├── app.js               # Existing (unchanged)
│   ├── chart.js             # Existing (unchanged)
│   ├── gauge.js             # Existing (unchanged)
│   ├── shelly-api.js        # Existing (unchanged)
│   └── login.js             # New: browser-side passkey authentication
├── vendor/
│   └── simplewebauthn-browser.mjs  # Vendored @simplewebauthn/browser
├── login.html               # Passkey login page
├── index.html               # Existing (unchanged)
└── css/
    └── style.css            # Existing + login page styles

.github/workflows/
├── ci.yml                   # Existing test suite (unchanged)
└── deploy.yml               # New: build → push to GHCR → SSH deploy to UpCloud

tests/
├── auth.test.js             # Unit tests for auth module
└── e2e/
    └── auth.spec.js         # Playwright e2e for login flow
```

**Structure Decision**: The `deploy/` directory at repo root contains all infrastructure and container config. Auth code lives within `poc/auth/` since it's part of the PoC server. This avoids a separate backend project — the existing `server.js` is extended with middleware.

## Complexity Tracking

No constitution violations to justify. The design follows the simplest path: extend the existing server with auth middleware, wrap in Docker, provision with Terraform.
