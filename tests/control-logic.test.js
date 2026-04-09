const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES, DEFAULT_CONFIG, MODE_VALVES,
        VALVE_TIMING, planValveTransition,
        toSchedulerView, fromSchedulerView,
        buildSnapshotFromState, runBoundedPool,
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
      v_air: false
    });
    assert.deepStrictEqual(r.actuators, {
      pump: false, fan: false, space_heater: false, immersion_heater: false
    });
  });

  it('SOLAR_CHARGING: vi_btm + vo_coll open, v_air closed, pump on', () => {
    const r = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(r.valves.vi_btm, true);
    assert.strictEqual(r.valves.vo_coll, true);
    assert.strictEqual(r.valves.v_air, false);
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
      v_air: false
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

// ── Device config gated actuator tests ──

// Compact device config format: ce, ea (bitmask), fm (mode code), am (mode codes), v
describe('config-gated actuator behavior', () => {
  // ea bitmask: valves=1, pump=2, fan=4, space_heater=8, immersion_heater=16
  const disabledConfig = { ce: false, ea: 0, v: 1 };
  const partialConfig = { ce: true, ea: 1 | 2, v: 2 }; // valves + pump only
  const allEnabled = { ce: true, ea: 31, v: 1 }; // all actuators

  it('returns suppressed flag when controls are disabled', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, disabledConfig);
    assert.strictEqual(result.suppressed, true);
  });

  it('still computes correct mode when controls disabled', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('respects per-actuator bitmask — disables fan when not in mask', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 },
    }), null, partialConfig);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(result.actuators.pump, true);
    assert.strictEqual(result.actuators.fan, false);
  });

  it('keeps pump on when enabled in partial config', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, partialConfig);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.actuators.pump, true);
    assert.strictEqual(result.suppressed, false);
  });

  it('disables valves when valve bit is off', () => {
    const noValvesConfig = { ce: true, ea: 2 | 4 | 8 | 16, v: 3 }; // everything except valves
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, noValvesConfig);
    for (const key in result.valves) {
      assert.strictEqual(result.valves[key], false, key + ' should be closed');
    }
  });

  it('works without deviceConfig (backward compatible)', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.suppressed, false);
    assert.strictEqual(result.actuators.pump, true);
  });

  it('forced_mode overrides automatic mode selection', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, { ...allEnabled, fm: 'SC' });
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('forced_mode works with full mode names', () => {
    const result = evaluate(makeState({}), null, { ...allEnabled, fm: 'GH' });
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('allowed_modes filters out disallowed modes', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 },
    }), null, { ...allEnabled, am: ['I', 'SC'] });
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('allowed_modes permits allowed modes', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, { ...allEnabled, am: ['I', 'SC'] });
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('device config JSON fits within Shelly KVS 256-byte limit', () => {
    const worstCase = {
      ce: true, ea: 31, fm: 'GH',
      am: ['I', 'SC', 'GH', 'AD'], // 4 modes = max before normalization to null
      v: 9999,
    };
    const json = JSON.stringify(worstCase);
    assert.ok(json.length <= 256,
      'device config JSON is ' + json.length + ' bytes, must be <= 256. Content: ' + json);
    // Also verify it's well under — target is 1/4 of limit
    assert.ok(json.length <= 64,
      'device config should be <= 64 bytes (1/4 of KVS limit), got ' + json.length);
  });

  it('forced_mode still respects safety drain preemption', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, { ...allEnabled, fm: 'SC' });
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});

// ── Hard safety override tests (017-review-hardware-architecture) ──

describe('hard safety overrides bypass device config', () => {
  const disabledConfig = { ce: false, ea: 0, v: 1 };
  const allEnabled = { ce: true, ea: 31, v: 1 };

  it('freeze drain with ce=false returns ACTIVE_DRAIN, not suppressed, safetyOverride=true', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.suppressed, false);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('freeze drain with am=["SC"] (excluding AD) still returns ACTIVE_DRAIN', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, { ...allEnabled, am: ['SC'] });
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('overheat drain with ce=false returns ACTIVE_DRAIN, not suppressed, safetyOverride=true', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 90, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.suppressed, false);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('overheat drain with am=["I"] (excluding AD) still returns ACTIVE_DRAIN', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 90, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, { ...allEnabled, am: ['I'] });
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('sensor staleness with ce=false returns IDLE, suppressed=true (safe state)', () => {
    const result = evaluate(makeState({
      sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 200 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.suppressed, true);
  });

  it('normal solar charging with ce=false is still suppressed', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.suppressed, true);
    assert.ok(!result.safetyOverride);
  });

  it('freeze drain with ce=true also sets safetyOverride=true', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, allEnabled);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.suppressed, false);
    assert.strictEqual(result.safetyOverride, true);
  });
});

