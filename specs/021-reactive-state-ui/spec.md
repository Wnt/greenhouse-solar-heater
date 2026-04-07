# Feature Specification: Reactive State Core UI Rewrite

**Feature Branch**: `021-reactive-state-ui`  
**Created**: 2026-04-07  
**Status**: Draft  
**Input**: User description: "rewrite the UI using the Reactive State Core + Derived Views architecture we outlined"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dashboard Remains Consistent Across Mode Switches (Priority: P1)

An operator opens the monitoring dashboard on their phone, bookmarks the Sensors view, and later refreshes the page. The application restores the correct view without flashing a wrong screen or falling back to a default. Switching between live and simulation modes updates the available navigation items and redirects the operator if they are on a view that is no longer available, without manual intervention.

**Why this priority**: View consistency and correct navigation are the most visible user-facing behaviors. The current system fails here — a page refresh on a live-only view loses the user's place. This is the core usability problem that motivated the rewrite.

**Independent Test**: Can be fully tested by bookmarking each view, refreshing the browser, switching modes, and verifying the correct view is displayed every time.

**Acceptance Scenarios**:

1. **Given** the operator is on the Sensors view in live mode, **When** they refresh the page, **Then** the application loads directly into the Sensors view without briefly showing the Status view.
2. **Given** the operator is on the Sensors view in live mode, **When** they switch to simulation mode, **Then** the application redirects them to Status (or another available view) and hides Sensors/Device from the navigation.
3. **Given** the operator is on the Controls view in simulation mode, **When** they switch to live mode, **Then** Controls is hidden and the operator is redirected to an available view.
4. **Given** the operator navigates to a URL with an invalid hash fragment, **When** the page loads, **Then** the application falls back to the Status view.

---

### User Story 2 - Sensor Scanning Shows Immediate Feedback (Priority: P1)

An operator opens the Sensors tab for the first time. They immediately see a visual indication that sensor discovery is in progress — a loading state on the scan button and "Scanning..." placeholders for each sensor hub. When scanning completes, the detected sensor list appears with current temperature readings. Pressing the Scan button again shows the same loading state while a new scan runs.

**Why this priority**: The sensor scanning workflow is the second core problem area. The current system fails to show loading state on initial page load, confusing operators into thinking the system is broken.

**Independent Test**: Can be tested by navigating to the Sensors view and observing that loading indicators appear before any scan results, and that the Scan button shows activity during every scan — including the automatic initial scan.

**Acceptance Scenarios**:

1. **Given** the operator opens the Sensors view for the first time, **When** the view loads, **Then** a scanning indicator is immediately visible before any scan results arrive.
2. **Given** a sensor scan is in progress, **When** the operator looks at the Scan button, **Then** the button shows a visual activity indicator and is not clickable.
3. **Given** a sensor scan completes, **When** results are displayed, **Then** each detected sensor's current temperature reading is shown alongside its address.
4. **Given** a sensor scan fails, **When** results are displayed, **Then** an error message appears for the affected hub and the scan button returns to its normal state.

---

### User Story 3 - Connection Status Reflects Reality Without Delay (Priority: P2)

An operator is viewing the live dashboard. The connection to the server drops. Within seconds, the dashboard shows a reconnecting indicator. When connection is restored and data flows again, the indicator updates to show active status. If data stops arriving despite a connected WebSocket, the dashboard shows a stale data warning after a reasonable timeout.

**Why this priority**: Connection state is important for operator trust but is a less common interaction than navigation and sensor scanning. The current system handles most connection states but derives them through complex conditional logic that is fragile to extend.

**Independent Test**: Can be tested by simulating WebSocket disconnects, MQTT broker outages, and data cessation, then verifying the correct status indicator appears in each scenario.

**Acceptance Scenarios**:

