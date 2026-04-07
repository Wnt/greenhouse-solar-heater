# Implementation Plan: Reactive State Core UI Rewrite

**Branch**: `021-reactive-state-ui` | **Date**: 2026-04-07 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/021-reactive-state-ui/spec.md`

## Summary

Rewrite the playground's ad-hoc imperative state management into a reactive state store with derived views. The current architecture scatters ~30 mutable variables across module closures and a 1139-line inline script, requiring manual render calls after every mutation. The new architecture introduces a single reactive state store (~50 lines, no dependencies) where setting a value automatically notifies subscribers, eliminating the class of bugs where UI updates are forgotten. Computed values (scanning status, available views, connection display state) are derived from the store rather than stored independently, making state duplication structurally impossible. The high-frequency simulation loop (60fps physics + canvas) remains outside the reactive path for performance.

## Technical Context

**Language/Version**: JavaScript ES6+ (browser modules), HTML5, CSS3
**Primary Dependencies**: None new — vanilla ES modules only. Existing vendored: js-yaml 4.1.0
**Storage**: N/A (client-side only; server APIs unchanged)
**Testing**: Playwright 1.56.0 (e2e), node:test (unit). `npm run test:unit` and `npm run test:e2e`
**Target Platform**: Modern browsers (ES6+ module support, Proxy API)
**Project Type**: Single-page web application (playground/)
**Performance Goals**: 60fps simulation rendering, equivalent to pre-rewrite baseline
**Constraints**: No third-party frontend frameworks, all dependencies vendored, offline-capable
**Scale/Scope**: 9 JS modules (1765 lines), 1139-line inline script, 1452-line CSS file

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applicable? | Status | Notes |
|-----------|-------------|--------|-------|
| I. Hardware Spec as Single Source of Truth | No | N/A | This rewrite affects only playground UI code, not hardware specs |
| II. Pure Logic / IO Separation | Yes | Pass | The reactive store is a pure data structure. `evaluate()` function and control-logic.js are unchanged. Actions (async I/O) remain separate from state computation |
| III. Safe by Default (NON-NEGOTIABLE) | Indirectly | Pass | No actuation or control logic changes. Safety-critical code paths in control-logic.js and control.js (Shelly) are untouched |
| IV. Proportional Test Coverage | Yes | Pass | All existing e2e and unit tests must pass. New store module gets unit tests. Sensor/navigation behavior changes get e2e coverage |
| V. Token-Based Cloud Auth | No | N/A | No cloud authentication changes |
| VI. Durable Data Persistence | No | N/A | Client-side only; no persistence changes |
| VII. No Secrets in Cloud-Init | No | N/A | No infrastructure changes |

**Platform Constraints Check:**
- Browser code: ES6+ modules with importmap — **Compliant**. New modules use ES6+ imports/exports.
- Vendored dependencies: **Compliant**. No new third-party dependencies introduced.
- Shelly scripts: **Not affected**. No changes to shelly/ files.

**Gate result: PASS** — no violations, no justifications needed.

## Project Structure

### Documentation (this feature)

```text
specs/021-reactive-state-ui/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0: architecture decisions
├── data-model.md        # Phase 1: state shape and derived values
├── quickstart.md        # Phase 1: development guide
├── contracts/           # Phase 1: module interfaces
│   ├── store.md         # Store API contract
│   ├── views.md         # View component lifecycle contract
│   └── actions.md       # Action function contract
└── checklists/
    └── requirements.md  # Spec quality checklist
```

### Source Code (repository root)

```text
playground/
├── index.html                  # Reduced inline script (~200 lines: init, simLoop, updateDisplay)
├── login.html                  # Unchanged
├── css/
│   └── style.css               # Unchanged (+ scan-spinner from prior commit)
├── js/
│   ├── store.js                # NEW: Reactive state store (createStore)
│   ├── app-state.js            # NEW: Store instance, initial state shape, derived getters
│   ├── subscriptions.js        # NEW: Global store→DOM bindings (nav, overlays, banners, indicators)
│   ├── actions/
│   │   ├── navigation.js       # NEW: navigateTo(), hashchange handler
│   │   ├── connection.js       # NEW: switchToLive(), switchToSimulation(), staleness check
│   │   ├── sensors.js          # NEW: scanSensors(), saveSensorConfig(), applyConfig()
│   │   ├── device-config.js    # NEW: loadDeviceConfig(), saveDeviceConfig()
│   │   └── version-check.js    # NEW: startVersionCheck(), dismissUpdate()
│   ├── views/
│   │   ├── sensors-view.js     # NEW: mount/unmount/render for Sensors tab
│   │   └── device-view.js      # NEW: mount/unmount/render for Device tab
│   ├── control-logic-loader.js # Unchanged
│   ├── control.js              # Unchanged
│   ├── data-source.js          # Modified: LiveSource writes to store instead of callbacks
│   ├── physics.js              # Unchanged
│   ├── ui.js                   # Unchanged
│   └── yaml-loader.js          # Unchanged
└── vendor/                     # Unchanged
```

**Structure Decision**: The existing flat `playground/js/` structure is extended with two subdirectories (`actions/` and `views/`) to separate concerns. Actions contain async I/O functions that write to the store. Views contain mount/unmount lifecycle components. The store itself and derived state are top-level modules. This keeps the module count manageable while establishing clear boundaries.

## Complexity Tracking

No constitution violations to justify — all principles pass cleanly.
