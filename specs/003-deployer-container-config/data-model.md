# Data Model: Deployer Container for Mutable Config

**Feature**: 003-deployer-container-config
**Date**: 2026-03-21

## Entities

### Images

| Image | Registry | Built By | Contents |
|-------|----------|----------|----------|
| App | `ghcr.io/<repo>:latest` | CI pipeline | Node.js app code |
| Deployer | `ghcr.io/<repo>-deployer:latest` | CI pipeline | docker-compose.yml, Caddyfile, deploy.sh |

### Host Filesystem (managed by cloud-init, immutable after boot)

| Path | Purpose | Written By |
|------|---------|------------|
| `/opt/app/.env` | Secrets (session key, S3 creds, domain) | Cloud-init (Terraform templatefile) |
| `/etc/systemd/system/deployer.service` | One-shot: pull + run deployer | Cloud-init |
| `/etc/systemd/system/deployer.timer` | Periodic trigger (every 5 min) | Cloud-init |

### Host Filesystem (managed by deployer, mutable)

| Path | Purpose | Written By |
|------|---------|------------|
| `/opt/app/docker-compose.yml` | Service stack definition | Deployer container |
| `/opt/app/Caddyfile` | Reverse proxy config | Deployer container |

### Container Stack (managed by deployer)

| Container | Image | Role |
|-----------|-------|------|
| app | `ghcr.io/<repo>:latest` | Monitoring web UI |
| caddy | `caddy:2-alpine` | TLS termination |
| wireguard | `lscr.io/linuxserver/wireguard` | VPN (optional, via profiles) |

Note: Watchtower is **removed** — the deployer + systemd timer replaces it.

## State Transitions

### Update Flow (config change)

```
Push to main
  → CI builds app image + deployer image → push to GHCR
  → systemd timer fires (every 5 min)
  → pulls deployer:latest
  → runs deployer container (one-shot)
  → deployer copies config to /opt/app/
  → deployer runs: docker compose config (validate)
  → deployer runs: docker compose pull
  → deployer runs: docker compose up -d --remove-orphans
  → deployer exits (code 0)
```

### Update Flow (app code change only)

```
Push to main
  → CI builds app image → push to GHCR
  → systemd timer fires
  → pulls deployer:latest (no change, same digest)
  → runs deployer
  → config unchanged (already on disk)
  → docker compose pull (pulls new app image)
  → docker compose up -d (recreates app container only)
  → deployer exits
```

### Server Reboot

```
Server boots
  → systemd starts deployer.timer
  → deployer.service runs immediately (on boot)
  → deployer writes config (from image, idempotent)
  → docker compose up -d (starts all services)
```

### Failed Deploy

```
Deployer writes config
  → docker compose config → fails (invalid YAML, missing image, etc.)
  → deployer logs error, exits non-zero
  → existing running services UNAFFECTED
  → systemd records failure (visible in journalctl)
  → next timer run retries
```
