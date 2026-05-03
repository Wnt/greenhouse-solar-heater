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
    sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 },
  };
  return Object.assign({}, base, overrides);
}

const PERMANENT = 9999999999;
const allEnabled = { ce: true, ea: 31, v: 1 };

// `held` is the live diagnostic field on the evaluator result. It captures
// the gap between "the evaluator's preferred decision" and "the decision it
// returns" because of a guard. Three independent sub-fields:
//   pumpMode        — main pump+valve decision held back
//   emergencyHeating — heater overlay held back
//   fanCooling      — fan overlay held back
// Each is null/absent when nothing is being held; the parent `held` is
// null when all three sub-fields are null. This way the playground can
// surface "would enter X — held by Y, Zm remaining" without having to
// re-derive intent from a snapshot.

describe('held field — pump mode', () => {
  it('is null when the evaluator returns the obvious choice with no guards firing', () => {
    const result = evaluate(makeState({}), null, allEnabled);
    assert.strictEqual(result.held, null);
  });

  it('captures refill_cooldown when SC refill is wanted but cooldown blocks it', () => {
    // Drained collectors + favorable delta + warm outdoor. Cooldown
    // not yet elapsed (lastRefillAttempt 500 + 1800 = 2300 > now 1000).
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      collectorsDrained: true,
      lastRefillAttempt: 500,
      now: 1000,
    }), null, allEnabled);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.ok(result.held && result.held.pumpMode, 'pumpMode held expected');
    assert.strictEqual(result.held.pumpMode.wanted, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.held.pumpMode.wantedReason, 'solar_refill');
    assert.strictEqual(result.held.pumpMode.blockedBy, 'refill_cooldown');
    assert.strictEqual(result.held.pumpMode.until, 500 + 1800);
  });

  it('captures freeze_guard when SC refill is wanted but collector is still cold', () => {
    // Drained + delta met by tank_btm; collector itself below freezeDrainTemp.
    const result = evaluate(makeState({
      temps: { collector: 1, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 8 },
      collectorsDrained: true,
      lastRefillAttempt: 0,
      now: 5000,
    }), null, allEnabled);
    // collector(1) < tank_bottom(30) + 3 → delta NOT met → no held (held only
    // fires when there IS a wanted action). The bouncy-collector edge case
    // is the next test.
    assert.strictEqual(result.held, null);
  });

  it('captures freeze_guard when delta IS met but collector hasn’t passed the freeze bar', () => {
    // Delta met (collector > tank_btm + 3) AND outdoor warm, but collector
    // still below freezeDrainTemp (4 °C). This is the morning case where
    // the radiative-cooled collector starts heating but is briefly above
    // tank yet still below freezing risk.
    const result = evaluate(makeState({
      temps: { collector: 3.5, tank_top: 0, tank_bottom: 0, greenhouse: 15, outdoor: 8 },
      collectorsDrained: true,
      lastRefillAttempt: 0,
      now: 5000,
    }), null, allEnabled);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.ok(result.held && result.held.pumpMode);
    assert.strictEqual(result.held.pumpMode.wanted, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.held.pumpMode.wantedReason, 'solar_refill');
    assert.strictEqual(result.held.pumpMode.blockedBy, 'freeze_guard');
    assert.strictEqual(result.held.pumpMode.until, undefined,
      'freeze_guard is not time-bounded');
  });

  it('captures wb_ban with until when SC is banned by a 4-h cool-off', () => {
    // Collector 41 vs tank_btm 30 → SC is the natural pump mode.
    // wb.SC is set to a future timestamp → collapse to IDLE.
    const banUntil = 5000;
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      now: 2000,
    }), null, { ...allEnabled, wb: { SC: banUntil } });
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.ok(result.held && result.held.pumpMode);
    assert.strictEqual(result.held.pumpMode.wanted, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.held.pumpMode.blockedBy, 'wb_ban');
    assert.strictEqual(result.held.pumpMode.until, banUntil);
  });

  it('captures wb_ban without until when the mode is permanently disabled', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      now: 2000,
    }), null, { ...allEnabled, wb: { SC: PERMANENT } });
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.ok(result.held && result.held.pumpMode);
    assert.strictEqual(result.held.pumpMode.wanted, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.held.pumpMode.blockedBy, 'wb_ban');
    assert.strictEqual(result.held.pumpMode.until, undefined);
  });

  it('captures min_duration with until when current mode is held by the 5-min lock', () => {
    // GREENHOUSE_HEATING entered 60 s ago; minModeDuration = 300 s. Hold
    // is active. Greenhouse is now warm enough to exit, but the hold
    // keeps us in GH for another 240 s.
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 1940,
      now: 2000,
    }), null, allEnabled);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(result.reason, 'min_duration');
    assert.ok(result.held && result.held.pumpMode);
    assert.strictEqual(result.held.pumpMode.blockedBy, 'min_duration');
    assert.strictEqual(result.held.pumpMode.until, 1940 + 300);
  });
});

