# MQTT Topic Contract

**Feature**: 010-live-system-playground

## Topics

### `greenhouse/state` (retained)

Published by the Shelly Pro 4PM control script. Retained so new subscribers receive the latest state immediately.

**QoS**: 1 (at least once)
**Retain**: true
**Publisher**: Shelly Pro 4PM control script
**Subscribers**: Node.js server

**Payload** (JSON):

```json
{
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
  },
  "controls_enabled": true
}
```

**Publish triggers**:
- End of each poll cycle (~30s)
- Each step of a mode transition (with `transitioning: true` and appropriate `transition_step`)
- Any valve or actuator state change

**Transition steps sequence** (when `transitioning: true`):
1. `"pump_stop"` — pump turned off
2. `"valves_closing"` — all valves closing (after 1s settle)
3. `"valves_opening"` — new mode's valves opening
4. `"pump_start"` — pump started (after 5s prime)
5. `null` with `transitioning: false` — transition complete

---

### `greenhouse/config` (retained)

Published by the Node.js server when an operator updates the device configuration. Retained so the Shelly receives the latest config immediately on MQTT connect (or reconnect). The Shelly subscribes to this topic for push-based config updates.

**QoS**: 1 (at least once)
**Retain**: true
**Publisher**: Node.js server (on `PUT /api/device-config`)
**Subscribers**: Shelly Pro 4PM control script

**Payload** (JSON):

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

**Publish triggers**:
- Operator updates config via `PUT /api/device-config`

**Shelly-side behavior on receive**:
1. Parse JSON payload
2. Compare `version` with current KVS config version
3. If different: update KVS, apply new config immediately
4. If `controls_enabled` changed to `false` while a mode is active: safe shutdown on next control loop iteration (stop pump → close valves → idle)
