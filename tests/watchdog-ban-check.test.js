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

  // Field bug 2026-05-02: greenhouse_heating disabled (wb.GH=sentinel),
  // greenhouse fell to 4 °C overnight. Emergency heating sat dormant for
  // hours despite the operator never disabling it (wb.EH unset). Root
  // cause: the greenhouse-heating pump-mode block at control-logic.js
  // 508-527 picks GREENHOUSE_HEATING without consulting wb.GH. The
  // emergency overlay then sees pumpMode != IDLE and only stamps the
  // space_heater overlay onto a GH result. The natural-mode ban check
  // at 584-590 rebuilds the result as IDLE and the rebuild discards the
  // overlay actuator. Net: cold greenhouse, EH not banned, no heat.
  it('emergency overlay fires under wb.GH ban with warm tank and cold greenhouse', () => {
    // greenhouse 4 °C is well below emergencyEnterTemp (9). tank_top 37
    // is well above greenhouse + greenhouseMinTankDelta (4 + 5 = 9), so
    // the GH pump-mode block would otherwise pick GREENHOUSE_HEATING.
    const state = makeState({
      temps: { collector: 0, tank_top: 37, tank_bottom: 30, greenhouse: 4, outdoor: 5 },
      collectorsDrained: true,
    });
    const cfg = { ce: true, ea: 31, wb: { GH: 9999999999 } };
    const result = evaluate(state, null, cfg);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING,
      'GH banned → pumpMode must stay IDLE → emergency overlay returns EMERGENCY_HEATING');
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
    assert.strictEqual(result.actuators.space_heater, true,
      'space heater must be on whenever EH flag is set and EH is not banned');
  });

  // Same bug shape, fan-cool overlay variant. greenhouse 32 °C with
  // GH banned: GH pump-mode logic does not fire (greenhouse not cold)
  // so fan-cool already worked here, but we lock in the invariant.
  // The more interesting case is when SC is banned during a hot day.
  it('fan-cool overlay fires under wb.SC ban with hot collector and hot greenhouse', () => {
    // collector 60 > tank_bottom + 3 → SC physics fires; banned via wb.
    // greenhouse 32 ≥ greenhouseFanCoolEnter (30) → overlay should run.
    const state = makeState({
      temps: { collector: 60, tank_top: 40, tank_bottom: 30, greenhouse: 32, outdoor: 25 },
    });
    const cfg = { ce: true, ea: 31, wb: { SC: 9999999999 } };
    const result = evaluate(state, null, cfg);
    assert.strictEqual(result.nextMode, MODES.IDLE,
      'SC banned → falls back to IDLE');
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true);
    assert.strictEqual(result.actuators.fan, true,
      'fan-cool overlay must survive the ban-induced IDLE rebuild');
  });

  // Companion: confirm the natural pump path still chooses the banned
  // mode's reason code and not "mode_disabled" when an overlay covers
  // for it. The reason field drives the System Logs UI; we want it to
  // read "emergency_enter" so the operator sees what's actually
  // happening, not "mode_disabled" which would imply nothing is doing.
  it('emergency overlay under wb.GH ban reports emergency_enter, not mode_disabled', () => {
    const state = makeState({
      temps: { collector: 0, tank_top: 37, tank_bottom: 30, greenhouse: 4, outdoor: 5 },
      collectorsDrained: true,
    });
    const cfg = { ce: true, ea: 31, wb: { GH: 9999999999 } };
    const result = evaluate(state, null, cfg);
    assert.strictEqual(result.reason, 'emergency_enter');
  });
});
