# Data Model: VPN Key Persistence

**Feature**: 004-vpn-key-persistence
**Date**: 2026-03-21

## Entities

### VPN Configuration Object

The WireGuard configuration file stored as an S3 object.

| Attribute | Description |
|---|---|
| Object key | `wg0.conf` (configurable via `VPN_CONFIG_KEY` env var) |
| Bucket | Same bucket as credentials (`S3_BUCKET`) |
| Content type | `text/plain` |
| Content | Full contents of `wg0.conf` (INI-style WireGuard config) |
| Size | < 1 KB |

### Local VPN Configuration

The WireGuard configuration file on the server filesystem.

| Attribute | Description |
|---|---|
| Path | `/opt/app/wg0.conf` |
| Mounted into | WireGuard container at `/config/wg_confs/wg0.conf:ro` |
| Owner | `deploy:deploy` (UID/GID 1000) |
| Permissions | Read-only mount in container |

## State Transitions

```text
                    ┌─────────────┐
                    │  No config  │
                    │ (fresh srv) │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              │                         │
         S3 has config            S3 has no config
              │                         │
              ▼                         ▼
     ┌────────────────┐       ┌─────────────────┐
     │ Download from   │       │ No VPN config   │
     │ S3 → local      │       │ (skip, log)     │
     └────────────────┘       └─────────────────┘
              │
              ▼
     ┌────────────────┐
     │ WireGuard       │
     │ starts with     │
     │ restored config │
     └────────────────┘


                    ┌──────────────┐
                    │ Operator     │
                    │ places local │
                    │ wg0.conf     │
                    └──────┬───────┘
                           │
                    deployer runs
                           │
              ┌────────────┴────────────┐
              │                         │
         S3 has config            S3 has no config
              │                         │
              ▼                         ▼
     ┌────────────────┐       ┌─────────────────┐
     │ S3 already      │       │ Upload local    │
     │ up to date      │       │ → S3 (bootstrap)│
     │ (no-op)         │       │                 │
     └────────────────┘       └─────────────────┘
```

## Relationships

- **VPN Config ↔ S3 Bucket**: Shares the same bucket as WebAuthn credentials. Distinguished by object key (`wg0.conf` vs `credentials.json`).
- **VPN Config ↔ Deployer**: The deployer orchestrates download/upload but delegates S3 operations to the app image via `docker run`.
- **VPN Config ↔ WireGuard Container**: The WireGuard container mounts the local file read-only. It is unaware of S3 persistence.
