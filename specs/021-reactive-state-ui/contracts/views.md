# Contract: View Components

**Location**: `playground/js/views/`

## Lifecycle Interface

Every view component exports a `mount` function that returns an `unmount` function.

### `mount(container, store) → unmount`

Called when the user navigates to this view.

**Parameters**:
- `container: HTMLElement` — the DOM container to render into (e.g., `#sensors-content`)
- `store: Store` — the reactive state store instance

**Responsibilities**:
1. Subscribe to relevant store keys
2. Perform initial render (reads current store state)
3. Kick off any async initialization (e.g., sensor scan)
4. Return the `unmount` function

**Returns**: `() → void` — the unmount function.

### `unmount()`

Called when the user navigates away from this view.

**Responsibilities**:
1. Remove all store subscriptions (call every `unsubscribe` function)
2. Clear any timers (intervals, timeouts)
3. Optionally clear the container's innerHTML

## Render Pattern

Views use `container.innerHTML = buildHTML(storeState)` for full re-renders. After setting innerHTML, event handlers are bound to the new DOM elements.

```
subscribe → state change → render() → innerHTML = html → bindHandlers()
```

The render function:
1. Reads current state from the store (via `store.get()` or derived getters)
2. Builds an HTML string
3. Assigns to `container.innerHTML`
4. Queries the new DOM and attaches event listeners

## Guard Against Unmounted Renders

Views must track a `mounted` flag to prevent renders after unmount (async operations like fetch may complete after navigation away).

```
let mounted = true;
// in render(): if (!mounted) return;
// in unmount(): mounted = false;
```

## Views in Scope

| View | Module | Store Keys | Async Init |
|------|--------|------------|------------|
| Sensors | `views/sensors-view.js` | `sensorConfig`, `detectedSensors`, `sensorScanPending` | Yes (scan on mount) |
| Device | `views/device-view.js` | `deviceConfig` | Yes (fetch config on mount) |

## Views NOT Extracted

Status, Components, Schematic, and Controls views remain in the inline script. They are rendered by `updateDisplay()` on every simulation frame or live data update. Extracting them would require either splitting `updateDisplay()` across modules (fragile) or routing 60fps data through the store (violates the performance boundary). These views may be extracted in a future phase once the store is proven.
