# Playground schematic from generated SVG — design

## Problem

The playground's Schematic view draws a 700×400 SVG inline in `playground/js/main.js`
(`buildSchematic` / `updateSchematic`, ~65 lines of string-concatenated SVG markup).
Highlighting is per-*mode*: three groups (`pipe-solar`, `pipe-heating`, `pipe-drain`)
toggle opacity based on `result.mode`. The diagram bakes in assumptions from the
pre-spec-024 topology (8-valve layout, collector-top return valve, fan) and cannot
reflect the actual valve-by-valve state that the new staged-opening scheduler
produces during transitions.

Meanwhile, `design/diagrams/system-topology.drawio` — generated from
`design/diagrams/topology-layout.yaml` — is the up-to-date 7-valve topology and
already carries every component as a `data-cell-id`-tagged element in its SVG
export. We should reuse it as the playground schematic so the two stay in lockstep.

## Goals

1. Replace the inline schematic with one built from the generated topology SVG,
   rendered in the Stitch dark palette so the visual feel of the current schematic
   is preserved.
2. Highlight by **actual valve and pump state**, not by mode label. Pipes light up
   only when both their endpoint valves are open and the pump is running.
3. Extract the schematic into a standalone, reusable module — no coupling to
   `main.js`, the global store, or the Shelly control-logic internals. One clear
   interface: `buildSchematic({container, svgUrl})` → handle; `handle.update(state)`.
4. Add a standalone component tester at `playground/schematic-tester.html` with
   mode presets plus individual valve/actuator toggles. The tester is not linked
   from the main SPA navigation.

## Non-goals

- Changing the committed dark-theme drawio or the light-theme PDF/SVG pipeline.
- Reworking control logic, mode decisions, or the staged-opening scheduler.
- Changing `system.yaml` or `topology-layout.yaml` beyond adding a theme block
  and (optionally) minor port metadata the schematic needs.
- Adding a new UI framework. The module is vanilla ES modules.

## Architecture

```
topology-layout.yaml  ──┐
                        │  generate-topology.js --theme playground
system.yaml  ───────────┤
                        ▼
               [tmp drawio in playground theme]
                        │  drawio CLI --svg-theme light
                        ▼
          playground/assets/system-topology.svg (committed)
                        │  fetch()
                        ▼
          schematic.js (buildSchematic + update)
             ▲                         ▲
             │                         │
          main.js                schematic-tester.html
        (live state)           (mode presets + toggles)
```

Three concerns, three units:

1. **Asset pipeline** — owned by the generator and the existing
   `design/docs/pdf/generate-topology-svg.js`, extended with a theme flag.
2. **Rendering module** — `playground/js/schematic.js`, the only code that knows
   how to mutate the SVG in response to state.
3. **Consumers** — `main.js` (live data source) and `schematic-tester.html`
   (manual toggles). Both pass the same flat state shape into `handle.update`.

## Unit 1 — asset pipeline

### `design/diagrams/topology-layout.yaml`

Add a `themes.playground` block alongside `themes.light`:

```yaml
themes:
  playground:
    canvas_background: "transparent"   # let the Stitch card surface show through
    fill:
      # Tint substitutions so the dark theme reads as the current playground palette
      "#f9a82520": "#e9c34920"   # collector panel tint
      "#4fc3f720": "#43aea420"   # pump fill tint (if any)
      "#ef572220": "#ee7d7720"   # radiator panel tint
    font:
      "#f9a825": "#e9c349"       # collector labels
      "#4fc3f7": "#43aea4"       # pump labels
      "#ff5722": "#ee7d77"       # radiator labels
      "#ff8a65": "#ee7d77"       # radiator accent
      "#ef5350": "#ee7d77"       # hot-pipe labels
      "#ef9a9a": "#ee7d77"       # hot-pipe accent
    stroke:
      "#f9a825": "#e9c349"
      "#4fc3f7": "#43aea4"
      "#ff5722": "#ee7d77"
      "#ef5350": "#ee7d77"
```

`#42a5f5` (supply blue) and `#76ff03` (sensor green) are already correct for the
playground palette and pass through unchanged. Canvas background is transparent
so the SVG inherits the card surface (`var(--surface)` ≈ `#161a21`).

### `design/diagrams/generate-topology.js`

No changes — it already supports `--theme <name>` and applies the substitution
map via `applyThemeToStyle` (added in the 024 branch work). `validateLayout()`
warns if a theme key is not a known substitution, nothing more.

