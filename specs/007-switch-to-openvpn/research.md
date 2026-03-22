# Research: Switch to OpenVPN

## R1: UniFi Site-to-Site OpenVPN Mode

**Decision**: Use OpenVPN static key (PSK) mode, not PKI/certificate-based mode.

**Rationale**: The UniFi gateway's site-to-site VPN UI (Settings → VPN → OpenVPN) uses Pre-Shared Key authentication. This maps to OpenVPN's `--secret` static key mode. The UI fields confirm this:
- Pre-Shared Key (the static key file content)
- Local/Remote Tunnel IP Addresses (maps to `--ifconfig`)
- Port 1194 (standard OpenVPN UDP port)
- Cipher: Default
- Remote Networks (maps to `--route`)

Static key mode is simpler than PKI — a single shared secret file instead of CA, server cert, client cert, and DH parameters. This is appropriate for a single site-to-site tunnel.

**Alternatives considered**:
- PKI/certificate mode: More complex, designed for multi-client scenarios. Overkill for a single site-to-site tunnel. Not compatible with UniFi's site-to-site VPN UI.
- IPsec: UniFi supports this too, but OpenVPN was explicitly chosen by the user.

## R2: OpenVPN Static Key Configuration

**Decision**: Generate a 2048-bit static key using `openvpn --genkey --secret static.key`.

**Rationale**: OpenVPN static key mode uses a single shared secret file for both encryption and authentication. The key file is a text file containing hex-encoded key material. Both sides (server and client) use the same key file.

**Server config format** (compatible with UniFi client):
```
dev tun
proto udp
port 1194
secret /etc/openvpn/static.key
ifconfig 10.10.10.1 10.10.10.2
route 192.168.1.0 255.255.255.0
keepalive 10 60
persist-tun
persist-key
verb 3
```

**UniFi client-side configuration** (entered in the UI):
- Pre-Shared Key: contents of `static.key` (the hex block)
- Local Tunnel IP: 10.10.10.2 (UniFi end)
- Remote Tunnel IP: 10.10.10.1 (cloud server end)
- Remote IP Address: cloud server's public IP
- Remote Networks: 10.10.10.0/24 (tunnel subnet, if needed from client side)
- Port: 1194

## R3: Docker Container Choice

**Decision**: Use `alpine` + `openvpn` package with a custom entrypoint script (not a pre-built OpenVPN Docker image).

**Rationale**:
- Pre-built images like `kylemanna/openvpn` are designed for PKI/certificate-based multi-client setups. They include heavy EasyRSA tooling and initialization scripts that are unnecessary for static key mode.
- A plain Alpine container with the `openvpn` package is minimal (~10MB), easy to understand, and gives full control over the config.
- The Dockerfile is trivial: `FROM alpine`, `RUN apk add --no-cache openvpn`, `CMD ["openvpn", "--config", "/etc/openvpn/server.conf"]`.
- This aligns with the project's principle of simplicity and avoids pulling in opaque third-party images.

**Alternatives considered**:
- `kylemanna/openvpn`: Too heavyweight for static key mode. Designed for PKI with EasyRSA.
- `dperson/openvpn`: Similar complexity issues, unmaintained.
- `linuxserver/openvpn`: Feature-rich but overkill for a single tunnel.

## R4: Network Namespace Sharing

**Decision**: `network_mode: "service:openvpn"` works identically to `network_mode: "service:wireguard"`.

**Rationale**: Docker Compose `network_mode: "service:<name>"` shares the network namespace of the target service regardless of what that service runs. The app container will share the OpenVPN container's network namespace, gaining access to the `tun0` interface and all routes configured by OpenVPN. This is a Docker/kernel-level feature, not VPN-specific.

**Key difference from WireGuard**: OpenVPN creates a `tun0` userspace device (via /dev/net/tun) instead of a kernel-level WireGuard interface. The container needs `NET_ADMIN` capability and access to `/dev/net/tun`. It does NOT need `SYS_MODULE` (no kernel module loading required, unlike WireGuard).