// ── Manual override guard behavior (022-relay-toggle-ui) ──
// The override guard lives in control.js (I/O layer). These tests verify that
// evaluate() still produces correct safety signals that the guard relies on,
// and that device config with mo field doesn't break evaluate().

describe('manual override safety interaction', () => {
  const overrideConfig = { ce: true, ea: 31, v: 1, mo: { a: true, ex: 9999999999, ss: false } };
  const overrideSuppressedConfig = { ce: true, ea: 31, v: 1, mo: { a: true, ex: 9999999999, ss: true } };

  it('evaluate() still returns safetyOverride=true during freeze even with mo set', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, overrideConfig);
    assert.strictEqual(result.safetyOverride, true);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('evaluate() still returns safetyOverride=true during overheat even with mo set', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 90, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, overrideConfig);
    assert.strictEqual(result.safetyOverride, true);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('evaluate() works normally with mo field in config (mo is I/O concern)', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, overrideConfig);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.suppressed, false);
  });

  it('evaluate() works with mo.ss=true (suppressed safety config)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, overrideSuppressedConfig);
    // evaluate() still returns safetyOverride — the I/O layer decides whether to act on it
    assert.strictEqual(result.safetyOverride, true);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('ce=false with mo set still returns suppressed (controls gate takes priority)', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, { ce: false, ea: 0, v: 1, mo: { a: true, ex: 9999999999, ss: false } });
    assert.strictEqual(result.suppressed, true);
  });
});

// ── planValveTransition scheduler ──

const VALVE_NAMES = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air'];

function allClosed() {
  const m = {};
  for (const n of VALVE_NAMES) m[n] = false;
  return m;
}

function allOpenSinceZero() {
  const m = {};
  for (const n of VALVE_NAMES) m[n] = 0;
  return m;
}

// INVARIANT ASSERTIONS — used by every test case below.
// See contracts/valve-scheduler.md "Invariants".
function assertInvariants(plan, input) {
  const { opening, now, current, openSince, cfg } = input;
  const timing = cfg || VALVE_TIMING;

  // INV1: slot budget.
  let liveOpens = 0;
  for (const k in opening) if (opening[k] > now) liveOpens++;
  assert.ok(
    liveOpens + plan.startOpening.length <= timing.maxConcurrentOpens,
    `INV1: liveOpens(${liveOpens}) + startOpening(${plan.startOpening.length}) > maxConcurrentOpens(${timing.maxConcurrentOpens})`
  );

  // INV2: no valve in both startOpening and closeNow.
  for (const v of plan.startOpening) {
    assert.ok(plan.closeNow.indexOf(v) === -1, `INV2: ${v} in both startOpening and closeNow`);
  }

  // INV3: no valve in closeNow has (now - openSince[v]) < minOpenMs unless openSince[v] === 0.
  for (const v of plan.closeNow) {
    const since = openSince[v] || 0;
    if (since !== 0) {
      assert.ok(
        now - since >= timing.minOpenMs,
        `INV3: ${v} in closeNow but now(${now}) - openSince(${since}) = ${now - since} < minOpenMs(${timing.minOpenMs})`
      );
    }
  }

  // INV4: no valve in startOpening has current[v] === true.
  for (const v of plan.startOpening) {
    assert.ok(!current[v], `INV4: ${v} in startOpening but current[${v}] === true`);
  }

  // INV5: no valve in closeNow has current[v] === false.
  for (const v of plan.closeNow) {
    assert.ok(current[v], `INV5: ${v} in closeNow but current[${v}] === false`);
  }

  // INV6: targetReached ⇒ all lists empty AND no live opens.
  if (plan.targetReached) {
    assert.strictEqual(plan.startOpening.length, 0, 'INV6: targetReached but startOpening non-empty');
    assert.strictEqual(plan.closeNow.length, 0, 'INV6: targetReached but closeNow non-empty');
    assert.strictEqual(plan.queuedOpens.length, 0, 'INV6: targetReached but queuedOpens non-empty');
    assert.strictEqual(Object.keys(plan.deferredCloses).length, 0, 'INV6: targetReached but deferredCloses non-empty');
    assert.strictEqual(liveOpens, 0, 'INV6: targetReached but live opening windows remain');
  }

  // INV7: nextResumeAt > now when non-null.
  if (plan.nextResumeAt !== null) {
    assert.ok(plan.nextResumeAt > now, `INV7: nextResumeAt(${plan.nextResumeAt}) <= now(${now})`);
  }
}

