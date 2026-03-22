# Testing Strategy for Shelly Control Software

**Date:** 2026-03-12
**Status:** Approved
**Related:** [Shelly Control Software Design](2026-03-12-shelly-control-software-design.md)

## Overview

Testing strategy for the greenhouse solar heating control system. The control logic runs on a resource-constrained Shelly Pro 4PM (Espruino JS subset), but must be thoroughly tested including realistic thermal simulations. The entire test suite must run in under 10 seconds.

## Architecture: Pure Logic Core

**Note:** The control software spec describes a single monolithic script. This testing strategy refines that into a two-file split for testability. The control software spec should be updated to reflect this change.

The control script is split into two files:

### `scripts/control-logic.js` — Pure Functions

All decision-making logic with zero Shelly dependencies. Written in Shelly-compatible JavaScript (no const/let, no arrow functions, no destructuring, no template literals, no ES6 classes).

**Main function signature:**

```js
function evaluate(state, config) {
  // returns { nextMode, valves, actuators, flags }
}
```

**Input state:**

```js
{
  temps: {
    collector: 72.3,
    tank_top: 58.1,
    tank_bottom: 32.4,
    greenhouse: 11.2,
    outdoor: 8.5
  },
  currentMode: "IDLE",
  modeEnteredAt: 1234,          // timestamp (simulated or real)
  now: 5678,                    // current timestamp
  collectorsDrained: true,
  lastRefillAttempt: 0,         // timestamp, for retry cooldown
  sensorAge: {                  // seconds since last valid reading per sensor
    collector: 0,
    tank_top: 0,
    tank_bottom: 0,
    greenhouse: 0,
    outdoor: 0
  }
}
```

**Output decisions:**

```js
{
  nextMode: "SOLAR_CHARGING",
  valves: {
    vi_btm: true, vi_top: false, vi_coll: false,
    vo_coll: true, vo_rad: false, vo_tank: false,
    v_ret: true, v_air: false
  },
  actuators: {
    pump: true,
    fan: false,
    space_heater: false,
    immersion_heater: false
  },
  flags: {
    collectorsDrained: false,
    lastRefillAttempt: 0
  }
}
```

**Valve values are logical states** (true = open, false = closed), matching system.yaml semantics. All valves including V_air use the same logic (true = open). The `evaluate()` function has no knowledge of relay wiring.

**Optional sensors** (T_radiator_in, T_radiator_out) are excluded from the `evaluate()` interface — they are for monitoring only and not used in control decisions.

**Design rules:**

- **No internal clock.** Receives `now` and `modeEnteredAt`, computes elapsed time. Simulation passes virtual time, Shelly shell passes `Date.now()`.
- **No side effects.** Does not mutate input. The Shelly shell persists flags to KVS, sends valve commands, etc.
- **Configuration as parameter.** Thresholds, hysteresis bands, minimum durations, retry cooldowns passed via `config` object with sensible defaults. Tests can override with tight values. Expected config keys include: `solarEnterDelta` (7°C), `solarExitDelta` (3°C), `greenhouseEnterTemp` (10°C), `greenhouseExitTemp` (12°C), `greenhouseMinTankTop` (25°C), `emergencyEnterTemp` (5°C), `emergencyExitTemp` (8°C), `freezeDrainTemp` (2°C), `overheatDrainTemp` (85°C), `overheatResumeTemp` (75°C), `minModeDuration` (300s), `minRunTimeAfterRefill` (tunable), `refillRetryCooldown` (tunable), `sensorStaleThreshold` (150s, ~5 missed cycles), `drainTimeout` (180s).

### `scripts/control.js` — Thin Shelly Shell

Handles all platform concerns:

- 30-second repeating timer for the control loop
- HTTP RPC to Pro 2PMs (valve commands) and 1 Gen3 (sensor reads)
- Local relay control for pump, fan, heaters
- KVS persistence for `collectorsDrained` flag and other state
- Status endpoint (`/script/1/status`)
- Error handling (retry, fallback to last known sensor values)
- Boot sequence (all off → read sensors → enter loop)

Contains **no conditional logic about modes or temperatures**. All decisions come from `evaluate()`.

## Unit Tests

**File:** `tests/control-logic.test.js`
**Runner:** `node --test` (built-in, zero dependencies)

Tests exercise the pure `evaluate()` function directly. Fast — pure function calls, no I/O.

### Test categories:

