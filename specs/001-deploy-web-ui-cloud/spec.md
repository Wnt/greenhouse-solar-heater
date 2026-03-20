# Feature Specification: Deploy PoC Web UI to Cloud

**Feature Branch**: `001-deploy-web-ui-cloud`
**Created**: 2026-03-20
**Status**: Draft
**Input**: User description: "Make the PoC web UI accessible from the internet. I want to deploy it to Upcloud using docker containers and use Infrastructure as Code. The connection to the Shelly devices should go via a VPN. I have Unifi networking hardware at on site where the Shelly is, so that can be used as VPN provider on that end. The internet UI should be behind passkeys authentication"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Remote Temperature Monitoring (Priority: P1)

As the greenhouse owner, I want to view live sensor temperatures from anywhere with an internet connection, so I can monitor the solar heating system without being on-site.

**Why this priority**: This is the core value proposition — remote access to the existing PoC UI. Without this, no other feature matters.

**Independent Test**: Can be fully tested by navigating to the public URL, authenticating, and seeing live temperature readings from the Shelly sensors. Delivers the primary value of remote monitoring.

**Acceptance Scenarios**:

1. **Given** the cloud server is running and VPN is connected, **When** I navigate to the public URL from a mobile device outside my home network, **Then** I see the Shelly Monitor UI with live sensor readings
2. **Given** the cloud server is running, **When** a sensor value changes on-site, **Then** the updated value appears in the remote UI within the normal polling interval
3. **Given** the VPN connection is temporarily down, **When** I access the UI, **Then** I see the UI with a clear indication that sensor data is unavailable (not a broken page)

---

### User Story 2 - Passkey Authentication (Priority: P1)

As the greenhouse owner, I want the web UI protected by passkey authentication, so only I can access the system and no passwords are needed.

**Why this priority**: Security is non-negotiable for an internet-exposed system controlling physical hardware. Co-prioritized with P1 because the UI must not go live without authentication.

**Independent Test**: Can be tested by attempting to access the UI without credentials and verifying access is denied, then authenticating with a registered passkey and verifying access is granted.

**Acceptance Scenarios**:

1. **Given** I am not authenticated, **When** I navigate to any page of the UI, **Then** I am redirected to a login page prompting for passkey authentication
2. **Given** I have a registered passkey on my device, **When** I authenticate using my passkey, **Then** I am granted access to the full UI
3. **Given** I am authenticated, **When** my session expires, **Then** I am prompted to re-authenticate
4. **Given** I am the first user, **When** I access the system for the first time, **Then** I can complete an initial registration flow to enroll my passkey

---

### User Story 3 - Remote Valve Control (Priority: P2)

As the greenhouse owner, I want to control valves and view system mode remotely, so I can respond to conditions without traveling to the greenhouse.

**Why this priority**: Extends the core monitoring capability with interactive control. Less critical than viewing data but adds significant operational value.

**Independent Test**: Can be tested by toggling a valve from the remote UI and verifying the state change reaches the Shelly controller on-site.

**Acceptance Scenarios**:

1. **Given** I am authenticated and connected, **When** I issue a valve command through the UI, **Then** the command reaches the Shelly controller and the valve state updates
2. **Given** the VPN is temporarily down, **When** I attempt a valve control action, **Then** I receive an error message and no partial command is sent

---

### User Story 4 - Infrastructure Reproducibility (Priority: P2)

As the system maintainer, I want all cloud infrastructure defined as code, so I can recreate, update, or tear down the deployment reliably.

**Why this priority**: Ensures the deployment is maintainable and reproducible. Critical for long-term operations but not directly user-facing.

**Independent Test**: Can be tested by running the IaC tooling from scratch against UpCloud and verifying a fully functional deployment is created without manual steps.

**Acceptance Scenarios**:

1. **Given** valid UpCloud credentials and the IaC configuration, **When** I run the provisioning commands, **Then** the complete infrastructure (server, networking, DNS) is created automatically
2. **Given** a running deployment, **When** I update IaC configuration and re-apply, **Then** only the changed resources are updated without downtime

---

### User Story 5 - Continuous Deployment via GitHub Actions (Priority: P2)

As the system maintainer, I want the production instance to update automatically when changes are merged to main and all tests pass, so deployments are reliable and hands-free.

**Why this priority**: Automates the deployment workflow, reducing manual effort and human error. Depends on the infrastructure being in place first (Stories 1 & 4).

**Independent Test**: Can be tested by merging a visible change (e.g., page title) to main and verifying it appears on the production instance after the pipeline completes.

