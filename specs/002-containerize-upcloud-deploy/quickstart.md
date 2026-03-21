# Quickstart: Containerize UpCloud Deployment

**Feature**: 002-containerize-upcloud-deploy
**Date**: 2026-03-21

## Prerequisites

- UpCloud account with API credentials
- Terraform >= 1.5 installed locally
- Domain name with DNS access (for A record)
- GitHub repository with GHCR access

## Step 1: Configure Terraform

```bash
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars:
#   ssh_public_key = "ssh-ed25519 AAAA..."
#   domain = "monitor.example.com"
#   enable_vpn = false  (default)
```

Set UpCloud API credentials:
```bash
export UPCLOUD_USERNAME="your-username"
export UPCLOUD_PASSWORD="your-password"
```

## Step 2: Provision Infrastructure

```bash
terraform init
terraform plan    # Review: server, firewall, object storage
terraform apply   # Creates everything in UpCloud
```

Terraform outputs the server's public IP. Create a DNS A record pointing your domain to this IP.

## Step 3: Configure Secrets

After the server boots (cloud-init takes ~2-3 minutes), access it via UpCloud web console to set the `.env` file at `/opt/app/.env`:

```bash
RPID=monitor.example.com
ORIGIN=https://monitor.example.com
SESSION_SECRET=<random-hex-string>
DOMAIN=monitor.example.com
S3_ENDPOINT=<from-terraform-output>
S3_BUCKET=<from-terraform-output>
S3_ACCESS_KEY_ID=<from-terraform-output>
S3_SECRET_ACCESS_KEY=<from-terraform-output>
```

Most of these values come from Terraform outputs. The `SESSION_SECRET` should be generated: `openssl rand -hex 32`.

## Step 4: Verify

Visit `https://monitor.example.com` — you should see the passkey registration page (within the setup window).

## Ongoing Deployments

Push to `main` → GitHub Actions builds + pushes to GHCR → Watchtower on the server auto-pulls and restarts the app container. No SSH needed.

## Enabling VPN (later)

```bash
# In terraform.tfvars:
enable_vpn = true

terraform apply   # Adds firewall rule for WireGuard port
```

Then configure VPN secrets via UpCloud web console and activate the VPN Compose profile.

## Local Development (unchanged)

```bash
node poc/server.js  # No S3, no auth, direct LAN access
```