**Mode evaluation:**
- Each mode entered when its trigger conditions are met
- Correct mode selected when multiple triggers are true (priority order)
- IDLE returned when no triggers are met

**Hysteresis:**
- Solar charging enters at T_collector > T_tank_bottom + 7°C
- Solar charging does not exit until T_collector < T_tank_bottom + 3°C
- Greenhouse heating enters at T_greenhouse < 10°C AND T_tank_top > 25°C, exits at > 12°C
- Greenhouse heating does not enter when T_tank_top < 25°C (no point running radiator with cold tank)
- Emergency enters at T_greenhouse < 5°C AND T_tank_top < 25°C, exits at > 8°C

**Minimum duration:**
- Mode held for minimum time even if exit conditions are met
- ACTIVE_DRAIN preempts immediately regardless of minimum duration
- Minimum run time respected after speculative refill

**Valve and actuator mapping:**
- Each mode produces exactly the correct valve states and actuator states (pump, fan, heaters)
- One-input-one-output invariant holds across all mode outputs
- V_air logical state correct per mode (same logic as all other valves)

**Priority and preemption:**
- ACTIVE_DRAIN preempts SOLAR_CHARGING when T_outdoor drops
- EMERGENCY preempts GREENHOUSE_HEATING
- Higher priority mode selected when multiple triggers are active
- Concurrent solar charging + greenhouse heating triggers: heating wins (higher priority)

**Speculative refill:**
- Refill attempted when collectors drained + conditions met
- Minimum run time before evaluating success
- Retry cooldown respected after failed attempt
- `lastRefillAttempt` timestamp updated correctly
- "Daytime" guard: `evaluate()` does not check wall-clock time (no internal clock). Instead, the speculative refill triggers on the existing solar delta condition being plausible — if collectors are drained, T_outdoor > 5°C, and T_collector (reading ambient air near panels when dry) suggests daylight. If the refill fails after minimum run time, the retry cooldown prevents churn. No explicit daytime flag needed.

**Sensor failure:**
- Stale sensor readings (high sensorAge) → transition to IDLE
- Graceful handling of missing temperature values

**Mode mapping:**
- Overheat drain is not a separate mode — `evaluate()` returns `ACTIVE_DRAIN` when T_tank_top > 85°C during solar charging. The trigger is different but the output (valve states, actuators) is identical.
- Speculative refill is not a separate mode — `evaluate()` returns `SOLAR_CHARGING` when conditions are met for a refill attempt. The `collectorsDrained` and `lastRefillAttempt` flags drive the refill/retry logic within the solar charging evaluation path.

**Edge cases:**
- Overheat during active charging → active drain (T_tank_top trigger)
- Boot during freezing conditions
- All sensors stale simultaneously

## Simulation Layer

### `tests/simulation/thermal-model.js` — Thermal Model

A simple lumped-parameter thermal model. Each component is a single temperature value updated per tick based on heat flows.

**Components:**

**Collectors:**
- Gain heat from solar irradiance (proportional to area, irradiance, and absorptivity)
- Lose heat to ambient (radiation + convection, proportional to temperature difference)
- When water flows: exchange heat with water (flow rate × specific heat × temperature difference)
- When empty (drained): thermal mass drops dramatically, temperature tracks ambient + irradiance quickly
- Single lumped temperature (represents sensor at outlet)

**Tank (two-zone):**
- Top zone and bottom zone, matching the two real sensors
- Solar charging: hot water enters top (via dip tube), cold drawn from bottom
- Greenhouse heating: hot drawn from top (via dip tube), cool return enters bottom
- Zones mix slowly over time (conduction between zones). Asymmetric: when top is hotter than bottom, stable stratification (minimal mixing). When bottom is hotter than top, rapid convective mixing.
- Heat loss to ambient (insulated, slow)

**Greenhouse:**
- Loses heat to ambient (proportional to temperature difference, representing insulation quality)
- Gains heat from radiator when heating mode active (proportional to radiator inlet temperature − greenhouse temperature)
- Thermal mass represents air volume + structure

**Ambient + irradiance (inputs, not simulated):**
- Ambient temperature: configurable profile (constant, sinusoidal day/night, step function)
- Solar irradiance: configurable profile (clear sky bell curve, cloudy with random drops, step changes)

