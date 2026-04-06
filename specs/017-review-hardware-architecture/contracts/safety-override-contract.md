# Contract: Safety Override Behavior

**Feature**: 017-review-hardware-architecture  
**Date**: 2026-04-02

## Overview

Defines the contract for how safety-critical mode transitions interact with device configuration suppression. This is the core behavioral change identified by the architecture review.

## Contract: `evaluate()` Safety Override

### Inputs

Same as current `evaluate(state, config, deviceConfig)` — no signature change.

### Behavioral Rules

1. **Freeze drain** (`t_outdoor < freezeDrainTemp && !collectorsDrained`):
   - MUST return `nextMode: "ACTIVE_DRAIN"` regardless of device config
   - MUST set `safetyOverride: true` on the result
   - MUST NOT set `suppressed: true` (even when `ce = false`)
   - Valve and actuator states MUST reflect full ACTIVE_DRAIN configuration

2. **Overheat drain** (`t_tank_top > overheatDrainTemp && !collectorsDrained`):
   - Same rules as freeze drain

3. **Sensor staleness** (any sensor stale):
   - MUST return `nextMode: "IDLE"` regardless of device config
   - MAY set `suppressed: true` (IDLE is a safe state — no actuation needed)
   - Emergency heating MUST be disabled

4. **All other modes** (solar charging, greenhouse heating, emergency heating):
   - Existing suppression behavior via `ce`, `ea`, `am` remains unchanged

### Shell Script (`controlLoop()`) Behavior

```
if (result.nextMode !== state.mode) {
  if (result.safetyOverride) {
    transitionTo(result);           // ALWAYS execute safety transitions
  } else if (result.suppressed) {
    applyFlags(result.flags);       // Suppress non-safety transitions
    emitStateUpdate();
  } else {
    transitionTo(result);           // Normal transition
  }
}
```

### Test Cases Required

| Test | Input | Expected |
|------|-------|----------|
| Freeze drain, ce=false | outdoor=1°C, ce=false | nextMode=ACTIVE_DRAIN, suppressed=false, safetyOverride=true |
| Freeze drain, am=["SC"] | outdoor=1°C, am=["SC"] | nextMode=ACTIVE_DRAIN (bypasses am filter) |
| Overheat drain, ce=false | tank_top=90°C, ce=false | nextMode=ACTIVE_DRAIN, suppressed=false, safetyOverride=true |
| Overheat drain, am=["I"] | tank_top=90°C, am=["I"] | nextMode=ACTIVE_DRAIN (bypasses am filter) |
| Staleness, ce=false | stale sensors, ce=false | nextMode=IDLE, suppressed=true |
| Solar, ce=false | solar conditions, ce=false | nextMode=SOLAR_CHARGING, suppressed=true |
| Normal freeze drain | outdoor=1°C, ce=true | nextMode=ACTIVE_DRAIN, suppressed=false, safetyOverride=true |
