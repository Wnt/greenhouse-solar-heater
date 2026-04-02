# Staged Commissioning Guide

**Feature**: 017-review-hardware-architecture  
**Date**: 2026-04-02

This guide describes how to bring the greenhouse solar heating control system online incrementally as hardware installation progresses. The system supports progressive mode enablement — you enable individual loops as hardware is installed, with hard safety rules always active.

## Prerequisites

- Safety override code fix deployed (C-001 from findings-017.md)
- Sensor IP aligned in `shelly/control.js` and `shelly/devices.conf` (C-002)
- Shelly Pro 4PM flashed with latest `control-logic.js` + `control.js` via `shelly/deploy.sh`

## Sensor Identity Verification

**When**: Before enabling any automatic mode for the first time, and after any rewiring.

**Why**: DS18B20 sensors on the 1-Wire bus are identified by index (0-4), not by physical label. A miswired sensor (e.g., outdoor sensor reporting collector temperature) could prevent freeze drain or trigger it falsely.

**Procedure**:

1. Deploy scripts with controls disabled: `{ ce: false, ea: 0, fm: null, am: null, v: 1 }`
   - Freeze and overheat drain are still active (safety overrides bypass `ce`)
2. Open the playground UI → Status view
3. Observe the 3 sensor readings (collector, tank_bottom, outdoor)
4. For each sensor, one at a time:
   - Apply heat (hand warmth or heat gun) to the physical sensor probe
   - Observe which reading increases in the playground UI
   - If the wrong reading changes, the sensors are swapped — adjust wiring or update `SENSOR_IDS` in `control.js`
5. Record the verified mapping:

   | Wire Label | Physical Location | Logical Name | Sensor ID | Verified |
   |------------|-------------------|--------------|-----------|----------|
   | (label) | Collector outlet | collector | 0 | ☐ |
   | (label) | Tank lower region | tank_bottom | 2 | ☐ |
   | (label) | Outside, shaded | outdoor | 4 | ☐ |

6. Once all sensors are verified, proceed to Stage 1 configuration.

**Tip**: Use ice (wrapped in cloth) on the outdoor sensor to test that it correctly triggers freeze drain below 2°C. Observe the mode change in the playground Status view.

## Stage 1: Solar Collector Loop

**Hardware required**:
- Shelly Pro 4PM (control box) — runs control logic
- Shelly 1 Gen3 + Add-on — 3 sensors connected (collector, tank_bottom, outdoor)
- Shelly Pro 2PM unit 1 (192.168.1.11) — valves VI-btm, VI-top
- Shelly Pro 2PM unit 2 (192.168.1.12) — valves VI-coll, VO-coll
- Shelly Pro 2PM unit 4 (192.168.1.14) — valves V_ret, V_air
- Pump (Wilo Star Z20/4)
- 24V DC PSU for valve actuators
- Ethernet switch connecting all Pro devices

**Device config**:

```json
{ "ce": true, "ea": 3, "fm": null, "am": ["SC"], "v": 1 }
```

- `ce: true` — controls enabled
- `ea: 3` — valves (1) + pump (2) enabled; fan (4), space heater (8), immersion (16) disabled
- `am: ["SC"]` — only solar charging allowed (plus safety drains, which always bypass `am`)

**Expected behavior**:

| Condition | Mode | Action |
|-----------|------|--------|
| collector > tank_bottom + 7°C | SOLAR_CHARGING | Pump runs, water circulates through collectors |
| collector < tank_bottom + 3°C | IDLE | Pump stops, valves close |
| outdoor < 2°C | ACTIVE_DRAIN (safety) | Collectors drained automatically |
| tank_top > 85°C | ACTIVE_DRAIN (safety) | Overheat protection (if tank connected) |
| Any sensor stale > 150s | IDLE | Safe state, pump stops |

**Manual freeze protection test**:

1. Set forced mode: update device config to `{ "ce": true, "ea": 3, "fm": "AD", "am": ["SC"], "v": 2 }`
2. Observe the system execute the full Active Drain sequence:
   - Pump stops
   - All valves close
   - V_air opens (air intake at collector top)
   - VI-coll opens (pump inlet from collector bottom)
   - VO-tank opens (pump outlet to tank)
   - Pump starts
   - Power monitoring detects dry-run → pump stops → all valves close
3. Clear forced mode: set `fm: null` and increment version

**Validation checklist**:

- [ ] All 3 sensors reading plausible temperatures
- [ ] Solar charging activates when collector is hot enough
- [ ] Solar charging stops when delta drops below 3°C
- [ ] Freeze drain fires when outdoor temp drops below 2°C
- [ ] Manual drain test (fm: "AD") completes full sequence
- [ ] Pump dry-run detection stops drain correctly

## Progressive Enablement

As additional hardware is installed, progressively enable modes by updating the device config.

### Add Greenhouse Heating

**Additional hardware**: Tank top sensor, greenhouse sensor, Pro 2PM unit 3 (192.168.1.13), radiator + fan.

**Sensor verification**: Repeat the identity verification procedure for the 2 new sensors (tank_top, greenhouse).

**Config update**:

```json
{ "ce": true, "ea": 7, "fm": null, "am": ["SC", "GH"], "v": 3 }
```

- `ea: 7` — valves (1) + pump (2) + fan (4)
- `am: ["SC", "GH"]` — solar charging and greenhouse heating allowed

**Test**: Set `fm: "GH"` to force greenhouse heating mode and verify the radiator loop operates correctly (pump + fan ON, hot water circulates through radiator).

### Add Emergency Heating

**Additional hardware**: Space heater (2kW) connected to Pro 4PM O4.

**Config update**:

```json
{ "ce": true, "ea": 15, "fm": null, "am": ["SC", "GH", "EH"], "v": 4 }
```

- `ea: 15` — valves (1) + pump (2) + fan (4) + space heater (8)
- `am: ["SC", "GH", "EH"]` — solar, heating, and emergency allowed

**Test**: Set `fm: "EH"` to verify space heater activates.

### Full System

**Config update**:

```json
{ "ce": true, "ea": 31, "fm": null, "am": null, "v": 5 }
```

- `ea: 31` — all actuators enabled (valves + pump + fan + space heater + immersion)
- `am: null` — all modes allowed (no filter)

At this point the system operates fully autonomously. Safety drains (freeze and overheat) have been active since Stage 1.