**Water flow:**
- When pump on and valve path set: water circulates between connected components
- Flow transfers heat based on flow rate, specific heat, and temperature difference between source and destination
- When pump starts into drained collectors: cold tank water fills collectors, collector temperature drops sharply
- Collector water volume tracked: starts at zero when drained, fills over time when pump runs into collectors, drains when active drain runs

**Drain completion detection:**
- In the real system, pump power drop signals drain completion. In the simulation, drain is complete when collector water volume reaches zero. The simulator sets `pump_power` in the trace log based on whether the pump is moving water (normal power) or running dry (low power). This matches the pump power monitoring approach in the control software spec.

**Tick function:**

```js
function tick(model, dt, decisions) → updatedModel
```

Takes current model state, time step in seconds, and current controller decisions (pump, valves). Returns new model state. Pure function — no mutation.

### `tests/simulation/simulator.js` — Virtual-Time Harness

Runs the thermal model and control logic together in virtual time.

**Loop (per scenario):**

1. Initialize model state and trace log
2. For each tick (dt = 1 simulated second):
   a. Advance thermal model by dt
   b. Every 30 simulated seconds: extract temperatures from model, build state object, call `evaluate()`, apply decisions to model
   c. Record snapshot to trace log
3. Return trace log

A full 24-hour simulated day = 86,400 ticks. At ~1µs per tick (pure math), this runs in well under 1 second.

**No real time delays.** Virtual time is just a counter. The control logic sees whatever `now` value the simulator provides.

### `tests/simulation/scenarios.js` — Scenario Definitions

Each scenario defines:

```js
{
  name: "semi-cloudy-day",
  duration: 86400,              // simulated seconds (24h)
  initialState: { ... },        // starting temperatures, mode, flags
  ambient: function(t) { ... }, // temperature profile over time
  irradiance: function(t) { ... }, // solar input profile over time
  assertions: [
    { description: "collectors never exceed 95°C", check: function(trace) { ... } },
    { description: "drain within 60s of freeze threshold", check: function(trace) { ... } }
  ]
}
```

**Predefined scenarios:**

| Scenario | Key behavior tested |
|----------|-------------------|
| **Sunny day** | Solar charging starts in morning, runs all day, stops at sunset. Tank stratification. |
| **Semi-cloudy day** | Irradiance fluctuates. Speculative refill cycles. Minimum run time prevents bouncing. Retry cooldown between attempts. |
| **Freeze at dusk** | Temperature drops during active charging. ACTIVE_DRAIN preempts immediately. Collectors fully drained. |
| **Overheat** | High irradiance + nearly full tank. Overheat drain triggers before T_tank_top reaches dangerous levels. |
| **Cold night heating** | Tank is hot, greenhouse cools overnight. Heating mode activates with hysteresis. Emergency kicks in if tank depletes. |
| **Emergency fallback** | Tank cold, greenhouse dropping. Emergency heating at 5°C, exits at 8°C. |
| **Sensor failure** | One or more sensors go stale mid-operation. System transitions to IDLE safely. |
| **Boot during freeze** | System starts with T_outdoor < 2°C. Verify safe behavior on first evaluation. |
| **Concurrent triggers** | Cold greenhouse + good sun. Greenhouse heating wins over solar charging (priority). |
| **Hysteresis boundary** | Temperatures hover right at entry/exit thresholds. Minimum duration prevents oscillation. |

### Trace Log Format

Array of state snapshots, one per simulated second:

```js
{
  t: 3600,
  temps: { collector: 72.3, tank_top: 58.1, tank_bottom: 32.4, greenhouse: 11.2, outdoor: 8.5 },
  irradiance: 680,
  mode: "SOLAR_CHARGING",
  valves: { vi_btm: true, vo_coll: true, v_ret: true, vi_top: false, vi_coll: false, vo_rad: false, vo_tank: false, v_air: false },
  pump: true,
  pump_power: 51,
  event: null
}
```

The `event` field is non-null only on mode transitions:

```js
event: "MODE_TRANSITION: IDLE → SOLAR_CHARGING"
```

**On test failure:** trace log written to `tests/output/<scenario-name>.trace.json` for debugging. On pass, no file written.

### `tests/simulation/simulation.test.js` — Simulation Test Runner

Uses `node --test` to run each scenario as a test case. Loads scenario definitions, runs simulator, checks assertions against trace log, dumps trace on failure.

## File Structure

