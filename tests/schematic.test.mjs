/**
 * Unit tests for playground/js/schematic.js — specifically the pure
 * computeActivePipes() helper. DOM mutation is covered by the e2e tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { computeActivePipes } from '../playground/js/schematic.js';
import { PIPES } from '../playground/js/schematic-topology.js';

function state(overrides) {
  const base = {
    valves: {
      vi_btm: false, vi_top: false, vi_coll: false,
      vo_coll: false, vo_rad: false, vo_tank: false,
      v_air: false,
    },
    pump: false,
    fan: false,
    space_heater: false,
    sensors: {},
  };
  return {
    ...base,
    ...overrides,
    valves: { ...base.valves, ...(overrides && overrides.valves) },
  };
}

describe('computeActivePipes — idle baseline', () => {
  it('all pipes inactive when nothing is open', () => {
    const active = computeActivePipes(state({}), PIPES);
    for (const id of Object.keys(PIPES)) {
      assert.strictEqual(active[id], false, `${id} should be inactive`);
    }
  });

  it('pump running with all valves closed leaves every pipe inactive', () => {
    const active = computeActivePipes(state({ pump: true }), PIPES);
    for (const id of Object.keys(PIPES)) {
      assert.strictEqual(active[id], false, `${id} should be inactive`);
    }
  });
});

describe('computeActivePipes — solar_charging (vi_btm + vo_coll + pump)', () => {
  const s = state({
    pump: true,
    valves: { vi_btm: true, vo_coll: true },
  });
  const active = computeActivePipes(s, PIPES);

  it('lights up tank → vi_btm → pump → vo_coll → collector path', () => {
    const expected = [
      'pipe_tank_vibtm',
      'pipe_vibtm_pump',
      'pipe_pump_vocoll',
      'pipe_vocoll_collbtm',
    ];
    for (const id of expected) {
      assert.strictEqual(active[id], true, `${id} should be active`);
    }
  });

  it('lights up the passive collector-top and dip-reservoir return pipes', () => {
    assert.strictEqual(active.pipe_coll_top_reservoir, true);
    assert.strictEqual(active.pipe_dip_reservoir, true);
  });

  it('leaves greenhouse-heating and drain pipes inactive', () => {
    assert.strictEqual(active.pipe_pump_vorad, false);
    assert.strictEqual(active.pipe_pump_votank, false);
  });
});

describe('computeActivePipes — greenhouse_heating (vi_top + vo_rad + pump)', () => {
  const s = state({
    pump: true,
    valves: { vi_top: true, vo_rad: true },
  });
  const active = computeActivePipes(s, PIPES);

  it('lights up reservoir → vi_top → pump → vo_rad → radiator path', () => {
    for (const id of [
      'pipe_reservoir_vitop',
      'pipe_vitop_pump',
      'pipe_pump_vorad',
      'pipe_vorad_radiator',
      'pipe_rad_return',
    ]) {
      assert.strictEqual(active[id], true, `${id} should be active`);
    }
  });

  it('lights up the passive dip-reservoir supply pipe (vi_top branch)', () => {
    assert.strictEqual(active.pipe_dip_reservoir, true);
  });

  it('does NOT light up the passive collector-top pipe (no vo_coll/vi_coll)', () => {
    assert.strictEqual(active.pipe_coll_top_reservoir, false);
  });
});

describe('computeActivePipes — active_drain (vi_coll + vo_tank + v_air + pump)', () => {
  const s = state({
    pump: true,
    valves: { vi_coll: true, vo_tank: true, v_air: true },
  });
  const active = computeActivePipes(s, PIPES);

  it('lights up collector → vi_coll → pump → vo_tank → tank path', () => {
    for (const id of [
      'pipe_collbtm_vicoll',
      'pipe_vicoll_pump',
      'pipe_pump_votank',
      'pipe_votank_tank',
    ]) {
      assert.strictEqual(active[id], true, `${id} should be active`);
    }
  });

  it('lights up the passive collector-top pipe (vi_coll branch)', () => {
    assert.strictEqual(active.pipe_coll_top_reservoir, true);
  });
});

describe('computeActivePipes — pump off with valves open', () => {
  it('no pipe is active when pump is off, even if valves are open', () => {
    const s = state({
      pump: false,
      valves: { vi_btm: true, vo_coll: true },
    });
    const active = computeActivePipes(s, PIPES);
    for (const id of Object.keys(PIPES)) {
      assert.strictEqual(active[id], false, `${id} should be inactive`);
    }
  });
});
