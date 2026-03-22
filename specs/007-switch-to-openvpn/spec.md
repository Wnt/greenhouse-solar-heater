# Feature Specification: Switch to OpenVPN

**Feature Branch**: `007-switch-to-openvpn`
**Created**: 2026-03-22
**Status**: Draft
**Input**: User description: "change the VPN server to OpenVPN. WireGuard is not usable in Unifi for site-to-site connections, which we want to enable here, e.g. allow connections from VPN server-side to the IoT Devices on VPN client side"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cloud Server Reaches Home IoT Devices via OpenVPN (Priority: P1)

As a system operator, the cloud-hosted monitoring app connects to Shelly IoT devices on the home LAN through an OpenVPN tunnel, replacing the current WireGuard tunnel. The app continues to proxy sensor readings and valve commands to Shelly devices exactly as before, but the underlying VPN technology is OpenVPN. The UniFi gateway at home acts as the OpenVPN client, establishing a site-to-site connection to the cloud server.

**Why this priority**: This is the core functionality — without the tunnel, the cloud app cannot reach any IoT devices. OpenVPN is required because UniFi does not support WireGuard for site-to-site VPN, which is needed for bidirectional routing (cloud server initiating connections to home LAN devices).

**Independent Test**: Can be fully tested by deploying the OpenVPN server container, connecting the UniFi client, and verifying that the monitoring app can reach a Shelly device on the home LAN (e.g., successful HTTP RPC call to the controller).

**Acceptance Scenarios**:

1. **Given** the cloud server is running with OpenVPN enabled, **When** the UniFi gateway connects as an OpenVPN client, **Then** the monitoring app can make HTTP requests to Shelly devices on the home LAN (192.168.1.0/24).
2. **Given** the OpenVPN tunnel is established, **When** the monitoring app proxies an RPC request to the Shelly controller, **Then** the response is returned successfully within the existing timeout thresholds.
3. **Given** the OpenVPN tunnel is established, **When** the cloud server initiates a connection to a device on the home LAN, **Then** the connection succeeds (site-to-site bidirectional routing works).

---

### User Story 2 - VPN Configuration Persists Across Server Recreation (Priority: P2)

As a system operator, the OpenVPN configuration (server keys, certificates, and config files) is stored in S3 object storage so that when the cloud server is recreated (e.g., Terraform apply), the VPN configuration is automatically restored without manual intervention.

**Why this priority**: Without persistence, every server recreation would require manual VPN reconfiguration and re-exchanging keys with the UniFi gateway, causing significant downtime.

**Independent Test**: Can be tested by uploading an OpenVPN config to S3, destroying and recreating the server, and verifying that the deployer automatically restores the VPN config and the tunnel re-establishes.

**Acceptance Scenarios**:

1. **Given** a working OpenVPN configuration exists in S3, **When** the server is recreated and the deployer runs, **Then** the OpenVPN config is downloaded from S3 and the VPN container starts with the restored configuration.
2. **Given** a local OpenVPN configuration exists but is not yet in S3, **When** the deployer runs, **Then** the configuration is uploaded to S3 for future recovery.

---

### User Story 3 - Health Monitoring Reports VPN Status (Priority: P3)

As a system operator, the health endpoint continues to report VPN tunnel status (connected/disconnected/degraded) so that monitoring dashboards and alerts work as before.

**Why this priority**: Operational visibility is important but the system functions without it. The existing health check mechanism (TCP probe to a home LAN device) is VPN-technology-agnostic and should work unchanged.

**Independent Test**: Can be tested by querying the /health endpoint and verifying it reports VPN status correctly when the tunnel is up and when it is down.

**Acceptance Scenarios**:

1. **Given** the OpenVPN tunnel is connected, **When** the /health endpoint is queried, **Then** the response includes `"vpn": "connected"` and `"status": "ok"`.
2. **Given** the OpenVPN tunnel is disconnected, **When** the /health endpoint is queried, **Then** the response includes `"vpn": "disconnected"` and `"status": "degraded"`.

