# Feature Specification: Fix Padding and Status Display Inconsistencies

**Feature Branch**: `015-fix-padding-status-display`
**Created**: 2026-03-31
**Status**: Draft
**Input**: User description: "Fix the padding on this page. at least the control descriptions and the bottom left live / simulation switch are not padded properly. Also the system status in Live mode shows misleading info when there's no connection to the Shelly device. There are probably more inconsistencies and padding problems on other views as well. Check the design system docs about how these should be implemented the design system docs should be in /design/Stitch"

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

### User Story 3 - Accurate System Status in Live Mode Without Connection (Priority: P1)

A user switches to Live mode but has no active connection to the Shelly device. Instead of seeing misleading sensor values (such as a temperature reading and "STABLE" status), the System Status panel clearly communicates that no live data is available. The user is never misled into thinking displayed values reflect the actual system state.

**Why this priority**: Showing default or stale data when there is no device connection is misleading and could cause the user to make incorrect decisions about the heating system. This is a data integrity and trust issue.

**Independent Test**: Enable Live mode without a Shelly device connection and verify the System Status panel shows a clear "no connection" state instead of simulated or default values.

**Acceptance Scenarios**:

1. **Given** the user has switched to Live mode, **When** no WebSocket connection to the server is established, **Then** the System Status panel displays a "no data available" state instead of numeric sensor values.
2. **Given** the user is in Live mode with an active connection, **When** the connection drops and 60 seconds elapse without new data, **Then** the System Status transitions to show the connection loss state.
3. **Given** the user is in Live mode without connection, **When** the system status is in "no data" state, **Then** the mode indicator, temperature gauge, energy stored, and greenhouse temperature all show placeholder/unavailable indicators rather than zero or default values.
4. **Given** the user is in Live mode without connection, **When** they look at Critical Components, **Then** component states (pump, fan, heater) show "Unknown" rather than "OFF".
5. **Given** the user switches from Live mode back to Simulation mode, **When** the simulation activates, **Then** sensor values immediately revert to simulated values with no lingering "no data" state.

---

### User Story 4 - Consistent Spacing on Components and Schematic Views (Priority: P2)

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
- What happens if the user has never been in Simulation mode and goes directly to Live mode without connection? The status panel should show "no data" from the start, not leftover simulation values.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: All card elements MUST use consistent internal padding following the Stitch design system spacing scale (8/12/16/24/32px), with cards using 24px (1.5rem) internal padding.
- **FR-002**: The Live/Simulation toggle MUST have horizontal padding matching other sidebar navigation elements (24px horizontal padding).
- **FR-003**: The connection status indicator MUST have horizontal padding matching the toggle and sidebar navigation elements.
- **FR-004**: The System Status panel MUST display a clear "no data" state when in Live mode without an active data connection, instead of showing default or zero values.
- **FR-005**: Critical Components MUST show "Unknown" state for actuators when no live data is available, rather than "OFF".
- **FR-006**: Device configuration rows MUST use design system spacing tokens for vertical padding (12px or 16px).
- **FR-007**: Control descriptions MUST have proper spacing from card edges following the 24px internal card padding rule.
- **FR-008**: The valve grid on the Components view MUST use a minimum 12px gap between items per the Stitch spacing scale.
- **FR-009**: All structural boundaries MUST be created through tonal layering (color temperature shifts), not 1px border lines, per the Stitch "No-Line" rule.
- **FR-010**: When transitioning from Live mode back to Simulation mode, sensor values MUST immediately display simulated values.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All five views (Status, Components, Schematic, Controls, Device) use spacing values exclusively from the Stitch design system token scale (8/12/16/24/32px) — zero arbitrary pixel values found in a spacing audit.
- **SC-002**: The Live/Simulation toggle label and switch are 100% visible on both desktop (sidebar) and mobile layouts with no clipping.
- **SC-003**: In Live mode without connection, zero numeric sensor values are shown in the System Status panel — all fields display a clear "unavailable" indicator.
- **SC-004**: Users can distinguish between "system is idle with all actuators off" and "no connection to system" within 5 seconds of viewing the Status page.
- **SC-005**: Structural borders used for layout containment (not data lines) number zero across all views, per the Stitch "No-Line" rule.

## Assumptions

- The Stitch design system spacing scale (8/12/16/24/32px) as documented in `design/Stitch/desktop/DESIGN.md` is the authoritative reference for all spacing decisions.
- The existing 60-second staleness timeout is appropriate and does not need adjustment.
- The "no data" state applies to the System Status panel, Critical Components, and mode indicator — the chart/history area can show "no data" with its existing empty state.
- Mobile responsive breakpoint remains at 768px.
- The fix applies to the playground web app only (HTML, CSS, client-side JS), not to the Shelly device scripts or server-side code.
- Cards use 1.5rem (24px) corner radius per the Stitch design system.
