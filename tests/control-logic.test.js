const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES, DEFAULT_CONFIG, MODE_VALVES,
        formatDuration, formatTemp, buildDisplayLabels } = require('../shelly/control-logic.js');

function makeState(overrides) {
  const base = {
    temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    currentMode: MODES.IDLE,
    modeEnteredAt: 0,
    now: 2000,
    collectorsDrained: false,
    lastRefillAttempt: 0,
    emergencyHeatingActive: false,
    sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
  };
  return Object.assign({}, base, overrides);
}

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

  it('enters GREENHOUSE_HEATING when greenhouse < 10 and tank has delta > 5', () => {
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

  it('enters EMERGENCY_HEATING when greenhouse < 9 and tank lacks delta', () => {
    // tank_top 12°C is only 4°C above greenhouse 8°C (< 5°C delta)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('selects highest priority mode when multiple triggers active', () => {
    // Both freeze drain and emergency could trigger — drain wins
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 8, outdoor: 1 },
      collectorsDrained: false
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});

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

  it('does not enter greenhouse heating when tank lacks sufficient delta over greenhouse', () => {
    // tank_top 13°C is only 4°C above greenhouse 9°C (< 5°C delta)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 13, tank_bottom: 10, greenhouse: 9, outdoor: 10 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('enters greenhouse heating when tank has sufficient delta even at low absolute temp', () => {
    // tank_top 20°C has 11°C delta over greenhouse 9°C (> 5°C entry delta)
    // No minimum tank temp — any tank with enough delta is useful
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 20, tank_bottom: 18, greenhouse: 9, outdoor: -20 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Should heat: tank 20°C has 11°C delta over greenhouse 9°C');
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

  it('enters emergency at greenhouse < 9 and tank lacks delta', () => {
    // tank_top 12°C is only 4°C above greenhouse 8°C (< 5°C delta)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('stays in emergency at exact exit threshold (greenhouse = 12)', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 12, outdoor: -5 },
      currentMode: MODES.EMERGENCY_HEATING,
      emergencyHeatingActive: true,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
  });

  it('exits emergency when greenhouse > 12', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 14, tank_bottom: 12, greenhouse: 13, outdoor: -5 },
      currentMode: MODES.EMERGENCY_HEATING,
      emergencyHeatingActive: true,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    // greenhouse > 12 exits emergency; tank 14°C is only 1°C above greenhouse 13°C
    // so it falls through to IDLE (not enough delta for greenhouse heating)
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.emergencyHeatingActive, false);
  });

  it('does not enter emergency at exact threshold (greenhouse = 9)', () => {
    // tank_top 12°C is only 3°C above greenhouse 9°C (< 5°C delta)
    // but greenhouse = 9 is not < 9 (exact threshold), so no emergency
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 9, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });
});

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
    // tank_top 12°C is only 4°C above greenhouse 8°C (< 5°C delta) → emergency
    const r = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
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
      const v = MODE_VALVES[mode];
      const openInputs = inputs.filter(k => v[k]).length;
      const openOutputs = outputs.filter(k => v[k]).length;
      assert.ok(openInputs <= 1, mode + ' has ' + openInputs + ' input valves open');
      assert.ok(openOutputs <= 1, mode + ' has ' + openOutputs + ' output valves open');
    }
  });
});