## R5: S3 Persistence for OpenVPN Config

**Decision**: Bundle the OpenVPN config and static key into a single tar archive for S3 persistence (similar approach to WireGuard's single wg0.conf file).

**Rationale**: OpenVPN static key mode requires two files:
1. `server.conf` — the OpenVPN server configuration
2. `static.key` — the pre-shared key

Bundling them into a tar archive (`openvpn-config.tar`) keeps the S3 persistence pattern simple — a single S3 object, just like the current `wg0.conf`. The vpn-config.js helper uploads/downloads this archive and extracts to the expected directory.

**Alternatives considered**:
- Two separate S3 objects: More complex S3 operations, two download/upload calls, harder to keep in sync.
- Embedding the key in the config file using `<secret>` inline tags: OpenVPN supports this, making it a single file. This is actually simpler and avoids the tar archive entirely.

**Revised decision**: Use OpenVPN's inline `<secret>` tag to embed the static key directly in the server config file. This makes it a single file (`openvpn.conf`) — same pattern as WireGuard's `wg0.conf`.

## R6: Setup Config Generation Tool

**Decision**: Create a shell script `deploy/openvpn/setup.sh` that generates the OpenVPN server config and static key, and outputs the values needed for UniFi configuration.

**Rationale**: The user needs a tool that:
1. Generates the static key (`openvpn --genkey --secret`)
2. Creates the server config file with the key embedded inline
3. Prints the values to enter in the UniFi UI (pre-shared key, tunnel IPs, remote IP, remote networks)

This replaces the manual WireGuard key generation steps documented in `wg0.conf.example`.

## R7: Firewall Port Change

**Decision**: Change the firewall rule from UDP 51820 (WireGuard) to UDP 1194 (OpenVPN).

**Rationale**: Standard OpenVPN port. Matches the UniFi default. The Terraform variable `enable_vpn` remains the same — just the port and comment change.

## R8: Static Key Deprecation in OpenVPN 2.6+

**Finding**: OpenVPN static key mode is deprecated as of OpenVPN 2.6 (logs a warning). OpenVPN 2.7 requires `--allow-deprecated-insecure-static-crypto` to use it. OpenVPN 2.8 will remove it entirely.

**Decision**: Accept the deprecation warning. Pin the Alpine OpenVPN package to 2.6.x if needed.

**Rationale**: UniFi's site-to-site VPN firmware only supports static key mode for OpenVPN. There is no alternative that works with UniFi's UI. The recommended replacement (`peer-fingerprint` with self-signed certs) is not supported by UniFi. Alpine currently ships OpenVPN 2.6.x where static key works with a deprecation warning in logs — this is cosmetic and does not affect functionality.

**Mitigation**: If a future Alpine version ships OpenVPN 2.7+, the Dockerfile can pin to a specific Alpine version (e.g., `alpine:3.21`) or add `--allow-deprecated-insecure-static-crypto` to the OpenVPN command. If UniFi adds `peer-fingerprint` support in the future, the config can be migrated.

## R9: Keepalive and Reconnection

**Decision**: Use `ping 15` / `ping-restart 45` / `ping-timer-rem` instead of `keepalive 10 60`.

**Rationale**: The `keepalive` directive is a macro that expands to `ping` and `ping-restart` with slightly different semantics. Using the explicit directives provides clearer control. `ping-timer-rem` delays the ping timer until a remote address is known — appropriate since the UniFi client initiates the connection.

## R10: Caddyfile Reverse Proxy Target

**Decision**: Change Caddyfile `reverse_proxy` target from `wireguard:3000` to `openvpn:3000`.

**Rationale**: Since the app uses `network_mode: "service:openvpn"`, its port 3000 is exposed on the openvpn container's network namespace. Caddy resolves the Docker Compose service name to reach it.
