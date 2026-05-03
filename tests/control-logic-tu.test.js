// Tuning (`tu`) overrides — extracted from control-logic.test.js to
// keep that file under the 1200-line file-size cap. Same shape: pure
// evaluator tests against deviceConfig.tu.

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES } = require('../shelly/control-logic.js');

function makeState(overrides) {
  const base = {
    temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    currentMode: MODES.IDLE,
    modeEnteredAt: 0,
    now: 2000,
    collectorsDrained: false,
    lastRefillAttempt: 0,
    emergencyHeatingActive: false,
    greenhouseFanCoolingActive: false,
    sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
  };
  return Object.assign({}, base, overrides);
}

describe('tu (tuning) overrides via deviceConfig', () => {
  // Default greenhouseEnterTemp = 10. With tu.geT = 12, greenhouse
  // heating should fire at 11 °C (which would not have triggered with
  // the default).
  it('cfg.tu.geT raises the greenhouse-heating enter threshold', () => {
    const noTu = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 11, outdoor: 10 }
    }), null, {});
    assert.strictEqual(noTu.nextMode, MODES.IDLE);

    const withTu = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 11, outdoor: 10 }
    }), null, { tu: { geT: 12 } });
    assert.strictEqual(withTu.nextMode, MODES.GREENHOUSE_HEATING);
  });

  // Default freezeDrainTemp = 4. With tu.frT = 2, outdoor 3 °C must
  // NOT trigger drain anymore.
  it('cfg.tu.frT lowers the freeze-drain threshold', () => {
    const noTu = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 3 }
    }), null);
    assert.strictEqual(noTu.nextMode, MODES.ACTIVE_DRAIN);

    const withTu = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 3 }
    }), null, { tu: { frT: 2 } });
    assert.strictEqual(withTu.nextMode, MODES.IDLE);
  });

  // Default emergencyEnterTemp = 9. With tu.ehE = 11 the heater
  // overlay must engage when greenhouse is 10 (where the default
  // would NOT have triggered).
  it('cfg.tu.ehE raises the emergency-heater enter threshold', () => {
    const noTu = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 10, outdoor: -5 },
      collectorsDrained: true
    }), null, {});
    assert.strictEqual(noTu.flags.emergencyHeatingActive, false);

    const withTu = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 10, outdoor: -5 },
      collectorsDrained: true
    }), null, { tu: { ehE: 11 } });
    assert.strictEqual(withTu.flags.emergencyHeatingActive, true);
  });

  // greenhouseMinTankDelta default = 5 K. With tu.gmD = 10 the tank
  // must be 10 K hotter than the greenhouse to start heating; an 8 K
  // delta that would trigger by default no longer does.
  it('cfg.tu.gmD raises the greenhouse-heat entry tank-delta requirement', () => {
    // greenhouse=9 (< default geT 10), tank_top=17 → 8 K delta.
    const noTu = evaluate(makeState({
      temps: { collector: 5, tank_top: 17, tank_bottom: 12, greenhouse: 9, outdoor: 5 }
    }), null, {});
    assert.strictEqual(noTu.nextMode, MODES.GREENHOUSE_HEATING);

    const withTu = evaluate(makeState({
      temps: { collector: 5, tank_top: 17, tank_bottom: 12, greenhouse: 9, outdoor: 5 }
    }), null, { tu: { gmD: 10 } });
    assert.notStrictEqual(withTu.nextMode, MODES.GREENHOUSE_HEATING);
  });

  // greenhouseExitTankDelta default = 2 K. With tu.gxD = 5 K, an
  // already-running heating session must abort sooner: tank only 3 K
  // above greenhouse no longer meets the keep-going threshold.
  it('cfg.tu.gxD tightens the keep-going tank-delta requirement', () => {
    // Greenhouse 11 (still ≤ default gxT 12 so the heat-exit branch
    // doesn't fire), tank_top 14 → 3 K delta. Default keeps heating;
    // with gxD = 5 the keep-going branch fails and we exit.
    const baseState = {
      temps: { collector: 5, tank_top: 14, tank_bottom: 12, greenhouse: 11, outdoor: 5 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0,
      now: 5000  // > minModeDuration (300 s) so we're past the hold
    };
    const noTu = evaluate(makeState(baseState), null, {});
    assert.strictEqual(noTu.nextMode, MODES.GREENHOUSE_HEATING);

    const withTu = evaluate(makeState(baseState), null, { tu: { gxD: 5 } });
    assert.notStrictEqual(withTu.nextMode, MODES.GREENHOUSE_HEATING);
  });

  // Sparse tu — keys omitted MUST fall back to DEFAULT_CONFIG. Setting
  // only fcE leaves freeze, overheat, greenhouse heating untouched.
  it('keys omitted from tu fall back to DEFAULT_CONFIG', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 3 }
    }), null, { tu: { fcE: 35 } });
    // freeze drain still fires at outdoor=3 because frT default = 4
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.reason, 'freeze_drain');
  });
});
