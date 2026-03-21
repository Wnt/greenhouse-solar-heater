# Tasks: Deployer Container for Mutable Config

**Feature**: 003-deployer-container-config
**Created**: 2026-03-21

## Phase 1: Create Deployer Image

- [X] T01: Create `deploy/deployer/deploy.sh` — entrypoint script (copy config, validate, pull, apply)
- [X] T02: Create `deploy/deployer/Dockerfile` — docker:cli base with deploy.sh and config files
- [X] T03: Move `deploy/docker/docker-compose.yml` → `deploy/deployer/docker-compose.yml` (remove Watchtower, add VPN with profiles)
- [X] T04: Move `deploy/docker/Caddyfile` → `deploy/deployer/Caddyfile`

## Phase 2: Simplify Cloud-Init

- [X] T05: Rewrite `deploy/terraform/cloud-init.yaml` — minimal bootstrap (Docker + systemd deployer timer + .env)
- [X] T06: Update `deploy/terraform/main.tf` — remove enable_vpn from templatefile (no longer affects cloud-init)
- [X] T07: Update `deploy/terraform/variables.tf` — keep enable_vpn for firewall only

## Phase 3: CI Pipeline

- [X] T08: Update `.github/workflows/deploy.yml` — build and push both app + deployer images

## Phase 4: Documentation and Cleanup

- [X] T09: Remove old `deploy/docker/docker-compose.yml` and `deploy/docker/Caddyfile`
- [X] T10: Update `deploy/README.md` with new deployer architecture
- [X] T11: Update `CLAUDE.md` with new file relationships and architecture
- [X] T12: Run existing tests to verify no regressions
