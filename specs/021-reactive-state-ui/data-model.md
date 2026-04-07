# Data Model: Reactive State Core

**Date**: 2026-04-07 | **Branch**: `021-reactive-state-ui`

## State Store Shape

The single canonical state object. Every key is independently subscribable. Values use the simplest possible types — primitives and shallow objects.

### App Lifecycle

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `phase` | `'init' \| 'simulation' \| 'live'` | `'init'` | Current application mode. Determines which views are available and which data source is active. |
| `isLiveCapable` | `boolean` | computed at boot | Whether the deployment context supports live mode (not GitHub Pages, not forced simulation). Set once at startup, never changes. |

### Navigation

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `currentView` | `string` | `'status'` | The active view tab. Canonical source for which view is mounted. Set from URL hash or redirected by phase changes. |

### Connection (live mode)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `wsStatus` | `'disconnected' \| 'reconnecting' \| 'connected'` | `'disconnected'` | WebSocket connection state. Set by LiveSource. |
| `mqttStatus` | `'unknown' \| 'connected' \| 'disconnected'` | `'unknown'` | Server-side MQTT broker connection state. Set from WebSocket `connection` messages. |
| `lastDataTime` | `number` | `0` | Timestamp (ms) of last data update from live source. Used for staleness detection. |
| `hasReceivedData` | `boolean` | `false` | Whether any MQTT state data has arrived since connecting. Distinguishes "connecting" from "device offline". |
| `wsConnectedAt` | `number` | `0` | Timestamp when WebSocket opened. Used for grace period in display state derivation. |

### Simulation

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `running` | `boolean` | `false` | Whether the simulation is currently playing. |
| `graphRange` | `number` | `86400` | Selected time window for the history graph, in seconds. |

### Sensors

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `sensorConfig` | `object \| null` | `null` | Sensor configuration from `/api/sensor-config`. Contains `hosts`, `assignments`, `version`. |
| `detectedSensors` | `object` | `{}` | Map of hostId → `{sensors: [{addr, component, tC, error}], error: string|null}` or `null` (scanning in progress for that host). |
| `sensorScanPending` | `boolean` | `false` | Whether an HTTP request to `/api/sensor-discovery` is currently in-flight. |

### Device Config

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `deviceConfig` | `object \| null` | `null` | Device configuration from `/api/device-config`. Contains controls_enabled, forced_mode, allowed_modes, etc. |

### Version Check

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `baselineHash` | `string \| null` | `null` | JS source hash established on first poll. |
| `serverHash` | `string \| null` | `null` | Latest JS source hash from server. |
| `versionDismissed` | `boolean` | `false` | Whether the operator dismissed the update toast. Reset when hash changes again. |

## Derived State

Computed on every access from the store. Never stored independently.

### `scanning` → `boolean`

```
sensorScanPending OR any host in sensorConfig.hosts where detectedSensors[hostId] === null
```

Replaces the `scanning` module variable that had to be manually synchronized.

### `availableViews` → `string[]`

```
If phase === 'live':  ['status', 'components', 'schematic', 'sensors', 'device']
If phase === 'simulation': ['status', 'components', 'schematic', 'controls']
If phase === 'init': ['status', 'components', 'schematic']
```

Replaces DOM visibility checks (`sensorsNav.style.display === 'none'`).

### `connectionDisplay` → `string`

```
If wsStatus === 'reconnecting': 'reconnecting'
If wsStatus !== 'connected': 'disconnected'
If !hasReceivedData AND mqttStatus === 'disconnected': 'device_offline'
If !hasReceivedData AND (now - wsConnectedAt) < 2000: 'connecting'
If !hasReceivedData: 'never_connected'
If (now - lastDataTime) > 60000: 'stale'
Else: 'active'
```

Replaces the scattered `getConnectionDisplayState()` function and its duplicated condition checks.

### `missingRoles` → `string[]`

```
REQUIRED_ROLES.filter(r => !sensorConfig?.assignments?.[r]?.addr)
```

Replaces `getMissingRequiredRoles()` that reads module-level `sensorConfig`.

### `updateAvailable` → `boolean`

```
baselineHash !== null AND serverHash !== null AND baselineHash !== serverHash AND !versionDismissed
```

Replaces the scattered check across version-check.js variables.

## State Transitions

### Phase Transitions

```
init → simulation    (when !isLiveCapable, at end of init())
init → live          (when isLiveCapable, at end of init() via initModeToggle)
live → simulation    (user clicks mode toggle)
simulation → live    (user clicks mode toggle)
```

### Navigation Transitions

```
On hashchange:
  requestedView = hash.replace('#', '') || 'status'
  if requestedView in availableViews: set currentView = requestedView
  else: set currentView = 'status'

On phase change:
  if currentView not in availableViews: set currentView = 'status'
```

### Sensor Scan Lifecycle

```
idle → scanning:    set sensorScanPending=true, detectedSensors={hostId: null, ...}
scanning → done:    set sensorScanPending=false, detectedSensors={hostId: {sensors, error}, ...}
scanning → error:   set sensorScanPending=false, detectedSensors={hostId: {sensors:[], error}, ...}
```

## Entities Not in Store

The following remain outside the reactive store (performance-critical, updated at 60fps):

- `ThermalModel` state (temperatures, irradiance, simTime)
- `ControlStateMachine` state (currentMode, modeStartTime, transitionLog)
- `TimeSeriesStore` data (times, values, modes arrays)
- Canvas graph rendering data
- Slider positions and drag state
- Simulation parameters (t_outdoor, irradiance overrides)
