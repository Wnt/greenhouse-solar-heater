# Phase 1 Data Model: Remove V_ret Valve from Collector Top

This feature has no new persistent data model. The "data model" here is the **in-memory + on-wire shape of valve state** plus the **source-of-truth representation** of the collector-top junction in `system.yaml`. One entity is removed, one is reshaped, one constraint is strengthened.

---

## Entities Removed

### `V_ret` (motorized valve)

**Was**: An on/off motorized ball valve (DN15, A83 9-24V DC actuator) at the top of the solar collector array. Its `relay_logic` was standard (relay ON = open, relay OFF = closed). It was driven by Shelly Pro 2PM `unit_4` relay `O1`, IP `192.168.30.14` id `0`. It appeared as the key `v_ret` in every mode's `valve_states` table, in the `VALVE_NAMES_SORTED` constant, in the `MODE_VALVES` mode table, in the Shelly `RELAY_MAP`, in `closeAllValves` / `seedValveOpenSinceOnBoot` / `currentSchedulerView` arrays, in the MQTT snapshot `valve_states` field, in the WebSocket broadcast, and in the playground UI (relay button, valve grid, schematic path + label).

**Now**: Removed entirely. No replacement entity — the motorized valve is gone; its former role is carried by a passive T joint (see Entities Reshaped).

**Affected fields**:

- `system.yaml → valves.collector_top.v_ret` — removed.
- `system.yaml → modes.*.valve_states.v_ret` — removed from every mode (`idle`, `solar_charging`, `greenhouse_heating`, `active_drain`, `overheat_drain`, `emergency_heating`).
- `system.yaml → valves.total_motorized` — 8 → 7 (and the "9 when wood burner added" comment → "8 when wood burner added").
- `system.yaml → control.shelly_components.shelly_pro_2pm.units.unit_4` — `O1` relay no longer maps to `v_ret`. Per FR-012, the default is to leave `O1` unassigned (reserved spare).
- `shelly/control-logic.js → VALVE_NAMES_SORTED` — array shrinks from 8 → 7 elements (stay alphabetically sorted).
- `shelly/control-logic.js → MODE_VALVES.*` — `v_ret` key removed from every mode table entry.
- `shelly/control-logic.js → buildSnapshotFromState` — stops copying `v_ret` into the returned `valve_states`.
- `shelly/control.js → RELAY_MAP.v_ret` — removed.
- `shelly/control.js → closeAllValves, seedValveOpenSinceOnBoot, currentSchedulerView` — `v_ret` removed from the valve-name arrays.
- `shelly/control.js → default state.valve_states` — `v_ret` key removed.
- `shelly/devices.conf` — `PRO4PM_VPN` / collector-top Shelly mapping comment lines that reference `v_ret` — removed or rewritten.
- `design/diagrams/topology-layout.yaml → valves.v_ret` — removed.
- `design/diagrams/topology-layout.yaml → labels.v_ret_to_label` — removed.
- `design/diagrams/topology-layout.yaml → pipes.pipe_coll_top_vret, pipe_vret_reservoir` — removed.
- `playground/js/main.js → valveNames, valveNameLabels, fallback modes object` — `v_ret` key removed from each.
- `playground/js/main.js → buildSchematic() template literal` — `V-ret → reservoir` path + label removed.
- `playground/index.html:493` — `<button data-relay="v_ret">` removed.
- MQTT `greenhouse/state` snapshot payload — `valve_states` object loses the `v_ret` key.
- WebSocket broadcast from `server/lib/mqtt-bridge.js` — mirrors the MQTT snapshot shape.

---

## Entities Reshaped

### Collector-top junction

**Was**: Two motorized valves (`V_ret` + `V_air`) on separate outlets from the collector top pipe, joined implicitly at the `collectors, port: top` source. The YAML described this as `valves.collector_top` with two child valve entries.

**Now**: A passive three-way T joint. Three branches:

1. **Collector-top pipe branch** (upward branch, from inside the collectors) — carries water up from the collector array.
2. **Reservoir branch** (horizontal / downward) — permanently connects to the reservoir, with the pipe's terminating end below the reservoir water line so no air can be drawn in.
3. **V_air branch** (upward, to atmosphere via the one remaining motorized valve) — opens only in drain modes.

The YAML now describes `valves.collector_top` as containing exactly one motorized valve (`v_air`) plus a prose description of the T joint; no separate entity is introduced for the joint itself (the T is implicit in the plumbing, same pattern as every other elbow/tee in the system).

