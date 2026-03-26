# Feature Specification: Remove Monitor App, Promote Playground

**Feature Branch**: `013-remove-monitor-app`
**Created**: 2026-03-26
**Status**: Draft
**Input**: User description: "Remove the monitor app web UI and the Monitor / PoC Shelly code and everything related to that from the project. Make the playground (solar heating monitoring & controlling system) app the actual app. Add explanation to all the different options on Device configuration view. Make the individual views deep bookmarkable. Set the Shelly 4pm IP address to 192.168.1.174 and enable updating its script happen on deploy."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Simplified Project with Playground as Main App (Priority: P1)

As a project maintainer, I want the monitor app UI (gauges, charts, sensor display), push notifications, PoC Shelly scripts, and PWA artifacts removed from the codebase so that the playground becomes the sole web application, while keeping the passkey authentication system to protect the control interface.

**Why this priority**: The monitor app UI is being retired. Removing it is the prerequisite for all other changes — the playground cannot become the main app while the monitor still exists and serves as the entry point. Authentication must be retained because the system controls real hardware.

**Independent Test**: After removal, the project builds and deploys with only the playground app behind passkey auth. Monitor-specific UI files, push notification code, PoC Shelly scripts, and PWA artifacts are gone. The server serves the playground at the root URL. Authentication protects all views and API endpoints. Existing playground functionality (simulation, live mode, all views) continues to work.

**Acceptance Scenarios**:

1. **Given** the full codebase, **When** the monitor app UI is removed, **Then** no monitor-specific UI files remain (monitor HTML, CSS, client JS for gauges/charts, icons, service worker, manifest) and the PoC Shelly directory is deleted. Authentication code (credentials, sessions, WebAuthn, login page, vendored auth libs) is preserved.
2. **Given** the monitor UI is removed, **When** server-side code is reviewed, **Then** push notification endpoints and monitor-specific static file serving are removed — but authentication middleware, WebSocket, device config, RPC proxy, and history APIs are preserved and protected by passkey auth.
3. **Given** the monitor UI is removed, **When** deployment artifacts are built, **Then** the Docker image, deploy scripts, and CI workflows reference the playground as the main app, served at the root path `/` behind passkey authentication.
4. **Given** the monitor UI is removed, **When** tests are run, **Then** push notification and service worker tests are removed, auth tests are preserved, and all remaining tests pass.

---

### User Story 2 - Deep Bookmarkable Views (Priority: P2)

As a user, I want to bookmark or share a direct link to any specific view (Status, Components, Schematic, Controls, Device) so that I can return to exactly where I was or share a specific view with someone else.

**Why this priority**: Deep linking is a fundamental usability feature that makes the single-page app navigable and shareable. It builds on the playground being the main app.

**Independent Test**: Navigate to each view, verify the URL changes (e.g., `#status`, `#components`). Copy the URL, open it in a new browser tab, and confirm the correct view loads directly. Use browser back/forward to verify history navigation works.

**Acceptance Scenarios**:

1. **Given** the app is loaded, **When** a user clicks a navigation link (e.g., "Schematic"), **Then** the URL updates to include a fragment identifier (e.g., `#schematic`) without a full page reload.
2. **Given** a URL with a view fragment (e.g., `https://example.com/#controls`), **When** a user opens it in a new browser tab, **Then** the Controls view is displayed immediately.
3. **Given** a user is on a specific view, **When** they use the browser's back/forward buttons, **Then** the view switches to match the browser history.
4. **Given** the app is loaded without a fragment, **When** the page finishes loading, **Then** the Status view is shown by default.

---

### User Story 3 - Device Configuration Explanations (Priority: P3)

As a user viewing the Device configuration screen, I want clear explanations for every configuration option so that I understand what each setting does and the implications of changing it.

**Why this priority**: The Device configuration view controls real hardware. Without explanations, users risk misconfiguring the system. This is important but lower priority than the structural changes.

**Independent Test**: Open the Device configuration view and verify that every toggle, dropdown, and checkbox group has a visible description explaining its purpose and effect.

**Acceptance Scenarios**:

1. **Given** the Device configuration view is open, **When** the user views the "Controls Enabled" toggle, **Then** a description explains that this is the master switch — when off, the controller will not actuate any hardware regardless of other settings.
2. **Given** the Device configuration view is open, **When** the user views the "Enabled Actuators" section, **Then** each actuator toggle (Valves, Pump, Fan, Space Heater, Immersion Heater) has a description explaining what that actuator does and the effect of disabling it.
3. **Given** the Device configuration view is open, **When** the user views the "Forced Mode" dropdown, **Then** a description explains that selecting a mode overrides automatic mode selection, and each mode option is briefly explained.
4. **Given** the Device configuration view is open, **When** the user views the "Allowed Modes" checkboxes, **Then** each mode has a brief explanation of when it is normally used by the automation.

---

### User Story 4 - Shelly Script Deployment on App Deploy (Priority: P4)

As a system operator, I want the Shelly Pro 4PM control scripts to be automatically updated during the application deployment process so that the device firmware stays in sync with the deployed application version.

