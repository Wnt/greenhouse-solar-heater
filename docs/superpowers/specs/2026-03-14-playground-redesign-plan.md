# Playground Redesign — Implementation Plan

**Date:** 2026-03-14
**Design spec:** `docs/superpowers/specs/2026-03-14-playground-redesign-design.md`
**Status:** Draft

## Overview

8 steps, ordered by dependency. Steps 1–2 are deletions (risk-free). Steps 3–5 are the core retheme. Steps 6–7 fix tests. Step 8 updates docs.

---

## Step 1: Delete Linter Files

**Files to delete:**
- `playground/linter.html`
- `playground/js/linter.js`
- `playground/vendor/acorn.js`

**Why first:** Removes dead code before modifying shared files (CSS, nav). No other file imports `linter.js` or `acorn.js`.

**Verification:** `grep -r "linter\|acorn" playground/` should only return hits in CSS (`.lint-*` classes) and nav links — both addressed in later steps.

---

## Step 2: Delete 3D View Files

**Files to delete:**
- `playground/js/scene3d.js`
- `playground/vendor/three.module.js`
- `playground/vendor/three-addons/` (entire directory)

**Why second:** Removes 3D before editing `thermal.html`, so we don't accidentally break references.

**Verification:** `grep -r "scene3d\|three\|3[Dd]" playground/` — remaining hits will be in `thermal.html` (import map, inline script) and are cleaned up in Step 4.

---

## Step 3: Retheme `playground/css/style.css`

This is the largest single change. Do it before touching HTML so the light theme takes effect across all pages at once.

### 3a: Replace CSS Variables (line ~2–19)

Replace the dark palette block with the light palette from the design spec:

```css
--bg: #f5f7f8;
--bg-card: #ffffff;
--bg-input: #f0f2f5;
--border: #e2e6ea;
--text: #1e293b;
--text-muted: #64748b;
--text-bright: #0f172a;
```

Add new variable:
```css
--primary: #0056b2;
```

Keep all semantic colors (`--blue`, `--red`, `--yellow`, `--green`, `--purple`, `--orange`) unchanged — they're for schematic/simulation use.

### 3b: Card Styling (~line 62–71)

- Change `border-radius` from `8px` to `12px`
- Add `box-shadow: 0 1px 3px rgba(0,0,0,0.08)`
- Background uses `var(--bg-card)` (already does, but verify)

### 3c: Nav Header (~line 35–59)

- White background with subtle bottom border (`1px solid var(--border)`)
- Active link: `color: var(--primary)` with `border-bottom: 2px solid var(--primary)`
- Remove any dark card background on the nav

### 3d: Mode Badges (~line 129–153)

- Softer tint backgrounds for light theme (e.g., `background: #dbeafe` for solar, `#fee2e2` for heating, `#ffedd5` for drain)

### 3e: Status Table (~line 185–199)

- Light alternating rows (e.g., `#f8fafc` / `#ffffff`)
- Text in `var(--text)`

### 3f: Buttons

- Primary buttons: `background: var(--primary); color: white`
- Secondary/outline buttons: `border: 1px solid var(--primary); color: var(--primary); background: transparent`

### 3g: Rename `.lint-*` Classes to `.status-*` (~line 201–216)

Per design spec section 7:
- `.lint-error` → `.status-error`
- `.lint-warning` → `.status-warning`
- `.lint-ok` → `.status-ok`
- `.lint-info` → `.status-info`

Rename the CSS comment block header too.

**Dependency:** `hydraulic.html` uses `.lint-error` for pump priming status — update it in Step 5.

### 3h: Landing Page Styles (~line 218–267)

- Hero and tool cards: white bg, subtle shadow, match new card style
- Only 2 tool cards after linter removal

### 3i: Chart-Adjacent Styles (~line 177–183)

- No CSS-level chart changes needed — chart colors are hardcoded in `ui.js` (Step 4a)

**Verification:** Open each page in browser, visually confirm light theme renders without broken contrast.

