# Feature Specification: MQTT-Only Shelly Communication API

**Feature Branch**: `019-mqtt-only-shelly-api`
**Created**: 2026-04-07
**Status**: Draft
**Input**: User description: "How can we avoid this kind of RPC eval calling from the playground / cloud? There should be a strictly defined API on the Shelly side that is accessible from the remote monitoring system. Can we limit it to e.g. only reload the config from cloud and rely on MQTT updates about status on the cloud side? We also need to take into consideration the Shelly platform limitations like the 5 concurrent tasks. Ideally we would use what the Shelly platform already provides and just configure those features. But we still need to make it fully functional without the cloud connection if internet is down"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reliable State Monitoring Without Script.Eval (Priority: P1)

The monitoring system receives system state (mode, temperatures, valve positions, actuator status) from the Shelly controller purely through device-initiated status updates. The cloud server never calls `Script.Eval` or any other intrusive RPC on the controller. This eliminates script crashes caused by concurrent call limits and removes the fragile dependency on the cloud polling the device.

**Why this priority**: The current `Script.Eval` polling crashes the control script due to the 5-concurrent-call platform limit. This is the root cause of the display not updating and the system being unreliable.

**Independent Test**: Disconnect the cloud server entirely. Verify the Shelly controller continues operating (mode transitions, display updates, sensor polling) without any degradation. Then reconnect and verify the monitoring dashboard receives state within one update cycle.

**Acceptance Scenarios**:

1. **Given** the Shelly controller is running with MQTT connected, **When** the control loop completes a cycle, **Then** the current state is published to the monitoring system without any inbound RPC call from the cloud.
2. **Given** the MQTT connection is lost (internet down), **When** the control loop runs, **Then** the system continues operating normally — mode transitions, sensor polling, valve control, and display updates all function without interruption.
3. **Given** the MQTT connection recovers after an outage, **When** the next control cycle completes, **Then** the monitoring dashboard receives the current state within one update cycle (30 seconds).

---

### User Story 2 - Configuration Push Without Direct RPC (Priority: P2)

When an operator changes device configuration or sensor configuration through the monitoring dashboard, the changes are delivered to the Shelly device exclusively through the message bus. No direct HTTP RPC calls are made from the cloud to the Shelly device for configuration delivery.

**Why this priority**: Config changes are infrequent (operator-initiated) but currently mix MQTT delivery with direct RPC calls for sensor configuration apply. Unifying on message-based delivery simplifies the architecture and respects device resource limits.

**Independent Test**: Change a device configuration setting in the monitoring dashboard. Verify the Shelly device receives and applies the change via the message bus, with no HTTP RPC calls from the cloud to the device.

**Acceptance Scenarios**:

1. **Given** an operator changes device controls (enable/disable, mode selection) in the dashboard, **When** the change is saved, **Then** the configuration reaches the Shelly device through the message bus within 5 seconds.
2. **Given** an operator applies sensor assignments in the dashboard, **When** the apply is confirmed, **Then** the sensor host configuration is applied without the cloud server making direct HTTP RPC calls to the sensor hosts.

---

### User Story 3 - Sensor Discovery as a Local-Only Operation (Priority: P3)

Sensor discovery (scanning the 1-Wire bus for connected DS18B20 probes) is performed by the Shelly device itself as a local operation. The cloud/playground only triggers the discovery and receives the results through the message bus — it does not directly call sensor host RPC endpoints.

**Why this priority**: Sensor discovery is a rare operation (initial setup, hardware changes). It currently requires direct RPC from the cloud to sensor hosts, which adds complexity and bypasses the message bus architecture. Moving this to be device-initiated is cleaner but lower priority than fixing the monitoring crash.

**Independent Test**: Trigger sensor discovery from the monitoring dashboard. Verify the Shelly controller performs the scan locally and reports results through the message bus, with no direct cloud-to-sensor-host HTTP calls.

**Acceptance Scenarios**:

