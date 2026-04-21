const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES } = require('../shelly/control-logic.js');

function makeState(overrides) {
  const base = {
    // Solar-charging physics trigger (collector > tank_bottom + 10)
    temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
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

describe('wb ban check in evaluate', () => {
  it('allows mode when no wb entry', () => {
    const cfg = { ce: true, ea: 31 };
    const result = evaluate(makeState({}), null, cfg);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('blocks SOLAR_CHARGING when wb.SC > now', () => {
    const cfg = { ce: true, ea: 31, wb: { SC: 3000 } };
    const result = evaluate(makeState({}), null, cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('allows mode when wb entry is in the past (stale — real prune happens on device)', () => {
    const cfg = { ce: true, ea: 31, wb: { SC: 1000 } };
    const result = evaluate(makeState({}), null, cfg);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('blocks GREENHOUSE_HEATING when wb.GH > now', () => {
    // GH physics: greenhouse < 10 and tank_top > greenhouse + 5
    const state = makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    });
    const cfg = { ce: true, ea: 31, wb: { GH: 3000 } };
    const result = evaluate(state, null, cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('treats permanent sentinel 9999999999 as banned', () => {
    const cfg = { ce: true, ea: 31, wb: { SC: 9999999999 } };
    const result = evaluate(makeState({}), null, cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('active manual override does NOT bypass wb ban at the pure-evaluate level', () => {
    // evaluate() is I/O-layer agnostic: it doesn't treat mo as a
    // bypass of wb bans, because wb bans and override live in
    // different conceptual layers. The I/O layer (controlLoop)
    // short-circuits on mo.a anyway, so evaluate()'s verdict here
    // only matters if mo is cleared mid-tick — and then wb MUST
    // still hold.
    const cfg = {
      ce: true, ea: 31,
      wb: { SC: 3000 },
      mo: { a: true, fm: 'I', ex: 9999999999 }
    };
    const result = evaluate(makeState({}), null, cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });
});
