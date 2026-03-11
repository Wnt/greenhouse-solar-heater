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
| Storage tank | Jäspi VLM 300L | Ferritic stainless steel, used unpressurized, ALL connections at bottom (0cm) |
| Open reservoir | Vented container, 20–50L | On top of tank (~200cm), air separator, connected to dip tube |
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
| VI-top | Reservoir bottom (de-aired hot water) | Greenhouse heating |
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

### Tank Interface

All physical pipe connections on the Jäspi tank are at the **bottom** (0cm):

- **Tank bottom port:** direct connection to the bottom of the tank. Used for drawing cool water (solar charging), receiving radiator return water, and receiving drained collector water.
- **Tank top port (dip tube):** has an internal dip tube reaching the top of the water column (~185cm). Pipe runs **UP** from dip tube port (0cm) to the reservoir at ~200cm. This is the primary path for water and gas to move between the tank top and the reservoir.

### Reservoir as Air Separator

The reservoir sits on top of the Jäspi (~200cm) and serves as the system's **primary air separator**. It has three connections:

1. **Top/mid inlet — dip tube pipe:** from dip tube port (0cm) up to reservoir. Hot water from the tank top exits here; trapped gas separates and vents to atmosphere.
2. **Top/mid inlet — V_ret pipe:** collector return water enters here during solar charging.
3. **Bottom outlet:** clean, de-aired water feeds VI-top → pump. Gravity head (~200cm) ensures the pump never loses prime.

