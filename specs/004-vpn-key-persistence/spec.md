# Feature Specification: VPN Key Persistence

**Feature Branch**: `004-vpn-key-persistence`
**Created**: 2026-03-21
**Status**: Draft
**Input**: User description: "Add S3 persistence for WireGuard VPN keys, similar to how credentials are handled"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Survive Server Recreation (Priority: P1)

An operator recreates the UpCloud server (e.g., via `terraform destroy` + `terraform apply`). After the new server boots and the deployer runs, the WireGuard VPN tunnel re-establishes automatically using the same keys — no manual key regeneration or UniFi peer reconfiguration required.

**Why this priority**: This is the core reason for the feature. Without it, every server recreation requires manual key regeneration and reconfiguration of both the server and the UniFi peer, which is error-prone and causes downtime.

**Independent Test**: Can be tested by verifying that after a server rebuild, the VPN config with persisted keys is restored and the tunnel comes up without manual intervention.

**Acceptance Scenarios**:

1. **Given** a running server with an active WireGuard tunnel, **When** the server is destroyed and recreated, **Then** the deployer restores the VPN configuration from storage and the tunnel re-establishes without manual key exchange.
2. **Given** a fresh server with no local WireGuard config, **When** the deployer runs and storage contains a saved VPN config, **Then** the config is written to the expected location and the WireGuard container starts successfully.
3. **Given** a fresh server with no local WireGuard config and no VPN config in storage, **When** the deployer runs, **Then** VPN is not started and the system operates normally without VPN (graceful absence).

---

### User Story 2 - Initial Key Provisioning (Priority: P2)

An operator sets up VPN for the first time. They generate WireGuard keys, create the `wg0.conf` with real keys and peer details, and the system persists the configuration to durable storage so it survives future server rebuilds.

**Why this priority**: The initial setup is a one-time operation, but it must store the keys durably for Story 1 to work.

**Independent Test**: Can be tested by creating a VPN config on the server, triggering the persistence step, and verifying the config appears in durable storage.

**Acceptance Scenarios**:

1. **Given** an operator has created a valid `wg0.conf` on the server, **When** the persistence mechanism runs, **Then** the config is uploaded to durable storage.
2. **Given** a VPN config already exists in storage, **When** the operator updates the local config and triggers persistence, **Then** the updated config replaces the previous version in storage.

---

### Edge Cases

- What happens when durable storage is unreachable during deployment? The deployer should log a warning and continue without VPN rather than failing the entire deployment.
- What happens when the stored config is corrupted or empty? The system should treat it as absent and log a warning.
- What happens when VPN is disabled (Compose profile not active)? The config should still be persisted and restored for when VPN is later enabled, but no VPN container should start.
- What happens when the config file exists locally but not in storage (first deployment after enabling persistence)? The local config should be uploaded to storage.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST persist the WireGuard configuration file to durable storage so it survives server recreation.
- **FR-002**: The system MUST restore the WireGuard configuration from durable storage to the local filesystem during deployment when storage contains a saved config.
- **FR-003**: The system MUST reuse the same storage infrastructure already configured for credential persistence — no additional storage accounts or credentials required.
- **FR-004**: The system MUST NOT fail the overall deployment if VPN config is absent from both local filesystem and storage.
- **FR-005**: The system MUST NOT fail the overall deployment if storage is temporarily unreachable when fetching VPN config.
- **FR-006**: The system MUST store the VPN config separately from other persisted data (e.g., distinct object key from credentials).
- **FR-007**: The system MUST support the existing two-step VPN enablement flow (firewall rule + Compose profile) without changes to that flow.
- **FR-008**: The system MUST upload the local VPN config to storage if it exists locally but not in storage (bootstrap scenario).

### Key Entities

- **VPN Configuration**: The WireGuard config file containing server private key, listen port, address, and peer public key + allowed IPs.
- **Storage Object**: A durable copy of the VPN configuration, keyed separately from credentials, in the same storage location.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: After server recreation, the VPN tunnel re-establishes without manual key exchange or peer reconfiguration — zero manual steps required.
- **SC-002**: Deployment succeeds within normal time bounds regardless of whether VPN config exists in storage or not.
- **SC-003**: Existing deployments without VPN enabled continue to work with no changes to their workflow.
- **SC-004**: The operator can update VPN config once, and all future server rebuilds automatically use the updated config.

## Assumptions

- The existing storage bucket and credentials (used for credential persistence) are available and sufficient for storing the VPN config.
- The VPN config file is small (< 1 KB) and does not require special handling for size.
- The deployer has network access to the storage service (same as the app uses for credentials).
- Initial key generation remains a manual one-time step — the system persists keys, it does not generate them.
- The config file format is stable and does not change between software versions.