**Acceptance Scenarios**:

1. **Given** a pull request is merged to main, **When** all tests pass in CI, **Then** the updated application is automatically deployed to the production UpCloud instance
2. **Given** a pull request is merged to main, **When** tests fail in CI, **Then** the deployment does not proceed and the current production version remains unchanged
3. **Given** a deployment is in progress, **When** it completes successfully, **Then** the running application serves the new version with zero downtime

---

### Edge Cases

- What happens when the VPN tunnel drops and reconnects? The proxy server should gracefully handle timeouts and resume when the tunnel recovers.
- What happens when the UpCloud server restarts? Docker containers should restart automatically and re-establish the VPN tunnel.
- What happens when the user tries to register a second passkey? The system should support multiple passkey enrollments for the same user (e.g., phone + laptop).
- What happens when the on-site UniFi gateway is unreachable for extended periods? The UI should show a clear "offline" status rather than hanging indefinitely.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST serve the PoC web UI (static files + RPC proxy) from a cloud-hosted Docker container on UpCloud
- **FR-002**: System MUST establish a VPN tunnel between the UpCloud server and the on-site network where Shelly devices reside, using the UniFi gateway as the on-site VPN endpoint
- **FR-003**: System MUST proxy RPC requests from the cloud-hosted UI to Shelly devices over the VPN tunnel (the existing proxy pattern in `server.js` continues to work, but reaches devices via VPN instead of LAN)
- **FR-004**: System MUST require passkey (WebAuthn/FIDO2) authentication before granting access to any part of the UI
- **FR-005**: System MUST support an initial passkey registration flow for the first user (owner bootstrap). Registration is only available during the first 30 minutes after initial deployment; after that window closes, the registration endpoint is permanently disabled until the next fresh deployment
- **FR-006**: System MUST define all cloud infrastructure (server, networking, firewall rules) using Infrastructure as Code
- **FR-007**: System MUST run all application components as Docker containers with automatic restart on failure
- **FR-008**: System MUST serve the UI over HTTPS with a valid TLS certificate
- **FR-009**: System MUST return meaningful error responses when the VPN tunnel or Shelly devices are unreachable
- **FR-010**: System MUST maintain authenticated sessions so users don't need to re-authenticate on every page load
- **FR-011**: System MUST automatically deploy the updated application to production when changes are merged to main and all CI tests pass, via GitHub Actions
- **FR-012**: System MUST NOT deploy to production if any CI test fails

### Key Entities

- **Cloud Server**: UpCloud virtual machine hosting Docker containers, the VPN client endpoint, and the web application
- **VPN Tunnel**: Secure network link between the cloud server and the on-site UniFi gateway, providing access to the Shelly device LAN
- **Passkey Credential**: WebAuthn public key credential registered to the owner, stored server-side, used for passwordless authentication
- **User Session**: Authenticated session token issued after successful passkey verification, with a defined expiry

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The owner can access the monitoring UI from any internet-connected device and see live sensor data within 10 seconds of page load
- **SC-002**: Unauthenticated requests to the UI are blocked 100% of the time — no page content is visible without a valid passkey authentication
- **SC-003**: A complete deployment can be created from scratch using only the IaC definitions and documented credentials, with no manual configuration steps on the UpCloud console
- **SC-004**: The system recovers automatically from a server restart — containers and VPN tunnel are operational again without manual intervention within 2 minutes
- **SC-005**: Valve control commands issued remotely are delivered to the Shelly controller within 5 seconds under normal VPN conditions

## Clarifications

### Session 2026-03-20

- Q: How is the initial passkey registration secured against unauthorized access? → A: Time-window — registration is only possible within 30 minutes of first deployment.

## Assumptions

- The owner has an UpCloud account with API credentials available for IaC provisioning
- The on-site UniFi gateway supports site-to-site VPN (UniFi supports WireGuard, IPsec, and OpenVPN; the specific protocol will be determined during planning)
- The Shelly devices remain at fixed IP addresses on the local network (per `devices.conf`)
- A domain name is available or will be acquired for HTTPS access (alternatively, a subdomain of an existing domain)
- The owner has at least one device (phone, laptop) that supports WebAuthn/FIDO2 passkeys
- Single-user system — only the greenhouse owner needs access; no multi-user roles or permissions are required
- The existing `server.js` proxy architecture is preserved — the cloud deployment wraps the same Node.js server in a container, with the VPN providing network-level access to Shelly IPs
