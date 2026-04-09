# Feature Specification: Limit Concurrent Valve Operations

**Feature Branch**: `023-limit-valve-operations`
**Created**: 2026-04-09
**Status**: Draft
**Input**: User description: "the 24V PSU I have in the system is only rated to operate max two of the valves simultaneously from closed to open position. Ensure in the Shelly control script that only two valves are doing this phase change at the same time. Operating from closed to open mode takes about 20 seconds. Only after that another valve is allowed to change from closed to open position. In closing valves the same rule doesn't apply. any number of valves can be closed at the same time. But there is an important caveat: a valve must remain open for at least 1 minute before closing as there is an internal capacitor in the valves that gets slowly charged. this capacitor then operates the motor into the closing direction"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Protect the 24V PSU During Mode Transitions (Priority: P1)

As the operator of the greenhouse heating system, I need the control script to open at most two valves simultaneously so that the 24V power supply is never asked to deliver more current than it is rated for, and no valve opening operation is interrupted by an undervoltage event.

**Why this priority**: Directly prevents hardware damage and undefined system states. Without this limit, a mode transition that requires three or more valves to open at once (e.g., entering Solar Charging or Active Drain from IDLE) can overload the PSU, causing brown-outs, partial valve actuation, or PSU failure. All other enhancements depend on the system staying physically operable.

**Independent Test**: Trigger a mode transition that requires three or more closed valves to open (e.g., IDLE → ACTIVE_DRAIN). Observe that no more than two valves are energized into the "opening" phase at the same time, and that the third valve only begins its opening phase after at least one of the previously opening valves has completed its 20-second opening window. The system still arrives at the correct final valve configuration.

**Acceptance Scenarios**:

1. **Given** the system is in a state where valves A, B, and C are currently closed and a mode change requires all three to be open, **When** the control loop commands the new mode, **Then** valves A and B begin opening simultaneously, valve C does not begin opening until at least 20 seconds have passed and at least one of A/B has finished its opening window, and the system eventually reaches the target state with all three valves open.
2. **Given** a mode change requires four closed valves (A, B, C, D) to be opened, **When** the control loop commands the new mode, **Then** at any instant during the transition, no more than two valves are in the "opening" phase, and the transition completes with all four valves open in roughly 40 seconds (two batches of two).
3. **Given** a mode change requires both opening some valves and closing others, **When** the control loop commands the new mode, **Then** the valves being closed are not counted against the concurrent-opening limit and may actuate in parallel with the opening operations (subject to the minimum-open-time rule in Story 3).
4. **Given** only one valve needs to be opened, **When** the control loop commands the new mode, **Then** the valve opens immediately without any artificial delay.

---

### User Story 2 - Queue Pending Opens Across Control Cycles (Priority: P1)

As the operator, I need the control script to remember valves that still need to be opened and continue the staged opening on subsequent control iterations (or ticks) so that a mode transition is not abandoned half-way if the target state cannot be reached in a single control cycle.

**Why this priority**: Without a persistent queue or state machine for pending opens, a transition that needs more than two valves would either (a) complete only partially and leave the system in an inconsistent hydraulic state, or (b) require blocking the entire control loop for tens of seconds, which conflicts with the 30-second polling interval and safety-event responsiveness. This capability is required for Story 1 to work for mode transitions that involve three or more opening valves.

**Independent Test**: Start from a mode whose target state requires four closed valves to be opened. Wait through the full transition while observing the valve state on each control tick. Confirm that after the first tick exactly two valves are opening, after the next batch completes the remaining two begin opening, and the full target state is reached without operator intervention.

**Acceptance Scenarios**:

1. **Given** a mode transition was started that needs four valves to open, **When** the first batch of two has completed its opening window, **Then** the next control tick (or the internal scheduler) begins opening the remaining two valves without requiring the mode to be re-requested.
2. **Given** a staged opening is in progress, **When** the control logic decides the target mode should change again mid-transition, **Then** the system follows the new target mode and only opens the valves required by the new target (no "leftover" opens from the superseded target).
3. **Given** a valve in the opening phase does not confirm success within its 20-second window, **When** the window expires, **Then** the valve is released from the "currently opening" bookkeeping so that queued valves are not blocked indefinitely, and the error is surfaced through the existing error-reporting path.