### `design/docs/pdf/generate-topology-svg.js`

Already accepts the theme internally when called as a library. Extend the CLI
entry point: if invoked with `--theme <name> --output <path>`, pass those to
`generate-topology.js` and to the drawio export step. Default behavior
(no flags) stays the same — light theme → `design/docs/pdf/system-topology.svg`.

### `package.json`

Add one script:

```json
"topology-svg-playground": "node design/docs/pdf/generate-topology-svg.js --theme playground --output playground/assets/system-topology.svg"
```

The generated SVG is checked into git under `playground/assets/system-topology.svg`
so the playground has no drawio-CLI runtime dependency (mirrors the existing
light-theme artifact at `design/docs/pdf/system-topology.svg`).

## Unit 2 — rendering module

### `playground/js/schematic.js`

```js
// Public API
export async function buildSchematic({ container, svgUrl }) {
  const res = await fetch(svgUrl);
  const svgText = await res.text();
  container.innerHTML = svgText;
  const svgEl = container.querySelector('svg');
  applyBaseStyles(svgEl);         // inject the small CSS block (see below)
  return {
    update(state) { applyState(svgEl, state); },
    destroy()     { container.innerHTML = ''; },
  };
}
```

`applyBaseStyles` does two things:

1. Prepends a `<style>` element inside the SVG with the highlighting rules, so
   they travel with the inlined SVG and work both in the main playground and
   in the tester without CSS duplication.
2. Initializes every managed cell to `data-active="false"` so the default
   "nothing is flowing" state renders dimly even before the first `update()`
   call. Unmanaged cells (component bodies, labels, walls) are left alone.

```css
/* default: anything we manage is dimmed unless explicitly marked active */
[data-cell-id][data-active="false"]      { opacity: 0.15; transition: opacity 180ms; }
[data-cell-id][data-active="true"]       { opacity: 1.00; transition: opacity 180ms; }
/* valves stay a bit more visible than pipes when closed */
[data-cell-id^="vi_"][data-active="false"],
[data-cell-id^="vo_"][data-active="false"],
[data-cell-id^="v_"][data-active="false"]  { opacity: 0.30; }
/* pump gets a teal highlight when on */
[data-cell-id="pump"][data-active="true"] path,
[data-cell-id="pump"][data-active="true"] ellipse { stroke: #43aea4; }
```

"Managed cells" are: every pipe id, every valve id, `pump`, `fan`,
`space_heater`, and each sensor dot. The collector body, tank body, reservoir,
radiator, greenhouse walls, and all static labels stay at their natural
full-opacity rendering — they are scene, not state.

### State shape

```js
{
  valves: {
    vi_btm: false, vi_top: false, vi_coll: false,
    vo_coll: false, vo_rad: false, vo_tank: false,
    v_air:  false,
  },
  pump: false,
  fan: false,
  space_heater: false,
  sensors: {
    t_tank_top: null, t_tank_bottom: null,
    t_collector: null, t_greenhouse: null, t_outdoor: null,
  },
}
```

All seven valves are booleans. `v_air` is encoded in its physical polarity
(`true` = open). Polarity inversion relative to the relay is the caller's
responsibility — the schematic only cares about physical state.

### Flow topology map

A small data-only module `playground/js/schematic-topology.js` declares which
valves feed each pipe. Three shapes are supported:

- `valves: [a, b]` — pipe is active iff **all** listed valves are open
  (AND pump on when `needsPump`). The common case: a direct pipe with one
  valve at each end, or a manifold stub with one adjacent valve.
- `anyOf: [a, b, c]` — pipe is active iff **any** listed valve is open
  (AND pump on when `needsPump`). Used for the passive collector-top and
  dip-reservoir pipes that carry flow in multiple modes.

