# Feature Specification: Containerize UpCloud Deployment

**Feature Branch**: `002-containerize-upcloud-deploy`
**Created**: 2026-03-21
**Status**: Draft
**Input**: User description: "Minimize host logic by containerizing VPN, replace persistent volumes with UpCloud managed service, harden containers (read-only root, non-root user), add Terraform VPN toggle, focus on getting app running first."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Deploy App to Empty UpCloud Account (Priority: P1)

As a developer, I want to provision infrastructure and deploy the greenhouse monitoring app to a fresh UpCloud account so that the web UI is accessible over HTTPS on my domain.

**Why this priority**: This is the foundational story — nothing else works until the app is running. The UpCloud account is empty, so everything must be provisioned from scratch via Terraform and containers deployed successfully.

**Independent Test**: Can be fully tested by running `terraform apply` against an empty account, then deploying containers, and verifying the web UI loads at the configured domain with HTTPS. Delivers a working production monitoring interface.

**Acceptance Scenarios**:

1. **Given** an empty UpCloud account with valid API credentials, **When** the operator runs `terraform apply`, **Then** a server is provisioned with all required firewall rules and the server is reachable via SSH.
2. **Given** a provisioned server, **When** Docker containers are deployed, **Then** the app container starts, passes its health check, and the Caddy container obtains a TLS certificate and serves the web UI on port 443.
3. **Given** the app is running, **When** a user visits the domain in a browser, **Then** they see the passkey authentication page and can register their first passkey within the setup window.

---

### User Story 2 - Hardened Container Execution (Priority: P1)

As a security-conscious operator, I want all containers to run with read-only root filesystems and as non-root users so that the attack surface is minimized even if a container is compromised.

**Why this priority**: Security hardening is a deployment-time concern that must be designed in from the start — retrofitting it later requires reworking volume mounts, file permissions, and entrypoints.

**Independent Test**: Can be tested by inspecting running containers: verify the effective user is non-root, and attempting to write to the root filesystem fails. The app still functions correctly despite these restrictions.

**Acceptance Scenarios**:

1. **Given** the app container is running, **When** inspecting the container process, **Then** it runs as a non-root user (UID > 0).
2. **Given** any container in the stack, **When** a process attempts to write to the root filesystem, **Then** the write fails (read-only filesystem).
3. **Given** hardened containers, **When** the app needs to write data (credentials, sessions), **Then** writes succeed only to explicitly mounted writable paths.

---

### User Story 3 - Managed Persistence via UpCloud Service (Priority: P1)

As an operator, I want application data (credentials, sessions) stored in an UpCloud managed service instead of Docker volumes on the host, so that data survives server replacement and reduces host-level state.

**Why this priority**: Decoupling persistence from the host is essential for the "minimize host logic" goal and makes the server disposable and replaceable.

**Independent Test**: Can be tested by verifying that credential and session data persists after the app container is restarted or the host server is replaced. Data is stored in the managed service, not on the local filesystem.

**Acceptance Scenarios**:

1. **Given** the app is running with managed persistence, **When** the app container is destroyed and recreated, **Then** previously registered passkeys and active sessions remain valid.
2. **Given** managed persistence is configured, **When** inspecting the host filesystem, **Then** no application data (credentials, sessions) is stored in Docker volumes on the host.
3. **Given** the Terraform configuration, **When** infrastructure is provisioned, **Then** the managed storage service is created and accessible from the app container.

---

### User Story 4 - VPN as a Separate Container (Priority: P2)

As an operator, I want the WireGuard VPN to run in its own container rather than being installed on the host, so that VPN lifecycle is managed alongside other containers and the host remains minimal.

**Why this priority**: Moving VPN to a container supports the "minimize host logic" goal but is secondary to getting the app running. VPN is disabled initially and will be enabled when on-site device access is needed.

**Independent Test**: Can be tested by enabling the VPN toggle, deploying, and verifying the VPN container starts and establishes a tunnel to the on-site network. Shelly devices become reachable from the app container.

**Acceptance Scenarios**:

1. **Given** VPN is enabled in configuration, **When** containers are deployed, **Then** a WireGuard container starts alongside the app and Caddy containers.
2. **Given** the VPN container is running, **When** the app attempts to reach an on-site Shelly device IP, **Then** the request is routed through the VPN tunnel successfully.
3. **Given** VPN is disabled in configuration, **When** containers are deployed, **Then** no VPN container is started and no VPN-related resources are provisioned on the host.

---

### User Story 5 - Terraform VPN Toggle (Priority: P2)

As an operator, I want a boolean flag in the infrastructure configuration to enable or disable VPN provisioning so that I can deploy the app without VPN initially and add it later without changing the infrastructure code.