---

## Step 4: Update JavaScript and HTML for Thermal Simulation

### 4a: `playground/js/ui.js` — Chart Colors (~line 140–193)

Update hardcoded dark-theme colors in `drawChart()`:

| Current | New | Purpose |
|---------|-----|---------|
| `#30363d` | `#e2e6ea` | Grid lines |
| `#8b949e` | `#64748b` | Axis labels, outdoor temp line |

**Approach:** Read CSS variables at draw time via `getComputedStyle()` so chart colors stay in sync with the theme:
```js
var style = getComputedStyle(document.documentElement);
var gridColor = style.getPropertyValue('--border').trim();
var labelColor = style.getPropertyValue('--text-muted').trim();
```

This is future-proof if we ever add theme switching.

### 4b: `playground/thermal.html` — Remove 3D References

**Import map** (~line 8–15): Remove `three` and `three/addons/` entries. Keep only `js-yaml`.

**Inline script changes** (identified by searching for `scene`, `3d`, `toggle`, `webgl`):

1. Remove the `scene3d` variable declaration and all assignments
2. Remove the dynamic `import('./js/scene3d.js')` block
3. Remove `#btn-toggle-view` button and its click handler
4. Remove the WebGL availability check (`document.createElement('canvas').getContext('webgl')`)
5. Remove `scene.update()` call in `simLoop()` / `updateDisplay()`
6. Remove `#view-3d` container div from HTML (keep `#view-2d` / SVG container only)
7. Remove `scene.dispose()` in any cleanup logic

**Layout per design spec** — wrap existing sections in titled cards:
- Wrap input controls in a card titled "Environment & Initial Conditions"
- Wrap schematic in a card titled "System Visualization"
- Temperature + Valve tables side-by-side in a card row
- Chart in a card titled "Temperature History"
- Mode log in a card titled "Mode Transition Log"

These are wrapper `<div class="card">` additions around existing content. The existing grid/table structure inside each card stays the same.

### 4c: `playground/thermal.html` — Remove Linter Nav Link

Remove the `<a>` element linking to `linter.html` from the nav bar.

### 4d: `playground/thermal.html` — Update Schematic Colors

In `buildSchematic()` (inline script):

**Structural elements (static):**
- Tank outline stroke: → `#cbd5e1`, fill: → `#f8fafc`
- Pipe strokes: → `#94a3b8`
- Greenhouse outline stroke: → `#cbd5e1`, fill: → `#f0fdf4`
- Collector frame stroke: → `#94a3b8`
- Labels/text fill: → `#475569`
- SVG background `<rect>` fill `#0d1117`: **remove the rect entirely** (let card bg show through)

**Dynamic elements** — keep the design-spec colors for:
- Collector panels: `#f59e0b`
- Active flow: blue `#3b82f6` / red `#ef4444` / orange `#f97316`
- Valves: green `#22c55e` (open), `#94a3b8` (closed)
- Pump: `#0056b2` (on), `#94a3b8` (off)
- Sensors: `#0056b2` dots

In `updateSchematic()`:
- Pump OFF fill: `#21262d` → `#e2e6ea`
- Fan OFF fill: `#8b949e` → `#cbd5e1`
- Heater OFF: similar update to muted light-theme gray

**Constraint:** Do NOT change pipe routing, valve positions, heights, or any topology. Only colors change.

---

## Step 5: Update Hydraulic and Landing Pages

### 5a: `playground/hydraulic.html` — Remove Linter Nav Link

Same as 4c.

### 5b: `playground/hydraulic.html` — Update Inline SVG Colors

In `buildCrossSection()`:
- Background rect fill `#0d1117` → remove or use `var(--bg)` equivalent
- Text fills `#8b949e` → `#64748b`
- Strokes `#30363d` → `#e2e6ea`
- Pump fill `#21262d` → `#f0f2f5`

### 5c: `playground/hydraulic.html` — Rename `.lint-error` Usage

