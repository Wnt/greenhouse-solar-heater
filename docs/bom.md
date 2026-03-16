# Control System — Bill of Materials

Complete order list for the kasvihuone solar heating control system. Three vendors, all in stock, March 2026 pricing (EUR incl. VAT).

## Vendor 1: [Nurkan takaa](https://verkkokauppa.nurkantakaa.fi/) — Shelly electronics

Finnish Shelly specialist in Tuusula.

### Core System

| # | Item | Qty | Unit | Total | Role |
|---|------|-----|------|-------|------|
| 1 | Shelly Pro 4PM | 1 | 107.90 | 107.90 | Brain — pump (O1), fan (O2), immersion heater (O3), space heater (O4). Power monitoring. Ethernet. |
| 2 | Shelly Pro 2PM | 4 | 89.00 | 356.00 | Valve relays — 2 valves per unit (8 motorized valves total). Ethernet. |
| 3 | Shelly 1 Gen3 | 1 | 19.00 | 19.00 | Sensor hub host for Add-on. WiFi. *(Replaces discontinued Shelly Plus 1)* |
| 4 | Shelly Plus Add-on | 1 | 16.90 | 16.90 | 1-Wire interface for DS18B20 sensors (up to 5 per Add-on) |
| 5 | DS18B20 temp sensor, 3m cable | 5 | 6.50 | 32.50 | T_collector, T_tank_top, T_tank_bottom, T_greenhouse, T_outdoor |

### Spares & Expansion

| # | Item | Qty | Unit | Total | Rationale |
|---|------|-----|------|-------|-----------|
| 6 | Shelly Pro 2PM | 1 | 89.00 | 89.00 | Spare / wood burner valve (VO-wood) when added |
| 7 | Shelly 1 Gen3 | 1 | 19.00 | 19.00 | Spare sensor hub or 2nd hub for >5 sensors |
| 8 | Shelly Plus Add-on | 1 | 16.90 | 16.90 | Spare / 2nd sensor hub |
| 9 | DS18B20 temp sensor, 3m cable | 3 | 6.50 | 19.50 | 2× optional radiator sensors + 1 spare |

### Networking & Mounting

| # | Item | Qty | Unit | Total | Role |
|---|------|-----|------|-------|------|
| 10 | Zyxel GS-108BV5 (8-port Gigabit) | 1 | 24.90 | 24.90 | Unmanaged switch, wall-mount. Ports: 1 uplink + 1 Pro 4PM + 5× Pro 2PM = 7 of 8. |
| 11 | DIN-kiskopidike PLUS-kokoisille | 2 | 4.50 | 9.00 | DIN rail adapter for the two Shelly 1 Gen3 units |
| 12 | Mean Well DIN rail PSU 24V 15W | 1 | 19.00 | 19.00 | Powers all motorized valve actuators (24V DC) |

| | | | **Nurkan takaa total** | **729.60** | |

### Stock check (March 2026)

| Item | Need | In stock |
|------|------|----------|
| Pro 4PM | 1 | 7 |
| Pro 2PM | 5 | 7 |
| 1 Gen3 | 2 | 25 |
| Plus Add-on | 2 | 28 |
| DS18B20 3m | 8 | 23 |
| Zyxel GS-108BV5 | 1 | 9 |
| DIN adapter (PLUS-size) | 2 | 31 |

---

## Vendor 2: [hpcontrol.fi](https://hpcontrol.fi/elektrozawor-kulowy-1-2-cala-z-silownikiem-a80-a82.html) — Motorized valves

Polish manufacturer with Finnish website. In stock, ships within 24h.

| # | Item | Qty | Unit | Total | Role |
|---|------|-----|------|-------|------|
| 13 | Palloventtiili ½" DN15 PN40 + A83 9-24V DC 2-wire | 8 | 64.53 | 516.24 | All motorized valves (see assignment table below) |

| | | | **hpcontrol.fi total** | **516.24** | |

**How to order:** Select "½ tuumaa DN15" for the valve, and **"A83 9-24V DC 2-johtiminen"** for the actuator. The 2-wire actuator auto-closes when power is removed — directly compatible with 1 Shelly relay per valve (relay ON = open, relay OFF = close).

