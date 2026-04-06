# MQTT API Contract: Shelly Controller ↔ Server

**Feature**: 019-mqtt-only-shelly-api | **Version**: 1.0

## Overview

All communication between the cloud server and Shelly controller flows through MQTT topics on the Mosquitto broker (localhost:1883 within the K8s pod). No direct HTTP RPC calls from server to any Shelly device.

---

## Existing Topics (unchanged)

### `greenhouse/state` — State Snapshots

**Publisher**: Shelly controller (telemetry script)
**Subscriber**: Server (mqtt-bridge.js)
**QoS**: 1 | **Retain**: Yes

```json
{
  "ts": 1712444400000,
  "mode": "idle",
  "transitioning": false,
  "transition_step": null,
  "temps": {
    "collector": 45.2,
    "tank_top": 38.1,
    "tank_bottom": 25.4,
    "greenhouse": 14.3,
    "outdoor": 8.7
  },
  "valves": {
    "vi_btm": false, "vi_top": false, "vi_coll": false,
    "vo_coll": false, "vo_rad": false, "vo_tank": false,
    "v_ret": false, "v_air": false
  },
  "actuators": {
    "pump": false, "fan": false,
    "space_heater": false, "immersion_heater": false
  },
  "flags": {
    "collectors_drained": false,
    "emergency_heating_active": false
  },
  "controls_enabled": true
}
```

### `greenhouse/config` — Device Configuration

**Publisher**: Server (mqtt-bridge.js)
**Subscriber**: Shelly controller (telemetry script)
**QoS**: 1 | **Retain**: Yes

```json
{
  "ce": true,
  "ea": 31,
  "fm": null,
  "am": null,
  "v": 5
}
```

### `greenhouse/sensor-config` — Sensor Assignments

**Publisher**: Server (mqtt-bridge.js)
**Subscriber**: Shelly controller (telemetry script)
**QoS**: 1 | **Retain**: Yes

```json
{
  "s": {
    "collector": {"h": 0, "i": 100},
    "tank_top": {"h": 0, "i": 101},
    "tank_bottom": {"h": 0, "i": 102},
    "greenhouse": {"h": 1, "i": 100},
    "outdoor": {"h": 1, "i": 101}
  },
  "h": ["192.168.30.21", "192.168.30.22"],
  "v": 3
}
```

---

## New Topics

### `greenhouse/sensor-config-apply` — Apply Sensor Config to Hosts

**Publisher**: Server
**Subscriber**: Shelly controller (telemetry script → control script)
**QoS**: 1 | **Retain**: No

**Request**:
```json
{
  "id": "apply-1712444400123",
  "target": null,
  "config": {
    "s": {"collector": {"h": 0, "i": 100}, "...": "..."},
    "h": ["192.168.30.21", "192.168.30.22"],
    "v": 4
  }
}
```

- `id`: Unique correlation ID for matching response
- `target`: Specific host IP to apply to, or `null` for all hosts
- `config`: Full sensor config in compact format

### `greenhouse/sensor-config-result` — Apply Results

**Publisher**: Shelly controller
**Subscriber**: Server
**QoS**: 1 | **Retain**: No

**Response**:
```json
{
  "id": "apply-1712444400123",
  "success": true,
  "results": [
    {"host": "192.168.30.21", "ok": true, "peripherals": 3},
    {"host": "192.168.30.22", "ok": true, "peripherals": 2}
  ]
}
```

Error case:
```json
{
  "id": "apply-1712444400123",
  "success": false,
  "results": [
    {"host": "192.168.30.21", "ok": true, "peripherals": 3},
    {"host": "192.168.30.22", "ok": false, "error": "HTTP timeout"}
  ]
}
```

### `greenhouse/discover-sensors` — Sensor Discovery Request

**Publisher**: Server
**Subscriber**: Shelly controller (telemetry script → control script)
**QoS**: 1 | **Retain**: No

**Request**:
```json
{
  "id": "disc-1712444400456",
  "hosts": ["192.168.30.21", "192.168.30.22"]
}
```

### `greenhouse/discover-sensors-result` — Discovery Results

**Publisher**: Shelly controller
**Subscriber**: Server
**QoS**: 1 | **Retain**: No

**Response**:
```json
{
  "id": "disc-1712444400456",
  "results": [
    {
      "host": "192.168.30.21",
      "ok": true,
      "sensors": [
        {"addr": "28:ff:12:34:56:78:ab:cd", "tC": 23.4},
        {"addr": "28:ff:98:76:54:32:10:ef", "tC": 41.2}
      ]
    },
    {
      "host": "192.168.30.22",
      "ok": true,
      "sensors": [
        {"addr": "28:ff:aa:bb:cc:dd:ee:ff", "tC": 15.1}
      ]
    }
  ]
}
```

Error case:
```json
{
  "id": "disc-1712444400456",
  "results": [
    {
      "host": "192.168.30.21",
      "ok": false,
      "error": "Connection refused",
      "sensors": []
    }
  ]
}
```

---

## Server HTTP API Changes

### Removed

| Method | Path | Reason |
|--------|------|--------|
| POST | `/api/rpc/*` | No longer needed — all device communication via MQTT |

### Modified

| Method | Path | Change |
|--------|------|--------|
| POST | `/api/sensor-config/apply` | No longer makes direct RPC. Publishes to MQTT, waits for result (30s timeout). |
| POST | `/api/sensor-config/apply/:targetId` | Same — routes through MQTT. |

### New

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/sensor-discovery` | Publishes discovery request to MQTT, waits for result (30s timeout). Body: `{"hosts": ["ip1", "ip2"]}` |

---

## Timeouts and Error Handling

| Operation | Timeout | On Timeout |
|-----------|---------|------------|
| Discovery request | 30 seconds | Server returns HTTP 504 with `{"error": "Discovery timed out"}` |
| Config apply request | 30 seconds | Server returns HTTP 504 with `{"error": "Config apply timed out"}` |
| Individual sensor host RPC (on controller) | 5 seconds | Host marked as failed in results, other hosts still processed |

## Ordering Guarantees

- Discovery and config-apply requests are processed one at a time on the controller (serialized via pending flags)
- If a request arrives while another is in progress, it is queued and processed after the current operation completes
- Normal control loop (sensor polling, mode evaluation, valve control) takes priority — MQTT commands execute in the gap between cycles
