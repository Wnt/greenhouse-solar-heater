# Playground schematic from generated SVG — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-drawn inline schematic in `playground/js/main.js` with a reusable module built from the generated topology SVG, highlighting active components/pipes per actual valve+pump state, and add a standalone component tester at `playground/schematic-tester.html`.

**Architecture:**
1. Generate a **playground-themed** SVG from `design/diagrams/topology-layout.yaml` (new `themes.playground` substitution map), checked into `playground/assets/`.
2. New module `playground/js/schematic.js` fetches & inlines the SVG, exposes `buildSchematic({container, svgUrl}) → { update, destroy }`. A pure helper `computeActivePipes(state)` is unit-tested against a data-only `schematic-topology.js`.
3. `main.js` loses its ~65 lines of inline SVG and calls `handle.update(toSchematicState(state, result))` on each tick.
4. New `schematic-tester.html` page loads the same module and drives it from mode presets + per-valve/actuator toggles. Not linked in SPA nav.

**Tech Stack:** Vanilla ES modules (browser), Node.js `node:test` + ESM `import()` for unit tests, Playwright 1.56 for e2e, existing drawio CLI pipeline (`generate-topology-svg.js`).

**Reference spec:** `design/docs/superpowers/specs/2026-04-11-playground-schematic-from-svg-design.md`

---

## Task 1: Add `themes.playground` substitution map to topology-layout.yaml

**Files:**
- Modify: `design/diagrams/topology-layout.yaml` (append to `themes:` block, ~line 82)

**Context:** The generator already supports themes — `themes.light` is the existing precedent. `applyThemeToStyle()` in `generate-topology.js` reads `themes.<name>.{fill,font,stroke}` as base-hex → base-hex substitution maps (alpha suffixes are preserved automatically). `canvas_background` overrides the diagram background rect for that theme.

The playground-theme palette matches the current inline schematic's Stitch colors: gold `#e9c349` (collectors), teal `#43aea4` (pump), coral `#ee7d77` (hot pipes / radiator). Blue `#42a5f5` supply and green `#76ff03` sensors are already correct and stay unchanged.

- [ ] **Step 1: Add the theme block**

Find `themes:` in `design/diagrams/topology-layout.yaml`. It currently contains a single `light:` child. Append a sibling `playground:` entry right after the final `light:` substitution row:

```yaml
  playground:
    # Dark canvas that matches Stitch --surface (#161a21). Not transparent —
    # we want the SVG to render consistently whether embedded in a card or
    # opened raw in a browser.
    canvas_background: "#161a21"
    fill:
      "#f9a825": "#e9c349"   # collector panel fill tint (alpha preserved)
      "#00695c": "#43aea4"   # pump fill tint
      "#ff5722": "#ee7d77"   # radiator fill tint
      "#f44336": "#ee7d77"   # space heater fill tint
      "#ff9800": "#ee7d77"   # fan fill tint (if present)
    font:
      "#f9a825": "#e9c349"   # collector labels
      "#4fc3f7": "#43aea4"   # pump labels
      "#ff5722": "#ee7d77"   # radiator labels
      "#ff8a65": "#ee7d77"   # radiator accent
      "#ef5350": "#ee7d77"   # hot pipe labels
      "#ef9a9a": "#ee7d77"   # hot pipe accent
    stroke:
      "#f9a825": "#e9c349"
      "#4fc3f7": "#43aea4"
      "#ff5722": "#ee7d77"
      "#ef5350": "#ee7d77"
      "#f44336": "#ee7d77"
```

- [ ] **Step 2: Smoke-test the generator with the new theme**

```bash
node design/diagrams/generate-topology.js --theme playground --output /tmp/playground.drawio
```

Expected: exit 0, writes `/tmp/playground.drawio`. Grep the result to confirm substitutions took effect:

```bash
grep -c '#e9c349' /tmp/playground.drawio
grep -c '#43aea4' /tmp/playground.drawio
grep -c '#ee7d77' /tmp/playground.drawio
```

Expected: all three counts ≥ 1 (exact values depend on how many cells reference each color).

- [ ] **Step 3: Commit**

