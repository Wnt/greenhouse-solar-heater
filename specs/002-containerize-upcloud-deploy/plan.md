# Implementation Plan: Containerize UpCloud Deployment

**Branch**: `002-containerize-upcloud-deploy` | **Date**: 2026-03-21 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/002-containerize-upcloud-deploy/spec.md`

## Summary

Refactor the UpCloud deployment to: (1) replace Docker volumes with UpCloud Managed Object Storage for persistence, (2) harden all containers with read-only root filesystems and non-root users, (3) move WireGuard VPN from host to a container with a Terraform boolean toggle (disabled by default), (4) eliminate SSH exposure by using Watchtower for automated deployments and cloud-init for initial provisioning, (5) deploy the full stack to a fresh empty UpCloud account.

## Technical Context

**Language/Version**: Node.js 20 LTS (CommonJS), Terraform >= 1.5 (HCL), Docker Compose v2
**Primary Dependencies**: @aws-sdk/client-s3 (new, for S3 persistence), Caddy 2-alpine, containrrr/watchtower, linuxserver/wireguard (optional)
**Storage**: UpCloud Managed Object Storage (S3-compatible, €5/month, 250GB min)
**Testing**: node:test (unit), Playwright (e2e) — existing test suite; add unit tests for S3 storage adapter
**Target Platform**: UpCloud fi-hel1 server, Ubuntu 24.04 LTS, Docker
**Project Type**: Infrastructure-as-code + web-service deployment
**Performance Goals**: App accessible within 5 minutes of deployment; Watchtower update cycle < 10 minutes
**Constraints**: Read-only root filesystem on all containers; non-root execution; no SSH on public IP; single-server architecture
**Scale/Scope**: Single-user app, 1 server, 3-4 containers, ~10 Terraform resources

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Research Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | N/A | This feature is software/deployment only — `system.yaml` not affected |
| II. Pure Logic / IO Separation | PASS | Storage adapter follows this pattern: pure read/write interface, S3 I/O isolated in adapter |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | VPN disabled by default; firewall drops all by default; containers read-only by default |
| IV. Proportional Test Coverage | PASS | Storage adapter will have unit tests; existing tests unaffected |

### Post-Design Re-Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | N/A | No hardware changes |
| II. Pure Logic / IO Separation | PASS | S3 adapter is an I/O layer; credential logic unchanged |
| III. Safe by Default | PASS | Default config: VPN off, SSH closed, RO filesystems, non-root users |
| IV. Proportional Test Coverage | PASS | New storage adapter tested; Terraform validated via `terraform plan` |

## Project Structure

### Documentation (this feature)

```text
specs/002-containerize-upcloud-deploy/
├── plan.md              # This file
├── research.md          # Phase 0: UpCloud services research
├── data-model.md        # Phase 1: Entity and state model
├── quickstart.md        # Phase 1: Deployment guide
├── contracts/           # Phase 1: Interface contracts
│   └── storage-adapter.md
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
deploy/
├── terraform/
│   ├── main.tf              # Server, firewall, object storage (MODIFY)
│   ├── variables.tf         # Add enable_vpn, S3 outputs (MODIFY)
│   ├── outputs.tf           # Add S3 endpoint, keys (MODIFY)
│   ├── cloud-init.yaml      # Remove WireGuard, add docker-compose + .env (MODIFY)
│   └── terraform.tfvars.example  # Update with new variables (MODIFY)
├── docker/
│   ├── Dockerfile           # Non-root user, RO-compatible (MODIFY)
│   ├── docker-compose.yml   # Hardening, Watchtower, VPN profile (MODIFY)
│   └── Caddyfile            # Unchanged
└── wireguard/
    └── wg0.conf.example     # Unchanged (reference for VPN container config)

poc/
├── auth/
│   └── credentials.js       # Replace fs with S3 adapter (MODIFY)
├── lib/
│   └── s3-storage.js        # S3 read/write adapter (NEW)
└── server.js                # Unchanged

.github/workflows/
└── deploy.yml               # Simplify: remove SSH deploy job (MODIFY)

tests/
└── s3-storage.test.js       # Unit tests for S3 adapter (NEW)
```

**Structure Decision**: Existing project structure maintained. Changes are modifications to existing deploy/ and poc/ files, plus two new files (S3 adapter + tests). No new directories beyond what already exists.

## Complexity Tracking

No constitution violations to justify.
