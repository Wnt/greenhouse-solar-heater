# Feature Specification: Mutable Server Configuration

**Feature Branch**: `005-fix-vpn-immutable-config`
**Created**: 2026-03-21
**Status**: Draft
**Input**: User description: "if I run terraform apply after a `enable_vpn = true` change, the server is going to be recreated. How can we move this kind of changes outside of the immutable part of the system? I want to be able to add components like this without recreating the whole server, which causes downtime and manual work with the DNS"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enable VPN Without Server Recreation (Priority: P1)

As a system operator, I want to enable the VPN component on a running server by changing a Terraform variable and applying, without the server being destroyed and recreated. Today, toggling `enable_vpn = true` changes the cloud-init user_data (which contains the `.env` file), forcing UpCloud to destroy and rebuild the server. This causes downtime and requires manual DNS re-pointing because the server gets a new IP address.

**Why this priority**: This is the exact pain point described. Server recreation causes real downtime, manual DNS work, and loss of Caddy's TLS certificates (which must be re-issued). It's the primary blocker for incremental infrastructure changes.

**Independent Test**: Can be fully tested by running `terraform plan` with `enable_vpn = true` on an existing server and confirming the plan shows zero changes to the server resource — only firewall and deployer-level changes.

**Acceptance Scenarios**:

1. **Given** a running server with `enable_vpn = false`, **When** the operator sets `enable_vpn = true` and runs `terraform apply`, **Then** the server resource is NOT destroyed or recreated — only the firewall rules and deployer configuration are updated.
2. **Given** a running server with `enable_vpn = true`, **When** the operator sets `enable_vpn = false` and runs `terraform apply`, **Then** the server resource is NOT destroyed or recreated — only the firewall rules and deployer configuration are updated.
3. **Given** a running server with VPN just enabled, **When** the deployer runs its next cycle, **Then** the VPN container starts automatically without manual intervention.

---

### User Story 2 - Add New Components Without Server Recreation (Priority: P2)

As a system operator, I want to add or remove optional service components (like VPN, monitoring agents, or future services) by changing Terraform variables, without triggering a full server rebuild. The system should have a clear separation between one-time bootstrap configuration (OS, Docker, deploy user) and ongoing service configuration (which services run, environment variables, feature flags).

**Why this priority**: This generalizes the VPN problem to any future component. If only VPN is fixed but the architecture still bakes mutable config into cloud-init, the next optional component will hit the same wall.

**Independent Test**: Can be tested by adding a hypothetical new Terraform variable for a future optional component and confirming `terraform plan` shows no server changes.

**Acceptance Scenarios**:

1. **Given** a running server, **When** the operator changes any service-level configuration variable (feature flags, optional components), **Then** `terraform plan` shows zero changes to the server resource.
2. **Given** a running server, **When** a new environment variable is added to the service configuration, **Then** the change is applied by the deployer on its next cycle without server recreation.
3. **Given** a running server, **When** the operator changes the server plan or OS image, **Then** the server IS recreated (these are legitimately immutable properties).

---

### User Story 3 - Maintain Security of Secrets (Priority: P2)

As a system operator, I want secrets (session keys, S3 credentials) to remain secure when configuration is split between immutable and mutable layers. Moving configuration out of cloud-init must not weaken the security posture — secrets must still be protected at rest and in transit.

**Why this priority**: Equal to P2 because splitting config could accidentally expose secrets if done carelessly. The current approach (cloud-init writes secrets to a 0600 file) is secure; the new approach must maintain equivalent protection.

**Independent Test**: Can be tested by inspecting the deployed server's file permissions and verifying secrets are not exposed in Terraform state, deployer logs, or container environment beyond what's necessary.

**Acceptance Scenarios**:

1. **Given** the new configuration architecture, **When** secrets are stored or transmitted, **Then** they are never written to the deployer image, git repository, or container logs.
2. **Given** a server with the new config architecture, **When** an attacker gains access to the deployer image, **Then** no secrets are exposed (secrets remain on the server or in S3, not in the image).

---

### Edge Cases

- What happens when the deployer updates the `.env` but the server already has running containers with the old values? The deployer must restart affected containers for changes to take effect.
- What happens on a brand-new server (first-ever provision)? Cloud-init must still write the initial secrets and bootstrap config so the deployer has something to work with on first run.
- What happens if the deployer fails to update the `.env`? Running services must continue operating with the previous configuration — no data loss or downtime from a failed deployer cycle.
- What happens when Terraform variables change but the deployer hasn't run yet? The system should be in a consistent state where the old config keeps working until the deployer applies the new config.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST separate server bootstrap configuration (OS setup, Docker install, deploy user creation, systemd timer) from service-level configuration (which containers run, environment variables, feature flags).
- **FR-002**: Changes to service-level configuration (e.g., enabling VPN, adding environment variables) MUST NOT trigger server recreation in Terraform.
- **FR-003**: The deployer MUST be responsible for applying service-level configuration changes to the running server, including updating the `.env` file and restarting affected services.
- **FR-004**: Cloud-init MUST only contain truly one-time bootstrap steps: OS packages, Docker installation, deploy user creation, systemd units, and initial secrets seeding.
- **FR-005**: The firewall rules MUST remain independently updateable without server recreation (this already works today via the separate `upcloud_firewall_rules` resource).
- **FR-006**: The `enable_vpn` variable MUST control both the firewall rule (Terraform) and the Compose profile activation (deployer), coordinated without server recreation.
- **FR-007**: Secrets MUST be seeded during initial server creation (cloud-init) and MUST NOT be embedded in the deployer image or git repository.
- **FR-008**: The deployer MUST be able to merge or update environment variables without overwriting secrets that were seeded at bootstrap time.
- **FR-009**: The system MUST support adding new optional components in the future by following the same mutable configuration pattern established for VPN.

### Key Entities

- **Bootstrap Config**: One-time server setup that legitimately requires server recreation if changed (OS, Docker, deploy user, systemd units, initial secrets). Written by cloud-init.
- **Service Config**: Ongoing operational configuration that should be changeable without server recreation (feature flags, optional components, non-secret environment variables). Managed by the deployer.
- **Secrets**: Sensitive values (session secret, S3 credentials) seeded at bootstrap, referenced by services, never stored in the deployer image.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Toggling VPN on or off via Terraform produces a plan with zero server resource changes — only firewall and deployer image changes.
- **SC-002**: After applying a VPN toggle change and one deployer cycle, the VPN container is running (or stopped) within 10 minutes without manual intervention.
- **SC-003**: Server IP address remains stable across all service-level configuration changes, eliminating DNS re-pointing.
- **SC-004**: All existing functionality (web UI, auth, S3 persistence, TLS) continues working through a VPN enable/disable cycle with zero downtime.
- **SC-005**: A new optional component can be added to the system following the established pattern without modifying cloud-init or triggering server recreation.
