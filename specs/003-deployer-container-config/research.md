# Research: Deployer Container for Mutable Config

**Feature**: 003-deployer-container-config
**Date**: 2026-03-21

## R1: Watchtower Lifecycle Hooks — Can They Trigger Compose Restart?

### Finding: Yes, but impractical and Watchtower is archived

Watchtower lifecycle hooks (`post-update`) run **inside the updated container**, not on the host. So the deployer would need Docker CLI + socket access to run `docker compose up -d` after writing config.

However, **Watchtower was archived by its maintainers in December 2025** (repository is now read-only, no further releases). This makes it a poor foundation for new architecture.

Additionally, Watchtower only monitors **running** containers. A deployer that exits after writing config would not be monitored for updates — Watchtower skips stopped containers.

## R2: The Chicken-and-Egg Problem

### Problem

If the deployer is defined in the same docker-compose.yml that it writes, it cannot update its own compose file and then restart itself. The deployer would need to be managed separately from the services it deploys.

### Solution: Two-layer architecture

1. **Bootstrap layer** (cloud-init, immutable): installs Docker, writes `.env` (secrets), creates a systemd service+timer that periodically pulls and runs the deployer
2. **Application layer** (deployer image, mutable): contains docker-compose.yml, Caddyfile, deploy script. Writes config and runs `docker compose up -d`

The systemd timer replaces Watchtower for the deployer. The deployer itself can also pull the latest app image during its run, **eliminating Watchtower entirely**.

## R3: Replacing Watchtower with Deployer + Systemd Timer

### Decision: Replace Watchtower with deployer container + systemd timer

**Rationale**: Watchtower is archived (Dec 2025). Instead of depending on abandoned software, the deployer container + systemd timer provides a simpler, more capable architecture:

1. Systemd timer triggers every 5 minutes (configurable)
2. Pulls latest deployer image from GHCR
3. Runs deployer as a one-shot container (`--rm`)
4. Deployer copies config to `/opt/app/`, runs `docker compose pull && docker compose up -d --remove-orphans`
5. Deployer exits. Systemd timer handles next run.

**Advantages over Watchtower**:
- Single mechanism for both config and image updates
- No chicken-and-egg problem (deployer is outside the compose stack)
- Runs on server reboot automatically (systemd)
- Can validate config before applying (`docker compose config`)
- Can handle add/remove services (`--remove-orphans`)
- No dependency on archived software

**Alternatives considered**:

| Option | Rejected Because |
|--------|------------------|
| Watchtower + lifecycle hooks | Watchtower archived Dec 2025. Hooks run inside container (complex). Doesn't monitor stopped containers. |
| Watchtower + separate bootstrap compose | Two compose stacks, complex networking, Watchtower still archived |
| Cron job instead of systemd | Less reliable, no boot-time guarantee, no logging |
| S3-based config pull | Two Terraform providers needed, extra sync mechanism, more moving parts |

## R4: Deployer Container Design

### Decision: Alpine + Docker CLI + shell script

The deployer image is minimal:
- Base: `docker:cli` (Alpine with Docker CLI, ~15MB)
- Contains: `docker-compose.yml`, `Caddyfile`, `deploy.sh`
- Entrypoint: `deploy.sh` which copies config, validates, pulls images, applies
- Runs as one-shot with `--rm` — no persistent container

**Mount requirements**:
- `/var/run/docker.sock` — to manage containers
- `/opt/app` — to write config files
- `/opt/app/.env` — pre-existing secrets file (read-only from deployer's perspective)

**Hardening**:
- Read-only root filesystem
- No secrets in the image
- Docker socket access is required (necessary trade-off for managing containers)
- The deploy script validates config before applying

## R5: Cloud-Init Reduction

### Decision: Cloud-init only installs Docker + creates systemd deployer service

Cloud-init will be reduced to:
1. Install Docker
2. Create deploy user
3. Write `.env` (secrets — still needs Terraform templatefile for these)
4. Create `/opt/app/` directory
5. Create `deployer.service` (one-shot: pull + run deployer image)
6. Create `deployer.timer` (periodic trigger, e.g., every 5 minutes)
7. Enable and start the timer

**What moves OUT of cloud-init**: docker-compose.yml, Caddyfile, all service definitions, Watchtower config.

**What stays IN cloud-init**: Docker installation, `.env` (contains secrets that must not be in images), systemd service/timer definitions (minimal, rarely change).

## R6: CI Pipeline — Building Two Images

### Decision: Single workflow builds both app and deployer images

The deploy workflow builds two images in parallel:
1. `ghcr.io/<repo>:latest` — the app image (existing)
2. `ghcr.io/<repo>-deployer:latest` — the deployer image (new)

Both use the same build-and-push job pattern with different Dockerfiles and contexts.

## R7: Config Validation Before Apply

### Decision: Deployer validates config with `docker compose config` before applying

The deploy script:
1. Copies config files to `/opt/app/`
2. Runs `docker compose -f /opt/app/docker-compose.yml config` to validate
3. If validation fails: log error, exit non-zero (systemd records failure), existing services keep running
4. If validation passes: `docker compose pull && docker compose up -d --remove-orphans`

This satisfies FR-007 (failed deployer must not take down running deployment).
