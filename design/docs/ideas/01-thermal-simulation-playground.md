# Idea 1 — Thermal Simulation Playground

Web-based visual simulator for the greenhouse solar heating system. Set environmental conditions and watch the control system respond in real time.

## Problem

The control logic (mode triggers, hysteresis thresholds, minimum run times) is hard to validate without running the physical system. Mistakes risk freeze damage, overheating, or wasted energy. A simulator lets you iterate on parameters before deploying to real hardware.

## Scope

A single-page web application that models thermal dynamics and control logic, driven by the same state machine defined in `system.yaml`.

## Functional Requirements

### Input Controls

| Parameter | Range | Default | Notes |
|-----------|-------|---------|-------|
| Outdoor temperature | -30°C to +40°C | 5°C | Slider or time-series profile |
| Solar irradiance | 0–1000 W/m² | 500 W/m² | Simulates sun angle / clouds |
| Time of day | 00:00–23:59 | 12:00 | Drives irradiance curve if using profiles |
| Tank temperature (initial) | 5°C–95°C | 40°C | Split into top/bottom for stratification |
| Greenhouse temperature (initial) | -10°C–40°C | 8°C | Starting air temp |
| Simulation speed | 1×–100× | 10× | Real-time multiplier |

### Simulated Physics (Simplified)

- **Collector gain**: `Q_coll = η₀ · A · G − U_L · A · (T_coll − T_outdoor)` where η₀ ≈ 0.75, U_L ≈ 4 W/m²K, A = 4m², G = irradiance
- **Tank stratification**: two-node model (top/bottom), mixing coefficient when pump runs
- **Tank heat loss**: `Q_loss = U_tank · A_tank · (T_tank − T_outdoor)`, insulated U ≈ 1 W/m²K
- **Greenhouse heat loss**: proportional to `(T_greenhouse − T_outdoor)`, tuneable UA coefficient
- **Radiator output**: `Q_rad = ε · (T_water_in − T_greenhouse)` with flow-dependent ε
- **Pipe losses**: simplified per-meter loss, relevant for outdoor runs

### Control Logic

- Implements the same mode triggers and exit conditions from `system.yaml`
- Mode transitions: idle → solar_charging, idle → greenhouse_heating, solar_charging → overheat_drain, etc.
- Safety rule: pump stops before valve transitions (visible delay in UI)
- Minimum run times and hysteresis respected

### Visualization

- **System schematic**: simplified SVG showing tank, collectors, radiator, reservoir, pump, valves — derived from existing `system-height-layout.svg`
- **Color-coded flow**: animated flow path highlights active piping (blue = cold supply, red = hot return)
- **Valve states**: each valve shows open/closed with color (green/grey)
- **Temperature gauges**: live-updating numbers at each sensor location
- **Mode indicator**: current operating mode with reason for last transition
- **Time-series chart**: rolling plot of all temperatures + mode bands over simulated time

## Non-Functional Requirements

- Runs entirely client-side (no backend required)
- Loads `system.yaml` at startup to configure thresholds, valve mappings, mode triggers
- Shareable via URL parameters (encode scenario as query string)
- Mobile-responsive (usable on phone for on-site testing)

## Technical Approach

### Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Framework | Vanilla JS or Preact | Minimal bundle, no build step needed |
| YAML parsing | `js-yaml` | Parse `system.yaml` client-side |
| SVG rendering | Inline SVG with JS manipulation | Matches existing SVG conventions |
| Charts | `uPlot` or `Chart.js` | Lightweight time-series plotting |
| Hosting | GitHub Pages | Zero infrastructure |

### Architecture

```
┌─────────────────────────────────────────────┐
│  Browser                                     │
│                                              │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐ │
│  │ UI Layer │◄──│ Control  │◄──│ Physics  │ │
│  │ (SVG +   │   │ State    │   │ Engine   │ │
│  │  Charts) │   │ Machine  │   │ (thermal │ │
│  └──────────┘   └──────────┘   │  model)  │ │
│       ▲              ▲         └──────────┘ │
│       │              │              ▲        │
│       │         ┌────┴─────┐       │        │
│       └─────────│ system   │───────┘        │
│                 │ .yaml    │                │
│                 │ (parsed) │                │
│                 └──────────┘                │
└─────────────────────────────────────────────┘
```

- **Physics Engine**: runs on a fixed timestep (e.g. 1s simulated), computes ΔT for each node
- **Control State Machine**: evaluates trigger/exit conditions each tick, commands valve/pump states
- **UI Layer**: re-renders SVG attributes and chart data each frame (requestAnimationFrame throttled)

### Key Modules

1. **`physics.js`** — thermal model: collector gain, tank nodes, greenhouse loss, radiator transfer
2. **`control.js`** — state machine loaded from parsed YAML modes section
3. **`ui.js`** — SVG manipulation, chart updates, input bindings
4. **`yaml-loader.js`** — fetches and parses `system.yaml`, extracts thresholds and valve maps

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Thermal model too simplistic | Simulator gives false confidence | Label as "qualitative" — use for logic testing, not sizing |
| `system.yaml` schema changes | Simulator breaks silently | Validate parsed YAML against expected keys at load time |
| Performance at high sim speeds | Choppy UI | Decouple physics tick from render frame; batch physics steps |

## Success Criteria

- Can reproduce all 3 main operating modes (solar charging, greenhouse heating, active drain) by adjusting inputs
- Mode transitions match `system.yaml` trigger/exit thresholds exactly
- Valve states in UI match the `valve_states` table for each mode
- A cold night scenario (outdoor −10°C, tank hot) triggers greenhouse heating → emergency heating cascade correctly
