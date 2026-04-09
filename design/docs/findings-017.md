# Architecture Review Findings — 017

**Feature**: 017-review-hardware-architecture  
**Date**: 2026-04-02  
**Scope**: `system.yaml` ↔ `shelly/control-logic.js` ↔ `shelly/control.js` ↔ `shelly/devices.conf` ↔ `design/docs/design.md`

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 2 | C-001 Fixed, C-002 Fixed |
| Warning | 4 | W-001 Fixed, W-002 Fixed, W-003 Fixed, W-004 Fixed |
| Informational | 11 | Verified |

---

## Critical Findings

### C-001: Safety Drain Suppressed by Device Config — FIXED

**Severity**: Critical  
**Files**: `shelly/control-logic.js:126-158`, `shelly/control.js:348-354`  
**Status**: Fixed in this branch

**Before**: When `deviceConfig.ce = false` (controls disabled), `makeResult()` set `result.suppressed = true` for ALL modes, including safety-critical freeze and overheat drain. The shell script's `controlLoop()` skipped `transitionTo()` when suppressed, meaning freeze drain would not actuate even at sub-zero temperatures.

**After**: `makeResult()` now accepts a `safetyOverride` parameter. Freeze drain (`control-logic.js:198`) and overheat drain (`control-logic.js:204`) pass `safetyOverride=true`, which bypasses all device config suppression. The shell script checks `result.safetyOverride` first and always calls `transitionTo()` for safety overrides.

**Test coverage**: 7 new tests in `tests/control-logic.test.js` verify safety overrides with `ce=false`, `am` filter, and `ce=true`. Updated integration test in `tests/device-config-integration.test.js`.

### C-002: Sensor Hub IP Mismatch — FIXED

**Severity**: Critical  
**Files**: `shelly/control.js:24`, `shelly/devices.conf:10`  
**Status**: Fixed in this branch

**Before**: `control.js` used `SENSOR_IP = "192.168.1.20"` while `devices.conf` specified `SENSOR=192.168.1.86`. The control script would fail to read temperatures from the sensor hub.

**After**: Aligned `control.js` to use `192.168.1.86` matching the DHCP reservation in `devices.conf`.

---

## Warning Findings

### W-001: Actuator State Snapshot Hardcoded to False — FIXED

**Severity**: Warning  
**File**: `shelly/control.js:215-220`  
**Status**: Fixed in this branch

**Before**: `buildStateSnapshot()` hardcoded `fan: false`, `space_heater: false`, `immersion_heater: false`. MQTT telemetry always showed these actuators as off, even when they were commanded on.

**After**: Added `state.fan_on`, `state.space_heater_on`, `state.immersion_heater_on` tracking variables. Updated `setFan()`, `setSpaceHeater()`, `setImmersion()` to track state. `buildStateSnapshot()` now uses tracked values.

### W-002: V_air Inverted Relay Logic Undocumented — FIXED

**Severity**: Warning  
**File**: `shelly/control.js:85`  
**Status**: Fixed in this branch (comment added)

`setValve()` inverts the relay command for V_air: `var cmd = (name === "v_air") ? !open : open`. The physical actuator is wired as **normally-open** (de-energized = open). This is a deliberate fail-safe: power loss opens V_air, enabling gravity-assisted drain. The code inversion allows the rest of the logic to use consistent `true = open` semantics. Comment and system.yaml note added.

### W-003: Pro 2PM IPs Not in devices.conf — FIXED

**Severity**: Warning  
**File**: `shelly/devices.conf`  
**Status**: Fixed in this branch

**Before**: Only `PRO2PM_1=192.168.1.136` was listed (as reference). The actual Pro 2PM IPs used in `control.js` (192.168.1.11-.14) were undocumented.

**After**: All 4 Pro 2PM unit IPs documented with valve assignments.

### W-004: Missing Safety Override Tests — FIXED

**Severity**: Warning  
**File**: `tests/control-logic.test.js`  
**Status**: Fixed in this branch

No tests existed for safety drain behavior when device config suppresses controls. Added 7 test cases covering freeze drain, overheat drain, and sensor staleness with various device config states.

---

## Informational Findings

### I-001: Valve Names 100% Consistent ✓

All 7 valve names (`vi_btm`, `vi_top`, `vi_coll`, `vo_coll`, `vo_rad`, `vo_tank`, `v_air`) are identical across `system.yaml` modes section, `MODE_VALVES` in `control-logic.js:14-40`, and `VALVES` map in `control.js:13-22`. *(Updated for spec 024: the collector-top return valve was replaced by a passive T joint, reducing the motorized count from 8 to 7.)*

### I-002: Actuator Relay Assignments Correct ✓

Pro 4PM outputs match exactly:
- O1 (id:0) = pump — `system.yaml:305`, `control.js:59`
- O2 (id:1) = radiator fan — `system.yaml:306`, `control.js:66`
- O3 (id:2) = immersion heater — `system.yaml:307`, `control.js:72`
- O4 (id:3) = space heater — `system.yaml:308`, `control.js:78`

### I-003: Pro 2PM Unit→Valve Mappings Correct ✓

