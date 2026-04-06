# Feature Specification: Review Hardware Architecture

**Feature Branch**: `017-review-hardware-architecture`  
**Created**: 2026-04-02  
**Status**: Draft  
**Input**: User description: "do an overall architectural code review on the hardware designs in the system"

## Clarifications

### Session 2026-04-02

- Q: Should staged commissioning be part of this spec or a separate feature? → A: Add as new P1 user story in this spec (review + rollout plan). Remove wood burner scalability story — disregard for now.
- Q: Which sensors will be installed in stage 1 (first power-on)? → A: Collector + tank bottom + outdoor (3 sensors). Enough for solar charging + automatic freeze protection. Sensor identity verification required before enabling automatic modes (miswiring/mislabeling risk).
- Q: How should manual freeze protection testing work? → A: Use existing forced mode mechanism (`fm: "AD"`) via Device config UI. No new code for the testing mechanism itself. CRITICAL FINDING: Current code suppresses freeze protection when controls are disabled — this must be fixed.
- Q: Which safety rules should be hard-coded (unsuppressible by device config)? → A: Freeze drain + overheat drain + sensor staleness → IDLE. All three fire regardless of `ce`, `ea`, or `am` device config settings. Overheat is lower priority but uses same mechanism as freeze.
- Q: How many commissioning stages before full system? → A: No fixed stages. Operator progressively enables individual modes/loops via allowed_modes as hardware is installed. System must support any combination of enabled modes safely.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Validate Hardware-Software Consistency (Priority: P1)

As a system builder, I want an authoritative review confirming that the hardware design in `system.yaml` is internally consistent with the control logic and shell scripts, so that I can trust the design before purchasing components and starting construction.

**Why this priority**: Any inconsistency between the authoritative spec and the deployed control code could lead to hardware damage, water damage, or freeze damage. This is the highest-value review outcome.

**Independent Test**: Can be fully tested by cross-referencing every valve name, actuator assignment, sensor mapping, mode definition, and safety rule between `system.yaml`, the control logic, the shell script, and the design documentation. Delivers confidence that the system spec and code are in agreement.

**Acceptance Scenarios**:

1. **Given** the valve names and states defined in `system.yaml` modes section, **When** compared to the mode-valve mappings in the control logic, **Then** every mode has identical valve open/closed states in both sources.
2. **Given** the actuator assignments in `system.yaml` control section, **When** compared to relay mappings in the shell script, **Then** every output ID maps to the correct physical device.
3. **Given** the sensor definitions in `system.yaml`, **When** compared to sensor ID mappings in the shell script, **Then** every sensor name and purpose is consistently referenced.

---

### User Story 2 - Identify Design Risks and Hard Safety Overrides (Priority: P1)

As a system builder, I want a review that identifies safety risks and verifies that critical safety rules (freeze drain, overheat drain, sensor staleness) are hard-coded and cannot be suppressed by device configuration, so that the system protects hardware even during staged commissioning when not all features are enabled.

**Why this priority**: Safety risks in a water-based heating system operating in -25°C conditions can cause catastrophic failure. Freeze and overheat protection must fire unconditionally — a miswired config or disabled controls must never prevent a safety drain.

**Independent Test**: Can be fully tested by reviewing the control logic code paths for freeze drain, overheat drain, and sensor staleness to confirm they execute regardless of `ce` (controls_enabled), `ea` (enabled_actuators), and `am` (allowed_modes) device config values. Delivers a verified safety architecture.

**Acceptance Scenarios**:

1. **Given** `deviceConfig.ce = false` (controls disabled) and `t_outdoor < 2°C` with collectors not drained, **When** the control logic evaluates, **Then** the system MUST enter Active Drain mode and actuate the pump and valves — the suppression flag does not block safety drains.
2. **Given** `deviceConfig.am = ["I", "SC"]` (only idle and solar allowed) and `t_tank_top > 85°C`, **When** the control logic evaluates, **Then** the system MUST enter Active Drain mode regardless of the allowed_modes filter.
3. **Given** any sensor reporting stale data beyond the threshold, **When** the control logic evaluates, **Then** the system MUST return to IDLE and stop the pump regardless of device config state.
4. **Given** the single-pump topology, **When** reviewed for single points of failure, **Then** each critical component's failure impact is documented with severity.

