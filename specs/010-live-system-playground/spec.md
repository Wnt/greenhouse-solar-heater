# Feature Specification: Connect Playground to Live System

**Feature Branch**: `010-live-system-playground`
**Created**: 2026-03-24
**Status**: Draft
**Input**: User description: "Modify the playground app so that we can connect the status, components and schematic views into a real running system. The Shelly side might also need some changes for it to publish all needed data for visualization. Introduce MQTT communication from Shellys towards the app. Keep the option to run simulations in the Playground app: it should be the only mode available in GH pages deployment, but when the app is running from the greenhouse.madekivi.com (current monitoring app) it should default to real system monitoring and have the option to switch to simulation mode."

## Clarifications

### Session 2026-03-24

- Q: How long should the system retain historical time series data? → A: Indefinite — keep all data permanently, no automatic expiry.
- Q: How frequently should data be recorded to the time series database? → A: Tiered — full MQTT resolution retained for 48 hours, downsampled to 30-second intervals for long-term storage. All state change events (mode transitions, valve/actuator changes) stored indefinitely at full resolution regardless of tier.
- Q: Where should the MQTT broker run? → A: Cloud server only — Shelly devices publish over the VPN tunnel to the cloud-hosted broker. The Node.js server subscribes locally on the same host.
- Q: Should the playground replace the monitor app or coexist with it? → A: Playground replaces the monitor — single unified app. The monitor's current features (gauges, chart, auth, push notifications) are absorbed into the playground. One app served from both GitHub Pages (simulation-only) and greenhouse.madekivi.com (live + simulation).
- Q: How should Shelly devices publish data via MQTT? → A: Script-based custom publishing from the control script. Publishes consolidated JSON state snapshots containing mode, transition status, temperatures, valve states, and actuator states — not raw Shelly built-in topics.
- Q: How should Shelly control scripts be deployed/updated? → A: Remotely via the VPN tunnel as part of the deployment process. The deploy.sh script should work with VPN-reachable IPs, not just LAN. Script updates should be triggerable from the CD pipeline without physical access.
- Q: Should all controls (valves, pump, fans, heaters) be enabled by default? → A: No — all actuator control must be disabled by default. The system should be safe to deploy without accidentally commanding hardware. Enabling controls should not require a new deployment — runtime configuration only.
- Q: How should the Shelly device get its runtime configuration? → A: On startup, the Shelly fetches config from a cloud HTTP endpoint (bootstrap — before MQTT is available). After that, config changes are pushed instantly via MQTT retained message on `greenhouse/config`. The Shelly subscribes to this topic and applies changes immediately — critical for safety (e.g., disabling a circuit mid-operation must stop the pump and close valves within seconds, not wait for polling). Config is persisted in KVS for offline resilience.
- Q: How fast must config changes take effect? → A: Safety-critical changes (enabling/disabling actuators like circuits, pump, fan) must trigger an immediate extra control loop iteration — not wait for the next scheduled 30s cycle. The MQTT config callback calls `controlLoop()` directly for these changes. Non-critical changes (e.g., temperature threshold tweaks) can wait for the next regular cycle. This is simple because `controlLoop()` is already a standalone function with a re-entrancy guard (`if (state.transitioning) return`).

## User Scenarios & Testing

### User Story 1 - View Live System State in Playground (Priority: P1)

A greenhouse operator visits the playground app hosted at greenhouse.madekivi.com and sees real-time data from the physical system: current temperatures from all five sensors, valve positions, pump/actuator states, the active operating mode, and the schematic view with live pipe flow visualization — all updated continuously without manual refresh.

**Why this priority**: This is the core value proposition. Without live data flowing into the existing playground views, none of the other stories matter. The playground already has the UI — it just needs a real data source instead of simulated data.

**Independent Test**: Can be tested by connecting to a running system and verifying that all five temperature readings, eight valve states, four actuator states, and the current mode are displayed and update when physical state changes.

**Acceptance Scenarios**:

1. **Given** the app is served from greenhouse.madekivi.com, **When** the user opens the app, **Then** the Status, Components, and Schematic views display live data from the physical Shelly devices.
2. **Given** the live system is running in Solar Charging mode, **When** the user opens the Schematic view, **Then** the solar pipe path is highlighted and temperature labels show current sensor readings.
3. **Given** the physical system changes mode (e.g., from Idle to Solar Charging), **When** the change occurs, **Then** the app updates within a few seconds without manual refresh.
4. **Given** a temperature sensor reading changes on the physical system, **When** the new value is published, **Then** the Status gauges, Components table, and Schematic labels reflect the updated value within a few seconds.

---

### User Story 2 - Shelly Devices Publish State via MQTT (Priority: P2)

