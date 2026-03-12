# Ideas — Overview & Implementation Plan

High-level specs and implementation roadmap for the ideas in `IDEAS.md`. Each idea has a dedicated spec document; this file provides the cross-cutting plan.

## Ideas Summary

| # | Idea | Spec | Effort | Priority |
|---|------|------|--------|----------|
| 1 | Thermal Simulation Playground | [01-thermal-simulation-playground.md](01-thermal-simulation-playground.md) | Large | High |
| 2 | Hydraulic Playground (Water Level & Air) | [02-hydraulic-playground.md](02-hydraulic-playground.md) | Medium | Medium |
| 3 | Platform Conformance Linter | [03-platform-conformance-linter.md](03-platform-conformance-linter.md) | Medium | High |

## Dependency Graph

```
                   system.yaml (source of truth)
                   ┌──────┼──────────┐
                   ▼      ▼          ▼
              Idea 1   Idea 2     Idea 3
              Thermal  Hydraulic  Linter
              Sim      Sim
                 │      │
                 ▼      ▼
              Unified Playground (future)
```

- Ideas 1 and 2 share a YAML loader, UI framework, and SVG conventions — they can be separate tabs in one app
- Idea 3 is fully independent — it analyzes script files, not the simulation
- All three read `system.yaml` as their configuration source

## Implementation Roadmap

### Phase 1 — Foundation (Weeks 1–2)

**Goal**: Shared infrastructure that all ideas build on.

1. **YAML loader module** — parse `system.yaml` client-side, extract mode triggers, valve maps, sensor definitions, component specs
2. **Project scaffold** — single repo directory (`playground/` or `tools/`), minimal build setup (or no-build with ES modules), GitHub Pages deployment
3. **SVG base schematic** — simplified system diagram reusable by both simulators, derived from existing `system-height-layout.svg`

### Phase 2 — Platform Linter MVP (Weeks 2–3)

**Goal**: Catch Shelly scripting mistakes before deployment. Delivers value immediately once Shelly scripts exist.

1. Phase 1 of linter spec — syntax rules (SH-004 through SH-009, SH-013)
2. Phase 2 of linter spec — resource limit counting (SH-001 through SH-003, SH-012)
3. CLI tool with terminal output
4. GitHub Actions integration

**Why first**: The linter is smaller in scope, delivers value early (prevents bricked deployments), and doesn't require physics modeling.

### Phase 3 — Thermal Simulator MVP (Weeks 3–6)

**Goal**: Validate control logic against environmental scenarios.

1. Physics engine — two-node tank model, collector gain, greenhouse loss
2. Control state machine — loaded from parsed YAML modes
3. Input controls — sliders for outdoor temp, irradiance, initial tank temp
4. Basic SVG visualization — flow paths, valve states, temperature readouts
5. Time-series chart — rolling temperature plot with mode bands

### Phase 4 — Hydraulic Simulator (Weeks 6–8)

**Goal**: Validate reservoir sizing and air management.

1. Hydraulics engine — communicating vessels, volume accounting, air pocket tracking
2. Cross-section SVG — tank interior with water level, reservoir, collector loop
3. Preset scenarios — normal operation, drain cycle, air injection, low water
4. Danger indicators — pump prime loss, reservoir overflow

### Phase 5 — Polish & Integration (Weeks 8–10)

1. Linter Phase 3 — safety rules (SH-010/011) cross-referencing `system.yaml`
2. Unified playground — combine thermal and hydraulic tabs
3. URL-shareable scenarios (encode parameters as query string)
4. Mobile-responsive layout for on-site use

## Shared Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| No build step | ES modules + import maps | Simplicity; spec repo shouldn't need Node toolchain |
| Client-side only | GitHub Pages hosting | Zero infrastructure, anyone can fork and run |
| `system.yaml` as config | Parsed at load time | Single source of truth preserved; changes propagate automatically |
| SVG conventions | Match existing `data-component` / `data-height` attributes | Consistency with hand-authored diagrams in `diagrams/` |
| Linter in Node.js | Separate from playground | Different runtime context (CLI vs browser); shares only YAML parsing |

## File Structure (Proposed)

```
greenhouse-solar-heater/
├── system.yaml                    # source of truth (existing)
├── IDEAS.md                       # raw ideas (existing)
├── docs/ideas/                    # specs and plan (this directory)
│   ├── 00-overview.md             # this file
│   ├── 01-thermal-simulation-playground.md
│   ├── 02-hydraulic-playground.md
│   └── 03-platform-conformance-linter.md
├── playground/                    # web simulator (future)
│   ├── index.html
│   ├── js/
│   │   ├── yaml-loader.js
│   │   ├── physics.js
│   │   ├── hydraulics.js
│   │   ├── control.js
│   │   └── ui.js
│   └── svg/
│       └── schematic.svg
└── tools/                         # CLI tools (future)
    └── shelly-lint/
        ├── package.json
        ├── bin/shelly-lint.js
        └── rules/
            ├── syntax.js
            ├── resources.js
            └── safety.js
```

## Open Questions

1. **Reservoir sizing**: Should the hydraulic sim be built before physically sizing the reservoir? It could inform the 20–50L decision.
2. **Shelly firmware version**: Which minimum firmware version should the linter target? Syntax support varies.
3. **Simulation accuracy**: Is qualitative (directional correctness) sufficient, or do we need quantitative validation against measured data?
4. **Linter scope**: Should it lint only the main Pro 4PM brain script, or also validate the relay mapping configuration on Pro 2PM units?
