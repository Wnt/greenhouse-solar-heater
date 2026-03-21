# Implementation Plan: Deployer Container for Mutable Config

**Branch**: `003-deployer-container-config` | **Date**: 2026-03-21 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/003-deployer-container-config/spec.md`

## Summary

Move all deployment configuration (docker-compose.yml, Caddyfile, service definitions) from immutable cloud-init into a deployer container image. Replace Watchtower (archived Dec 2025) with a systemd timer that periodically pulls and runs the deployer. The deployer writes config to disk, validates it, pulls service images, and runs `docker compose up -d`. Config changes propagate via push → CI builds deployer image → systemd timer pulls and runs it → services updated. No server recreation needed.

## Technical Context

**Language/Version**: Shell (deploy script), HCL (Terraform), YAML (cloud-init, compose), Dockerfile
**Primary Dependencies**: `docker:cli` base image (Alpine + Docker CLI), Docker Compose v2, systemd
**Storage**: UpCloud Managed Object Storage (existing, for app credentials)
**Testing**: Shell script validation, `docker compose config` for config validation, existing unit tests unaffected
**Target Platform**: UpCloud DEV-1xCPU-1GB-10GB server, Ubuntu 24.04 LTS
**Project Type**: Infrastructure-as-code + deployment automation
**Constraints**: Read-only root filesystem, no secrets in images, no SSH, 10GB disk
**Scale/Scope**: 1 server, 1 deployer image, 1 app image, ~4 services

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### Pre-Research Check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | N/A | Deployment infrastructure only |
| II. Pure Logic / IO Separation | N/A | No control logic changes |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | Deployer validates config before applying; failed deploys don't take down running services |
| IV. Proportional Test Coverage | PASS | Deploy script tested; existing app tests unaffected |
| V. Token-Based Cloud Auth | PASS | UPCLOUD_TOKEN used; GHCR token for image pulls |

### Post-Design Re-Check

| Principle | Status | Notes |
|-----------|--------|-------|
| III. Safe by Default | PASS | Config validation gate before `docker compose up -d`; existing services untouched on failure |
| V. Token-Based Cloud Auth | PASS | No username/password references in any config |

## Project Structure

### Documentation (this feature)

```text
specs/003-deployer-container-config/
├── plan.md              # This file
├── research.md          # Phase 0: Watchtower limitations, deployer design
├── data-model.md        # Phase 1: Entity and state model
├── quickstart.md        # Phase 1: Deployment guide
├── contracts/           # Phase 1: Interface contracts
│   └── deployer-script.md
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
deploy/
├── deployer/
│   ├── Dockerfile           # docker:cli base, copies config + script (NEW)
│   ├── deploy.sh            # Entrypoint: copy config, validate, apply (NEW)
│   ├── docker-compose.yml   # Service stack definition (MOVED from docker/)
│   └── Caddyfile            # Reverse proxy config (MOVED from docker/)
├── docker/
│   ├── Dockerfile           # App image, unchanged
│   └── docker-compose.yml   # REMOVE (replaced by deployer/docker-compose.yml)
│   └── Caddyfile            # REMOVE (replaced by deployer/Caddyfile)
├── terraform/
│   ├── main.tf              # Remove compose/Caddyfile from cloud-init (MODIFY)
│   ├── variables.tf         # Remove enable_vpn if no longer needed in TF (MODIFY)
│   ├── cloud-init.yaml      # Minimal: Docker + systemd deployer (REWRITE)
│   └── outputs.tf           # Unchanged
└── wireguard/
    └── wg0.conf.example     # Unchanged

.github/workflows/
└── deploy.yml               # Add deployer image build job (MODIFY)
```

**Structure Decision**: New `deploy/deployer/` directory holds the deployer Dockerfile, entrypoint script, and all deployment config files. The existing `deploy/docker/` retains only the app Dockerfile. Cloud-init is drastically simplified.

## Complexity Tracking

No constitution violations to justify.