describe('planValveTransition — foundational', () => {
  it('target reached: all target === current, no live opens → targetReached=true, nextResumeAt=null (case 9)', () => {
    const state = { vi_btm: true, vo_coll: true, v_air: false };
    const current = { vi_btm: true, vo_coll: true, v_air: false };
    const openSince = { vi_btm: 1000, vo_coll: 1000, v_air: 0 };
    const opening = {};
    const now = 100000;
    const plan = planValveTransition(state, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.targetReached, true);
    assert.strictEqual(plan.nextResumeAt, null);
    assert.deepStrictEqual(plan.startOpening, []);
    assert.deepStrictEqual(plan.closeNow, []);
    assert.deepStrictEqual(plan.queuedOpens, []);
    assert.deepStrictEqual(plan.deferredCloses, {});
    assertInvariants(plan, { target: state, current, openSince, opening, now });
  });

  it('pure/deterministic: same inputs → deep-equal output (INV8)', () => {
    const target = { vi_btm: true, vi_top: false, vo_coll: true };
    const current = { vi_btm: false, vi_top: false, vo_coll: false };
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0 };
    const opening = {};
    const now = 1234567;
    const a = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    const b = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(a, b);
  });

  it('VALVE_TIMING has documented defaults', () => {
    assert.strictEqual(VALVE_TIMING.maxConcurrentOpens, 2);
    assert.strictEqual(VALVE_TIMING.openWindowMs, 20000);
    assert.strictEqual(VALVE_TIMING.minOpenMs, 60000);
  });
});

describe('planValveTransition — US1 PSU slot budget', () => {
  it('case 1: single valve needs to open → startOpening=[v], nextResumeAt=now+openWindowMs', () => {
    const target = { vi_btm: true };
    const current = { vi_btm: false };
    const openSince = { vi_btm: 0 };
    const opening = {};
    const now = 100000;
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.startOpening, ['vi_btm']);
    assert.deepStrictEqual(plan.closeNow, []);
    assert.deepStrictEqual(plan.queuedOpens, []);
    assert.deepStrictEqual(plan.deferredCloses, {});
    assert.strictEqual(plan.targetReached, false);
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 2: four closed valves all need to open → 2 in startOpening, 2 in queuedOpens, alphabetical order', () => {
    const target = { vi_btm: true, vi_top: true, vo_coll: true, vo_rad: true };
    const current = { vi_btm: false, vi_top: false, vo_coll: false, vo_rad: false };
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 0 };
    const opening = {};
    const now = 500000;
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.startOpening.length, 2);
    assert.strictEqual(plan.queuedOpens.length, 2);
    // Stable alphabetical ordering across the combined [startOpening, queuedOpens] list.
    const combined = plan.startOpening.concat(plan.queuedOpens);
    assert.deepStrictEqual(combined, ['vi_btm', 'vi_top', 'vo_coll', 'vo_rad']);
    assert.deepStrictEqual(plan.closeNow, []);
    assert.strictEqual(plan.targetReached, false);
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 15: deterministic ordering (same input different key insertion order → same output arrays)', () => {
    const target1 = {};
    target1.vo_rad = true; target1.vi_btm = true; target1.vo_coll = true; target1.vi_top = true;
    const target2 = {};
    target2.vi_btm = true; target2.vi_top = true; target2.vo_coll = true; target2.vo_rad = true;
    const current = { vi_btm: false, vi_top: false, vo_coll: false, vo_rad: false };
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 0 };
    const opening = {};
    const now = 200000;
    const p1 = planValveTransition(target1, current, openSince, opening, now, VALVE_TIMING);
    const p2 = planValveTransition(target2, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(p1, p2);
  });

  it('case 11: mix — two valves closing (hold satisfied) + three opening from closed', () => {
    const target = {
      vi_btm: true, vi_top: true, vo_coll: true,    // three to open
      vo_rad: false, vo_tank: false                  // two to close
    };
    const current = {
      vi_btm: false, vi_top: false, vo_coll: false,
      vo_rad: true, vo_tank: true
    };
    // openSince values are old enough that closes are immediately eligible.
    // Hold behavior is exercised in US3; this test isolates slot-budget logic.
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 1000, vo_tank: 1000 };
    const opening = {};
    const now = 70000 + 1000; // > 60s after openSince for the closing pair
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.startOpening.length, 2, 'two opens this tick (slot budget)');
    assert.strictEqual(plan.queuedOpens.length, 1, 'one queued');
    // Slot budget counts only opens.
    assert.strictEqual(plan.closeNow.length, 2);
    assert.strictEqual(plan.closeNow.indexOf('vo_rad') > -1, true);
    assert.strictEqual(plan.closeNow.indexOf('vo_tank') > -1, true);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });
});