---

### User Story 3 - Honor the Minimum-Open Hold Before Closing (Priority: P1)

As the operator, I need every motorized valve to remain open for at least one minute before it is commanded to close, because the internal capacitor that drives the closing motor only charges while the valve is energized open. Closing the valve too early leaves the capacitor under-charged and the valve physically stuck or only partially closed.

**Why this priority**: This is a hardware-protection rule with direct physical consequences — an under-charged capacitor means the valve cannot close, which in turn means water paths are not isolated as expected, which can cause thermal short-circuits, wasted pump energy, or in the worst case, freezing collectors that cannot be drained. It must hold for every normal mode transition.

**Independent Test**: Open a valve, then immediately command a transition that would close it. Observe that the close command is deferred until at least 60 seconds have elapsed since the valve first reached the open state. Confirm that after the hold time, the valve closes successfully. A second test: open a valve, wait more than 60 seconds, then close it — the close should happen immediately with no artificial delay.

**Acceptance Scenarios**:

1. **Given** valve X was just commanded open at time T and is currently open, **When** the control loop decides valve X must be closed at time T+30s, **Then** the close command is deferred and valve X is actually closed no earlier than T+60s.
2. **Given** valve X has been open for more than 60 seconds, **When** the control loop decides valve X must be closed, **Then** the close command is executed immediately, with no artificial delay.
3. **Given** several valves need to be closed and one of them has not yet reached its 60-second minimum, **When** the control loop issues the close batch, **Then** the valves that have met their minimum open time close immediately (in parallel, with no PSU concurrency limit for closing), and the one that has not met it is deferred until its hold time elapses.
4. **Given** a valve's close command is deferred due to the minimum-open rule, **When** the hold time elapses, **Then** the close actually happens without requiring any new external trigger.

---

### User Story 4 - Safety-Critical Drains Still Execute As Fast As Physically Possible (Priority: P2)

As the operator, I need safety-triggered mode changes (freeze drain, overheat drain) to reach the ACTIVE_DRAIN valve configuration as quickly as the hardware rules allow, even when those rules add delay relative to the previous behavior.

**Why this priority**: Safety overrides must be effective. However, ignoring the PSU concurrency limit would risk burning out the power supply during an already stressful event, and ignoring the 1-minute capacitor hold on closing valves would mean the valves fail to close and the drain path is not actually established. So the rules must still apply, but nothing else (e.g., minimum mode duration, user-level throttling) should add further delay.

**Independent Test**: Trigger a freeze drain from a Solar Charging state (which has some valves open that must close and some closed that must open). Confirm that: (a) valves being closed that have been open > 60s close immediately in parallel, (b) valves being closed that haven't yet met 60s are deferred only until their hold elapses, (c) valves being opened follow the 2-at-a-time rule, and (d) no other throttles (minimum mode duration, refill cooldown) are applied.

**Acceptance Scenarios**:

1. **Given** a freeze-drain safety override is triggered, **When** the transition begins, **Then** the opening of drain-path valves follows the 2-at-a-time PSU rule but is otherwise prioritized over all non-safety throttles.
2. **Given** a safety override needs to close a valve that has been open for less than 60 seconds, **When** the close is issued, **Then** the close is deferred only until the capacitor hold has elapsed, and the deferral is logged/observable so operators know why the drain took marginally longer.
3. **Given** a safety override is active, **When** new valves need to be opened after the first batch of two finishes, **Then** the second batch starts immediately (no artificial delay beyond the 20-second opening window and the PSU concurrency rule).

---

### User Story 5 - Operators Can Observe Staged Valve Progress (Priority: P3)

As an operator monitoring the playground UI and the device logs, I want to see which valves are currently in the "opening" phase, which are queued, and which close commands are being deferred due to the minimum-open hold, so that unexpected delays during mode transitions are explainable rather than confusing.

**Why this priority**: Nice-to-have for operational clarity. The feature is correct and safe without it, but without visibility, operators seeing a multi-second delay during mode transitions may conclude something is broken.

**Independent Test**: Trigger a mode transition that requires staged opening and a deferred close. Observe the device log, the playground Status view, or the Device view and confirm that the in-progress opening batch, the queued valves, and the deferred closes are each visible.