**Why this priority**: Supports incremental deployment — get the app running first (VPN off), then enable VPN when ready to connect to on-site devices.

**Independent Test**: Can be tested by provisioning infrastructure with VPN disabled vs enabled and verifying the difference in provisioned resources.

**Acceptance Scenarios**:

1. **Given** the VPN toggle is set to disabled (default), **When** provisioning infrastructure, **Then** no WireGuard-related resources (firewall rules for VPN port, VPN configuration) are included.
2. **Given** the VPN toggle is changed from disabled to enabled, **When** provisioning infrastructure, **Then** WireGuard firewall rules are added and VPN container configuration is generated.
3. **Given** VPN was previously enabled, **When** the toggle is set to disabled and infrastructure is reprovisioned, **Then** VPN resources are cleanly removed.

---

### Edge Cases

- What happens when the managed storage service is temporarily unavailable? The app should fail gracefully with clear error messages rather than corrupting data.
- What happens when the TLS certificate renewal occurs with read-only root filesystem? The reverse proxy must have a writable path for certificate storage.
- What happens when the VPN toggle is changed on an already-running deployment? The transition should be clean — no orphaned containers or broken network routes.
- What happens when the setup window expires before the first passkey is registered? The operator should have a documented way to reset the window.
- What happens when the server is replaced (destroyed and reprovisioned)? All persistent data must survive via the managed storage service.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The infrastructure configuration MUST provision all required resources (server, firewall, managed storage) from a single provisioning command against an empty account.
- **FR-002**: The infrastructure configuration MUST include a boolean variable (default: disabled) that controls whether VPN-related resources are provisioned.
- **FR-003**: When VPN is disabled, the system MUST NOT provision VPN firewall rules or VPN container configuration.
- **FR-004**: All application containers MUST run with read-only root filesystems.
- **FR-005**: All application containers MUST run as non-root users.
- **FR-006**: The app container MUST store persistent data (credentials, sessions) in a managed storage service, not in local Docker volumes on the host.
- **FR-007**: The VPN MUST run as a container (not installed on the host) when the VPN toggle is enabled.
- **FR-008**: The app container MUST expose a health check endpoint that returns its operational status.
- **FR-009**: The reverse proxy container MUST have writable paths for TLS certificate storage despite the read-only root filesystem.
- **FR-010**: The server bootstrap process MUST set up the container runtime and deploy user without installing VPN software on the host.
- **FR-011**: The system MUST support the existing automated deployment pipeline (test, build, push, deploy).
- **FR-012**: Each container MUST have only the minimum writable tmpfs or volume mounts necessary for its function.

### Key Entities

- **Server**: The compute instance running containers, provisioned via infrastructure-as-code. Should hold no application state.
- **Managed Storage**: A cloud-provider service used for persisting application data independently from the server lifecycle.
- **App Container**: The monitoring web UI with passkey authentication, running as non-root with read-only root filesystem.
- **Reverse Proxy Container**: Handles TLS termination and HTTPS, running as non-root with read-only root filesystem.
- **VPN Container**: An optional container providing encrypted tunnel to on-site devices, controlled by the VPN toggle.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A fresh, empty cloud account can go from zero to a running, HTTPS-accessible monitoring app with a single infrastructure provisioning step plus container deployment.
- **SC-002**: All containers in the stack run as non-root users and with read-only root filesystems — verifiable by inspecting running container properties.
- **SC-003**: Application data (credentials, sessions) persists across container restarts and server reprovisioning without data loss.
- **SC-004**: Toggling VPN from disabled to enabled (or vice versa) requires only changing one configuration variable and reprovisioning — no manual server configuration needed.
- **SC-005**: The host server has no application state beyond the container runtime itself — the server is disposable and replaceable.
- **SC-006**: The monitoring web UI loads and is functional within 5 minutes of container deployment completing.

## Assumptions

- The cloud provider offers a managed storage or object storage service in the target region suitable for small-volume credential/session storage. If no managed service is cost-effective for this use case, a provider-managed block storage volume attached to the server is an acceptable alternative (still managed via infrastructure-as-code, survives server replacement).
- The existing container image build process can be adapted for non-root user and read-only filesystem without major application changes.
- The existing automated deployment pipeline structure (test, build, push, deploy) remains valid; only the deployment target configuration changes.
- The reverse proxy image supports running as non-root with appropriate volume mounts for certificates.
- A WireGuard container image is available and suitable for the VPN container role.

## Out of Scope

- Migrating away from single-server architecture (no container orchestration platforms, no multi-node clustering).
- Changing the application code beyond what is needed for non-root/read-only filesystem compatibility.
- Setting up monitoring, alerting, or log aggregation infrastructure.
- DNS management automation (DNS record creation remains manual or handled outside this feature).
- Multi-user authentication or moving away from the current credential storage format.
