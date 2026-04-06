# Data Model: Configure Sensor Connectors

**Date**: 2026-04-06  
**Feature**: 018-configure-sensor-connectors

## Entities

### SensorHost

Represents a Shelly 1 Gen3 device with Plus Add-on providing a 1-Wire bus for DS18B20 sensors.

| Field    | Type   | Description                                              |
|----------|--------|----------------------------------------------------------|
| id       | string | Human-readable identifier (e.g., "sensor_1", "sensor_2") |
| ip       | string | Network IP address (e.g., "192.168.30.20")               |
| name     | string | Display name (e.g., "Sensor Hub 1")                      |
| online   | bool   | Whether the host is currently reachable                   |

**Source**: Configured via `SENSOR_HOST_IPS` environment variable (comma-separated). Host metadata stored in sensor-config.

### DetectedSensor

A DS18B20 sensor discovered on a sensor host via 1-Wire bus scan.

| Field     | Type        | Description                                                         |
|-----------|-------------|---------------------------------------------------------------------|
| addr      | string      | 1-Wire hardware address (colon-separated hex, e.g., "40:FF:64:06:C7:CC:95:B1") |
| hostId    | string      | ID of the sensor host this sensor was found on                       |
| component | string/null | Current Shelly component binding (e.g., "temperature:100") or null   |
| tC        | number/null | Current temperature reading in Celsius, or null if error             |
| error     | string/null | Error message if sensor is faulted                                   |

**Source**: Queried at runtime via `SensorAddon.OneWireScan` RPC on each host. Not persisted — always discovered fresh.

### SensorRole

A named measurement point defined by the system. Represents a logical sensor position in the heating system.

| Field    | Type   | Description                                           |
|----------|--------|-------------------------------------------------------|
| name     | string | Role identifier (e.g., "collector", "tank_top")        |
| label    | string | Human-readable label (e.g., "Collector Outlet")        |
| location | string | Physical location description                          |
| optional | bool   | Whether this role is optional for system operation      |

**Source**: Derived from `system.yaml` sensors section. Hardcoded in the UI (same as current `SENSOR_IDS` map).

**Defined roles**:
- `collector` — Collector outlet (~280cm) — required
- `tank_top` — Tank upper region (~180cm) — required
- `tank_bottom` — Tank lower region (~10cm) — required
- `greenhouse` — Greenhouse air — required
- `outdoor` — Outside, shaded — required
- `radiator_in` — Radiator inlet — optional
- `radiator_out` — Radiator outlet — optional

### SensorAssignment

The mapping between a sensor role and a physical sensor. Persisted as the sensor configuration.

| Field     | Type   | Description                                                   |
|-----------|--------|---------------------------------------------------------------|
| role      | string | Sensor role name (e.g., "collector")                           |
| addr      | string | 1-Wire hardware address of the assigned sensor                 |
| hostIndex | number | Index into the hosts array (0 or 1)                            |
| componentId | number | Shelly temperature component ID (100+)                       |

**Uniqueness rules**:
- Each role can have at most one assigned sensor.
- Each sensor address can be assigned to at most one role.
- Each (hostIndex, componentId) pair is unique.

### SensorConfig (persisted)

The complete sensor configuration, stored server-side and delivered to the control device.

**Server-side format** (full, used by API and S3/local persistence):
```json
{
  "hosts": [
    {"id": "sensor_1", "ip": "192.168.30.20", "name": "Sensor Hub 1"},
    {"id": "sensor_2", "ip": "192.168.30.21", "name": "Sensor Hub 2"}
  ],
  "assignments": {
    "collector":    {"addr": "40:FF:64:06:C7:CC:95:B1", "hostIndex": 0, "componentId": 100},
    "tank_top":     {"addr": "40:FF:64:06:C7:CC:95:B2", "hostIndex": 0, "componentId": 101},
    "tank_bottom":  {"addr": "40:FF:64:06:C7:CC:95:B3", "hostIndex": 0, "componentId": 102},
    "greenhouse":   {"addr": "40:FF:64:06:C7:CC:95:B4", "hostIndex": 0, "componentId": 103},
    "outdoor":      {"addr": "40:FF:64:06:C7:CC:95:B5", "hostIndex": 0, "componentId": 104},
    "radiator_in":  {"addr": "40:FF:64:06:C7:CC:95:B6", "hostIndex": 1, "componentId": 100},
    "radiator_out": {"addr": "40:FF:64:06:C7:CC:95:B7", "hostIndex": 1, "componentId": 101}
  },
  "version": 1
}
```

**Shelly KVS format** (compact, delivered via MQTT, stored in KVS key `sensor_config`):
```json
{
  "s": {
    "collector":    {"h": 0, "i": 100},
    "tank_top":     {"h": 0, "i": 101},
    "tank_bottom":  {"h": 0, "i": 102},
    "greenhouse":   {"h": 0, "i": 103},
    "outdoor":      {"h": 0, "i": 104},
    "radiator_in":  {"h": 1, "i": 100},
    "radiator_out": {"h": 1, "i": 101}
  },
  "h": ["192.168.30.20", "192.168.30.21"],
  "v": 1
}
```

Compact keys: `s` = sensors, `h` = hosts (by index), `i` = component ID, `v` = version.

## State Transitions

### Apply Configuration Flow

```
DRAFT → APPLYING → APPLIED (per target)
                 → FAILED  (per target, retryable)
```

**Targets** (applied independently, best-effort):
1. Sensor Host 1 — `SensorAddon.RemovePeripheral` (all existing) + `SensorAddon.AddPeripheral` (assigned sensors)
2. Sensor Host 2 — same as above
3. Control System — publish sensor config to `greenhouse/sensor-config` MQTT topic (retained)

Each target tracks its own apply status. Failed targets can be retried independently.

## Validation Rules

- A sensor address must be exactly 8 colon-separated hex bytes.
- Component IDs must be in the 100-199 range (Add-on peripheral range).
- All 5 required roles must be assigned before applying (warning if not).
- No duplicate sensor addresses across roles.
- No duplicate component IDs within the same host.
- Component IDs are assigned sequentially starting from 100 on each host.
