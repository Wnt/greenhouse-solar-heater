# Data Model: MQTT-Only Shelly Communication API

**Feature**: 019-mqtt-only-shelly-api | **Date**: 2026-04-06

## Entities

### State Snapshot (existing, unchanged)

Published by Shelly controller to `greenhouse/state` every control cycle (~30s).

| Field | Type | Description |
|-------|------|-------------|
| `ts` | number | Unix timestamp (milliseconds) |
| `mode` | string | Current mode: `"idle"`, `"solar_charging"`, `"greenhouse_heating"`, `"active_drain"`, `"emergency_heating"` |
| `transitioning` | boolean | Whether a mode transition is in progress |
| `transition_step` | string \| null | Current transition step name |
| `temps` | object | Temperature readings (°C, null if stale) |
| `temps.collector` | number \| null | Solar collector temperature |
| `temps.tank_top` | number \| null | Tank top temperature |
| `temps.tank_bottom` | number \| null | Tank bottom temperature |
| `temps.greenhouse` | number \| null | Greenhouse air temperature |
| `temps.outdoor` | number \| null | Outdoor temperature |
| `valves` | object | 8 valve states (boolean on/off) |
| `actuators` | object | 4 actuator states: `pump`, `fan`, `space_heater`, `immersion_heater` (boolean) |
| `flags.collectors_drained` | boolean | Whether collectors have been actively drained |
| `flags.emergency_heating_active` | boolean | Whether emergency heating is engaged |
| `controls_enabled` | boolean | Whether device controls are enabled |

### Device Config Message (existing, unchanged)

Published by server to `greenhouse/config`. Received by Shelly telemetry script.

| Field | Type | Description |
|-------|------|-------------|
| `ce` | boolean | Controls enabled |
| `ea` | number | Enabled actuators bitmask (1=valves, 2=pump, 4=fan, 8=space_heater, 16=immersion) |
| `fm` | string \| null | Forced mode code (`"I"`, `"SC"`, `"GH"`, `"AD"`, `"EH"`) or null |
| `am` | string[] \| null | Allowed mode codes, or null for all |
| `v` | number | Version number (monotonically increasing) |

### Sensor Config Message (existing, unchanged)

Published by server to `greenhouse/sensor-config`. Received by Shelly telemetry script.

| Field | Type | Description |
|-------|------|-------------|
| `s` | object | Sensor assignments: `{role: {h: hostIndex, i: componentId}, ...}` |
| `h` | string[] | Host IP addresses array |
| `v` | number | Version number |

### Sensor Config Apply Request (NEW)

Published by server to `greenhouse/sensor-config-apply`. Received by Shelly controller.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Request correlation ID (e.g., `"apply-{timestamp}"`) |
| `target` | string \| null | Specific host IP to apply to, or null for all hosts |
| `config` | object | Full sensor config in compact format (same as sensor config message) |

### Sensor Config Apply Result (NEW)

Published by Shelly controller to `greenhouse/sensor-config-result`. Received by server.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Correlation ID matching the request |
| `success` | boolean | Overall success |
| `results` | object[] | Per-host results |
| `results[].host` | string | Host IP address |
| `results[].ok` | boolean | Whether this host was configured successfully |
| `results[].error` | string \| undefined | Error message if failed |
| `results[].peripherals` | number | Number of peripherals configured |

### Discovery Request (NEW)

Published by server to `greenhouse/discover-sensors`. Received by Shelly controller.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Request correlation ID (e.g., `"disc-{timestamp}"`) |
| `hosts` | string[] | Sensor host IPs to scan |

### Discovery Result (NEW)

Published by Shelly controller to `greenhouse/discover-sensors-result`. Received by server.

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Correlation ID matching the request |
| `results` | object[] | Per-host scan results |
| `results[].host` | string | Host IP address |
| `results[].ok` | boolean | Whether scan succeeded |
| `results[].error` | string \| undefined | Error message if scan failed |
| `results[].sensors` | object[] | Detected DS18B20 sensors |
| `results[].sensors[].addr` | string | 1-Wire address |
| `results[].sensors[].tC` | number \| null | Current temperature reading |

## State Transitions

### Controller MQTT Command Processing

```
[Normal operation]
  │
  ├── Receive discovery request on greenhouse/discover-sensors
  │     → Set pendingDiscovery flag
  │     → Wait for current sensor poll to complete
  │     → Execute discovery scan sequentially per host
  │     → Publish results to greenhouse/discover-sensors-result
  │     → Clear pendingDiscovery flag
  │
  ├── Receive config-apply request on greenhouse/sensor-config-apply
  │     → Set pendingConfigApply flag
  │     → Wait for current sensor poll to complete
  │     → Execute SensorAddon RPC calls sequentially per host
  │     → Update local sensor config from response
  │     → Publish results to greenhouse/sensor-config-result
  │     → Clear pendingConfigApply flag
  │
  └── Normal control loop continues unaffected
```

### Server Discovery Flow

```
[UI triggers discovery]
  → Server publishes to greenhouse/discover-sensors with correlation ID
  → Server subscribes to greenhouse/discover-sensors-result
  → Server waits for matching correlation ID (timeout: 30s)
  → Returns results to UI via HTTP response
  → On timeout: returns error to UI
```

## Validation Rules

- Discovery request `hosts` array must contain only valid IPv4 addresses
- Correlation IDs must be unique per request (timestamp-based sufficient at this scale)
- Config apply `config` must validate against the existing sensor config schema (hosts array, role mappings)
- MQTT messages are validated with JSON.parse; malformed payloads are silently dropped (existing pattern in telemetry.js)
- Concurrent call limit enforced by serializing all HTTP operations within the control script (no parallel RPC calls during discovery/apply)
