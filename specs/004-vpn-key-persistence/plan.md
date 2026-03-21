# Implementation Plan: VPN Key Persistence

**Branch**: `004-vpn-key-persistence` | **Date**: 2026-03-21 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/004-vpn-key-persistence/spec.md`

## Summary

Persist the WireGuard VPN configuration (`wg0.conf`) to S3 object storage so it survives server recreation. The deployer downloads the config from S3 before starting containers, and uploads it if a local config exists but no S3 copy does (bootstrap). This reuses the existing S3 bucket and credentials already configured for WebAuthn credential storage.

The key design decision (see [research.md](research.md) R1) is to use the app Docker image as a one-shot S3 helper — the deployer runs `docker run --rm` with the app image to execute a Node.js script that handles S3 operations. This avoids adding any dependencies to the deployer image.

## Technical Context

**Language/Version**: Node.js 20 LTS (CommonJS), POSIX shell (deployer)
**Primary Dependencies**: `@aws-sdk/client-s3` (already in app image)
**Storage**: UpCloud Managed Object Storage (S3-compatible, existing bucket)
**Testing**: `node:test` (unit tests), existing CI pipeline
**Target Platform**: Linux server (UpCloud DEV-1xCPU-1GB)
**Project Type**: Infrastructure / deployment tooling
**Performance Goals**: N/A (one-time S3 GET/PUT per deploy, < 1 KB file)
**Constraints**: Deployer is minimal Alpine (`docker:cli`); no Node.js in deployer
**Scale/Scope**: Single server, single VPN config file

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applicable? | Status | Notes |
|---|---|---|---|
| I. system.yaml as source of truth | No | Pass | VPN config is deployment infrastructure, not hardware spec |
| II. Pure Logic / IO Separation | No | Pass | No control logic involved; this is deployment tooling |
| III. Safe by Default (NON-NEGOTIABLE) | Yes | Pass | Deploy fails gracefully if S3 unreachable; existing services unaffected |
| IV. Proportional Test Coverage | Yes | Pass | Unit tests for vpn-config.js; deploy.sh changes tested via existing patterns |
| V. Token-Based Cloud Authentication | Yes | Pass | S3 access uses existing token-based credentials; no UpCloud API auth involved |

**Post-Phase 1 re-check**: All gates still pass. The design adds no unsafe defaults — S3 failures are logged and non-fatal, and the deployer continues without VPN if config is unavailable.

## Project Structure

### Documentation (this feature)

```text
specs/004-vpn-key-persistence/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
poc/lib/
└── vpn-config.js        # NEW: S3 helper for VPN config (download/upload CLI)

deploy/deployer/
├── deploy.sh            # MODIFIED: Add VPN config download/upload steps
├── docker-compose.yml   # UNCHANGED
├── Dockerfile           # UNCHANGED
└── Caddyfile            # UNCHANGED

deploy/terraform/
├── cloud-init.yaml      # MODIFIED: Add VPN_CONFIG_KEY env var to .env
├── main.tf              # UNCHANGED
└── variables.tf         # UNCHANGED

tests/
└── vpn-config.test.js   # NEW: Unit tests for vpn-config.js
```

**Structure Decision**: Changes are minimal — one new file (`vpn-config.js`), one new test file, and modifications to two existing files (`deploy.sh`, `cloud-init.yaml`). No new directories or architectural changes.

## Complexity Tracking

No constitution violations. No complexity justifications needed.
