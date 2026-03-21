# Quickstart: VPN Key Persistence

**Feature**: 004-vpn-key-persistence

## What This Feature Does

Automatically persists the WireGuard VPN configuration (`wg0.conf`) to S3 object storage. When a server is recreated, the deployer restores the config from S3 so the VPN tunnel re-establishes without manual key regeneration.

## How It Works

1. **On deploy**: The deployer checks S3 for a stored `wg0.conf`. If found, it downloads it to `/opt/app/wg0.conf` before starting containers.
2. **Bootstrap**: If a local `wg0.conf` exists but S3 has no copy, the deployer uploads it (first-time persistence).
3. **No config**: If neither local nor S3 has a config, deployment continues without VPN.

## Setup (First Time)

1. Enable VPN in Terraform: set `enable_vpn = true` in `terraform.tfvars`, run `terraform apply`
2. Generate keys on the server:
   ```
   wg genkey | tee private.key | wg pubkey > public.key
   ```
3. Create `/opt/app/wg0.conf` from the template (`deploy/wireguard/wg0.conf.example`), filling in the real keys
4. Set `COMPOSE_PROFILES=vpn` in `/opt/app/.env`
5. On the next deployer run (within 5 minutes), the config is automatically uploaded to S3

## After Server Recreation

No action needed. The deployer automatically:
1. Downloads `wg0.conf` from S3
2. Starts the WireGuard container with the restored config
3. VPN tunnel re-establishes

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VPN_CONFIG_KEY` | `wg0.conf` | S3 object key for the VPN config |
| `S3_ENDPOINT` | (required) | Already configured for credentials |
| `S3_BUCKET` | (required) | Already configured for credentials |
| `S3_ACCESS_KEY_ID` | (required) | Already configured for credentials |
| `S3_SECRET_ACCESS_KEY` | (required) | Already configured for credentials |

## Testing

```bash
npm run test:unit    # Includes vpn-config.js unit tests
```
