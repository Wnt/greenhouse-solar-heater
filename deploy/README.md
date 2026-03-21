# Deployment

## Architecture

```
Internet → Caddy (:443, TLS) → Node.js app (:3000) → S3 Object Storage (credentials)
                                                    → WireGuard VPN (optional) → Shelly devices
```

All containers run with **read-only root filesystems** and as **non-root users**.
Credentials are stored in UpCloud Managed Object Storage (S3-compatible), not on the host.
No SSH is exposed — deployments are handled by Watchtower auto-pulling from GHCR.

## Prerequisites

- UpCloud account with API credentials
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

The server boots, cloud-init installs Docker, writes configuration files, and starts all containers automatically. The app should be accessible at `https://your-domain` within ~5 minutes.

## GitHub Actions (CI/CD)

The CD pipeline builds and pushes the Docker image to GHCR on merge to main. **Watchtower** on the server automatically detects and pulls new `:latest` images every 5 minutes.

No SSH deploy secrets are needed. Only the GHCR token (provided automatically by GitHub Actions) is required.

## Terraform Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ssh_public_key` | Yes | — | SSH public key (required by UpCloud, but SSH port is NOT exposed) |
| `domain` | Yes | — | Domain name for the monitoring UI |
| `github_repo` | Yes | — | GitHub repo in `owner/name` format |
| `session_secret` | Yes | — | HMAC secret for cookies (`openssl rand -hex 32`) |
| `upcloud_zone` | No | `fi-hel1` | UpCloud zone |
| `server_plan` | No | `DEV-1xCPU-1GB-10GB` | Server plan (€3/month, limit 2/account) |
| `objsto_region` | No | `europe-1` | Object Storage region (~€5/month) |
| `enable_vpn` | No | `false` | Enable WireGuard VPN container |

## Enabling VPN (later)

```bash
# In terraform.tfvars:
enable_vpn = true

terraform apply
# Then configure WireGuard peer details via UpCloud web console
```

## Emergency Access

Use the **UpCloud Control Panel web console** (HTML5) — always available regardless of firewall rules.

## Container Stack

| Container | Image | Purpose | Hardening |
|-----------|-------|---------|-----------|
| app | `ghcr.io/<repo>:latest` | Monitoring UI | Non-root (UID 1000), RO root |
| caddy | `caddy:2-alpine` | TLS termination | RO root, writable cert volumes |
| watchtower | `containrrr/watchtower` | Auto-deploy from GHCR | RO root, Docker socket (RO) |
| wireguard | `linuxserver/wireguard` | VPN tunnel (optional) | NET_ADMIN cap, RO root |