describe('priority and preemption', () => {
  it('ACTIVE_DRAIN preempts SOLAR_CHARGING when outdoor drops', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('EMERGENCY replaces GREENHOUSE_HEATING when tank depletes below exit delta', () => {
    // tank_top 9°C is only 1°C above greenhouse 8°C (< 2°C exit delta)
    // Pump shuts off (would cool greenhouse), emergency takes over
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 9, tank_bottom: 8, greenhouse: 8, outdoor: -5 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 1000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
  });

  it('concurrent solar + greenhouse triggers: greenhouse wins', () => {
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
      now: 2000
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
    const result = evaluate(makeState({
      temps: { collector: null, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });
});

describe('independent emergency heating overlay', () => {
  it('activates space_heater during GREENHOUSE_HEATING when greenhouse < 9', () => {
    // Tank at 20°C, greenhouse at 8°C — tank has 12°C delta (useful for pump)
    // But greenhouse is critical → space heater overlay activates too
    const result = evaluate(makeState({
      temps: { collector: -25, tank_top: 20, tank_bottom: 18, greenhouse: 8, outdoor: -30 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Pump should run: tank 20°C has 12°C delta over greenhouse 8°C');
    assert.strictEqual(result.actuators.space_heater, true,
      'Space heater should overlay: greenhouse 8°C < 9°C');
    assert.strictEqual(result.actuators.pump, true,
      'Pump should also run: tank is useful');
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
  });

  it('enters pure EMERGENCY_HEATING when tank lacks entry delta and greenhouse < 9', () => {
    // tank_top 12°C is only 4°C above greenhouse 8°C (< 5°C entry delta)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING,
      'Pure emergency: tank has no useful delta for pump');
    assert.strictEqual(result.actuators.space_heater, true);
    assert.strictEqual(result.actuators.pump, false);
  });

  it('keeps space_heater on via hysteresis until greenhouse > 12', () => {
    // Emergency was active, greenhouse warmed to 11°C — still below exit (12)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 30, tank_bottom: 28, greenhouse: 11, outdoor: -5 },
      emergencyHeatingActive: true,
      collectorsDrained: true
    }), null);
    // greenhouse 11 > 10 → no greenhouse heating entry, but emergency stays active
    assert.strictEqual(result.flags.emergencyHeatingActive, true,
      'Emergency stays active: greenhouse 11°C <= 12°C exit threshold');
  });

  it('turns off space_heater when greenhouse > 12 (emergency exit)', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 30, tank_bottom: 28, greenhouse: 13, outdoor: -5 },
      emergencyHeatingActive: true,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.flags.emergencyHeatingActive, false,
      'Emergency deactivates: greenhouse 13°C > 12°C');
    assert.strictEqual(result.actuators.space_heater, false);
  });

  it('enters GREENHOUSE_HEATING with any tank that has entry delta', () => {
    // Tank at 15°C, greenhouse at 9°C — 6°C delta > 5 entry threshold
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 15, tank_bottom: 13, greenhouse: 9, outdoor: -10 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Should heat: tank 15°C has 6°C delta over greenhouse 9°C');
    assert.strictEqual(result.actuators.space_heater, false,
      'No space heater: greenhouse 9°C is not < 9°C threshold');
  });

  it('exits GREENHOUSE_HEATING when tank drops below exit delta (2°C)', () => {
    // Currently heating, tank cooled to only 1°C above greenhouse → would cool
    const result = evaluate(makeState({
      temps: { collector: -20, tank_top: 9, tank_bottom: 8, greenhouse: 8, outdoor: -30 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING,
      'Should stop pump: tank 9°C is only 1°C above greenhouse 8°C (< 2°C)');
    assert.strictEqual(result.actuators.pump, false);
    assert.strictEqual(result.actuators.space_heater, true);
  });

  it('stays in GREENHOUSE_HEATING at exact exit tank delta (2°C)', () => {
    // tank_top = greenhouse + 2 → stays (>= threshold)
    const result = evaluate(makeState({
      temps: { collector: -20, tank_top: 10, tank_bottom: 8, greenhouse: 8, outdoor: -30 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Should stay: tank 10°C is exactly 2°C above greenhouse 8°C');
  });

  it('simulates late-season overnight: tank depletes, emergency takes over', () => {
    // Phase 1: warm tank — greenhouse heating + emergency overlay
    var state = makeState({
      temps: { collector: -20, tank_top: 30, tank_bottom: 28, greenhouse: 8, outdoor: -30 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    });

    var result = evaluate(state, null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Phase 1: tank 30°C has 22°C delta, pump runs');
    assert.strictEqual(result.actuators.space_heater, true,
      'Phase 1: space heater also on (greenhouse 8°C < 9°C)');
    assert.strictEqual(result.actuators.pump, true);

    // Phase 2: tank depletes near greenhouse — pump stops, pure emergency
    state.temps.tank_top = 9;
    state.temps.greenhouse = 8;
    state.currentMode = MODES.GREENHOUSE_HEATING;
    state.emergencyHeatingActive = result.flags.emergencyHeatingActive;
    result = evaluate(state, null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING,
      'Phase 2: tank 9°C only 1°C above greenhouse → pump off, pure emergency');
    assert.strictEqual(result.actuators.pump, false);
    assert.strictEqual(result.actuators.space_heater, true);

    // Phase 3: space heater warms greenhouse above exit
    state.temps.greenhouse = 13;
    state.currentMode = MODES.EMERGENCY_HEATING;
    state.emergencyHeatingActive = result.flags.emergencyHeatingActive;
    result = evaluate(state, null);
    assert.strictEqual(result.nextMode, MODES.IDLE,
      'Phase 3: greenhouse 13°C > 12°C → emergency off');
    assert.strictEqual(result.flags.emergencyHeatingActive, false);
  });

  it('does not activate emergency at exact threshold (greenhouse = 9)', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 9, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.flags.emergencyHeatingActive, false,
      'greenhouse = 9 is not < 9, no emergency');
  });

  it('clears emergency flag on sensor staleness', () => {
    const result = evaluate(makeState({
      emergencyHeatingActive: true,
      sensorAge: { collector: 200, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.emergencyHeatingActive, false,
      'Emergency flag cleared on stale sensors');
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

  it('boot during freeze: heats greenhouse if tank has delta', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 30, tank_bottom: 28, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    }), null);
    // tank_top 30°C has 33°C delta → pump useful, plus emergency overlay
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(result.actuators.space_heater, true,
      'Space heater also on: greenhouse -3°C < 9°C');
  });

  it('boot during freeze: uses tank even at low absolute temp if delta is enough', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 5, tank_bottom: 5, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    }), null);
    // tank_top 5°C has 8°C delta over greenhouse -3°C (> 5°C entry) → pump useful
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Tank 5°C still useful: 8°C delta over greenhouse -3°C');
    assert.strictEqual(result.actuators.space_heater, true);
    assert.strictEqual(result.actuators.pump, true);
  });

  it('boot during freeze: emergency when tank has no useful delta', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 1, tank_bottom: 1, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    }), null);
    // tank_top 1°C is only 4°C above greenhouse -3°C (< 5°C delta) → pure emergency
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
    assert.strictEqual(result.actuators.pump, false);
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

describe('formatDuration', () => {
  it('formats seconds', () => {
    assert.strictEqual(formatDuration(0), '0s');
    assert.strictEqual(formatDuration(30000), '30s');
    assert.strictEqual(formatDuration(59999), '59s');
  });

  it('formats minutes', () => {
    assert.strictEqual(formatDuration(60000), '1m');
    assert.strictEqual(formatDuration(2820000), '47m');
    assert.strictEqual(formatDuration(3599999), '59m');
  });

  it('formats hours and minutes', () => {
    assert.strictEqual(formatDuration(3600000), '1h0m');
    assert.strictEqual(formatDuration(4980000), '1h23m');
    assert.strictEqual(formatDuration(36000000), '10h0m');
  });
});

describe('formatTemp', () => {
  it('formats normal temperatures', () => {
    assert.strictEqual(formatTemp(68.2), '68C');
    assert.strictEqual(formatTemp(8.3), '8C');
    assert.strictEqual(formatTemp(-3.7), '-4C');
    assert.strictEqual(formatTemp(0), '0C');
  });

  it('returns -- for null/undefined', () => {
    assert.strictEqual(formatTemp(null), '--');
    assert.strictEqual(formatTemp(undefined), '--');
  });
});

describe('buildDisplayLabels', () => {
  function makeDisplayState(overrides) {
    const base = {
      mode: MODES.IDLE,
      modeDurationMs: 0,
      temps: { collector: 20, tank_top: 45, tank_bottom: 38, greenhouse: 8, outdoor: 3 },
      lastError: null,
      collectorsDrained: false,
    };
    return Object.assign({}, base, overrides);
  }

  it('shows mode and duration on ch0', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      mode: MODES.SOLAR_CHARGING,
      modeDurationMs: 2820000,
    }));
    assert.strictEqual(labels[0], 'SOLAR 47m');
  });

  it('uses short mode names', () => {
    assert.strictEqual(buildDisplayLabels(makeDisplayState({ mode: MODES.IDLE }))[0], 'IDLE 0s');
    assert.strictEqual(buildDisplayLabels(makeDisplayState({ mode: MODES.GREENHOUSE_HEATING }))[0], 'HEAT 0s');
    assert.strictEqual(buildDisplayLabels(makeDisplayState({ mode: MODES.ACTIVE_DRAIN }))[0], 'DRAIN 0s');
    assert.strictEqual(buildDisplayLabels(makeDisplayState({ mode: MODES.EMERGENCY_HEATING }))[0], 'EMERG 0s');
  });

  it('prefixes ! on error', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      mode: MODES.SOLAR_CHARGING,
      lastError: 'valve_vi_btm',
    }));
    assert.strictEqual(labels[0], '!SOLAR 0s');
  });

  it('appends D when drained and idle', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      mode: MODES.IDLE,
      collectorsDrained: true,
    }));
    assert.strictEqual(labels[0], 'IDLE 0s D');
  });

  it('does not append D when drained but not idle', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      mode: MODES.SOLAR_CHARGING,
      collectorsDrained: true,
    }));
    assert.strictEqual(labels[0], 'SOLAR 0s');
  });

  it('shows collector and tank temps on ch1', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      temps: { collector: 68.2, tank_top: 45, tank_bottom: 38, greenhouse: 8, outdoor: 3 },
    }));
    assert.strictEqual(labels[1], 'Coll 68C Tk45C/38C');
  });

  it('shows greenhouse temp on ch2', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      temps: { collector: 20, tank_top: 45, tank_bottom: 38, greenhouse: 8.3, outdoor: 3 },
    }));
    assert.strictEqual(labels[2], 'GH 8C');
  });

  it('shows outdoor temp on ch3', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      temps: { collector: 20, tank_top: 45, tank_bottom: 38, greenhouse: 8, outdoor: 3.1 },
    }));
    assert.strictEqual(labels[3], 'Out 3C');
  });

  it('handles null temps with --', () => {
    const labels = buildDisplayLabels(makeDisplayState({
      temps: { collector: null, tank_top: null, tank_bottom: null, greenhouse: null, outdoor: null },
    }));
    assert.strictEqual(labels[1], 'Coll -- Tk--/--');
    assert.strictEqual(labels[2], 'GH --');
    assert.strictEqual(labels[3], 'Out --');
  });

  it('returns exactly 4 labels', () => {
    const labels = buildDisplayLabels(makeDisplayState({}));
    assert.strictEqual(labels.length, 4);
  });
});