describe('held field — emergency heating overlay', () => {
  it('is null when EH is wanted and allowed (overlay is firing)', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: 5 },
      collectorsDrained: true,
    }), null, allEnabled);
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
    assert.ok(!result.held || !result.held.emergencyHeating,
      'no held entry when overlay is actually on');
  });

  it('captures wb_ban when wb.EH suppresses a wanted EH overlay', () => {
    // Greenhouse 4 °C → hysteresis would set EH on. wb.EH ban suppresses it.
    const banUntil = 9000;
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 5 },
      now: 2000,
    }), null, { ...allEnabled, wb: { EH: banUntil } });
    assert.strictEqual(result.flags.emergencyHeatingActive, false);
    assert.strictEqual(result.actuators.space_heater, false);
    assert.ok(result.held && result.held.emergencyHeating);
    assert.strictEqual(result.held.emergencyHeating.wanted, true);
    assert.strictEqual(result.held.emergencyHeating.blockedBy, 'wb_ban');
    assert.strictEqual(result.held.emergencyHeating.until, banUntil);
  });

  it('captures ea_mask when EA_SPACE_HEATER bit is off', () => {
    // ea = 1+2+4+16 = 23 (everything except space heater)
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 5 },
    }), null, { ce: true, ea: 23, v: 1 });
    // hysteresis still runs — flag is on, but the actuator is masked off
    // by the EA bit at the control.js layer. evaluate() reports the held
    // signal so the UI can warn "heater would fire but EA bit is clear".
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
    assert.ok(result.held && result.held.emergencyHeating);
    assert.strictEqual(result.held.emergencyHeating.blockedBy, 'ea_mask');
  });
});

describe('held field — fan cooling overlay', () => {
  it('is null when fan cooling is wanted and allowed', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 32, outdoor: 20 },
    }), null, allEnabled);
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true);
    assert.strictEqual(result.actuators.fan, true);
    assert.ok(!result.held || !result.held.fanCooling);
  });

  it('captures controls_disabled when ce=false', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 32, outdoor: 20 },
    }), null, { ce: false, ea: 31, v: 1 });
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true);
    assert.strictEqual(result.actuators.fan, false);
    assert.ok(result.held && result.held.fanCooling);
    assert.strictEqual(result.held.fanCooling.wanted, true);
    assert.strictEqual(result.held.fanCooling.blockedBy, 'controls_disabled');
  });

  it('captures ea_mask when EA_FAN bit is off', () => {
    // ea = 1+2+8+16 = 27 (everything except fan)
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 32, outdoor: 20 },
    }), null, { ce: true, ea: 27, v: 1 });
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true);
    assert.strictEqual(result.actuators.fan, false);
    assert.ok(result.held && result.held.fanCooling);
    assert.strictEqual(result.held.fanCooling.blockedBy, 'ea_mask');
  });
});

describe('held field — composite cases', () => {
  it('returns held with both pumpMode and overlay sub-fields when multiple guards fire', () => {
    // wb bans both SC and EH. Greenhouse cold + warm collector → both
    // pump-mode (SC) and overlay (EH) would activate; both are blocked.
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 5 },
      now: 2000,
    }), null, { ...allEnabled, wb: { SC: PERMANENT, EH: PERMANENT } });
    assert.ok(result.held);
    assert.ok(result.held.pumpMode, 'pumpMode held');
    assert.strictEqual(result.held.pumpMode.wanted, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.held.pumpMode.blockedBy, 'wb_ban');
    assert.ok(result.held.emergencyHeating, 'emergencyHeating held');
    assert.strictEqual(result.held.emergencyHeating.blockedBy, 'wb_ban');
  });

  it('omits sub-fields that are not held', () => {
    // Only pumpMode is held (refill cooldown). Overlays are quiet.
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      collectorsDrained: true,
      lastRefillAttempt: 500,
      now: 1000,
    }), null, allEnabled);
    assert.ok(result.held);
    assert.ok(result.held.pumpMode);
    assert.strictEqual(result.held.emergencyHeating, undefined);
    assert.strictEqual(result.held.fanCooling, undefined);
  });
});