The Jäspi tank has no vent at the top — gas trapped above the dip tube opening (~185cm) cannot exit downward. By routing all water through the open reservoir, gas is separated before reaching the pump. The pump always pushes water through the radiator (positive pressure clears trapped gas from the radiator's small parallel channels).

### Piping

- 22mm PEX throughout, insulated
- DN15 (½") valves with PEX → threaded adapters
- Collector pipes slope 2–3 cm/m toward drain point
- Typical flow: 4–10 L/min
- Radiator return connects to tank bottom port (direct)
- Reservoir-to-tank pipe runs from reservoir top/mid (200cm) DOWN to dip tube port (0cm), then UP through internal dip tube to ~185cm inside tank

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

### Control Hardware — Shelly Components

12 relay outputs needed: 8 motorized valves + pump + fan + 2 heaters.

| Device | Qty | Outputs | Assignment | Est. Price |
|--------|-----|---------|------------|------------|
| **Shelly Pro 4PM** | 1 | 4 | Pump, radiator fan, immersion heater, space heater | ~60€ |
| **Shelly Pro 2PM** | 4 | 2 each | 8 motorized valves (2 per unit) | ~180€ |
| **Shelly Plus 1 + Add-on** | 1 | — | Temperature sensor hub (DS18B20, 1-Wire) | ~30€ |
| **DS18B20 sensors** | 5–7 | — | T_coll, T_tank×2, T_greenhouse, T_outdoor (+2 optional) | ~35€ |

**Total Shelly + sensors: ~305€**

**Pro 4PM** is the main brain — runs Shelly scripts for control logic, has power monitoring on all 4 channels (useful for detecting stuck pump, verifying fan is running).

**Pro 2PM valve assignments:**

| Unit | Output 1 | Output 2 | Location |
|------|----------|----------|----------|
| #1 | VI-btm | VI-top | Input manifold (ground) |
| #2 | VI-coll | VO-coll | Input/output manifold (ground) |
| #3 | VO-rad | VO-tank | Output manifold (ground) |
| #4 | V_ret | V_air | Collector top (~280cm) |

**V_air fail-safe:** Wired with a normally-open spring-return valve. Relay ON = valve closed (normal operation). Relay OFF or power loss = valve opens, allowing air in so collectors drain automatically.

**Sensor hub:** Shelly Plus Add-on connects DS18B20 sensors via 1-Wire bus. Supports up to 5 sensors natively; a second Add-on may be needed if all 7 sensors are used.

**Flow sensor** connects to a digital input on the Plus 1 or Pro 4PM.

**Communication:** HTTP RPC over local network (Shelly scripting), optionally MQTT.

### Air Management

**Collector loop:** Auto air vent at collector top (highest point) continuously bleeds trapped air. Upward flow carries bubbles to the top naturally.

**Tank gas venting:** The Jäspi has no top vent — gas trapped above the dip tube (~185cm) cannot escape downward. The reservoir solves this by acting as the primary air separator:
- Water from the tank top exits via dip tube → enters reservoir at top/mid level
- Gas separates in the reservoir and vents to atmosphere (open top)
- Clean, de-aired water exits the reservoir bottom to the pump
- The pump **never** draws directly from the dip tube — it always draws from the reservoir bottom

**Radiator gas clearing:** The pump pushes pressurized water through the radiator (not suction). Positive pressure clears gas from the car radiator's small parallel channels more effectively. Gas returns to the tank and eventually reaches the reservoir via the dip tube.

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
- Supply: Tank bottom port (0cm) → VI-btm → Pump → VO-coll → Collector bottom (30cm) → up through panels (to 280cm)
- Return: Collector top (280cm) → V_ret → Reservoir top (200cm) → dip tube pipe down to 0cm → up through internal dip tube → exits at ~185cm inside tank (enters at TOP = excellent stratification)

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
- Supply: Tank top (hot water) → dip tube → exits 0cm → pipe UP to reservoir top (~200cm, gas separates) → reservoir bottom → VI-top → Pump → VO-rad → Radiator
- Return: Radiator → tank bottom port (0cm) → enters tank at bottom

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

200cm ─── Open reservoir / air separator (on top of Jäspi)
          IN:  dip tube pipe (from 0cm below) + V_ret pipe (collector return)
          OUT: bottom outlet → VI-top → pump

~185cm── Dip tube opening inside tank (top of water column)

170cm ─── Upper panel bottom / Lower panel top

 30cm ─── Collector bottom (lower panel)
          Flow sensor

 20cm ─── Pump (Wilo Star Z20/4)
          Input manifold (VI-btm, VI-top, VI-coll)
          Output manifold (VO-coll, VO-rad, VO-tank)
          SV-drain, SV-fill (service valves)

  0cm ─── Ground level
          Jäspi tank — pipe connections at bottom:
            • Tank bottom port (direct to bottom of tank)
            • Dip tube port (pipe runs UP to reservoir at 200cm)
          Radiator + fan (inside greenhouse, near ground)
          2kW space heater (inside greenhouse)
```

### Collector Frame

- 48×98mm structural timber
- Foundation: concrete slabs on sand bed (20cm excavation)
- Fasteners: 6×120 structural screws (~60), angle brackets (12), joist hangers (4)
- Snow load rated: 2.5 kN/m² (~1000kg)
- Total load capacity: ~1100kg (panels + snow)

## Water Treatment

**Materials in contact with water:** ferritic stainless steel (tank), PEX (piping), brass (valves), bronze/stainless (pump), copper (solar collectors).

**Biological growth:** The open reservoir is the main risk area — cover it with an opaque lid (keep it vented). Darkness prevents algae. The solar loop regularly exceeds 60°C, which suppresses growth elsewhere in the system. If needed, periodic food-grade hydrogen peroxide (30–50 ppm) can be added — it decomposes cleanly.

**Corrosion:** Low-moderate risk. Stainless tank and PEX are highly resistant. The main concern is copper collectors + brass valves in oxygenated water (the open reservoir continuously dissolves O₂). Use a combined corrosion inhibitor / biocide for open mixed-metal systems (e.g. Sentinel X100 or Fernox Protector F1). These contain oxygen scavengers, mixed-metal inhibitors, and biocide. Check inhibitor concentration annually.

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
| Shelly hardware (Pro 4PM + 4× Pro 2PM + Plus 1 + Add-on) | ~310€ |
| DS18B20 sensors (5–7×) | ~35€ |
| 8× motorized on/off valves (DN15) | ~200€ |
| Flow sensor | ~25€ |
| Auto air vent | ~10€ |
| 2× manual service valves | ~20€ |
| **Control system total** | **~600€** |

Structural materials (wood, slabs, fasteners) budgeted separately.

## Open Design Questions

1. **Reservoir sizing:** 20–50L range — exact size depends on collector loop water volume. Must have 3 pipe penetrations (2× top/mid, 1× bottom).
2. **Collector seasonal adjustment:** Fixed angle or seasonally adjustable?
3. **Wind anchoring:** Required for collector frame?
4. **Jäspi internal heater:** Use as backup boost, or leave disconnected?
5. **Fail-safe behavior:** Should V_air be normally-open (drain on power failure)?

## Documentation Format

- **`system.yaml`** — single source of truth for all component specs, heights, valve states
- **Mermaid (`.mmd`)** — control logic, state machines, operating mode transitions
- **SVG (`.svg`)** — physical layout with height scale, pipe routing, flow direction arrows

AI agents validate by reading `system.yaml` for correctness (heights, flow physics, valve logic). Diagrams are visual representations of the YAML data.
