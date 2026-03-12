# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Solar thermal greenhouse heating system design for Southwest Finland. This is a **specification repository** — no software to build, test, or run. All files are documentation, diagrams, and hardware reference photos.

## Source of Truth

`system.yaml` is the **single authoritative source** for all specifications: component dimensions, heights, valve states, operating modes, sensor assignments, and Shelly relay mappings. All other documentation and diagrams are derived views of this file.

When making changes, **update system.yaml first**, then propagate to affected docs and diagrams.

## File Relationships

- `system.yaml` → authoritative specs (heights, valve states, modes, components)
- `docs/design.md` → prose explanation of the YAML, for human review
- `diagrams/*.svg` → hand-authored SVG with `data-` attributes mapping to YAML values
- `diagrams/*.mmd` → Mermaid control logic (state machines, sequences)
- `construction/` → physical build instructions
- `existing-hardware/` → reference photos of owned components

## Documentation Formats

- **YAML** for machine-readable specs — validate changes against this
- **Mermaid** for control logic (state machines, sequences) — renderable by GitHub
- **SVG** for physical layout — hand-crafted with height coordinates and `data-component`/`data-height` attributes; these are NOT generated, they are authored directly

## Key Architecture Concepts

- **Unpressurized system**: Jäspi tank is sealed but vented via an open reservoir connected to the dip tube port. The reservoir acts as an air separator — gas from the tank vents to atmosphere through the open reservoir top.
- **Communicating vessels**: Water level in reservoir equals water level at the dip tube opening inside the tank (~197cm). Gas is trapped above this level in the sealed tank.
- **Valve manifold**: 8 motorized on/off DN15 valves in input/output manifolds around a single pump. Three input valves (VI-btm, VI-top, VI-coll) and three output valves (VO-coll, VO-rad, VO-tank) plus two at collector top (V_ret, V_air).
- **Three operating modes**: Solar Charging (Mode 1), Greenhouse Heating (Mode 2), Active Drain (Mode 3). Each mode opens a specific subset of valves — see the `modes` section in system.yaml.
- **Safety rule**: Always stop pump BEFORE switching valves.

## SVG Diagram Conventions

All SVGs use a dark background (#0d1117), consistent color coding:
- Blue (#42a5f5, #1565c0) = supply/cool water, tank
- Red (#ef5350, #e53935) = hot water, dip tube path
- Yellow (#f9a825) = solar collectors
- Green (#76ff03) = sensors, active/ON states
- Purple (#e040fb) = motorized valves
- Orange (#ff9800) = drain mode, service valves

Height scales in SVGs are approximate — `system-height-layout.svg` is the most precise for physical positioning.

## Playground Architecture

The `playground/` directory contains interactive browser-based simulators (thermal, hydraulic) and a Shelly script linter. These are static HTML files using ES modules with `<script type="importmap">`.

### Vendored Dependencies

All third-party libraries are vendored locally in `playground/vendor/` to avoid CDN/CORS issues in restricted environments (e.g. Claude Code web runtime, CI, offline):

- `playground/vendor/js-yaml.mjs` — js-yaml 4.1.0 (ESM), used by all playground pages
- `playground/vendor/three.module.js` — Three.js 0.170.0 (ESM, minified), used by thermal sim 3D view
- `playground/vendor/three-addons/controls/OrbitControls.js` — Three.js OrbitControls addon
- `playground/vendor/acorn.js` — Acorn 8.11.3 (UMD), used by the Shelly linter

**Do NOT replace these with CDN URLs.** The importmaps in each HTML file point to `./vendor/...` paths. If upgrading a dependency, download via `npm pack`, extract the dist files, and copy to `playground/vendor/`.

### 3D Visualization (Three.js)

The thermal simulation has a 3D view (`playground/js/scene3d.js`) that is **lazy-loaded** via dynamic `import()`. If Three.js fails to load (e.g. WebGL unavailable), the page falls back to the 2D SVG schematic automatically. The toggle button is hidden when 3D is unavailable.

## Running Tests

```bash
npm test              # all tests: unit + simulation + e2e
npm run test:unit     # unit + simulation tests only (fast, no browser)
npm run test:e2e      # Playwright e2e tests only (requires Chromium)
```

### Test Setup Notes

- **Playwright version**: Must match the cached Chromium browser revision. Currently `@playwright/test@1.56.0` matches `chromium-1194`. If you see "browser not found" errors, check `~/.cache/ms-playwright/` for available revisions and install the matching Playwright version.
- **Static server**: Tests use `npx serve` on port 3210 to serve the playground. The Playwright config auto-starts this server.
- **No `-s` flag on serve**: Do NOT use `serve -s` (SPA mode) — it breaks direct HTML file access by redirecting all routes.
- **E2e tests exercise the 3D view** when Three.js loads successfully (vendored locally). Individual test timeouts are 30s to accommodate WebGL initialization overhead.
