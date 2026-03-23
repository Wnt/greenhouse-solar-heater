/**
 * Tests for the playground ControlStateMachine (playground/js/control.js).
 *
 * The playground control.js now delegates all decisions to the real
 * shelly/control-logic.js, so these tests verify that the wrapper
 * correctly translates between playground sensor format and Shelly
 * state format, and produces the right transitions.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the real Shelly control logic (CommonJS)
const shellyLogicSrc = readFileSync(join(__dirname, '..', 'shelly', 'control-logic.js'), 'utf8');
const shellyModule = { exports: {} };
new Function('module', shellyLogicSrc)(shellyModule);
const { evaluate: _evaluate, MODES: _MODES, MODE_VALVES: _MODE_VALVES, MODE_ACTUATORS: _MODE_ACTUATORS } = shellyModule.exports;

// Load playground control.js with stubbed imports
const controlSrc = readFileSync(join(__dirname, '..', 'playground', 'js', 'control.js'), 'utf8');

// Remove ESM imports/exports, and pre-assign the module-level vars
// that control.js expects to be populated by initControlLogic()
const modifiedSrc = controlSrc
  .replace(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*['"];?/g, '')
  .replace('export async function initControlLogic', 'async function initControlLogic')
  .replace('export class', 'class')
  // Pre-assign the shared logic vars so we don't need to call initControlLogic()
  .replace('let _evaluate, _MODES, _MODE_VALVES, _MODE_ACTUATORS;',
    'var _evaluate = __evaluate, _MODES = __MODES, _MODE_VALVES = __MODE_VALVES, _MODE_ACTUATORS = __MODE_ACTUATORS;');

const factory = new Function(
  '__evaluate', '__MODES', '__MODE_VALVES', '__MODE_ACTUATORS',
  modifiedSrc + '\nreturn ControlStateMachine;'
);

const ControlStateMachine = factory(
  _evaluate, _MODES, _MODE_VALVES, _MODE_ACTUATORS
);

// Minimal modes config (only needed for constructor, not decisions)
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

describe('playground ControlStateMachine — shared logic integration', () => {
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

  it('enters emergency_heating from idle when tank below minimum useful temp', () => {
    controller.collectorsDrained = true;
    // Tank 20°C has delta over greenhouse 8°C but is below 25°C minimum
    const result = controller.evaluate(
      makeSensors({ t_greenhouse: 8, t_tank_top: 20, t_tank_bottom: 18, t_outdoor: -30 }),
      1000
    );
    assert.strictEqual(result.mode, 'emergency_heating',
      'should enter emergency: tank 20°C < 25°C minimum, greenhouse 8°C < 9°C');
  });

  it('transitions from greenhouse_heating to emergency_heating when tank depletes', () => {
    controller.collectorsDrained = true;

    // First, get into greenhouse_heating mode (tank must be >= 25°C)
    const r1 = controller.evaluate(
      makeSensors({ t_greenhouse: 9, t_tank_top: 30, t_tank_bottom: 28, t_outdoor: -5 }),
      0
    );
    assert.strictEqual(r1.mode, 'greenhouse_heating',
      'should enter greenhouse_heating initially');

    // Tank depletes below minimum, greenhouse drops
    const r2 = controller.evaluate(
      makeSensors({ t_greenhouse: 5, t_tank_top: 20, t_tank_bottom: 18, t_outdoor: -5 }),
      500
    );
    assert.strictEqual(r2.mode, 'emergency_heating',
      'should transition to emergency_heating when tank depletes');
    assert.strictEqual(r2.actuators.space_heater, true,
      'space heater should be ON in emergency mode');
  });

  it('keeps greenhouse_heating when tank still has useful heat even if greenhouse < 9', () => {
    controller.collectorsDrained = true;

    // Enter greenhouse_heating with warm tank
    controller.evaluate(
      makeSensors({ t_greenhouse: 9, t_tank_top: 30, t_tank_bottom: 28, t_outdoor: -5 }),
      0
    );

    // Greenhouse drops below 9 but tank still above minimum (25°C) and has delta
    const r2 = controller.evaluate(
      makeSensors({ t_greenhouse: 5, t_tank_top: 25, t_tank_bottom: 22, t_outdoor: -5 }),
      500
    );
    assert.strictEqual(r2.mode, 'greenhouse_heating',
      'should stay in greenhouse_heating when tank still has useful heat');
  });

  it('never lets greenhouse drop below 9°C without emergency intervention', () => {
    controller.collectorsDrained = true;

    // Start with warm tank — greenhouse heating
    const r1 = controller.evaluate(
      makeSensors({ t_greenhouse: 9, t_tank_top: 30, t_tank_bottom: 28, t_outdoor: -6 }),
      0
    );
    assert.strictEqual(r1.mode, 'greenhouse_heating');

    // Tank cools below minimum, greenhouse drops
    const r2 = controller.evaluate(
      makeSensors({ t_greenhouse: 7, t_tank_top: 20, t_tank_bottom: 18, t_outdoor: -6 }),
      500
    );
    assert.strictEqual(r2.mode, 'emergency_heating',
      'must switch to emergency when greenhouse < 9 and tank below minimum');
  });

  it('produces transition log entries on mode changes', () => {
    controller.collectorsDrained = true;
    controller.evaluate(
      makeSensors({ t_greenhouse: 9, t_tank_top: 30, t_tank_bottom: 28, t_outdoor: -5 }),
      0
    );
    assert.strictEqual(controller.transitionLog.length, 1);
    assert.ok(controller.transitionLog[0].transition.includes('greenhouse_heating'));
  });

  it('reset clears all state', () => {
    controller.collectorsDrained = true;
    controller.currentMode = 'emergency_heating';
    controller.transitionLog.push({ time: 0, transition: 'test' });
    controller.reset();
    assert.strictEqual(controller.currentMode, 'idle');
    assert.strictEqual(controller.collectorsDrained, false);
    assert.strictEqual(controller.transitionLog.length, 0);
  });

  it('uses real Shelly MODE_VALVES for output', () => {
    // Enter solar charging
    const r = controller.evaluate(
      makeSensors({ t_collector: 40, t_tank_top: 40, t_tank_bottom: 30, t_greenhouse: 15, t_outdoor: 10 }),
      0
    );
    assert.strictEqual(r.mode, 'solar_charging');
    assert.strictEqual(r.valves.vi_btm, true);
    assert.strictEqual(r.valves.vo_coll, true);
    assert.strictEqual(r.valves.v_ret, true);
    assert.strictEqual(r.actuators.pump, true);
    assert.strictEqual(r.actuators.fan, false);
  });
});
