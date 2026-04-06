# Data Model: Review Hardware Architecture

**Feature**: 017-review-hardware-architecture  
**Date**: 2026-04-02

This feature is primarily a review and code-fix task. The data model documents the key entities affected by the safety override changes.

## Device Config (Shelly KVS)

Compact JSON stored in Shelly KVS under key `config`. Maximum 256 bytes.

| Field | Type | Description |
|-------|------|-------------|
| `ce` | boolean | Controls enabled — master switch for all actuators |
| `ea` | int | Enabled actuators bitmask: valves=1, pump=2, fan=4, space_heater=8, immersion=16 |
| `fm` | string/null | Forced mode override: "I", "SC", "GH", "AD", "EH", or null |
| `am` | array/null | Allowed modes list: ["I","SC",...] or null (all allowed) |
| `v` | int | Config version (monotonic, prevents stale writes) |

### Safety Override Behavior (Current → Target)

**Current**: When `ce = false`, `makeResult()` sets `suppressed = true` for ALL modes including safety drains. Shell script skips `transitionTo()`.

**Target**: Safety drains (ACTIVE_DRAIN triggered by freeze or overheat) MUST NOT be suppressed. `makeResult()` should not set `suppressed = true` when the mode is ACTIVE_DRAIN and the trigger is a safety condition.

### State Transitions Affected

```
evaluate() safety checks:
  ┌─ sensor staleness? → IDLE (suppressed OK — pump already off)
  ├─ freeze drain?     → ACTIVE_DRAIN (MUST NOT be suppressed)
  ├─ overheat drain?   → ACTIVE_DRAIN (MUST NOT be suppressed)
  └─ normal mode logic → can be suppressed by ce/ea/am
```

## Evaluate Result

Return value of `evaluate(state, config, deviceConfig)`:

| Field | Type | Description |
|-------|------|-------------|
| `nextMode` | string | Target mode (IDLE, SOLAR_CHARGING, etc.) |
| `valves` | object | 8 valve states (boolean) |
| `actuators` | object | 4 actuator states (boolean) |
| `flags` | object | Persistent state: collectorsDrained, lastRefillAttempt, emergencyHeatingActive |
| `suppressed` | boolean | True when device config prevents actuation |

### New field needed

| Field | Type | Description |
|-------|------|-------------|
| `safetyOverride` | boolean | True when mode was triggered by a safety rule (freeze/overheat). Shell script must execute even if `suppressed = true`. |

## State Snapshot (MQTT telemetry)

Published to `greenhouse/state` topic. Currently has a reporting bug:

| Field | Current | Fix needed |
|-------|---------|------------|
| `actuators.pump` | `state.pump_on` | OK |
| `actuators.fan` | hardcoded `false` | Track via `state.fan_on` |
| `actuators.space_heater` | hardcoded `false` | Track via `state.space_heater_on` |
| `actuators.immersion_heater` | hardcoded `false` | Track via `state.immersion_heater_on` |
