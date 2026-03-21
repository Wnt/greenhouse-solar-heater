# Contract: Deployer Script (deploy.sh)

**Feature**: 003-deployer-container-config
**Date**: 2026-03-21

## Purpose

Entrypoint script for the deployer container. Copies config files from the image to the host volume, validates the config, pulls service images, and applies the service stack.

## Interface

### Inputs

- Config files baked into the image at `/config/` (docker-compose.yml, Caddyfile)
- Host volume mounted at `/opt/app/` (writable)
- Docker socket mounted at `/var/run/docker.sock`
- `.env` file pre-existing at `/opt/app/.env` (secrets, provisioned by Terraform)

### Outputs

- Config files written to `/opt/app/`
- Service stack running via `docker compose up -d`
- Exit code 0 on success, non-zero on failure

### Behavior

1. Copy config files from `/config/` to `/opt/app/`
2. Validate: `docker compose -f /opt/app/docker-compose.yml config`
3. If validation fails: log error, exit 1 (existing services untouched)
4. Pull images: `docker compose -f /opt/app/docker-compose.yml pull`
5. Apply: `docker compose -f /opt/app/docker-compose.yml up -d --remove-orphans`
6. Exit 0

### Error Handling

- Validation failure → exit 1, no services affected
- Pull failure (network) → exit 1, existing services keep running
- Compose up failure → partial failure possible, logged

## Systemd Integration

### deployer.service

- Type: oneshot
- ExecStart: `docker pull ghcr.io/<repo>-deployer:latest && docker run --rm -v /opt/app:/opt/app -v /var/run/docker.sock:/var/run/docker.sock ghcr.io/<repo>-deployer:latest`
- User: deploy (Docker group member)

### deployer.timer

- OnBootSec: 30s (delay after boot for Docker to be ready)
- OnUnitActiveSec: 5min (polling interval)
- Persistent: true (catch up if timer missed while off)
