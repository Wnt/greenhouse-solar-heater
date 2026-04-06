# Feature Specification: Configure Sensor Connectors

**Feature Branch**: `018-configure-sensor-connectors`  
**Created**: 2026-04-06  
**Status**: Draft  
**Input**: User description: "When I start to take the system into use and I plugin one sensor at a time to the shelly sensor hosts, I need to make sure I plugin the right sensor into the correct connector in my wiring harness. I think I also need to configure the shelly sensor host config with the HW address of the just plugged-in sensor. add a feature into the UI that can help me with this. The system should be pretty flexible and usable to also when re-configuring the system or swapping sensors. it should be able to detect plugged-in sensors from both sensor hosts and write to the system config where each sensor is installed an at which index."

## Clarifications

### Session 2026-04-06

- Q: Should the system fully own and manage all sensor configuration on the Shelly host devices, including cleanup of stale entries? → A: Yes. The system has total ownership of Shelly sensor host configuration. When applying, the system replaces the full sensor configuration on each host — any sensor address not assigned by this system is removed. When a sensor moves between hosts, its address is removed from the old host and added to the new one, ensuring a 1-Wire address never appears on two hosts simultaneously.
- Q: Should applying the sensor configuration also update the control system's sensor polling config (host + index per role)? → A: Yes, in scope. The apply step updates both the sensor host devices and the control system's sensor routing, so the control system knows which host and index to poll for each sensor role. This makes the feature end-to-end complete.
- Q: When applying config to multiple targets (two hosts + control system), what happens if one is unreachable? → A: Best-effort — apply to reachable targets, warn about failures, allow retry for failed targets later.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Detect and Identify a Newly Plugged-In Sensor (Priority: P1)

The operator is commissioning the system for the first time. They plug a DS18B20 sensor into one of the connectors on a sensor host (Shelly 1 Gen3 + Add-on). They open the playground UI and navigate to a sensor configuration view. The UI shows which sensors are currently detected on each sensor host, displaying the 1-Wire hardware address and the current temperature reading for each detected sensor. The operator can see the new sensor appear (or refresh to detect it), confirm it is reading a plausible temperature, and identify it physically (e.g., by warming the sensor with their hand and watching the temperature rise in the UI).

**Why this priority**: Without the ability to detect and identify sensors, none of the subsequent assignment or configuration steps are possible. This is the foundational capability.

**Independent Test**: Can be fully tested by plugging in a single sensor, opening the UI, and verifying the sensor appears with its hardware address and a live temperature reading.

**Acceptance Scenarios**:

1. **Given** a sensor host is online and reachable, **When** the operator opens the sensor configuration view, **Then** all currently connected sensors are listed with their 1-Wire hardware address, connector index, and current temperature.
2. **Given** the operator plugs in a new sensor while the view is open, **When** they trigger a refresh (or the view auto-refreshes), **Then** the newly connected sensor appears in the list.
3. **Given** two sensor hosts exist on the network, **When** the operator opens the view, **Then** sensors from both hosts are shown, clearly grouped by host.

---

### User Story 2 - Assign a Detected Sensor to a System Role (Priority: P1)

After identifying a sensor (by its temperature reading or physical test), the operator assigns it to a system role (e.g., "t_collector", "t_tank_top", "t_greenhouse"). The UI presents a list of all defined sensor roles from the system configuration, shows which roles are already assigned and which are unassigned. The operator selects an unassigned detected sensor and maps it to the desired role. This assignment is saved to the system configuration.

**Why this priority**: Assigning sensors to roles is the core purpose of the feature — without it, the control system cannot know which physical sensor corresponds to which measurement point.

**Independent Test**: Can be tested by detecting a sensor (Story 1), assigning it to a role, saving, and verifying the assignment persists in the system configuration.

**Acceptance Scenarios**:

1. **Given** one or more sensors are detected and the system has defined sensor roles, **When** the operator views the configuration, **Then** each role shows either its currently assigned sensor (with address and live temperature) or an "unassigned" state.
2. **Given** an unassigned sensor is detected, **When** the operator assigns it to a role and saves, **Then** the system configuration is updated with the sensor's hardware address mapped to that role at the correct host and index.
3. **Given** a role already has a sensor assigned, **When** the operator assigns a different sensor to that role, **Then** the previous assignment is cleared and the new one takes effect.

