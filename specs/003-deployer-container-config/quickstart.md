# Quickstart: Deployer Container for Mutable Config

**Feature**: 003-deployer-container-config
**Date**: 2026-03-21

## How It Works

```
                    ┌──────────────────┐
  git push main ──→ │ GitHub Actions   │
                    │ Build app image  │
                    │ Build deployer   │
                    └───────┬──────────┘
                            │ push to GHCR
                            ▼
               ┌─────────────────────────┐
               │ UpCloud Server          │
               │                         │
               │ systemd timer (5 min)   │
               │   └─ pull deployer      │
               │   └─ run deployer       │
               │       ├─ write config   │
               │       ├─ validate       │
               │       ├─ pull images    │
               │       └─ compose up -d  │
               │                         │
               │ Running services:       │
               │   app, caddy, [vpn]     │
               └─────────────────────────┘
```

## Making Config Changes

1. Edit files in `deploy/deployer/` (docker-compose.yml, Caddyfile, etc.)
2. Push to main
3. CI builds and pushes the deployer image
4. Within 5 minutes, the server pulls the new deployer and applies config
5. No SSH, no server recreation, no manual steps

## Enabling VPN

1. Uncomment the wireguard service in `deploy/deployer/docker-compose.yml`
2. Add `COMPOSE_PROFILES=vpn` logic or include it directly
3. Push to main
4. In Terraform, set `enable_vpn = true` and `terraform apply` (adds firewall rule)
5. Configure WireGuard peer details via UpCloud web console

## Initial Deployment

Same as before: `terraform apply` against an empty UpCloud account. Cloud-init installs Docker, writes `.env`, starts the systemd deployer timer. The deployer pulls and starts all services.

## Local Development

```bash
# Build and test deployer locally
docker build -t deployer-test deploy/deployer/
docker run --rm -v $(pwd)/deploy/deployer:/opt/app deployer-test
# Inspect /opt/app/ for written config files
```

## Checking Deployer Status on Server

Via UpCloud web console:
```bash
# Last deployer run
systemctl status deployer.service

# Deployer logs
journalctl -u deployer.service --no-pager -n 50

# Timer schedule
systemctl list-timers deployer.timer
```
