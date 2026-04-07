# Quickstart: Manual Relay Toggle UI

**Feature**: 022-relay-toggle-ui

## Prerequisites

- Node.js 20 LTS
- Existing dev environment (`npm install` completed)
- Familiarity with: Shelly ES5 scripting, MQTT topics, WebSocket, playground SPA

## Key Files to Modify

### Shelly Device Scripts (ES5 only)
- `shelly/control.js` — Add relay command event handler, manual override guard in control loop
- `shelly/telemetry.js` — Subscribe to `greenhouse/relay-command` topic, forward events
- `shelly/control-logic.js` — No changes needed (manual override bypasses evaluate())

### Server
- `server/server.js` — Add WebSocket message handler for incoming commands
- `server/lib/mqtt-bridge.js` — Add `publishRelayCommand()` function, subscribe to relay-command responses if needed
- `server/lib/device-config.js` — Extend config schema to support `mo` field, add override TTL management

### Playground UI
- `playground/index.html` — Add relay toggle board HTML in Device view, override entry/exit controls, TTL selector, countdown display
- `playground/js/data-source.js` — Add `sendCommand()` method to LiveSource class
- `playground/css/style.css` — Add soundboard grid styles, button states, shake animation

### Tests
- `tests/control-logic.test.js` — Add tests for manual override guard behavior
- `tests/device-config.test.js` — Add tests for `mo` field validation, TTL computation
- `tests/mqtt-bridge.test.js` — Add tests for relay command publishing
- `tests/e2e/device-config.spec.js` — Add e2e tests for toggle board UI, override enter/exit

## Development Flow

1. **Start with device config extension** — Add `mo` field support to `server/lib/device-config.js` and write unit tests
2. **Add WebSocket command handler** — Implement bidirectional messaging in `server/server.js`
3. **Add MQTT relay command topic** — Extend `mqtt-bridge.js` and `telemetry.js`
4. **Implement Shelly-side override** — Guard control loop and add relay command handler in `control.js`
5. **Build the UI** — Toggle board HTML/CSS, data-source send method, haptic feedback
6. **Add server-side TTL management** — Timer-based auto-expiry with config push
7. **E2E tests** — Playwright tests for the full override flow

## Running Tests

```bash
npm run test:unit     # Unit tests (fast, no browser)
npm run test:e2e      # Playwright e2e tests
npm test              # All tests
```

## Key Constraints

- Shelly scripts: ES5 only (no const/let, no arrow functions, no template literals)
- Shelly timers: 5 max — do NOT add a new recurring timer on the device
- Device config JSON must fit in 256 bytes (Shelly KVS limit)
- All dependencies vendored in `playground/vendor/` — no CDN URLs
- MQTT-only device communication — no direct HTTP RPC from server
