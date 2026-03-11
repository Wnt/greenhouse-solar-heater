# Kasvihuone Solar Heating System — Design Specification

## Overview

Solar thermal heating system for a greenhouse in Southwest Finland. Heats water using solar collectors, stores heat in a 300L tank, and distributes it to the greenhouse via a car radiator and fan. An open, unpressurized system with active pump-driven drainback for freeze protection.

**Design temperature:** -25°C (winter)
**Greenhouse target:** ≥ 10°C
**Location:** Southwest Finland

## System Components

All component specifications are defined in `system.yaml` (source of truth).

### Core Components

| Component | Model/Type | Key Spec |
|-----------|-----------|----------|
| Solar collectors | 2× flat plate, 2m×1m | 4m² total, mounted 30–280cm height |
| Storage tank | Jäspi VLM 300L | Used unpressurized, connections at bottom |
| Open reservoir | Vented container, 20–50L | On top of tank at ~200cm, drainback buffer |
| Circulation pump | Wilo Star Z20/4 | 34/51/71W, 230V, near ground |
| Radiator | Car radiator + 230V fan | Inside greenhouse, heat distribution |
| Space heater | 2kW fan heater | Emergency/backup |

### Valve Arrangement (3× three-way motorized ball valves)

| Valve | Location | Position A (normal) | Position B (drain) |
|-------|----------|---------------------|---------------------|
| V_top | Collector top | Collector output → reservoir | Open to air intake |
| V_pump_in | Pump inlet | Draw from tank | Draw from collector bottom |
| V_pump_out | Pump outlet | Push to collectors/radiator | Push to tank |

All valves: DN15, 230V actuator, motorized ball valve.

A **flow sensor** at the collector bottom pipe detects when collectors are empty during drain.

### Piping