---

### User Story 3 - Staged Commissioning Plan (Priority: P1)

As a system builder, I want a commissioning plan that allows me to progressively enable individual modes and loops as hardware installation proceeds, starting with the solar collector loop (3 sensors: collector, tank bottom, outdoor) and expanding to the full system over time.

**Why this priority**: The hardware will be installed incrementally. The control system must be safely operational from the first power-on with only a partial set of sensors and actuators connected. Hard safety rules must be active from day one.

**Independent Test**: Can be fully tested by configuring the device with only the solar charging mode allowed and verifying that: (a) solar charging works with 3 sensors, (b) freeze protection fires automatically, (c) freeze protection can be manually triggered via forced mode, and (d) sensor identity verification confirms correct wiring before automatic modes are enabled.

**Acceptance Scenarios**:

1. **Given** the control box is powered on with 3 sensors (collector, tank bottom, outdoor) and only the solar collector loop plumbed, **When** `am` is set to `["SC"]` (solar charging only), **Then** only solar charging and hard safety modes (freeze drain, overheat drain) can activate.
2. **Given** sensors are connected but not yet verified, **When** the operator reads sensor values via the playground UI, **Then** each sensor can be identified by physically warming/cooling it and observing which reading changes (sensor identity verification).
3. **Given** outdoor temperature is above 2°C and the operator wants to test freeze protection, **When** forced mode is set to `fm: "AD"` via the Device config UI, **Then** the system executes the full Active Drain sequence using the real valves and pump.
4. **Given** a new loop is plumbed and tested (e.g., greenhouse heating), **When** the operator adds `"GH"` to the `am` allowed_modes list, **Then** greenhouse heating mode becomes available alongside solar charging, with no system restart required.

---

### User Story 4 - Verify Electrical and Communication Architecture (Priority: P2)

As a system builder, I want confirmation that the Shelly device topology correctly covers all relay outputs and sensor inputs, and that the device-to-device communication pattern is robust for real-time control of safety-critical operations like freeze drain.

**Why this priority**: Electrical architecture errors discovered during construction are expensive to fix. Communication reliability directly affects safety-critical operations.

**Independent Test**: Can be fully tested by mapping every physical actuator to a specific device output and confirming the relay count, communication path, and failure behavior. Delivers a validated wiring plan.

**Acceptance Scenarios**:

1. **Given** 8 motorized valves + pump + fan + 2 heaters = 12 outputs needed, **When** mapped to the controller (4 outputs) + 4 valve controllers (8 outputs), **Then** every actuator has exactly one assigned relay with no conflicts.
2. **Given** HTTP RPC is used for remote valve control, **When** a network request fails, **Then** the control script includes retry logic and a safe fallback (pump stop, return to idle).

---

### Edge Cases

