# Contract: MQTT `greenhouse/state` snapshot shape change

This contract documents the wire-format change to the MQTT state snapshot published by the Shelly controller on topic `greenhouse/state` and consumed by the monitoring server's MQTT bridge. The change is strictly a key removal — no added or renamed fields.

## Topic

`greenhouse/state`

## Publisher

`shelly/telemetry.js` on the Shelly Pro 4PM (invoked from `shelly/control.js` whenever `buildSnapshotFromState` produces a new snapshot).

## Before

```jsonc
{
  "mode": "solar_charging",
  "valve_states": {
    "vi_btm": true,
    "vi_top": false,
    "vi_coll": false,
    "vo_coll": true,
    "vo_rad": false,
    "vo_tank": false,
    "v_ret": true,
    "v_air": false
  },
  "actuators": { "pump": true, "fan": false, "space_heater": false, "immersion_heater": false },
  "sensors": { /* … */ },
  "opening": [],
  "queued_opens": [],
  "pending_closes": [],
  "manual_override": false,
  "schema_v": 1
}
```

## After

```jsonc
{
  "mode": "solar_charging",
  "valve_states": {
    "vi_btm": true,
    "vi_top": false,
    "vi_coll": false,
    "vo_coll": true,
    "vo_rad": false,
    "vo_tank": false,
    "v_air": false
  },
  "actuators": { "pump": true, "fan": false, "space_heater": false, "immersion_heater": false },
  "sensors": { /* … */ },
  "opening": [],
  "queued_opens": [],
  "pending_closes": [],
  "manual_override": false,
  "schema_v": 1
}
```

**Delta**: the `valve_states` object shrinks from 8 keys to 7. No other field changes.

## Staged-valve fields

`opening`, `queued_opens`, and `pending_closes` (added by 023-limit-valve-operations) are alphabetically ordered arrays of valve-name strings. After the rename, they MUST never contain the string `"v_ret"` — `buildSnapshotFromState` iterates `VALVE_NAMES_SORTED`, which drops `v_ret` as part of this feature, so the exclusion is automatic.

## Consumers

All consumers iterate the `valve_states` object keys generically (`for key in valve_states` or `Object.keys(valve_states).forEach(...)`). None hard-code `v_ret`. Confirmed by grepping each consumer:

- **`server/lib/mqtt-bridge.js`** — subscribes to `greenhouse/state`, parses, normalizes, broadcasts via WebSocket. Iterates `valve_states` keys generically. Grep: 0 matches for `v_ret`.
- **`server/lib/db.js`** — inserts state events keyed by `(event_type, timestamp, snapshot_json)`. The snapshot is stored as opaque JSONB, so the shrunk shape is stored verbatim with no schema change. Historical rows predating this feature still contain `v_ret: true/false`, which is fine — the DB treats them as opaque data.
- **`server/server.js` `/api/events`** — paginated state-events feed for the System Logs UI. Returns snapshots verbatim, no per-key enumeration.
- **`playground/js/data-source.js`** — `LiveSource` / `SimulationSource` abstraction. Passes `valve_states` through to the UI unchanged. No hard-coded valve names.
- **`playground/js/main.js`** — the `valveNames` array and `valveNameLabels` map ARE hard-coded enumerations and MUST be edited (FR-009) to drop `v_ret`.

## Backwards compatibility

- **Historical DB rows**: state-event rows from before this feature still contain `"v_ret": false/true` in their snapshot JSONB. This is fine — they are read-only history. The `/api/events` endpoint returns them verbatim and the playground's System Logs UI iterates keys generically, so a stray `v_ret` key in old rows does not crash rendering. A user scrolling far enough back in history will see `v_ret` in old state logs; this is accurate historical record.
- **Live data**: after deploy, the Shelly publishes the new 7-key shape. Consumers see one fewer key. No downtime.
- **Downgrade**: rolling back to the pre-feature Shelly script republishes the 8-key shape. The DB and the server handle both.

## Testing

- `tests/control-logic.test.js` — the `buildSnapshotFromState` suite (added by 023) asserts the returned `valve_states` shape. Every test that currently lists 8 keys MUST be updated to list 7.
- `tests/mqtt-bridge.test.js` — state-change detection tests. If any test constructs a state snapshot with 8 valve keys, update to 7.
- `tests/e2e/live-mode.spec.js`, `live-display.spec.js`, `live-logs.spec.js` — mocked WebSocket payloads. Update the mocked `valve_states` shape.
- `tests/e2e/staged-valves.spec.js` — depends on the `opening` / `queued_opens` / `pending_closes` fields but does not enumerate valve names directly. Confirm it still passes.