describe('planValveTransition — US2 cross-tick queue', () => {
  it('case 3: two valves mid-flight, two more queued → startOpening=[], queuedOpens=[remaining two], nextResumeAt=min(opening[v])', () => {
    const target = { vi_btm: true, vi_top: true, vo_coll: true, vo_rad: true };
    const current = { vi_btm: false, vi_top: false, vo_coll: false, vo_rad: false };
    const openSince = { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 0 };
    // Both slots are taken: vi_btm + vo_coll are mid-flight
    const now = 100000;
    const opening = { vi_btm: now + 12000, vo_coll: now + 15000 };
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.startOpening, []);
    assert.strictEqual(plan.queuedOpens.length, 2);
    assert.ok(plan.queuedOpens.indexOf('vi_top') > -1);
    assert.ok(plan.queuedOpens.indexOf('vo_rad') > -1);
    // nextResumeAt is the earliest live window end.
    assert.strictEqual(plan.nextResumeAt, now + 12000);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 4: first batch window ended → opening now empty, queued valves move into startOpening', () => {
    const target = { vi_btm: true, vi_top: true, vo_coll: true, vo_rad: true };
    // First batch finished; the shell cleared the opening entries and updated current.
    const current = { vi_btm: true, vo_coll: true, vi_top: false, vo_rad: false };
    const openSince = { vi_btm: 120000, vo_coll: 120000, vi_top: 0, vo_rad: 0 };
    const opening = {}; // window ended, caller cleared
    const now = 120000;
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.startOpening.length, 2);
    assert.deepStrictEqual(plan.startOpening.slice().sort(), ['vi_top', 'vo_rad']);
    assert.deepStrictEqual(plan.queuedOpens, []);
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 10: mid-transition target change — valve in opening but target now closes it → not in any action list, nextResumeAt includes its window end', () => {
    // vi_btm is mid-flight opening, but the new target says it should be closed.
    // Chosen behavior (b): scheduler does not add it to any action list; the
    // window will end naturally, the shell will record openSince[v], and on
    // the next resume it will be re-evaluated as a normal close candidate.
    const target = { vi_btm: false, vi_top: true };
    const current = { vi_btm: false, vi_top: false };
    const openSince = { vi_btm: 0, vi_top: 0 };
    const now = 100000;
    const opening = { vi_btm: now + 10000 };
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    // vi_btm: physically still closing→opening, but target says closed. Do
    // nothing — wait for the window to end.
    assert.ok(plan.closeNow.indexOf('vi_btm') === -1);
    assert.ok(plan.startOpening.indexOf('vi_btm') === -1);
    assert.ok(plan.queuedOpens.indexOf('vi_btm') === -1);
    assert.ok(!('vi_btm' in plan.deferredCloses));
    // vi_top can still open — one slot free (2 - 1 live = 1).
    assert.ok(plan.startOpening.indexOf('vi_top') > -1);
    // nextResumeAt includes the opening window of vi_btm.
    assert.strictEqual(plan.nextResumeAt, Math.min(now + 10000, now + VALVE_TIMING.openWindowMs));
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 14: nextResumeAt is the earliest of live opening windows and deferred closes', () => {
    const target = { vi_btm: true, vo_rad: false };
    const current = { vi_btm: false, vo_rad: true };
    // vo_rad was opened very recently; close is deferred. vi_btm will open now.
    const now = 100000;
    const openSince = { vi_btm: 0, vo_rad: now - 10000 }; // open for 10s → ready at now+50000
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.ok(plan.startOpening.indexOf('vi_btm') > -1);
    // Expected readyAt for vo_rad: openSince + 60000 = now - 10000 + 60000 = now + 50000
    assert.strictEqual(plan.deferredCloses.vo_rad, now + 50000);
    // Opening window of vi_btm ends at now + 20000. That's earlier than now + 50000.
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });
});

