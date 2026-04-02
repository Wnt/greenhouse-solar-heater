# Implementation Plan: Review Hardware Architecture

**Branch**: `017-review-hardware-architecture` | **Date**: 2026-04-02 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/017-review-hardware-architecture/spec.md`

## Summary

Architecture review of the greenhouse solar heating hardware design, producing a findings document, safety override code fix, and staged commissioning guide. The review validates consistency between `system.yaml` and control code, identifies a critical safety gap (freeze/overheat drain suppressed by device config), and defines how to progressively enable the system during hardware installation.

## Technical Context

**Language/Version**: JavaScript ES5 (Shelly scripts), Node.js 20 LTS (tests)  
**Primary Dependencies**: Shelly scripting runtime, node:test (testing)  
**Storage**: Shelly KVS (device config), MQTT (telemetry)  
**Testing**: `npm run test:unit` (node:test), Shelly lint (`shelly/lint/`)  
**Target Platform**: Shelly Pro 4PM (control), Shelly Pro 2PM × 4 (valves), Shelly 1 Gen3 + Add-on (sensors)  
**Project Type**: Embedded control system + documentation  
**Performance Goals**: Control loop evaluates every 30s; safety drains preempt immediately  
**Constraints**: ES5-only on Shelly; 16KB max script size; 256-byte KVS value limit  
**Scale/Scope**: 8 valves, 5-7 sensors, 4 actuators, 5 operating modes

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as SoT | **PASS** | Review validates system.yaml as authoritative |
| II. Pure Logic / IO Separation | **PASS** | Safety override fix stays in pure logic (`control-logic.js`); shell script only changes dispatch logic |
| III. Safe by Default (NON-NEGOTIABLE) | **VIOLATION FOUND** | Current code suppresses safety drains when `ce=false`. Fix is the primary deliverable. |
| IV. Proportional Test Coverage | **PASS** | Plan includes tests for all safety override scenarios |
| V. Token-Based Cloud Auth | N/A | No cloud auth involved |
| VI. Durable Data Persistence | N/A | No new persistent data |
| VII. No Secrets in Cloud-Init | N/A | No infrastructure changes |

**Constitution Violation Resolution**: Principle III violation is the **finding** this review exists to identify and fix. The plan includes a concrete code change to `control-logic.js` that makes freeze/overheat drain unsuppressible. This is the highest-priority deliverable.

## Project Structure

### Documentation (this feature)

```text
specs/017-review-hardware-architecture/
├── plan.md                              # This file
├── spec.md                              # Feature specification
├── research.md                          # Phase 0: all findings consolidated
├── data-model.md                        # Phase 1: affected data structures
├── quickstart.md                        # Phase 1: quickstart guide
├── contracts/
│   └── safety-override-contract.md      # Phase 1: safety override behavioral contract
└── checklists/
    └── requirements.md                  # Spec quality checklist
```

### Source Code (repository root)

```text
shelly/
├── control-logic.js    # MODIFY: add safetyOverride flag, skip suppression for safety drains
├── control.js          # MODIFY: handle safetyOverride in controlLoop(), fix actuator state tracking
└── devices.conf        # MODIFY: add Pro 2PM IPs, align sensor IP

tests/
└── control-logic.test.js  # MODIFY: add safety-with-device-config test cases

