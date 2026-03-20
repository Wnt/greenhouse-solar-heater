# Research: Deploy PoC Web UI to Cloud

**Feature Branch**: `001-deploy-web-ui-cloud`
**Date**: 2026-03-20

## R1: VPN Protocol and Architecture

**Decision**: WireGuard, host-level on UpCloud server, UniFi gateway as VPN client

**Rationale**:
- WireGuard is 3-5x faster than OpenVPN and simpler than IPsec (~4,000 lines of code vs ~70,000 for OpenVPN)
- UniFi gateways support WireGuard VPN Client (UniFi Network 8.1+). The gateway connects to the cloud server as a client, which works even behind NAT/CGNAT
- Host-level WireGuard (not Docker container) is simpler for site-to-site: direct kernel module access, no Docker iptables conflicts, straightforward routing
- UpCloud has no source/destination check filtering (unlike AWS), so WireGuard routing works out of the box

**Alternatives considered**:
- IPsec (IKEv2): Native UniFi S2S support but more complex configuration, harder to debug with third-party endpoints
- OpenVPN: Slower, higher resource usage, userspace overhead
- WireGuard in Docker: Adds networking complexity (iptables, bridge routing) with no benefit for a single tunnel
- Tailscale: Designed for device-level access, not site-to-site network bridging

**Architecture**:
- Cloud server runs WireGuard server (host-level, `wg0` interface, UDP 51820)
- UniFi gateway configured as WireGuard VPN Client, initiates connection to cloud server
- Tunnel subnet: 10.10.10.0/24 (cloud=10.10.10.1, UniFi=10.10.10.2)
- Cloud server's `AllowedIPs` includes 192.168.1.0/24 for LAN device access
- Docker containers reach Shelly devices via host networking or Docker's default bridge (host has the route)

**UpCloud gotchas**:
- Must allow UDP 51820 in both UpCloud panel firewall AND OS-level firewall
- Interface name may be `ens3` or `eth0` — check before writing iptables rules
- `net.ipv4.ip_forward=1` must be explicitly enabled
- WireGuard MTU default 1420 generally works; lower to 1380 if large packet issues

## R2: WebAuthn/Passkey Authentication

**Decision**: @simplewebauthn/server + @simplewebauthn/browser, JSON file storage, signed cookies for sessions

**Rationale**:
- @simplewebauthn is the most actively maintained Node.js WebAuthn library, FIDO Alliance conformant, used by major projects (Supabase, Hanko)
- JSON file storage is appropriate for single-user system — no database needed
- Signed cookies using Node.js built-in `crypto.createHmac` — zero additional dependencies for session management
- Keeps the stack minimal: only 2 new npm packages, no Express, no database

**Alternatives considered**:
- fido2-lib: Less actively maintained, more verbose API
- SQLite for credential storage: Overkill for 1 user with 1-3 passkeys
- JWT sessions via `jose`: Adds dependency for no benefit in single-user scenario
- Express + express-session: Unnecessary framework overhead for a simple server

**Key implementation details**:
- RP ID must match the hostname (domain) — changing it invalidates all credentials
- WebAuthn requires HTTPS (or localhost). Caddy reverse proxy provides automatic TLS
- `userVerification: "preferred"` — enables biometric/PIN when available
- `residentKey: "preferred"` — allows passwordless discoverable credentials
- Counter must be validated and updated on each authentication

**Bootstrap flow** (30-minute time window per spec):
1. Server starts, checks credential JSON file
2. If empty → setup mode with 30-minute timer
3. Registration endpoint exposed only during setup window
4. After first credential registered or timer expires, registration disabled
5. Additional passkeys require authentication first

## R3: Infrastructure as Code

**Decision**: Terraform with official UpCloud provider + cloud-init for server bootstrap

**Rationale**:
- UpCloud has an official, production-ready Terraform provider (`UpCloudLtd/upcloud`, actively maintained since ~2020)
- Covers all needed resources: server, firewall rules, networking
- cloud-init via `user_data` is the cleanest way to bootstrap Docker + WireGuard (no SSH race conditions, idempotent)
- UpCloud does not offer managed DNS — use Cloudflare Terraform provider for DNS records

**Alternatives considered**:
- Pulumi: No native UpCloud provider, would need Terraform bridge — extra complexity
- Ansible: No official UpCloud modules, good for config management but not for infra provisioning
- UpCloud CLI (upctl): Scripting only, no state tracking, not declarative

**Server plan**: `1xCPU-2GB` in `fi-hel1` (Helsinki) — ~11-13 EUR/month. Docker overhead is ~200-300MB, WireGuard negligible, Node.js ~100-300MB. The 1GB plan would be too tight.

**Terraform structure**:
```
terraform/
  main.tf           # provider config, server, firewall, network
  variables.tf      # zone, plan, SSH key, domain
  cloud-init.yaml   # Docker + WireGuard bootstrap
  outputs.tf        # server IP, domain
```

**DNS**: Cloudflare (free tier) with Terraform provider `cloudflare/cloudflare` for A record management.

## R4: Continuous Deployment

**Decision**: GitHub Container Registry (GHCR) + SSH deploy via GitHub Actions

**Rationale**:
- GHCR is free for public repos, integrated with GitHub (uses GITHUB_TOKEN)
- SSH deploy is simple and reliable for a single server
- Single workflow with job dependencies: test → build-and-push → deploy
- `docker compose pull && docker compose up -d --wait` with healthchecks for zero-downtime

**Alternatives considered**:
- Watchtower: Less control, no deployment status feedback in GitHub
- docker build on server: Wastes server resources, slower
- Direct rsync + docker build: No container registry, harder to rollback

**Deployment strategy**:
1. Push to main triggers workflow
2. `test` job runs full test suite
3. `build-and-push` job builds Docker image, pushes to GHCR (tagged with SHA + latest)
4. `deploy` job SSHs into UpCloud server, pulls new image, restarts with `docker compose up -d --wait`
5. Images tagged with git SHA for rollback capability

**Server-side setup**:
- Dedicated `deploy` user with Docker group membership
- Ed25519 SSH keypair for GitHub Actions
- `/opt/app/docker-compose.yml` referencing GHCR image

## R5: HTTPS and Reverse Proxy

**Decision**: Caddy as reverse proxy for automatic HTTPS (Let's Encrypt)

**Rationale**:
- Caddy provides automatic TLS certificate management via Let's Encrypt with zero configuration
- Handles HTTPS termination, freeing the Node.js app from TLS concerns
- Can act as the authentication gateway — passkey auth can be a middleware or handled by the app
- Runs as a Docker container alongside the app
- Simpler than Traefik for a single-service setup

**Architecture**:
```
Internet → Caddy (:443) → Node.js app (:3000) → WireGuard → Shelly devices
```