**Acceptance Scenarios**:

1. **Given** a staged opening is in progress, **When** I view the device state (via logs or UI), **Then** I can see which valves are currently opening and which are queued.
2. **Given** a close is being deferred due to the minimum-open hold, **When** I view the device state, **Then** I can see that the close is pending and approximately how much longer the hold will last.

---

### Edge Cases

- **Mid-open mode change**: If the system decides to abandon the current mode while a batch of valves is mid-opening, those valves must still complete their in-progress opening window (physically, a half-opened valve is worse than an open one) and the new target is applied from the resulting state. In particular, a valve that has just started opening must not be immediately commanded closed — that would both overlap opening/closing commands on the same valve and also violate the minimum-open hold.
- **Power cycle during a staged opening**: After a reboot, the control script does not know how long any valve has been open. The safe assumption is that any valve found open at boot has been open for "long enough" to be closeable (so the system can recover to IDLE), but newly opened valves after boot still track their open timestamps normally.
- **Valve that never confirms open**: If a valve does not confirm reaching the open state within its 20-second window, it is released from the concurrent-opening slot, the error is recorded via the existing error path, and the next queued valve (if any) is allowed to proceed. The system should not block indefinitely waiting for a dead valve.
- **Repeat "open" of an already-open valve**: Commanding a valve that is already open to stay open must not consume a concurrent-opening slot and must not reset its minimum-open timer.
- **Manual override mode (feature 022)**: Relay toggle commands issued while manual override is active should obey the same hardware-protection rules (PSU limit on opens, minimum-open hold on closes). The UI may indicate that a manual open/close has been queued or deferred rather than silently failing, but the enforcement happens device-side.
- **Idle → idle with no actual change**: If the target valve state equals the current valve state, no commands are issued, no slots are consumed, and no deferrals happen.
- **Closing an already-closed valve**: Commanding a valve that is already closed to stay closed is a no-op and does not trigger the minimum-open rule.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The Shelly control script MUST ensure that at most two valves are in the "closed → open" transition phase at the same time.
- **FR-002**: The control script MUST treat the valve "opening" phase as lasting a configurable duration (default 20 seconds) during which the opening slot remains occupied.
- **FR-003**: When a valve's 20-second opening window has elapsed (whether successfully confirmed or timed out), the control script MUST free that concurrent-opening slot so that the next queued valve can begin opening.
- **FR-004**: When more than two valves need to be opened as part of a single mode transition, the control script MUST open them in batches of at most two, with subsequent batches starting as soon as a slot becomes available.
- **FR-005**: The control script MUST NOT artificially limit the number of valves that can be commanded closed simultaneously — any number of valves whose minimum-open hold has elapsed may close in parallel.
- **FR-006**: The control script MUST record the timestamp at which each valve most recently transitioned into the "open" state.
- **FR-007**: Before commanding a valve to close, the control script MUST verify that at least 60 seconds (configurable minimum-open hold) have elapsed since that valve entered the "open" state. If not, the close MUST be deferred until the hold has elapsed.
- **FR-008**: While a close command is deferred, the control script MUST NOT re-issue the "open" command to that valve and MUST NOT count it as "currently opening."
- **FR-009**: Once the deferred close's minimum-open hold has elapsed, the control script MUST execute the close without requiring any new external trigger (control-loop iteration or equivalent is sufficient).
- **FR-010**: Safety-critical mode transitions (freeze drain, overheat drain) MUST still honor both the PSU concurrent-open limit and the minimum-open hold for closing, because these are physical hardware constraints. Safety transitions MUST NOT add any other throttles on top of them.
- **FR-011**: The system MUST correctly reach the final target valve configuration for every mode transition, including transitions that require staging across multiple control iterations.
- **FR-012**: If a new mode target is selected while a staged opening is in progress, the control script MUST NOT interrupt valves that are already mid-opening (i.e., currently within their 20-second window), but it MUST recompute the pending-open queue based on the new target before starting the next batch.
- **FR-013**: Commanding a valve to its current state (open→open or closed→closed) MUST be a no-op: it consumes no concurrent-opening slot, does not reset the minimum-open timer, and does not trigger a deferred close.
- **FR-014**: The control script MUST surface the staged-valve state (currently opening, queued to open, pending close awaiting hold) through the existing state-broadcast / telemetry path so that operators and the playground UI can observe progress.
- **FR-015**: On device reboot, the control script MUST treat any valve observed to already be in the open state as having satisfied its minimum-open hold (so that recovery to IDLE is not blocked), while newly opened valves after boot MUST track their open timestamps normally.
- **FR-016**: The concurrent-open limit (2), the opening-window duration (20 s), and the minimum-open hold (60 s) MUST be defined as named constants (or device-config values) so they can be adjusted without hunting through the code.
- **FR-017**: The control script MUST NOT issue a close command to a valve while the same valve is inside its 20-second opening window, regardless of whether the minimum-open hold has been reached.
- **FR-018**: All new timing and queueing logic MUST work within the existing Shelly ES5 constraints (no `const`/`let`, no arrow functions, no classes, etc.).

