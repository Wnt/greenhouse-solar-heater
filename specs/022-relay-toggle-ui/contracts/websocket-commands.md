# WebSocket Command Contract

**Feature**: 022-relay-toggle-ui  
**Direction**: Client → Server (new), Server → Client (extended)

## Client → Server Commands

All commands are JSON messages sent over the existing WebSocket connection at `/ws`.

### override-enter

Enters manual override mode. Requires `ce=true` in current device config.

```json
{
  "type": "override-enter",
  "ttl": 300,
  "suppressSafety": false
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `type` | string | yes | `"override-enter"` | Command type |
| `ttl` | integer | no | 60–3600, default 300 | Override duration in seconds |
| `suppressSafety` | boolean | no | default false | Suppress safety overrides |

**Server behavior**:
1. Validate `ce=true` in current device config. If false, send error response.
2. Validate override not already active. If active, update TTL and suppressSafety.
3. Compute `ex = Math.floor(Date.now()/1000) + ttl`.
4. Update device config: set `mo: {a: true, ex, ss: suppressSafety}`.
5. Publish updated config to MQTT `greenhouse/config`.
6. Track TTL expiry server-side as secondary measure (device enforces primary expiry via control loop).
7. Send acknowledgment.

**Response** (Server → Client):
```json
{"type": "override-ack", "active": true, "expiresAt": 1712505600, "suppressSafety": false}
```

**Error response**:
```json
{"type": "override-error", "message": "Controls not enabled"}
```

### override-exit

Exits manual override mode voluntarily.

```json
{
  "type": "override-exit"
}
```

**Server behavior**:
1. Clear override: update device config with `mo: null`.
2. Clear server-side TTL tracking.
3. Publish updated config to MQTT.
4. Send acknowledgment.

**Response**:
```json
{"type": "override-ack", "active": false}
```

### override-update

Updates TTL while override is active.

```json
{
  "type": "override-update",
  "ttl": 900
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `type` | string | yes | `"override-update"` | Command type |
| `ttl` | integer | yes | 60–3600 | New TTL from now, in seconds |

**Server behavior**:
1. Validate override is active. If not, send error.
2. Compute new `ex = Math.floor(Date.now()/1000) + ttl`.
3. Update device config `mo.ex`.
4. Reset server-side TTL tracking.
5. Publish updated config to MQTT.
6. Send acknowledgment with new expiry.

### relay-command

Toggles a specific relay. Only valid during active manual override.

```json
{
  "type": "relay-command",
  "relay": "pump",
  "on": true
}
```

| Field | Type | Required | Constraints | Description |
|-------|------|----------|-------------|-------------|
| `type` | string | yes | `"relay-command"` | Command type |
| `relay` | string | yes | One of: `vi_btm`, `vi_top`, `vi_coll`, `vo_coll`, `vo_rad`, `vo_tank`, `v_ret`, `v_air`, `pump`, `fan` | Target actuator |
| `on` | boolean | yes | — | Desired state |

**Server behavior**:
1. Validate override is active. If not, send error.
2. Validate `relay` is a recognized identifier.
3. Publish to MQTT topic `greenhouse/relay-command` with `{relay, on}`.
4. Do NOT send a response — the state update arrives via the normal state broadcast.

**No direct response** — confirmation comes via the next state broadcast message which includes the updated relay state.

## MQTT Topic Contract

### greenhouse/relay-command (new)

**Direction**: Server → Shelly device  
**QoS**: 1  
**Retain**: false (transient commands)

```json
{"relay": "pump", "on": true}
```

**Device behavior**:
1. Validate `deviceConfig.mo.a === true` and `now < deviceConfig.mo.ex` (override active and not expired).
2. Call the appropriate relay function (`setPump`, `setFan`, `setValve`).
3. Emit state update via `greenhouse/state`.

### Device-side TTL enforcement

On every control loop iteration (every 30 seconds), the device checks:
1. If `deviceConfig.mo && deviceConfig.mo.a && Shelly.getComponentStatus("sys").unixtime >= deviceConfig.mo.ex`:
   - Clear `deviceConfig.mo` (set to null)
   - Save updated config to KVS
   - Resume normal `evaluate()` cycle
   - Emit state update (clears `manual_override` in broadcast)
2. This ensures override expires even when the server/internet is unreachable.

## Server → Client State Broadcast (extended)

The existing `{type: "state", data: {...}}` message gains a new field:

```json
{
  "type": "state",
  "data": {
    "temps": { ... },
    "mode": "IDLE",
    "valves": { ... },
    "actuators": { ... },
    "transitioning": false,
    "controls_enabled": true,
    "manual_override": {
      "active": true,
      "expiresAt": 1712505600,
      "suppressSafety": false
    }
  }
}
```

When no override is active, `manual_override` is `null`.