```bash
git add design/diagrams/topology-layout.yaml
git commit -m "$(cat <<'EOF'
Add playground theme to topology-layout.yaml

Introduces a themes.playground substitution map matching the Stitch
palette used by the current inline schematic, in preparation for
reusing the generated topology SVG as the playground schematic.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Teach `generate-topology-svg.js` to honor `--theme` / `--output` and dark svg-theme

**Files:**
- Modify: `design/docs/pdf/generate-topology-svg.js`

**Context:** The existing script is hardcoded to light theme and `design/docs/pdf/system-topology.svg`. It runs `generate-topology.js --theme light --output <tmp>` and then `drawio --export --format svg --svg-theme light -o <final> <tmp>`. For a dark playground theme we need to (a) pass through a user-supplied theme name and (b) tell drawio to export in the matching svg-theme (dark for non-light themes, so drawio's `light-dark()` CSS resolves to the dark branch).

- [ ] **Step 1: Replace the hardcoded `main()` body with argparse + theme plumbing**

Open `design/docs/pdf/generate-topology-svg.js`. Replace the `main()` function (currently ~lines 33–60) with:

```js
function main() {
  const { theme, output } = parseArgs(process.argv.slice(2));
  const targetSvg = output
    ? path.resolve(process.cwd(), output)
    : OUTPUT_SVG;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-svg-'));
  const tmpDrawio = path.join(tmpDir, `system-topology-${theme}.drawio`);

  try {
    step(`generating ${theme}-theme drawio → ${rel(tmpDrawio)}`);
    runChecked('node', [GENERATOR, '--theme', theme, '--output', tmpDrawio]);

    // drawio's --svg-theme flag controls how `light-dark()` CSS functions
    // resolve in the exported SVG. Use "light" only for the light theme;
    // every other theme (dark, playground, …) takes the dark branch.
    const svgTheme = theme === 'light' ? 'light' : 'dark';

    step(`drawio CLI export (--svg-theme ${svgTheme}) → ${rel(targetSvg)}`);
    runChecked(DRAWIO_BIN, [
      '--export',
      '--format', 'svg',
      '--svg-theme', svgTheme,
      '-o', targetSvg,
      tmpDrawio,
    ]);

    const stats = fs.statSync(targetSvg);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(`\n✓ wrote ${rel(targetSvg)} (${sizeKB} KB)`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

function parseArgs(argv) {
  let theme = 'light';
  let output = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--theme') { theme = argv[++i]; continue; }
    if (a === '--output') { output = argv[++i]; continue; }
    throw new Error('Unknown argument: ' + a);
  }
  return { theme, output };
}
```

The rest of the file (`step`, `rel`, `runChecked`, module-level constants, and the `try { main() } catch` block at the bottom) stays unchanged.

- [ ] **Step 2: Regenerate the existing light SVG with the new code path**

Make sure the default (no args) path still works exactly as before:

```bash
npm run topology-svg
```

Expected: writes `design/docs/pdf/system-topology.svg`. Confirm the file is byte-identical to its previous version:

```bash
git diff --stat design/docs/pdf/system-topology.svg
```

Expected: no output (no changes). If there is a diff, the drawio CLI version may have changed — inspect, and if the diff is only in the XML/metadata header, regenerate and include the update in the commit.

- [ ] **Step 3: Commit**

```bash
git add design/docs/pdf/generate-topology-svg.js
git commit -m "$(cat <<'EOF'
Add --theme and --output flags to generate-topology-svg.js

Defaults are unchanged (light theme, design/docs/pdf/system-topology.svg).
Non-light themes export with --svg-theme dark so light-dark() CSS
functions resolve to their dark branches.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Generate & commit the playground SVG and drawio artifacts

**Files:**
- Modify: `package.json` (add npm script)
- Create: `playground/assets/system-topology.svg` (generated)
- Create: `playground/assets/system-topology.drawio` (generated, for drift check)

- [ ] **Step 1: Add the npm script**

In `package.json`, under `"scripts"`, add a sibling entry after `"topology-contrast"`:

```json
    "topology-svg-playground": "node design/docs/pdf/generate-topology-svg.js --theme playground --output playground/assets/system-topology.svg",
    "topology-drawio-playground": "node design/diagrams/generate-topology.js --theme playground --output playground/assets/system-topology.drawio"
```

- [ ] **Step 2: Create the assets directory**

```bash
mkdir -p playground/assets
```

- [ ] **Step 3: Generate both artifacts**

```bash
npm run topology-drawio-playground
npm run topology-svg-playground
```

Expected: both commands exit 0 and create `playground/assets/system-topology.drawio` and `playground/assets/system-topology.svg`.

- [ ] **Step 4: Smoke-check the generated SVG**

```bash
grep -c 'data-cell-id="pump"' playground/assets/system-topology.svg
grep -c 'data-cell-id="pipe_' playground/assets/system-topology.svg
grep -c '#e9c349' playground/assets/system-topology.svg
```

Expected: pump count = 1, pipe_* count ≥ 13, `#e9c349` count ≥ 1.

- [ ] **Step 5: Commit**

```bash
git add package.json playground/assets/system-topology.svg playground/assets/system-topology.drawio
git commit -m "$(cat <<'EOF'
Generate playground-themed topology SVG artifacts

Adds two npm scripts (topology-svg-playground,
topology-drawio-playground) and their outputs under
playground/assets/, used by the schematic module (next task).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Create `playground/js/schematic-topology.js` (PIPES data)

**Files:**
- Create: `playground/js/schematic-topology.js`

**Context:** Small data-only module. Consumed by `schematic.js` (next tasks) and exported for tests. Each entry keys a `data-cell-id` in the generated SVG. Two rule shapes:
- `valves: [list]` — active iff **all** listed valves are open (AND pump on when `needsPump`)
- `anyOf: [list]` — active iff **any** listed valve is open (AND pump on when `needsPump`)

The two passive pipes (`pipe_coll_top_reservoir`, `pipe_dip_reservoir`) carry flow in multiple modes depending on which manifold valve is open, which is why they use `anyOf`.

- [ ] **Step 1: Write the file**

Create `playground/js/schematic-topology.js` with this exact content:

```js
/**
 * Pipe → valve topology for the playground schematic.
 *
 * Each entry keys a `data-cell-id` in the generated topology SVG
 * (playground/assets/system-topology.svg). The rule determines whether
 * the pipe should render "active" (water flowing) given the current
 * valve + pump state.
 *
 * Rule shapes:
 *   valves: [a, b]  — active iff every listed valve is open
 *                     (AND pump on when needsPump)
 *   anyOf: [a, b]   — active iff any listed valve is open
 *                     (AND pump on when needsPump)
 *
 * When a new pipe is added to topology-layout.yaml, it MUST be added
 * here too. The schematic module warns at build time about any pipe
 * cell in the SVG that isn't in this map.
 */
export const PIPES = {
  // Input manifold stubs (tank side)
  pipe_tank_vibtm:         { valves: ['vi_btm'],  needsPump: true },
  pipe_vibtm_pump:         { valves: ['vi_btm'],  needsPump: true },
  pipe_reservoir_vitop:    { valves: ['vi_top'],  needsPump: true },
  pipe_vitop_pump:         { valves: ['vi_top'],  needsPump: true },
  pipe_collbtm_vicoll:     { valves: ['vi_coll'], needsPump: true },
  pipe_vicoll_pump:        { valves: ['vi_coll'], needsPump: true },

  // Output manifold stubs
  pipe_pump_vocoll:        { valves: ['vo_coll'], needsPump: true },
  pipe_vocoll_collbtm:     { valves: ['vo_coll'], needsPump: true },
  pipe_pump_vorad:         { valves: ['vo_rad'],  needsPump: true },
  pipe_vorad_radiator:     { valves: ['vo_rad'],  needsPump: true },
  pipe_rad_return:         { valves: ['vo_rad'],  needsPump: true },
  pipe_pump_votank:        { valves: ['vo_tank'], needsPump: true },
  pipe_votank_tank:        { valves: ['vo_tank'], needsPump: true },

  // Passive connections — flow direction depends on the active mode.
  // pipe_coll_top_reservoir:
  //   - solar_charging: vo_coll is open, water circulates collector→reservoir
  //   - active_drain:   vi_coll is open, water drains reservoir→collector
  // pipe_dip_reservoir:
  //   - solar_charging (return): vi_btm is open, return flows via dip tube
  //   - greenhouse_heating (supply): vi_top is open, supply flows via dip tube
  pipe_coll_top_reservoir: { anyOf: ['vo_coll', 'vi_coll'], needsPump: true },
  pipe_dip_reservoir:      { anyOf: ['vi_btm', 'vi_top'],   needsPump: true },
};

/**
 * All valve ids managed by the schematic. Used for default `data-active="false"`
 * initialization and to translate state updates into DOM mutations.
 */
export const VALVE_IDS = [
  'vi_btm', 'vi_top', 'vi_coll',
  'vo_coll', 'vo_rad', 'vo_tank',
  'v_air',
];

/**
 * Non-valve components whose activity is driven directly by state flags.
 * Mapping of cell id → state key.
 */
export const ACTUATOR_CELLS = {
  pump: 'pump',
  space_heater: 'space_heater',
  // v_air is already in VALVE_IDS; fan cell removed in spec 024
};

/**
 * Sensor cell id → state key under `state.sensors`. The schematic module
 * finds the label text node inside each sensor cell and replaces its
 * textContent with the formatted temperature.
 */
export const SENSOR_CELLS = {
  t_tank_top:    't_tank_top',
  t_tank_bottom: 't_tank_bottom',
  t_collector:   't_collector',
  t_greenhouse:  't_greenhouse',
  t_outdoor:     't_outdoor',
};
```

- [ ] **Step 2: Commit**

```bash
git add playground/js/schematic-topology.js
git commit -m "$(cat <<'EOF'
Add schematic-topology.js: pipe → valve activation rules

Data-only module consumed by the upcoming schematic.js. Declares
PIPES (activation rules per data-cell-id), VALVE_IDS, ACTUATOR_CELLS,
and SENSOR_CELLS.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Write the failing unit test for `computeActivePipes`

**Files:**
- Create: `tests/schematic.test.js`

**Context:** `computeActivePipes(state, pipes)` is the pure decision core of the schematic module. It takes a state object and the PIPES map and returns `{ [pipeId]: boolean }`. This is the only piece worth unit-testing — DOM mutation is covered by e2e.

The repo's tests use `node:test` with ES module `import` (auto-detected by Node). `playground-control.test.js` is the reference pattern.

- [ ] **Step 1: Write the test file**

Create `tests/schematic.test.js` with this content:

```js
/**
 * Unit tests for playground/js/schematic.js — specifically the pure
 * computeActivePipes() helper. DOM mutation is covered by the e2e tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeActivePipes } from '../playground/js/schematic.js';
import { PIPES } from '../playground/js/schematic-topology.js';

function state(overrides) {
  const base = {
    valves: {
      vi_btm: false, vi_top: false, vi_coll: false,
      vo_coll: false, vo_rad: false, vo_tank: false,
      v_air: false,
    },
    pump: false,
    fan: false,
    space_heater: false,
    sensors: {},
  };
  return {
    ...base,
    ...overrides,
    valves: { ...base.valves, ...(overrides && overrides.valves) },
  };
}

describe('computeActivePipes — idle baseline', () => {
  it('all pipes inactive when nothing is open', () => {
    const active = computeActivePipes(state({}), PIPES);
    for (const id of Object.keys(PIPES)) {
      assert.strictEqual(active[id], false, `${id} should be inactive`);
    }
  });

  it('pump running with all valves closed leaves every pipe inactive', () => {
    const active = computeActivePipes(state({ pump: true }), PIPES);
    for (const id of Object.keys(PIPES)) {
      assert.strictEqual(active[id], false, `${id} should be inactive`);
    }
  });
});

describe('computeActivePipes — solar_charging (vi_btm + vo_coll + pump)', () => {
  const s = state({
    pump: true,
    valves: { vi_btm: true, vo_coll: true },
  });
  const active = computeActivePipes(s, PIPES);

  it('lights up tank → vi_btm → pump → vo_coll → collector path', () => {
    const expected = [
      'pipe_tank_vibtm',
      'pipe_vibtm_pump',
      'pipe_pump_vocoll',
      'pipe_vocoll_collbtm',
    ];
    for (const id of expected) {
      assert.strictEqual(active[id], true, `${id} should be active`);
    }
  });

  it('lights up the passive collector-top and dip-reservoir return pipes', () => {
    assert.strictEqual(active.pipe_coll_top_reservoir, true);
    assert.strictEqual(active.pipe_dip_reservoir, true);
  });

  it('leaves greenhouse-heating and drain pipes inactive', () => {
    assert.strictEqual(active.pipe_pump_vorad, false);
    assert.strictEqual(active.pipe_pump_votank, false);
  });
});

describe('computeActivePipes — greenhouse_heating (vi_top + vo_rad + pump)', () => {
  const s = state({
    pump: true,
    valves: { vi_top: true, vo_rad: true },
  });
  const active = computeActivePipes(s, PIPES);

  it('lights up reservoir → vi_top → pump → vo_rad → radiator path', () => {
    for (const id of [
      'pipe_reservoir_vitop',
      'pipe_vitop_pump',
      'pipe_pump_vorad',
      'pipe_vorad_radiator',
      'pipe_rad_return',
    ]) {
      assert.strictEqual(active[id], true, `${id} should be active`);
    }
  });

  it('lights up the passive dip-reservoir supply pipe (vi_top branch)', () => {
    assert.strictEqual(active.pipe_dip_reservoir, true);
  });

  it('does NOT light up the passive collector-top pipe (no vo_coll/vi_coll)', () => {
    assert.strictEqual(active.pipe_coll_top_reservoir, false);
  });
});

describe('computeActivePipes — active_drain (vi_coll + vo_tank + v_air + pump)', () => {
  const s = state({
    pump: true,
    valves: { vi_coll: true, vo_tank: true, v_air: true },
  });
  const active = computeActivePipes(s, PIPES);

  it('lights up collector → vi_coll → pump → vo_tank → tank path', () => {
    for (const id of [
      'pipe_collbtm_vicoll',
      'pipe_vicoll_pump',
      'pipe_pump_votank',
      'pipe_votank_tank',
    ]) {
      assert.strictEqual(active[id], true, `${id} should be active`);
    }
  });

  it('lights up the passive collector-top pipe (vi_coll branch)', () => {
    assert.strictEqual(active.pipe_coll_top_reservoir, true);
  });
});

describe('computeActivePipes — pump off with valves open', () => {
  it('no pipe is active when pump is off, even if valves are open', () => {
    const s = state({
      pump: false,
      valves: { vi_btm: true, vo_coll: true },
    });
    const active = computeActivePipes(s, PIPES);
    for (const id of Object.keys(PIPES)) {
      assert.strictEqual(active[id], false, `${id} should be inactive`);
    }
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
node --test tests/schematic.test.js
```

Expected: failure with `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ... playground/js/schematic.js` (because the module doesn't exist yet).

- [ ] **Step 3: Commit the failing test**

```bash
git add tests/schematic.test.js
git commit -m "$(cat <<'EOF'
Add failing unit tests for computeActivePipes

Covers idle baseline, solar_charging, greenhouse_heating, active_drain,
and pump-off edge case. Next task implements the function.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Implement `computeActivePipes` in `playground/js/schematic.js`

**Files:**
- Create: `playground/js/schematic.js`

**Context:** First skeleton of the module. Only implements the pure helper needed by the unit tests. `buildSchematic` and DOM code come in the next task.

- [ ] **Step 1: Create the skeleton with `computeActivePipes`**

Write `playground/js/schematic.js` with this content:

```js
/**
 * Playground schematic module.
 *
 * Public API:
 *   buildSchematic({ container, svgUrl })
 *     → Promise<{ update(state), destroy() }>
 *   handle.update(state)
 *     → Mutates the inlined SVG to reflect valve/pump/sensor state.
 *
 * Pure helpers exported for testing:
 *   computeActivePipes(state, pipes) → { [pipeId]: boolean }
 *
 * State shape:
 *   {
 *     valves: { vi_btm, vi_top, vi_coll, vo_coll, vo_rad, vo_tank, v_air },
 *     pump: boolean,
 *     fan: boolean,
 *     space_heater: boolean,
 *     sensors: { t_tank_top, t_tank_bottom, t_collector, t_greenhouse, t_outdoor },
 *   }
 */

import {
  PIPES,
  VALVE_IDS,
  ACTUATOR_CELLS,
  SENSOR_CELLS,
} from './schematic-topology.js';

/**
 * Pure: given a state object and a PIPES map, compute which pipes should
 * render "active" (water flowing). Returns a new object keyed by pipe id
 * with boolean values.
 */
export function computeActivePipes(state, pipes) {
  const result = {};
  const valves = (state && state.valves) || {};
  const pump = !!(state && state.pump);

  for (const id of Object.keys(pipes)) {
    const rule = pipes[id];
    const flowing = !rule.needsPump || pump;
    let open;
    if (rule.valves) {
      open = rule.valves.every((v) => !!valves[v]);
    } else if (rule.anyOf) {
      open = rule.anyOf.some((v) => !!valves[v]);
    } else {
      open = false;
    }
    result[id] = flowing && open;
  }
  return result;
}

// buildSchematic() and applyState() come in Task 7.
export async function buildSchematic() {
  throw new Error('buildSchematic not implemented yet');
}
```

- [ ] **Step 2: Run the unit tests — expect pass**

```bash
node --test tests/schematic.test.js
```

Expected: all tests pass. `describe` blocks report PASS, no failures.

- [ ] **Step 3: Commit**

```bash
git add playground/js/schematic.js
git commit -m "$(cat <<'EOF'
Implement computeActivePipes in schematic.js

Pure flow-logic helper keyed on the PIPES topology map. The module
also exposes a placeholder buildSchematic that throws — filled in
by the next task.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Implement `buildSchematic` + `applyState` DOM mutation

**Files:**
- Modify: `playground/js/schematic.js`

**Context:** Second half of the schematic module. Fetches the SVG, inlines it, injects a `<style>` block with the highlighting CSS, initializes every managed cell to `data-active="false"`, and applies state on update. No unit test — covered by the e2e test in Task 12.

- [ ] **Step 1: Replace the placeholder `buildSchematic`**

In `playground/js/schematic.js`, replace the final `export async function buildSchematic()` (the placeholder from Task 6) with this complete implementation:

```js
const STYLE_TAG_ID = 'schematic-base-styles';

const BASE_CSS = `
/* Default: managed cells render dim until update() is called */
[data-cell-id][data-active="false"] { opacity: 0.15; transition: opacity 180ms; }
[data-cell-id][data-active="true"]  { opacity: 1.00; transition: opacity 180ms; }

/* Valves stay a bit more visible than pipes when closed */
[data-cell-id^="vi_"][data-active="false"],
[data-cell-id^="vo_"][data-active="false"],
[data-cell-id^="v_"][data-active="false"]  { opacity: 0.30; }

/* Pump gets a teal highlight when on */
[data-cell-id="pump"][data-active="true"] path,
[data-cell-id="pump"][data-active="true"] ellipse { stroke: #43aea4; }
`;

/**
 * Fetch the SVG at `svgUrl`, inject it into `container`, install base styles,
 * initialize managed cells to data-active="false", and return a handle.
 */
export async function buildSchematic({ container, svgUrl }) {
  if (!container) throw new Error('buildSchematic: container is required');
  if (!svgUrl) throw new Error('buildSchematic: svgUrl is required');

  const res = await fetch(svgUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${svgUrl}: ${res.status}`);
  }
  const svgText = await res.text();
  container.innerHTML = svgText;

  const svgEl = container.querySelector('svg');
  if (!svgEl) throw new Error('buildSchematic: no <svg> element found in response');

  installBaseStyles(svgEl);
  initializeManagedCells(svgEl);

  return {
    update(state) {
      if (!state) return;
      applyState(svgEl, state);
    },
    destroy() {
      container.innerHTML = '';
    },
  };
}

function installBaseStyles(svgEl) {
  if (svgEl.querySelector('#' + STYLE_TAG_ID)) return;
  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.id = STYLE_TAG_ID;
  style.textContent = BASE_CSS;
  svgEl.insertBefore(style, svgEl.firstChild);
}

function initializeManagedCells(svgEl) {
  const ids = [
    ...VALVE_IDS,
    ...Object.keys(ACTUATOR_CELLS),
    ...Object.keys(PIPES),
  ];
  for (const id of ids) {
    const cell = svgEl.querySelector(`[data-cell-id="${id}"]`);
    if (cell) cell.setAttribute('data-active', 'false');
  }
  // Warn about pipe cells in the SVG that aren't in the PIPES map — catches
  // "added a pipe to topology-layout.yaml but forgot schematic-topology.js"
  const pipeCells = svgEl.querySelectorAll('[data-cell-id^="pipe_"]');
  for (const cell of pipeCells) {
    const id = cell.getAttribute('data-cell-id');
    if (!PIPES[id] && typeof console !== 'undefined') {
      console.warn('[schematic] pipe cell has no PIPES entry:', id);
    }
  }
}

function applyState(svgEl, state) {
  // Valves
  for (const vid of VALVE_IDS) {
    const cell = svgEl.querySelector(`[data-cell-id="${vid}"]`);
    if (cell) cell.setAttribute('data-active', state.valves && state.valves[vid] ? 'true' : 'false');
  }

  // Actuator components (pump, space_heater, ...)
  for (const [cellId, stateKey] of Object.entries(ACTUATOR_CELLS)) {
    const cell = svgEl.querySelector(`[data-cell-id="${cellId}"]`);
    if (cell) cell.setAttribute('data-active', state[stateKey] ? 'true' : 'false');
  }

  // Pipes — computed from valve + pump state
  const activePipes = computeActivePipes(state, PIPES);
  for (const [pipeId, isActive] of Object.entries(activePipes)) {
    const cell = svgEl.querySelector(`[data-cell-id="${pipeId}"]`);
    if (cell) cell.setAttribute('data-active', isActive ? 'true' : 'false');
  }

  // Sensor temperature labels
  if (state.sensors) {
    for (const [cellId, stateKey] of Object.entries(SENSOR_CELLS)) {
      const val = state.sensors[stateKey];
      const text = formatTemp(val);
      updateSensorLabel(svgEl, cellId, text);
    }
  }
}

function formatTemp(v) {
  if (v == null || !Number.isFinite(v)) return '--°C';
  return v.toFixed(1) + '°C';
}

function updateSensorLabel(svgEl, cellId, text) {
  const cell = svgEl.querySelector(`[data-cell-id="${cellId}"]`);
  if (!cell) return;
  // drawio renders cell labels as either <text> or a foreignObject <div>.
  // Try text first, fall back to the deepest <div> inside any foreignObject.
  const textEl = cell.querySelector('text');
  if (textEl) {
    textEl.textContent = text;
    return;
  }
  const fo = cell.querySelector('foreignObject');
  if (fo) {
    const divs = fo.querySelectorAll('div');
    const target = divs[divs.length - 1];
    if (target) target.textContent = text;
  }
}
```

- [ ] **Step 2: Re-run the unit tests to confirm nothing regressed**

```bash
node --test tests/schematic.test.js
```

Expected: all tests still pass — `computeActivePipes` behavior unchanged.

- [ ] **Step 3: Commit**

```bash
git add playground/js/schematic.js
git commit -m "$(cat <<'EOF'
Implement buildSchematic + applyState DOM mutation

Fetches the playground-themed SVG, injects it into the container,
installs a base CSS <style> block, initializes managed cells to
data-active="false", and mutates cell attributes + sensor labels
on each update() call. Sensor labels handle both drawio text
elements and foreignObject div fallbacks.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire the schematic module into `playground/js/main.js`

**Files:**
- Modify: `playground/js/main.js` — imports, delete inline `buildSchematic`/`updateSchematic` (~65 lines at 1673–1789), add `toSchematicState` adapter, replace call sites

**Context:** The existing code has:
- `buildSchematic()` called at `main.js:638` that draws the inline SVG markup
- `updateSchematic(state, result)` called at `main.js:1450` that mutates ids like `s-t-top`, `pipe-solar`, `s-pump`
- Both functions defined at `main.js:1673–1789`

All three call sites / definitions must change. The replacement wires the module's handle through a module-scoped variable.

- [ ] **Step 1: Add the import at the top of main.js**

Find the existing imports near the top of `playground/js/main.js`. Add one more line near the other playground imports:

```js
import { buildSchematic as buildSchematicFromSvg } from './schematic.js';
```

(The alias avoids a name collision with the soon-to-be-deleted local `buildSchematic`.)

- [ ] **Step 2: Replace the inline `buildSchematic()` call at line 638**

Find the line in `main.js` that calls `buildSchematic();` (approximately line 638, inside the code that runs on view load). Replace it with:

```js
  // Schematic view — async build, handle held in module scope
  (async () => {
    try {
      schematicHandle = await buildSchematicFromSvg({
        container: document.getElementById('schematic'),
        svgUrl: './assets/system-topology.svg',
      });
      // If a result is already available, apply it immediately
      if (lastState && lastResult) {
        schematicHandle.update(toSchematicState(lastState, lastResult));
      }
    } catch (err) {
      console.error('[schematic] build failed:', err);
      const el = document.getElementById('schematic');
      if (el) el.textContent = 'Failed to load schematic';
    }
  })();
```

Also add these module-scoped vars near the top of the file (next to other module-scoped state like `model`, `controller`, etc.):

```js
let schematicHandle = null;
let lastState = null;
let lastResult = null;
```

- [ ] **Step 3: Replace the `updateSchematic(state, result)` call at line 1450**

Find the line `updateSchematic(state, result);` in `main.js` (around line 1450 inside `updateDisplay`). Replace it with:

```js
    lastState = state;
    lastResult = result;
    if (schematicHandle) {
      schematicHandle.update(toSchematicState(state, result));
    }
```

- [ ] **Step 4: Delete the inline `buildSchematic()`, `updateSchematic()`, `setText`, and `setOpacity`**

Find the block at approximately `main.js:1673–1789` that defines:

- `function buildSchematic()` (~line 1674)
- `function updateSchematic(state, result)` (~line 1741)
- `function setText(id, text)` (~line 1782)
- `function setOpacity(id, val)` (~line 1786)

All four are only used inside `updateSchematic` / `buildSchematic` (verify with `grep -n 'setText\|setOpacity' playground/js/main.js` — expected: only the 1747–1774 call sites inside `updateSchematic`, plus the function definitions). Delete all four functions.

- [ ] **Step 5: Add the `toSchematicState` adapter**

In the same region where the old inline functions used to live, add:

```js
function toSchematicState(state, result) {
  if (!state || !result) return null;
  const valves = result.valves || {};
  const actuators = result.actuators || {};
  return {
    valves: {
      vi_btm:  !!valves.vi_btm,
      vi_top:  !!valves.vi_top,
      vi_coll: !!valves.vi_coll,
      vo_coll: !!valves.vo_coll,
      vo_rad:  !!valves.vo_rad,
      vo_tank: !!valves.vo_tank,
      v_air:   !!valves.v_air,
    },
    pump:         !!actuators.pump,
    fan:          !!actuators.fan,
    space_heater: !!actuators.space_heater,
    sensors: {
      t_tank_top:    state.t_tank_top,
      t_tank_bottom: state.t_tank_bottom,
      t_collector:   state.t_collector,
      t_greenhouse:  state.t_greenhouse,
      t_outdoor:     state.t_outdoor,
    },
  };
}
```

- [ ] **Step 6: Smoke-test: serve the playground and load the schematic view**

```bash
npx serve -l 3210 .
```

In another terminal:

```bash
open http://localhost:3210/playground/#schematic
```

Expected: the schematic view loads, SVG renders with the playground-themed dark palette. Cells are dim until the simulation starts, then valves/pipes light up as mode transitions happen. Check the browser console — no errors.

Kill the `npx serve` process when done.

- [ ] **Step 7: Commit**

```bash
git add playground/js/main.js
git commit -m "$(cat <<'EOF'
Wire playground schematic view to the new module

Replaces the inline hand-drawn schematic (~65 LOC) with a call to
buildSchematicFromSvg({container, svgUrl}) that fetches the generated
playground-themed topology SVG. A new toSchematicState() adapter
maps the existing (state, result) tick into the module's flat
state shape.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update `tests/e2e/thermal-sim.spec.js` selectors for new SVG structure

**Files:**
- Modify: `tests/e2e/thermal-sim.spec.js`

**Context:** The existing Playwright tests expect `#pipe-solar`, `#pipe-heating`, `#pipe-drain`, `#s-pump`, `#s-t-coll`, etc. — ids from the old inline SVG. None of those exist in the new generated SVG; assertions need to target `[data-cell-id="pipe_*"]` and friends.

- [ ] **Step 1: Audit the current spec for stale selectors**

```bash
grep -nE "#pipe-|#s-|s-pump|pipe-solar|pipe-heating|pipe-drain" tests/e2e/thermal-sim.spec.js
```

Expected: a list of lines referring to the old ids. Each one needs to be replaced.

- [ ] **Step 2: Replace the old selectors with `[data-cell-id="…"]` equivalents**

For every match in step 1, swap the selector. Reference mapping (use this table to choose the replacement):

| Old | New |
|---|---|
| `#pipe-solar` | (remove — no longer a group; assert on `[data-cell-id="pipe_pump_vocoll"][data-active="true"]` instead) |
| `#pipe-heating` | `[data-cell-id="pipe_pump_vorad"][data-active="true"]` |
| `#pipe-drain` | `[data-cell-id="pipe_pump_votank"][data-active="true"]` |
| `#s-pump` | `[data-cell-id="pump"]` |
| `#s-t-coll` | (removed — sensor labels now live inside `[data-cell-id="t_collector"]`; assert on `.textContent` of the nested label) |
| `#s-t-top` | `[data-cell-id="t_tank_top"]` |
| `#s-t-bot` | `[data-cell-id="t_tank_bottom"]` |
| `#s-t-gh`  | `[data-cell-id="t_greenhouse"]` |
| `#s-t-out` | `[data-cell-id="t_outdoor"]` |

Replace each assertion one at a time. For opacity checks, use `data-active`:

```js
// Old:
await expect(page.locator('#pipe-solar')).toHaveAttribute('opacity', '1');
// New:
await expect(page.locator('[data-cell-id="pipe_pump_vocoll"]'))
  .toHaveAttribute('data-active', 'true');
```

For text content:

```js
// Old:
await expect(page.locator('#s-t-coll')).toContainText('°C');
// New:
await expect(page.locator('[data-cell-id="t_collector"]')).toContainText('°C');
```

- [ ] **Step 3: Run the e2e test**

```bash
npx playwright test tests/e2e/thermal-sim.spec.js --project=chromium
```

Expected: all assertions pass. If any still target the old ids, fix them and re-run.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/thermal-sim.spec.js
git commit -m "$(cat <<'EOF'
Update thermal-sim e2e selectors for generated schematic SVG

Replaces old inline-SVG ids (#pipe-solar, #s-pump, #s-t-top, …)
with data-cell-id selectors from the generated topology SVG.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Create `playground/schematic-tester.html`

**Files:**
- Create: `playground/schematic-tester.html`

**Context:** Minimal standalone page. Uses the same Stitch CSS as the main playground, imports `js/schematic.js` and a new `js/schematic-tester.js` (next task). Not linked from SPA nav — reached by URL only.

- [ ] **Step 1: Write the HTML**

Create `playground/schematic-tester.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Schematic tester — Solar Heater</title>
  <link rel="stylesheet" href="./css/style.css">
  <style>
    body {
      margin: 0;
      background: var(--surface-container-lowest);
      color: var(--on-surface);
      font-family: 'Manrope', sans-serif;
    }
    .tester-layout {
      display: grid;
      grid-template-columns: 1fr 280px;
      gap: 24px;
      padding: 24px;
      min-height: 100vh;
      box-sizing: border-box;
    }
    .tester-schematic {
      background: var(--surface-container);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tester-schematic svg { width: 100%; height: auto; max-height: 90vh; }
    .tester-panel {
      background: var(--surface-container);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .tester-panel h3 {
      font-family: 'Newsreader', Georgia, serif;
      font-style: italic;
      font-size: 18px;
      margin: 0 0 8px;
      color: var(--on-surface);
    }
    .tester-panel .preset-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .tester-panel button {
      background: var(--surface-container-high);
      color: var(--on-surface);
      border: 1px solid var(--surface-bright);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .tester-panel button:hover {
      background: var(--primary);
      color: var(--surface-container-lowest);
    }
    .tester-panel label {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 2px 0;
      font-size: 13px;
      color: var(--on-surface-variant);
      cursor: pointer;
    }
    .tester-panel label input[type="checkbox"] { accent-color: var(--primary); }
    @media (max-width: 768px) {
      .tester-layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="tester-layout">
    <section id="schematic-container" class="tester-schematic"></section>
    <aside class="tester-panel">
      <div>
        <h3>Presets</h3>
        <div id="preset-buttons" class="preset-buttons"></div>
      </div>
      <div>
        <h3>Valves</h3>
        <div id="valve-toggles"></div>
      </div>
      <div>
        <h3>Actuators</h3>
        <div id="actuator-toggles"></div>
      </div>
    </aside>
  </main>
  <script type="module" src="./js/schematic-tester.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add playground/schematic-tester.html
git commit -m "$(cat <<'EOF'
Add schematic-tester.html: standalone component tester page

Minimal grid layout with a schematic canvas and a control panel
for presets + per-valve/actuator toggles. Not linked from SPA nav.
Uses the shared Stitch CSS. Logic wired by js/schematic-tester.js
(next task).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Create `playground/js/schematic-tester.js`

**Files:**
- Create: `playground/js/schematic-tester.js`

**Context:** The tester script. It hardcodes the 7 modes from `system.yaml` (no need to parse YAML at runtime — the valve/actuator states are small and stable). Picking a preset loads valve + actuator state into a local object, ticks the UI checkboxes, and calls `handle.update()`. Checkboxes mutate state and call `handle.update()`.

- [ ] **Step 1: Write the script**

Create `playground/js/schematic-tester.js`:

```js
/**
 * Standalone schematic component tester.
 *
 * Drives the reusable schematic module with either a mode preset
 * or individual valve/actuator toggles. No server, no auth, no
 * simulation — pure local state.
 */

import { buildSchematic } from './schematic.js';
import { VALVE_IDS } from './schematic-topology.js';

// Mode presets copied from system.yaml (modes.<name>.valve_states + .actuators).
// If system.yaml changes, update this table.
const PRESETS = {
  idle: {
    label: 'Idle',
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    pump: false, fan: false, space_heater: false,
  },
  solar_charging: {
    label: 'Solar charging',
    valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
    pump: true, fan: false, space_heater: false,
  },
  greenhouse_heating: {
    label: 'Greenhouse heating',
    valves: { vi_btm: false, vi_top: true, vi_coll: false, vo_coll: false, vo_rad: true, vo_tank: false, v_air: false },
    pump: true, fan: true, space_heater: false,
  },
  active_drain: {
    label: 'Active drain',
    valves: { vi_btm: false, vi_top: false, vi_coll: true, vo_coll: false, vo_rad: false, vo_tank: true, v_air: true },
    pump: true, fan: false, space_heater: false,
  },
  overheat_drain: {
    label: 'Overheat drain',
    valves: { vi_btm: false, vi_top: false, vi_coll: true, vo_coll: false, vo_rad: false, vo_tank: true, v_air: true },
    pump: true, fan: false, space_heater: false,
  },
  emergency_heating: {
    label: 'Emergency heating',
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    pump: false, fan: false, space_heater: true,
  },
};

const ACTUATORS = [
  { key: 'pump', label: 'Pump' },
  { key: 'fan', label: 'Fan' },
  { key: 'space_heater', label: 'Space heater' },
];

const state = {
  valves: Object.fromEntries(VALVE_IDS.map((v) => [v, false])),
  pump: false,
  fan: false,
  space_heater: false,
  sensors: {},
};

let handle = null;

async function init() {
  const container = document.getElementById('schematic-container');
  try {
    handle = await buildSchematic({
      container,
      svgUrl: './assets/system-topology.svg',
    });
  } catch (err) {
    container.textContent = 'Failed to load schematic: ' + err.message;
    console.error(err);
    return;
  }

  renderPresetButtons();
  renderValveToggles();
  renderActuatorToggles();
  applyPreset('idle');
}

function renderPresetButtons() {
  const host = document.getElementById('preset-buttons');
  host.innerHTML = '';
  for (const [key, preset] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.textContent = preset.label;
    btn.dataset.preset = key;
    btn.addEventListener('click', () => applyPreset(key));
    host.appendChild(btn);
  }
}

function renderValveToggles() {
  const host = document.getElementById('valve-toggles');
  host.innerHTML = '';
  for (const vid of VALVE_IDS) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.valve = vid;
    cb.addEventListener('change', () => {
      state.valves[vid] = cb.checked;
      tick();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(vid));
    host.appendChild(label);
  }
}

function renderActuatorToggles() {
  const host = document.getElementById('actuator-toggles');
  host.innerHTML = '';
  for (const a of ACTUATORS) {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.actuator = a.key;
    cb.addEventListener('change', () => {
      state[a.key] = cb.checked;
      tick();
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode(a.label));
    host.appendChild(label);
  }
}

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  for (const vid of VALVE_IDS) {
    state.valves[vid] = !!p.valves[vid];
  }
  state.pump = !!p.pump;
  state.fan = !!p.fan;
  state.space_heater = !!p.space_heater;
  syncCheckboxes();
  tick();
}

function syncCheckboxes() {
  for (const cb of document.querySelectorAll('[data-valve]')) {
    cb.checked = !!state.valves[cb.dataset.valve];
  }
  for (const cb of document.querySelectorAll('[data-actuator]')) {
    cb.checked = !!state[cb.dataset.actuator];
  }
}

function tick() {
  if (handle) handle.update(state);
}

init();
```

- [ ] **Step 2: Manual smoke test**

```bash
npx serve -l 3210 .
open http://localhost:3210/playground/schematic-tester.html
```

Expected: page loads, grid layout (schematic left, control panel right), `idle` preset is applied — every valve/pipe is dim. Click `Solar charging`: `vi_btm`, `vo_coll`, `pump` checkboxes tick; the collector-loop pipes and those valves light up. Click `Greenhouse heating`: `vi_top`, `vo_rad`, `pump`, `fan` tick; radiator loop pipes light up. Toggle individual valves to verify the schematic reacts.

Kill `npx serve` when done.

- [ ] **Step 3: Commit**

```bash
git add playground/js/schematic-tester.js
git commit -m "$(cat <<'EOF'
Add schematic-tester.js: standalone component tester logic

Wires preset buttons (7 modes from system.yaml) and per-valve /
actuator toggles to the shared schematic module. Pure local state,
no server calls.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Write the e2e test for the schematic tester

**Files:**
- Create: `tests/e2e/schematic-tester.spec.js`

**Context:** Playwright spec that loads the tester, clicks each preset, and asserts the expected `data-active="true"` set. All e2e tests in this repo import from `./fixtures.js`, NOT from `@playwright/test`.

- [ ] **Step 1: Write the spec**

Create `tests/e2e/schematic-tester.spec.js`:

```js
import { test, expect } from './fixtures.js';

test.describe('schematic tester', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/schematic-tester.html');
    // Wait for the SVG to be inlined
    await page.locator('#schematic-container svg').waitFor();
  });

  test('loads with idle preset — nothing active', async ({ page }) => {
    // All valves data-active="false"
    for (const vid of ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'false');
    }
    await expect(
      page.locator('[data-cell-id="pump"]')
    ).toHaveAttribute('data-active', 'false');
  });

  test('solar charging preset lights collector loop + passive coll-top pipe', async ({ page }) => {
    await page.getByRole('button', { name: 'Solar charging' }).click();

    // Valves that should be open
    for (const vid of ['vi_btm', 'vo_coll']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    // Valves that should be closed
    for (const vid of ['vi_top', 'vi_coll', 'vo_rad', 'vo_tank', 'v_air']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'false');
    }
    // Pipes that should be active
    for (const pid of [
      'pipe_tank_vibtm',
      'pipe_vibtm_pump',
      'pipe_pump_vocoll',
      'pipe_vocoll_collbtm',
      'pipe_coll_top_reservoir',
      'pipe_dip_reservoir',
    ]) {
      await expect(
        page.locator(`[data-cell-id="${pid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    // Pipes that must NOT be active in this mode
    for (const pid of ['pipe_pump_vorad', 'pipe_pump_votank']) {
      await expect(
        page.locator(`[data-cell-id="${pid}"]`)
      ).toHaveAttribute('data-active', 'false');
    }
    // Pump is on
    await expect(
      page.locator('[data-cell-id="pump"]')
    ).toHaveAttribute('data-active', 'true');
  });

  test('greenhouse heating preset lights radiator loop', async ({ page }) => {
    await page.getByRole('button', { name: 'Greenhouse heating' }).click();

    for (const vid of ['vi_top', 'vo_rad']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    for (const pid of ['pipe_pump_vorad', 'pipe_vorad_radiator', 'pipe_rad_return', 'pipe_dip_reservoir']) {
      await expect(
        page.locator(`[data-cell-id="${pid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    // collector-top pipe must NOT be active (vi_coll / vo_coll are both closed)
    await expect(
      page.locator('[data-cell-id="pipe_coll_top_reservoir"]')
    ).toHaveAttribute('data-active', 'false');
  });

  test('active drain preset lights drain path', async ({ page }) => {
    await page.getByRole('button', { name: 'Active drain' }).click();

    for (const vid of ['vi_coll', 'vo_tank', 'v_air']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    for (const pid of ['pipe_collbtm_vicoll', 'pipe_vicoll_pump', 'pipe_pump_votank', 'pipe_votank_tank']) {
      await expect(
        page.locator(`[data-cell-id="${pid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
  });

  test('toggling a valve checkbox updates the schematic', async ({ page }) => {
    // Start from idle (nothing active)
    await page.getByRole('button', { name: 'Idle' }).click();

    // Toggle vi_btm on — but pipe should NOT light (pump still off)
    await page.locator('[data-valve="vi_btm"]').check();
    await expect(
      page.locator('[data-cell-id="vi_btm"]')
    ).toHaveAttribute('data-active', 'true');
    await expect(
      page.locator('[data-cell-id="pipe_tank_vibtm"]')
    ).toHaveAttribute('data-active', 'false');

    // Now turn the pump on — pipe lights
    await page.locator('[data-actuator="pump"]').check();
    await expect(
      page.locator('[data-cell-id="pipe_tank_vibtm"]')
    ).toHaveAttribute('data-active', 'true');
  });
});
```

- [ ] **Step 2: Run the test**

```bash
npx playwright test tests/e2e/schematic-tester.spec.js --project=chromium
```

Expected: all tests pass. The Playwright config auto-starts `npx serve` on port 3210 (see `playwright.config.js`).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/schematic-tester.spec.js
git commit -m "$(cat <<'EOF'
Add e2e tests for schematic-tester.html

Covers idle/solar/greenhouse/drain presets and manual
valve/actuator toggling. Uses the shared fixtures.js fixture
to block Google Fonts and import test helpers.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Add playground-theme drift check to `tests/topology-diagram.test.js`

**Files:**
- Modify: `tests/topology-diagram.test.js`

**Context:** The existing test byte-compares `generateTopology()` (default dark theme) against the committed `design/diagrams/system-topology.drawio`. We add a second assertion for the playground theme against `playground/assets/system-topology.drawio`. The SVG output is not byte-checked (drawio CLI output is not deterministic across versions) — only the drawio intermediate.

**Reference — existing test pattern** (`tests/topology-diagram.test.js`):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { generateTopology } = require('../design/diagrams/generate-topology.js');

const DRAWIO_PATH = path.resolve(__dirname, '..', 'design', 'diagrams', 'system-topology.drawio');

test('system-topology.drawio is up-to-date with generator sources', () => {
  const { xml: expected } = generateTopology({ silent: true });
  const actual = fs.readFileSync(DRAWIO_PATH, 'utf8');
  // ...
});
```

`generateTopology({theme, silent})` is a CommonJS export that returns `{xml, cellCount}`. The signature already supports `theme: 'playground'`.

- [ ] **Step 1: Add a second `test()` block after the existing one**

At the bottom of `tests/topology-diagram.test.js` (after the closing `});` of the existing `test()`), append:

```js
const PLAYGROUND_DRAWIO_PATH = path.resolve(
  __dirname,
  '..',
  'playground',
  'assets',
  'system-topology.drawio',
);

test('playground/assets/system-topology.drawio is up-to-date (playground theme)', () => {
  const { xml: expected } = generateTopology({ theme: 'playground', silent: true });
  const actual = fs.readFileSync(PLAYGROUND_DRAWIO_PATH, 'utf8');

  if (actual !== expected) {
    const expectedLines = expected.split('\n');
    const actualLines = actual.split('\n');
    let firstDiffLine = -1;
    for (let i = 0; i < Math.max(expectedLines.length, actualLines.length); i++) {
      if (expectedLines[i] !== actualLines[i]) {
        firstDiffLine = i + 1;
        break;
      }
    }
    assert.fail(
      'playground/assets/system-topology.drawio is out of date.\n\n' +
        `  First differing line: ${firstDiffLine}\n` +
        `  Committed bytes: ${actual.length}\n` +
        `  Generated bytes: ${expected.length}\n\n` +
        'Regenerate and commit:\n' +
        '  npm run topology-drawio-playground\n' +
        '  npm run topology-svg-playground\n' +
        '  git add playground/assets/system-topology.drawio playground/assets/system-topology.svg\n',
    );
  }
});
```

No new `require` statements — `fs`, `path`, `test`, `assert`, and `generateTopology` are all already in scope from the existing file.

- [ ] **Step 2: Run the drift test**

```bash
node --test tests/topology-diagram.test.js
```

Expected: both the existing dark-theme drift assertion and the new playground-theme drift assertion pass.

- [ ] **Step 3: Commit**

```bash
git add tests/topology-diagram.test.js
git commit -m "$(cat <<'EOF'
Add drift check for playground-theme topology drawio

Byte-compares generateTopology({theme:'playground'}) against the
committed playground/assets/system-topology.drawio so regenerating
without committing the update fails fast.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

**Context:** Document the new module, the tester page, and the npm scripts so the next Claude session can find them without archaeology.

- [ ] **Step 1: Find the Playground Architecture section**

```bash
grep -n "## Playground Architecture" CLAUDE.md
```

- [ ] **Step 2: Update the file-relationships bullets**

Under the `playground/` block in `## File Relationships`, add two new bullet sub-items right after the `playground/js/` line:

```markdown
- `playground/js/schematic.js` → schematic rendering module: fetches the generated topology SVG, installs highlighting CSS, exposes `buildSchematic({container, svgUrl}) → { update, destroy }`. Pure helper `computeActivePipes(state, pipes)` is unit-tested
- `playground/js/schematic-topology.js` → PIPES data: per-pipe activation rules consumed by `computeActivePipes`
- `playground/js/schematic-tester.js` + `playground/schematic-tester.html` → standalone component tester with mode presets and per-valve/actuator toggles. Not linked from SPA nav, reached by direct URL
- `playground/assets/system-topology.svg` + `.drawio` → generated playground-theme topology (via `npm run topology-svg-playground` / `topology-drawio-playground`)
```

- [ ] **Step 3: Update the drawio section to mention the playground theme**

Find the `### Light-theme PDF` subsection under `## drawio Topology Diagram`. After that subsection, add:

```markdown
### Playground-theme SVG

The playground's Schematic view is driven by `playground/assets/system-topology.svg`,
a playground-themed SVG generated from the same topology source. It uses the Stitch
dark palette (gold collectors, teal pump, coral radiator) and renders on a dark
card background.

Regenerate via:
- `npm run topology-drawio-playground` — writes `playground/assets/system-topology.drawio`
- `npm run topology-svg-playground`    — writes `playground/assets/system-topology.svg`

Drift check: `tests/topology-diagram.test.js` also byte-compares the playground-theme
drawio intermediate against the committed copy. The SVG itself is not byte-checked
(drawio CLI output varies across versions) — only the drawio file.

The playground-theme color substitutions live in `topology-layout.yaml` under
`themes.playground.{fill,font,stroke}`.
```

- [ ] **Step 4: Update Testing section**

Find `## Test Structure`. Add two new bullets under the unit tests list:

```markdown
- `tests/schematic.test.js` — unit tests for the pure `computeActivePipes` helper (solar/greenhouse/drain modes + pump-off edge cases)
```

And under the e2e tests list:

```markdown
- `tests/e2e/schematic-tester.spec.js` — Playwright e2e tests for the standalone component tester at `/playground/schematic-tester.html` (preset buttons + per-valve toggles)
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Document the playground schematic module and tester page in CLAUDE.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Full-test-suite gate

After every task above passes, run the full suite one final time before declaring done:

```bash
npm test
```

Expected: unit tests, simulation tests, and Playwright e2e tests all pass. If something fails, diagnose and fix before handing off. In particular, watch for:

- **Drift tests** — any accidental edit to `topology-layout.yaml` without regenerating both the dark-theme and playground-theme drawio files will fail the drift assertions.
- **Offline font blocking** — the e2e tests import from `./fixtures.js` to block Google Fonts. If a new test imports from `@playwright/test` directly, CI may hang waiting for fonts.

## Files touched (summary)

**Created:**
- `playground/js/schematic.js`
- `playground/js/schematic-topology.js`
- `playground/js/schematic-tester.js`
- `playground/schematic-tester.html`
- `playground/assets/system-topology.svg` (generated, committed)
- `playground/assets/system-topology.drawio` (generated, committed)
- `tests/schematic.test.js`
- `tests/e2e/schematic-tester.spec.js`

**Modified:**
- `design/diagrams/topology-layout.yaml` — `themes.playground`
- `design/docs/pdf/generate-topology-svg.js` — `--theme`/`--output` flags, dark svg-theme default
- `package.json` — `topology-svg-playground`, `topology-drawio-playground` scripts
- `playground/js/main.js` — removed inline schematic, added adapter + module wiring
- `tests/e2e/thermal-sim.spec.js` — updated selectors
- `tests/topology-diagram.test.js` — playground-theme drift assertion
- `CLAUDE.md` — document module, tester, and regeneration commands