1. **Given** an operator triggers sensor discovery from the dashboard, **When** the controller receives the discovery request via the message bus, **Then** the controller scans the sensor hosts directly (on the local network) and publishes the results back via the message bus.
2. **Given** the cloud connection is down, **When** the operator has local network access to the Shelly device, **Then** sensor discovery can still be performed through the device's built-in web interface or local network access.

---

### Edge Cases

- What happens when the Shelly controller boots with no MQTT broker available? The system must operate safely in standalone mode (IDLE, no actuation).
- What happens when a config message arrives via MQTT during a valve transition? The system must queue the config update until the transition completes.
- What happens when sensor polling and MQTT publish overlap? The system must respect the 5-concurrent-call limit by serializing operations.
- What happens when the MQTT broker restarts? The Shelly device must reconnect and resume publishing without manual intervention.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The cloud server MUST NOT call `Script.Eval` or any other code-execution RPC on the Shelly controller.
- **FR-002**: The Shelly controller MUST publish its full state (mode, temperatures, valve positions, actuator status, flags) to the message bus on every control cycle.
- **FR-003**: The cloud server MUST receive system state exclusively from the message bus — not by polling the device via HTTP.
- **FR-004**: Device configuration changes MUST be delivered to the Shelly controller exclusively through the message bus.
- **FR-005**: Sensor configuration (role assignments, host bindings) MUST be delivered to the Shelly controller through the message bus, and the controller MUST apply the configuration to sensor hosts via the local network.
- **FR-006**: The Shelly controller MUST operate fully (mode decisions, sensor polling, valve control, display updates) without any cloud connection.
- **FR-007**: The system MUST never exceed the platform limit of 5 concurrent calls per script, including during sensor polling, valve commands, and status publishing.
- **FR-008**: The Shelly device's built-in MQTT support MUST be used for publish/subscribe rather than custom HTTP-based communication.
- **FR-009**: Sensor discovery MUST be performed by the Shelly controller on the local network. The cloud server sends a discovery request via the message bus, the controller scans sensor hosts locally, and publishes results back via the message bus. No direct cloud-to-sensor-host RPC calls.
- **FR-010**: The cloud server MUST NOT make any direct HTTP RPC calls to Shelly devices during normal operation, including sensor discovery. All communication MUST flow through the message bus.

### Key Entities

- **State Snapshot**: The complete system state published by the controller each cycle — mode, temperatures, valve positions, actuator states, transition status, error flags, configuration status.
- **Config Message**: A compact configuration payload delivered via the message bus — device controls (enable/disable, actuator mask, mode restrictions) and sensor assignments (role-to-host-and-component mappings).
- **Discovery Result**: Sensor scan results from the controller — list of detected 1-Wire addresses per sensor host, current bindings, live temperature readings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The Shelly control script runs continuously for 24+ hours without crashing due to concurrent call limits or external RPC interference.
- **SC-002**: The monitoring dashboard receives state updates within 30 seconds of any state change on the controller, purely via the message bus.
- **SC-003**: The Shelly controller operates for 24+ hours with no cloud connection, with all local functions (mode control, sensor polling, valve actuation, display updates) working correctly.
- **SC-004**: Zero HTTP RPC calls from the cloud server to the Shelly controller during normal monitoring operation (config changes and sensor discovery excluded).
- **SC-005**: The system stays within the 5-concurrent-call platform limit at all times, verified by no "Too many calls in progress" errors over a 24-hour period.

## Assumptions

- The existing MQTT infrastructure (Mosquitto sidecar in the K8s pod, Shelly built-in MQTT client) is sufficient and does not need replacement.
- The Shelly telemetry script already handles MQTT publish/subscribe and inter-script events — this feature extends that pattern rather than creating a new communication mechanism.
- The 30-second control loop interval is acceptable for state update frequency. More frequent updates are not required.
- Sensor discovery is a rare, operator-initiated action performed by the controller on the local network, with results reported back via the message bus.
- The Shelly device's built-in MQTT reconnect behavior is reliable enough that custom reconnection logic is not needed.