1. **Given** the WebSocket connection drops, **When** the operator views the dashboard, **Then** the connection indicator shows "Reconnecting" within 5 seconds.
2. **Given** the WebSocket is connected but no MQTT data arrives for 60 seconds, **When** the operator views the dashboard, **Then** a staleness warning banner appears.
3. **Given** the WebSocket reconnects and MQTT data resumes, **When** the operator views the dashboard, **Then** the connection indicator returns to "Active" and the staleness banner disappears.
4. **Given** the WebSocket is connected but the MQTT broker is disconnected, **When** the operator views the dashboard, **Then** the indicator shows "Device Offline" rather than "Active."

---

### User Story 4 - Simulation Performance Stays Smooth (Priority: P2)

An operator runs the 24-hour thermal simulation. The physics animation remains smooth at the same frame rate as the current system. Slider adjustments (outdoor temperature, irradiance, simulation speed) take effect immediately without perceptible lag. The graph draws and updates without jank.

**Why this priority**: The simulation is the most performance-sensitive part of the application. The rewrite must not regress animation smoothness or input responsiveness.

**Independent Test**: Can be tested by running the simulation for a full 24-hour cycle, adjusting sliders during playback, and measuring frame rate and input latency against the current system.

**Acceptance Scenarios**:

1. **Given** the simulation is running, **When** the operator adjusts the outdoor temperature slider, **Then** the simulation reflects the change within one animation frame.
2. **Given** the simulation is running at normal speed, **When** the operator observes the animation, **Then** the frame rate is equivalent to the pre-rewrite baseline.
3. **Given** the simulation has accumulated 24 hours of data, **When** the operator views the graph, **Then** panning and drawing remain responsive without visible stutter.

---

### User Story 5 - Device Configuration Round-Trips Correctly (Priority: P3)

An operator opens the Device configuration view, toggles several settings (controls enabled, forced mode, allowed modes), and saves. The saved values persist correctly, and on the next page load, the form accurately reflects the saved state. At no point does the form show stale data from a previous load.

**Why this priority**: Device configuration is a lower-frequency operation, but correctness is critical since misconfiguration can affect physical hardware.

**Independent Test**: Can be tested by saving a device configuration, refreshing the page, and verifying every field matches what was saved.

**Acceptance Scenarios**:

1. **Given** the operator changes device settings and saves, **When** they refresh the page, **Then** the form shows the exact values that were saved.
2. **Given** the server returns an error on save, **When** the operator sees the error, **Then** the form retains the operator's unsaved changes rather than reverting to the last-loaded state.
3. **Given** the operator opens the Device view, **When** the configuration is loading from the server, **Then** the form is not interactive until data has loaded (no stale defaults shown).

---

### User Story 6 - Version Update Notification Works Reliably (Priority: P3)

When the server-side application is updated, the operator sees a notification prompting them to reload. Dismissing the notification suppresses it until the next update. The notification does not appear when there is no update, and does not interfere with other views.

**Why this priority**: This is a low-frequency, low-complexity feature that already works. The rewrite should preserve existing behavior through the new state mechanism.

**Independent Test**: Can be tested by changing the server's JS hash and verifying the toast appears, then dismissing it and verifying it stays dismissed until the hash changes again.

**Acceptance Scenarios**:

1. **Given** the server hash changes after page load, **When** the version check polls, **Then** an update notification appears.
2. **Given** the operator dismisses the update notification, **When** the same hash is detected again on next poll, **Then** the notification remains dismissed.
3. **Given** the operator dismisses the notification and the hash changes again (a second update), **When** the version check polls, **Then** a new notification appears.

---

### Edge Cases

