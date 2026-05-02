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

// Repurposes the radiator fan as an air-circulation overlay when the
// greenhouse gets hot. Independent of pump mode. Hysteresis: enter at
// >= 30 °C, exit at <= 28 °C.

describe('greenhouse fan cooling overlay', () => {
  it('activates fan when greenhouse rises to enter threshold (30 °C)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 30, outdoor: 20 },
    }), null);
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true);
    assert.strictEqual(result.actuators.fan, true);
  });

  it('does NOT activate just below enter threshold (29.9 °C)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 29.9, outdoor: 20 },
    }), null);
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, false);
    assert.strictEqual(result.actuators.fan, false);
  });

  it('stays on via hysteresis between 28 °C and 30 °C', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 29, outdoor: 20 },
      greenhouseFanCoolingActive: true,
    }), null);
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true);
    assert.strictEqual(result.actuators.fan, true);
  });

  it('deactivates when greenhouse drops to exit threshold (28 °C)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 28, outdoor: 20 },
      greenhouseFanCoolingActive: true,
    }), null);
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, false);
    assert.strictEqual(result.actuators.fan, false);
  });

  it('overlay applies on top of IDLE pump mode (fan-only operation)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 32, outdoor: 20 },
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.actuators.pump, false);
    assert.strictEqual(result.actuators.fan, true);
  });

  it('overlay applies on top of SOLAR_CHARGING (fan + pump)', () => {
    const result = evaluate(makeState({
      temps: { collector: 60, tank_top: 40, tank_bottom: 30, greenhouse: 31, outdoor: 25 },
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.actuators.pump, true);
    assert.strictEqual(result.actuators.fan, true);
  });

  // Overlays (fan-cool + space heater) are fully independent of pump
  // mode and run on every tick, including during drain. The fan and
  // heater are physically separate from the drain plumbing (drain
  // uses pump+valves), so there's no conflict. Detailed coverage of
  // the heater overlay across all 4 drain paths is in the
  // "overlays are independent of pump mode" describe block in
  // control-logic.test.js.
  it('overlay runs during ACTIVE_DRAIN (overlays are independent of pump mode)', () => {
    const result = evaluate(makeState({
      temps: { collector: 1, tank_top: 40, tank_bottom: 30, greenhouse: 35, outdoor: 1 },
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.actuators.fan, true);
  });

  it('clears the cooling flag on sensor staleness', () => {
    const result = evaluate(makeState({
      greenhouseFanCoolingActive: true,
      sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 200, outdoor: 0 },
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, false);
    assert.strictEqual(result.actuators.fan, false);
  });

  // ea = EA_VALVES | EA_PUMP | EA_SPACE_HEATER | EA_IMMERSION = 1+2+8+16 = 27
  // (EA_FAN = 4 omitted) — comfort overlay must respect the user's mask.
  it('respects EA_FAN device-config bit (fan disabled in config)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 32, outdoor: 20 },
    }), null, { ce: true, ea: 27, v: 1 });
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true,
      'hysteresis still tracks intent');
    assert.strictEqual(result.actuators.fan, false,
      'fan masked off by EA_FAN');
  });

  it('null greenhouse sensor leaves the cooling flag untouched', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: null, outdoor: 20 },
      greenhouseFanCoolingActive: true,
    }), null);
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true);
  });
});