**Why this priority**: Keeping the Shelly scripts in sync with the app prevents version drift between the controller logic and the monitoring/control UI. This is the final operational improvement.

**Independent Test**: Trigger a deployment and verify that the Shelly Pro 4PM at 192.168.1.174 receives the latest control and telemetry scripts.

**Acceptance Scenarios**:

1. **Given** the deployment pipeline runs, **When** the deployer container executes, **Then** the Shelly deploy script is invoked to upload the latest control and telemetry scripts to the Shelly Pro 4PM at 192.168.1.174.
2. **Given** the Shelly device is unreachable during deployment, **When** the script upload fails, **Then** the deployment logs a warning but does not fail the overall deployment (the app still starts).
3. **Given** the deployment runs in the cloud, **When** the deployer runs the Shelly deploy script, **Then** it uses the VPN-routable address to reach the device.

---

### Edge Cases

- What happens when a user bookmarks the Device view URL but is not in live mode? The view should still navigate to the Device section, but the live-only visibility rules should still apply — the user sees an indication that live mode is required.
- What happens when the Shelly device is mid-operation during a script deploy? The deploy script already handles stopping scripts before upload; this existing safety mechanism is preserved.
- What happens to existing monitor-app bookmarks or links? They will break — this is acceptable since the monitor app is being fully removed.
- What happens if the URL fragment doesn't match any known view name? The app defaults to the Status view.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST remove monitor app UI files (monitor HTML page, CSS, client-side JavaScript for gauges/charts/push, icons, service worker, manifest).
- **FR-002**: System MUST preserve all authentication code (credential store, session management, WebAuthn handlers, invitation system, login page, vendored auth libraries) and apply it to protect the playground app.
- **FR-003**: System MUST remove the PoC Shelly scripts directory (`monitor/shelly/` containing `sensor-display.js` and `deploy-poc.sh`).
- **FR-004**: System MUST remove push notification endpoints and push storage from the server. Authentication middleware and login-related API routes MUST be preserved.
- **FR-005**: System MUST preserve server-side libraries needed by the playground in live mode: structured logging, S3 storage adapter, database module, MQTT bridge, device config store, tracing, valve poller, and authentication modules.
- **FR-006**: System MUST serve the playground app at the root URL path (`/`) instead of at a sub-path.
- **FR-007**: System MUST implement URL fragment-based navigation so each view has a unique, bookmarkable URL (e.g., `#status`, `#components`, `#schematic`, `#controls`, `#device`).
- **FR-008**: System MUST update the URL fragment when the user navigates between views.
- **FR-009**: System MUST load the correct view when the page is opened with a URL fragment.
- **FR-010**: System MUST handle browser back/forward navigation between views via the `hashchange` event.
- **FR-011**: System MUST display explanatory descriptions for the Controls Enabled toggle, explaining it as the master on/off switch for all hardware actuation.
- **FR-012**: System MUST display explanatory descriptions for each Enabled Actuator toggle (Valves, Pump, Fan, Space Heater, Immersion Heater), explaining what each controls and the effect of disabling it.
- **FR-013**: System MUST display explanatory descriptions for the Forced Mode dropdown, explaining that it overrides automatic mode selection, with brief descriptions of each mode.
- **FR-014**: System MUST set the Shelly Pro 4PM IP address to 192.168.1.174 in the deployment configuration.
- **FR-015**: System MUST include Shelly script deployment as a step in the application deployment pipeline.
- **FR-016**: System MUST handle Shelly script deployment failure gracefully — log a warning but do not fail the overall deployment.
- **FR-017**: System MUST remove push notification and service worker tests. Auth tests MUST be preserved and updated for the new project structure.
- **FR-018**: System MUST update the Dockerfile, docker-compose, deploy scripts, and CI workflows to reflect the playground as the sole app.
- **FR-019**: System MUST update project documentation (CLAUDE.md) to remove monitor app references and reflect the new structure.

### Key Entities

- **View**: A named section of the single-page app (Status, Components, Schematic, Controls, Device) identified by a URL fragment.
- **Device Configuration**: Runtime settings pushed to the Shelly controller via MQTT, including controls enable, actuator enable bitmask, mode override, and allowed modes.
- **Shelly Pro 4PM**: The physical controller device at IP 192.168.1.174 that receives deployed scripts and runtime configuration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The codebase contains zero files related to the monitor app UI (gauges, charts, sensor display), push notifications, PoC Shelly scripts, service worker, or PWA manifest. Authentication code is preserved and functional.
- **SC-002**: The playground app loads at the root URL (`/`) and all five views (Status, Components, Schematic, Controls, Device) are accessible and functional.
- **SC-003**: Every view is reachable via a direct URL with a fragment identifier, and the correct view displays when the URL is opened in a new browser session.
- **SC-004**: Browser back/forward buttons correctly navigate between previously visited views.
- **SC-005**: All Device configuration options have visible, human-readable explanations that a non-technical user can understand.
- **SC-006**: The deployment pipeline uploads Shelly scripts to the Pro 4PM at 192.168.1.174, and a script upload failure does not prevent the app from starting.
- **SC-007**: All remaining tests pass after the monitor app removal and structural changes.
