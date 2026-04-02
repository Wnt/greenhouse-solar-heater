# Feature Specification: Review Hardware Architecture

**Feature Branch**: `017-review-hardware-architecture`  
**Created**: 2026-04-02  
**Status**: Draft  
**Input**: User description: "do an overall architectural code review on the hardware designs in the system"

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

### User Story 2 - Identify Design Risks and Safety Gaps (Priority: P1)

As a system builder, I want a review that identifies safety risks, single points of failure, and design gaps in the hardware architecture, so that I can address them before construction begins.

**Why this priority**: Safety risks in a water-based heating system operating in -25°C conditions can cause catastrophic failure (burst pipes, pump damage, greenhouse crop loss). This review must surface risks proactively.

**Independent Test**: Can be fully tested by producing a documented list of identified risks, each with a severity rating and mitigation status (already mitigated in design vs. needs attention). Delivers a pre-construction safety assessment.

**Acceptance Scenarios**:

1. **Given** the freeze protection design (active drain at 2°C), **When** reviewed against failure scenarios (power loss, network failure, sensor failure), **Then** each scenario has a documented risk assessment.
2. **Given** the single-pump topology, **When** reviewed for single points of failure, **Then** each critical component's failure impact is documented with severity.
3. **Given** the open-system water treatment approach, **When** reviewed for material compatibility, **Then** corrosion and biological growth risks are assessed with mitigations.

---

### User Story 3 - Verify Electrical and Communication Architecture (Priority: P2)

As a system builder, I want confirmation that the Shelly device topology correctly covers all relay outputs and sensor inputs, and that the device-to-device communication pattern is robust for real-time control of safety-critical operations like freeze drain.

**Why this priority**: Electrical architecture errors discovered during construction are expensive to fix. Communication reliability directly affects safety-critical operations.

**Independent Test**: Can be fully tested by mapping every physical actuator to a specific device output and confirming the relay count, communication path, and failure behavior. Delivers a validated wiring plan.

**Acceptance Scenarios**:

1. **Given** 8 motorized valves + pump + fan + 2 heaters = 12 outputs needed, **When** mapped to the controller (4 outputs) + 4 valve controllers (8 outputs), **Then** every actuator has exactly one assigned relay with no conflicts.
2. **Given** HTTP RPC is used for remote valve control, **When** a network request fails, **Then** the control script includes retry logic and a safe fallback (pump stop, return to idle).

---

### User Story 4 - Assess Scalability and Future Expansion (Priority: P3)

As a system builder, I want the review to assess how well the current architecture supports planned future additions (wood burner integration, additional sensors), so that I can avoid costly rework later.

**Why this priority**: The design already includes a capped 4th output manifold port for the wood burner. Confirming the architecture accommodates this gracefully is valuable but not blocking for initial construction.

**Independent Test**: Can be fully tested by checking that the output manifold has capacity, the device count has spare/expansion capacity, and the control logic can accommodate the additional valve definition. Delivers a future-readiness assessment.

**Acceptance Scenarios**:

1. **Given** the 4-port output manifold with a capped port for the wood burner, **When** a wood burner valve is added, **Then** no manifold hardware changes are needed — only uncapping the port and adding a new valve controller unit.
2. **Given** the sensor hub supports 5 sensors natively, **When** all 7 sensors (including optional) are connected, **Then** a documented plan exists for the second sensor hub or alternative wiring.

---

### Edge Cases

- What happens when multiple mode triggers are true simultaneously (e.g., freeze drain needed while greenhouse heating is active)?
- How does the system behave during a partial valve failure (valve stuck open or stuck closed)?
- What is the behavior if the sensor hub loses WiFi connectivity while valve controllers remain on Ethernet?
- What happens if the reservoir overflows during a rapid drain-to-tank operation?
- What is the freeze risk window between the 2°C trigger and the time required to complete a full drain sequence?

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

### Key Entities

- **System Specification**: Single source of truth for all hardware specifications, component dimensions, valve states, and operating modes (`system.yaml`).
- **Control Logic**: Pure decision engine — mode evaluation, valve/actuator state computation. Shared between hardware and simulator.
- **Shell Script**: Device communication layer — relay control, sensor polling, state transitions. References specific network addresses and output IDs.
- **Telemetry Script**: MQTT publish/subscribe and configuration management. Separate from control logic.
- **Design Documentation**: Human-readable design specification derived from the system specification.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of valve names, sensor names, and actuator assignments are verified as consistent between the system specification and all code files, with any discrepancies documented.
- **SC-002**: All identified safety-critical risks have a severity rating and a documented mitigation (either already present in the design or recommended as a new measure).
- **SC-003**: The review produces a categorized findings list where every Critical finding has a specific, actionable remediation recommendation.
- **SC-004**: The review confirms or identifies gaps in the relay/sensor hardware topology coverage for all defined operating modes, with documented evidence.
- **SC-005**: All flow paths are confirmed as physically valid (water flows downhill or pump provides adequate head pressure) with no unaccounted thermosiphon or air-lock risks.
