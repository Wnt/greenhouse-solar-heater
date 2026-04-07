# Contract: Actions

**Location**: `playground/js/actions/`

## Definition

An action is an async function that performs side effects (network requests, timer management) and writes results to the store. Actions are the only path through which external events modify state.

## Interface Pattern

```
export async function actionName(store, ...args) → void
```

**Parameters**:
- `store: Store` — the reactive state store (always first argument)
- `...args` — action-specific parameters

**Returns**: void (or a value for callers that need it, e.g., save results)

**Side effects**: Network requests, timer creation/destruction

**State mutations**: Via `store.set()` or `store.update()` only. Never mutate external variables.

## Actions by Module

### `actions/navigation.js`

| Action | Trigger | Store Writes |
|--------|---------|--------------|
| `initNavigation(store)` | App boot | Binds hashchange listener, sets initial `currentView` |
| `navigateTo(store, viewId)` | Hash change, phase change | `currentView` |

### `actions/connection.js`

| Action | Trigger | Store Writes |
|--------|---------|--------------|
| `switchToLive(store, liveSource)` | Mode toggle click, app boot (if live-capable) | `phase`, `running` |
| `switchToSimulation(store, liveSource)` | Mode toggle click | `phase` |
| `startStalenessCheck(store)` | After switching to live | `lastDataTime` (indirectly via timer) |
| `stopStalenessCheck()` | After switching to simulation | None (clears timer) |

### `actions/sensors.js`

| Action | Trigger | Store Writes |
|--------|---------|--------------|
| `loadSensorConfig(store)` | View mount, before scan | `sensorConfig` |
| `scanSensors(store)` | View mount, manual click, auto-refresh | `detectedSensors`, `sensorScanPending` |
| `saveSensorAssignments(store, assignments)` | Save button click | `sensorConfig` |
| `applySensorConfig(store)` | Apply button click | None (server-side only) |

### `actions/device-config.js`

| Action | Trigger | Store Writes |
|--------|---------|--------------|
| `loadDeviceConfig(store)` | View mount | `deviceConfig` |
| `saveDeviceConfig(store, config)` | Save button click | `deviceConfig` |

### `actions/version-check.js`

| Action | Trigger | Store Writes |
|--------|---------|--------------|
| `startVersionCheck(store)` | App boot | `baselineHash`, `serverHash`, `versionDismissed` |
| `dismissVersionUpdate(store)` | Toast dismiss click | `versionDismissed` |

## Rules

1. **Actions never read from DOM**. They receive input as function arguments (from event handlers) and read existing state from the store.
2. **Actions never call render functions**. State changes trigger subscribers, which handle rendering.
3. **Actions may call other actions** when composing workflows (e.g., `scanSensors` calls `loadSensorConfig` first).
4. **Error handling**: Actions catch their own errors and write error state to the store (e.g., `detectedSensors[hostId].error`) or call a status display helper. They never throw unhandled.
