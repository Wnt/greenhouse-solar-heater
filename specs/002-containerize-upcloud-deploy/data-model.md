# Data Model: Containerize UpCloud Deployment

**Feature**: 002-containerize-upcloud-deploy
**Date**: 2026-03-21

## Entities

### Terraform State

Infrastructure entities managed by Terraform. No application-level data model changes.

| Entity | Terraform Resource | Purpose |
|--------|-------------------|---------|
| Server | `upcloud_server` | Compute instance running Docker |
| Firewall | `upcloud_firewall_rules` | Network access control |
| Object Storage | `upcloud_managed_object_storage` | S3-compatible persistence service |
| Storage Bucket | `upcloud_managed_object_storage_bucket` | Bucket for app credentials |
| Storage User | `upcloud_managed_object_storage_user` | Service account for S3 access |
| Access Key | `upcloud_managed_object_storage_user_access_key` | S3 credentials (key ID + secret) |

### Application Data (unchanged format)

The credentials JSON structure remains identical. Only the storage backend changes (local file → S3 object).

| Entity | Format | Location (before) | Location (after) |
|--------|--------|-------------------|-------------------|
| Credentials | JSON | `/data/credentials.json` (Docker volume) | `s3://bucket/credentials.json` (Object Storage) |

### Container Stack

| Container | Image | Role | Hardening |
|-----------|-------|------|-----------|
| app | `ghcr.io/<repo>:latest` | Node.js monitoring UI | Non-root (UID 1000), RO root, no volumes |
| caddy | `caddy:2-alpine` | TLS termination, reverse proxy | Non-root, RO root, writable `/data` + `/config` |
| watchtower | `containrrr/watchtower` | Auto-update from GHCR | RO root, Docker socket (read-only) |
| wireguard | `linuxserver/wireguard` | VPN tunnel (optional) | NET_ADMIN cap, RO root, tmpfs |

## State Transitions

### Server Lifecycle

```
Empty Account → terraform apply → Server Running + Object Storage Ready
  → cloud-init → Docker Running + Containers Started
  → Watchtower polls → Auto-updates on new image push
```

### VPN Toggle

```
VPN Disabled (default) → change variable + terraform apply → VPN Enabled
  → COMPOSE_PROFILES=vpn → WireGuard container starts
  → App routes through VPN to on-site devices
```