### Key Entities

- **Concurrent-opening slot**: A logical slot representing one in-flight "closed → open" actuation. The system has exactly two slots. A slot is occupied from the moment the valve is commanded open until its 20-second opening window ends.
- **Open-since timestamp**: The time at which a given valve most recently completed the transition into the open state (or, at boot, the time at which the valve was first observed to be open). Used to evaluate the 60-second minimum-open hold when a close is requested.
- **Pending-open queue**: The ordered list of valves that need to be opened to reach the current target state but have not yet been able to start because both concurrent-opening slots are occupied.
- **Deferred close**: A valve that the control logic has determined must be closed, but whose open-since timestamp is less than 60 seconds old, so its close command is held until the hold elapses.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every mode transition the system reaches the correct final valve configuration 100% of the time, even when three or more valves must be opened.
- **SC-002**: During any transition, the operator can verify (via telemetry, logs, or direct measurement) that at no point are more than two valves simultaneously in their "closed → open" phase.
- **SC-003**: Every close command is issued no earlier than 60 seconds after the corresponding valve most recently became open, measured across 100% of close events.
- **SC-004**: A transition that needs to open four previously-closed valves completes within approximately 45 seconds of wall-clock time (two 20-second batches plus scheduling overhead).
- **SC-005**: A freeze-drain or overheat-drain safety override reaches the target ACTIVE_DRAIN valve configuration in the minimum time physically allowed by the PSU concurrency limit and the capacitor hold — no other throttles add delay.
- **SC-006**: A valve that fails to confirm open within its 20-second window does not block the pending-open queue for longer than that single window.
- **SC-007**: The 24V power supply never observes more than two valves simultaneously drawing opening current, as verified by the telemetry-visible concurrency counter.
- **SC-008**: All existing automated tests for the control logic continue to pass, plus new tests cover the staged-opening, deferred-close, and safety-override interactions.

## Assumptions

- The 20-second "opening" duration is treated as a time-based estimate. The control script does not need to read actual valve end-stop feedback to know when a valve has finished opening; the time window is the authoritative signal for "slot can be released." If real feedback becomes available later, the same slot-release logic can be driven by it.
- The 60-second minimum-open hold is an approximation of the capacitor-charging time. If the physical value is different, it is adjusted via the named constant (FR-016), not by restructuring the logic.
- The existing device-config flags (`ce`, `ea`, etc. — controls-enabled, enabled-actuators bitmask) continue to gate valve actuation. This feature only adds timing constraints on top of those existing gates.
- Valve state tracking occurs inside the Shelly control script's in-memory state. Persistence across reboots is explicitly not required for the open-since timestamp (see FR-015 for the reboot recovery rule).
- The user's reference to "the Shelly control script" means both the decision-logic module (`shelly/control-logic.js`) and the device shell (`shelly/control.js`). Timing bookkeeping that depends on real clocks naturally lives in the shell; the pure logic may expose a "desired valves" target that the shell realizes subject to the hardware constraints.
- The existing 30-second control-loop polling interval is fast enough to drive the staged-open state machine. No new high-frequency timer is required purely for this feature; the in-progress batch can be driven by short internal timers scoped to the transition itself.
- Manual override mode (feature 022) relay commands are subject to the same hardware-protection rules, but the UI-level design for communicating deferrals in the override view is out of scope for this feature.