describe('planValveTransition — US3 min-open hold', () => {
  it('case 5: valve open 10s, needs to close → deferredCloses with readyAt = openSince + 60000', () => {
    const target = { vi_btm: false };
    const current = { vi_btm: true };
    const now = 100000;
    const openSince = { vi_btm: now - 10000 };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.closeNow, []);
    assert.strictEqual(plan.deferredCloses.vi_btm, (now - 10000) + 60000);
    assert.strictEqual(plan.nextResumeAt, (now - 10000) + 60000);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 6: valve open 70s, needs to close → closeNow', () => {
    const target = { vi_btm: false };
    const current = { vi_btm: true };
    const now = 100000;
    const openSince = { vi_btm: now - 70000 };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.closeNow, ['vi_btm']);
    assert.deepStrictEqual(plan.deferredCloses, {});
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('case 8: boot recovery — openSince[v]=0, target says closed → closeNow (trivially satisfied)', () => {
    const target = { vi_btm: false };
    const current = { vi_btm: true }; // first iteration after boot before closeAllValves took effect
    const now = 100000;
    const openSince = { vi_btm: 0 }; // R7 boot default
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.deepStrictEqual(plan.closeNow, ['vi_btm']);
    assert.deepStrictEqual(plan.deferredCloses, {});
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('mixed hold: two elders closeNow, youngster deferred, nextResumeAt = youngster.readyAt', () => {
    const target = { vi_btm: false, vi_top: false, vo_coll: false };
    const current = { vi_btm: true, vi_top: true, vo_coll: true };
    const now = 100000;
    const openSince = {
      vi_btm: now - 70000,   // elder
      vi_top: now - 70000,   // elder
      vo_coll: now - 10000   // youngster
    };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.closeNow.length, 2);
    assert.ok(plan.closeNow.indexOf('vi_btm') > -1);
    assert.ok(plan.closeNow.indexOf('vi_top') > -1);
    assert.strictEqual(plan.deferredCloses.vo_coll, (now - 10000) + 60000);
    assert.strictEqual(plan.nextResumeAt, (now - 10000) + 60000);
    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('INV3: no valve in closeNow has (now - openSince) < minOpenMs unless openSince === 0', () => {
    // Run case 6 and confirm INV3 explicitly (already covered by generic
    // assertInvariants but make it loud).
    const target = { vi_btm: false };
    const current = { vi_btm: true };
    const now = 100000;
    const openSince = { vi_btm: now - 70000 };
    const plan = planValveTransition(target, current, openSince, {}, now, VALVE_TIMING);
    for (const v of plan.closeNow) {
      const since = openSince[v] || 0;
      if (since !== 0) {
        assert.ok(now - since >= VALVE_TIMING.minOpenMs);
      }
    }
  });

  it('no-op: target[v] === current[v] does not consume a slot or change openSince', () => {
    const target = { vi_btm: true, vi_top: false };
    const current = { vi_btm: true, vi_top: false };
    const now = 100000;
    const openSince = { vi_btm: now - 30000, vi_top: 0 };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);
    assert.strictEqual(plan.targetReached, true);
    assert.deepStrictEqual(plan.startOpening, []);
    assert.deepStrictEqual(plan.closeNow, []);
  });

  it('fuzz: 1000 random configurations → invariants hold', () => {
    // Seeded PRNG (mulberry32) for reproducibility.
    let seed = 0x9e3779b9;
    function rnd() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    function randBool() { return rnd() > 0.5; }
    function randInt(lo, hi) { return Math.floor(lo + rnd() * (hi - lo)); }
    const cfg = VALVE_TIMING;

    for (let iter = 0; iter < 1000; iter++) {
      const target = {};
      const current = {};
      const openSince = {};
      const opening = {};
      const now = randInt(1000000, 10000000);
      let liveOpenCount = 0;
      for (const n of VALVE_NAMES) {
        target[n] = randBool();
        current[n] = randBool();
        // 50% chance: openSince is boot (0); else now - [0..2*minOpenMs]
        openSince[n] = randBool() ? 0 : now - randInt(0, 2 * cfg.minOpenMs);
        // Up to maxConcurrentOpens valves may be mid-flight (precondition
        // of the scheduler: INV1 in the contract refers to a reachable
        // state, and the shell never commands more than that many to open
        // at once). Past/expired windows are always allowed.
        if (rnd() < 0.35) {
          if (liveOpenCount < cfg.maxConcurrentOpens && rnd() < 0.5) {
            opening[n] = now + randInt(1, cfg.openWindowMs);
            liveOpenCount++;
          } else {
            opening[n] = now - randInt(0, cfg.openWindowMs); // already expired
          }
        }
      }
      const plan = planValveTransition(target, current, openSince, opening, now, cfg);
      assertInvariants(plan, { target, current, openSince, opening, now, cfg });
    }
  });
});

// Integration-style: drive the SCHEDULE loop across simulated time to
// verify the two-batch cadence required by SC-004 and the freeze-drain
// scenario from US4.
function drivePlanLoop(initial) {
  // Simulates exactly what the shell does in resumeTransition/scheduleStep:
  //  1. call planValveTransition(now)
  //  2. record live opening windows for startOpening entries
  //  3. update current to reflect closeNow + startOpening (after window end
  //     for opens, immediately for closes)
  //  4. advance now to plan.nextResumeAt
  //  5. expire any opening windows (write openSince = window end)
  //  6. repeat until plan.targetReached
  // Returns a trace array of {t, startOpening, closeNow, deferredCloses, opening}.
  const target = initial.target;
  const current = Object.assign({}, initial.current);
  const openSince = Object.assign({}, initial.openSince);
  const opening = Object.assign({}, initial.opening || {});
  const cfg = initial.cfg || VALVE_TIMING;
  let now = initial.now;
  const trace = [];
  const maxIters = 50;
  for (let iter = 0; iter < maxIters; iter++) {
    const plan = planValveTransition(target, current, openSince, opening, now, cfg);
    trace.push({
      t: now,
      startOpening: plan.startOpening.slice(),
      closeNow: plan.closeNow.slice(),
      deferredCloses: Object.assign({}, plan.deferredCloses),
      queuedOpens: plan.queuedOpens.slice(),
      opening: Object.assign({}, opening),
      current: Object.assign({}, current),
      targetReached: plan.targetReached,
    });
    if (plan.targetReached) break;
    // Apply closeNow immediately.
    for (const v of plan.closeNow) {
      current[v] = false;
      openSince[v] = 0;
    }
    // Schedule opens: record opening window. (current[v] stays false until
    // the window ends — this mirrors the shell's behavior where the open
    // command is in flight and the physical state flips at window end.)
    for (const v of plan.startOpening) {
      opening[v] = now + cfg.openWindowMs;
    }
    assertInvariants(plan, { target, current: trace[trace.length - 1].current, openSince, opening: trace[trace.length - 1].opening, now });
    // If the scheduler fired immediate actions but set nextResumeAt=null
    // (no future work waiting), the effect of those actions will be seen
    // on the next iteration without advancing the clock. Otherwise, jump
    // to the resume moment.
    if (plan.nextResumeAt !== null) {
      now = plan.nextResumeAt;
    }
    // Expire any opening windows at or before now; record openSince.
    const toExpire = [];
    for (const k in opening) {
      if (opening[k] <= now) toExpire.push(k);
    }
    for (const k of toExpire) {
      const windowEnd = opening[k];
      openSince[k] = windowEnd;
      current[k] = true; // physical state reaches open at window end
      delete opening[k];
    }
  }
  return trace;
}

describe('planValveTransition — SCHEDULE loop integration', () => {
  it('four closed valves all need to open → two batches within 45 s total', () => {
    const trace = drivePlanLoop({
      target: { vi_btm: true, vi_top: true, vo_coll: true, vo_rad: true },
      current: { vi_btm: false, vi_top: false, vo_coll: false, vo_rad: false },
      openSince: { vi_btm: 0, vi_top: 0, vo_coll: 0, vo_rad: 0 },
      opening: {},
      now: 1000000,
    });
    const lastFrame = trace[trace.length - 1];
    assert.strictEqual(lastFrame.targetReached, true, 'target reached');
    const wallClock = lastFrame.t - trace[0].t;
    assert.ok(wallClock <= 45000, `wall clock ${wallClock}ms > 45000ms`);
    assert.ok(wallClock >= 40000, `wall clock ${wallClock}ms < 40000ms (should take 2 × 20s)`);
    // Each frame must honor the slot budget.
    for (const f of trace) {
      let liveOpens = 0;
      for (const k in f.opening) if (f.opening[k] > f.t) liveOpens++;
      assert.ok(liveOpens + f.startOpening.length <= 2, `frame at t=${f.t}: live=${liveOpens} + starting=${f.startOpening.length} > 2`);
    }
    // Every valve ended up open.
    for (const v of ['vi_btm', 'vi_top', 'vo_coll', 'vo_rad']) {
      assert.strictEqual(lastFrame.current[v], true, `${v} not open at end`);
    }
  });

  it('freeze drain from mixed state: elders close immediately, youngsters defer, opens follow 2-at-a-time', () => {
    // Synthetic 3-valve mixed-age starting state (does not correspond to any
    // real mode after spec 024 — SOLAR_CHARGING now has only 2 open valves).
    // The point of this test is the scheduler's elder/youngster behaviour,
    // not the mode invariants. Starting with vi_btm + vo_coll + vo_rad open:
    // vi_btm and vo_coll are elders (open >60s), vo_rad is a youngster.
    // Target is ACTIVE_DRAIN: vi_coll + vo_tank + v_air logical-open
    // (scheduler-view v_air=false because of the polarity inversion).
    const oldOpenSince = 1000000 - 70000; // 70s ago → elders
    const youngOpenSince = 1000000 - 10000; // 10s ago → youngster
    const trace = drivePlanLoop({
      target: {
        vi_btm: false, vi_top: false, vi_coll: true,
        vo_coll: false, vo_rad: false, vo_tank: true,
        v_air: false // scheduler view: de-energized
      },
      current: {
        vi_btm: true, vi_top: false, vi_coll: false,
        vo_coll: true, vo_rad: true, vo_tank: false,
        v_air: false
      },
      openSince: {
        vi_btm: oldOpenSince, vi_top: 0, vi_coll: 0,
        vo_coll: oldOpenSince, vo_rad: youngOpenSince, vo_tank: 0,
        v_air: 0
      },
      opening: {},
      now: 1000000,
    });
    const lastFrame = trace[trace.length - 1];
    assert.strictEqual(lastFrame.targetReached, true, 'drain transition completed');

    // At no frame was the slot budget exceeded.
    for (const f of trace) {
      let liveOpens = 0;
      for (const k in f.opening) if (f.opening[k] > f.t) liveOpens++;
      assert.ok(liveOpens + f.startOpening.length <= 2);
    }

    // First frame: vi_btm + vo_coll in closeNow (elders), vo_rad in deferredCloses.
    const first = trace[0];
    assert.ok(first.closeNow.indexOf('vi_btm') > -1);
    assert.ok(first.closeNow.indexOf('vo_coll') > -1);
    assert.ok('vo_rad' in first.deferredCloses);
  });
});

describe('planValveTransition — US4 safety drain mix', () => {
  it('case 7: two valves closing with openSince=now-70s, one closing with openSince=now-10s, three opening', () => {
    // Safety override does not add any throttles — the same rules apply.
    // Synthetic target/current — not a real mode, exercises the scheduler's
    // 2-elder + 1-youngster close pattern combined with 3 simultaneous opens.
    const target = {
      vi_btm: false, vi_top: false, vo_rad: false,      // three to close
      vo_coll: true, vo_tank: true, vi_coll: true       // three to open
    };
    const current = {
      vi_btm: true, vi_top: true, vo_rad: true,
      vo_coll: false, vo_tank: false, vi_coll: false
    };
    const now = 200000;
    const openSince = {
      vi_btm: now - 70000,   // elder → closeNow
      vi_top: now - 70000,   // elder → closeNow
      vo_rad: now - 10000,   // youngster → deferredCloses
      vo_coll: 0, vo_tank: 0, vi_coll: 0
    };
    const opening = {};
    const plan = planValveTransition(target, current, openSince, opening, now, VALVE_TIMING);

    assert.strictEqual(plan.closeNow.length, 2);
    assert.ok(plan.closeNow.indexOf('vi_btm') > -1);
    assert.ok(plan.closeNow.indexOf('vi_top') > -1);
    assert.strictEqual(plan.deferredCloses.vo_rad, (now - 10000) + 60000);

    // Slot budget on opens: exactly two this tick.
    assert.strictEqual(plan.startOpening.length, 2);
    assert.strictEqual(plan.queuedOpens.length, 1);

    // nextResumeAt = min(opening window end of two new opens = now+20000,
    //                   deferred close ready = now+50000)
    //              = now + 20000
    assert.strictEqual(plan.nextResumeAt, now + VALVE_TIMING.openWindowMs);

    assertInvariants(plan, { target, current, openSince, opening, now });
  });

  it('freeze drain: evaluate() returns safetyOverride immediately regardless of mode age', () => {
    // Locks in that evaluate() bypasses min-mode-duration for freeze. The
    // downstream SCHEDULE path still honors physical limits, verified in
    // unit tests above.
    const state = {
      temps: { collector: 0, tank_top: 30, tank_bottom: 20, greenhouse: 15, outdoor: 1 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 1000, // just 1 second ago → would normally be blocked
      now: 1001,
      collectorsDrained: false,
      lastRefillAttempt: 0,
      emergencyHeatingActive: false,
      sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
    };
    const result = evaluate(state, null, null);
    assert.strictEqual(result.safetyOverride, true);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});

describe('runBoundedPool — bounded parallelism (T050b)', () => {
  it('actuating 8 items with limit=4: never more than 4 in flight', (t, done) => {
    const inFlightHistory = [];
    let inFlight = 0;
    const pending = [];
    const dispatch = (item, cb) => {
      inFlight++;
      inFlightHistory.push(inFlight);
      assert.ok(inFlight <= 4, `inFlight=${inFlight} exceeded limit=4 for item ${item}`);
      // Defer completion to simulate async HTTP.
      pending.push(() => { inFlight--; cb(true); });
    };
    runBoundedPool([1, 2, 3, 4, 5, 6, 7, 8], 4, dispatch, (ok) => {
      assert.strictEqual(ok, true);
      done();
    });
    // Flush pending dispatches in FIFO order.
    function flush() {
      while (pending.length > 0) {
        const step = pending.shift();
        step();
      }
    }
    // Two waves because items 5-8 get dispatched only after items 1-4 complete.
    flush();
    flush();
  });

  it('empty input → callback invoked with true immediately', (t, done) => {
    runBoundedPool([], 4, () => { throw new Error('should not dispatch'); }, (ok) => {
      assert.strictEqual(ok, true);
      done();
    });
  });

  it('one failure → final callback ok=false', (t, done) => {
    const dispatch = (item, cb) => cb(item !== 3);
    runBoundedPool([1, 2, 3, 4], 2, dispatch, (ok) => {
      assert.strictEqual(ok, false);
      done();
    });
  });

  it('synchronous completion: limit=1 acts like sequential execution', (t, done) => {
    const order = [];
    const dispatch = (item, cb) => { order.push(item); cb(true); };
    runBoundedPool([1, 2, 3, 4, 5], 1, dispatch, (ok) => {
      assert.deepStrictEqual(order, [1, 2, 3, 4, 5]);
      done();
    });
  });
});

describe('buildSnapshotFromState — US5 staged-transition fields', () => {
  function baseShellState() {
    return {
      mode: MODES.IDLE,
      mode_start: 0,
      transitioning: false,
      transition_step: null,
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      valve_states: {},
      pump_on: false, fan_on: false, space_heater_on: false, immersion_heater_on: false,
      collectors_drained: false, emergency_heating_active: false,
      valveOpenSince: {}, valveOpening: {},
      valvePendingOpen: [], valvePendingClose: []
    };
  }
  const baseDc = { ce: true, ea: 31, fm: null, am: null, v: 1 };

  it('idle state: opening/queued_opens/pending_closes are empty', () => {
    const snap = buildSnapshotFromState(baseShellState(), baseDc, 1000000);
    assert.deepStrictEqual(snap.opening, []);
    assert.deepStrictEqual(snap.queued_opens, []);
    assert.deepStrictEqual(snap.pending_closes, []);
  });

  it('mid-transition: two opening, one queued, one pending close', () => {
    const st = baseShellState();
    const now = 1000000;
    st.transitioning = true;
    st.transition_step = 'valves_opening';
    st.valveOpening = { vi_btm: now + 10000, vo_coll: now + 15000 };
    st.valvePendingOpen = ['vi_top'];
    st.valvePendingClose = ['vo_rad'];
    st.valveOpenSince = { vo_rad: now - 30000 }; // open 30s → ready at now+30s
    const snap = buildSnapshotFromState(st, baseDc, now);
    assert.deepStrictEqual(snap.opening.slice().sort(), ['vi_btm', 'vo_coll']);
    assert.deepStrictEqual(snap.queued_opens, ['vi_top']);
    assert.strictEqual(snap.pending_closes.length, 1);
    assert.strictEqual(snap.pending_closes[0].valve, 'vo_rad');
    // readyAt is unix seconds.
    assert.strictEqual(snap.pending_closes[0].readyAt, Math.floor((now - 30000 + 60000) / 1000));
  });

  it('expired opening entries are excluded from opening[]', () => {
    const st = baseShellState();
    const now = 1000000;
    st.valveOpening = { vi_btm: now - 100 }; // expired
    const snap = buildSnapshotFromState(st, baseDc, now);
    assert.deepStrictEqual(snap.opening, []);
  });

  it('preserves existing snapshot fields (ts, mode, valves, actuators)', () => {
    const st = baseShellState();
    st.mode = MODES.SOLAR_CHARGING;
    st.valve_states = { vi_btm: true, vo_coll: true };
    st.pump_on = true;
    const snap = buildSnapshotFromState(st, baseDc, 1234567);
    assert.strictEqual(snap.ts, 1234567);
    assert.strictEqual(snap.mode, 'solar_charging');
    assert.strictEqual(snap.valves.vi_btm, true);
    assert.strictEqual(snap.valves.vo_coll, true);
    assert.strictEqual(snap.valves.vi_top, false);
    assert.strictEqual(snap.actuators.pump, true);
  });
});

describe('toSchedulerView / fromSchedulerView polarity helpers', () => {
  it('round-trip is identity for every 7-valve combination', () => {
    // 2^7 = 128 combinations.
    const combos = 1 << VALVE_NAMES.length;
    for (let mask = 0; mask < combos; mask++) {
      const m = {};
      for (let i = 0; i < VALVE_NAMES.length; i++) {
        m[VALVE_NAMES[i]] = ((mask >> i) & 1) === 1;
      }
      assert.deepStrictEqual(fromSchedulerView(toSchedulerView(m)), m);
    }
  });

  it('v_air is inverted, all others are identity', () => {
    const logical = {
      vi_btm: true, vi_top: false, vi_coll: true, vo_coll: false,
      vo_rad: true, vo_tank: false, v_air: false
    };
    const scheduler = toSchedulerView(logical);
    assert.strictEqual(scheduler.vi_btm, true);
    assert.strictEqual(scheduler.vi_top, false);
    assert.strictEqual(scheduler.vi_coll, true);
    assert.strictEqual(scheduler.vo_coll, false);
    assert.strictEqual(scheduler.vo_rad, true);
    assert.strictEqual(scheduler.vo_tank, false);
    assert.strictEqual(scheduler.v_air, true); // inverted

    const flipped = toSchedulerView({ v_air: true });
    assert.strictEqual(flipped.v_air, false);
  });

  it('handles null/undefined as passthrough', () => {
    assert.strictEqual(toSchedulerView(null), null);
    assert.strictEqual(toSchedulerView(undefined), undefined);
  });
});
