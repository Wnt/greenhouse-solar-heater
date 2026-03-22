# Playground Redesign — Light Theme & Cleanup

**Date:** 2026-03-14
**Status:** Draft

## Goal

Modernize the playground UI with a light theme inspired by the Stitch "Home Dashboard (Light)" mockup. Remove the Shelly Linter and 3D view. Update the thermal simulation layout and colors to be cleaner while preserving the real system topology in the schematic.

## Decisions

| Question | Answer |
|----------|--------|
| CSS approach | Retheme existing custom CSS (no Tailwind) |
| Schematic colors | Hybrid: muted structural, semantic for thermal state |
| Landing page | Retheme to light, remove linter card, keep simple |
| 3D view | Remove entirely, including all vendor files |
| Linter | Remove entirely, including all source files |

## Scope

### 1. Files to Delete

| File | Reason |
|------|--------|
| `playground/linter.html` | Linter page removed |
| `playground/js/linter.js` | Linter module removed |
| `playground/vendor/acorn.js` | Only used by linter |
| `playground/js/scene3d.js` | 3D view removed |
| `playground/vendor/three.module.js` | Only used by 3D view |
| `playground/vendor/three-addons/` (entire directory) | Only used by 3D view |

### 2. Files to Modify

#### `playground/css/style.css` — Light Theme

Replace dark CSS variables with light palette:

```
--bg: #f5f7f8            (was #0d1117)
--bg-card: #ffffff        (was #161b22)
--bg-input: #f0f2f5       (was #21262d)
--border: #e2e6ea         (was #30363d)
--text: #1e293b           (was #c9d1d9)
--text-muted: #64748b     (was #8b949e)
--text-bright: #0f172a    (was #f0f6fc)
```

