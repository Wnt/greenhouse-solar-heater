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
| Auto air vent | Automatic bleed valve | Collector top (highest point, ~285cm) |

### Valve Topology: On/Off Manifold

The system uses 8 motorized on/off ball valves (DN15, 230V) arranged in input and output manifolds around the pump. Any input source can be routed to any output destination. Control logic ensures exactly one input and one output valve are open at a time.

**Input manifold** (pump inlet):

| Valve | Source | Used In |
|-------|--------|---------|
| VI-btm | Tank bottom (cool water) | Solar charging |
| VI-top | Tank top via dip tube (hot water) | Greenhouse heating |
| VI-coll | Collector bottom pipe | Active drain |

**Output manifold** (pump outlet):

| Valve | Destination | Used In |
|-------|-------------|---------|
| VO-coll | Collector bottom (supply) | Solar charging, refill |
| VO-rad | Radiator in greenhouse | Greenhouse heating |
| VO-tank | Tank return | Active drain |

**Collector top** (at panel top, ~280cm):

| Valve | Path | Used In |
|-------|------|---------|
| V_ret | Collector top → reservoir | Solar charging (return path) |
| V_air | Collector top → open air | Active drain (air intake) |

**Additional:**

| Component | Type | Purpose |
|-----------|------|---------|
| Flow sensor | On collector bottom pipe | Detects empty collectors during drain |
| SV-drain | Manual ball valve, hose barb | Drain system at lowest point |
| SV-fill | Manual ball valve, hose barb | Fill system (garden hose) |

### Piping

- 22mm PEX throughout, insulated
- DN15 (½") valves with PEX → threaded adapters
- Collector pipes slope 2–3 cm/m toward drain point
- Typical flow: 4–10 L/min
- Radiator return connects via tee fitting at tank bottom pipe

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
| Shelly Pro 4PM | Main controller: pump, fan, heater contactor, space heater |
| Shelly Pro 2PM ×3 | Valve relays (2 valves each, 6 of 8 valves) |
| Shelly Plus 1 | Remaining valve(s), V_air as fail-safe |
| Shelly Plus 1 + Add-on | Temperature sensor hub (DS18B20) |

Communication: HTTP RPC over local network (Shelly scripting), optionally MQTT.

Total relay outputs needed: 8 valves + pump + fan + 2 heaters = 12.

### Air Management

No flow restrictor needed at panel bottom. Air is managed by:
- **Auto air vent** at collector top (highest point) — continuously bleeds trapped air
- **Open reservoir** acts as air separator
- **Upward flow** through collectors carries air bubbles to the top naturally
- Pump provides sufficient head (~4m max) to clear any air pockets

## Operating Modes

### Mode 1: Solar Charging

**Trigger:** T_collector > T_tank_bottom + 7°C
**Stop:** T_collector < T_tank_bottom + 3°C

| Valve | State |
|-------|-------|
| VI-btm | OPEN |
| VO-coll | OPEN |
| V_ret | OPEN |
| All others | CLOSED |

**Flow loop:**
- Supply: Tank bottom → VI-btm → Pump → VO-coll → Collector bottom → up through panels
- Return: Collector top → V_ret → Reservoir → overflows into tank

**Actuators:** Pump ON, Fan OFF

### Mode 2: Greenhouse Heating

**Trigger:** T_greenhouse < 10°C
**Stop:** T_greenhouse ≥ 12°C

| Valve | State |
|-------|-------|
| VI-top | OPEN |
| VO-rad | OPEN |
| All others | CLOSED |

**Flow loop:**
- Supply: Tank top (dip tube) → VI-top → Pump → VO-rad → Radiator
- Return: Radiator → tee at tank bottom → tank

**Actuators:** Pump ON, Fan ON

### Mode 3: Active Drain (Freeze Protection)

**Trigger:** T_outdoor < 2°C AND collectors not already drained

| Valve | State |
|-------|-------|
| VI-coll | OPEN |
| VO-tank | OPEN |
| V_air | OPEN |
| All others | CLOSED |

**Sequence:**
1. Stop pump
2. Close all valves
3. Open V_air (air enters collector top)
4. Open VI-coll (pump inlet from collector bottom)
5. Open VO-tank (pump outlet to tank)
6. Start pump
7. Monitor flow sensor
8. Flow sensor reads zero → stop pump → close all valves

**Actuators:** Pump ON (until flow=0)

### Mode 4: Refill After Drain

**Trigger:** T_outdoor > 5°C AND collectors drained AND sun available

Switch to solar charging valve states. Pump fills collectors with water from tank.

### Mode 5: Emergency Heating

**Trigger:** T_greenhouse < 5°C AND tank heat insufficient

- 2kW space heater ON
- Jäspi internal heater element ON (optional, boost tank)

### Mode 6: Winter Shutdown

Full seasonal shutdown for deep winter (-25°C periods):
- Run active drain sequence
- Open SV-drain to empty all outdoor pipes via gravity
- Space heater on standalone thermostat for greenhouse minimum temperature

## Physical Layout

### Height Map

```
285cm ─── Auto air vent (highest point)

280cm ─── Collector top (upper panel)
          V_ret, V_air (collector top manifold)
          T_collector sensor

200cm ─── Open reservoir (on top of Jäspi)
          Jäspi tank top (internal water level)

170cm ─── Upper panel bottom / Lower panel top

 30cm ─── Collector bottom (lower panel)
          Flow sensor

 20cm ─── Pump (Wilo Star Z20/4)
          Input manifold (VI-btm, VI-top, VI-coll)
          Output manifold (VO-coll, VO-rad, VO-tank)
          SV-drain, SV-fill (service valves)

  0cm ─── Ground level
          Jäspi tank bottom (pipe connections)
          Radiator + fan (inside greenhouse, near ground)
          2kW space heater (inside greenhouse)
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
3. **One input, one output** — exactly one input valve and one output valve open at a time
4. **Drain before freezing** — trigger at 2°C gives safety margin before 0°C
5. **Slope collector pipes** — 2–3 cm/m toward drain to ensure complete drainage
6. **Union fittings** — on all valves for easy replacement
7. **Fail-safe V_air** — consider wiring V_air as normally-open so collectors drain on power loss

## Budget Estimate

| Category | Cost |
|----------|------|
| Shelly hardware (Pro 4PM + 3× Pro 2PM + Plus 1 + Add-on) | ~550€ |
| DS18B20 sensors | ~40€ |
| 8× motorized on/off valves (DN15) | ~200€ |
| Flow sensor | ~25€ |
| Auto air vent | ~10€ |
| 2× manual service valves | ~20€ |
| **Control system total** | **~845€** |

Structural materials (wood, slabs, fasteners) budgeted separately.

## Open Design Questions

1. **Reservoir sizing:** 20–50L range — exact size depends on collector loop water volume.
2. **Collector seasonal adjustment:** Fixed angle or seasonally adjustable?
3. **Wind anchoring:** Required for collector frame?
4. **Jäspi internal heater:** Use as backup boost, or leave disconnected?
5. **Radiator return routing:** Tee at tank bottom vs dedicated return connection.
6. **Fail-safe behavior:** Should V_air be normally-open (drain on power failure)?

## Documentation Format

- **`system.yaml`** — single source of truth for all component specs, heights, valve states
- **Mermaid (`.mmd`)** — control logic, state machines, operating mode transitions
- **SVG (`.svg`)** — physical layout with height scale, pipe routing, flow direction arrows

AI agents validate by reading `system.yaml` for correctness (heights, flow physics, valve logic). Diagrams are visual representations of the YAML data.