Search for `lint-error` in `hydraulic.html` and replace with `status-error`. Also update any other `.lint-*` class references.

### 5d: `playground/index.html` — Update Landing Page

- Remove linter nav link
- Remove linter tool card (the third card in the tools grid)
- 2 cards remain: Thermal Sim, Hydraulic Sim
- Card styling inherits from updated CSS automatically

---

## Step 6: Update E2E Tests

### 6a: `tests/e2e/screenshots.spec.js`

- **Delete** the entire `Linter Screenshots` describe block (~lines 325–397)
- **Delete** 3D-specific screenshot tests: `thermal-3d-initial-desktop`, `thermal-3d-initial-mobile` (around lines 58–72, 87–100 area — confirm exact line numbers)
- All remaining screenshot baselines will need regeneration (light theme changes every pixel). Run tests to regenerate: `npx playwright test tests/e2e/screenshots.spec.js --update-snapshots`

### 6b: `tests/e2e/thermal-sim.spec.js`

- **Line ~331**: Change `toHaveCount(4)` → `toHaveCount(3)` (3 nav links: Home, Thermal, Hydraulic)
- **Lines ~150–170**: Delete or rewrite the "view toggle or 2D fallback works" test. No `#btn-toggle-view` or `#view-3d` exist anymore. Replace with a simpler test that just verifies the 2D SVG schematic is visible:
  ```js
  test('schematic is visible', async ({ page }) => {
    await expect(page.locator('#view-2d svg')).toBeVisible();
  });
  ```
- Search for any other references to `3d`, `toggle-view`, `scene`, `three` in this file and remove them.

---

## Step 7: Run Tests and Fix Breakage

After all code changes:

```bash
npm run test:unit        # Should pass — no physics/control changes
npm run test:e2e         # Will need snapshot updates
```

Expected issues:
- Screenshot mismatches (light theme) — regenerate baselines with `--update-snapshots`
- Any missed hardcoded color references — fix as found
- Any missed `.lint-*` → `.status-*` renames — fix as found

---

## Step 8: Update Documentation

### 8a: `CLAUDE.md` — Playground Architecture Section

- Remove `playground/linter.html` from file list
- Remove `playground/js/linter.js` from module list
- Remove `playground/js/scene3d.js` from module list
- Remove 3D Visualization (Three.js) subsection entirely
- Update Vendored Dependencies: remove `acorn.js`, `three.module.js`, `three-addons/`
- Add note: "Light theme (Stitch-inspired)"
- Update SVG Diagram Conventions section: note that playground uses light-theme colors (different from the static SVGs in `diagrams/` which keep dark backgrounds)

### 8b: `README.md`

- Remove the linter row from the playground tools table (~line 21)

---

## Commit Strategy

One commit per logical step, to keep changes reviewable and bisectable:

1. `chore: delete linter files (linter.html, linter.js, acorn.js)`
2. `chore: delete 3D view files (scene3d.js, three.js, three-addons)`
3. `style: retheme playground CSS to light palette`
4. `refactor: remove 3D view and linter from thermal.html, update schematic colors`
5. `refactor: update hydraulic.html and index.html for light theme`
6. `test: update e2e tests for playground redesign`
7. `docs: update CLAUDE.md and README.md for playground redesign`

Steps 6 and 7 (test fix + docs) could be a single commit if preferred.

---

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Breaking hydraulic.html with `.lint-*` → `.status-*` rename | Search for all usages before renaming |
| Missing hardcoded dark colors in inline SVG builders | Grep for `#0d1117`, `#161b22`, `#21262d`, `#30363d`, `#8b949e` across all playground files |
| Chart unreadable after color change | Test with actual simulation data, check contrast |
| Schematic topology accidentally altered | Only change `fill`/`stroke` attributes, never `d`, `x`, `y`, `width`, `height`, `transform` |
| E2e tests flaky after changes | Run full suite twice, regenerate screenshots |
