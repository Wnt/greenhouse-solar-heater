# WebSocket API Contract

**Feature**: 010-live-system-playground
**Endpoint**: `wss://greenhouse.madekivi.com/ws`

## Connection

- **Auth**: WebSocket upgrade request must include a valid session cookie (same WebAuthn session as HTTP endpoints). Unauthenticated upgrades are rejected with 401.
- **Path**: `/ws`
- **Protocol**: Standard WebSocket (RFC 6455)

## Server → Client Messages

### `state` — Live system state update

Sent whenever a new MQTT message arrives from the Shelly controller.

```json
{
  "type": "state",
  "data": {
    "ts": 1711296000000,
    "mode": "solar_charging",
    "transitioning": false,
    "transition_step": null,
    "temps": {
      "collector": 65.2,
      "tank_top": 48.1,
      "tank_bottom": 32.5,
      "greenhouse": 18.3,
      "outdoor": 12.7
    },
    "valves": {
      "vi_btm": true,
      "vi_top": false,
      "vi_coll": true,
      "vo_coll": true,
      "vo_rad": false,
      "vo_tank": false,
      "v_ret": true,
      "v_air": false
    },
    "actuators": {
      "pump": true,
      "fan": false,
      "space_heater": false,
      "immersion_heater": false
    },
    "flags": {
      "collectors_drained": false,
      "emergency_heating_active": false
    }
  }
}
```

### `connection` — MQTT connection status

Sent when the server's MQTT connection state changes.

```json
{
  "type": "connection",
  "status": "connected"
}
```

`status` values: `connected`, `disconnected`, `reconnecting`

## Server → Client: History API

Historical data is served via HTTP (not WebSocket) for simplicity and cacheability.

### `GET /api/history?range={range}&sensor={sensor}`

**Auth**: Session cookie required.

**Parameters**:
- `range`: Time range — `1h`, `6h`, `24h`, `7d`, `30d`, `1y`, `all`
- `sensor` (optional): Specific sensor ID. If omitted, returns all sensors.

**Response** (JSON):

```json
{
  "range": "6h",
  "points": [
    {
      "ts": 1711296000000,
      "collector": 65.2,
      "tank_top": 48.1,
      "tank_bottom": 32.5,
      "greenhouse": 18.3,
      "outdoor": 12.7
    }
  ],
  "events": [
    {
      "ts": 1711293600000,
      "type": "mode",
      "from": "idle",
      "to": "solar_charging"
    }
  ]
}
```

**Resolution**: Automatically selected based on range:
- `1h`, `6h`: raw resolution (every data point)
- `24h`, `48h`: raw for recent portion, 30s for older portion
- `7d`, `30d`, `1y`, `all`: 30s resolution

## Client → Server Messages

None currently. The WebSocket is unidirectional (server → client). Future extensions (manual overrides) may add client → server messages.

## Device Configuration API

Runtime configuration for the Shelly controller. Not exposed through Caddy — only reachable from VPN (Shelly devices) and localhost (web UI via server proxy).

### `GET /api/device-config`

**Auth**: None (Shelly devices cannot perform WebAuthn; access restricted by network — VPN only, not exposed via Caddy).

**Response** (JSON):

```json
{
  "controls_enabled": false,
  "enabled_actuators": {
    "valves": false,
    "pump": false,
    "fan": false,
    "space_heater": false,
    "immersion_heater": false
  },
  "version": 1
}
```

### `PUT /api/device-config`

**Auth**: Session cookie required (operator only).

**Request body**: Same shape as GET response. `version` is auto-incremented by the server.

**Response**: Updated config (with new `version`).

**Side effects**:
1. Config persisted to S3/local storage
2. Config published to `greenhouse/config` MQTT topic (retained, QoS 1) — Shelly receives it immediately via subscription
3. Shelly applies on next control loop iteration (~30s worst case). If controls disabled while active, triggers safe shutdown.
