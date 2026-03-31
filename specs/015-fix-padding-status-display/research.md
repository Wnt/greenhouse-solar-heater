# Research: Fix Padding and Status Display Inconsistencies

**Feature**: 015-fix-padding-status-display
**Date**: 2026-03-31

## R1: Stitch Design System Spacing Compliance

**Decision**: Use the Stitch design system spacing scale (8/12/16/24/32px) exclusively. Cards use 24px internal padding, 1.5rem corner radius.

**Rationale**: The Stitch desktop and mobile DESIGN.md documents define the spacing scale explicitly. Current violations include: mode toggle (0px horizontal padding), connection status (0px horizontal padding), device config rows (10px vertical padding — not on scale), controls indicator (0px horizontal padding).

**Alternatives considered**: Custom spacing values per component — rejected because the design system exists specifically to prevent inconsistency.

## R2: Structural Border Violations (No-Line Rule)

**Decision**: Remove `border-bottom` from `.device-config-row` (line 1132 of style.css) and replace with spacing gap. Keep borders on form inputs (toggle switches, dropdowns, checkboxes) as these are functional input boundaries, not structural containment. Keep the ghost border on the card at line 613 (≤8% opacity, within the 15% max).

**Rationale**: The Stitch "No-Line" rule explicitly states: "Do not use 1px solid borders to define sections. Boundaries are created through color temperature and tonal shifts." Device config rows use borders for structural separation, violating this rule. Form element borders serve a different purpose (affordance) and are acceptable.

**Alternatives considered**: Replace all borders including form elements — rejected because form inputs need visible boundaries for usability.

## R3: Connection State Detection Architecture

**Decision**: Track three states using a combination of WebSocket connection status and data freshness:
1. **never_connected**: `LiveSource.hasReceivedData === false` AND `connectionStatus !== 'connected'`
2. **disconnected**: `LiveSource.hasReceivedData === true` AND `connectionStatus === 'disconnected'`
3. **stale**: `connectionStatus === 'connected'` AND `Date.now() - lastDataTime > 60000` AND `lastDataTime > 0`

**Rationale**: The existing `connectionStatus` and `lastDataTime` variables already track most of this. Only the `hasReceivedData` flag is new — a simple boolean that flips on first data receipt. This minimal change avoids restructuring the data source.

**Alternatives considered**:
- Unified "unavailable" state — rejected per clarification (user wants three distinct states)
- State machine in data-source.js — rejected as over-engineering; the three conditions are simple boolean checks

## R4: Glassmorphic Overlay Implementation

**Decision**: Use `position: absolute` overlays inside each Status view card/section that has `position: relative`. The overlay uses `background: rgba(17, 19, 25, 0.6)` (surface-container-low at 60% opacity) with `backdrop-filter: blur(20px)`.

**Rationale**: This matches the Stitch "Glass & Gradient Rule" recipe exactly. Absolute positioning within the card preserves layout flow. The overlay is added/removed via a CSS class toggle, keeping JS minimal.

**Alternatives considered**:
- Full-view overlay covering all cards at once — rejected because individual card overlays respect the card grid layout and are more visually precise
- CSS `::after` pseudo-element — rejected because the overlay contains text content (editorial message + subtitle)

## R5: E2E Test Strategy

**Decision**: Create a single new test file `tests/e2e/connection-status.spec.js` with 5 focused tests. Tests verify DOM state (element visibility, text content, CSS classes) without running the thermal simulation. No WebSocket mocking needed — the tests verify the "never connected" state which is the default when the static server has no WebSocket endpoint.

**Rationale**: The static `npx serve` used in e2e tests has no WebSocket server, so live mode will naturally be in the "never connected" state. This is perfect for testing overlays without complex mocking. Tests stay fast (no simulation warmup, no network delays) within the 5s timeout.

**Alternatives considered**:
- WebSocket mocking to test all three states — deferred to avoid test complexity; "never connected" is the critical path. Disconnected and stale states share the same overlay mechanism and differ only in message text, testable via unit tests if needed.
- Adding tests to existing live-mode.spec.js — rejected to keep test files focused and independently runnable.

## R6: Device Push Disabled State

**Decision**: Disable the `#dc-save` button by adding a `.disabled` class and `disabled` attribute when `connectionStatus !== 'connected'`. Show an explanation `<p>` below the button. Add a "try anyway" `<a>` link that bypasses the check and calls the save handler directly.

**Rationale**: The disabled state prevents user frustration from silent push failures. The "try anyway" link respects power users per the clarification. The implementation is minimal — a few lines of JS in the existing connection change handler.

**Alternatives considered**:
- Toast notification on push failure instead of disabling — rejected because it's reactive rather than proactive
- Modal confirmation dialog — rejected as too heavy for this use case
