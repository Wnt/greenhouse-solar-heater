# Kasvihuone Solar Heating System

Solar thermal heating system for a greenhouse in Southwest Finland.

## What This Is

An open (unpressurized) solar thermal system that:
- Heats water in a 300L Jäspi tank using 2× flat plate solar collectors (4m²)
- Distributes stored heat to the greenhouse via a car radiator and fan
- Uses active pump-driven drainback for freeze protection (spring/autumn nightly drain cycles)
- Controlled by Shelly devices with DS18B20 temperature sensors

## Project Files

| File | Purpose |
|------|---------|
| `system.yaml` | **Source of truth** — all component specs, heights, valve states, operating modes |
| `docs/design.md` | Design specification — architecture, modes, safety rules |
| `diagrams/control-states.mmd` | Mermaid state diagram — operating mode transitions |
| `diagrams/drain-sequence.mmd` | Mermaid sequence diagram — active drain procedure |
| `diagrams/system-height-layout.svg` | SVG physical layout — components at real-world heights |
| `construction/solar_collector_frame.md` | Collector frame build details |
| `existing-hardware/` | Photos of owned components (pump, panels, tank) |

## Documentation Format

- **YAML** (`system.yaml`) — machine-readable source of truth. AI agents validate this.
- **Mermaid** (`.mmd`) — control logic, state machines, sequences
- **SVG** (`.svg`) — physical layout with height coordinates and `data-` attributes

## Key Design Decisions

- **Unpressurized system** — Jäspi tank used open/vented via reservoir on top
- **Active drainback** — pump empties collectors through 3-way valve switching
- **3× three-way valves** — V_top (collector top), V_pump_in, V_pump_out
- **Flow sensor** — detects when collectors are empty, prevents pump dry-run
- **Shelly control** — Pro 4PM + Pro 2PM/3 + Plus 1 with Add-on