- 22mm PEX throughout
- DN15 (½") valves with PEX → threaded adapters
- Pipes insulated
- Collector pipes slope 2–3 cm/m toward drain point
- Typical flow: 4–10 L/min

### Sensors (DS18B20 via Shelly Plus Add-on)

| Sensor | Location | Purpose |
|--------|----------|---------|
| T_collector | Collector outlet (280cm) | Solar charging trigger |
| T_tank_top | Tank upper region | Heating source temperature |
| T_tank_bottom | Tank lower region | Charging delta calculation |
| T_greenhouse | Greenhouse air | Heating trigger |
| T_outdoor | Outside, shaded | Freeze protection trigger |
| T_radiator_in | Radiator inlet (optional) | Performance monitoring |
| T_radiator_out | Radiator outlet (optional) | Performance monitoring |

### Control Hardware

| Device | Role |
|--------|------|
| Shelly Pro 4PM | Main controller, runs scripts. Outputs: pump, fan, heater contactor, spare |
| Shelly Pro 2PM/3 | Additional valve relays (3 valves need 3 relay outputs) |
| Shelly Plus 1 + Add-on | Temperature sensor hub (DS18B20) |

Communication: HTTP RPC over local network (Shelly scripting), optionally MQTT.

## Operating Modes

### Mode 1: Solar Charging

**Trigger:** T_collector > T_tank_bottom + 7°C

Water circulates from the tank through the solar collectors and back, heating the tank.

**Flow loop:**
- Supply: Tank bottom → V_pump_in(A) → Pump → V_pump_out(A) → Collector bottom → up through panels
- Return: Collector top → V_top(A) → Reservoir → overflows into tank

**Valve states:** V_top=A, V_pump_in=A, V_pump_out=A
**Actuators:** Pump ON, Fan OFF

### Mode 2: Greenhouse Heating

**Trigger:** T_greenhouse < 10°C

Hot water from the tank circulates through the radiator inside the greenhouse.

**Flow loop:**
- Supply: Tank top (via internal dip tube) → V_pump_in(A) → Pump → V_pump_out(A) → Radiator
- Return: Radiator → Tank bottom

**Valve states:** V_top=A, V_pump_in=A, V_pump_out=A
**Actuators:** Pump ON, Fan ON

**Note:** V_pump_in draws from tank top for heating (hot water) vs tank bottom for charging (cool water). The valve routing for selecting tank top vs bottom needs further detail — either V_pump_in has a third path, or a separate valve (V_tank) selects the tank connection.

### Mode 3: Active Drain (Freeze Protection)

**Trigger:** T_outdoor < 2°C AND collectors not already drained

The pump actively empties the collectors by pulling water from the bottom while air enters from the top.

**Sequence:**
1. Stop pump
2. Switch V_top → B (air intake)
3. Switch V_pump_in → B (draw from collector bottom)
4. Switch V_pump_out → B (push to tank)
5. Start pump
6. Monitor flow sensor
7. Flow sensor reads zero → stop pump

**Valve states:** V_top=B, V_pump_in=B, V_pump_out=B
**Actuators:** Pump ON (until flow=0)

### Mode 4: Refill After Drain

**Trigger:** T_outdoor > 5°C AND collectors drained AND sun available

Switch all valves back to position A. Resume normal solar charging — pump fills collectors with water from the tank.

### Mode 5: Emergency Heating

**Trigger:** T_greenhouse < 5°C AND tank heat insufficient

- 2kW space heater ON
- Jäspi internal heater element ON (optional, boost tank)

### Mode 6: Winter Shutdown

Full seasonal shutdown for deep winter (-25°C periods):
- Run active drain sequence
- Optionally drain all outdoor pipes
- Space heater on standalone thermostat for greenhouse minimum temperature

## Physical Layout

### Height Map

```
280cm ─── Collector top (upper panel)
          V_top (3-way valve)
          T_collector sensor

200cm ─── Open reservoir (on top of Jäspi)
          Jäspi tank top (internal water level)

170cm ─── Upper panel bottom / Lower panel top

 30cm ─── Collector bottom (lower panel)
          Flow sensor

 20cm ─── Pump (Wilo Star Z20/4)
          V_pump_in, V_pump_out
          Radiator + fan (inside greenhouse)
          2kW space heater (inside greenhouse)

  0cm ─── Ground level
          Jäspi tank bottom (pipe connections)
```

### Collector Frame

- 48×98mm structural timber
- Foundation: concrete slabs on sand bed (20cm excavation)
- Fasteners: 6×120 structural screws (~60), angle brackets (12), joist hangers (4)
- Snow load rated: 2.5 kN/m² (~1000kg)
- Total load capacity: ~1100kg (panels + snow)

## Safety Rules

1. **Always stop pump before switching any valve** — prevents water hammer and valve damage
2. **Never run pump dry** — flow sensor stops pump when collectors empty
3. **Drain before freezing** — trigger at 2°C gives safety margin before 0°C
4. **Slope collector pipes** — 2–3 cm/m toward drain to ensure complete drainage
5. **Union fittings** — on all valves for easy replacement

## Budget Estimate

| Category | Cost |
|----------|------|
| Shelly hardware | ~350€ |
| DS18B20 sensors | ~40€ |
| 3× motorized valves | ~180€ |
| Flow sensor | ~25€ |
| **Control total** | **~595€** |

Structural materials (wood, slabs, fasteners) budgeted separately.

## Open Design Questions

1. **Tank top/bottom selection:** V_pump_in currently selects tank vs collector-bottom. How do we also select between tank-top and tank-bottom for charging vs heating modes? May need a 4th valve (V_tank) or a different valve topology.
2. **Reservoir sizing:** 20–50L range — exact size depends on collector loop water volume.
3. **Collector seasonal adjustment:** Fixed angle or seasonally adjustable?
4. **Wind anchoring:** Required for collector frame?
5. **Jäspi internal heater:** Use as backup boost, or leave disconnected?

## Documentation Format

- **`system.yaml`** — single source of truth for all component specs, heights, valve states
- **Mermaid (`.mmd`)** — control logic, state machines, operating mode transitions
- **SVG (`.svg`)** — physical layout with height scale, pipe routing, flow direction arrows

AI agents validate by reading `system.yaml` for correctness (heights, flow physics, valve logic). Diagrams are visual representations of the YAML data.
