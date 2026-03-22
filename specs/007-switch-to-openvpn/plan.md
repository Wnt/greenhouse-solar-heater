# Implementation Plan: Switch to OpenVPN

**Branch**: `007-switch-to-openvpn` | **Date**: 2026-03-22 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/007-switch-to-openvpn/spec.md`

## Summary

Replace WireGuard with OpenVPN for the site-to-site VPN tunnel between the UpCloud cloud server and the home UniFi gateway. OpenVPN is needed because UniFi does not support WireGuard for site-to-site connections with bidirectional routing (cloud→home LAN). The implementation uses OpenVPN's static key (PSK) mode, which matches the UniFi site-to-site VPN UI. A setup script generates the server config and outputs values for the UniFi UI.

## Technical Context

**Language/Version**: POSIX shell (setup script, deployer), HCL (Terraform >= 1.5), Node.js 20 LTS (vpn-config.js), YAML (docker-compose)
**Primary Dependencies**: OpenVPN (Alpine package), Docker Compose v2, @aws-sdk/client-s3 (existing)
**Storage**: UpCloud Managed Object Storage (S3-compatible) for VPN config persistence
**Testing**: node:test (unit tests for vpn-config.js)
**Target Platform**: Linux server (UpCloud DEV-1xCPU-1GB-10GB, Ubuntu 24.04 LTS)
**Project Type**: Infrastructure/deployment configuration
**Performance Goals**: VPN tunnel established within 30 seconds of container start
**Constraints**: Single site-to-site tunnel, UniFi PSK mode compatibility, no PKI/CA required
**Scale/Scope**: Single server, single VPN peer (UniFi gateway)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Source of Truth | N/A | This feature is software/deployment infrastructure, not hardware |
| II. Pure Logic / IO Separation | N/A | No control logic changes |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | VPN is optional (`COMPOSE_PROFILES=vpn`), firewall defaults to closed, deployer continues without VPN on failure |
| IV. Proportional Test Coverage | PASS | vpn-config.js tests updated for new config key, setup script tested manually |
| V. Token-Based Cloud Auth | PASS | No UpCloud auth changes — uses existing UPCLOUD_TOKEN for Terraform |
| VI. Durable Data Persistence | PASS | VPN config persisted to S3, not container-local filesystem |

**Gate result**: PASS — no violations.

## Project Structure

### Documentation (this feature)

```text
specs/007-switch-to-openvpn/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (created by /speckit.tasks)
```

### Source Code (repository root)

```text
deploy/
├── openvpn/
│   ├── Dockerfile           # NEW: Alpine + openvpn package
│   ├── server.conf.example  # NEW: Template server config (replaces wg0.conf.example)
│   └── setup.sh             # NEW: Generates static key + server config + UniFi instructions
├── deployer/
│   ├── docker-compose.yml   # MODIFY: Replace wireguard service with openvpn
│   ├── deploy.sh            # MODIFY: Update VPN config file references
│   └── config.env           # MODIFY: Update VPN_CONFIG_KEY default
├── terraform/
│   ├── main.tf              # MODIFY: Change firewall port 51820→1194, update comment
│   └── variables.tf         # MODIFY: Update enable_vpn description
├── wireguard/               # DELETE: Entire directory (wg0.conf.example)
└── README.md                # MODIFY: Update VPN setup instructions

monitor/
└── lib/
    └── vpn-config.js        # MODIFY: Update comments/defaults (wg0.conf → openvpn.conf)

tests/
└── vpn-config.test.js       # MODIFY: Update sample config and key references

CLAUDE.md                    # MODIFY: Update VPN references throughout
```

**Structure Decision**: No new directories except `deploy/openvpn/` which replaces `deploy/wireguard/`. All changes are in existing deployment infrastructure files.

## Key Design Decisions

### D1: OpenVPN Static Key with Inline Secret

Use OpenVPN's `<secret>` inline tag to embed the static key directly in `server.conf`. This keeps it as a single file — same S3 persistence pattern as the current `wg0.conf`. No need for tar archives or multiple S3 objects.

**Server config structure**:
```
dev tun
proto udp
port 1194
ifconfig 10.10.10.1 10.10.10.2
route 192.168.1.0 255.255.255.0
keepalive 10 60
persist-tun
persist-key
verb 3

<secret>
[static key content here]
</secret>
```

### D2: Custom Alpine Dockerfile (not pre-built image)

Build a minimal OpenVPN container from Alpine instead of using pre-built images:
```dockerfile
FROM alpine:3.21
RUN apk add --no-cache openvpn
CMD ["openvpn", "--config", "/etc/openvpn/server.conf"]
```

Pre-built images (kylemanna/openvpn, etc.) are designed for PKI multi-client setups and include EasyRSA tooling that's unnecessary for static key mode. The Alpine image is ~10MB and fully transparent.

The image is built locally by Docker Compose (`build: ../openvpn`) — no GHCR push needed since it's a simple Alpine+openvpn package. Alternatively, can use `image: alpine:3.21` with `command: sh -c "apk add --no-cache openvpn && openvpn --config /etc/openvpn/server.conf"` to avoid a custom Dockerfile entirely — but a Dockerfile is cleaner for the `--cap-add` and volume mount documentation.

### D3: Setup Script

`deploy/openvpn/setup.sh` will:
1. Check that `openvpn` is available (or use Docker to run it)
2. Generate a static key: `openvpn --genkey --secret static.key`
3. Accept parameters: server tunnel IP, client tunnel IP, remote network, port
4. Generate `openvpn.conf` with the key embedded inline via `<secret>` tag
5. Output the values to enter in the UniFi UI:
   - Pre-Shared Key (the hex content from the static key)
   - Remote IP Address (cloud server public IP — user provides or auto-detects)
   - Remote Tunnel IP Address + Port
   - Remote Networks
6. Copy the generated config to the deployment path

### D4: Docker Compose Changes

Replace the `wireguard` service with `openvpn`:
```yaml
openvpn:
  build: ../openvpn
  restart: unless-stopped
  cap_add:
    - NET_ADMIN
  volumes:
    - ./openvpn.conf:/etc/openvpn/server.conf:ro
  ports:
    - "1194:1194/udp"
  devices:
    - /dev/net/tun:/dev/net/tun
  sysctls:
    - net.ipv4.ip_forward=1
```

Key differences from WireGuard:
- No `SYS_MODULE` capability needed (OpenVPN doesn't load kernel modules)
- Needs `/dev/net/tun` device access
- Port changes: 51820/udp → 1194/udp
- Config mount path changes
- App changes: `network_mode: "service:openvpn"`, `depends_on: openvpn`

### D5: VPN Config Persistence

Update `monitor/lib/vpn-config.js`:
- Change default `VPN_CONFIG_KEY` from `wg0.conf` to `openvpn.conf`
- Update comments and log messages
- The download/upload logic remains identical (single file, text content)

Update `deploy/deployer/deploy.sh`:
- Change `VPN_CONFIG` path from `wg0.conf` to `openvpn.conf`
- Update log messages

The S3 persistence mechanism is file-format agnostic — it just uploads/downloads a text file. No logic changes needed.

## Complexity Tracking

No constitution violations to justify. All changes are direct replacements within existing patterns.