The Shelly controller (Pro 4PM) publishes a complete system state snapshot — temperatures, valve positions, actuator states, current mode, and transition information — via MQTT at regular intervals and on state changes. This provides a real-time data stream that the app can subscribe to without polling individual devices.

**Why this priority**: MQTT is the transport layer that enables P1. Without devices publishing their state, the app has no live data source. This is separate from P1 because it involves changes to the Shelly-side scripts and introducing MQTT infrastructure.

**Independent Test**: Can be tested by subscribing to the MQTT topic with any MQTT client and verifying that state messages arrive at regular intervals and immediately on mode transitions.

**Acceptance Scenarios**:

1. **Given** the Shelly Pro 4PM is running the control script, **When** the system is operating normally, **Then** it publishes a complete state snapshot to a designated MQTT topic at a regular interval.
2. **Given** a mode transition occurs (e.g., Idle → Solar Charging), **When** the transition completes, **Then** the device publishes an immediate state update (in addition to periodic updates).
3. **Given** the MQTT broker is temporarily unavailable, **When** the broker comes back online, **Then** the device resumes publishing without manual intervention and system control operation is unaffected.
4. **Given** an MQTT subscriber connects, **When** they subscribe to the system state topic, **Then** they receive the most recent state snapshot (retained message) immediately.

---

### User Story 3 - Switch Between Live and Simulation Modes (Priority: P3)

A user visiting the playground on greenhouse.madekivi.com can toggle between live monitoring and simulation mode. The app defaults to live mode on the deployed site but provides a clear toggle to enter simulation mode, where the existing thermal simulation runs as before. On GitHub Pages, only simulation mode is available (no toggle shown).

**Why this priority**: This preserves the existing simulation functionality while adding the live mode. It's lower priority because the simulation already works — this story is about the mode-switching UX and deployment-aware behavior.

**Independent Test**: Can be tested by visiting both the GitHub Pages and greenhouse.madekivi.com deployments and verifying the correct default mode, toggle visibility, and that switching modes works without page reload.

**Acceptance Scenarios**:

1. **Given** the app is loaded from GitHub Pages, **When** the user opens any view, **Then** the app runs in simulation mode only with no live/simulation toggle visible.
2. **Given** the app is loaded from greenhouse.madekivi.com, **When** the user opens the app, **Then** it defaults to live monitoring mode with a visible toggle to switch to simulation.
3. **Given** the user is viewing live data on greenhouse.madekivi.com, **When** they switch to simulation mode, **Then** the views transition to showing simulated data and the Controls view becomes available for adjusting simulation parameters.
4. **Given** the user is in simulation mode on greenhouse.madekivi.com, **When** they switch back to live mode, **Then** the views reconnect to live data and the simulation Controls are hidden or disabled.

---

### User Story 4 - View Transition Sequences in Real Time (Priority: P4)

When the live system transitions between modes, the user sees a step-by-step visualization of the transition sequence: pump stops, valves close, new valves open, pump restarts — with timing that reflects the actual hardware delays (1s valve settle, 5s pump prime). The transition log shows each step as it happens.

**Why this priority**: This adds significant observability value but depends on all previous stories being in place. The hardware transition sequence (stop pump → wait → close valves → open new valves → wait → start pump) is currently invisible in the playground.

**Independent Test**: Can be tested by triggering a mode transition on the live system and verifying that intermediate steps (pump off, valves closing, valves opening, pump on) appear sequentially in the UI with correct timing.

**Acceptance Scenarios**:

1. **Given** the system is in Solar Charging mode and a transition to Greenhouse Heating is triggered, **When** the transition begins, **Then** the user sees sequential steps: pump stops → valves close → new valves open → pump starts, with visible delays between steps.
2. **Given** a transition is in progress, **When** the user is on the Schematic view, **Then** valve and pump state changes animate in real time as each step completes.
3. **Given** a transition is in progress, **When** the user is on the Components view, **Then** individual valve and actuator states update step-by-step as each change occurs on the hardware.

---

### User Story 5 - View Historical Data in Live Mode (Priority: P5)

When in live monitoring mode, the Status view's history graph shows actual historical temperature data (not simulated) stored in a time series database. The user can browse time ranges — from short windows (1h, 6h, 24h) to long-term views (1 week, 1 month, 1 year, all time) — to see how the system has performed. All data is retained indefinitely.

**Why this priority**: Historical data adds long-term monitoring value but requires a database and server-side persistence, making it more complex. The live snapshot (P1) delivers immediate value without history.

**Independent Test**: Can be tested by letting the system run for several hours, then verifying that the history graph shows real temperature trends and mode transitions over the selected time range.

**Acceptance Scenarios**:

1. **Given** the system has been running for at least 6 hours, **When** the user selects the "6h" time range on the Status view, **Then** the graph shows real temperature trends for all sensors over the past 6 hours.
2. **Given** a mode transition occurred 2 hours ago, **When** the user views the 6h history, **Then** the transition is visible as a marker or annotation on the graph.
3. **Given** the app has been open for some time, **When** new data arrives, **Then** the history graph updates in real time (new data points appear on the right edge).
4. **Given** the system has been running for months, **When** the user selects a long-term time range (e.g., 1 month), **Then** the graph shows temperature trends over that period with appropriate data resolution.

---

### Edge Cases

- What happens when the MQTT connection drops while viewing live data? The app should indicate the connection loss and attempt to reconnect automatically, showing the last known state with a staleness indicator.
- What happens when the Shelly devices are unreachable (e.g., power outage, network issue)? The app should show a clear "disconnected" or "no data" state rather than stale values without indication.
- What happens when a user is in simulation mode and the live system changes mode? The simulation should be unaffected — mode switching is independent.
- What happens on the first visit when no historical data exists? The history graph should show an empty state with a message indicating data collection has started.
- What happens if MQTT messages arrive faster than the UI can render? The app should use the latest state snapshot and skip intermediate ones to avoid UI lag.
- What happens when viewing a time range that spans the 48-hour full-resolution/downsampled boundary? The graph should blend seamlessly — higher resolution for the recent portion, 30-second intervals for the older portion.
- What happens when the Shelly device starts with no internet and no prior KVS config? All actuator control remains disabled (safe default). The device reads sensors and publishes MQTT when connectivity returns, but does not command any hardware until it receives an explicit config enabling controls.
- What happens when the cloud config endpoint is unreachable during initial boot fetch? The device continues with its KVS-persisted config (or all-disabled default if no KVS). Once MQTT connects, it will receive the retained config message.
- What happens when a config update disables actuators while the system is actively running a mode? The config change arrives instantly via MQTT. The MQTT callback detects a safety-critical change (actuator enable flags differ) and calls `controlLoop()` immediately. The control loop sees controls disabled and performs a safe shutdown: stop pump, close all valves, transition to idle. No 30s wait.

## Requirements

### Functional Requirements

- **FR-001**: The app MUST detect its deployment context (GitHub Pages vs. greenhouse.madekivi.com) and select the appropriate default mode (simulation-only vs. live-with-toggle).
- **FR-002**: When in live mode, the app MUST display current readings from all five temperature sensors (collector, tank top, tank bottom, greenhouse, outdoor).
- **FR-003**: When in live mode, the app MUST display the current state of all eight motorized valves and four actuators (pump, fan, immersion heater, space heater).
- **FR-004**: When in live mode, the app MUST display the current operating mode (Idle, Solar Charging, Greenhouse Heating, Active Drain, Emergency Heating).
- **FR-005**: The Shelly control script MUST publish consolidated JSON state snapshots via custom MQTT calls, including temperatures, valve states, actuator states, current mode, and transition status. Built-in Shelly MQTT topics are not used.
- **FR-006**: MQTT publishing MUST NOT interfere with the primary control logic — if MQTT fails, the system MUST continue operating normally.
- **FR-007**: The app MUST receive live updates within a few seconds of a state change on the physical system.
- **FR-008**: On greenhouse.madekivi.com, users MUST be able to toggle between live monitoring mode and simulation mode without reloading the page.
- **FR-009**: On GitHub Pages, the app MUST operate in simulation-only mode with no visible live mode controls.
- **FR-010**: The Schematic view MUST update pipe highlights, temperature labels, and component states in real time when in live mode.
- **FR-011**: During mode transitions, the app MUST visualize intermediate steps (pump stop, valve changes, pump start) as they occur on the hardware.
- **FR-012**: The app MUST indicate connection status — showing when the live data feed is connected, reconnecting, or disconnected.
- **FR-013**: The server MUST relay MQTT data to browser clients (browsers cannot connect to MQTT directly in this architecture).
- **FR-014**: The system MUST persist all state snapshots in a time series database using a tiered retention policy: full-resolution data for the most recent 48 hours, downsampled to 30-second intervals for long-term storage.
- **FR-015**: All state change events (mode transitions, valve open/close, actuator on/off) MUST be stored indefinitely at full resolution, regardless of the downsampling tier.
- **FR-016**: The Status view MUST support browsing historical data beyond 24 hours, with appropriate time range options for the full retained history.
- **FR-017**: The unified app MUST retain the monitor app's existing capabilities: WebAuthn passkey authentication (when deployed), push notifications for state changes, and PWA installability (home screen, offline fallback).
- **FR-018**: The unified app MUST work as a fully static site on GitHub Pages (no server dependency for simulation mode).
- **FR-019**: All actuator control (valves, pump, fan, space heater, immersion heater) MUST be disabled by default. The Shelly device MUST NOT command any hardware until explicitly enabled via runtime configuration.
- **FR-020**: Enabling or disabling actuator control MUST be possible at runtime without deploying new code. Safety-critical config changes (actuator enables/disables) MUST trigger an immediate extra control loop iteration — not wait up to 30s for the next scheduled cycle. Disabling controls while a mode is active MUST trigger a safe shutdown (stop pump, close valves). Non-critical changes (e.g., temperature thresholds) MAY wait for the next regular cycle.
- **FR-021**: The Shelly device MUST fetch runtime configuration from a cloud HTTP endpoint on startup (bootstrap) and subscribe to an MQTT config topic for live updates. Configuration MUST be persisted in KVS so the device can start without internet connectivity using the last known settings.
- **FR-022**: If no configuration exists (fresh device, no KVS, no cloud access), the device MUST default to all controls disabled (monitoring-only mode: reads sensors, publishes MQTT, but does not actuate).
- **FR-023**: Shelly control scripts MUST be deployable remotely via the VPN tunnel. The deployment process MUST NOT require physical/LAN access to the device.
- **FR-024**: The server MUST provide a device configuration API endpoint (HTTP GET for bootstrap, HTTP PUT for operator updates). On config update, the server MUST publish the new config to the MQTT config topic so the device receives it immediately.