---

### User Story 3 - Swap or Reconfigure Sensors (Priority: P2)

The operator needs to replace a faulty sensor or reorganize the wiring. They unplug the old sensor and plug in a replacement. In the UI, the old sensor disappears from the detected list (or shows as disconnected). The operator assigns the new sensor to the same role. The system configuration updates seamlessly without requiring manual editing of configuration files.

**Why this priority**: Sensor replacement and reconfiguration are ongoing maintenance tasks that must be supported, but are less frequent than initial commissioning.

**Independent Test**: Can be tested by swapping a sensor, refreshing the view, and reassigning the role to the new sensor.

**Acceptance Scenarios**:

1. **Given** a sensor is assigned to a role and the operator unplugs it, **When** they refresh the view, **Then** the sensor shows as disconnected or missing, and the role shows a warning.
2. **Given** a replacement sensor is plugged in, **When** the operator detects it and assigns it to the vacated role, **Then** the configuration updates with the new sensor's hardware address.
3. **Given** the operator wants to move a sensor from one connector to another on the same host, **When** they unplug and replug, **Then** the system detects the sensor at the new index and the operator can update the assignment.

---

### User Story 4 - Apply Full Sensor Configuration (Priority: P2)

After assigning sensors to roles, the operator applies the configuration. This performs two things: (1) configures each sensor host device with the correct 1-Wire address-to-index mapping, and (2) updates the control system's sensor polling configuration so it knows which host and index to query for each sensor role. This makes the system end-to-end operational — the sensor hosts report the right temperatures at the right indices, and the control system polls the right hosts.

**Why this priority**: Without applying the configuration to both the sensor hosts and the control system, the system cannot operate correctly. This is the culmination of the commissioning workflow.

**Independent Test**: Can be tested by completing sensor assignments, applying, then verifying both that the sensor hosts return correct readings at expected indices and that the control system polls the correct host for each role.

**Acceptance Scenarios**:

1. **Given** all required sensor roles are assigned, **When** the operator triggers "apply configuration", **Then** each sensor host device is configured so each sensor index corresponds to the correct hardware address.
2. **Given** sensors span two hosts, **When** the operator applies, **Then** the control system's sensor polling configuration is updated to query the correct host and index for each sensor role.
3. **Given** the operator changes an assignment, **When** they apply the configuration again, **Then** both the sensor hosts and the control system update to reflect the new mapping.
4. **Given** a sensor is moved from one host to another, **When** the operator applies, **Then** the old host's configuration no longer contains that sensor's address.

---

### Edge Cases

