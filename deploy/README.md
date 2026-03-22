# Deployment

## Architecture

```
Internet → Caddy (:443, TLS) → Node.js app (:3000) → S3 Object Storage (credentials)
                                                    → OpenVPN (optional) → Shelly devices

Update flow:
  git push → CI builds app + deployer images → GHCR
  systemd timer (5 min) → pulls deployer → writes config → docker compose up -d
```

All service configuration lives in the **deployer image** (`deploy/deployer/`), not in cloud-init.
Config changes are applied by pushing to main — no server recreation, no SSH, no manual steps.

## Prerequisites

- UpCloud account with API token
- Terraform >= 1.5
- Domain name with DNS access

## Quick Start

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values

export UPCLOUD_TOKEN="your-api-token"

terraform init
terraform plan
terraform apply
```

After apply, create a DNS A record pointing your domain to the `server_ip` output.

The server boots, cloud-init installs Docker and starts a systemd timer. The timer pulls the deployer image, which writes config and starts all services. The app should be accessible at `https://your-domain` within ~5 minutes.

## How Updates Work

1. Push to `main`
2. GitHub Actions builds two images: **app** + **deployer** (in parallel)
3. Both are pushed to GHCR as `:latest`
4. The systemd timer on the server fires every 5 minutes
5. It pulls the deployer image and runs it
6. The deployer copies config, validates, pulls service images, and runs `docker compose up -d`

No SSH, no Watchtower, no manual steps.

## Changing Config

Edit files in `deploy/deployer/`:
- `docker-compose.yml` — service definitions
- `Caddyfile` — reverse proxy rules

Push to main. The deployer image is rebuilt and the server picks it up within 5 minutes.

## Terraform Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ssh_public_key` | Yes | — | SSH public key (required by UpCloud, SSH port NOT exposed) |
| `domain` | Yes | — | Domain name for the monitoring UI |
| `github_repo` | Yes | — | GitHub repo in `owner/name` format |
| `session_secret` | Yes | — | HMAC secret for cookies (`openssl rand -hex 32`) |
| `upcloud_zone` | No | `fi-hel1` | UpCloud zone |
| `server_plan` | No | `DEV-1xCPU-1GB-10GB` | Server plan (€3/month, limit 2/account) |
| `objsto_region` | No | `europe-1` | Object Storage region (~€5/month) |
| `enable_vpn` | No | `false` | Enable OpenVPN firewall rule (UDP 1194) |

## Enabling VPN

1. Generate OpenVPN config: `cd deploy/openvpn && ./setup.sh --server-ip <PUBLIC_IP>`
2. Copy the generated `openvpn.conf` to `/opt/app/openvpn.conf` on the server
3. Enter the printed values in UniFi UI: Settings → VPN → Create New VPN → OpenVPN
4. Add `COMPOSE_PROFILES=vpn` to the `.env` on the server (via UpCloud web console)
5. In Terraform: `enable_vpn = true` then `terraform apply` (adds firewall rule for UDP 1194)
6. On the next deployer run (~5 min), the OpenVPN container starts and the tunnel establishes

The deployer automatically uploads `openvpn.conf` to S3 for recovery after server recreation.

## Emergency Access

Use the **UpCloud Control Panel web console** (HTML5) — always available regardless of firewall rules.

## Deployer Status

Via UpCloud web console:
```bash
systemctl status deployer.service     # last run
journalctl -u deployer.service -n 50  # logs
systemctl list-timers deployer.timer  # schedule
```

## Container Stack

| Container | Image | Purpose | Hardening |
|-----------|-------|---------|-----------|
| app | `ghcr.io/<repo>:latest` | Monitoring UI | Non-root (UID 1000), RO root |
| caddy | `caddy:2-alpine` | TLS termination | RO root, writable cert volumes |
| openvpn | Custom Alpine + openvpn | VPN tunnel (optional, via profiles) | NET_ADMIN cap |

The deployer runs as a **one-shot container** via systemd — it is not a long-lived service.
