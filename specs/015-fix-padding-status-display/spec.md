# Feature Specification: Fix Padding and Status Display Inconsistencies

**Feature Branch**: `015-fix-padding-status-display`
**Created**: 2026-03-31
**Status**: Draft
**Input**: User description: "Fix the padding on this page. at least the control descriptions and the bottom left live / simulation switch are not padded properly. Also the system status in Live mode shows misleading info when there's no connection to the Shelly device. There are probably more inconsistencies and padding problems on other views as well. Check the design system docs about how these should be implemented the design system docs should be in /design/Stitch"

## Clarifications

### Session 2026-03-31

- Q: Which views should show a distinct "no data" mode in Live mode without connection? → A: Status view only. Additionally, Device config "Save & Push" should be disabled when the device is unreachable, with an explanation and an option to skip the health check.
- Q: How should unavailable data be visually presented? → A: Overlay a subtle frosted/glass banner on existing cards with a connection status message (Stitch glassmorphism style).
- Q: Should stale, disconnected, and never-connected be visually distinct states? → A: Three distinct states with individual messages: "Never connected" (no data ever received), "Disconnected" (connection lost), and "Stale" (connected but data stopped arriving).
- Q: What should the Device config skip mechanism look like? → A: Disabled "Save & Push" button with explanation text + small "try anyway" link below it to override.
- Q: Should overlay messages use editorial or technical tone? → A: Editorial primary message + direct subtitle (e.g., *"Your sanctuary is sleeping."* / "No connection to the controller has been established").

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Consistent Spacing Across All Views (Priority: P1)

A user navigates between the five views (Status, Components, Schematic, Controls, Device) and sees consistent, well-spaced content that follows the Stitch "Digital Sanctuary" design system. No elements are clipped, cramped, or visually misaligned. The spacing creates a calm, breathing layout with clear visual hierarchy through tonal layering rather than border lines.

**Why this priority**: Spacing inconsistencies are visible on every view and affect the perceived quality of the entire application. This is the most widespread issue and the primary user complaint.

**Independent Test**: Navigate through all five views on desktop and mobile and verify that spacing follows the Stitch design system tokens (8/12/16/24/32px scale) with 1.5rem (24px) internal card padding.

**Acceptance Scenarios**:

1. **Given** the user is on any view (Status, Components, Schematic, Controls, Device), **When** they view the content, **Then** all cards use consistent internal padding following the Stitch spacing scale (24px internal card padding).
2. **Given** the user is on the Device view, **When** they view the configuration rows (Controls Enabled, Enabled Actuators, Mode Override, Allowed Modes), **Then** each section has consistent vertical spacing using design system spacing tokens.
3. **Given** the user is on the Controls view, **When** they view control group descriptions, **Then** text has proper spacing from card edges and between label/value pairs.
4. **Given** the user is on any view on a mobile device (below 768px), **When** the responsive layout activates, **Then** spacing scales down proportionally while maintaining readability and the design system minimum spacing.

---

### User Story 2 - Properly Positioned Live/Simulation Toggle (Priority: P1)

A user sees the Live/Simulation toggle in the sidebar (desktop) or bottom area (mobile) with proper padding so that the label text and toggle switch are fully visible and not clipped by the sidebar or screen edges.

**Why this priority**: The toggle is a primary interaction element that is currently visually broken — the "Live" label appears clipped at the left edge of the screen, making it look unprofessional and harder to use.

**Independent Test**: Toggle between Live and Simulation modes and verify the full label and switch are visible with appropriate spacing from sidebar edges.

**Acceptance Scenarios**:

1. **Given** the user is on desktop with the sidebar visible, **When** they look at the Live/Simulation toggle at the bottom of the sidebar, **Then** the toggle label and switch are fully visible with horizontal padding matching other sidebar elements (24px).
2. **Given** the user is on a mobile device, **When** they look at the Live/Simulation toggle, **Then** the toggle is fully visible and properly spaced within the mobile layout.
3. **Given** the connection status indicator is displayed below the toggle, **When** the user views the sidebar bottom area, **Then** both the toggle and connection status have consistent left-aligned padding.

