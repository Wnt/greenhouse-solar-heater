# Shelly Control System — Bill of Materials

Order list for the kasvihuone solar heating control system.
Prices from [Nurkan takaa](https://verkkokauppa.nurkantakaa.fi/) (EUR incl. VAT, March 2026) — Finnish Shelly specialist in Tuusula.

## Core System

Everything needed for the base design per `system.yaml`.

| # | Item | Qty | Unit (EUR) | Total (EUR) | Role |
|---|------|-----|-----------|-------------|------|
| 1 | Shelly Pro 4PM | 1 | 107.90 | 107.90 | Brain — pump (O1), fan (O2), immersion heater (O3), space heater (O4). Power monitoring on all channels. Ethernet. |
| 2 | Shelly Pro 2PM | 4 | 89.00 | 356.00 | Valve relays — 2 valves per unit (8 motorized valves total). Ethernet. |
| 3 | Shelly 1 Gen3 | 1 | 19.00 | 19.00 | Sensor hub host for Add-on. WiFi. *(Replaces discontinued Shelly Plus 1)* |
| 4 | Shelly Plus Add-on | 1 | 16.90 | 16.90 | 1-Wire interface for DS18B20 temperature sensors (up to 5 per Add-on) |
| 5 | DS18B20 temp sensor, 3m cable | 5 | 6.50 | 32.50 | T_collector, T_tank_top, T_tank_bottom, T_greenhouse, T_outdoor |
| | | | **Core subtotal** | **532.30** | |

### Pro 2PM valve assignments

| Unit | O1 | O2 | Location |
|------|----|----|----------|
| #1 | VI-btm (tank bottom → pump) | VI-top (reservoir → pump) | Input manifold, ground level |
| #2 | VI-coll (collector → pump) | VO-coll (pump → collector) | Input/output manifold, ground level |
| #3 | VO-rad (pump → radiator) | VO-tank (pump → tank) | Output manifold, ground level |
| #4 | V_ret (collector → reservoir) | V_air (air intake, normally-open) | Collector top, ~280 cm |

## Spares & Expansion

Extras for breakage, optional sensors, and future aux heater hookup.

| # | Item | Qty | Unit (EUR) | Total (EUR) | Rationale |
|---|------|-----|-----------|-------------|-----------|
| 6 | Shelly Pro 2PM | 1 | 89.00 | 89.00 | Spare valve controller. Can also serve as relay for 1–2 aux heaters or additional motorized valves. |
| 7 | Shelly 1 Gen3 | 1 | 19.00 | 19.00 | Spare sensor hub. Or use as 2nd hub if you add the optional radiator sensors (6–7 sensors exceed 1 Add-on's 5-sensor limit). |
| 8 | Shelly Plus Add-on | 1 | 16.90 | 16.90 | Spare / 2nd sensor hub for >5 sensors |
| 9 | DS18B20 temp sensor, 3m cable | 3 | 6.50 | 19.50 | 2× optional radiator sensors (T_radiator_in, T_radiator_out) + 1 spare |
| | | | **Spares subtotal** | **144.40** | |

## Order Total

| | EUR | Source |
|---|-----|--------|
| Core system | 532.30 | Nurkan takaa |
| Spares & expansion | 144.40 | Nurkan takaa |
| Networking & mounting | 33.90 | Nurkan takaa |
| **Order total** | **710.60** | |

## Stock Check (March 2026)

All items in stock at Nurkan takaa:

| Item | Need | In stock |
|------|------|----------|
| Pro 4PM | 1 | 7 |
| Pro 2PM | 5 | 7 |
| 1 Gen3 | 2 | 25 |
| Plus Add-on | 2 | 28 |
| DS18B20 3m | 8 | 23 |
| Zyxel GS-108BV5 | 1 | 9 |
| DIN adapter (PLUS-size) | 2 | 31 |

## Networking

The Pro devices (Pro 4PM + Pro 2PM × 5) need wired Ethernet. The Gen3 sensor hub uses WiFi.

| # | Item | Qty | Unit (EUR) | Total (EUR) | Role |
|---|------|-----|-----------|-------------|------|
| 10 | Zyxel GS-108BV5 (8-port Gigabit, wall-mount) | 1 | 24.90 | 24.90 | Unmanaged switch for all Pro devices. Wall-mountable metal chassis. |
| 11 | DIN-kiskopidike PLUS-kokoisille | 2 | 4.50 | 9.00 | DIN rail adapter for the two Shelly 1 Gen3 units |
| | | | **Networking subtotal** | **33.90** | |

Port allocation: 1 uplink + 1 Pro 4PM + 5× Pro 2PM = 7 of 8 ports (1 spare).

All communication is local HTTP RPC. No cloud connection required. Router / WiFi AP for the Gen3 sensor hub — likely already available.

## Notes

### Shelly Plus 1 discontinued
The original design specified a Shelly Plus 1 as the sensor hub host. This product is now discontinued and out of stock at shelly.com. The **Shelly 1 Gen3** is the direct replacement and is compatible with the Plus Add-on.

### DS18B20 cable length
The 3m cable sensors cover most runs. The shop also has **1m cable sensors at €4.00** — usable for T_tank_top and T_tank_bottom if the sensor hub is mounted near the tank. The collector outlet sensor (280 cm height) definitely needs 3m. Outdoor sensor placement may need a longer run depending on distance to hub.

### Flow sensor removed
The original design included a physical flow sensor. This was removed — pump dry-run detection now uses the Pro 4PM's built-in power monitoring on the pump channel (O1). No additional hardware needed.

### Aux heater expansion
The spare Pro 2PM (#6 above) provides 2 relay outputs with power monitoring. To add an auxiliary heater:
1. Connect the heater (or its contactor) to one of the spare Pro 2PM outputs
2. Connect the Pro 2PM to the Ethernet switch
3. The Pro 4PM brain controls it via HTTP RPC, same as the valve units

### Nurkan takaa vs shelly.com pricing

| Item | shelly.com | Nurkan takaa | Savings |
|------|-----------|--------------|---------|
| Pro 4PM | 116.50 | 107.90 | 8.60 |
| Pro 2PM (×5) | 496.45 | 445.00 | 51.45 |
| 1 Gen3 (×2) | 27.98 | 38.00 | -10.02 |
| Plus Add-on (×2) | 32.14 | 33.80 | -1.66 |
| DS18B20 3m (×8) | 56.16 | 52.00 | 4.16 |
| **Total** | **729.23** | **676.70** | **52.53** |

Nurkan takaa is ~€53 cheaper overall, mainly due to the Pro 2PM price difference. The Gen3 is slightly more expensive but still a good deal considering no shipping hassle from a Finnish retailer.