Additional style changes:
- Add `--primary: #0056b2` (Stitch's primary blue) — replaces `--blue-dark` for UI accents (nav active state, links, buttons). The existing `--blue` and `--red` etc. semantic colors are kept for schematic/simulation use only.
- Cards get subtle `box-shadow: 0 1px 3px rgba(0,0,0,0.08)` instead of relying on border contrast
- `border-radius` on cards increased to `12px` (from 8px) to match Stitch's rounded-xl
- Nav header: white background with subtle bottom border, no dark card bg
- Mode badges: softer tint backgrounds appropriate for light theme
- Status table: light alternating rows instead of dark
- Buttons (Start/Pause/Reset): primary blue fill or outline style
- Chart: update grid/axis colors for light background

#### `playground/index.html` — Landing Page

- Remove linter nav link and linter tool card
- 2 tool cards remain: Thermal Sim, Hydraulic Sim
- Update card styling to match light theme (white bg, subtle shadow)
- Keep hero section and about section, rethemed

#### `playground/thermal.html` — Thermal Simulation

Navigation:
- Remove linter nav link
- Remove all Three.js/3D-related entries from importmap
- Remove 3D toggle button and all 3D initialization/update code from inline script

Layout updates (structure preserved, styling improved):
- **Controls bar**: cleaner button styling, primary blue accent
- **Input controls grid**: group into a card titled "Environment & Initial Conditions" (matching Stitch)
- **System visualization**: full-width card titled "System Visualization"
- **Temperature + Valve tables**: side-by-side in a card row (matching Stitch layout)
- **Temperature history chart**: card with clean header
- **Mode transition log**: card at bottom

Inline script cleanup:
- Remove `scene3d.js` dynamic import and all `scene` variable references
- Remove 3D toggle button handler
- Remove WebGL availability check
- Remove `scene.update()` calls from simulation loop

#### `playground/hydraulic.html` — Hydraulic Simulation

- Remove linter nav link
- Update inline SVG colors in `buildCrossSection()`: background rect fill `#0d1117` → remove or use `--bg`, text fills `#8b949e` → `--text-muted`, stroke `#30363d` → `--border`, pump fill `#21262d` → light equivalent
- No layout changes

#### `playground/js/ui.js` — Chart Colors

The `drawChart()` function has hardcoded dark-theme colors that must be updated:
- Grid lines `#30363d` → `#e2e6ea` (match `--border`)
- Axis labels `#8b949e` → `#64748b` (match `--text-muted`)
- Outdoor temp line `#8b949e` → `#64748b`

Approach: pass color config from the caller or read CSS variables at draw time, so chart colors stay in sync with the theme.

### 3. System Schematic Color Scheme (2D SVG in thermal.html)

The schematic is built by `buildSchematic()` in thermal.html's inline script. Update colors:

**Structural elements** (always visible, don't change with simulation state):
- Tank outline: `#cbd5e1` (slate-300) stroke, `#f8fafc` (slate-50) fill
- Pipe paths: `#94a3b8` (slate-400) stroke
- Greenhouse outline: `#cbd5e1` stroke, `#f0fdf4` (green-50) fill
- Collector frame: `#94a3b8` stroke
- Labels/text: `#475569` (slate-600)

**Dynamic/state elements** (change with simulation):
- Water temperature in tank: blue (`#3b82f6`) to red (`#ef4444`) gradient based on temperature
- Collector panels: `#f59e0b` (amber-500) fill — solar collectors stay warm-colored
- Active flow pipes: highlighted with mode-appropriate color, animated dashes
  - Solar charging flow: `#3b82f6` (blue)
  - Greenhouse heating flow: `#ef4444` (red)
  - Drain flow: `#f97316` (orange)
- Valves: small circles — `#22c55e` (green) fill when OPEN, `#94a3b8` (slate-400) when CLOSED
- Pump: `#0056b2` (primary) when ON, `#94a3b8` when OFF
- Sensors: small `#0056b2` dots with labels

**Dynamic colors in `updateSchematic()`**: The function that updates the schematic each frame also has hardcoded dark-theme colors for pump OFF (`#21262d`), fan OFF (`#8b949e`), heater OFF states. These must be updated to light-theme equivalents (e.g., `#e2e6ea` for OFF states).

**SVG background**: The schematic's `<rect>` background fill (`#0d1117`) should be removed entirely — let the card background show through.

**Key constraint**: All heights, pipe routing (dip tube path, reservoir connections, manifold layout), and valve positions must match `system.yaml`. The topology is not simplified — it shows the real system.

### 4. Navigation (all pages)

3 links in header: **Home** | **Thermal Sim** | **Hydraulic Sim**

Active link styling: `--primary` color with bottom border (like Stitch).

### 5. Files NOT Changed

- `playground/js/yaml-loader.js` — pure data loading
- `playground/js/control.js` — pure logic
- `playground/js/physics.js` — pure physics
- `playground/js/hydraulics.js` — pure physics
- `playground/vendor/js-yaml.mjs` — vendored dependency, still needed

### 6. CI/Docs Updates

- `.github/workflows/lint-shelly.yml` — no change (lints `scripts/`, not playground)
- `CLAUDE.md` — update Playground Architecture section:
  - Remove linter references
  - Remove 3D/Three.js references
  - Update vendored dependencies list
  - Note light theme
- `README.md` — remove references to `playground/linter.html` and the linter tool

### 7. CSS Cleanup Note

The `/* Linter */` CSS block in `style.css` contains `.lint-error`, `.lint-warning`, `.lint-ok`, `.lint-info` classes. The `.lint-error` class is also used by `hydraulic.html` for pump priming status display. Either:
- Rename these to generic `.status-error`, `.status-warning`, `.status-ok`, `.status-info` and update both files, OR
- Keep the classes but rename the CSS comment block

Recommended: rename to `.status-*` for clarity.

### 8. Test Updates

- `tests/e2e/screenshots.spec.js`:
  - Delete the entire `Linter Screenshots` describe block (~lines 325-397) — linter page no longer exists
  - Remove 3D-specific screenshot tests (`thermal-3d-initial-desktop`, `thermal-3d-initial-mobile`)
  - All remaining screenshot tests will produce different images due to light theme — regenerate baselines
- `tests/e2e/thermal-sim.spec.js`:
  - Update nav link count assertion from `toHaveCount(4)` to `toHaveCount(3)` (~line 331)
  - Remove or rewrite the "view toggle or 2D fallback works" test (~lines 150-170) — no more `#btn-toggle-view`, `#view-3d`
  - Remove any other references to 3D elements

## Out of Scope

- Tailwind CSS migration
- New features (live data, energy stats, health checks from Stitch mockup)
- Hydraulic sim layout changes
- Physics/control logic changes