---

### User Story 3 - Connection-Aware Status View with Three Distinct States (Priority: P1)

A user switches to Live mode and the Status view accurately reflects the connection state. Three distinct states are communicated through frosted glassmorphic overlays on the Status view cards, each with an editorial primary message and a direct technical subtitle:

1. **Never connected**: No data has ever been received since entering Live mode. Editorial message (e.g., *"Your sanctuary is sleeping."*) with direct subtitle (e.g., "No connection to the controller has been established").
2. **Disconnected**: A previously active connection has been lost. Editorial message (e.g., *"Lost touch with your sanctuary."*) with direct subtitle (e.g., "Connection to the controller was lost").
3. **Stale**: Connected but no new data received for 60+ seconds. Editorial message (e.g., *"Your sanctuary has gone quiet."*) with direct subtitle (e.g., "No data received for over 60 seconds").

The overlays use Stitch glassmorphism (surface-container-low at 60% opacity with 20px backdrop blur) and are applied to individual cards/sections on the Status view.

**Why this priority**: Showing default or stale data when there is no device connection is misleading and could cause the user to make incorrect decisions about the heating system. This is a data integrity and trust issue.

**Independent Test**: Enable Live mode in each of the three connection states and verify the correct overlay appears on Status view cards.

**Acceptance Scenarios**:

1. **Given** the user has just switched to Live mode and no WebSocket connection has been established, **When** they view the Status page, **Then** a frosted overlay with the "never connected" editorial message and subtitle appears on the System Status, mode indicator, and Critical Components cards.
2. **Given** the user is in Live mode with an active connection, **When** the connection drops, **Then** the overlay transitions to the "disconnected" state message.
3. **Given** the user is in Live mode and connected, **When** no new data arrives for 60 seconds, **Then** the overlay transitions to the "stale" state message.
4. **Given** any overlay state is active, **When** a live data update arrives, **Then** the overlay is removed and current values are displayed immediately.
5. **Given** the user switches from Live mode back to Simulation mode, **When** the simulation activates, **Then** all overlays are removed and simulated values display immediately.

---

### User Story 4 - Device Config Push Disabled Without Connection (Priority: P1)

A user navigates to the Device view in Live mode without a connection to the Shelly device. The "Save & Push to Device" button is disabled with an explanation of why the push is unavailable. A small "try anyway" link allows the user to override the health check if they believe the connection will recover or want to attempt the push regardless.

**Why this priority**: Attempting to push config to an unreachable device is a silent failure that confuses users. Disabling with explanation prevents frustration while the override preserves power-user flexibility.

**Independent Test**: Navigate to Device view in Live mode without connection, verify button is disabled with explanation and "try anyway" link.

**Acceptance Scenarios**:

1. **Given** the user is on the Device view in Live mode, **When** there is no connection to the device, **Then** the "Save & Push to Device" button is visually disabled with an explanation message (e.g., "Cannot reach the controller").
2. **Given** the button is disabled due to no connection, **When** the user clicks the "try anyway" link, **Then** the push is attempted normally regardless of connection state.
3. **Given** the button is disabled due to no connection, **When** the connection is restored, **Then** the button re-enables automatically and the explanation message disappears.

---

### User Story 5 - Consistent Spacing on Components and Schematic Views (Priority: P2)

A user navigates to the Components and Schematic views and sees content with consistent spacing that matches the Status and Device views, following the Stitch design system.

**Why this priority**: Completes the cross-view consistency but is lower priority since these views are less frequently used for decision-making.

**Independent Test**: Navigate to Components and Schematic views and verify card padding, grid gaps, and internal spacing follow the same Stitch design system tokens as other views.

**Acceptance Scenarios**:

1. **Given** the user is on the Components view, **When** they view sensor tables and valve grids, **Then** the spacing between items uses design system tokens (minimum 12px gap between items).
2. **Given** the user is on the Schematic view, **When** they view the SVG diagram, **Then** the diagram container has appropriate padding from the view edges consistent with other views.

---

### Edge Cases

