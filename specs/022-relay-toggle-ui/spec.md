# Feature Specification: Manual Relay Toggle UI

**Feature Branch**: `022-relay-toggle-ui`  
**Created**: 2026-04-07  
**Status**: Draft  
**Input**: User description: "Add a feature to the device view in playground UI where I can manually toggle state of relays. I want to be able to test each valve actuation, fan and pump. The communication should happen via MQTT and have as low latency as possible. There should be a sound board style view where I can toggle all relays on / off. Entering this mode would disable automated operations of the system. The manual override mode should default to e.g. 5 minutes and then switch back to automation mode if the user doesn't set another TTL for manual overrides. And of course if the device was not in controls enabled mode, the system should not switch it on. Tapping buttons in the toggle board should have nice visual feedback and use mobile phone vibration API to make toggling the valves feel more physical."

## Clarifications

### Session 2026-04-07

- Q: Should safety overrides (freeze drain, overheat drain) always take precedence during manual override, or should the user be able to suppress them? → A: User-selectable option when entering manual override. "Suppress Safety Overrides" defaults to OFF (safe default). When ON, safety overrides are suspended for the TTL duration, allowing unrestricted actuator testing.
- Q: When a relay toggle command fails (device unreachable, actuator doesn't respond), how should the system handle it? → A: Silently revert the button state with a brief visual "shake" or error color flash (no modal/toast).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Enter Manual Override and Toggle Individual Relays (Priority: P1)

As a system operator, I want to enter a manual override mode from the Device view and individually toggle each relay (8 valve relays, pump, fan) on or off using a soundboard-style grid of buttons, so I can test actuator function during commissioning or troubleshooting.

**Why this priority**: Core value of the feature. Without the ability to toggle relays in manual mode, no other stories deliver value.

**Independent Test**: Can be fully tested by entering manual override mode, tapping individual relay buttons, and verifying the corresponding hardware actuates. Delivers immediate value for commissioning and diagnostics.

**Acceptance Scenarios**:

1. **Given** the device has controls enabled (`ce=true`) and the system is in automation mode, **When** I tap "Enter Manual Override" in the Device view, **Then** the system enters manual override mode, automation is suspended, a countdown timer shows the remaining override duration (default 5 minutes), and the relay toggle board becomes active.
2. **Given** manual override mode is active, **When** I tap a relay button (e.g., "Pump"), **Then** the relay toggles to the opposite state, the button visually reflects the new state, I feel a brief haptic vibration, and the state change is confirmed within 1 second.
3. **Given** manual override mode is active and a relay is on, **When** I tap the same relay button again, **Then** the relay turns off, the button visually reflects the off state, and I feel haptic feedback.
4. **Given** the device does NOT have controls enabled (`ce=false`), **When** I view the Device page, **Then** the manual override button is disabled with a clear explanation that controls must be enabled first, and the toggle board is not accessible.

---

### User Story 2 - Auto-Revert to Automation After TTL Expires (Priority: P2)

As a system operator, I want the manual override to automatically expire and return to normal automation after a configurable duration, so I never accidentally leave the system in a manual state that could cause damage.

**Why this priority**: Safety-critical behavior. Without auto-revert, a forgotten manual override could leave valves open or the pump running indefinitely.

**Independent Test**: Can be tested by entering manual override, waiting for the TTL to expire, and verifying the system resumes automation and all manually-set relays return to their automation-determined state.

**Acceptance Scenarios**:

1. **Given** manual override mode is active with a 5-minute TTL, **When** 5 minutes elapse without the user extending the TTL, **Then** manual override ends, the system resumes automated control, and the relay toggle board becomes inactive.
2. **Given** manual override mode is active, **When** I adjust the TTL (e.g., to 15 minutes), **Then** the countdown resets to the new duration and the override continues.
3. **Given** manual override mode is active, **When** the TTL expires, **Then** all relays return to whatever state the automation logic determines (not necessarily all off), and a notification indicates that manual override has ended.

---

### User Story 3 - Tactile Feedback on Relay Toggle (Priority: P3)

As a mobile user, I want each relay button tap to produce immediate visual feedback and haptic vibration, so the toggle board feels responsive and physical, like pressing real switches.

**Why this priority**: Enhances usability and confidence when operating physical hardware remotely. Important for the "soundboard" experience but the feature works without it.

**Independent Test**: Can be tested on a mobile device by tapping relay buttons and verifying that visual state change and vibration occur immediately, regardless of network round-trip time.

**Acceptance Scenarios**:

1. **Given** manual override mode is active on a mobile device, **When** I tap a relay button, **Then** the button provides instant visual feedback (color/state change) and a short vibration pulse before the server round-trip completes.
2. **Given** the device does not support the Vibration API (e.g., desktop browser), **When** I tap a relay button, **Then** visual feedback still occurs and no errors are thrown.
3. **Given** manual override mode is active, **When** a relay toggle command fails, **Then** the button silently reverts to its previous state with a brief visual error indicator (shake or error color flash), without modal dialogs or toasts.

---

### User Story 4 - Exit Manual Override Voluntarily (Priority: P3)

As a system operator, I want to exit manual override before the TTL expires, so I can return to automation at any time.

**Why this priority**: Convenience and safety — operator may finish testing early.

**Independent Test**: Can be tested by entering manual override, toggling some relays, then tapping "Exit Manual Override" and verifying automation resumes.

**Acceptance Scenarios**:

1. **Given** manual override mode is active, **When** I tap "Exit Manual Override", **Then** manual override ends immediately, automation resumes, and the toggle board becomes inactive.
2. **Given** manual override mode is active and some relays were toggled on, **When** I exit manual override, **Then** the automation logic takes over and sets relays to whatever state it determines appropriate.

---

### Edge Cases

- What happens when the WebSocket connection drops during manual override? The override TTL continues on the server/device side regardless of UI connectivity. When reconnected, the UI reflects the current state.
- What happens if another user saves a device config change during manual override? The manual override takes precedence until TTL expires. Config changes that disable controls (`ce=false`) immediately end the override and disable all relays (safety takes priority).
- What happens if a safety condition (freeze drain, overheat drain) triggers during manual override? If "Suppress Safety Overrides" is OFF (default), safety overrides take precedence — the system executes the safety mode, manual override is suspended, and the user is notified. If "Suppress Safety Overrides" is ON, the safety condition is ignored for the duration of the override TTL, allowing unrestricted testing.
- What happens when the browser tab is closed during manual override? The override TTL continues server/device-side. Relays remain in their manual state until TTL expires, then automation resumes.
- What happens when a relay toggle command fails? The button silently reverts to its previous state with a brief visual error indicator (shake or error color flash). No retry is attempted automatically — the user can tap again to retry manually.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a "Manual Override" mode accessible from the Device view that suspends all automated relay control when activated.
- **FR-002**: System MUST display a soundboard-style grid of toggle buttons, one for each controllable actuator: 8 valves (vi_btm, vi_top, vi_coll, vo_coll, vo_rad, vo_tank, v_ret, v_air), pump, and fan.
- **FR-003**: Each toggle button MUST show the current relay state (on/off) and update within 1 second of a state change command.
- **FR-004**: Relay toggle commands MUST be transmitted via the lowest-latency available communication path to minimize delay between tap and actuation.
- **FR-005**: System MUST provide immediate optimistic visual feedback on button tap, before the server round-trip confirms the state change.
- **FR-006**: System MUST use the Vibration API to provide a short haptic pulse on each relay toggle tap, gracefully degrading on unsupported devices.
- **FR-007**: Manual override MUST have a configurable time-to-live (TTL) that defaults to 5 minutes.
- **FR-008**: System MUST display a visible countdown showing remaining override time.
- **FR-009**: When the TTL expires, system MUST automatically exit manual override and resume automated control.
- **FR-010**: Users MUST be able to adjust the TTL while in manual override mode (extending or shortening the remaining time).
- **FR-011**: Users MUST be able to voluntarily exit manual override before TTL expiration.
- **FR-012**: Manual override mode MUST NOT be available when the device's controls-enabled setting is off. The UI MUST clearly indicate why the feature is unavailable.
- **FR-013**: If controls are disabled externally while manual override is active, the override MUST end immediately and all relays MUST be disabled.
- **FR-014**: When entering manual override, the user MUST be presented with a "Suppress Safety Overrides" option that defaults to OFF (safe default: safety overrides active). When the option is OFF, safety-critical operations (freeze drain, overheat drain) take precedence and can interrupt manual override. When the option is ON, safety overrides are also suspended for the duration of the manual override TTL, allowing unrestricted actuator testing.
- **FR-016**: The "Suppress Safety Overrides" setting MUST revert to its safe default (OFF) when the manual override session ends (whether by TTL expiry, voluntary exit, or controls being disabled externally).
- **FR-015**: The relay toggle board MUST display human-readable labels for each actuator alongside technical identifiers so operators can identify which physical component each button controls.
- **FR-017**: When a relay toggle command fails (device unreachable, actuator unresponsive), the system MUST silently revert the button to its previous state with a brief visual error indicator (shake animation or error color flash) — no modal dialogs or toast notifications.

### Key Entities

- **Manual Override Session**: Represents an active override period with a start time, TTL duration, safety-override-suppression flag, and the set of relay states being manually controlled. Exists only while override is active.
- **Relay Command**: A request to change a specific relay's state (on/off), including the target actuator identifier and desired state. Transmitted with minimal latency.
- **Override TTL**: The configurable duration for which manual override remains active before auto-reverting to automation. Adjustable during an active session.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can toggle any individual relay and see confirmed state feedback within 1 second of tapping the button in typical network conditions.
- **SC-002**: Manual override auto-reverts to automation within 30 seconds of TTL expiration with no user intervention, even when the server or internet connection is down.
- **SC-003**: 100% of relay toggle taps on supported mobile devices produce haptic vibration feedback.
- **SC-004**: The toggle board displays all 10 controllable actuators (8 valves + pump + fan) in a grid layout that is usable on both mobile and desktop screens.
- **SC-005**: Users can complete a full commissioning test (enter override, toggle each actuator on then off, exit override) in under 3 minutes.
- **SC-006**: No automated relay changes occur during an active manual override session. When safety override suppression is OFF (default), safety conditions can still interrupt the session. When suppression is ON, no automated changes occur at all.

## Assumptions

- The existing device config mechanism (controls-enabled, enabled-actuators bitmask) provides the authorization gate for manual override — no new permission system is needed.
- Space heater and immersion heater are excluded from the toggle board, as the user specifically mentioned valves, fan, and pump. These can be added later if needed.
- The override TTL is enforced primarily on the Shelly device itself (checked every control loop iteration, ~30 seconds), ensuring auto-revert even when the server or internet is unreachable. The server tracks TTL as a secondary measure for client notification.
- Optimistic UI updates (instant visual feedback before server confirmation) are acceptable, with reconciliation when the actual state is received.
- The existing communication infrastructure provides sufficient latency for near-real-time relay control.
