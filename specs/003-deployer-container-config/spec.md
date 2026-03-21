# Feature Specification: Deployer Container for Mutable Config

**Feature Branch**: `003-deployer-container-config`
**Created**: 2026-03-21
**Status**: Draft
**Input**: User description: "Move deployment configuration (compose, reverse proxy config, etc.) out of the immutable cloud-init into a deployer container image. The deployer is updated by the same auto-update mechanism as the app. On startup it writes config files to a shared volume, then triggers a service restart. This eliminates server recreation when deployment config changes."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Update Deployment Config Without Server Recreation (Priority: P1)

As an operator, I want to change deployment configuration (container definitions, reverse proxy rules, environment settings) by pushing to the repository, so that the running server picks up the new config automatically without being destroyed and reprovisioned.

**Why this priority**: This is the core value proposition — eliminating the immutable cloud-init dependency for runtime configuration. Without this, any config change forces a full server rebuild with minutes of downtime.

**Independent Test**: Can be tested by modifying a deployment config file in the repository, pushing to main, and verifying the server applies the new configuration within the auto-update polling interval. The server is not recreated — only the deployer container is updated and services are restarted.

**Acceptance Scenarios**:

1. **Given** a running deployment with the current configuration, **When** the operator modifies a deployment config file and pushes to main, **Then** the automated pipeline builds a new deployer image and the server applies the updated configuration without server recreation.
2. **Given** a running deployment, **When** the deployer container starts with updated config, **Then** it writes the new configuration files and signals the other services to restart with the new config.
3. **Given** a running deployment, **When** the deployer config changes but the app image has not changed, **Then** only the services affected by the config change are restarted.

---

### User Story 2 - Add or Replace Services Without Downtime (Priority: P1)

As an operator, I want to add new services (e.g., enable VPN) or replace existing ones (e.g., swap the reverse proxy) by changing config in the repository, so that the server adapts without requiring infrastructure reprovisioning.

**Why this priority**: The current system bakes the service definitions into cloud-init. Adding VPN or changing the reverse proxy forces server destruction. This story directly addresses the operator's stated pain point.

**Independent Test**: Can be tested by enabling the VPN service in the config, pushing to main, and verifying the VPN container starts on the server alongside existing services. No server recreation occurs and existing services (app, reverse proxy) remain running throughout.

**Acceptance Scenarios**:

1. **Given** a running deployment without VPN, **When** the operator enables VPN in the deployment config and pushes, **Then** the VPN service starts on the server without affecting the app or reverse proxy uptime.
2. **Given** a running deployment with a specific reverse proxy, **When** the operator replaces it with a different one in the config, **Then** the old reverse proxy is stopped and the new one starts, with only a brief interruption to HTTPS traffic (seconds, not minutes).

---

### User Story 3 - Initial Server Bootstrap (Priority: P1)

As an operator provisioning a new server from an empty account, I want the server to automatically pull the deployer image on first boot and start the full container stack, so that the initial deployment works the same way as subsequent updates.

**Why this priority**: The deployer approach must not break the initial provisioning flow. Cloud-init still handles the one-time bootstrap (install container runtime, create user), but delegates all service configuration to the deployer.

**Independent Test**: Can be tested by running the infrastructure provisioning against an empty account and verifying the server boots, pulls the deployer image, and the full stack becomes operational.

**Acceptance Scenarios**:

1. **Given** an empty cloud account, **When** the operator provisions infrastructure, **Then** the server boots, pulls the deployer image, the deployer writes initial config, and all services start.
2. **Given** a freshly provisioned server, **When** cloud-init completes, **Then** the server has a minimal bootstrap only — the container runtime and a mechanism to pull and run the deployer. All service definitions come from the deployer image.

---

### User Story 4 - Secrets Remain Separate from Config (Priority: P2)

As an operator, I want secrets (session keys, storage credentials, API tokens) to remain outside the deployer image, so that sensitive values are never baked into container images or stored in the repository.

**Why this priority**: Security is important but the mechanism is straightforward — secrets are already handled via environment variables injected at infrastructure provisioning time.

**Independent Test**: Can be tested by inspecting the deployer image contents and verifying no secrets are present. Services receive secrets via environment variables or mounted secret files that are provisioned separately from the deployer.

