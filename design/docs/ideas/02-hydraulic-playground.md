# Idea 2 — Hydraulic Playground (Water Level & Air Simulation)

Interactive simulator for the hydraulic behavior of the unpressurized system: water levels, air pockets, reservoir fill/drain dynamics, and communicating vessels physics.

## Problem

The system relies on subtle hydraulic principles — communicating vessels between tank and reservoir, gravity drainback, air separation through the open reservoir. Introducing air (e.g. after a drain cycle, or from a leak) has consequences that are hard to reason about mentally. A visual hydraulic simulator makes these dynamics intuitive and testable.

## Scope

A companion to the thermal simulator (Idea 1) or an integrated tab/mode within it. Focuses on fluid levels and gas behavior rather than temperatures.

## Functional Requirements

### Input Controls

| Parameter | Range | Default | Notes |
|-----------|-------|---------|-------|
| Total water volume | 200–370L | 320L | Tank 300L + reservoir + pipes |
| Air injection point | dropdown | collector top | Where air enters the system |
| Air volume injected | 0–20L | 2L | Single bolus or continuous |
| Reservoir capacity | 20–50L | 30L | Physical reservoir size |
| Pump state | ON / OFF | OFF | Manual or auto (via control logic) |
| Active valve set | mode selector | idle | Determines flow path |

### Simulated Hydraulics

- **Communicating vessels**: water level in reservoir = water level at dip tube opening inside tank (~197cm). When water is added or removed anywhere, both levels adjust.
- **Gas trapping**: sealed tank traps gas above the water line. Gas compresses/expands with water level changes. The dip tube opening height sets the equilibrium.
- **Reservoir overflow/underflow**: if water volume exceeds capacity, reservoir overflows (visual warning). If air displaces too much water, reservoir drops below outlet (pump loses prime — critical failure).
- **Drainback volume**: when collectors drain, that water volume (~4–6L) must fit in the reservoir without overflowing, and without dropping the reservoir level below the pump inlet.
- **Air separation**: gas entering the reservoir from the dip tube pipe rises to the surface and vents. Air in the collector loop vents through the auto air vent at top.
- **Gravity drain**: when V_air opens and pump pulls from collector bottom, water drains by gravity + pump suction. Visualize the falling water column and air entering from top.

### Visualization

- **Cross-section schematic**: side view showing tank interior (water level, gas space, dip tube), reservoir (water level, overflow line), collector loop (water/air boundary)
- **Animated water levels**: real-time level changes as pump runs or air is injected
- **Air pocket indicators**: bubbles or shaded regions showing trapped gas
- **Volume accounting**: numeric display of water in each component (tank, reservoir, collectors, pipes)
- **Danger indicators**: red warnings for pump-loses-prime, reservoir overflow, excessive air in system

### Scenarios (Presets)

1. **Normal operation**: system full, pump circulating — verify stable levels
2. **Drain cycle**: active drain empties collectors into reservoir — verify reservoir doesn't overflow
3. **Air injection**: inject air at collector top mid-circulation — watch it travel to reservoir and vent
4. **Low water**: reduce total water volume — see when reservoir drops below pump inlet
5. **Refill after drain**: collectors empty, switch to solar charging — watch collectors refill, reservoir level drop temporarily

## Technical Approach

### Physics Model

```
Reservoir level = f(total_water_volume, tank_volume, collector_volume, pipe_volume)

Key equation (communicating vessels):
  h_reservoir = h_dip_tube_opening − (V_gas_tank / A_tank_cross_section)

When pump runs in mode X:
  Water moves from source → destination at flow_rate L/min
  Volume accounting updates each component
  Air pockets travel with flow (simplified advection)
```

### Stack

Same as Idea 1 (vanilla JS, inline SVG, GitHub Pages). Can share the YAML loader and UI framework.

### Key Modules

1. **`hydraulics.js`** — volume accounting, communicating vessels equation, air pocket tracking
2. **`scenarios.js`** — preset configurations for common test cases
3. **`hydraulic-ui.js`** — cross-section SVG with animated water levels and air regions

## Integration with Idea 1

Two options:

| Approach | Pros | Cons |
|----------|------|------|
| **Separate tab** in same app | Simpler physics (no thermal coupling) | Can't see thermal + hydraulic together |
| **Unified model** | Realistic — thermal expansion affects levels | Significantly more complex |

**Recommendation**: Start as a separate tab. Add thermal coupling later if needed.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Communicating vessels math is tricky with gas compression | Incorrect levels displayed | Validate against hand calculations for known states |
| Reservoir sizing depends on this being accurate | Could over/undersize reservoir | Use conservative margins; label sim as qualitative |
| Air advection in pipes is complex fluid dynamics | Oversimplified air behavior | Use discrete "air slug" model, not CFD — good enough for intuition |

## Success Criteria

- Reservoir level matches expected communicating vessels equilibrium (±1cm) for a fully filled system
- Drain cycle shows collector water transferring to reservoir without overflow for reservoir ≥ 30L
- Air injected at any point eventually reaches the reservoir or auto air vent (no permanent trapped pockets in normal flow)
- Low-water scenario correctly flags pump prime loss when reservoir drops below outlet