All 4 Pro 2PM units match `system.yaml:318-333` ↔ `control.js:13-22`:
- Unit 1 (192.168.1.11): vi_btm (id:0), vi_top (id:1)
- Unit 2 (192.168.1.12): vi_coll (id:0), vo_coll (id:1)
- Unit 3 (192.168.1.13): vo_rad (id:0), vo_tank (id:1)
- Unit 4 (192.168.1.14): (id:0 reserved spare, spec 024), v_air (id:1)

### I-004: Sensor Mappings Consistent ✓

All 5 core sensors match `system.yaml:250-282` ↔ `control.js:25-27` ↔ `control-logic.js:94`:
- collector=0, tank_top=1, tank_bottom=2, greenhouse=3, outdoor=4

Optional sensors (t_radiator_in, t_radiator_out) are defined in system.yaml but not yet in SENSOR_IDS — consistent with their `optional: true` status.

### I-005: All Flow Paths Physically Valid ✓

- **Solar charging**: Wilo Z20/4 (PN10 = 10m head) easily lifts water 2.8m to collector top. Return via dip tube provides excellent thermal stratification.
- **Greenhouse heating**: Pump-driven (not passive thermosiphon). Reservoir at 200cm provides gravity head for pump priming.
- **Active drain**: Gravity assists drain from 280cm collectors. Air enters via V_air at top. Pump pushes drained water to tank.

### I-006: All Safety Rules Enforced in Code ✓

1. **Pump before valve** — `transitionTo()` calls `setPump(false)` first, waits 1000ms (`VALVE_SETTLE_MS`), then switches valves, waits 5000ms (`PUMP_PRIME_MS`), then restarts pump.
2. **No dry run** — `startDrainMonitor()` checks power every 200ms, 3 consecutive readings below 20W triggers stop. 180s absolute timeout.
3. **One input, one output** — `MODE_VALVES` enforces per-mode constraint by design. V_air is the only motorized valve at the collector top (the return path is a passive T joint, spec 024).
4. **Drain at 2°C** — `freezeDrainTemp: 2` with immediate preemption (ignores min mode duration).

### I-007: Deploy Script Correct ✓

`shelly/deploy.sh` correctly concatenates `control-logic.js` + `control.js` and uploads to script slot 1 on the Pro 4PM. Telemetry script uploads to slot 3 separately.

### I-008: V_air Fail-Safe Design Sound ✓

V_air physical actuator is normally-open (de-energized = open). Power loss → V_air opens → air enters collector top → gravity assists drain. This is the correct fail-safe orientation for freeze protection.

### I-009: Reservoir Overflow Risk Low ✓

Collector loop water volume ~4-6L. Reservoir capacity 20-50L (TBD, 30L target). Safety margin ≥5×. Pump dry-run detection stops drain when collectors empty.

### I-010: Air Vent Removal Rationale Sound ✓

Sub-atmospheric pressure at collector top (80cm water column from 280cm collector to 200cm reservoir) would draw air IN through an auto-vent. Trapped air is instead carried by flow through the passive T joint (spec 024) down to the open reservoir, where it separates and vents. The reservoir-side pipe terminates below the water line so no air can re-enter. Confirmed by testing with manual valve.

### I-011: Allowed Modes Mechanism Supports Progressive Enablement ✓

`am` (allowed_modes) filter in `evaluate()` correctly restricts which modes can activate. Setting `am: ["SC"]` limits the system to solar charging only, while safety drains (freeze/overheat) bypass the filter entirely (they return before the `am` check). This enables staged commissioning.

---

## Communication & Reliability Assessment

### HTTP RPC Retry Logic

`control.js:setValve()` includes single-retry logic: if the initial HTTP.GET to a Pro 2PM fails (error or non-200 status), it retries once. On second failure, it sets `state.last_error = "valve_" + name` and calls back with `false`.

### Safe Fallback on Valve Failure

When `setValves()` receives a failure callback, it immediately:
1. Stops the pump (`setPump(false)`)
2. Sets mode to IDLE
3. Clears the transitioning flag

This prevents the system from operating with an indeterminate valve state.

### Sensor Hub WiFi vs Ethernet Reliability

The sensor hub (Shelly 1 Gen3 + Add-on) connects via WiFi, while all Pro devices (Pro 4PM + 4× Pro 2PM) connect via wired Ethernet. WiFi is inherently less reliable. If the sensor hub loses connectivity:
- Sensor readings stop updating
- `sensorAge` values increase past `sensorStaleThreshold` (150s)
- Control logic returns IDLE (sensor staleness check is the first evaluation in `evaluate()`)
- This is a safe state — pump off, all valves closed

### Single Points of Failure

| Component | Failure Impact | Severity | Mitigation |
|-----------|---------------|----------|------------|
| Pump (Wilo Z20/4) | No water circulation — solar, heating, drain all disabled | High | Spare pump recommended; emergency heating (space heater) is pump-independent |
| Pro 4PM (controller) | No control logic — system inert | High | V_air fail-safe allows gravity drain; space heater on standalone thermostat as backup |
| Ethernet switch | No valve control, no sensor data | High | All modes stop; V_air opens on power loss |
| Power supply (24V DC) | All valve actuators lose power | High | V_air opens (normally-open); other valves close (normally-closed). Collectors drain via gravity through open V_air. |
| Sensor hub (WiFi) | No temperature data → IDLE mode | Medium | Staleness detection triggers safe IDLE within 150s |
| Individual Pro 2PM | Specific valve pair uncontrollable | Medium | setValve retry + pump stop fallback |