### Valve assignments

| Valve | Manifold | Port | Mode |
|-------|----------|------|------|
| VI-btm | Input #1 | Tank bottom → pump | Solar charging, wood burning |
| VI-top | Input #2 | Reservoir → pump | Greenhouse heating |
| VI-coll | Input #3 | Collector bottom → pump | Active drain |
| VO-coll | Output #1 | Pump → collector bottom | Solar charging |
| VO-rad | Output #2 | Pump → radiator | Greenhouse heating |
| VO-tank | Output #3 | Pump → tank return | Active drain |
| V_ret | Collector top | Collector top → reservoir | Solar charging, wood burning |
| V_air | Collector top | Collector top → open air | Active drain (air intake) |

### Future expansion: VO-wood (9th valve)

When adding the wood-burning heater, order one more valve+actuator set (€64.53) and connect to the spare 4th port on the output manifold. Controlled by the spare Pro 2PM (#6).

---

## Vendor 3: [Biltema](https://www.biltema.fi/) — Manifolds, fittings, service valves

Pick up in-store.

| # | Item | Art. | Qty | Unit | Total | Role |
|---|------|------|-----|------|-------|------|
| 14 | [Jakaja 3 putkea](https://www.biltema.fi/rakentaminen/lvi/vesijarjestelmat-ja-saniteetti/pex-letkut-ja-liittimet/pex-haaroitusputket/jakaja-3-putkea-2000061955) | 84517 | 1 | 19.95 | 19.95 | **Input manifold.** ¾" inlet (pump suction) → 3× ½" outlets for VI-btm, VI-top, VI-coll. |
| 15 | [Jakaja 4 putkea](https://www.biltema.fi/rakentaminen/lvi/vesijarjestelmat-ja-saniteetti/pex-letkut-ja-liittimet/pex-haaroitusputket/jakaja-4-putkea-2000061956) | 84518 | 1 | 25.95 | 25.95 | **Output manifold.** ¾" inlet (pump pressure) → 4× ½" outlets for VO-coll, VO-rad, VO-tank, VO-wood. 4th port capped until wood burner added. |
| 16 | [Palloventtiili ½" R15](https://www.biltema.fi/rakentaminen/lvi/vesijarjestelmat-ja-saniteetti/venttiilit-lvi/palloventtiili-lvi/palloventtiili-12-r15-2000058624) | — | 2 | 8.95 | 17.90 | Manual service valves: SV-drain (lowest point) + SV-fill (hose fill). |
| 17 | [Letkuyhde ½"](https://www.biltema.fi/en-fi/boat/vvs/hose-nipples/hose-nipple-12-x-12-2000049790) | — | 2 | ~4.00 | 8.00 | Hose barb adapters for SV-drain and SV-fill (garden hose). |
| 18 | Tulppa ½" (plug) | — | 1 | ~2.00 | 2.00 | Cap for the 4th output manifold port (VO-wood future). |
| 19 | 22mm PEX → ½" UK puserrusliitin | — | 8 | ~4.00 | 32.00 | PEX-to-valve adapters (male ½" BSP → valve female ½" BSP). |
| 20 | Nipples, PTFE tape, misc fittings | — | — | — | ~15.00 | Short nipples, reducers, sealing. |

| | | | | **Biltema total** | **~121** | |

### Auto air vent — removed

No auto air vent at the collector top. Sub-atmospheric pressure there (80cm water column falling to reservoir at 200cm) draws air IN rather than venting it out — confirmed by testing with a manual valve at the collector top. Trapped air in the collector loop is carried by water flow through V_ret to the open reservoir, where it vents to atmosphere.

---

## Manifold & Valve Layout

```
                         COLLECTOR TOP (~280 cm)
                         ┌──────────────────────┐
                         │  V_ret ──→ reservoir  │
                         │  V_air ──→ open air   │
                         └──────┬───────────────┘
                                │ collector pipes
                                │
              ┌─────────────────┤ (tee at collector bottom)
              │                 │
    ┌─────────┴──────┐  ┌──────┴─────────┐
    │ INPUT MANIFOLD │  │ OUTPUT MANIFOLD │
    │ Jakaja 3       │  │ Jakaja 4        │
    │ (¾" to pump)   │  │ (¾" from pump)  │
    ├────────────────┤  ├────────────────┤
    │ VI-btm ← tank  │  │ VO-coll → coll │
    │ VI-top ← res.  │  │ VO-rad  → rad  │
    │ VI-coll ← coll │  │ VO-tank → tank │
    └───────┬────────┘  │ VO-wood → wood │ (future, capped)
            │           └───────┬────────┘
            │    ┌──────┐       │
            └──→ │ PUMP │ ←─────┘
                 │ ¾"   │
                 └──────┘
```

### Manifold connections

- Manifold outlets (½" male) thread directly into valve inlets (½" female BSP) — no adapters needed.
- Manifold inlets (¾") connect to the pump's ¾" ports.
- Collector bottom pipe connects to BOTH VI-coll (input manifold) and VO-coll (output manifold) via a tee fitting.
- Wood burner return pipe goes directly to the reservoir (open top, no valve needed).

### Operating modes vs manifold ports

| Mode | Input valve | Output valve | Collector top | Purpose |
|------|-------------|--------------|---------------|---------|
| Solar charging | VI-btm | VO-coll | V_ret open | Heat tank from sun |
| Greenhouse heating | VI-top | VO-rad | — | Warm greenhouse from tank |
| Active drain | VI-coll | VO-tank | V_air open | Empty collectors (freeze protection) |
| Wood burning (future) | VI-btm | VO-wood | V_ret open | Heat tank from wood burner |

---

## Wiring

### Valve circuit (24V DC)

```
DIN rail:  24V PSU ──→ Pro 2PM relays ──→ valve actuators
                       (1 relay per valve)  (A83 2-wire:
                                             power+ / power-)
```

No 230V at any valve location. All mains voltage stays on the DIN rail (Shelly devices + PSU).

### Relay wiring detail (2-wire actuator)

Each A83 2-wire actuator has 2 wires: **power+** and **power-**. The relay simply switches 24V DC to the valve:

- **Relay ON** → 24V applied → valve **opens** (motor drives open)
- **Relay OFF** → voltage removed → valve **auto-closes** (motor return)

One relay per valve, 2 valves per Pro 2PM. Direct compatibility — no changeover relays, no inverted logic, no special wiring. All valves behave identically.

On power loss, all relays de-energize and all valves auto-close. This is the correct behavior for idle state (all valves closed).

### V_air design rationale

V_air is a standard normally-closed valve (same as all others). A normally-open design (spring-return, solenoid, or vacuum breaker) was considered and rejected: the sub-atmospheric pressure at the collector top (~0.25 bar vacuum from the 250cm water column below) would draw air into the system constantly during idle. Fail-safe drain on power loss is not possible regardless of V_air design — the collectors sit below the reservoir and cannot gravity-drain, and the pump requires power. Freeze protection depends on the 2°C trigger and the pump completing a drain cycle (~3 min) while power is available.

---

## Order Summary

| Vendor | Items | Total (EUR) |
|--------|-------|-------------|
| Nurkan takaa | Shelly electronics, sensors, switch, PSU, DIN adapters | 729.50 |
| hpcontrol.fi | 8× motorized valve DN15 + A83 9-24V DC 2-wire actuator | 516.24 |
| Biltema | Manifolds, service valves, fittings, adapters | ~121 |
| **Grand total** | | **~1,367** |

### Future expansion cost (wood burner)

| Item | Source | Cost |
|------|--------|------|
| 1× motorized valve DN15 + A83 9-24V DC 2-wire | hpcontrol.fi | 64.53 |
| Remove plug from output manifold port 4, install valve | — | 0 |
| PEX piping to/from wood burner | Biltema | ~20-30 |
| **Wood burner plumbing total** | | **~80** |

The spare Pro 2PM (#6) and the 4th manifold port are already in the base order.
