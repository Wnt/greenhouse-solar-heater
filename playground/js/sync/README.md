# Frontend data-sync framework

Small registry + coordinator that handles the "browser was paused, now we're back" problem so individual feature modules don't each have to.

## When to use

Any time a feature has its own server-side data source (an HTTP endpoint, a WebSocket frame, etc.) whose data ends up in the UI. Without registering, the feature won't refresh on:

- Android backgrounding / Chrome timer suspension (the WebSocket may stay open but deliver no data, so the cached state on screen drifts from reality);
- Network drops + recovery;
- The user switching back to the tab.

## How to plug in

Three steps, mirroring the registry shape (`registry.js`):

### 1. Server: add the endpoint or WS message

Whatever your feature needs. No coordinator changes here — the coordinator only cares about how the client refreshes.

### 2. Client fetch: register a data source

In your feature's init path:

```js
import { registerDataSource } from '../sync/registry.js';
import { store } from '../app-state.js';

registerDataSource({
  id: 'my-feature',                     // unique
  isActive: () => store.get('phase') === 'live',
  fetch: (signal) => fetch('/api/my-feature', { signal }).then(r => r.json()),
  applyToStore: (data) => {
    // Atomic write into your module-local state or the central store.
    // Idempotent — applyToStore may be called many times over an app's
    // lifetime, once per resync the source is active for.
    myModuleState = data;
    rerender();
  },
});
```

`fetch(signal)` MUST honour the AbortSignal: when a second resync starts before the first finishes (e.g. the user resumes, then immediately the network reconnects), the coordinator aborts the first. If your fetch ignores the signal, `applyToStore` for the stale fetch will be skipped (the coordinator drops it), but the network request continues — which is wasteful and can cause out-of-order data writes if you're not careful.

### 3. Display: subscribe to your store keys

Your DOM components subscribe to whichever store keys (or module-local re-render hook) `applyToStore` writes into. Components do NOT touch `visibilitychange` / `online` / WebSocket lifecycle themselves — that's the coordinator's job.

## Lifecycle

The coordinator listens for `visibilitychange` (visible), `pageshow` (bfcache restore), and `online`. On any of those:

1. Aborts any in-flight resync.
2. Sets `store.syncing = true`. Components that want a "syncing…" affordance can subscribe to this key.
3. Calls `onResyncStart(reason)` (set up once at app boot in `connection.js`). Used to reset stale-frame flags.
4. Runs every active source's `fetch(signal)` in parallel.
5. For each that resolves un-aborted, calls `applyToStore(data)`.
6. Sets `store.syncing = false` and calls `onResyncComplete(reason)`.

## What NOT to put here

- WebSocket message replay. We deliberately don't do server-side "send everything since seq N" — re-fetching from `/api/history` (or your endpoint) on resume is sufficient because `sensor_readings_30s` is the source of truth for graphed data anyway. Adding replay would buy us second-resolution accuracy across the gap, at the cost of protocol complexity. Talk to a maintainer before introducing it.
- Per-component fetch retry policies. The coordinator runs sources once per resume; if a source fails the user sees the previous data until the next resume. Don't add a hidden retry loop — it tends to mask real outages.

## Tests

- `tests/frontend/sync-registry.spec.js` — contract test. Future contributors who change the API need to keep this green. It exercises:
  - `registerDataSource` rejecting malformed specs and duplicate ids
  - `isActive()` being honoured
  - `fetch(signal)` getting an AbortSignal that aborts on overlap
  - `applyToStore` running exactly once per resolved fetch (and not at all if aborted)
  - the `syncing` store flag toggling around the resync window
  - one source failing not blocking the others
- `tests/frontend/visibility-resync.spec.js` — behaviour test for the Android resume case.