---

### Edge Cases

- What happens when the OpenVPN tunnel drops and reconnects? The app should gracefully retry device requests.
- What happens during the migration window when WireGuard is removed but OpenVPN is not yet configured? The health endpoint should report "disconnected" and the app should operate in degraded mode.
- What happens if the OpenVPN config in S3 becomes stale or corrupted? The deployer should log a warning and continue without VPN (same as current WireGuard behavior).
- What happens if the UniFi gateway's OpenVPN client cannot reach the cloud server (e.g., firewall misconfiguration)? The health endpoint reports degraded status.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST replace the WireGuard VPN container with an OpenVPN server container in the deployment stack.
- **FR-002**: System MUST allow the UniFi gateway to connect as an OpenVPN client, establishing a site-to-site tunnel.
- **FR-003**: System MUST route traffic from the cloud server (app container) to the home LAN subnet (192.168.1.0/24) through the OpenVPN tunnel.
- **FR-004**: System MUST support bidirectional routing — the cloud server MUST be able to initiate connections to devices on the home LAN (not just respond to connections from the home side).
- **FR-005**: System MUST persist the OpenVPN configuration (keys, certificates, server config) in S3 object storage, using the existing S3 persistence mechanism.
- **FR-006**: System MUST update the firewall rules to allow the OpenVPN port instead of the WireGuard port.
- **FR-007**: System MUST maintain the existing app networking pattern where the app container shares the VPN container's network namespace.
- **FR-008**: System MUST update the deployer script to handle OpenVPN config download/upload instead of WireGuard config.
- **FR-009**: System MUST update the config template and setup documentation to reflect OpenVPN setup steps (key generation, UniFi client configuration).
- **FR-010**: System MUST remove all WireGuard-specific configuration, scripts, and references from the codebase.

### Key Entities

- **VPN Server Configuration**: OpenVPN server config file containing network settings, tunnel parameters, certificate references, and routing directives. Replaces `wg0.conf`.
- **VPN Credentials**: Server certificate, server key, CA certificate, and optional TLS auth key. These must be persisted in S3 alongside the config.
- **Firewall Rule**: Cloud server firewall rule allowing inbound traffic on the OpenVPN port (replacing WireGuard UDP 51820).

## Assumptions

- The UniFi gateway supports OpenVPN client connections for site-to-site VPN. This is a well-documented UniFi feature.
- The existing S3 persistence mechanism can handle multiple files (or a bundled config archive) for OpenVPN's certificate-based setup, which requires more files than WireGuard's single-file config.
- The OpenVPN tunnel subnet will use a similar private range (e.g., 10.10.10.0/24) as the current WireGuard setup.
- OpenVPN will use UDP transport by default (standard for VPN tunnels, better performance than TCP).
- The existing Docker Compose profiles mechanism (`COMPOSE_PROFILES=vpn`) will be reused for the OpenVPN container.
- The app container will continue to use `network_mode: "service:<vpn-container>"` to share the VPN network namespace.
- The VPN health check (TCP probe to a home LAN device) requires no changes since it is VPN-technology-agnostic.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The cloud monitoring app can reach all Shelly IoT devices on the home LAN through the OpenVPN tunnel with the same reliability as the previous WireGuard setup.
- **SC-002**: The UniFi gateway successfully connects as an OpenVPN client and maintains a stable site-to-site tunnel.
- **SC-003**: The cloud server can initiate connections to home LAN devices (bidirectional routing), verified by successful HTTP requests from the app to Shelly devices.
- **SC-004**: After server recreation, the VPN tunnel is automatically restored from S3-persisted configuration within one deployer cycle (approximately 5 minutes).
- **SC-005**: All WireGuard references are removed from the codebase — no residual WireGuard configuration, scripts, or documentation remains.
- **SC-006**: The health endpoint correctly reports VPN status (connected/disconnected) with the new OpenVPN tunnel.
