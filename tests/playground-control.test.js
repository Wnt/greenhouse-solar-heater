/**
 * Tests for the playground ControlStateMachine (playground/js/control.js).
 *
 * Since control.js is an ES module that imports from yaml-loader.js,
 * we use --experimental-vm-modules and a custom loader to stub the dependency.
 * Alternatively, we inline the class here for unit testing.
 *
 * This test focuses on emergency heating transitions that the Shelly
 * control-logic.js handles correctly but the playground version missed.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// We can't easily import the ES module with its yaml-loader dependency,
// so we import it dynamically after registering a loader hook.
// Instead, we'll extract the class by reading and evaluating it with
// the yaml-loader functions stubbed.

// Stub the yaml-loader imports
const parseTrigger = () => ({});
const evaluateTrigger = () => false;

// Dynamically load control.js with stubbed imports
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const controlSrc = readFileSync(join(__dirname, '..', 'playground', 'js', 'control.js'), 'utf8');

// Rewrite the import to use our stubs and evaluate
const modifiedSrc = controlSrc
  .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?/, '')
  .replace('export class', 'class');

// Create a function that returns the class
const factory = new Function('parseTrigger', 'evaluateTrigger',
  modifiedSrc + '\nreturn ControlStateMachine;');

const ControlStateMachine = factory(parseTrigger, evaluateTrigger);

// Minimal modes config (only needs valve_states and actuators for result building)
const MODES_CONFIG = {
  idle: {
    trigger: '', exit: '',
    valve_states: {},
    actuators: { pump: 'OFF', fan: 'OFF' },
  },
  solar_charging: {
    trigger: '', exit: '',
    valve_states: { vi_btm: 'OPEN', vo_coll: 'OPEN', v_ret: 'OPEN' },
    actuators: { pump: 'ON', fan: 'OFF' },
  },
  greenhouse_heating: {
    trigger: '', exit: '',
    valve_states: { vi_top: 'OPEN', vo_rad: 'OPEN' },
    actuators: { pump: 'ON', fan: 'ON' },
  },
  active_drain: {
    trigger: '', exit: '',
    valve_states: { vi_coll: 'OPEN', vo_tank: 'OPEN', v_air: 'OPEN' },
    actuators: { pump: 'ON', fan: 'OFF' },
  },
  emergency_heating: {
    trigger: '', exit: '',
    valve_states: {},
    actuators: { pump: 'OFF', fan: 'OFF' },
  },
};

function makeSensors(overrides) {
  return Object.assign({
    t_collector: 20,
    t_tank_top: 40,
    t_tank_bottom: 30,
    t_greenhouse: 15,
    t_outdoor: 10,
  }, overrides);
}

describe('playground ControlStateMachine — emergency heating', () => {
  let controller;

  beforeEach(() => {
    controller = new ControlStateMachine(MODES_CONFIG);
  });

  it('enters emergency_heating from idle when greenhouse < 9 and tank lacks delta', () => {
    controller.collectorsDrained = true;
    const result = controller.evaluate(
      makeSensors({ t_greenhouse: 5, t_tank_top: 8, t_tank_bottom: 7, t_outdoor: -5 }),
      1000
    );
    assert.strictEqual(result.mode, 'emergency_heating');
    assert.strictEqual(result.actuators.space_heater, true);
  });

  it('transitions from greenhouse_heating to emergency_heating when tank depletes', () => {
    // Collectors already drained so freeze protection doesn't interfere
    controller.collectorsDrained = true;

    // First, get into greenhouse_heating mode
    const r1 = controller.evaluate(
      makeSensors({ t_greenhouse: 9, t_tank_top: 20, t_tank_bottom: 18, t_outdoor: -5 }),
      0
    );
    assert.strictEqual(r1.mode, 'greenhouse_heating',
      'should enter greenhouse_heating initially');

    // Simulate time passing (past min run time) — tank has cooled, greenhouse dropped
    // Tank at 10°C, greenhouse at 5°C → delta is only 5°C (not > 5), emergency conditions met
    const r2 = controller.evaluate(
      makeSensors({ t_greenhouse: 5, t_tank_top: 10, t_tank_bottom: 9, t_outdoor: -5 }),
      500  // well past MIN_RUN of 120s
    );
    assert.strictEqual(r2.mode, 'emergency_heating',
      'should transition to emergency_heating when tank depletes during greenhouse_heating');
    assert.strictEqual(r2.actuators.space_heater, true,
      'space heater should be ON in emergency mode');
  });

  it('keeps greenhouse_heating when tank still has useful heat even if greenhouse < 9', () => {
    controller.collectorsDrained = true;

    // Enter greenhouse_heating
    controller.evaluate(
      makeSensors({ t_greenhouse: 9, t_tank_top: 25, t_tank_bottom: 22, t_outdoor: -5 }),
      0
    );

    // Greenhouse drops below 9 but tank still has good delta (25 > 5 + 5 = 10)
    const r2 = controller.evaluate(
      makeSensors({ t_greenhouse: 5, t_tank_top: 25, t_tank_bottom: 22, t_outdoor: -5 }),
      500
    );
    assert.strictEqual(r2.mode, 'greenhouse_heating',
      'should stay in greenhouse_heating when tank still has useful heat');
  });

  it('never lets greenhouse drop below 9°C without emergency intervention', () => {
    controller.collectorsDrained = true;

    // Simulate the real scenario: system oscillates between greenhouse_heating and idle
    // while greenhouse temp slowly drops. When tank depletes, emergency should kick in.

    // Start: greenhouse 9°C, tank 16°C — enters greenhouse_heating
    const r1 = controller.evaluate(
      makeSensors({ t_greenhouse: 9, t_tank_top: 16, t_tank_bottom: 15, t_outdoor: -6 }),
      0
    );
    assert.strictEqual(r1.mode, 'greenhouse_heating');

    // Tank cools to where it can't meaningfully heat (delta <= 5)
    // greenhouse has dropped to 7°C, tank at 11°C (delta = 4°C)
    const r2 = controller.evaluate(
      makeSensors({ t_greenhouse: 7, t_tank_top: 11, t_tank_bottom: 10, t_outdoor: -6 }),
      500
    );
    assert.strictEqual(r2.mode, 'emergency_heating',
      'must switch to emergency when greenhouse < 9 and tank cannot help');
  });
});
