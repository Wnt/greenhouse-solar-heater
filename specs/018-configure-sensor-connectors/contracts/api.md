# API Contracts: Configure Sensor Connectors

**Date**: 2026-04-06  
**Feature**: 018-configure-sensor-connectors

## New Endpoints

### GET /api/sensor-config

Returns the current sensor configuration (host list and sensor-to-role assignments).

**Authentication**: Not required (read-only, same as device-config GET).

**Response** `200 OK`:
```json
{
  "hosts": [
    {"id": "sensor_1", "ip": "192.168.30.20", "name": "Sensor Hub 1"},
    {"id": "sensor_2", "ip": "192.168.30.21", "name": "Sensor Hub 2"}
  ],
  "assignments": {
    "collector": {"addr": "40:FF:64:06:C7:CC:95:B1", "hostIndex": 0, "componentId": 100},
    "tank_top": {"addr": "40:FF:64:06:C7:CC:95:B2", "hostIndex": 0, "componentId": 101}
  },
  "version": 1
}
```

**Response** `200 OK` (no config yet):
```json
{
  "hosts": [
    {"id": "sensor_1", "ip": "192.168.30.20", "name": "Sensor Hub 1"},
    {"id": "sensor_2", "ip": "192.168.30.21", "name": "Sensor Hub 2"}
  ],
  "assignments": {},
  "version": 0
}
```

### PUT /api/sensor-config

Updates sensor-to-role assignments and persists the configuration.

**Authentication**: Required (same as device-config PUT).

**Request body**:
```json
{
  "assignments": {
    "collector": {"addr": "40:FF:64:06:C7:CC:95:B1", "hostIndex": 0, "componentId": 100},
    "tank_top": {"addr": "40:FF:64:06:C7:CC:95:B2", "hostIndex": 0, "componentId": 101},
    "tank_bottom": {"addr": "40:FF:64:06:C7:CC:95:B3", "hostIndex": 0, "componentId": 102},
    "greenhouse": {"addr": "40:FF:64:06:C7:CC:95:B4", "hostIndex": 0, "componentId": 103},
    "outdoor": {"addr": "40:FF:64:06:C7:CC:95:B5", "hostIndex": 0, "componentId": 104}
  }
}
```

**Response** `200 OK`:
```json
{
  "hosts": [...],
  "assignments": {...},
  "version": 2
}
```

**Response** `400 Bad Request` (validation error):
```json
{
  "error": "Duplicate sensor address: 40:FF:64:06:C7:CC:95:B1"
}
```

### POST /api/sensor-config/apply

Applies the current sensor configuration to all targets (sensor hosts + control system). Best-effort: applies to reachable targets and reports per-target results.

**Authentication**: Required.

**Request body**: None (applies current persisted config).

**Response** `200 OK`:
```json
{
  "results": {
    "sensor_1": {"status": "success", "message": "5 sensors configured"},
    "sensor_2": {"status": "success", "message": "2 sensors configured"},
    "control": {"status": "success", "message": "Sensor routing published"}
  }
}
```

**Response** `200 OK` (partial failure):
```json
{
  "results": {
    "sensor_1": {"status": "success", "message": "5 sensors configured"},
    "sensor_2": {"status": "error", "message": "Device unreachable: ETIMEDOUT"},
    "control": {"status": "success", "message": "Sensor routing published"}
  }
}
```

### POST /api/sensor-config/apply/:hostId

Retries apply for a single target (sensor host or "control").

**Authentication**: Required.

**Response**: Same format as full apply, but only the targeted result.

## Extended Endpoint

### POST /api/rpc/* (existing, extended)

The existing RPC proxy is extended to accept a `_host` parameter in the JSON body to target sensor host devices (not just the controller).

**New behavior**: If `_host` is present in the request body, the proxy uses it as the target IP instead of `CONTROLLER_IP`. The `_host` value must be in the allowlist (`CONTROLLER_IP` + sensor host IPs from `SENSOR_HOST_IPS` env var).

**Request body** (targeting sensor host):
```json
{
  "_host": "192.168.30.20",
  "id": 100
}
```

**Response** `403 Forbidden` (host not in allowlist):
```json
{
  "error": "Host not in allowlist"
}
```

This allows the UI to call sensor host RPC methods like `SensorAddon.OneWireScan` through the existing proxy.

## MQTT Topics

### greenhouse/sensor-config (new, retained)

Published by the server when sensor config is applied. Consumed by the Shelly telemetry script.

**Payload** (compact format for KVS):
```json
{
  "s": {
    "collector": {"h": 0, "i": 100},
    "tank_top": {"h": 0, "i": 101},
    "tank_bottom": {"h": 0, "i": 102},
    "greenhouse": {"h": 0, "i": 103},
    "outdoor": {"h": 0, "i": 104}
  },
  "h": ["192.168.30.20", "192.168.30.21"],
  "v": 1
}
```

## Environment Variables

### SENSOR_HOST_IPS (new)

Comma-separated list of sensor host IP addresses.

**Example**: `SENSOR_HOST_IPS=192.168.30.20,192.168.30.21`

**Used by**:
- Server: RPC proxy allowlist, sensor-config host list
- Kubernetes ConfigMap / local .env

## Shelly KVS Keys

### sensor_config (new)

Stored on the Shelly Pro 4PM (controller) by the telemetry script when it receives the `greenhouse/sensor-config` MQTT message.

**Value**: Same compact JSON as the MQTT payload.

**Read by**: `control.js` at boot and on `sensor_config_changed` events.
