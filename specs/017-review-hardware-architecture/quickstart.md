# Quickstart: Review Hardware Architecture

**Feature**: 017-review-hardware-architecture  
**Date**: 2026-04-02

## What This Feature Does

1. **Architecture review** — validates consistency between `system.yaml`, control code, and documentation
2. **Safety override fix** — makes freeze/overheat drain unsuppressible by device config
3. **Commissioning guide** — documents how to safely bring the system online progressively
4. **Findings document** — categorized list of issues with severity and remediation

## Files to Change

### Code changes

| File | Change | Reason |
|------|--------|--------|
| `shelly/control-logic.js` | Add `safetyOverride` flag to `makeResult()`, skip suppression for safety drains | FR-011: freeze/overheat must not be suppressed |
| `shelly/control.js` | Handle `safetyOverride` in `controlLoop()`, add actuator state tracking | FR-011 + R4 snapshot bug |
| `tests/control-logic.test.js` | Add safety-with-device-config tests | R8: missing test coverage |

### Documentation deliverables

| File | Content |
|------|---------|
| `design/docs/findings-017.md` | Categorized findings (Critical/Warning/Informational) |
| `design/docs/commissioning-guide.md` | Staged commissioning procedure with sensor verification |

## Key Commands

```bash
# Run unit tests (fast feedback on control logic changes)
npm run test:unit

# Run all tests
npm test

# Lint Shelly scripts (ES5 compliance)
node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js

# Deploy to Shelly device (after testing)
./shelly/deploy.sh
```

## Staged Commissioning (Stage 1)

1. Power on control box with 3 sensors (collector, tank_bottom, outdoor)
2. Deploy scripts with `ce: false` (controls disabled)
3. Verify sensor readings in playground UI — warm/cool each sensor to confirm identity
4. Set `am: ["SC"]` and `ce: true` to enable only solar charging
5. Test freeze protection: set `fm: "AD"` to manually trigger Active Drain
6. Verify automatic freeze trigger by observing outdoor temperature readings
7. Progressively add modes to `am` as loops are plumbed and tested