```js
export const PIPES = {
  // Tank-side manifold stubs
  pipe_tank_vibtm:      { valves: ['vi_btm'],  needsPump: true },
  pipe_vibtm_pump:      { valves: ['vi_btm'],  needsPump: true },
  pipe_reservoir_vitop: { valves: ['vi_top'],  needsPump: true },
  pipe_vitop_pump:      { valves: ['vi_top'],  needsPump: true },
  pipe_collbtm_vicoll:  { valves: ['vi_coll'], needsPump: true },
  pipe_vicoll_pump:     { valves: ['vi_coll'], needsPump: true },
  // Output manifold stubs
  pipe_pump_vocoll:     { valves: ['vo_coll'], needsPump: true },
  pipe_vocoll_collbtm:  { valves: ['vo_coll'], needsPump: true },
  pipe_pump_vorad:      { valves: ['vo_rad'],  needsPump: true },
  pipe_vorad_radiator:  { valves: ['vo_rad'],  needsPump: true },
  pipe_rad_return:      { valves: ['vo_rad'],  needsPump: true },
  pipe_pump_votank:     { valves: ['vo_tank'], needsPump: true },
  pipe_votank_tank:     { valves: ['vo_tank'], needsPump: true },
  // Passive connections — flow direction varies by mode, so "any of the
  // relevant manifold valves is open AND pump is on" is the right rule.
  // coll_top_reservoir carries flow in solar_charging (vo_coll) and
  // active_drain (vi_coll). dip_reservoir carries flow in solar_charging
  // (vi_btm return) and greenhouse_heating (vi_top supply).
  pipe_coll_top_reservoir: { anyOf: ['vo_coll', 'vi_coll'], needsPump: true },
  pipe_dip_reservoir:      { anyOf: ['vi_btm', 'vi_top'],   needsPump: true },
};
```

The complete list is derived from the `data-cell-id`s in the generated SVG
(every id that starts with `pipe_`). The implementation must iterate the SVG
at build time and warn about any pipe cell not present in `PIPES` so that
adding a pipe to the layout without also updating the topology map fails
loudly in development.

### `applyState(svgEl, state)`

Pure function of the SVG and the state object:

1. For each valve id, set `data-active="true|false"` on its `[data-cell-id=<id>]`.
2. For `pump`, `fan`, `space_heater`, set `data-active` accordingly.
3. For each pipe in `PIPES`, compute
   ```
   const flowing = !rule.needsPump || state.pump;
   const open = rule.valves
     ? rule.valves.every(v => state.valves[v])
     : rule.anyOf.some(v => state.valves[v]);
   const active = flowing && open;
   ```
   and set `data-active` on the pipe cell.
4. For each sensor entry, find its label node inside `[data-cell-id=<sensorId>]`
   and replace the text content with the formatted temperature (e.g. `"45.2°C"`,
   or `"--°C"` when null).

Total size: ~150 lines of module code, plus ~30 lines of topology data.

## Unit 3 — consumers

### `main.js` wiring

1. Import `buildSchematic` from `./schematic.js`.
2. Remove the inline `buildSchematic()` and `updateSchematic()` functions
   (`main.js:1673-1789`).
3. Keep a module-scoped `schematicHandle = null`.
4. At the existing `buildSchematic()` call site (`main.js:638`), call the new
   async `buildSchematic({container, svgUrl})`, await it, and store the handle.
5. Replace the `updateSchematic(state, result)` call at `main.js:1450` with
   `if (schematicHandle) schematicHandle.update(toSchematicState(state, result));`.
6. Add a small adapter:

```js
function toSchematicState(state, result) {
  return {
    valves: result.valves || {},
    pump: !!(result.actuators && result.actuators.pump),
    fan:  !!(result.actuators && result.actuators.fan),
    space_heater: !!(result.actuators && result.actuators.space_heater),
    sensors: {
      t_tank_top: state.t_tank_top,
      t_tank_bottom: state.t_tank_bottom,
      t_collector: state.t_collector,
      t_greenhouse: state.t_greenhouse,
      t_outdoor: state.t_outdoor,
    },
  };
}
```

The adapter lives in `main.js` because it touches the playground-specific
`result` object. `schematic.js` stays agnostic.

Before state arrives, `handle.update(null)` is a no-op and the schematic renders
fully dimmed (its natural default from the CSS rules).

### Standalone tester — `playground/schematic-tester.html`

A minimal HTML page:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Schematic tester</title>
  <link rel="stylesheet" href="./css/style.css">
</head>
<body>
  <main class="tester-layout">
    <section id="schematic-container" class="svg-container"></section>
    <aside class="tester-panel">
      <h3>Presets</h3>
      <div id="preset-buttons"></div>
      <h3>Valves</h3>
      <div id="valve-toggles"></div>
      <h3>Actuators</h3>
      <div id="actuator-toggles"></div>
    </aside>
  </main>
  <script type="module" src="./js/schematic-tester.js"></script>
