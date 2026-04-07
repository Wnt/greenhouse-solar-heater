# Research: Reactive State Core UI Rewrite

**Date**: 2026-04-07 | **Branch**: `021-reactive-state-ui`

## R1: Reactive Primitives — Proxy vs Manual Setter

**Decision**: Manual setter function (`store.set(key, value)`) rather than ES6 Proxy.

**Rationale**: Proxy-based reactivity has edge cases with nested objects and requires careful handling of array mutations, property deletions, and object identity comparison. For this application, the state shape is flat (no deeply nested reactive objects) — all values are primitives, arrays of objects, or shallow objects. A manual `set()` function is simpler, more predictable, and avoids Proxy traps that can silently break with certain mutation patterns (e.g., `Object.keys()`, `JSON.stringify()`, spread operator).

**Alternatives considered**:
- **ES6 Proxy**: Transparent reactivity (`state.x = y` triggers subscribers). Rejected because the transparency is also its weakness — mutations can happen in unexpected places and the Proxy overhead is unnecessary for flat state.
- **Signals (Preact/Solid pattern)**: Fine-grained reactive atoms. Rejected because it introduces a conceptual overhead (wrapping/unwrapping `.value`) disproportionate to the application's complexity.
- **EventTarget/CustomEvent**: Native browser event system. Rejected because it lacks the synchronous guarantee needed for immediate UI updates and requires string-based event names prone to typos.

## R2: Derived State — Getters vs Computed Cache

**Decision**: Plain getter functions evaluated on every access (no memoization).

**Rationale**: The derived values in this application are trivially cheap to compute — checking if an array element is null (`scanning`), filtering a list of view names (`availableViews`), comparing two strings (`updateAvailable`). Memoization would add complexity (tracking dependencies, invalidation) for no measurable performance gain. The most complex derivation (`connectionDisplay`) is 6 comparisons — nanoseconds to execute.

**Alternatives considered**:
- **Memoized computed values**: Cache result, recompute only when dependencies change. Rejected because it requires dependency tracking infrastructure that isn't justified for sub-microsecond computations.
- **Pre-computed on state change**: Store derived values as separate state keys, updated by subscriptions. Rejected because this is exactly the "duplicated state" anti-pattern the rewrite eliminates.

## R3: Batching Strategy

**Decision**: Explicit `store.update(partial)` method for multi-key updates. Single-key `store.set()` notifies immediately.

**Rationale**: The application has two multi-key update patterns: (1) scan results updating both `detectedSensors` and `sensorScanPending`, and (2) connection state updating `wsStatus` + `mqttStatus` + `hasReceivedData`. An explicit batch API (`update({key1: v1, key2: v2})`) collects changed keys and notifies once per key after all mutations are applied. This avoids intermediate render states (e.g., `sensorScanPending = false` notifying before `detectedSensors` is populated).

**Alternatives considered**:
- **Microtask batching**: Queue all notifications to the next microtask. Rejected because it introduces async timing that makes UI updates non-deterministic and harder to test.
- **Transaction/commit pattern**: Explicit `beginTransaction()`/`commit()`. Rejected as overengineered — the `update()` method achieves the same with less ceremony.

## R4: View Lifecycle — String HTML vs DOM Manipulation

**Decision**: Views use `innerHTML` assignment (string HTML) for full re-renders, consistent with the current `renderSensorsView()` approach. Event handlers are re-bound after each render.

**Rationale**: The current application already uses this pattern successfully. The sensors view rebuilds its entire HTML string on every render (including dropdowns, tables, buttons). Switching to fine-grained DOM manipulation would require a diffing mechanism that approaches framework complexity — contrary to the "no framework" constraint. The render frequency for app-state views (sensors, device config) is low (user actions, 30s refresh), so full innerHTML replacement is performant.

**Alternatives considered**:
- **Fine-grained DOM updates**: Update individual `textContent`/attributes. Better performance for high-frequency updates but requires maintaining element references and manual diffing logic. Rejected for app-state views; already used (and kept) for the simulation `updateDisplay()` path where it matters.
- **Template literals with tagged functions**: Create a `html` tagged template that diffs. Approaches lit-html territory and adds complexity. Rejected.
- **DocumentFragment**: Build DOM in memory, swap into container. Marginal performance gain over innerHTML for these view sizes (<100 elements). Not worth the code complexity.

## R5: Simulation Loop Integration

**Decision**: The 60fps simulation loop (`simLoop` + `updateDisplay`) stays entirely outside the reactive store. It continues writing directly to DOM elements for temperature values, gauge arcs, and canvas. The store handles only coarse-grained state that affects UI structure (which view, what mode, connection status).

**Rationale**: Routing 60fps temperature updates through a reactive store would mean 300+ subscriber notifications per second (5 temperatures * 60fps). This adds overhead with zero benefit — `updateDisplay()` already writes the correct values directly to the DOM on every frame. The boundary is clear: if it changes every frame, it goes through the direct-write path; if it changes on user/network events, it goes through the store.

**Alternatives considered**:
- **All state through store**: Unified model but unacceptable performance overhead. Rejected.
- **Throttled store updates**: Write to store at 1Hz, keep direct-write for display. Adds complexity without clear benefit — the store subscribers for temperature would be identical to `updateDisplay()`. Rejected.

## R6: Navigation State Resolution

**Decision**: Navigation is resolved in a single subscription chain: `phase` change → recompute `availableViews` → check if `currentView` is valid → redirect if not. The URL hash is the external trigger; `store.set('currentView', viewId)` is the internal canonical state.

**Rationale**: The current bug (view lost on refresh) happens because DOM visibility is checked before live mode activates. With the reactive store, the chain is: (1) `hashchange` event sets `store.set('currentView', hash)`, (2) the `phase` subscription fires when live mode activates, (3) the derived `availableViews` includes live-only views, (4) the navigation subscriber sees the current view is now valid and mounts it. No ordering dependency between initialization steps.

**Alternatives considered**:
- **Deferred navigation**: Wait until live mode is determined before processing the hash. Requires explicit sequencing, which is what we're trying to eliminate. Rejected.
- **URL hash as sole source of truth**: No `currentView` in store, always read from `location.hash`. Rejected because the hash can contain invalid values that need resolution against available views.

## R7: Migration Strategy

**Decision**: Incremental migration, one state slice at a time, each independently shippable.

**Rationale**: A big-bang rewrite of 1139 lines of inline script risks introducing regressions across all views simultaneously. Incremental migration allows each slice to be tested against the existing e2e suite before moving to the next. The store can coexist with legacy code — new subscribers and old imperative code can both function until a slice is fully migrated.

**Migration order** (each step leaves the app fully functional):
1. Store core (`store.js`, `app-state.js`) — no UI changes, just infrastructure
2. Navigation + phase (`actions/navigation.js`, `actions/connection.js`, `subscriptions.js`) — fixes the refresh bug structurally
3. Sensors view (`actions/sensors.js`, `views/sensors-view.js`) — extracts from inline + sensors.js
4. Device config view (`actions/device-config.js`, `views/device-view.js`) — extracts from inline
5. Connection state + overlays — migrates connectionStatus, staleness, overlays to store
6. Version check — migrates to store (smallest slice)
7. Inline script cleanup — remove migrated code, reduce to ~200 lines
