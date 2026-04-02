# Research: Review Hardware Architecture

**Feature**: 017-review-hardware-architecture  
**Date**: 2026-04-02

## R1: Safety Override Suppression Behavior

**Decision**: Freeze drain, overheat drain, and sensor staleness are computed correctly by `evaluate()` even when `deviceConfig.ce = false`, but the shell script (`control.js`) **does not execute the transition** when `result.suppressed = true`. The mode decision is correct, but no hardware action occurs.

**Details**:
- `control-logic.js:195-199` — freeze drain returns `makeResult(MODES.ACTIVE_DRAIN, flags, dc)` which correctly early-returns before the `am` filter
- `control-logic.js:145-147` — `makeResult()` sets `suppressed = true` when `dc.ce = false`
- `control.js:348-354` — `controlLoop()` skips `transitionTo()` when `result.suppressed = true`, only applying flags and emitting state
- **Net effect**: The control logic **correctly identifies** a safety drain is needed, but the shell script **refuses to actuate** because controls are disabled

**Fix required**: Safety drains (freeze, overheat) must bypass the `suppressed` flag. Two approaches:
1. **Option A (recommended)**: In `makeResult()`, do NOT set `suppressed = true` for ACTIVE_DRAIN mode — safety overrides bypass device config entirely
2. **Option B**: In `controlLoop()`, call `transitionTo()` even when suppressed, if the mode is ACTIVE_DRAIN
3. For sensor staleness → IDLE: when `suppressed = true`, the system is already in a safe state (pump should be off because controls are disabled). No hardware action needed — just ensure the pump stays off.

**Alternatives considered**: Adding a separate safety evaluation outside `evaluate()` — rejected because it would violate Principle II (Pure Logic / IO Separation).

## R2: Valve/Sensor/Actuator Consistency

**Decision**: All names, states, and assignments are **100% consistent** across `system.yaml`, `control-logic.js`, and `control.js`.

**Details**:
- 8 valve names: perfect match across all 3 files
- 5 mode valve state tables: perfect match (IDLE, SOLAR_CHARGING, GREENHOUSE_HEATING, ACTIVE_DRAIN, EMERGENCY_HEATING)
- Pro 4PM outputs O1-O4: match (pump=id:0, fan=id:1, immersion=id:2, space_heater=id:3)
- Pro 2PM units 1-4: match (unit_1=192.168.1.11, unit_2=.12, unit_3=.13, unit_4=.14)
- 5 core sensors: match (collector=0, tank_top=1, tank_bottom=2, greenhouse=3, outdoor=4)

## R3: IP Address Mismatch (Sensor Hub)

**Decision**: There is a **critical IP mismatch** for the sensor hub that needs resolution.

**Details**:
- `control.js:24` — `SENSOR_IP = "192.168.1.20"`
- `shelly/devices.conf:10` — `SENSOR=192.168.1.86`
- These are inconsistent. The actual DHCP reservation determines which is correct.
- The Pro 2PM IPs (192.168.1.11-14) are not in devices.conf — this is intentional per comments but should be documented.

**Recommendation**: Align control.js SENSOR_IP with devices.conf, or update devices.conf to match. Add all Pro 2PM IPs to devices.conf for documentation completeness.

## R4: State Snapshot Reporting Bug

**Decision**: `buildStateSnapshot()` in `control.js:215-220` hardcodes `fan: false`, `space_heater: false`, `immersion_heater: false`. This is a telemetry reporting bug.

**Details**:
- Only `pump` is tracked via `state.pump_on`
- No state variables exist for fan, space_heater, or immersion_heater
- MQTT state snapshots will always show these as off, even when they're actually on
- This is a **reporting-only** issue — hardware commands are still sent correctly

**Recommendation**: Add `state.fan_on`, `state.space_heater_on`, `state.immersion_heater_on` tracking variables and use them in the snapshot.

## R5: V_air Inverted Relay Logic

**Decision**: `control.js:85` inverts the relay command for V_air: `var cmd = (name === "v_air") ? !open : open`. This is physically correct and safety-conscious.

**Details**:
- system.yaml says V_air is "normally-closed" — this refers to the **logical** default (closed in all modes except drain)
- The physical actuator is wired as **normally-open** (de-energized = open)
- Relay ON = energize = close the valve; Relay OFF = de-energize = valve opens
- **Fail-safe**: Power loss → V_air opens → air enters collector top → gravity assists drain
- The inverted logic in code compensates for this wiring so the rest of the code can use `true = open` semantics

**Recommendation**: Add a comment in system.yaml and control.js explaining this inversion. Currently undocumented.

## R6: Flow Path Physics Validation

**Decision**: All flow paths are physically valid.

**Details**:
- **Solar charging**: Wilo Z20/4 PN10 (10m head capacity) easily lifts water 2.8m to collector top. Return via dip tube provides excellent stratification.
- **Greenhouse heating**: Pump-driven (not passive thermosiphon). Reservoir provides gravity head for pump priming.
- **Active drain**: Gravity assists drain from 280cm collectors. Air enters via V_air at top. Pump pushes to tank.
- **Reservoir overflow**: Collector loop volume ~4-6L << reservoir capacity 20-50L. 5x+ safety margin.

## R7: Safety Rule Enforcement in Code

**Decision**: All 4 safety rules from system.yaml are enforced in code.

**Details**:
1. **Pump stops before valve switch**: `transitionTo()` calls `setPump(false)` first, waits 1000ms, then closes all valves, then opens new set, waits 5000ms, then restarts pump.
2. **Never run pump dry**: `startDrainMonitor()` checks power every 200ms, 3 consecutive readings below 20W triggers stop. 180s absolute timeout.
3. **One input, one output**: `MODE_VALVES` enforces exactly one input and one output per mode by design. V_ret and V_air are never both open.
4. **Drain before freeze**: `freezeDrainTemp: 2` with immediate preemption (ignores min mode duration).

## R8: Missing Test Coverage

**Decision**: Several critical test gaps exist for safety-with-device-config scenarios.

**Tests present**: Config-gated actuator behavior (lines 774-880), forced mode safety preemption (line 874-879)

**Tests missing**:
- Freeze drain with `ce=false` → should verify ACTIVE_DRAIN + suppressed=true
- Overheat drain with `ce=false` → should verify ACTIVE_DRAIN + suppressed=true
- Sensor staleness with `ce=false` → should verify IDLE + suppressed=true
- Freeze drain with `am=["SC"]` (not including "AD") → should verify ACTIVE_DRAIN bypasses filter
- After code fix: tests verifying safety drains are NOT suppressed
