# Implementation Plan: Fix Padding and Status Display Inconsistencies

**Branch**: `015-fix-padding-status-display` | **Date**: 2026-03-31 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/015-fix-padding-status-display/spec.md`

## Summary

Fix CSS spacing inconsistencies across all five playground views to conform with the Stitch "Digital Sanctuary" design system (8/12/16/24/32px token scale, 24px card padding, no structural borders). Add connection-aware glassmorphic overlays to the Status view with three distinct states (never connected, disconnected, stale). Disable "Save & Push" on the Device view when the device is unreachable, with a "try anyway" override. Fix the Live/Simulation toggle and connection status clipping in the sidebar. Cover new features with fast e2e tests.

## Technical Context

**Language/Version**: JavaScript ES6+ (browser modules), CSS3
**Primary Dependencies**: Playwright 1.56.0 (e2e tests), `npx serve` (static server for tests)
**Storage**: N/A (client-side only)
**Testing**: Playwright e2e (`npm run test:e2e`), 5s test timeout, 4 parallel workers
**Target Platform**: Modern browsers (desktop + mobile)
**Project Type**: Single-page web application (playground)
**Performance Goals**: E2e test suite completes in under 30 seconds total
**Constraints**: No new dependencies (all CSS/JS changes within existing files), vendored dependencies only
**Scale/Scope**: 3 files modified (index.html, style.css, data-source.js), 1 new e2e test file

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as SoT | N/A | No hardware changes |
| II. Pure Logic / IO Separation | N/A | No control logic changes |
| III. Safe by Default | PASS | No actuation changes; disabled button is safe-by-default for device push |
| IV. Proportional Test Coverage | PASS | E2e tests added for overlay states, toggle padding, device push disabled state |
| V. Token-Based Cloud Auth | N/A | No cloud auth changes |
| VI. Durable Data Persistence | N/A | No data persistence changes |
| VII. No Secrets in Cloud-Init | N/A | No infrastructure changes |

## Project Structure

### Documentation (this feature)

```text
specs/015-fix-padding-status-display/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 research
├── data-model.md        # Phase 1 data model (connection states)
└── quickstart.md        # Phase 1 quickstart
```

### Source Code (repository root)

```text
playground/
├── index.html           # MODIFY: overlay HTML, save button disabled state, toggle structure
├── css/style.css        # MODIFY: spacing fixes, overlay styles, toggle padding, border removal
└── js/data-source.js    # MODIFY: expose hasReceivedData flag for "never connected" state

tests/e2e/
└── connection-status.spec.js  # NEW: e2e tests for overlays, toggle visibility, device push
```

**Structure Decision**: All changes are within the existing `playground/` and `tests/e2e/` directories. No new directories or modules needed.

## Implementation Details

### 1. CSS Spacing Fixes (style.css)

**Specific violations to fix:**

| Selector | Current | Target | Token |
|----------|---------|--------|-------|
| `.mode-toggle` | `padding: 8px 0` | `padding: 8px 24px` | 24px horizontal (matches nav items) |
| `.connection-status` | `padding: 4px 0` | `padding: 4px 24px` | 24px horizontal (matches nav items) |
| `.controls-indicator` | `padding: 2px 0` | `padding: 2px 24px` | 24px horizontal (matches nav items) |
| `.device-config-row` | `padding: 10px 0` | `padding: 12px 0` | 12px vertical (Stitch scale) |
| `.device-config-row` | `border-bottom: 1px solid var(--outline-variant)` | Remove, use spacing gap | No-Line rule |
| `.valve-chip` grid gap | `8px` (if present) | `12px` | Stitch minimum gap |
| `.sidebar-nav` gap | `2px` | `2px` (keep — intentional tight nav) | Exception: nav items |

**Border violations to address:**
- Line 678: `border-bottom: 1px solid rgba(255,255,255,0.03)` — assess if structural (remove) or data (keep)
- Line 1132: `.device-config-row border-bottom` — structural → replace with margin gap
- Lines 1087, 1148, 1178: Toggle/form borders — functional input boundaries → keep (form element borders are acceptable)
- Line 613: Ghost border on card — keep if ≤15% opacity per Stitch spec

### 2. Connection-Aware Overlays (index.html + style.css)

**Three connection states tracked in JS:**

```
State: "never_connected" → "connected" → "disconnected" | "stale"
                                      ↑                    ↓
                                      └────────────────────┘ (data arrives)
```

**HTML: Add overlay elements inside each Status view card group:**
- Overlay on `.bento-span-2` (mode card area)
- Overlay on System Status card (gauge area)
- Overlay on Critical Components section

**CSS overlay recipe (Stitch glassmorphism):**
```css
.connection-overlay {
  position: absolute;
  inset: 0;
  background: rgba(17, 19, 25, 0.6);  /* surface-container-low at 60% */
  backdrop-filter: blur(20px);
  border-radius: 1.5rem;  /* match card radius */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 10;
}
```

**Editorial messages:**

| State | Editorial Primary | Direct Subtitle |
|-------|------------------|-----------------|
| never_connected | *"Your sanctuary is sleeping."* | No connection to the controller has been established. |
| disconnected | *"Lost touch with your sanctuary."* | Connection to the controller was lost. |
| stale | *"Your sanctuary has gone quiet."* | No data received for over 60 seconds. |

### 3. Device Config Push Disabled State (index.html)

**Current behavior**: `#dc-save` button always enabled.

**New behavior**:
- Track `connectionStatus` in the device config save handler
- When disconnected: add `.disabled` class, show explanation text, show "try anyway" link
- When connected: remove `.disabled` class, hide explanation
- "try anyway" click: call the existing save handler bypassing the connection check

### 4. Data Source Enhancement (data-source.js)

**Add `hasReceivedData` flag to distinguish "never connected" from "disconnected":**
- `LiveSource`: set `hasReceivedData = false` in constructor, flip to `true` on first `_handleState` call
- Reset to `false` on `stop()` (switching away from live mode)
- Expose as public property for the UI to read

### 5. E2E Tests (tests/e2e/connection-status.spec.js)

**Test strategy**: Fast tests (5s timeout), mock WebSocket via page.route, verify DOM state.

**Test cases:**

1. **Toggle visibility and padding**: Verify `#mode-toggle` is visible with full text, no overflow/clipping
2. **Never-connected overlay**: Navigate to live mode (default on localhost), verify overlay appears on Status view cards
3. **Overlay removal on simulation switch**: Switch to simulation, verify overlays are removed
4. **Device save button disabled**: Navigate to Device view in live mode, verify save button has disabled styling and explanation
5. **Device save "try anyway" link**: Verify "try anyway" link is present and clickable

**Performance budget**: 5 tests × ≤3s each = ≤15s total. No simulation warmup needed (these test static UI states, not thermal calculations).

**Test patterns to follow:**
- Import from `./fixtures.js` (not `@playwright/test`)
- Block Google Fonts (done by fixture)
- Mock API routes (`/api/device-config`, `/api/history`)
- Use `page.goto('/playground/')` for live mode (localhost is live-capable)
- Use `waitForFunction` with DOM checks, not arbitrary timeouts

## Complexity Tracking

No constitution violations to justify.