- What happens when multiple mode triggers are true simultaneously (e.g., freeze drain needed while greenhouse heating is active)?
- How does the system behave during a partial valve failure (valve stuck open or stuck closed)?
- What is the behavior if the sensor hub loses WiFi connectivity while valve controllers remain on Ethernet?
- What happens if the reservoir overflows during a rapid drain-to-tank operation?
- What is the freeze risk window between the 2°C trigger and the time required to complete a full drain sequence?
- How does the system behave when only a subset of valve controllers are powered on (staged hardware install)?
- What happens if a sensor is miswired (e.g., outdoor sensor reads collector temperature) — can the operator detect and correct this before enabling automatic modes?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Review MUST verify that every valve name in `system.yaml` modes section exactly matches the corresponding key in the control logic mode-valve mappings and the shell script valve map.
- **FR-002**: Review MUST verify that every relay assignment in `system.yaml` (controller outputs, valve controller unit assignments) matches the IP address and output ID mappings in the shell script.
- **FR-003**: Review MUST verify that the IP addresses in the shell script are consistent with the DHCP assignments in the device configuration file.
- **FR-004**: Review MUST verify that all safety rules in `system.yaml` (pump-before-valve, one-input-one-output, drain-before-freeze) are enforced by the control logic code.
- **FR-005**: Review MUST identify all single points of failure in the hardware topology and document their failure impact and severity.
- **FR-006**: Review MUST verify that the flow paths described in `system.yaml` modes are physically valid given the height map, piping layout, and pump capabilities.
- **FR-007**: Review MUST verify that the hardware budget and BOM accounts for all components referenced in the control architecture.
- **FR-008**: Review MUST assess the air intake valve design decision (normally-closed vs. normally-open) and confirm the documented rationale is physically sound.
- **FR-009**: Review MUST verify that the deployment script correctly concatenates the logic and shell scripts and deploys to the correct script slots on the target device.
- **FR-010**: Review MUST produce a findings document with categorized issues (Critical / Warning / Informational) and specific remediation recommendations for each finding.
- **FR-011**: Review MUST verify that freeze drain and overheat drain execute unconditionally — they MUST NOT be suppressed by `ce` (controls_enabled), `ea` (enabled_actuators), or `am` (allowed_modes) device config settings. If the current code suppresses them, the finding MUST be categorized as Critical with a specific code change recommendation.
- **FR-012**: Review MUST verify that sensor staleness detection (all sensors stale → IDLE + pump stop) is unsuppressible by device config.
- **FR-013**: Review MUST validate that the allowed_modes (`am`) mechanism correctly supports progressive mode enablement — enabling a single mode (e.g., solar charging only) must not interfere with hard safety rules.
- **FR-014**: Review MUST define a sensor identity verification procedure for commissioning — a method for the operator to confirm each physical sensor maps to the correct logical name before enabling automatic modes.

### Key Entities

- **System Specification**: Single source of truth for all hardware specifications, component dimensions, valve states, and operating modes (`system.yaml`).
- **Control Logic**: Pure decision engine — mode evaluation, valve/actuator state computation. Shared between hardware and simulator.
- **Shell Script**: Device communication layer — relay control, sensor polling, state transitions. References specific network addresses and output IDs.
- **Telemetry Script**: MQTT publish/subscribe and configuration management. Separate from control logic.
- **Design Documentation**: Human-readable design specification derived from the system specification.
- **Device Config**: Compact JSON configuration stored in Shelly KVS. Contains `ce` (controls enabled), `ea` (enabled actuators bitmask), `fm` (forced mode), `am` (allowed modes list), `v` (version). Pushed via MQTT or HTTP.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of valve names, sensor names, and actuator assignments are verified as consistent between the system specification and all code files, with any discrepancies documented.
- **SC-002**: All identified safety-critical risks have a severity rating and a documented mitigation (either already present in the design or recommended as a new measure).
- **SC-003**: The review produces a categorized findings list where every Critical finding has a specific, actionable remediation recommendation.
- **SC-004**: The review confirms or identifies gaps in the relay/sensor hardware topology coverage for all defined operating modes, with documented evidence.
- **SC-005**: All flow paths are confirmed as physically valid (water flows downhill or pump provides adequate head pressure) with no unaccounted thermosiphon or air-lock risks.
- **SC-006**: Hard safety overrides (freeze drain, overheat drain, sensor staleness) are verified as unsuppressible in the control logic, or a Critical finding with code fix is produced.
- **SC-007**: The commissioning plan demonstrates that the system can safely operate with only the solar collector loop (3 sensors, subset of valves) while freeze protection remains active.
- **SC-008**: A sensor identity verification procedure is documented that an operator can follow during commissioning to confirm correct wiring before enabling automatic modes.
