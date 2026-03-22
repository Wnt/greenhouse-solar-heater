# Testing Strategy Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement complete unit tests for evaluate() and thermal simulation layer per the testing strategy spec.

**Architecture:** Three layers — unit tests exercise evaluate() directly, a lumped-parameter thermal model simulates physics, and a virtual-time simulator connects them. All zero-dependency, runs under 10 seconds with `node --test`.

**Tech Stack:** Node.js built-in test runner (`node:test`), no npm packages. Test code uses modern JS; production code (`control-logic.js`) uses Shelly-compatible ES5.

**Spec:** `docs/superpowers/specs/2026-03-12-testing-strategy-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `tests/control-logic.test.js` | Modify | Complete all unit test TODOs |
| `tests/simulation/thermal-model.js` | Modify | Full lumped-parameter thermal model |
| `tests/simulation/thermal-model.test.js` | Create | TDD tests for thermal model |
| `tests/simulation/simulator.js` | Modify | Virtual-time harness |
| `tests/simulation/scenarios.js` | Modify | All 10 scenario definitions |
| `tests/simulation/simulation.test.js` | Modify | Test runner with trace dump |

---

## Chunk 1: Unit Tests

### Task 1: Complete unit tests for evaluate()

**Files:**
- Modify: `tests/control-logic.test.js`

All tests call `evaluate(state, config)` and check the returned `{ nextMode, valves, actuators, flags }`. The existing `makeState()` helper provides a safe baseline (all temps normal, IDLE, no staleness). Tests override specific fields.

Add `MODE_VALVES` to the existing import and increase `now` in the base state to clear refill cooldowns:

```js
const { evaluate, MODES, DEFAULT_CONFIG, MODE_VALVES } = require('../scripts/control-logic.js');
```

Update `makeState` base to use `now: 2000` (ensures refill cooldown 1800s is cleared by default):

```js
function makeState(overrides) {
  const base = {
    temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    currentMode: MODES.IDLE,
    modeEnteredAt: 0,
    now: 2000,
    collectorsDrained: false,
    lastRefillAttempt: 0,
    sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
  };
  return Object.assign({}, base, overrides);
}
```

- [ ] **Step 1: Write mode evaluation tests**

```js
describe('mode evaluation', () => {
  it('returns IDLE when no triggers are active', () => {
    const result = evaluate(makeState({}), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('enters SOLAR_CHARGING when collector > tank_bottom + 7', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('enters GREENHOUSE_HEATING when greenhouse < 10 and tank_top > 25', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('enters ACTIVE_DRAIN when outdoor < 2 and collectors not drained', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('enters EMERGENCY_HEATING when greenhouse < 5 and tank_top < 25', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 4, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('selects highest priority mode when multiple triggers active', () => {
    // Both freeze drain and emergency could trigger — drain wins
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 4, outdoor: 1 },
      collectorsDrained: false
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});
```

- [ ] **Step 2: Write hysteresis tests**

```js
describe('hysteresis', () => {
  it('enters solar charging at collector > tank_bottom + 7', () => {
    const result = evaluate(makeState({
      temps: { collector: 38, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('does not enter solar at collector = tank_bottom + 7 (needs strictly greater)', () => {
    const result = evaluate(makeState({
      temps: { collector: 37, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('stays in solar at exact exit threshold (collector = tank_bottom + 3)', () => {
    const result = evaluate(makeState({
      temps: { collector: 33, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('exits solar when collector < tank_bottom + 3', () => {
    const result = evaluate(makeState({
      temps: { collector: 32, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('enters greenhouse heating at greenhouse < 10 with hot tank', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('does not enter greenhouse heating when tank_top < 25', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 9, outdoor: 10 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('stays in greenhouse heating at exact exit threshold (greenhouse = 12)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 12, outdoor: 10 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('exits greenhouse heating when greenhouse > 12', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 13, outdoor: 10 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('does not enter greenhouse heating at exact threshold (greenhouse = 10)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 10, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('enters emergency at greenhouse < 5 and tank_top < 25', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 4, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('stays in emergency at exact exit threshold (greenhouse = 8)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 8, outdoor: -5 },
      currentMode: MODES.EMERGENCY_HEATING,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('exits emergency when greenhouse > 8', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 9, outdoor: -5 },
      currentMode: MODES.EMERGENCY_HEATING,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('does not enter emergency at exact threshold (greenhouse = 5)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 5, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });
});
```

- [ ] **Step 3: Write minimum duration tests**

```js
describe('minimum duration', () => {
  it('holds mode for minimum time even if exit conditions met', () => {
    const result = evaluate(makeState({
      temps: { collector: 32, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 900, now: 1000  // only 100s elapsed, min is 300
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('allows exit after minimum duration', () => {
    const result = evaluate(makeState({
      temps: { collector: 32, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000  // 1000s elapsed > 300 min
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('ACTIVE_DRAIN preempts immediately regardless of minimum duration', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 990, now: 1000  // only 10s elapsed
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('uses longer minimum after speculative refill', () => {
    const result = evaluate(makeState({
      temps: { collector: 32, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 500, now: 800,  // 300s elapsed > minModeDuration(300)
      lastRefillAttempt: 500,  // but < minRunTimeAfterRefill(600)
      collectorsDrained: false
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });
});
```

- [ ] **Step 4: Write valve and actuator mapping tests**

```js
describe('valve and actuator mapping', () => {
  it('IDLE: all valves closed, all actuators off', () => {
    const r = evaluate(makeState({}), null);
    assert.deepStrictEqual(r.valves, {
      vi_btm: false, vi_top: false, vi_coll: false,
      vo_coll: false, vo_rad: false, vo_tank: false,
      v_ret: false, v_air: false
    });
    assert.deepStrictEqual(r.actuators, {
      pump: false, fan: false, space_heater: false, immersion_heater: false
    });
  });

  it('SOLAR_CHARGING: vi_btm + vo_coll + v_ret open, pump on', () => {
    const r = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(r.valves.vi_btm, true);
    assert.strictEqual(r.valves.vo_coll, true);
    assert.strictEqual(r.valves.v_ret, true);
    assert.strictEqual(r.valves.vi_top, false);
    assert.strictEqual(r.valves.vo_rad, false);
    assert.strictEqual(r.actuators.pump, true);
    assert.strictEqual(r.actuators.fan, false);
  });

  it('GREENHOUSE_HEATING: vi_top + vo_rad open, pump + fan on', () => {
    const r = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    }), null);
    assert.strictEqual(r.valves.vi_top, true);
    assert.strictEqual(r.valves.vo_rad, true);
    assert.strictEqual(r.valves.vi_btm, false);
    assert.strictEqual(r.valves.vo_coll, false);
    assert.strictEqual(r.actuators.pump, true);
    assert.strictEqual(r.actuators.fan, true);
  });

  it('ACTIVE_DRAIN: vi_coll + vo_tank + v_air open, pump on', () => {
    const r = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 }
    }), null);
    assert.strictEqual(r.valves.vi_coll, true);
    assert.strictEqual(r.valves.vo_tank, true);
    assert.strictEqual(r.valves.v_air, true);
    assert.strictEqual(r.valves.vi_btm, false);
    assert.strictEqual(r.actuators.pump, true);
  });

  it('EMERGENCY_HEATING: all valves closed, space_heater + immersion on', () => {
    const r = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 4, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.deepStrictEqual(r.valves, {
      vi_btm: false, vi_top: false, vi_coll: false,
      vo_coll: false, vo_rad: false, vo_tank: false,
      v_ret: false, v_air: false
    });
    assert.strictEqual(r.actuators.space_heater, true);
    assert.strictEqual(r.actuators.immersion_heater, true);
    assert.strictEqual(r.actuators.pump, false);
  });

  it('one-input-one-output invariant: at most 1 input and 1 output valve open', () => {
    const inputs = ['vi_btm', 'vi_top', 'vi_coll'];
    const outputs = ['vo_coll', 'vo_rad', 'vo_tank'];
    const allModes = [MODES.IDLE, MODES.SOLAR_CHARGING, MODES.GREENHOUSE_HEATING,
                      MODES.ACTIVE_DRAIN, MODES.EMERGENCY_HEATING];
    for (const mode of allModes) {
      const v = MODE_VALVES[mode];  // MODE_VALVES imported at top of file
      const openInputs = inputs.filter(k => v[k]).length;
      const openOutputs = outputs.filter(k => v[k]).length;
      assert.ok(openInputs <= 1, mode + ' has ' + openInputs + ' input valves open');
      assert.ok(openOutputs <= 1, mode + ' has ' + openOutputs + ' output valves open');
    }
  });
});
```

- [ ] **Step 5: Write priority and preemption tests**

```js
describe('priority and preemption', () => {
  it('ACTIVE_DRAIN preempts SOLAR_CHARGING when outdoor drops', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('EMERGENCY preempts GREENHOUSE_HEATING when tank depletes', () => {
    // Currently heating, but tank cooled and greenhouse dropped below 5
    const result = evaluate(makeState({
      temps: { collector: 10, tank_top: 20, tank_bottom: 15, greenhouse: 4, outdoor: -5 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 1000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('concurrent solar + greenhouse triggers: greenhouse wins', () => {
    // Both triggers active: collector hot enough for solar, greenhouse cold
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('overheat triggers ACTIVE_DRAIN when tank_top > 85', () => {
    const result = evaluate(makeState({
      temps: { collector: 90, tank_top: 86, tank_bottom: 70, greenhouse: 25, outdoor: 30 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});
```

- [ ] **Step 6: Write speculative refill tests**

```js
describe('speculative refill', () => {
  it('attempts refill when drained + solar delta met + warm outdoor', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      collectorsDrained: true,
      lastRefillAttempt: 0,
      now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.flags.collectorsDrained, false);
    assert.strictEqual(result.flags.lastRefillAttempt, 2000);
  });

  it('does not refill when outdoor too cold', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 4 },
      collectorsDrained: true,
      lastRefillAttempt: 0,
      now: 2000  // cooldown cleared, only outdoor guard blocks
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('respects retry cooldown', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      collectorsDrained: true,
      lastRefillAttempt: 500, now: 1000  // only 500s, cooldown is 1800
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('allows refill after cooldown expires', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      collectorsDrained: true,
      lastRefillAttempt: 500, now: 2500  // 2000s > 1800 cooldown
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });
});
```

- [ ] **Step 7: Write sensor failure and edge case tests**

```js
describe('sensor failure', () => {
  it('transitions to IDLE when any sensor is stale', () => {
    const result = evaluate(makeState({
      currentMode: MODES.SOLAR_CHARGING,
      sensorAge: { collector: 200, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('transitions to IDLE when all sensors stale', () => {
    const result = evaluate(makeState({
      currentMode: MODES.SOLAR_CHARGING,
      sensorAge: { collector: 200, tank_top: 200, tank_bottom: 200, greenhouse: 200, outdoor: 200 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('stays in mode when sensors are fresh', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      sensorAge: { collector: 10, tank_top: 10, tank_bottom: 10, greenhouse: 10, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('handles null temperature values gracefully', () => {
    // collector is null — solar entry check skipped, returns IDLE
    const result = evaluate(makeState({
      temps: { collector: null, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });
});

describe('edge cases', () => {
  it('overheat during active charging triggers drain', () => {
    const result = evaluate(makeState({
      temps: { collector: 90, tank_top: 86, tank_bottom: 70, greenhouse: 25, outdoor: 30 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('boot during freeze: first eval triggers drain if not drained', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 5, tank_bottom: 5, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: false
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('boot during freeze: stays IDLE if already drained', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 5, tank_bottom: 5, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    }), null);
    // Emergency needs tank_top < 25 AND greenhouse < 5
    // greenhouse is -3 < 5 and tank_top is 5 < 25, so emergency triggers
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('drain timeout sets collectorsDrained and returns IDLE', () => {
    const result = evaluate(makeState({
      currentMode: MODES.ACTIVE_DRAIN,
      modeEnteredAt: 0, now: 200  // 200s > drainTimeout 180s
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.collectorsDrained, true);
  });

  it('stays in ACTIVE_DRAIN before timeout', () => {
    const result = evaluate(makeState({
      currentMode: MODES.ACTIVE_DRAIN,
      modeEnteredAt: 0, now: 100  // 100s < 180s
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});
```

- [ ] **Step 8: Run all unit tests**

Run: `node --test tests/control-logic.test.js`
Expected: All tests pass.

- [ ] **Step 9: Commit**

```bash
git add tests/control-logic.test.js
git commit -m "test: complete unit tests for evaluate() — all spec categories"
```

---

## Chunk 2: Thermal Model

### Task 2: Thermal model — constants and structure

**Files:**
- Modify: `tests/simulation/thermal-model.js`
- Create: `tests/simulation/thermal-model.test.js`

- [ ] **Step 1: Write thermal model tests**

These tests verify qualitative behavior — directions and relative magnitudes, not exact values.

```js
// tests/simulation/thermal-model.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { createModel, tick, PARAMS } = require('./thermal-model.js');

const IDLE_DECISIONS = {
  valves: { vi_btm: false, vi_top: false, vi_coll: false,
            vo_coll: false, vo_rad: false, vo_tank: false,
            v_ret: false, v_air: false },
  actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false }
};

const SOLAR_DECISIONS = {
  valves: { vi_btm: true, vi_top: false, vi_coll: false,
            vo_coll: true, vo_rad: false, vo_tank: false,
            v_ret: true, v_air: false },
  actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false }
};

const HEATING_DECISIONS = {
  valves: { vi_btm: false, vi_top: true, vi_coll: false,
            vo_coll: false, vo_rad: true, vo_tank: false,
            v_ret: false, v_air: false },
  actuators: { pump: true, fan: true, space_heater: false, immersion_heater: false }
};

const DRAIN_DECISIONS = {
  valves: { vi_btm: false, vi_top: false, vi_coll: true,
            vo_coll: false, vo_rad: false, vo_tank: true,
            v_ret: false, v_air: true },
  actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false }
};

const EMERGENCY_DECISIONS = {
  valves: { vi_btm: false, vi_top: false, vi_coll: false,
            vo_coll: false, vo_rad: false, vo_tank: false,
            v_ret: false, v_air: false },
  actuators: { pump: false, fan: false, space_heater: true, immersion_heater: true }
};

describe('thermal model — collector', () => {
  it('heats up under irradiance with no flow', () => {
    const m = createModel({ collector: 20, outdoor: 10, irradiance: 800 });
    const m2 = tick(m, 60, IDLE_DECISIONS);
    assert.ok(m2.collector > m.collector, 'collector should heat up');
  });

  it('cools toward ambient with no irradiance', () => {
    const m = createModel({ collector: 60, outdoor: 10, irradiance: 0 });
    const m2 = tick(m, 60, IDLE_DECISIONS);
    assert.ok(m2.collector < m.collector, 'collector should cool');
    assert.ok(m2.collector > 10, 'should not cool below ambient in 60s');
  });

  it('dry collector responds faster than wet', () => {
    const mDry = createModel({ collector: 60, outdoor: 10, irradiance: 0,
                                collectorWaterVolume: 0 });
    const mWet = createModel({ collector: 60, outdoor: 10, irradiance: 0,
                                collectorWaterVolume: PARAMS.collectorWaterCapacity });
    const dryAfter = tick(mDry, 60, IDLE_DECISIONS);
    const wetAfter = tick(mWet, 60, IDLE_DECISIONS);
    const dryCooling = mDry.collector - dryAfter.collector;
    const wetCooling = mWet.collector - wetAfter.collector;
    assert.ok(dryCooling > wetCooling,
      'dry collector should cool faster (lower thermal mass)');
  });

  it('water flow extracts heat from collector', () => {
    const m = createModel({ collector: 60, tank_bottom: 30, outdoor: 20,
                            irradiance: 0, collectorWaterVolume: 10 });
    const noFlow = tick(m, 10, IDLE_DECISIONS);
    const withFlow = tick(m, 10, SOLAR_DECISIONS);
    assert.ok(withFlow.collector < noFlow.collector,
      'flow should extract additional heat from collector');
  });
});

describe('thermal model — tank', () => {
  it('solar charging warms tank top', () => {
    const m = createModel({ collector: 70, tank_top: 40, tank_bottom: 30,
                            outdoor: 10, irradiance: 800, collectorWaterVolume: 10 });
    const m2 = tick(m, 60, SOLAR_DECISIONS);
    assert.ok(m2.tank_top > m.tank_top, 'tank top should warm during solar charging');
  });

  it('stable stratification: slow mixing when top > bottom', () => {
    const m = createModel({ tank_top: 60, tank_bottom: 30, outdoor: 20, irradiance: 0 });
    const m2 = tick(m, 3600, IDLE_DECISIONS);
    assert.ok(m2.tank_top > m2.tank_bottom,
      'stratification should persist (top still hotter)');
  });

  it('unstable stratification: rapid mixing when bottom > top', () => {
    const m = createModel({ tank_top: 30, tank_bottom: 60, outdoor: 20, irradiance: 0 });
    const m2 = tick(m, 3600, IDLE_DECISIONS);
    const diff = Math.abs(m2.tank_top - m2.tank_bottom);
    assert.ok(diff < 10, 'unstable stratification should mix rapidly, diff=' + diff.toFixed(1));
  });
});

describe('thermal model — greenhouse', () => {
  it('cools toward ambient with no heating', () => {
    const m = createModel({ greenhouse: 15, outdoor: 0, irradiance: 0 });
    const m2 = tick(m, 3600, IDLE_DECISIONS);
    assert.ok(m2.greenhouse < m.greenhouse, 'greenhouse should cool');
    assert.ok(m2.greenhouse > 0, 'should not reach ambient in 1h');
  });

  it('warms with radiator flow from hot tank', () => {
    const m = createModel({ greenhouse: 10, tank_top: 60, tank_bottom: 40,
                            outdoor: 5, irradiance: 0 });
    const noHeat = tick(m, 3600, IDLE_DECISIONS);
    const withHeat = tick(m, 3600, HEATING_DECISIONS);
    assert.ok(withHeat.greenhouse > noHeat.greenhouse,
      'radiator should warm greenhouse');
  });

  it('warms with space heater', () => {
    const m = createModel({ greenhouse: 5, outdoor: -5, irradiance: 0 });
    const m2 = tick(m, 3600, EMERGENCY_DECISIONS);
    assert.ok(m2.greenhouse > m.greenhouse, 'space heater should warm greenhouse');
  });
});

describe('thermal model — drain', () => {
  it('reduces collector water volume', () => {
    const m = createModel({ collectorWaterVolume: 10, collector: 30,
                            tank_bottom: 30, outdoor: 10, irradiance: 0 });
    const m2 = tick(m, 60, DRAIN_DECISIONS);
    assert.ok(m2.collectorWaterVolume < m.collectorWaterVolume,
      'drain should reduce water volume');
  });

  it('water volume does not go below zero', () => {
    const m = createModel({ collectorWaterVolume: 0.01, collector: 30,
                            tank_bottom: 30, outdoor: 10, irradiance: 0 });
    const m2 = tick(m, 60, DRAIN_DECISIONS);
    assert.ok(m2.collectorWaterVolume >= 0, 'volume should not go negative');
  });

  it('solar flow fills collectors', () => {
    const m = createModel({ collectorWaterVolume: 0, collector: 30,
                            tank_bottom: 30, outdoor: 10, irradiance: 0 });
    const m2 = tick(m, 60, SOLAR_DECISIONS);
    assert.ok(m2.collectorWaterVolume > 0, 'solar flow should fill collectors');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `node --test tests/simulation/thermal-model.test.js`
Expected: FAIL — `tick()` is a stub returning unchanged model.

- [ ] **Step 3: Implement thermal model**

```js
// tests/simulation/thermal-model.js
const PARAMS = {
  // Collector
  collectorArea: 4,                // m²
  collectorAbsorptivity: 0.8,
  collectorHeatLossCoeff: 5,       // W/(m²·K)
  collectorThermalMassDry: 5000,   // J/K
  collectorThermalMassWet: 20000,  // J/K
  collectorWaterCapacity: 10,      // liters

  // Tank
  tankVolume: 300,                 // liters
  tankZoneSplit: 0.5,
  tankInsulationLoss: 2,           // W/K total
  tankMixingCoeff: 0.5,            // W/K (stable: top > bottom)
  tankConvectiveMixing: 50,        // W/K (unstable: bottom > top)

  // Greenhouse
  greenhouseHeatLoss: 50,          // W/K
  greenhouseThermalMass: 500000,   // J/K
  radiatorCoeff: 200,              // W/K
  spaceHeaterPower: 2000,          // W
  immersionHeaterPower: 2000,      // W (heats tank top zone)

  // Water
  waterFlowRate: 5 / 60,           // L/s (5 L/min)
  waterSpecificHeat: 4186,         // J/(kg·K)

  // Pump power (for trace)
  pumpPowerNormal: 50,             // W
  pumpPowerDry: 10,                // W
};

function createModel(overrides) {
  const defaults = {
    collector: 20,
    tank_top: 40,
    tank_bottom: 30,
    greenhouse: 15,
    outdoor: 10,
    irradiance: 0,
    collectorWaterVolume: 0,
  };
  return Object.assign({}, defaults, overrides);
}

function tick(model, dt, decisions, params) {
  const p = params || PARAMS;
  const m = Object.assign({}, model);
  const cp = p.waterSpecificHeat;
  const f = p.waterFlowRate;  // L/s

  // Determine flow paths from valve + actuator state
  const pump = decisions.actuators.pump;
  const solarFlow = pump && decisions.valves.vi_btm && decisions.valves.vo_coll;
  const radiatorFlow = pump && decisions.valves.vi_top && decisions.valves.vo_rad;
  const drainFlow = pump && decisions.valves.vi_coll && decisions.valves.vo_tank;

  // ---- Collector ----
  const waterFrac = Math.min(m.collectorWaterVolume / p.collectorWaterCapacity, 1);
  const collMass = p.collectorThermalMassDry +
    (p.collectorThermalMassWet - p.collectorThermalMassDry) * waterFrac;

  let Qcoll = 0;
  Qcoll += m.irradiance * p.collectorArea * p.collectorAbsorptivity;
  Qcoll -= p.collectorHeatLossCoeff * p.collectorArea * (m.collector - m.outdoor);

  if (solarFlow && m.collectorWaterVolume > 0.1) {
    Qcoll -= f * cp * (m.collector - m.tank_bottom);
  }

  // Drain flow: water leaving collectors takes heat with it
  if (drainFlow && m.collectorWaterVolume > 0) {
    Qcoll -= f * cp * (m.collector - m.tank_bottom);
  }

  m.collector += (Qcoll / collMass) * dt;

  // Collector water volume
  if (solarFlow) {
    m.collectorWaterVolume = Math.min(
      m.collectorWaterVolume + f * dt, p.collectorWaterCapacity);
  } else if (drainFlow && m.collectorWaterVolume > 0) {
    m.collectorWaterVolume = Math.max(
      m.collectorWaterVolume - f * dt, 0);
  }

  // ---- Tank ----
  const Vzone = p.tankVolume * p.tankZoneSplit;
  const Czone = Vzone * cp;

  let Qtop = 0;
  let Qbot = 0;

  if (solarFlow && m.collectorWaterVolume > 0.1) {
    // Hot water from collector enters top zone
    Qtop += f * cp * (m.collector - m.tank_top);
    // Bottom zone: water leaves at T_bottom (no net heat change from flow)
    // Inter-zone mixing term below handles heat transfer between zones
  }

  if (radiatorFlow) {
    const Qrad = p.radiatorCoeff * (m.tank_top - m.greenhouse);
    const Treturn = Math.max(m.tank_top - Qrad / (f * cp), m.greenhouse);
    // Top zone loses hot water, replaced by cooler bottom water
    Qtop -= f * cp * (m.tank_top - m.tank_bottom);
    // Bottom zone receives cooled return water from radiator
    Qbot += f * cp * (Treturn - m.tank_bottom);
  }

  if (drainFlow && m.collectorWaterVolume > 0) {
    Qbot += f * cp * (m.collector - m.tank_bottom);
  }

  // Immersion heater heats tank top zone
  if (decisions.actuators.immersion_heater) {
    Qtop += p.immersionHeaterPower;
  }

  Qtop -= (p.tankInsulationLoss / 2) * (m.tank_top - m.outdoor);
  Qbot -= (p.tankInsulationLoss / 2) * (m.tank_bottom - m.outdoor);

  const mixCoeff = m.tank_bottom > m.tank_top ? p.tankConvectiveMixing : p.tankMixingCoeff;
  const Qmix = mixCoeff * (m.tank_top - m.tank_bottom);
  Qtop -= Qmix;
  Qbot += Qmix;

  m.tank_top += (Qtop / Czone) * dt;
  m.tank_bottom += (Qbot / Czone) * dt;

  // ---- Greenhouse ----
  let Qgh = 0;
  Qgh -= p.greenhouseHeatLoss * (m.greenhouse - m.outdoor);

  if (radiatorFlow) {
    Qgh += p.radiatorCoeff * (m.tank_top - m.greenhouse);
  }

  if (decisions.actuators.space_heater) {
    Qgh += p.spaceHeaterPower;
  }

  m.greenhouse += (Qgh / p.greenhouseThermalMass) * dt;

  return m;
}

module.exports = { createModel, tick, PARAMS };
```

- [ ] **Step 4: Run thermal model tests — verify they pass**

Run: `node --test tests/simulation/thermal-model.test.js`
Expected: All pass.

- [ ] **Step 5: Run full suite to check nothing broke**

Run: `node --test tests/control-logic.test.js tests/simulation/thermal-model.test.js`
Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add tests/simulation/thermal-model.js tests/simulation/thermal-model.test.js
git commit -m "feat: implement lumped-parameter thermal model with TDD tests"
```

---

## Chunk 3: Simulator and Test Runner

### Task 3: Virtual-time simulator

**Files:**
- Modify: `tests/simulation/simulator.js`

- [ ] **Step 1: Implement simulator**

```js
// tests/simulation/simulator.js
const { tick, createModel } = require('./thermal-model.js');
const { evaluate, MODES } = require('../../scripts/control-logic.js');

const CONTROL_INTERVAL = 30;  // seconds between evaluate() calls

function simulate(scenario, config) {
  const initTemps = scenario.initialState || {};
  let model = createModel(Object.assign({
    outdoor: scenario.ambient(0),
    irradiance: scenario.irradiance(0),
  }, initTemps));

  const trace = [];

  // Control state
  let currentMode = initTemps.mode || MODES.IDLE;
  let modeEnteredAt = 0;
  let collectorsDrained = initTemps.collectorsDrained || false;
  let lastRefillAttempt = initTemps.lastRefillAttempt || 0;
  let drainDryTicks = 0;

  // Initial evaluate
  let decisions = runEvaluate(0);

  for (let t = 0; t < scenario.duration; t++) {
    // Update environment
    model.outdoor = scenario.ambient(t);
    model.irradiance = scenario.irradiance(t);

    // Tick thermal model
    model = tick(model, 1, decisions);

    // Drain completion: simulate shell's dry-run detection
    if (currentMode === MODES.ACTIVE_DRAIN) {
      if (model.collectorWaterVolume <= 0) {
        drainDryTicks++;
        if (drainDryTicks >= 3) {
          collectorsDrained = true;
          currentMode = MODES.IDLE;
          modeEnteredAt = t;
          decisions = runEvaluate(t);
          drainDryTicks = 0;
        }
      } else {
        drainDryTicks = 0;
      }
    }

    // Control loop every CONTROL_INTERVAL seconds (skip if drain completion already evaluated)
    let evaluatedThisTick = false;
    if (currentMode === 'IDLE' && trace.length > 0 && trace[trace.length - 1].mode === 'ACTIVE_DRAIN') {
      evaluatedThisTick = true;  // drain completion already ran evaluate
    }
    if (t > 0 && t % CONTROL_INTERVAL === 0 && !evaluatedThisTick) {
      decisions = runEvaluate(t);
    }

    // Pump power: depends on flow path, not just collector volume
    const solarOrDrain = decisions.valves.vi_coll || decisions.valves.vo_coll;
    const pumpPower = decisions.actuators.pump
      ? (solarOrDrain ? (model.collectorWaterVolume > 0.1 ? 50 : 10) : 50)
      : 0;

    // Event detection
    const prevMode = trace.length > 0 ? trace[trace.length - 1].mode : null;
    const event = currentMode !== prevMode
      ? 'MODE_TRANSITION: ' + (prevMode || 'INIT') + ' \u2192 ' + currentMode
      : null;

    trace.push({
      t,
      temps: {
        collector: round2(model.collector),
        tank_top: round2(model.tank_top),
        tank_bottom: round2(model.tank_bottom),
        greenhouse: round2(model.greenhouse),
        outdoor: round2(model.outdoor),
      },
      irradiance: round2(model.irradiance),
      mode: currentMode,
      valves: Object.assign({}, decisions.valves),
      pump: decisions.actuators.pump,
      pump_power: pumpPower,
      event,
    });
  }

  return trace;

  function runEvaluate(t) {
    const sensorAge = scenario.sensorAge
      ? scenario.sensorAge(t)
      : { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 };

    const evalState = {
      temps: {
        collector: model.collector,
        tank_top: model.tank_top,
        tank_bottom: model.tank_bottom,
        greenhouse: model.greenhouse,
        outdoor: model.outdoor,
      },
      currentMode,
      modeEnteredAt,
      now: t,
      collectorsDrained,
      lastRefillAttempt,
      sensorAge,
    };

    const result = evaluate(evalState, config);

    if (result.nextMode !== currentMode) {
      currentMode = result.nextMode;
      modeEnteredAt = t;
      drainDryTicks = 0;
    }
    collectorsDrained = result.flags.collectorsDrained;
    lastRefillAttempt = result.flags.lastRefillAttempt;

    return result;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { simulate };
```

- [ ] **Step 2: Verify import works**

Run: `node -e "const { simulate } = require('./tests/simulation/simulator.js'); console.log(typeof simulate)"`
Expected: `function`

### Task 4: Simulation test runner

**Files:**
- Modify: `tests/simulation/simulation.test.js`

- [ ] **Step 3: Implement test runner with trace dump on failure**

```js
// tests/simulation/simulation.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { simulate } = require('./simulator.js');
const { scenarios } = require('./scenarios.js');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

describe('simulation', () => {
  for (const scenario of scenarios) {
    it(scenario.name, () => {
      const trace = simulate(scenario, scenario.config || null);

      const failures = [];
      for (const assertion of scenario.assertions) {
        try {
          assertion.check(trace);
        } catch (err) {
          failures.push(assertion.description + ': ' + err.message);
        }
      }

      if (failures.length > 0) {
        // Dump trace on failure
        if (!fs.existsSync(OUTPUT_DIR)) {
          fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }
        const tracePath = path.join(OUTPUT_DIR, scenario.name + '.trace.json');
        fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));
        assert.fail(
          failures.length + ' assertion(s) failed for ' + scenario.name +
          ':\n  - ' + failures.join('\n  - ') +
          '\n  Trace written to: ' + tracePath
        );
      }
    });
  }
});
```

- [ ] **Step 4: Run simulation tests (should pass vacuously if no scenarios yet)**

Run: `node --test tests/simulation/simulation.test.js`
Expected: Pass (no scenarios = no test cases).

- [ ] **Step 5: Commit**

```bash
git add tests/simulation/simulator.js tests/simulation/simulation.test.js
git commit -m "feat: implement virtual-time simulator and test runner with trace dump"
```

---

## Chunk 4: Scenarios

### Task 5: Scenario helper functions

**Files:**
- Modify: `tests/simulation/scenarios.js`

- [ ] **Step 1: Add environment profile helpers and first 3 scenarios**

```js
// tests/simulation/scenarios.js
const { MODES } = require('../../scripts/control-logic.js');

// --- Environment profile helpers ---

// Sinusoidal temperature: min at hour 4, max at hour 14
function sinusoidalTemp(min, max) {
  return function(t) {
    const hour = (t / 3600) % 24;
    // Cosine shifted so min at 4:00, max at 16:00
    return (min + max) / 2 + (max - min) / 2 * Math.cos(Math.PI * (hour - 14) / 12);
  };
}

// Bell curve irradiance: 0 at night, peak at solar noon (12:00)
function bellCurveIrradiance(peak) {
  return function(t) {
    const hour = (t / 3600) % 24;
    if (hour < 6 || hour > 18) return 0;
    // Gaussian centered at 12, sigma ~3h
    const x = (hour - 12) / 3;
    return peak * Math.exp(-x * x / 2);
  };
}

// Constant value
function constant(val) {
  return function() { return val; };
}

// Linear ramp from start to end over duration
function ramp(startVal, endVal, duration) {
  return function(t) {
    const frac = Math.min(t / duration, 1);
    return startVal + (endVal - startVal) * frac;
  };
}

// Fluctuating irradiance (semi-cloudy)
function cloudyIrradiance(peak, cloudInterval, cloudDuration) {
  const base = bellCurveIrradiance(peak);
  return function(t) {
    const val = base(t);
    // Cloud every cloudInterval seconds, lasting cloudDuration
    if (val > 0 && (t % cloudInterval) < cloudDuration) {
      return val * 0.1;  // 90% reduction during cloud
    }
    return val;
  };
}

// --- Assertion helpers ---

function findModeTransitions(trace, toMode) {
  return trace.filter(s => s.event && s.event.includes('\u2192 ' + toMode));
}

function findMode(trace, mode) {
  return trace.filter(s => s.mode === mode);
}

function maxTemp(trace, sensor) {
  return Math.max(...trace.map(s => s.temps[sensor]));
}

function minTemp(trace, sensor) {
  return Math.min(...trace.map(s => s.temps[sensor]));
}

// --- Scenarios ---

const scenarios = [
  // 1. Sunny day
  {
    name: 'sunny-day',
    duration: 86400,
    initialState: {
      collector: 10, tank_top: 25, tank_bottom: 20,
      greenhouse: 12, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: sinusoidalTemp(5, 15),
    irradiance: bellCurveIrradiance(800),
    assertions: [
      {
        description: 'solar charging starts during daylight',
        check: function(trace) {
          const transitions = findModeTransitions(trace, MODES.SOLAR_CHARGING);
          if (transitions.length === 0) throw new Error('never entered SOLAR_CHARGING');
          const hour = transitions[0].t / 3600;
          if (hour < 6 || hour > 14) throw new Error('started at hour ' + hour.toFixed(1));
        }
      },
      {
        description: 'solar charging stops by evening',
        check: function(trace) {
          const eveningFrames = trace.filter(s => s.t > 64800); // after 18:00
          const stillSolar = eveningFrames.filter(s => s.mode === MODES.SOLAR_CHARGING);
          if (stillSolar.length > 300) throw new Error('still solar charging after 18:00');
        }
      },
      {
        description: 'tank top warms during the day',
        check: function(trace) {
          const noon = trace.find(s => s.t === 43200);
          const morning = trace.find(s => s.t === 21600);
          if (!noon || !morning) throw new Error('missing data points');
          if (noon.temps.tank_top <= morning.temps.tank_top) {
            throw new Error('tank did not warm: ' + morning.temps.tank_top + ' -> ' + noon.temps.tank_top);
          }
        }
      },
    ],
  },

  // 2. Semi-cloudy day
  {
    name: 'semi-cloudy-day',
    duration: 86400,
    initialState: {
      collector: 10, tank_top: 30, tank_bottom: 25,
      greenhouse: 15, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    config: { minModeDuration: 60, refillRetryCooldown: 300, minRunTimeAfterRefill: 120 },
    ambient: sinusoidalTemp(8, 14),
    irradiance: cloudyIrradiance(700, 1200, 400),
    assertions: [
      {
        description: 'no mode oscillation within minimum duration',
        check: function(trace) {
          let lastTransition = 0;
          for (const s of trace) {
            if (s.event && s.event.includes('\u2192')) {
              const gap = s.t - lastTransition;
              // Allow very first transition and drain preemptions
              if (lastTransition > 0 && gap < 55 && !s.event.includes(MODES.ACTIVE_DRAIN)) {
                throw new Error('oscillation at t=' + s.t + ' gap=' + gap + 's: ' + s.event);
              }
              lastTransition = s.t;
            }
          }
        }
      },
      {
        description: 'at least one speculative refill attempt occurs',
        check: function(trace) {
          const refills = findModeTransitions(trace, MODES.SOLAR_CHARGING);
          if (refills.length === 0) throw new Error('no speculative refill occurred');
        }
      },
    ],
  },

  // 3. Freeze at dusk
  {
    name: 'freeze-at-dusk',
    duration: 43200,
    initialState: {
      collector: 45, tank_top: 40, tank_bottom: 35,
      greenhouse: 12, collectorsDrained: false,
      collectorWaterVolume: 10, mode: MODES.SOLAR_CHARGING,
    },
    ambient: ramp(8, -5, 43200),
    irradiance: ramp(400, 0, 21600),
    assertions: [
      {
        description: 'drain triggers before outdoor reaches 0°C',
        check: function(trace) {
          const drainStart = findModeTransitions(trace, MODES.ACTIVE_DRAIN);
          if (drainStart.length === 0) throw new Error('drain never triggered');
          const t = drainStart[0].t;
          const outdoor = trace[t].temps.outdoor;
          if (outdoor < 0) throw new Error('drain started too late, outdoor=' + outdoor);
        }
      },
      {
        description: 'collectors fully drained',
        check: function(trace) {
          const lastFrame = trace[trace.length - 1];
          const idleFrames = trace.filter(s => s.mode === MODES.IDLE && s.t > 10000);
          if (idleFrames.length === 0) throw new Error('never returned to IDLE after drain');
        }
      },
    ],
  },

  // 4. Overheat
  {
    name: 'overheat',
    duration: 28800,
    initialState: {
      collector: 60, tank_top: 70, tank_bottom: 60,
      greenhouse: 25, collectorsDrained: false,
      collectorWaterVolume: 10, mode: MODES.SOLAR_CHARGING,
    },
    ambient: constant(25),
    irradiance: bellCurveIrradiance(1000),
    assertions: [
      {
        description: 'overheat drain triggers when tank_top exceeds 85°C',
        check: function(trace) {
          const drain = findModeTransitions(trace, MODES.ACTIVE_DRAIN);
          if (drain.length === 0) throw new Error('overheat drain never triggered');
        }
      },
      {
        description: 'collector never exceeds 95°C',
        check: function(trace) {
          const max = maxTemp(trace, 'collector');
          if (max > 95) throw new Error('collector reached ' + max.toFixed(1) + '°C');
        }
      },
    ],
  },

  // 5. Cold night heating
  {
    name: 'cold-night-heating',
    duration: 43200,
    initialState: {
      collector: 5, tank_top: 60, tank_bottom: 50,
      greenhouse: 15, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: ramp(5, -2, 43200),
    irradiance: constant(0),
    assertions: [
      {
        description: 'greenhouse heating activates when greenhouse < 10',
        check: function(trace) {
          const heat = findModeTransitions(trace, MODES.GREENHOUSE_HEATING);
          if (heat.length === 0) throw new Error('heating never activated');
          const idx = heat[0].t;
          if (trace[idx].temps.greenhouse > 10.5) {
            throw new Error('heating started at greenhouse=' + trace[idx].temps.greenhouse);
          }
        }
      },
      {
        description: 'heating deactivates when greenhouse > 12',
        check: function(trace) {
          const heatFrames = findMode(trace, MODES.GREENHOUSE_HEATING);
          if (heatFrames.length === 0) return; // skip if never heated
          // Check that heating doesn't run when greenhouse > 12.5
          const overheated = heatFrames.filter(s => s.temps.greenhouse > 12.5);
          if (overheated.length > 60) { // allow transient from min duration
            throw new Error('heating ran too long above 12°C');
          }
        }
      },
    ],
  },

  // 6. Emergency fallback
  {
    name: 'emergency-fallback',
    duration: 14400,
    initialState: {
      collector: -5, tank_top: 15, tank_bottom: 10,
      greenhouse: 8, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: constant(-5),
    irradiance: constant(0),
    assertions: [
      {
        description: 'emergency heating activates when greenhouse < 5',
        check: function(trace) {
          const em = findModeTransitions(trace, MODES.EMERGENCY_HEATING);
          if (em.length === 0) throw new Error('emergency never activated');
        }
      },
      {
        description: 'space heater is ON during emergency',
        check: function(trace) {
          const emFrames = findMode(trace, MODES.EMERGENCY_HEATING);
          for (const s of emFrames) {
            if (!s.valves) continue;
            // Emergency: pump off, all valves closed, space_heater on
            if (s.pump) throw new Error('pump should be off in emergency at t=' + s.t);
          }
        }
      },
      {
        description: 'emergency exits when greenhouse > 8',
        check: function(trace) {
          const emFrames = findMode(trace, MODES.EMERGENCY_HEATING);
          const overheated = emFrames.filter(s => s.temps.greenhouse > 9);
          if (overheated.length > 600) {
            throw new Error('emergency ran too long above 8°C');
          }
        }
      },
    ],
  },

  // 7. Sensor failure
  {
    name: 'sensor-failure',
    duration: 3600,
    initialState: {
      collector: 50, tank_top: 40, tank_bottom: 30,
      greenhouse: 15, collectorsDrained: false,
      collectorWaterVolume: 10, mode: MODES.SOLAR_CHARGING,
    },
    ambient: constant(10),
    irradiance: constant(500),
    sensorAge: function(t) {
      // Sensors go stale at t=600 (collector stops updating)
      if (t >= 600) {
        return { collector: t - 600, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 };
      }
      return { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 };
    },
    assertions: [
      {
        description: 'system transitions to IDLE when sensor goes stale',
        check: function(trace) {
          // sensorStaleThreshold is 150s, so IDLE should happen by t=750
          const idleAfterStale = trace.filter(s => s.t > 750 && s.mode === MODES.IDLE);
          if (idleAfterStale.length === 0) {
            throw new Error('did not transition to IDLE after sensor failure');
          }
        }
      },
      {
        description: 'pump is off after sensor failure',
        check: function(trace) {
          const lateFrames = trace.filter(s => s.t > 900);
          const pumpOn = lateFrames.filter(s => s.pump);
          if (pumpOn.length > 0) throw new Error('pump still on after sensor failure');
        }
      },
    ],
  },

  // 8. Boot during freeze
  {
    name: 'boot-during-freeze',
    duration: 3600,
    initialState: {
      collector: -2, tank_top: 5, tank_bottom: 5,
      greenhouse: -2, collectorsDrained: false,
      collectorWaterVolume: 8,
    },
    ambient: constant(-3),
    irradiance: constant(0),
    assertions: [
      {
        description: 'drain triggers on first evaluation',
        check: function(trace) {
          const drain = findModeTransitions(trace, MODES.ACTIVE_DRAIN);
          if (drain.length === 0) throw new Error('drain never triggered');
          if (drain[0].t > 30) throw new Error('drain started too late at t=' + drain[0].t);
        }
      },
      {
        description: 'system reaches safe state (IDLE or EMERGENCY) within 5 minutes',
        check: function(trace) {
          const fiveMin = trace.filter(s => s.t > 300);
          const safe = fiveMin.filter(s =>
            s.mode === MODES.IDLE || s.mode === MODES.EMERGENCY_HEATING);
          if (safe.length < fiveMin.length * 0.9) {
            throw new Error('system not in safe state after 5 minutes');
          }
        }
      },
    ],
  },

  // 9. Concurrent triggers
  {
    name: 'concurrent-triggers',
    duration: 14400,
    initialState: {
      collector: 10, tank_top: 50, tank_bottom: 40,
      greenhouse: 9, collectorsDrained: true,
      collectorWaterVolume: 0,
    },
    ambient: constant(5),
    irradiance: constant(500),
    assertions: [
      {
        description: 'greenhouse heating wins over solar when both triggers active',
        check: function(trace) {
          // First non-IDLE mode should be GREENHOUSE_HEATING
          const firstActive = trace.find(s => s.mode !== MODES.IDLE);
          if (!firstActive) throw new Error('never left IDLE');
          if (firstActive.mode !== MODES.GREENHOUSE_HEATING) {
            throw new Error('first mode was ' + firstActive.mode + ', expected GREENHOUSE_HEATING');
          }
        }
      },
    ],
  },

  // 10. Hysteresis boundary
  {
    name: 'hysteresis-boundary',
    duration: 14400,
    initialState: {
      collector: 37, tank_top: 40, tank_bottom: 30,
      greenhouse: 15, collectorsDrained: false,
      collectorWaterVolume: 10,
    },
    config: { minModeDuration: 60 },
    ambient: constant(10),
    irradiance: constant(300),  // just enough to hover near threshold
    assertions: [
      {
        description: 'no rapid oscillation (min 50s between transitions)',
        check: function(trace) {
          let lastT = 0;
          for (const s of trace) {
            if (s.event && s.event.includes('\u2192')) {
              if (lastT > 0 && (s.t - lastT) < 50) {
                throw new Error('oscillation: transitions at t=' + lastT + ' and t=' + s.t);
              }
              lastT = s.t;
            }
          }
        }
      },
    ],
  },
];

module.exports = { scenarios };
```

- [ ] **Step 2: Run full simulation test suite**

Run: `node --test tests/simulation/simulation.test.js`
Expected: All 10 scenarios pass. If any fail, check trace in `tests/output/`.

- [ ] **Step 3: Run complete test suite and verify under 10 seconds**

Run: `time node --test tests/control-logic.test.js tests/simulation/thermal-model.test.js tests/simulation/simulation.test.js`
Expected: All pass, total < 10 seconds.

- [ ] **Step 4: Commit**

```bash
git add tests/simulation/scenarios.js
git commit -m "feat: add all 10 simulation scenarios with assertions"
```

- [ ] **Step 5: Final commit — everything together**

```bash
git add -A tests/
git commit -m "feat: complete testing strategy implementation — unit tests, thermal model, simulator, 10 scenarios"
```

---

## Run Command

```sh
node --test tests/control-logic.test.js tests/simulation/thermal-model.test.js tests/simulation/simulation.test.js
```

All tests must pass in under 10 seconds total.