**Invariants**:

- In every non-drain mode (idle, solar_charging, greenhouse_heating, emergency_heating): `V_air` is CLOSED, water fills both the collector branch and the reservoir branch of the T joint, the permanent siphon from collector top down to the reservoir is continuous, and sub-atmospheric pressure at the collector top is maintained (the 80 cm head difference to the reservoir still applies).
- In drain modes (active_drain, overheat_drain): `V_air` is OPEN, air enters the T joint, the siphon breaks, the reservoir-branch down-leg drains by gravity into the reservoir (small volume, ~0.5-1 L), and the pump actively evacuates the collector branch via `VI-coll` → pump → `VO-tank`.
- Power loss: normally-open `V_air` opens automatically; all other valves close (auto-return). The siphon breaks, the reservoir-branch down-leg drains, and the collector body remains filled (no passive drain — the pump is required for a full drain). This matches the existing fail-safe behaviour; the wording in `system.yaml` will be tightened per Edge Case "Power-loss fail-safe claim".

---

## Entities Unchanged (constraints strengthened)

### `V_air` (motorized valve)

**Unchanged** in hardware, wiring, relay, polarity, or per-mode state. The only change is that it is now the *sole* motorized valve at the collector top. Its `physical_wiring: normally-open`, inverted relay logic, and fail-safe description stay intact.

### `reservoir.connections.top_mid_inlet_2`

**Was** (in `system.yaml`): `pipe_from: V_ret (collector return), purpose: hot water returning from solar collectors`.

**Now**: `pipe_from: collector-top T joint (below water line), purpose: permanent connection carrying collector return water from the T joint into the reservoir; pipe terminates below the water line so the siphon cannot ingest air`. The "below water line" constraint is now explicitly part of the YAML description — it was implicit before and must become explicit to prevent accidental re-plumbing above the water line during construction.

### Reservoir port (topology layout)

**New port added**: `reservoir.ports.left_submerged: {x: 0, y: 0.7}` — a new named port on the reservoir component, visually placed below the component's vertical midpoint to signal "below water line". The new `pipe_coll_top_reservoir` terminates at this port.

---

## State Transitions

No scheduler state transitions change. The scheduler added by 023-limit-valve-operations operates on valve-name-keyed maps; shrinking those maps from 8 entries to 7 reduces the worst-case open-slot demand but does not alter any transition rule:

- `VALVE_TIMING.maxConcurrentOpens`: 2 (unchanged)
- `VALVE_TIMING.openWindowMs`: 20 000 (unchanged)
- `VALVE_TIMING.minOpenMs`: 60 000 (unchanged)
- `planValveTransition(target, current, openSince, opening, now, cfg)` input/output shape — unchanged.
- `toSchedulerView` / `fromSchedulerView` — only special-case `v_air`, continue to work as before.
- `buildSnapshotFromState` — returned `valve_states` shrinks from 8 → 7 keys; the `opening`, `queued_opens`, `pending_closes` arrays are computed from iteration over `VALVE_NAMES_SORTED` and automatically cover the 7-valve set.
- The 1000-iteration invariant fuzz test (`tests/control-logic.test.js`) runs against the updated 7-valve set as a regression check (SC-009).

---

## Validation Rules

No new validation rules. The existing rules continue to apply with the reduced valve set:

- **Manifold exclusivity (unchanged)**: exactly one input valve (`VI-btm`, `VI-top`, `VI-coll`) open at a time; exactly one output valve (`VO-coll`, `VO-rad`, `VO-tank`) open at a time.
- **Pump safety (unchanged)**: pump must be OFF before any valve change.
- **Dry-run protection (unchanged)**: pump power monitoring detects drained collectors during `active_drain` / `overheat_drain`.
- **`V_air` mode exclusivity (unchanged)**: `V_air` is OPEN only in drain modes.

**New**: the existing `VALVE_NAMES_SORTED` + `MODE_VALVES` sync constraint (introduced by commit `4240904` to avoid `Array.sort()`) now applies to a 7-valve set. Both lists must drop `v_ret` and remain in sync.

---

## No new persistent data

- No DB schema change (`server/lib/db.js` is sensor-readings + state-events, not per-valve flags).
- No S3 schema change (`device-config.json` uses compact keys, not valve names).
- No Shelly KVS schema change (device-side config stays under the 256-byte limit with unchanged keys).
- No auth / session / WebAuthn changes.

The feature is a source-of-truth + runtime-code correction with no persistence impact.
