# Quickstart: Reactive State Core UI Rewrite

**Branch**: `021-reactive-state-ui`

## Development Setup

```bash
# Install dependencies (for tests)
npm install
cd shelly/lint && npm install && cd ../..

# Run unit tests (fast, no browser)
npm run test:unit

# Run e2e tests (requires Chromium)
npm run test:e2e

# Run all tests
npm test
```

## Architecture Overview

```
URL hash ──→ actions/navigation.js ──→ store.set('currentView') ──→ subscriptions.js ──→ DOM
                                                                       ↗
LiveSource ──→ store.update({wsStatus, mqttStatus, ...}) ─────────────╯
                                                                       
User click ──→ actions/sensors.js ──→ store.update({detectedSensors}) ─→ views/sensors-view.js ──→ DOM
```

**Data flow**: Event → Action → Store → Subscriber → DOM. Never the reverse.

## Key Files

| File | Purpose |
|------|---------|
| `playground/js/store.js` | Reactive store (~50 lines). `createStore()`, `get`, `set`, `update`, `subscribe` |
| `playground/js/app-state.js` | Store instance with initial shape + derived getters |
| `playground/js/subscriptions.js` | Global store→DOM wiring (nav visibility, overlays, indicators) |
| `playground/js/actions/*.js` | Async side-effect functions that write to the store |
| `playground/js/views/*.js` | View components with mount/unmount lifecycle |

## Working with the Store

### Reading state
```js
import { store } from './app-state.js';
const view = store.get('currentView');
```

### Writing state
```js
store.set('running', true);
store.update({ wsStatus: 'connected', hasReceivedData: false });
```

### Subscribing
```js
const unsub = store.subscribe('currentView', (view, state) => {
  // Update DOM based on new view
});
// Later: unsub() to clean up
```

### Derived values
```js
import { derived } from './app-state.js';
if (derived.scanning) { /* show spinner */ }
const views = derived.availableViews;
```

## Testing

All existing tests must continue to pass. The reactive store gets its own unit tests:

```bash
# Run store unit tests
node --test tests/store.test.js

# Run full unit suite
npm run test:unit

# Run e2e tests (validates UI behavior end-to-end)
npm run test:e2e
```

## Migration Order

Each step is independently shippable and testable:

1. **Store core** — `store.js` + `app-state.js` (infrastructure, no UI changes)
2. **Navigation + phase** — `actions/navigation.js`, `actions/connection.js`, `subscriptions.js`
3. **Sensors view** — `actions/sensors.js`, `views/sensors-view.js`
4. **Device config view** — `actions/device-config.js`, `views/device-view.js`
5. **Connection state** — migrate overlays, indicators, staleness
6. **Version check** — migrate to store
7. **Inline cleanup** — remove migrated code from index.html
