# Quickstart: Switch to OpenVPN

## Prerequisites

- UpCloud server provisioned with Terraform (`deploy/terraform/`)
- UniFi gateway with access to VPN settings (Settings → VPN)
- Docker and Docker Compose on the server

## Setup Steps

### 1. Generate OpenVPN Configuration

Run the setup script to generate the server config and static key:

```bash
cd deploy/openvpn
./setup.sh --server-ip <CLOUD_SERVER_PUBLIC_IP> \
           --server-tunnel-ip 10.10.10.1 \
           --client-tunnel-ip 10.10.10.2 \
           --remote-network 192.168.1.0/24 \
           --port 1194 \
           --output /opt/app/openvpn.conf
```

The script will:
- Generate a static key
- Create `openvpn.conf` with the key embedded inline
- Print the values to enter in the UniFi UI

### 2. Configure UniFi Gateway

In the UniFi web UI: **Settings → VPN → Create New VPN**

| Field | Value |
|-------|-------|
| VPN Type | OpenVPN |
| Name | greenhouse-cloud |
| Pre-Shared Key | (paste from setup.sh output) |
| Local Tunnel IP Address | 10.10.10.2 |
| Local Port | 1194 |
| Cipher | Default |
| Remote Networks | 10.10.10.0/24 |
| Remote IP Address | (cloud server public IP) |
| Remote Tunnel IP Address | 10.10.10.1 |
| Port | 1194 |
| MTU | Auto |
| MSS | Auto |

### 3. Enable VPN in Terraform

```bash
cd deploy/terraform
# Edit terraform.tfvars:
#   enable_vpn = true
terraform apply
```

This adds the UDP 1194 firewall rule.

### 4. Enable VPN on Server

Add `COMPOSE_PROFILES=vpn` to `/opt/app/.env` via UpCloud web console, or ensure it's set in `.env.secrets`.

### 5. Deploy

The deployer will automatically:
1. Upload `openvpn.conf` to S3 (first run only)
2. Start the OpenVPN container
3. The UniFi gateway will connect and establish the tunnel

### 6. Verify

```bash
# Check health endpoint
curl https://greenhouse.madekivi.fi/health
# Expected: {"status":"ok","vpn":"connected",...}
```

## Migration from WireGuard

If migrating from an existing WireGuard setup:

1. Set `COMPOSE_PROFILES=` (empty) to disable VPN temporarily
2. Run deployer (WireGuard container stops)
3. Follow steps 1-5 above for OpenVPN
4. The old `wg0.conf` in S3 can be deleted manually after verifying OpenVPN works

## Troubleshooting

- **Tunnel not connecting**: Check firewall rule exists (`enable_vpn = true` in Terraform), verify UniFi can reach the server's public IP on port 1194/UDP
- **Health shows "disconnected"**: VPN container may not be running — check `COMPOSE_PROFILES=vpn` is set, check container logs
- **App can't reach devices**: Verify routes — the OpenVPN server needs `route 192.168.1.0 255.255.255.0` and `ip_forward=1`