- What happens when the operator navigates via browser back/forward buttons between views that span a mode switch (e.g., bookmarked Controls in simulation, then switched to live)?
- How does the system handle rapid toggling between live and simulation modes while sensor scans or history fetches are in-flight?
- What happens when the server returns a sensor config with hosts that changed between scans (hosts added or removed)?
- How does the system behave when a WebSocket message arrives while the operator is on the Sensors view and a scan is in progress (concurrent state updates from two sources)?
- What happens if the operator opens the application in two browser tabs — does state isolation work correctly (no shared mutable globals)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST maintain a single authoritative state store for all application-level state (current view, connection status, mode, sensor data, device configuration, version check). No application-level truth may exist solely in DOM elements or disconnected variables.
- **FR-002**: The system MUST automatically update all affected UI elements when any state value changes, without requiring manual render calls at each mutation site.
- **FR-003**: The system MUST derive computed values (scanning status, available views, connection display state, missing sensor roles, update availability) from the canonical state rather than storing them as independent variables.
- **FR-004**: The system MUST resolve the active view from both the URL hash and the current application mode, correctly handling the case where a bookmarked view is not yet available at page load time (e.g., live-only views before live mode initializes).
- **FR-005**: The system MUST separate high-frequency simulation rendering (temperature values, gauge arcs, graph canvas at animation frame rate) from the reactive state mechanism to maintain animation performance.
- **FR-006**: The system MUST provide view lifecycle management (mount/unmount) so that views like Sensors can set up and tear down subscriptions and timers cleanly when entered or left.
- **FR-007**: The system MUST support batched state updates — multiple state values changed together MUST result in a single notification cycle, not one per value.
- **FR-008**: The system MUST preserve all existing user-facing features: simulation playback, live data display, sensor discovery and assignment, device configuration, schematic visualization, component status, and connection status indicators.
- **FR-009**: The system MUST work without any third-party frontend framework — only vanilla browser APIs and ES modules.
- **FR-010**: The system MUST clean up all subscriptions and timers when a view is unmounted, preventing memory leaks during long sessions.

### Key Entities

- **State Store**: The single source of truth for application-level state. Contains named keys with values that trigger subscriber notifications on change.
- **Derived State**: Computed properties that read from the state store and return fresh values on every access. Never stored independently, always calculated from the store.
- **View Component**: A self-contained unit responsible for a single tab/view. Manages its own DOM rendering, subscribes to relevant state slices on mount, and cleans up on unmount.
- **Action**: A function that performs async work (API calls, WebSocket operations) and writes results back to the state store. The only way external state changes occur.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of existing end-to-end tests pass without modification to test assertions (test infrastructure changes like selectors are acceptable).
- **SC-002**: Bookmarking any view and refreshing the browser restores the correct view on first paint, with zero fallback flashes to a different view.
- **SC-003**: Every operator-visible loading state (sensor scanning, config loading, connection status) appears within one render cycle of the triggering action — no state change occurs without immediate UI reflection.
- **SC-004**: Simulation animation frame rate remains within 5% of the pre-rewrite baseline when running a 24-hour simulation cycle.
- **SC-005**: No application-level state is read from or written to DOM elements — all state flows from the store to the DOM, never the reverse direction (except for form inputs being collected on explicit user save actions).
- **SC-006**: The number of distinct mutable state variables across all modules is reduced by at least 50% compared to the current architecture (from ~30 scattered variables to a single store with defined keys).
- **SC-007**: Adding a new derived UI indicator (e.g., a new status badge) requires only defining a derived getter and a subscriber — no changes to existing render call sites.

## Assumptions

- The existing Shelly control logic (`shelly/control-logic.js`) and server-side code (`server/`) are out of scope — only `playground/` files are affected.
- The existing test suite (unit + e2e) serves as the regression safety net. All current tests must pass after the rewrite.
- The Stitch design system (visual appearance, CSS, layout) is unchanged — this is a structural rewrite, not a visual redesign.
- The simulation physics engine (`ThermalModel`), control state machine (`ControlStateMachine`), and data source abstraction (`LiveSource`/`SimulationSource`) retain their current APIs. The rewrite changes how their outputs connect to the UI, not how they work internally.
- The inline script in `index.html` will be significantly reduced as logic moves into ES modules, but `index.html` remains the single entry point.
- Performance-critical paths (60fps simulation loop, canvas graph drawing) remain outside the reactive store and continue to write directly to DOM for rendering speed.
