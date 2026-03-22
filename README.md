# Greenhouse Solar Heating System

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

All tools run entirely client-side (no backend), load `system.yaml` as configuration, and use ES modules with no build step.

## Project Files

| File | Purpose |
|------|---------|
| `system.yaml` | **Source of truth** — all component specs, heights, valve states, operating modes |
| `shelly/` | Shelly control software — control logic + shell integration + platform linter |
| `playground/` | Interactive web tools — thermal sim, hydraulic sim |
| `monitor/` | Temperature monitor web app — server, UI, auth, push notifications |
| `deploy/` | Cloud deployment — Terraform, Docker, deployer, WireGuard |
| `design/docs/` | Design documentation — architecture, modes, safety rules, BOM |
| `design/diagrams/` | SVG schematics + Mermaid state/sequence diagrams |
| `design/construction/` | Physical build instructions |
| `design/photos/` | Photos of owned components (pump, panels, tank) |
| `tests/` | Unit tests, thermal simulation scenarios, and e2e tests |

## Documentation Format

- **YAML** (`system.yaml`) — machine-readable source of truth. AI agents validate this.
- **Mermaid** (`.mmd`) — control logic, state machines, sequences
- **SVG** (`.svg`) — physical layout with height coordinates and `data-` attributes

## Key Design Decisions

- **Unpressurized system** — Jäspi tank used open/vented via reservoir on top
- **On/off valve manifold** — 8 motorized on/off valves (DN15) in input/output manifolds around pump
- **Active drainback** — pump empties collectors; air enters via V_air at collector top
- **Pump power monitoring** — Pro 4PM detects dry-run via power draw, no physical flow sensor
- **Open reservoir** — primary air separator; trapped air from collector loop and tank vents here
- **Manual service valves** — SV-drain and SV-fill for system maintenance
- **Shelly control** — Pro 4PM + 4× Pro 2PM + 1 Gen3 with Add-on
