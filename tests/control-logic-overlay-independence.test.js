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

// Both overlays (space heater + fan-cool) are fully independent of
// pump mode. They run hysteresis on every tick and stamp their
// actuators onto whatever the pump mode picked, including:
//   - drain modes (freeze/overheat/drain-running/drain-timeout) — these
//     are physically separate (drain uses pump+valves; overlays drive
//     the heater relay and the radiator fan), so there's no conflict
//   - min-duration hold — the overlay decision is per-tick, not
//     locked in alongside the pump mode
//
// 2026-05-02 field bug: greenhouse hit 4 °C during freeze drain and
// the space heater stayed off for the full ~5 min drain window.
// Plants are most at risk in exactly that weather, so the heater
// must overlay even on safety-override drain modes.
describe('overlays are independent of pump mode (drain + min-duration)', () => {
  it('emergency overlay fires during freeze_drain', () => {
    // outdoor 1 °C → freeze_drain triggers; greenhouse 4 °C → emergency.
    const result = evaluate(makeState({
      temps: { collector: 1, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 1 },
      collectorsDrained: false,
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.reason, 'freeze_drain');
    assert.strictEqual(result.actuators.space_heater, true,
      'Heater must overlay during freeze_drain — greenhouse is critically cold');
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
  });

  it('emergency overlay fires during overheat_drain', () => {
    // collector 96 + currentMode = SOLAR_CHARGING + collectors not drained
    // → overheat_drain. greenhouse 8 → emergency.
    const result = evaluate(makeState({
      temps: { collector: 96, tank_top: 86, tank_bottom: 70, greenhouse: 8, outdoor: 25 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000,
      collectorsDrained: false,
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.reason, 'overheat_drain');
    assert.strictEqual(result.actuators.space_heater, true);
  });

  it('emergency overlay fires during drain_running (already in ACTIVE_DRAIN)', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 5 },
      currentMode: MODES.ACTIVE_DRAIN,
      modeEnteredAt: 0, now: 100,
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.reason, 'drain_running');
    assert.strictEqual(result.actuators.space_heater, true);
  });

  it('emergency overlay fires during drain_timeout', () => {
    // currentMode ACTIVE_DRAIN, elapsed > drainTimeout (600s) → IDLE
    // with reason "drain_timeout". Greenhouse 4 °C → emergency.
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 5 },
      currentMode: MODES.ACTIVE_DRAIN,
      modeEnteredAt: 0, now: 700,
      collectorsDrained: false,
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.reason, 'drain_timeout');
    assert.strictEqual(result.actuators.space_heater, true);
    assert.strictEqual(result.flags.collectorsDrained, true,
      'drain_timeout must still mark collectors as drained');
  });

  it('fan-cool overlay fires during freeze_drain (symmetry — overlays are overlays)', () => {
    // Contrived: greenhouse 32 °C while outdoor crashes to 1 °C. Possible
    // on a sunny morning after a frosty night; drain triggers off
    // outdoor, fan-cool triggers off greenhouse. Both should run.
    const result = evaluate(makeState({
      temps: { collector: 1, tank_top: 30, tank_bottom: 25, greenhouse: 32, outdoor: 1 },
      collectorsDrained: false,
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.actuators.fan, true,
      'Fan-cool overlay must run during drain — same independence as the heater');
    assert.strictEqual(result.flags.greenhouseFanCoolingActive, true);
  });

  it('emergency overlay respects wb.EH ban during drain (user-disabled emergency)', () => {
    // User disabled Emergency Heating in the UI (wb.EH = sentinel).
    // freeze_drain still happens; heater must NOT fire.
    const result = evaluate(makeState({
      temps: { collector: 1, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 1 },
      collectorsDrained: false,
    }), null, { ce: true, ea: 31, wb: { EH: 9999999999 } });
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.actuators.space_heater, false,
      'Heater must NOT run when the user has disabled Emergency Heating');
    assert.strictEqual(result.flags.emergencyHeatingActive, false);
  });

  it('emergency overlay re-evaluates hysteresis during min-duration hold', () => {
    // Mode locked in 2 min ago (< minModeDuration of 300 s). Emergency
    // flag was false at entry (greenhouse was 11 °C). Now greenhouse
    // crashes to 4 °C mid-hold. The hold MUST NOT freeze the
    // hysteresis — heater must fire on this tick, not wait 3 min.
    //
    // Natural pump-mode pick is GREENHOUSE_HEATING (greenhouse still
    // cold, tank still has delta) — same as currentMode — so the
    // min-duration override is innocuous and the reason stays
    // "greenhouse_active". The hold is still in effect (would block a
    // mode swap if conditions tried to push us elsewhere), but
    // intentionally not surfaced as held since nothing is being
    // overridden.
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 5 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0,
      now: 120,
      emergencyHeatingActive: false,
      collectorsDrained: true,
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(result.reason, 'greenhouse_active',
      'natural reason wins when wanted == current — hold is innocuous');
    assert.strictEqual(result.flags.emergencyHeatingActive, true,
      'Hysteresis must update during the hold — greenhouse is critically cold');
    assert.strictEqual(result.actuators.space_heater, true,
      'Heater fires immediately, not after the hold expires');
  });

  it('wb.EH disable mid-hold takes effect immediately, not after 5 min', () => {
    // Mode locked in 2 min ago; emergency flag was true. User now
    // disables Emergency Heating via the app (wb.EH set). The heater
    // must turn off this tick, not wait for the hold to expire.
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 30, tank_bottom: 25, greenhouse: 4, outdoor: 5 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0,
      now: 120,
      emergencyHeatingActive: true,
      collectorsDrained: true,
    }), null, { ce: true, ea: 31, wb: { EH: 9999999999 } });
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(result.reason, 'greenhouse_active',
      'natural reason wins — see sibling min-duration test');
    assert.strictEqual(result.flags.emergencyHeatingActive, false,
      'wb.EH ban clears the flag even mid-hold');
    assert.strictEqual(result.actuators.space_heater, false);
  });
});