**Acceptance Scenarios**:

1. **Given** a deployer image, **When** inspecting its contents, **Then** no secrets (tokens, passwords, keys) are present in the image layers.
2. **Given** a running deployment, **When** a service needs a secret, **Then** it receives the secret from the infrastructure-provisioned environment, not from the deployer config.

---

### Edge Cases

- What happens when the deployer image is updated but a service it references does not yet exist in the registry? The deployer should handle missing images gracefully and log errors without crashing the entire stack.
- What happens when the deployer writes invalid configuration? The existing running services should not be stopped until the new config is validated. A failed deployer update should not take down a working deployment.
- What happens when the deployer and app images are updated simultaneously? The system should handle concurrent updates — the deployer writes config first, then services are restarted/updated in the correct order.
- What happens when the server reboots unexpectedly? The deployer should run on boot and restore the latest config from its image before services start.
- What happens when the deployer image cannot be pulled (network failure, registry down)? The existing deployment continues running with the previous config.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Deployment configuration (service definitions, reverse proxy rules, service-specific settings) MUST be delivered via a container image, not via immutable server provisioning scripts.
- **FR-002**: The deployer container MUST write configuration files to a location accessible by other services on the same host.
- **FR-003**: The deployer MUST be updated by the same auto-update mechanism used for the application container.
- **FR-004**: After the deployer writes new config, affected services MUST be restarted or recreated to apply the changes.
- **FR-005**: The initial server bootstrap MUST pull the deployer image and run it as part of first-boot setup, with cloud-init limited to installing the container runtime and bootstrap mechanism only.
- **FR-006**: Secrets MUST NOT be included in the deployer image. Secrets MUST be provisioned separately via infrastructure configuration.
- **FR-007**: A failed deployer update MUST NOT take down an already-running deployment. Existing services MUST continue operating with previous config if the deployer fails.
- **FR-008**: The deployer MUST support adding, removing, or replacing services without requiring server recreation or infrastructure reprovisioning.
- **FR-009**: The automated build pipeline MUST build and publish both the application image and the deployer image on each push to main.
- **FR-010**: All containers (including the deployer) MUST run with read-only root filesystems and as non-root users, consistent with the existing container hardening requirements.

### Key Entities

- **Deployer Image**: A container image containing all deployment configuration files. Built by the CI pipeline. Updated on the server by the auto-update mechanism.
- **Config Volume**: A shared writable location where the deployer writes configuration files that other services read.
- **Bootstrap Mechanism**: The minimal cloud-init setup that installs the container runtime and ensures the deployer runs on first boot and on every reboot.
- **Service Stack**: The set of containers (app, reverse proxy, auto-updater, optional VPN) whose definitions and configuration are managed by the deployer.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Changing deployment configuration (adding a service, modifying reverse proxy rules, enabling VPN) requires only a commit and push — no infrastructure reprovisioning, no manual server access, and zero planned downtime for unaffected services.
- **SC-002**: Config changes propagate from push to running services within the auto-update polling interval (currently 5 minutes) with no operator intervention.
- **SC-003**: Initial server provisioning from an empty account still results in a fully operational deployment, with cloud-init performing only runtime installation and deployer bootstrap.
- **SC-004**: The deployer image contains zero secrets — verifiable by inspecting image layers.
- **SC-005**: A broken deployer update (invalid config, missing image references) does not disrupt an already-running deployment.

## Assumptions

- The auto-update mechanism (currently Watchtower) can monitor and update multiple container images independently — both the app image and the deployer image.
- The container runtime on the server supports shared volumes between containers for config file delivery.
- The CI pipeline can build and push multiple container images (app + deployer) in a single workflow run.
- The deployer container exits after writing config; it does not run as a long-lived service.
- Secrets continue to be provisioned via infrastructure configuration (injected into the .env file at server creation time) and are not affected by this change.

## Out of Scope

- Changing the auto-update mechanism itself (e.g., replacing Watchtower with something else).
- Secret rotation or dynamic secret injection beyond what is already provisioned via infrastructure configuration.
- Multi-server or clustered deployments.
- Rollback mechanisms for deployer config (operator can push a revert commit to restore previous config).
- Monitoring or alerting for failed deployer updates.