```
scripts/
  control-logic.js    -- pure decision logic (Shelly-compatible JS)
  control.js          -- Shelly shell (timers, RPC, relays)
  deploy.sh           -- deployment script
  devices.conf        -- device IP addresses

tests/
  control-logic.test.js           -- unit tests
  simulation/
    thermal-model.js              -- lumped thermal model
    simulator.js                  -- virtual-time harness
    scenarios.js                  -- scenario definitions
    simulation.test.js            -- simulation test runner
  output/                         -- trace logs (failure only, gitignored)
```

## Running Tests

```sh
node --test tests/control-logic.test.js tests/simulation/simulation.test.js
```

Target: entire suite completes in under 10 seconds. Unit tests in milliseconds, each simulation scenario in under 1 second.

## Thermal Model Parameters

The thermal model needs calibration constants. Initial values based on physical estimates, tunable:

| Parameter | Initial estimate | Notes |
|-----------|-----------------|-------|
| Collector area | 4 m² | 2 panels × 2m × 1m |
| Collector absorptivity | 0.8 | Typical flat plate |
| Collector heat loss coefficient | 5 W/m²K | To ambient |
| Collector thermal mass (wet) | ~20 kJ/K | Water + copper + glass |
| Collector thermal mass (dry) | ~5 kJ/K | Copper + glass only |
| Tank volume | 300 L | Jäspi VLM |
| Tank zone split | 50/50 | Top/bottom |
| Tank insulation loss | ~2 W/K | Estimated |
| Tank inter-zone mixing | slow | Conduction only, no convection |
| Greenhouse heat loss | ~50 W/K | Rough estimate for small greenhouse |
| Water flow rate | 5 L/min | Mid-range of 4–10 L/min spec |
| Pipe thermal mass | negligible | PEX, small volume |

These are ballpark values. The model doesn't need to match reality precisely — it needs to produce realistic *dynamics* (temperature drops when cold water enters collectors, tank stratifies, greenhouse cools at night). The exact numbers can be refined if needed.

## Design Decisions

1. **Pure logic core** — enables direct unit testing and simulation without mocking Shelly APIs
2. **Virtual time** — simulation runs in microseconds per tick, not real time
3. **Lumped thermal model** — simple but captures key dynamics (cold water rush, stratification, cloud effects)
4. **Two-zone tank** — matches real sensor placement, captures stratification without CFD complexity
5. **Shelly-compatible JS for deployed code** — no build step for the control logic; tests import it directly
6. **Modern JS for test code only** — test files can use const/let, arrow functions, etc.
7. **Zero dependencies** — `node --test` built-in runner, no npm packages
8. **Trace log on failure** — full diagnostic without cluttering passing runs
9. **Configuration as parameter** — tests use tight timings; production uses real values
10. **Logical valve states** — `evaluate()` returns open/closed, all valves use same logic (true = open)
11. **No separate overheat/refill modes** — overheat drain returns ACTIVE_DRAIN, speculative refill returns SOLAR_CHARGING; flag-based logic, not extra mode states

## Known Testing Gaps

**Mode transition sequence:** The control software spec defines a 6-step transition sequence (stop pump → wait → close all → open new → wait → start pump). This sequence lives in the Shelly shell (`control.js`), not in `evaluate()`. The safety-critical behavior (pump always stopped before valve changes) is therefore not covered by automated tests. This must be verified during commissioning and through code review of the shell.

**Drain sub-loop timing:** The 200ms pump power monitoring loop during active drain runs in the shell. The simulation models drain completion via water volume, but the exact timing of power-drop detection is not simulated. Real-world calibration of the power threshold is required during commissioning.

**Drain safety timeout:** The control software spec defines a 3-minute safety timeout for drain. Whether this lives in `evaluate()` (which could return pump=off after `drainTimeout` seconds in ACTIVE_DRAIN) or in the shell is an implementation decision. If shell-only, it is a testing gap; if in `evaluate()`, it is covered by unit tests. The `drainTimeout` config key is defined either way.

## Changes to Other Specs

This testing strategy introduces changes that should be propagated to other documents:

- **Control software spec:** Update architecture from single monolithic script to two-file split (`control-logic.js` + `control.js`). Add overheat drain entry condition (T_tank_top > 85°C) to mode transition rules.
- **system.yaml:** ~~The flow sensor has been eliminated per the control software spec (replaced by pump power monitoring). References to `flow_sensor` in safety rules and active drain sequence should be updated.~~ Done — flow sensor removed, pump power monitoring is the design, Shelly Plus 1 replaced with 1 Gen3.
