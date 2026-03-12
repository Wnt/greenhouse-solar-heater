# Kasvihuone Solar Heating System

Solar thermal heating system for a greenhouse in Southwest Finland.

## What This Is

An open (unpressurized) solar thermal system that:
- Heats water in a 300L Jäspi tank using 2× flat plate solar collectors (4m²)
- Distributes stored heat to the greenhouse via a car radiator and fan
- Uses active pump-driven drainback for freeze protection (spring/autumn nightly drain cycles)
- Controlled by Shelly devices with DS18B20 temperature sensors

## Interactive Playground

Web-based tools for simulating and validating the system, deployed via GitHub Pages.

| Tool | Description |
|------|-------------|
| [Thermal Simulation](playground/thermal.html) | Set outdoor temp, irradiance, tank state — watch the control system respond in real time |
| [Hydraulic Simulation](playground/hydraulic.html) | Explore communicating vessels, reservoir sizing, drainback dynamics, and air management |
| [Shelly Linter](playground/linter.html) | Static analysis for Shelly scripts — catches unsupported syntax and resource limit violations |

All tools run entirely client-side (no backend), load `system.yaml` as configuration, and use ES modules with no build step.

## Project Files

| File | Purpose |
|------|---------|
| `system.yaml` | **Source of truth** — all component specs, heights, valve states, operating modes |
| `docs/design.md` | Design specification — architecture, modes, safety rules |
| `playground/` | Interactive web tools — thermal sim, hydraulic sim, Shelly linter |
| `tools/shelly-lint/` | CLI linter for Shelly scripts (Node.js) |
| `scripts/` | Shelly control software — control logic + shell integration |
| `tests/` | Unit tests and thermal simulation scenarios |
| `diagrams/system-topology.svg` | SVG pipe & valve topology — full manifold schematic |
| `diagrams/system-height-layout.svg` | SVG physical layout — components at real-world heights |
| `diagrams/solar-charging-flow.svg` | SVG flow loop — Mode 1: solar charging |
| `diagrams/greenhouse-heating-flow.svg` | SVG flow loop — Mode 2: greenhouse heating |
| `diagrams/active-drain-flow.svg` | SVG flow loop — Mode 3: active drain |
| `diagrams/control-states.mmd` | Mermaid state diagram — operating mode transitions |
| `diagrams/drain-sequence.mmd` | Mermaid sequence diagram — active drain procedure |
| `construction/solar_collector_frame.md` | Collector frame build details |
| `existing-hardware/` | Photos of owned components (pump, panels, tank) |

## Documentation Format

- **YAML** (`system.yaml`) — machine-readable source of truth. AI agents validate this.
- **Mermaid** (`.mmd`) — control logic, state machines, sequences
- **SVG** (`.svg`) — physical layout with height coordinates and `data-` attributes

## Key Design Decisions

- **Unpressurized system** — Jäspi tank used open/vented via reservoir on top
- **On/off valve manifold** — 8 motorized on/off valves (DN15) in input/output manifolds around pump
- **Active drainback** — pump empties collectors; air enters via V_air at collector top
- **Flow sensor** — detects when collectors are empty, prevents pump dry-run
- **Auto air vent** — at collector top (highest point), continuously bleeds trapped air
- **Manual service valves** — SV-drain and SV-fill for system maintenance
- **Shelly control** — Pro 4PM + 3× Pro 2PM + Plus 1 with Add-on