### Key Entities

- **System State Snapshot**: A point-in-time capture of all system data — five temperature readings, eight valve states, four actuator states, current mode, transition status, and timestamp.
- **Data Source**: An abstraction representing where the app gets its data — either a live MQTT-backed feed or the existing simulation engine. The app switches between these based on deployment context and user toggle.
- **Transition Sequence**: An ordered series of hardware steps during a mode change — pump stop, valve settle delay, valve operations, pump prime delay, pump start — each with a timestamp and status.
- **Device Configuration**: Runtime settings for the Shelly controller — which actuator groups are enabled (valves, pump, fan, heaters), fetched from the cloud and persisted locally in KVS. Controls the boundary between monitoring-only and full control modes.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Users viewing the live system see temperature updates within 5 seconds of a sensor reading change on the physical hardware.
- **SC-002**: All five temperature sensors, eight valves, and four actuators are visible and updating in the Status, Components, and Schematic views during live monitoring.
- **SC-003**: Mode transitions on the physical system are reflected in the app with visible intermediate steps (not just final state).
- **SC-004**: The existing simulation functionality continues to work identically on GitHub Pages with no regressions.
- **SC-005**: Users on greenhouse.madekivi.com can switch between live and simulation modes within 2 seconds, without page reload.
- **SC-006**: MQTT communication failures do not affect the Shelly controller's ability to manage valves and pump (control logic remains independent).
- **SC-007**: The app clearly indicates when live data is unavailable (connection lost, devices unreachable) rather than showing stale data silently.
- **SC-008**: Historical temperature data is available in the Status view's time-series graph during live monitoring, with the full retained history browsable (not limited to 24 hours).
- **SC-009**: A freshly deployed Shelly device with no prior configuration does NOT command any hardware — it only reads sensors and publishes MQTT.
- **SC-010**: Safety-critical config changes (actuator enables/disables) take effect within seconds — an immediate extra control loop runs without waiting for the 30s schedule. Disabling controls while active triggers safe shutdown (pump stop, valves close) on that immediate iteration.
- **SC-011**: A Shelly device that loses internet connectivity continues operating with the last known KVS-persisted configuration.

## Assumptions

- The Shelly Pro 4PM supports MQTT publishing from its scripting environment (Shelly devices have built-in MQTT support that can be enabled alongside HTTP RPC).
- An MQTT broker will be deployed on the cloud server as a container alongside the existing Docker Compose stack. Shelly devices connect to it over the VPN tunnel.
- The existing monitor server (Node.js) will be extended to act as the MQTT-to-browser bridge, rather than introducing a separate service.
- The playground app replaces the monitor app as a single unified application. The monitor's existing features (temperature gauges, time-series chart, WebAuthn auth, push notifications, PWA support) are absorbed into the playground. The monitor app will be retired once the unified app is feature-complete.
- The server subscribes to MQTT and forwards state to browser clients via a real-time channel.
- A time series database will be deployed as part of the infrastructure to store all state snapshots indefinitely.
- The existing authentication (WebAuthn passkeys) will apply to the live monitoring mode on greenhouse.madekivi.com.
- Shelly devices are reachable from the cloud server via the VPN tunnel for both MQTT communication and HTTP RPC (script deployment, config queries).
- The Shelly KVS (Key-Value Store) persists across reboots and can store the device configuration as a JSON string.
