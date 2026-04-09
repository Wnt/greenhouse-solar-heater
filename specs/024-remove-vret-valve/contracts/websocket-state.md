# Contract: WebSocket state broadcast shape change

This contract documents the WebSocket broadcast format sent from `server/lib/mqtt-bridge.js` to the playground's `LiveSource`. The shape is derived from the MQTT snapshot (see `mqtt-snapshot.md`) plus a small amount of server-side enrichment.

## Endpoint

`GET ws://<host>/ws` (upgraded from HTTP). The playground connects from `playground/js/data-source.js` `LiveSource`.

## Direction

Server → client (state broadcasts). A separate client → server direction exists for manual override and relay commands but is not affected by this feature.

## Before

```jsonc
{
  "type": "state",
  "mode": "solar_charging",
  "valve_states": {
    "vi_btm": true, "vi_top": false, "vi_coll": false,
    "vo_coll": true, "vo_rad": false, "vo_tank": false,
    "v_ret": true, "v_air": false
  },
  "actuators": { "pump": true, "fan": false, "space_heater": false, "immersion_heater": false },
  "sensors": { /* … */ },
  "opening": [],
  "queued_opens": [],
  "pending_closes": [],
  "manual_override": false,
  "timestamp": 1744244400000
}
```

## After

```jsonc
{
  "type": "state",
  "mode": "solar_charging",
  "valve_states": {
    "vi_btm": true, "vi_top": false, "vi_coll": false,
    "vo_coll": true, "vo_rad": false, "vo_tank": false,
    "v_air": false
  },
  "actuators": { "pump": true, "fan": false, "space_heater": false, "immersion_heater": false },
  "sensors": { /* … */ },
  "opening": [],
  "queued_opens": [],
  "pending_closes": [],
  "manual_override": false,
  "timestamp": 1744244400000
}
```

**Delta**: mirrors the MQTT snapshot — `valve_states` shrinks from 8 to 7 keys. The `manual_override` enrichment (added by device-config) is unaffected. The `timestamp` is added server-side and does not touch valve data.

## Implementation note

`server/lib/mqtt-bridge.js:broadcastState(snapshot)` currently does:

```js
const enriched = { type: 'state', ...snapshot, manual_override: deviceConfig.mo?.a || false, timestamp: Date.now() };
wsClients.forEach(ws => ws.send(JSON.stringify(enriched)));
```

Because it spreads the snapshot rather than hand-building the shape, it automatically adopts the new 7-key `valve_states` with zero code change. This is the desirable behaviour — FR-010 is verified by **absence of `v_ret` in the bridge code**, not by a code edit.

## Client-side handling

`playground/js/data-source.js` `LiveSource.onMessage` forwards the parsed payload to `playground/js/main.js` `updateDisplay(state, result)`. The display code in `main.js` hard-codes the `valveNames` array + `valveNameLabels` map (lines 1341-1345), which MUST be edited per FR-009 to drop `v_ret`. Once that edit lands, the display renders 7 valve rows and the relay grid contains 7 buttons.

## Manual override interaction

Manual override mode (023-relay-toggle-ui) lets the playground send per-relay commands over WebSocket. The command shape is:

```jsonc
{ "type": "relay-command", "valve": "vi_btm", "target": "open" }
```

After this feature, attempting to send `{ "valve": "v_ret", "target": "open" }` MUST either:

1. Be rejected server-side with a clear error message ("unknown valve: v_ret"), OR
2. Be impossible to produce from the UI because the `v_ret` button no longer exists (FR-009 removes the button from `playground/index.html:493`).

Option 2 is the correct answer: the UI simply cannot produce the command because the control element is gone. The server-side handler currently validates against `RELAY_MAP` keys in `shelly/control.js` (via the MQTT round-trip) and will reject any unknown valve, so a hand-crafted malicious WebSocket command is also handled safely — it just round-trips to the device, which drops it with an `unknown valve` error in its log.

## Testing

- `tests/e2e/live-mode.spec.js` — mocked WebSocket payloads for live mode. Update mocked `valve_states` to 7 keys.
- `tests/e2e/live-display.spec.js` — asserts the schematic and history graph render live values. Confirm the new 7-valve schematic renders without errors.
- `tests/e2e/live-logs.spec.js` — System Logs card pagination. Confirm historical rows with 8-key shape still render (see Backwards Compatibility in `mqtt-snapshot.md`).
- `tests/data-source.test.js` — `LiveSource` state mapping. Update any 8-key fixture to 7.
- `tests/mqtt-bridge.test.js` — state-change detection. Update any 8-key fixture to 7.
