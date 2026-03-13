# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Solar thermal greenhouse heating system for Southwest Finland. The repo contains system specifications, Shelly control scripts, interactive browser-based simulators (playground), a Shelly platform linter, and documentation/diagrams.

## Mandatory: Keep CLAUDE.md Up to Date

**Before finishing any work in this repo, review this file and update it if your changes affect the project structure, file relationships, conventions, commands, or workflows described here.** This ensures CLAUDE.md remains an accurate guide for future sessions. If you added new directories, scripts, tools, tests, CI workflows, or conventions — document them here.

## Source of Truth

`system.yaml` is the **single authoritative source** for all specifications: component dimensions, heights, valve states, operating modes, sensor assignments, and Shelly relay mappings. All other documentation and diagrams are derived views of this file.

When making changes, **update system.yaml first**, then propagate to affected docs and diagrams.

## File Relationships

- `system.yaml` → authoritative specs (heights, valve states, modes, components)
- `docs/design.md` → prose explanation of the YAML, for human review
- `docs/ideas/` → idea specs and implementation plans (thermal sim, hydraulic playground, linter)
- `docs/superpowers/specs/` → detailed design specs (Shelly control software, testing strategy)
- `diagrams/*.svg` → hand-authored SVG with `data-` attributes mapping to YAML values
- `diagrams/*.mmd` → Mermaid control logic (state machines, sequences)
- `construction/` → physical build instructions
- `existing-hardware/` → reference photos of owned components
- `scripts/` → Shelly device scripts and deployment tooling
- `tools/shelly-lint/` → standalone Shelly platform conformance linter (CLI)
- `playground/` → interactive browser-based simulators and linter UI
- `tests/` → unit, simulation, and e2e tests
- `.github/workflows/` → CI (GitHub Pages deploy, Shelly lint)
- `IDEAS.md` → raw ideas / wishlist

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

## Shelly Control Scripts

The `scripts/` directory contains the actual device scripts deployed to Shelly hardware:

- `scripts/control-logic.js` — Pure decision logic (ES5-compatible). Exports an `evaluate(state, config)` function with no side effects and no Shelly API calls. This is the testable core.
- `scripts/control.js` — Shelly shell script that handles timers, RPC, relays, KVS, sensors. Imports `control-logic.js` (concatenated at deploy time).
- `scripts/deploy.sh` — Deploys scripts to the Shelly Pro 4PM via HTTP RPC. Reads device IPs from `devices.conf`.
- `scripts/devices.conf` — DHCP-reserved IP addresses for all Shelly devices.

**Shelly scripting constraints**: Scripts must use ES5-compatible JavaScript — no `const`/`let`, no arrow functions, no destructuring, no template literals, no ES6 classes. The linter enforces these rules.

## Shelly Linter

Two implementations of the platform conformance linter exist:

- **CLI tool**: `tools/shelly-lint/` — standalone Node.js CLI (`node tools/shelly-lint/bin/shelly-lint.js`). Uses Acorn for AST parsing. Has its own `package.json` with acorn and js-yaml dependencies.
- **Browser UI**: `playground/linter.html` + `playground/js/linter.js` — interactive linter in the playground, using vendored Acorn.
- **CI**: `.github/workflows/lint-shelly.yml` runs the CLI linter on push/PR when `scripts/` or `tools/shelly-lint/` files change.

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

- `playground/index.html` — landing page linking to all playground tools
- `playground/thermal.html` — thermal simulation (2D + optional 3D view)
- `playground/hydraulic.html` — hydraulic simulation (water level, air venting)
- `playground/linter.html` — Shelly script linter UI
- `playground/js/` — ES modules: physics, control, hydraulics, UI, yaml-loader, scene3d, linter
- `playground/css/style.css` — shared styles

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

### Test Structure

- `tests/control-logic.test.js` — unit tests for the pure control logic (`scripts/control-logic.js`)
- `tests/simulation/` — thermal model and simulation scenario tests (`simulation.test.js`, `thermal-model.test.js`, `scenarios.js`, `simulator.js`, `thermal-model.js`)
- `tests/e2e/thermal-sim.spec.js` — Playwright e2e tests for the playground thermal simulation

### Test Setup Notes

- **Playwright version**: Must match the cached Chromium browser revision. Currently `@playwright/test@1.56.0` matches `chromium-1194`. If you see "browser not found" errors, check `~/.cache/ms-playwright/` for available revisions and install the matching Playwright version.
- **Static server**: Tests use `npx serve` on port 3210 to serve the playground. The Playwright config auto-starts this server.
- **No `-s` flag on serve**: Do NOT use `serve -s` (SPA mode) — it breaks direct HTML file access by redirecting all routes.
- **E2e tests exercise the 3D view** when Three.js loads successfully (vendored locally). Individual test timeouts are 30s to accommodate WebGL initialization overhead.

## CI / GitHub Actions

- `.github/workflows/ci.yml` — runs the full test suite (unit, simulation, e2e) on every push. Triggers on `push` only (not `pull_request`) so tests run exactly once — opening a PR from an already-pushed branch does not re-trigger.
- `.github/workflows/deploy-pages.yml` — deploys playground to GitHub Pages on push to main/master
- `.github/workflows/lint-shelly.yml` — runs Shelly linter on push/PR when scripts or linter files change
