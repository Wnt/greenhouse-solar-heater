# Phase 0 Research: Remove V_ret Valve from Collector Top

This research phase resolves every open question in the spec's Technical Context before Phase 1 design artifacts are written. All five items are concrete questions about the existing codebase, not unknowns about external systems.

---

## R1. Does the persisted device configuration enumerate valve names?

**Question**: The spec must avoid leaving a stale `v_ret` field in persisted state after the rename. The server persists device config to S3 (`device-config.json`), the Shelly device persists it to KVS, and both are loaded on boot. If the persisted shape enumerates valve names, existing deployments will carry a stale `v_ret` field.

**Investigation**: Read `server/lib/device-config.js:16-28`. The `DEFAULT_CONFIG` object uses compact keys to fit Shelly KVS's 256-byte limit:

```js
var DEFAULT_CONFIG = {
  ce: false,  // controls_enabled
  ea: 0,      // enabled_actuators bitmask (valves=1, pump=2, fan=4, sh=8, ih=16)
  fm: null,   // forced_mode
  am: null,   // allowed_modes
  v: 1,       // version
};
```

The `ea` (enabled_actuators) field is a **bitmask over actuator classes** — not a per-valve flag. The entire valve group is represented by a single bit. No valve-name keys appear anywhere in the schema.

Grep of `server/lib/device-config.js` for `v_ret`: **0 matches**.

**Decision**: No persistence migration needed. The compact schema is valve-agnostic by design (to fit the KVS limit), and removing `v_ret` from the code does not leave a stale persisted field. The `ea` bitmask stays the same — the "valves" bit still means "valves enabled", just covering 7 motorized valves instead of 8.

**Rationale**: Compact keys were introduced by 018-configure-sensor-connectors specifically for KVS compatibility. The valve-agnostic representation is a fortunate side-effect that makes hardware topology changes cheap.

**Alternatives considered**: (a) Define a schema migration that strips `v_ret` from any loaded config — rejected, no `v_ret` key exists to strip. (b) Increment the `v` (version) field to force clients to refresh — rejected, the shape didn't change.

---

## R2. How does `topology-layout.yaml` represent the collector-top junction, and how do I add a passive T joint?

**Question**: The generator for `system-topology.drawio` reads `topology-layout.yaml`. I need to know whether the layout has a concept of "passive junction / T joint" or whether it only supports components + valves + pipes, so I can plan the edit.

**Investigation**: Read `design/diagrams/topology-layout.yaml`:

- **Collector top currently**: two pipes both start at `{component: collectors, port: top}` — one routes to `v_ret.left`, the other (with a waypoint) routes to `v_air.left`. A third pipe goes from `v_ret.right` to `reservoir.top`. There is NO explicit junction vertex — the "Y" is implicit in the shared source port.
- **Existing valves section** (lines 202-210) declares `v_ret` and `v_air` as cells with absolute geometry inside the `coll_top_manifold` container.
- **Existing labels** (lines 104-111) include `v_ret_to_label: "→ reservoir"` and `v_air_to_label: "→ air intake"` as free-floating text annotations.
- **Reservoir ports** currently: `left (0, 0.5)`, `right (1, 0.5)`, `bottom (0.5, 1)`, `top (0.5, 0)`. The water line annotation sits at y≈325 (outside the shape).

**Decision**: Represent the T joint implicitly by routing a new pipe directly from `{component: collectors, port: top}` to a new reservoir port. Specifically:

1. **Delete** the `v_ret` valve entry from the `valves:` section (lines 202-206).
2. **Delete** the `v_ret_to_label` text annotation (lines 104-107).
3. **Delete** the two pipes `pipe_coll_top_vret` and `pipe_vret_reservoir`.
4. **Add** a new pipe `pipe_coll_top_reservoir` that goes directly from `{component: collectors, port: top}` to a new reservoir port `left_submerged: {x: 0, y: 0.7}` (added to the reservoir component's `ports:` map). `y: 0.7` visually places the entry point below the reservoir's vertical midpoint — i.e. below the conceptual water line. Waypoints follow the same path as the deleted `pipe_vret_reservoir` so the visual flow is continuous.
5. **Keep** the `pipe_coll_top_vair` pipe and the `v_air` valve entry unchanged.
6. **Rename** `v_air_to_label` to something like `collector_top_label` or just update its content to describe the T joint (e.g. "→ reservoir (below water) / air intake") — or keep `v_air_to_label` and add a new label for the reservoir path.

**Rationale**: The existing layout already treats the collector-top "branch point" as implicit, so adding or removing branches is a data edit only. Introducing a synthetic junction vertex would require new generator logic (see the Alternatives); avoiding that keeps the feature fully mechanical. The drift-check test (`tests/topology-diagram.test.js`) will catch any mismatch between the generator and the committed drawio.

**Alternatives considered**:

- **Explicit junction vertex** — add a new `components: t_junction_coll_top` entry with tiny geometry and three ports. Rejected: requires new generator validation logic, adds a non-component to the components section, and provides no visual benefit because the Y is already clear from the shared source port.
- **Route through `v_air`** — leave the existing `pipe_coll_top_vair` and have the reservoir pipe originate at `v_air.right`. Rejected: this would visually imply water flows *through* V_air during normal operation, which is wrong — V_air is closed and the water flows around it through the T joint.
- **Use existing `reservoir.top` port** — reuse the port that `pipe_vret_reservoir` currently terminates at. Rejected: `reservoir.top` is at y=0 (top of shape), which reads as "above water line" — exactly the wrong signal. A new `left_submerged` port at y=0.7 visually communicates "below water line".

---

## R3. Where is the playground schematic SVG defined, and how do I edit the `V-ret` markup?

**Question**: The spec says the playground schematic must depict the T joint with only `V_air` at the collector top. I need to know whether the schematic is inlined in HTML, loaded from an SVG file, or built programmatically in JavaScript, so I can plan the correct edit.

**Investigation**: Grepped `playground/index.html` for `svg` and `schematic`:

- `playground/index.html:318`: `<div id="schematic" class="svg-container"></div>` — the schematic is an empty container that is populated at runtime.
- `playground/js/main.js:1675`: `function buildSchematic()` assigns `svg.innerHTML = \`<svg ...>...</svg>\`` — a JS template literal.
- Inside that template (lines 1714-1715): `<text x="170" y="16" fill="#ee7d77" font-size="8">V-ret → reservoir</text>` plus the corresponding red `path` from `80,40` through `80,20` → `340,20` → `340,48`.
- Lines 1730-1731 (V_air): `<text x="135" y="12" fill="#dab53d" font-size="8">V-air (open)</text>` plus a yellow `path`.
- The only `v_ret` reference in `playground/index.html` is the relay-control button at line 493 (`data-relay="v_ret"`).

**Decision**: Edit `playground/js/main.js` `buildSchematic()` function directly:

1. **Remove** the `V-ret → reservoir` `<text>` and its preceding red `<path>` (lines ~1714-1715).
2. **Replace with** a new `<path>` representing the permanent T-joint-to-reservoir connection — the user wants it visible and clearly labelled (e.g. "T → reservoir"). Use a neutral blue (#64b5f6) to match the "water" colour family, not red (which signals hot water) and not dashed (which signals gas/vent).
3. **Keep** the V-air `<text>` and `<path>` unchanged — V_air is still there.
4. **Remove** the `data-relay="v_ret"` button from `playground/index.html:493`.

No separate SVG file to edit. No `design/Stitch/` changes (mockups are not wired to code). The Schematic view in the playground also has no references to `v_ret` outside the `buildSchematic()` template.

**Rationale**: The template literal is the single source of truth for the playground's schematic view; the `<div id="schematic">` container exists only to receive the rendered markup. There are no fallback code paths that might re-render a different schematic.

**Alternatives considered**:

- **Load schematic from `design/diagrams/system-topology.svg`** — would decouple the playground from the JS template, but is a bigger refactor, out of scope. Noted for a future improvement.
- **Use the generated `.drawio`** — not viable; the drawio format is not renderable in-browser.

---

## R4. Does the Shelly linter SH-014 rule affect this feature?

**Question**: Commit `4240904` (Fix Shelly crash: replace Array.sort() with pre-sorted iteration) added the `VALVE_NAMES_SORTED` constant to avoid `Array.prototype.sort()` and tightened SH-014 to forbid `Array.sort()` and `Array.findLastIndex()`. I need to know whether this feature's edits risk violating SH-014.

**Investigation**: Grepped `shelly/lint/rules/index.js` for SH-014 — the rule flags `.sort(`, `.shift(`, `.unshift(`, `.splice(`, `.flat(`, `.flatMap(`, `.findLast(`, `.findLastIndex(` on arrays. My planned edits to `shelly/control-logic.js` and `shelly/control.js` are all *data edits* (remove items from literal arrays, remove one key from an object literal). No new function calls, no new loops that could introduce a forbidden method, no new use of `VALVE_NAMES_SORTED` beyond what already exists.

**Decision**: No linter action needed. The change is data-only. The existing pre-sorted iteration in `planValveTransition` and `buildSnapshotFromState` automatically picks up the 7-valve list.

**Rationale**: Removing `"v_ret"` from `VALVE_NAMES_SORTED` is an element-removal from a literal array. Iteration over it uses `for (var i = 0; i < arr.length; i++)`, which is ES5-safe. The ordering stays alphabetical.

**Alternatives considered**: None needed.

---

## R5. Screenshot regeneration — blocking or non-blocking?

**Question**: `playground/screenshots/` contains rendered captures of the playground views. The spec's FR-019 requires regeneration. Is this a blocking step or can it happen after the main changes?

**Investigation**: `npm run screenshots` runs `tests/e2e/take-screenshots.spec.js` with `playwright.screenshots.config.js`. It takes ~1-2 minutes and requires all other e2e tests to pass first (otherwise the screenshots capture broken state). No other tests or tooling consume the screenshots; they are purely documentation assets.

**Decision**: Regenerate screenshots as the final step, after all other changes land and `npm test` is green. The regenerated PNGs are committed alongside the rest of the feature.

**Rationale**: Screenshots are downstream documentation, not part of any programmatic check. Running them earlier would produce stale images that would be overwritten by the final run anyway. The spec's A6 explicitly marks screenshot regeneration as "non-blocking finishing step".

**Alternatives considered**:

- **Skip screenshot regeneration** — rejected, FR-019 is explicit.
- **Regenerate after each commit** — rejected, adds ~1-2 minutes to every intermediate step for no benefit.

---

## Summary

All five research items resolved without external research. No [NEEDS CLARIFICATION] markers remain. Design can proceed to Phase 1.