- What happens when the browser window is resized between desktop and mobile breakpoints? The toggle and spacing should transition smoothly without visual glitches.
- How does the system status behave when connection is intermittent (rapidly connecting/disconnecting)? The UI should not flicker between states — a brief debounce should prevent visual noise.
- What happens to the staleness banner positioning when the view has scrollable content? It should remain visible at the top of the view.
- What happens if the user has never been in Simulation mode and goes directly to Live mode without connection? The Status view should show the "never connected" overlay from the start, not leftover simulation values.
- What happens if the user clicks "try anyway" on Device config and the push fails? The existing error handling for push failures applies — no new behavior needed.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All card elements MUST use consistent internal padding following the Stitch design system spacing scale (8/12/16/24/32px), with cards using 24px (1.5rem) internal padding.
- **FR-002**: The Live/Simulation toggle MUST have horizontal padding matching other sidebar navigation elements (24px horizontal padding).
- **FR-003**: The connection status indicator MUST have horizontal padding matching the toggle and sidebar navigation elements.
- **FR-004**: The Status view MUST display three distinct connection-aware overlay states in Live mode: "never connected", "disconnected", and "stale data".
- **FR-005**: Each connection overlay MUST use Stitch glassmorphism (surface-container-low at 60% opacity, 20px backdrop blur) applied to individual Status view cards.
- **FR-006**: Each connection overlay MUST display an editorial primary message and a direct technical subtitle.
- **FR-007**: Connection overlays MUST be removed immediately when live data arrives or when switching to Simulation mode.
- **FR-008**: The Device view "Save & Push to Device" button MUST be disabled when no connection to the device is available, with an explanation message.
- **FR-009**: A "try anyway" link MUST be provided below the disabled "Save & Push" button to allow users to override the connection health check.
- **FR-010**: The "Save & Push" button MUST re-enable automatically when the connection is restored.
- **FR-011**: Device configuration rows MUST use design system spacing tokens for vertical padding (12px or 16px).
- **FR-012**: Control descriptions MUST have proper spacing from card edges following the 24px internal card padding rule.
- **FR-013**: The valve grid on the Components view MUST use a minimum 12px gap between items per the Stitch spacing scale.
- **FR-014**: All structural boundaries MUST be created through tonal layering (color temperature shifts), not 1px border lines, per the Stitch "No-Line" rule.
- **FR-015**: When transitioning from Live mode back to Simulation mode, sensor values MUST immediately display simulated values.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All five views (Status, Components, Schematic, Controls, Device) use spacing values exclusively from the Stitch design system token scale (8/12/16/24/32px) — zero arbitrary pixel values found in a spacing audit.
- **SC-002**: The Live/Simulation toggle label and switch are 100% visible on both desktop (sidebar) and mobile layouts with no clipping.
- **SC-003**: In Live mode without connection, the Status view displays the correct glassmorphic overlay for each of the three states (never connected, disconnected, stale) — zero bare numeric values visible under overlays.
- **SC-004**: Users can distinguish between "system is idle with all actuators off" and "no connection to system" within 5 seconds of viewing the Status page.
- **SC-005**: The Device view "Save & Push" button is disabled within 2 seconds of connection loss and re-enabled within 2 seconds of connection restoration.
- **SC-006**: Structural borders used for layout containment (not data lines) number zero across all views, per the Stitch "No-Line" rule.

## Assumptions

- The Stitch design system spacing scale (8/12/16/24/32px) as documented in `design/Stitch/desktop/DESIGN.md` is the authoritative reference for all spacing decisions.
- The existing 60-second staleness timeout is appropriate and does not need adjustment.
- The connection-aware overlays apply to the Status view only. Other views (Components, Schematic, Controls) do not show connection overlays.
- The Device view connection check only affects the "Save & Push" button, not the display of current config values (which are locally held).
- Mobile responsive breakpoint remains at 768px.
- The fix applies to the playground web app only (HTML, CSS, client-side JS), not to the Shelly device scripts or server-side code.
- Cards use 1.5rem (24px) corner radius per the Stitch design system.
- The editorial overlay messages are examples — final copy may be adjusted during implementation as long as the editorial + direct subtitle pattern is preserved.
