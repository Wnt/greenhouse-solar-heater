/**
 * Integration test: UI config format → Shelly control-logic interpretation.
 * Simulates different device config scenarios that an operator might set
 * via the playground Device UI, and verifies the Shelly evaluate() function
 * interprets them correctly.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES, EA_VALVES, EA_PUMP, EA_FAN, EA_SPACE_HEATER, EA_IMMERSION } = require('../shelly/control-logic.js');

function makeState(overrides) {
  const base = {
    temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    currentMode: MODES.IDLE,
    modeEnteredAt: 0,
    now: 2000,
    collectorsDrained: false,
    lastRefillAttempt: 0,
    emergencyHeatingActive: false,
    sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 },
  };
  return Object.assign({}, base, overrides);
}

// Simulate what the UI produces when the operator clicks "Save & Push"
function buildUIConfig({ controlsEnabled, valves, pump, fan, spaceHeater, immersionHeater, forcedMode, allowedModes }) {
  let ea = 0;
  if (valves) ea |= EA_VALVES;
  if (pump) ea |= EA_PUMP;
  if (fan) ea |= EA_FAN;
  if (spaceHeater) ea |= EA_SPACE_HEATER;
  if (immersionHeater) ea |= EA_IMMERSION;
  return {
    ce: !!controlsEnabled,
    ea: ea,
    fm: forcedMode || null,
    am: allowedModes || null,
    v: 1,
  };
}

describe('UI config → Shelly control-logic integration', () => {

  it('Scenario: fresh deployment (all controls off)', () => {
    const config = buildUIConfig({ controlsEnabled: false });
    // Even with solar conditions, everything should be suppressed
    const result = evaluate(makeState({
      temps: { collector: 50, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, config);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING, 'logic still decides solar charging');
    assert.strictEqual(result.suppressed, true, 'but actuators are suppressed');
  });

  it('Scenario: step 2 — monitoring only (controls off, sensors publishing)', () => {
    const config = buildUIConfig({ controlsEnabled: false });
    // Greenhouse cold — logic says heat, but suppressed
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 45, tank_bottom: 35, greenhouse: 8, outdoor: 5 },
    }), null, config);
    assert.strictEqual(result.suppressed, true);
    // Safety: freeze drain bypasses device config — never suppressed
    const freezeResult = evaluate(makeState({
      temps: { collector: 5, tank_top: 20, tank_bottom: 15, greenhouse: 3, outdoor: 1 },
    }), null, config);
    assert.strictEqual(freezeResult.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(freezeResult.suppressed, false, 'safety drain must not be suppressed');
    assert.strictEqual(freezeResult.safetyOverride, true, 'safety override flag set');
  });

  it('Scenario: step 4 — force solar charging mode', () => {
    const config = buildUIConfig({
      controlsEnabled: true,
      valves: true,
      pump: true,
      forcedMode: 'SC',
    });
    // Conditions don't trigger solar (collector too cold), but forced mode overrides
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, config);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.actuators.pump, true);
    assert.strictEqual(result.actuators.fan, false, 'fan not in ea bitmask');
    assert.strictEqual(result.suppressed, false);
    // Verify valves match solar charging mode
    assert.strictEqual(result.valves.vi_btm, true);
    assert.strictEqual(result.valves.vo_coll, true);
  });

  it('Scenario: step 4 — force solar but freeze preempts', () => {
    const config = buildUIConfig({
      controlsEnabled: true,
      valves: true,
      pump: true,
      forcedMode: 'SC',
    });
    // Freeze condition — drain MUST happen regardless of forced mode
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 20, tank_bottom: 15, greenhouse: 3, outdoor: 1 },
    }), null, config);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN, 'safety drain preempts forced mode');
  });

  it('Scenario: step 5 — automation with only idle + solar allowed', () => {
    const config = buildUIConfig({
      controlsEnabled: true,
      valves: true,
      pump: true,
      allowedModes: ['I', 'SC'],
    });
    // Solar conditions met → solar charging allowed
    const solar = evaluate(makeState({
      temps: { collector: 50, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, config);
    assert.strictEqual(solar.nextMode, MODES.SOLAR_CHARGING);

    // Greenhouse heating conditions met, but GH not in allowed list → IDLE
    const gh = evaluate(makeState({
      temps: { collector: 20, tank_top: 45, tank_bottom: 35, greenhouse: 8, outdoor: 5 },
    }), null, config);
    assert.strictEqual(gh.nextMode, MODES.IDLE, 'greenhouse heating blocked by allowed_modes');

    // Idle when no triggers
    const idle = evaluate(makeState({}), null, config);
    assert.strictEqual(idle.nextMode, MODES.IDLE);
  });

  it('Scenario: expanding allowed modes to include greenhouse heating', () => {
    const config = buildUIConfig({
      controlsEnabled: true,
      valves: true,
      pump: true,
      fan: true,
      allowedModes: ['I', 'SC', 'GH'],
    });
    // Now greenhouse heating is allowed
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 45, tank_bottom: 35, greenhouse: 8, outdoor: 5 },
    }), null, config);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(result.actuators.pump, true);
    assert.strictEqual(result.actuators.fan, true);
  });

  it('Scenario: full automation (all modes, all actuators)', () => {
    const config = buildUIConfig({
      controlsEnabled: true,
      valves: true,
      pump: true,
      fan: true,
      spaceHeater: true,
      immersionHeater: true,
      // no forced mode, no allowed modes restriction
    });
    assert.strictEqual(config.ea, 31, 'all actuator bits set');
    assert.strictEqual(config.fm, null);
    assert.strictEqual(config.am, null);

    // Emergency heating when greenhouse very cold and tank can't help
    const result = evaluate(makeState({
      temps: { collector: 2, tank_top: 8, tank_bottom: 6, greenhouse: 7, outdoor: -5 },
      collectorsDrained: true,
    }), null, config);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
    assert.strictEqual(result.actuators.space_heater, true);
    assert.strictEqual(result.actuators.immersion_heater, true);
  });

  it('Scenario: partial actuators — pump only, no valves (diagnostic)', () => {
    const config = buildUIConfig({
      controlsEnabled: true,
      pump: true,
      // valves: false — pump runs but valves won't open
      forcedMode: 'SC',
    });
    const result = evaluate(makeState({}), null, config);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.actuators.pump, true);
    // Valves should all be false because valve bit not set
    assert.strictEqual(result.valves.vi_btm, false);
    assert.strictEqual(result.valves.vo_coll, false);
    assert.strictEqual(result.valves.v_air, false);
  });

  it('all configs fit within Shelly KVS 256-byte limit', () => {
    const scenarios = [
      buildUIConfig({ controlsEnabled: false }),
      buildUIConfig({ controlsEnabled: true, valves: true, pump: true }),
      buildUIConfig({ controlsEnabled: true, valves: true, pump: true, forcedMode: 'SC' }),
      buildUIConfig({ controlsEnabled: true, valves: true, pump: true, fan: true, allowedModes: ['I', 'SC'] }),
      buildUIConfig({ controlsEnabled: true, valves: true, pump: true, fan: true, spaceHeater: true, immersionHeater: true, forcedMode: 'GH', allowedModes: ['I', 'SC', 'GH', 'AD'] }),
    ];
    for (const cfg of scenarios) {
      const size = JSON.stringify(cfg).length;
      assert.ok(size <= 256, 'config is ' + size + ' bytes: ' + JSON.stringify(cfg));
      assert.ok(size <= 64, 'config should be <= 64 bytes (target), got ' + size + ': ' + JSON.stringify(cfg));
    }
  });
});