design/docs/
├── findings-017.md           # NEW: categorized review findings
└── commissioning-guide.md    # NEW: staged commissioning procedure
```

**Structure Decision**: No new directories needed. Changes touch existing Shelly scripts, tests, and design docs.

## Review Findings Summary

### Critical

| ID | Finding | File | Lines | Remediation |
|----|---------|------|-------|-------------|
| C-001 | Freeze/overheat drain suppressed when `ce=false` | `shelly/control-logic.js` | 145-147, 195-205 | Add `safetyOverride` flag; skip suppression for ACTIVE_DRAIN triggered by safety conditions |
| C-002 | Sensor IP mismatch between control.js and devices.conf | `shelly/control.js` / `shelly/devices.conf` | control.js:24, devices.conf:10 | Align IP addresses (determine correct DHCP reservation) |

### Warning

| ID | Finding | File | Lines | Remediation |
|----|---------|------|-------|-------------|
| W-001 | Actuator state snapshot hardcodes fan/heaters to false | `shelly/control.js` | 215-220 | Add state tracking variables for fan, space_heater, immersion_heater |
| W-002 | V_air inverted relay logic undocumented | `shelly/control.js` | 85 | Add explanatory comment in code and system.yaml |
| W-003 | Pro 2PM IPs not listed in devices.conf | `shelly/devices.conf` | — | Add all Pro 2PM IPs for documentation completeness |
| W-004 | Missing tests: safety drains with device config disabled | `tests/control-logic.test.js` | — | Add 7 test cases per safety override contract |

### Informational

| ID | Finding | Details |
|----|---------|---------|
| I-001 | All valve names/states 100% consistent | system.yaml ↔ control-logic.js ↔ control.js |
| I-002 | All actuator relay assignments correct | Pro 4PM O1-O4 match code |
| I-003 | All Pro 2PM unit→valve mappings correct | 4 units, 8 valves, no conflicts |
| I-004 | All 5 core sensor mappings consistent | Names and IDs match |
| I-005 | All flow paths physically valid | Pump capacity adequate, stratification correct |
| I-006 | All 4 safety rules enforced in code | pump-before-valve, no-dry-run, one-input-one-output, freeze-at-2°C |
| I-007 | Deploy script correctly concatenates and uploads | Slot 1 = control-logic.js + control.js, Slot 3 = telemetry.js |
| I-008 | V_air fail-safe design is sound | Power loss → valve opens → enables gravity drain |
| I-009 | Reservoir overflow risk low | Collector volume ~6L << reservoir capacity 20-50L |
| I-010 | Air vent removal rationale physically sound | Sub-atmospheric at collector top (80cm water column) |
| I-011 | `am` (allowed_modes) mechanism supports progressive enablement | Can restrict to ["SC"] for stage 1 |

## Staged Commissioning Plan

### Prerequisites
- Safety override code fix deployed (C-001)
- Sensor IP aligned (C-002)
- Actuator state tracking fixed (W-001)

### Stage 1: Solar Collector Loop

**Hardware**: Control box (Pro 4PM) + 3 sensors (collector, tank_bottom, outdoor) + Pro 2PM units for solar loop valves (unit_1: VI-btm; unit_2: VO-coll; unit_4: V_ret) + pump

**Config**: `{ ce: true, ea: 3, fm: null, am: ["SC"], v: 1 }`
- `ea: 3` = valves (1) + pump (2) enabled, fan/heaters disabled
- `am: ["SC"]` = only solar charging allowed; safety drains (freeze/overheat) always active

**Sensor Verification Procedure**:
1. Deploy with `ce: false` (controls disabled, safety drains still active after fix)
2. Open playground UI → Status view, observe sensor readings
3. For each sensor: apply heat (hand warmth, heat gun) or cold (ice pack) and confirm the correct reading changes
4. Document mapping: physical wire label → logical sensor name → confirmed correct
5. Once all 3 sensors verified, set `ce: true` and `am: ["SC"]`

**Validation Tests**:
- Solar charging activates when collector > tank_bottom + 7°C
- Freeze drain fires automatically when outdoor < 2°C
- Manual drain test: set `fm: "AD"`, observe full drain sequence
- Pump dry-run detection stops drain correctly

### Progressive Enablement

As additional hardware is installed:
1. Add greenhouse heating: connect tank_top + greenhouse sensors, plumb radiator loop, add `"GH"` to `am`, set `ea: 7` (add fan bit)
2. Add emergency heating: connect space heater, add `"EH"` to `am`, set `ea: 31` (all actuators)
3. Full system: set `am: null` (all modes allowed)

Each step: verify new sensors, test new mode via forced mode (`fm`), then add to allowed modes.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | — | — |

No constitution complexity violations. The safety override fix is the **minimum change** required to comply with Principle III.
