/**
 * Unit tests for playground/js/sim-bootstrap.js — the pure
 * fast-forward helper that pre-rolls the thermal simulation so the
 * GitHub Pages deploy lands on a populated dashboard.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { bootstrapSimulation, getDayNightEnv } from '../playground/js/sim-bootstrap.js';
import { ThermalModel } from '../playground/js/physics.js';

// Stub controller that flips between idle and solar_charging based on
// the same delta rule the real Shelly logic uses (≥7°C trigger, ≤3°C
// exit). Enough fidelity to verify the bootstrap loop emits transitions
// without dragging in the real ES5 control logic loader.
function makeStubController() {
  let mode = 'idle';
  return {
    get currentMode() { return mode; },
    evaluate(sensors) {
      const delta = sensors.t_collector - sensors.t_tank_bottom;
      const next = mode === 'idle'
        ? (delta >= 7 ? 'solar_charging' : 'idle')
        : (delta <= 3 ? 'idle' : 'solar_charging');
      const transition = next !== mode ? `${mode} → ${next}` : null;
      mode = next;
      return {
        mode,
        actuators: { pump: mode === 'solar_charging', fan: false, space_heater: false },
        valves: {},
        transition,
      };
    },
  };
}

describe('bootstrapSimulation', () => {
  it('advances simTime by exactly the requested duration', () => {
    const model = new ThermalModel({});
    model.reset({ t_tank_top: 12, t_tank_bottom: 9, t_greenhouse: 11, t_outdoor: 10, irradiance: 500 });
    const params = { t_outdoor: 10, irradiance: 500, day_night_cycle: true };

    bootstrapSimulation({
      model,
      controller: makeStubController(),
      durationSeconds: 12 * 3600,
      dt: 1,
      getEnv: (t) => getDayNightEnv(t, params.t_outdoor, params.irradiance),
    });

    assert.strictEqual(model.state.simTime, 12 * 3600);
  });

  it('records ~one point per 5 seconds of sim time', () => {
    const model = new ThermalModel({});
    model.reset({ t_tank_top: 12, t_tank_bottom: 9, t_greenhouse: 11, t_outdoor: 10, irradiance: 500 });
    const params = { t_outdoor: 10, irradiance: 500, day_night_cycle: true };

    const result = bootstrapSimulation({
      model,
      controller: makeStubController(),
      durationSeconds: 12 * 3600,
      dt: 1,
      getEnv: (t) => getDayNightEnv(t, params.t_outdoor, params.irradiance),
    });

    // 12h / 5s = 8640 expected points. Allow a small slack for the
    // mod-5 boundary at t=0 vs t=durationSeconds.
    assert.ok(result.points.length >= 8600, `expected ≥8600 points, got ${result.points.length}`);
    assert.ok(result.points.length <= 8700, `expected ≤8700 points, got ${result.points.length}`);
  });

  it('emits at least one transition log entry over a 12h day/night cycle', () => {
    // With a 500 W/m² peak and a stub controller that mirrors the real
    // delta-driven logic, the collector heats up enough during the day
    // for solar_charging to engage at least once and disengage at sunset.
    const model = new ThermalModel({});
    model.reset({ t_tank_top: 12, t_tank_bottom: 9, t_greenhouse: 11, t_outdoor: 10, irradiance: 500 });
    const params = { t_outdoor: 10, irradiance: 500, day_night_cycle: true };

    const result = bootstrapSimulation({
      model,
      controller: makeStubController(),
      durationSeconds: 12 * 3600,
      dt: 1,
      getEnv: (t) => getDayNightEnv(t, params.t_outdoor, params.irradiance),
    });

    assert.ok(result.logEntries.length >= 1, `expected at least one transition, got ${result.logEntries.length}`);
    // Each entry has the simLoop-compatible shape.
    for (const e of result.logEntries) {
      assert.strictEqual(e.kind, 'sim');
      assert.ok(typeof e.time === 'number');
      assert.ok(typeof e.text === 'string');
      assert.ok(typeof e.mode === 'string');
    }
  });

  it('records points in chronological order with simLoop-compatible shape', () => {
    const model = new ThermalModel({});
    model.reset({ t_tank_top: 12, t_tank_bottom: 9, t_greenhouse: 11, t_outdoor: 10, irradiance: 500 });
    const params = { t_outdoor: 10, irradiance: 500, day_night_cycle: true };

    const result = bootstrapSimulation({
      model,
      controller: makeStubController(),
      durationSeconds: 1 * 3600,
      dt: 1,
      getEnv: (t) => getDayNightEnv(t, params.t_outdoor, params.irradiance),
    });

    let lastT = -Infinity;
    for (const p of result.points) {
      assert.ok(p.time > lastT, 'points must be strictly increasing in time');
      lastT = p.time;
      assert.ok('t_tank_top' in p.values);
      assert.ok('t_tank_bottom' in p.values);
      assert.ok('t_collector' in p.values);
      assert.ok('t_greenhouse' in p.values);
      assert.ok('t_outdoor' in p.values);
      assert.ok(typeof p.mode === 'string');
    }
  });

  it('changes the model temperature state from its initial values', () => {
    // Sanity check — the model should evolve under daylight hours.
    const model = new ThermalModel({});
    const initialTop = 12;
    model.reset({ t_tank_top: initialTop, t_tank_bottom: 9, t_greenhouse: 11, t_outdoor: 10, irradiance: 500 });
    const params = { t_outdoor: 10, irradiance: 500, day_night_cycle: true };

    bootstrapSimulation({
      model,
      controller: makeStubController(),
      durationSeconds: 12 * 3600,
      dt: 1,
      getEnv: (t) => getDayNightEnv(t, params.t_outdoor, params.irradiance),
    });

    // Greenhouse always evolves with passive solar gain + losses, so
    // we expect *some* change after 12h regardless of mode.
    assert.notStrictEqual(model.state.t_greenhouse, 11);
  });
});
