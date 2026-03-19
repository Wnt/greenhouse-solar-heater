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

## Vendor 3: [Biltema](https://www.biltema.fi/) — Manifolds, tees, fittings

Pick up in-store.

| # | Item | Qty | Unit | Total | Role |
|---|------|-----|------|-------|------|
| 14 | [Jakaja 3 putkea](https://www.biltema.fi/rakentaminen/lvi/vesijarjestelmat-ja-saniteetti/pex-letkut-ja-liittimet/pex-haaroitusputket/jakaja-3-putkea-2000061955) | 1 | 19.95 | 19.95 | **Input manifold.** ¾" inlet (pump suction) → 3× ½" outlets. |
| 15 | [Jakaja 4 putkea](https://www.biltema.fi/rakentaminen/lvi/vesijarjestelmat-ja-saniteetti/pex-letkut-ja-liittimet/pex-haaroitusputket/jakaja-4-putkea-2000061956) | 1 | 25.95 | 25.95 | **Output manifold.** ¾" inlet (pump pressure) → 4× ½" outlets. 4th port capped for future VO-wood. |
| 16 | [Puserrusliitin T-yhde 22×22×22mm](https://www.biltema.fi/rakentaminen/lvi/vesijarjestelmat-ja-saniteetti/puserrusliittimet/messinkiset-puserrusliittimet/puserrusliitin-t-yhde-22-x-22-x-22-mm-2000053854) | 1 | 12.95 | 12.95 | **Collector bottom tee.** Splits collector bottom pipe to VI-coll and VO-coll branches. |
| 17 | [T-liitin ½" UK](https://www.biltema.fi/rakentaminen/lvi/vesijarjestelmat-ja-saniteetti/kierreliittimet/t-liittimet/t-liitin-uros-12-2000058695) | 1 | ~5.00 | 5.00 | **Collector top tee.** Splits to V_ret and V_air. |
| 18 | ½" nipple UK-UK | 2 | ~2.00 | 4.00 | Connect collector top tee to V_ret and V_air valves (tee female → nipple → valve female). |
| 19 | [Palloventtiili ½" R15](https://www.biltema.fi/rakentaminen/lvi/vesijarjestelmat-ja-saniteetti/venttiilit-lvi/palloventtiili-lvi/palloventtiili-12-r15-2000058624) | 2 | 8.95 | 17.90 | Manual service valves: SV-drain + SV-fill. |
| 20 | [Letkuyhde ½"](https://www.biltema.fi/en-fi/boat/vvs/hose-nipples/hose-nipple-12-x-12-2000049790) | 2 | ~4.00 | 8.00 | Hose barb adapters for service valves. |
| 21 | Tulppa ½" | 1 | ~2.00 | 2.00 | Cap for the 4th output manifold port (VO-wood future). |
| 22 | PTFE tape, misc | — | — | 5.00 | Sealing. |

| | | | **Biltema total** | **~101** | |

## Vendor 4: [K-Rauta](https://www.k-rauta.fi/) — PEX-to-valve adapters

22mm PEX pairs with ¾" BSP in standard plumbing, but the valves are ½" BSP. Biltema doesn't carry the 22mm × ½" reducing compression fitting. K-Rauta does.

| # | Item | Qty | Unit | Total | Role |
|---|------|-----|------|-------|------|
| 23 | [Puserrusliitin PROF 22×½" UK erikoismessinki](https://www.k-rauta.fi/tuote/puserrusliitin-prof-22x12-ulkokierre-erikoismessinki/6438313114475) | 8 | ~6.00 | ~48.00 | 22mm PEX → ½" male BSP. One per valve pipe-side connection (see adapter map below). |

| | | | **K-Rauta total** | **~48** | |

---

## Vendor 5: [Triopak](https://www.triopak.fi/) — Wiring, terminals, DIN rail

| # | Item | Spec | Qty | Est. price | Role |
|---|------|------|-----|-----------|------|
| 24 | 2-conductor cable 2×0.75mm² | MSO2X075 or YSLY | ~30m | ~15.00 | 24V DC valve wiring. 6 ground-level valves × ~2m + 2 collector top valves × ~8m. |
| 25 | Pääteholkit 0.75mm² (insulated ferrules) | — | 50 pcs | ~8.00 | For every wire end at screw terminals. |
| 26 | [DIN rail 35mm perforated, 2m](https://www.triopak.fi/fi/tuote/DIN-KISKO) | TS35/F6 | 1 | ~8.00 | Cut to ~60cm for all Shelly devices + PSU. |
| 27 | DIN rail end stops | — | 4 | ~3.00 | Keep devices from sliding. |
| 28 | [DIN rail terminal block 2.5mm² red](https://www.triopak.fi/fi/tuote/SR25BL) | SR25 series | 4 | ~5.00 | 24V+ distribution bus: PSU → Pro 2PM relay COMs. |
| 29 | DIN rail terminal block 2.5mm² blue | SR25 series | 4 | ~5.00 | 24V- (GND) distribution bus: PSU → all valve power- wires. |
| 30 | DIN rail terminal block 2.5mm² grey | SR25 series | 4 | ~5.00 | Spare / PE / misc connections. |
| 31 | Terminal block end plates | For SR25 | 4 | ~3.00 | End caps for terminal block rows. |
| 32 | [Shorting bridge 4-pole](https://www.triopak.fi/fi/tuote/QVB4) | QVB4, 20A, SR25 | 2 | ~2.00 | Bridge 24V+ red terminals into bus; bridge 24V- blue terminals into bus. |
| 33 | Cat5e patch cable 0.5m | — | 4 | ~8.00 | Pro 4PM + Pro 2PM #1-#3 (short runs on DIN rail). |
| 34 | Cat5e patch cable 2m | — | 2 | ~6.00 | Pro 2PM #4 + uplink to router. |
| 35 | PTFE tape (spare) | — | 1 | ~2.00 | — |

| | | | | **Triopak total** | **~76** |

## Vendor 6: [Puuilo](https://www.puuilo.fi/) — 230V distribution, wire management

| # | Item | Spec | Qty | Est. price | Role |
|---|------|------|-----|-----------|------|
| 36 | [Wago N-jakoliitin 2 kpl](https://www.puuilo.fi/wago-n-jakoliitin-2-kpl) | 1×6/10mm² → 6×1.5/2.5mm² | 1 pkg (2 pcs) | 15.95 | **230V L and N distribution.** One block splits mains L to Pro 4PM outputs + PSU, the other splits N. DIN rail mount, spring-clamp, no ferrules needed. |
| 37 | [Wago riviliitinpaketti 8-os harmaa/sininen/kevi](https://www.puuilo.fi/wago-riviliitinpaketti-8-os-harm-sin-kevi) | DIN rail, 0.08–2.5mm² | 1 pkg (8 pcs) | ~12.00 | **PE bus + spare terminals.** Colour-coded (grey=L, blue=N, green-yellow=PE) DIN rail terminals for field wiring connections. |
| 38 | [Finbullet vipurasialiitin DIN-kisko 10 kpl](https://www.puuilo.fi/finbullet-vipurasialiitin-din-kisko-10kpl) | 0.08–4mm², 450V/32A | 1 pkg (10+4 bridges) | 12.19 | **Extra terminals** for 24V valve field wiring breakout. Lever-type for easy re-wiring during commissioning. |

| | | | | **Puuilo total** | **~40** |

### 230V distribution detail

The Wago N-jakoliitin blocks replace the need for separate 230V terminal strips with shorting bridges. Each block accepts one thick feed wire (up to 10mm²) and distributes to 6 thinner branch wires (up to 2.5mm²):

```
MAINS 230V L ──→ [Wago N-jakoliitin #1] ──→ Pro 4PM L-in
                                          ──→ 24V PSU L-in
                                          ──→ (4 spare slots)

MAINS 230V N ──→ [Wago N-jakoliitin #2] ──→ Pro 4PM N-in
                                          ──→ 24V PSU N-in
                                          ──→ (4 spare slots)

PE ──→ [Wago 8-os kevi terminals] ──→ all PE connections
```

### Wire management note

None of the checked stores (Biltema, Puuilo, Motonet) carry proper **rei'itetty johtokouru** (slotted panel wiring duct) for electrical cabinets — their cable ducts are decorative surface-mount products. For proper panel duct (e.g. 25×40mm slotted), order from an electrical wholesaler like [Finnparttia](https://www.finnparttia.fi/), [SLO](https://www.slo.fi/), or [Onninen](https://www.onninen.fi/). Alternatively, tidy cable routing with DIN-rail-mounted cable tie bases and nippusiteet (zip ties) works fine for a small cabinet like this.

### 230V installation wiring (not from Triopak)

Fixed installation cables subject to electrical regulations — source from any electrical supplier:

- **1.5mm² 3-conductor** (L/N/PE, e.g. MMJ 3×1.5S): pump (~2m), radiator fan (~5-10m), immersion heater (~2m)
- **2.5mm² 3-conductor** (e.g. MMJ 3×2.5S): space heater 2kW (~5-10m, draws ~9A)
- Proper circuit breaker in distribution board

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

### Connection interfaces

Every joint in the system, from pump to PEX:

```
PUMP (¾") ←→ manifold inlet (¾")         — direct (check pump unions)
Manifold outlet (½" male) → valve (½" female) — direct thread
Valve (½" female) → [22×½" adapter] → 22mm PEX — K-Rauta puserrusliitin
Collector bottom: 22mm PEX tee (22×22×22)  — Biltema, splits to VI-coll + VO-coll
Collector top: [22×½" adapter] → ½" tee → [½" nipple] → V_ret / V_air
V_ret pipe side: valve (½" female) → [22×½" adapter] → 22mm PEX to reservoir
V_air pipe side: valve (½" female) → open to air
```

**Adapter map (8× K-Rauta 22mm×½" UK puserrusliitin):**

| # | Location |
|---|----------|
| 1 | VI-btm → tank bottom pipe |
| 2 | VI-top → reservoir pipe |
| 3 | VI-coll → collector bottom pipe |
| 4 | VO-coll → collector bottom pipe |
| 5 | VO-rad → radiator pipe |
| 6 | VO-tank → tank return pipe |
| 7 | Collector top pipe → ½" tee |
| 8 | V_ret → reservoir return pipe |

- Manifold inlets (¾") connect to the pump's ¾" ports.
- Collector bottom pipe connects to BOTH VI-coll and VO-coll via a 22mm PEX tee.
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

### Full wiring diagram

```
MAINS 230V ──→ ┌──────────────────────────────────────────────────────┐
               │ DIN RAIL                                              │
               │                                                       │
               │  Wago L-dist ──→ Pro 4PM L-in                        │
               │              ──→ 24V PSU L-in                         │
               │  Wago N-dist ──→ Pro 4PM N-in                        │
               │              ──→ 24V PSU N-in                         │
               │  PE bus (kevi terminals)                               │
               │                                                       │
               │  Pro 4PM ──O1──→ pump (230V, ~2m)                    │
               │           ──O2──→ radiator fan (230V, ~5-10m)        │
               │           ──O3──→ immersion heater (230V, ~2m)       │
               │           ──O4──→ space heater (230V, ~5-10m)        │
               │                                                       │
               │  24V PSU ──→ 24V+ bus (red terminals)                 │
               │          ──→ 24V- bus (blue terminals)                │
               │                                                       │
               │  Pro 2PM #1 ─relay1─→ VI-btm  power+ (~1m)           │
               │             ─relay2─→ VI-top  power+ (~1m)            │
               │  Pro 2PM #2 ─relay1─→ VI-coll power+ (~1m)           │
               │             ─relay2─→ VO-coll power+ (~1m)            │
               │  Pro 2PM #3 ─relay1─→ VO-rad  power+ (~2m)           │
               │             ─relay2─→ VO-tank power+ (~1m)            │
               │  Pro 2PM #4 ─relay1─→ V_ret   power+ (~8m, 280cm)   │
               │             ─relay2─→ V_air   power+ (~8m, 280cm)    │
               │  Pro 2PM #5 (spare, future VO-wood)                   │
               │                                                       │
               │  Gen3 + Add-on ──1-Wire──→ DS18B20 sensors (3m each) │
               │                                                       │
               │  Zyxel switch ←──Cat5e──→ all 6 Pro devices           │
               └──────────────────────────────────────────────────────┘
```

No 230V at any valve location. All mains voltage stays on the DIN rail. Valve actuators run on 24V DC via 2×0.75mm² cable from DIN rail terminal blocks.

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
| Biltema | Manifolds, tees, service valves, fittings | ~101 |
| K-Rauta | 8× puserrusliitin 22mm×½" UK (PEX-to-valve adapters) | ~48 |
| Triopak | Wiring, terminals, DIN rail, Ethernet cables | ~76 |
| Puuilo | 230V distribution (Wago), extra DIN rail terminals | ~40 |
| **Grand total** | | **~1,511** |

### Future expansion cost (wood burner)

| Item | Source | Cost |
|------|--------|------|
| 1× motorized valve DN15 + A83 9-24V DC 2-wire | hpcontrol.fi | 64.53 |
| Remove plug from output manifold port 4, install valve | — | 0 |
| PEX piping to/from wood burner | Biltema | ~20-30 |
| **Wood burner plumbing total** | | **~80** |

The spare Pro 2PM (#6) and the 4th manifold port are already in the base order.
