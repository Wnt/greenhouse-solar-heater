# Quickstart: Mutable Server Configuration

**Feature**: 005-fix-vpn-immutable-config
**Date**: 2026-03-21

## What This Changes

Previously, all environment variables were baked into cloud-init `user_data`, making any config change force server recreation. Now:

- **Secrets** (S3 credentials, session key) stay in cloud-init → changing them still recreates the server (expected)
- **Service config** (VPN toggle, domain, feature flags) lives in the deployer image → changes deploy automatically via git push, no server recreation

## Common Operations

### Enable VPN (no server recreation)

1. Edit `deploy/deployer/config.env`:
   ```
   COMPOSE_PROFILES=vpn
   VPN_CHECK_HOST=10.0.0.1  # your VPN peer IP
   ```
2. Commit and push → CD rebuilds deployer image → deployer applies within ~5 min
3. Open the firewall port:
   ```bash
   terraform apply -var="enable_vpn=true"
   ```
   This only modifies the firewall rules resource — server is untouched.

### Disable VPN (no server recreation)

1. Edit `deploy/deployer/config.env`:
   ```
   COMPOSE_PROFILES=
   VPN_CHECK_HOST=
   ```
2. Commit and push
3. Close the firewall port:
   ```bash
   terraform apply -var="enable_vpn=false"
   ```

### Change Domain

1. Update `deploy/deployer/config.env` with new DOMAIN, RPID, ORIGIN values
2. Commit and push
3. Update DNS A record to point to server IP
4. Update Terraform `domain` variable if it's used for firewall comments or naming

### Rotate Secrets

This is the one operation that still requires server recreation:

```bash
terraform apply -var="session_secret=$(openssl rand -hex 32)"
```

This is expected — secrets are seeded at provision time and changing them is rare.

## File Layout After Implementation

```
/opt/app/              (on server)
├── .env.secrets       ← cloud-init (secrets only, never changed by deployer)
├── config.env         ← deployer image (mutable service config)
├── .env               ← deployer merge output (consumed by docker-compose)
├── docker-compose.yml ← deployer image
├── Caddyfile          ← deployer image
└── wg0.conf           ← S3 download (VPN config)
```

## Verification

After implementation, verify the split works:

```bash
# Should show NO changes to upcloud_server.monitor
terraform plan -var="enable_vpn=true"

# Should only show changes to:
#   upcloud_firewall_rules.monitor (add WireGuard rule)
```