</body>
</html>
```

And `playground/js/schematic-tester.js`:

- Fetches `./system.yaml` via the existing `yaml-loader.js`, reads
  `modes.<mode>.valve_states` + `modes.<mode>.actuators` for each of the seven
  operating modes (`idle`, `solar_charging`, `greenhouse_heating`, `active_drain`,
  `overheat_drain`, `emergency_heating`, `refill_collectors`).
- Renders one preset button per mode. Clicking a preset loads that mode's
  valve + actuator state into a local in-memory `state` object, reflects it in
  the toggle UI, and calls `handle.update(state)`.
- Renders one checkbox per valve and one per actuator. Toggling a checkbox
  mutates `state` and re-calls `handle.update(state)`.
- Initial state is the `idle` preset.
- No auth, no server calls, no WebSocket, no simulation. Pure local state.

Reached by typing the URL directly: `/<base>/schematic-tester.html`. Not
linked from the SPA nav. `server.js` already serves `playground/` as static
files, so no route changes are needed.

Layout CSS (a new section at the end of `playground/css/style.css`, scoped
under `.tester-layout`) uses CSS grid: schematic fills the left column, the
control panel is a ~260px right column. The page is single-screen on desktop
and stacks on mobile (`<768px`).

## Error handling

- `buildSchematic` rejects if the SVG fetch fails. Callers show a placeholder
  error message inside the container (`"Failed to load schematic"`) — already
  the pattern used for `sensors.js` and `yaml-loader.js`.
- `handle.update(null)` is a no-op. `handle.update({})` with a missing field is
  treated as "false/null" — no throw.
- Unknown valve ids in `state.valves` are ignored silently. Unknown pipe ids in
  `PIPES` are ignored silently (they just stay at their default opacity).
- The schematic tester page shows a loading spinner while fetching both
  `system.yaml` and `system-topology.svg`; if either fails, the page shows an
  inline error.

## Testing

### Unit tests

- **`tests/schematic-topology.test.js`** (new): for each operating mode, assert
  that the expected pipes light up. Drive `applyState` with that mode's
  `valve_states` and `actuators`, then read `data-active` attributes from a
  stub SVG. Covers each mode from `system.yaml` and a few edge cases (pump off
  with valves open → no pipe active; two input valves open concurrently →
  only the pipes to/from both light up).
- **`tests/schematic.test.js`** (new): `applyState` is a pure function of
  `(svgEl, state)`. Smoke-test that (a) valve toggles flip `data-active`,
  (b) sensor text content updates, (c) `null`/missing state leaves the DOM
  untouched.

### E2E tests

- **`tests/e2e/schematic-tester.spec.js`** (new): open
  `/playground/schematic-tester.html`, click each preset button, assert the
  expected set of cells carries `data-active="true"` and everything else
  `"false"`. Also toggle two valves manually and assert pipes react.
- **`tests/e2e/thermal-sim.spec.js`** (existing): update assertions that rely
  on the old `pipe-solar` / `pipe-heating` / `pipe-drain` group ids so they
  target `[data-cell-id^="pipe_"]` instead. No new test file — fix in place.

### Drift tests

- **`tests/topology-diagram.test.js`** (existing): add a second assertion that
  calls `generateTopology({theme: 'playground'})` and byte-compares against a
  committed `playground/assets/system-topology.drawio` intermediate. The drawio
  → SVG step is non-deterministic across drawio versions so the SVG artifact
  itself is not byte-checked — the drawio intermediate is.

## Migration & removal

- Remove `pipe-solar`, `pipe-heating`, `pipe-drain` group ids from any remaining
  code or tests.
- Remove the inline SVG string from `main.js` (≈65 lines).
- The Components view's valve grid (`#valve-grid`) is untouched — that's a
  separate UI element, not the schematic.

## Files touched

Modified:
- `design/diagrams/topology-layout.yaml` — add `themes.playground`
- `design/docs/pdf/generate-topology-svg.js` — honor `--theme`/`--output` flags
- `package.json` — new `topology-svg-playground` script
- `playground/js/main.js` — import module, remove inline SVG, add adapter
- `playground/css/style.css` — `.tester-layout` grid rules
- `tests/topology-diagram.test.js` — playground-theme drift assertion
- `tests/e2e/thermal-sim.spec.js` — update selectors
- `CLAUDE.md` — document the module and the tester page

New:
- `playground/js/schematic.js`
- `playground/js/schematic-topology.js`
- `playground/js/schematic-tester.js`
- `playground/schematic-tester.html`
- `playground/assets/system-topology.svg` (generated, committed)
- `playground/assets/system-topology.drawio` (generated, committed, for drift check)
- `tests/schematic.test.js`
- `tests/schematic-topology.test.js`
- `tests/e2e/schematic-tester.spec.js`