- What happens when a sensor host is unreachable? The UI should show a clear error for that host and still display data from the reachable host.
- What happens when two sensors have very similar temperatures? The operator can use the "warm by hand" identification method — the UI shows live temperature updates so temperature changes are visible.
- What happens when more sensors are detected than there are defined roles? Extra sensors are shown as "unassigned" with no role — the operator can ignore them or assign them to optional roles.
- What happens when a sensor is detected but returns an error (e.g., wiring fault)? The UI shows the sensor with an error indicator instead of a temperature reading.
- What happens when the same hardware address appears on two different hosts? This should not happen physically; if detected, the UI warns about the duplicate.
- What happens when one sensor host is unreachable during apply? The system applies to reachable targets, shows per-target success/failure status, and allows retry for failed targets without re-pushing to already-configured targets.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST discover all DS18B20 sensors connected to each sensor host by querying the host's temperature sensor interface.
- **FR-002**: System MUST display each detected sensor's 1-Wire hardware address, connector index, host identity, and current temperature reading.
- **FR-003**: System MUST present all defined sensor roles (from system configuration) and show their current assignment status (assigned with details, or unassigned).
- **FR-004**: System MUST allow the operator to assign any detected sensor to any defined sensor role.
- **FR-005**: System MUST allow the operator to unassign a sensor from a role, returning both to their unassigned states.
- **FR-006**: System MUST persist sensor-to-role assignments in the system configuration, recording the sensor's hardware address, host identity, and connector index for each role.
- **FR-007**: System MUST support querying multiple sensor hosts (currently two: 192.168.30.20 and 192.168.30.21) and clearly distinguish which sensors belong to which host.
- **FR-008**: System MUST provide live or near-live temperature readings for detected sensors to help the operator physically identify them.
- **FR-009**: System MUST allow the operator to push the finalized sensor mapping to the sensor host devices so that sensor indices align with the control system's expectations.
- **FR-009a**: When applying configuration, the system MUST fully replace each sensor host's sensor configuration — removing any sensor addresses not assigned by this system. The system has total ownership of sensor host configuration.
- **FR-009b**: When a sensor is moved between hosts, the system MUST remove its 1-Wire address from the previous host's configuration and add it to the new host, ensuring a hardware address never appears on two hosts simultaneously.
- **FR-009c**: When applying configuration, the system MUST also update the control system's sensor polling configuration so it knows which host address and sensor index to query for each sensor role.
- **FR-010**: System MUST show clear error states when a sensor host is unreachable, a sensor returns an error, or a previously assigned sensor is no longer detected.
- **FR-010a**: When applying configuration, the system MUST use a best-effort approach: apply to all reachable targets, clearly report which targets succeeded and which failed, and allow the operator to retry failed targets without re-applying to already-succeeded targets.
- **FR-011**: System MUST warn the operator if required (non-optional) sensor roles remain unassigned when attempting to apply the configuration.
- **FR-012**: System MUST be usable both during initial commissioning and for later reconfiguration or sensor replacement without requiring manual file editing.

### Key Entities

- **Sensor Host**: A Shelly 1 Gen3 device with a Plus Add-on providing a 1-Wire bus. Identified by its network address. Has a set of connector indices (0-4 per Add-on) where sensors are physically plugged in.
- **Detected Sensor**: A DS18B20 sensor discovered on a sensor host. Identified by its unique 1-Wire hardware address, the host it's connected to, and its connector index. Reports a current temperature.
- **Sensor Role**: A named measurement point defined in the system configuration (e.g., t_collector, t_tank_top). Has a location description and may be marked as optional. Can be assigned to exactly one detected sensor.
- **Sensor Assignment**: The mapping between a sensor role and a detected sensor. Records which hardware address on which host at which index fulfills a given role.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Operator can identify and assign all 5 core sensors to their correct roles within 10 minutes during initial commissioning.
- **SC-002**: Detected sensors display a live temperature reading that updates at least every 30 seconds, enabling physical identification by warming.
- **SC-003**: After applying the configuration, the control system reads the correct temperature for each sensor role on the first polling cycle.
- **SC-004**: Replacing a single faulty sensor (unplug old, plug new, reassign, apply) takes under 2 minutes.
- **SC-005**: The entire commissioning workflow is completable from the UI without editing any configuration files by hand.
- **SC-006**: Both sensor hosts are queried and their sensors displayed, supporting a full 7-sensor deployment across two hosts.

## Assumptions

- The Shelly 1 Gen3 with Plus Add-on exposes 1-Wire sensor information (hardware addresses, temperature readings) via its HTTP RPC interface, using endpoints like `Temperature.GetStatus` and potentially `Temperature.GetConfig` or `Shelly.GetStatus`.
- Each Add-on supports up to 5 DS18B20 sensors. With 7 sensors, two hosts are needed.
- The sensor host IP addresses are known and configured (currently in `shelly/devices.conf`).
- The operator has physical access to the sensors and can identify them by touching/warming them while watching the UI.
- The system configuration (sensor-to-role mapping) can be persisted via the existing device configuration mechanism or a similar server-side store.
- The sensor host can be reconfigured via RPC to set the 1-Wire address-to-index mapping.
- The control system's sensor polling configuration (which host and index per role) can be updated at apply time — either via the existing device config mechanism or a dedicated sensor config store.
