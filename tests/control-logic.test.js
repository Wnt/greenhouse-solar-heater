const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES, DEFAULT_CONFIG } = require('../scripts/control-logic.js');

function makeState(overrides) {
  const base = {
    temps: {
      collector: 20, tank_top: 40, tank_bottom: 30,
      greenhouse: 15, outdoor: 10
    },
    currentMode: MODES.IDLE,
    modeEnteredAt: 0,
    now: 1000,
    collectorsDrained: false,
    lastRefillAttempt: 0,
    sensorAge: {
      collector: 0, tank_top: 0, tank_bottom: 0,
      greenhouse: 0, outdoor: 0
    }
  };
  return Object.assign({}, base, overrides);
}

describe('mode evaluation', () => {
  it('returns IDLE when no triggers are active', () => {
    const result = evaluate(makeState({}), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  // TODO: each mode entered when trigger conditions met
  // TODO: correct mode selected when multiple triggers (priority order)
});

describe('hysteresis', () => {
  it('enters solar charging at collector > tank_bottom + 7', () => {
    const result = evaluate(makeState({
      temps: { collector: 40, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  // TODO: solar exit threshold
  // TODO: greenhouse heating enter/exit
  // TODO: emergency enter/exit
});

describe('minimum duration', () => {
  // TODO: mode held for minimum time
  // TODO: ACTIVE_DRAIN preempts regardless of minimum
  // TODO: minimum run time after speculative refill
});

describe('valve and actuator mapping', () => {
  it('IDLE has all valves closed and actuators off', () => {
    const result = evaluate(makeState({}), null);
    for (const v of Object.values(result.valves)) {
      assert.strictEqual(v, false);
    }
    for (const a of Object.values(result.actuators)) {
      assert.strictEqual(a, false);
    }
  });

  // TODO: each mode produces correct valve/actuator states
  // TODO: one-input-one-output invariant
});

describe('priority and preemption', () => {
  // TODO: ACTIVE_DRAIN preempts SOLAR_CHARGING
  // TODO: EMERGENCY preempts GREENHOUSE_HEATING
  // TODO: concurrent solar + greenhouse → heating wins
});

describe('speculative refill', () => {
  // TODO: refill attempted when conditions met
  // TODO: retry cooldown respected
  // TODO: lastRefillAttempt updated
});

describe('sensor failure', () => {
  it('transitions to IDLE when sensors are stale', () => {
    const result = evaluate(makeState({
      currentMode: MODES.SOLAR_CHARGING,
      sensorAge: {
        collector: 200, tank_top: 0, tank_bottom: 0,
        greenhouse: 0, outdoor: 0
      }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  // TODO: all sensors stale simultaneously
});

describe('edge cases', () => {
  // TODO: overheat during active charging → active drain
  // TODO: boot during freezing conditions
});
