# Research: Containerize UpCloud Deployment

**Feature**: 002-containerize-upcloud-deploy
**Date**: 2026-03-21

## R1: UpCloud Managed Persistence — Object Storage vs Alternatives

### Decision: UpCloud Managed Object Storage (S3-compatible)

**Rationale**: The app stores a single JSON file (`credentials.json`) for WebAuthn passkeys and sessions. UpCloud Managed Object Storage provides S3-compatible access, is Terraform-provisioned, and decouples data from the server lifecycle. At €5/month (250GB minimum, far exceeding needs), it's the cheapest managed option.

**Alternatives considered**:

| Option | Cost | Fit | Rejected Because |
|--------|------|-----|------------------|
| Managed PostgreSQL | ~€8+/month | Poor | Overkill for a single JSON file. Requires significant app code changes to use SQL. |
| Block Storage | ~€1/month per 10GB | Good | Still attached to a specific server. Survives server deletion only if explicitly detached. Doesn't fully achieve "server is disposable" goal. |
| s3fs-fuse mount | €5/month (Object Storage) | Medium | Requires FUSE capability in container, conflicts with security hardening (read-only root, capabilities). |

**Implementation approach**: Add `@aws-sdk/client-s3` to the app's production dependencies. Create a thin storage adapter that reads/writes the credentials JSON to an S3 bucket instead of the local filesystem. The app code change is minimal — replace `fs.readFile/writeFile` calls in `poc/auth/credentials.js` with S3 get/put operations.

**Terraform resources**:
- `upcloud_managed_object_storage` — creates the storage instance
- `upcloud_managed_object_storage_bucket` — creates the bucket
- `upcloud_managed_object_storage_user` — creates access credentials
- `upcloud_managed_object_storage_user_access_key` — generates S3 access keys

**Region**: `europe-1` (maps to FI-HEL2). Accessible via public endpoint from server in `fi-hel1`. For internal traffic, a private network could be configured but adds complexity; public HTTPS access is sufficient for a single small file.

## R2: Deployment Without SSH — Watchtower for CD

### Decision: Use Watchtower for automated container updates; close SSH on public firewall

**Rationale**: UpCloud's API is infrastructure-level only — it cannot execute commands inside a running VM. The user wants no SSH exposed on the public IP. Watchtower runs as a container and polls GHCR for new image tags, automatically pulling and restarting containers when updates are found.

**Alternatives considered**:

| Option | Rejected Because |
|--------|------------------|
| SSH via GitHub Actions (current) | User explicitly wants SSH closed on public IP |
| Webhook listener on server | Custom code, additional attack surface, port to expose |
| UpCloud Managed Kubernetes | Overkill for 2-3 containers; significant complexity and cost increase |
| UpCloud API restart server | Restarts entire VM, not individual containers; loses state |

**How it works**:
1. GitHub Actions builds and pushes image to GHCR (same as current)
2. Watchtower container on the server polls GHCR periodically (e.g., every 5 minutes)
3. When a new `:latest` tag is detected, Watchtower pulls and recreates the app container
4. No SSH, no inbound ports needed for deployment

**Emergency access**: UpCloud web console (HTML5) is always available through the UpCloud Control Panel, regardless of firewall rules. This covers emergency/debugging scenarios.

**Initial setup**: Cloud-init handles all first-boot configuration. The docker-compose.yml and .env file are placed on the server via cloud-init's `write_files` directive, eliminating the need for SSH-based initial setup.

**CD pipeline change**: The deploy job in GitHub Actions simplifies from "SSH + docker compose pull" to just "build + push to GHCR". Watchtower handles the rest.

## R3: Container Hardening — Read-Only Root & Non-Root User

### Decision: Multi-stage Dockerfile with dedicated non-root user; read-only root with tmpfs mounts

**App container**:
- Add `USER node` (built into node:20-alpine, UID 1000)
- `read_only: true` in docker-compose.yml
- `tmpfs: ["/tmp"]` for Node.js temp files
- Writable volume for S3 SDK cache (if needed), otherwise none

**Caddy container**:
- Caddy 2.7+ supports running as non-root natively
- `read_only: true` in docker-compose.yml
- Writable volumes: `/data` (TLS certs), `/config` (Caddy config)
- `tmpfs: ["/tmp"]`

**WireGuard container** (when VPN enabled):
- `linuxserver/wireguard` image requires `NET_ADMIN` and `SYS_MODULE` capabilities
- Runs as root internally (required for network configuration)
- `read_only: true` with tmpfs for runtime state
- This is an acceptable exception — VPN containers inherently need elevated privileges

**Watchtower container**:
- Runs as non-root where possible
- Needs Docker socket access (`/var/run/docker.sock:ro`)
- `read_only: true` with tmpfs for runtime

## R4: VPN as Container with Terraform Toggle

### Decision: WireGuard in `linuxserver/wireguard` container, controlled by Terraform boolean

**Terraform variable**: `enable_vpn` (default: `false`)

**When `enable_vpn = false`** (current focus):
- No WireGuard firewall rule (port 51820 not opened)
- Cloud-init does NOT install wireguard packages on host
- Docker Compose profile `vpn` is not activated
- App runs without VPN connectivity to on-site devices

**When `enable_vpn = true`** (future):
- Firewall rule for UDP 51820 added via conditional Terraform resource
- WireGuard container added to Docker Compose with `profiles: ["vpn"]`
- VPN container gets `NET_ADMIN` capability, host networking or published UDP port
- App container routes to on-site network via VPN container

**Docker Compose profiles**: Use Compose profiles to conditionally include the VPN service. The `COMPOSE_PROFILES` env var controls which profiles are active.

## R5: Firewall — No SSH on Public IP

### Decision: Remove SSH from public firewall; use UpCloud web console for emergency access

**Firewall rules (VPN disabled)**:
- Port 80 (TCP) — HTTP → HTTPS redirect
- Port 443 (TCP) — HTTPS (Caddy TLS)
- Drop all other inbound (IPv4 and IPv6)

**Firewall rules (VPN enabled)** — adds:
- Port 51820 (UDP) — WireGuard

**Management access**:
- Initial provisioning: cloud-init (runs at first boot, no SSH needed)
- Ongoing deployments: Watchtower (auto-pulls from GHCR)
- Emergency access: UpCloud Control Panel web console (HTML5, no SSH/firewall dependency)
- Infrastructure changes: Terraform + UpCloud API (manages VM, firewall, storage)

**SSH key still required**: UpCloud cloud-init templates require SSH keys for server creation. The key is provisioned but the firewall blocks port 22. If emergency SSH is ever needed, the operator can temporarily add port 22 to the firewall via Terraform or UpCloud Control Panel.

## R6: Cloud-Init — Complete Server Bootstrap Without SSH

### Decision: cloud-init `write_files` + `runcmd` provisions everything needed

Cloud-init will:
1. Install Docker (from official repo)
2. Create deploy user with Docker group
3. Write `docker-compose.yml` to `/opt/app/`
4. Write `Caddyfile` to `/opt/app/`
5. Write `.env` with placeholder values (operator fills in secrets via UpCloud web console or Terraform variables)
6. Pull and start containers via `docker compose up -d`

This eliminates the "copy files via SSH" step from the current deployment README.

## R7: TLS Termination Inside Containers

### Decision: Caddy handles TLS inside the container stack (already the case)

The current architecture already has Caddy doing TLS termination inside Docker. Caddy obtains Let's Encrypt certificates automatically and terminates HTTPS at the container level. The host only forwards raw TCP on ports 80/443 to the Caddy container. No changes needed here — this is already correct.
