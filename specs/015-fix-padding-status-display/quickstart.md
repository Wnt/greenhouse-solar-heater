# Quickstart: Fix Padding and Status Display Inconsistencies

**Feature**: 015-fix-padding-status-display

## Files to Modify

1. **`playground/css/style.css`** — Spacing fixes, overlay styles, border removal
2. **`playground/index.html`** — Overlay HTML, JS connection state logic, device push disabled state
3. **`playground/js/data-source.js`** — Add `hasReceivedData` flag to LiveSource

## New Files

1. **`tests/e2e/connection-status.spec.js`** — E2e tests for overlays, toggle padding, device push

## Running Tests

```bash
# All tests (unit + e2e)
npm test

# E2e tests only
npm run test:e2e

# Unit tests only (fast, no browser)
npm run test:unit
```

## Local Development

```bash
# Start the playground locally (same as e2e test server)
cp system.yaml playground/ && mkdir -p playground/shelly && cp shelly/control-logic.js playground/shelly/ && npx serve -l 3210 --no-clipboard

# Open in browser
open http://localhost:3210/playground/
```

On localhost, the app defaults to live mode with the mode toggle visible. Since there's no WebSocket server, this shows the "never connected" overlay state — useful for development.

## Key Implementation Notes

- The 5s test timeout is strict. Tests must verify DOM state without simulation warmup.
- The static `npx serve` has no WebSocket, so live mode on localhost naturally shows the "never connected" state.
- Overlay messages use Newsreader (serif) for editorial primary and Manrope (sans-serif) for the direct subtitle.
- Device push disabled state uses the existing `connectionStatus` variable — no new event system needed.
- All spacing values must be from the Stitch token scale: 8, 12, 16, 24, or 32px. No other values.
