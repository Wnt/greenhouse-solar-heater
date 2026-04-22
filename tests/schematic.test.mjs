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

  it('lights up the shared output-tee chain between tank and VI-btm', () => {
    // Reverse flow through the two output tees: tank → tee_upper → tee_lower → VI-btm.
    assert.strictEqual(active.pipe_votank_tank, true);
    assert.strictEqual(active.pipe_tee_lower_tee_upper, true);
  });

  it('lights up the passive top-of-diagram return chain', () => {
    // Collector top → coll-top tee → reservoir (upper port), plus the dip
    // tube loop back to the tank — every segment animates during drainback.
    assert.strictEqual(active.pipe_coll_top_tee, true);
    assert.strictEqual(active.pipe_coll_top_reservoir, true);
    assert.strictEqual(active.pipe_dip_reservoir, true);
  });

  it('does NOT open V-air during solar charging', () => {
    assert.strictEqual(active.pipe_vair_colltee, false);
  });

  it('reverses the flow on the passive drainback segments', () => {
    // Drainback: collectors → reservoir → tee → dip tube → tank. The segments
    // drawn in the opposite direction must flip their animation.
    assert.ok(PIPES.pipe_collbtm_vicoll.reverseWhen.includes('vo_coll'));
    assert.ok(PIPES.pipe_tee_lower_tee_upper.reverseWhen.includes('vi_btm'));
    assert.ok(PIPES.pipe_votank_tank.reverseWhen.includes('vi_btm'));
    assert.ok(PIPES.pipe_dip_reservoir.reverseWhen.includes('vi_btm'));
  });

  it('leaves greenhouse-heating, drain, and reservoir-direct pipes inactive', () => {
    assert.strictEqual(active.pipe_pump_vorad, false);
    assert.strictEqual(active.pipe_pump_votank, false);
    assert.strictEqual(active.pipe_tee_collectors_vicoll, false);
    assert.strictEqual(active.pipe_votank_tee_lower, false);
    // The direct reservoir → VI-top pipe belongs to greenhouse_heating only.
    assert.strictEqual(active.pipe_reservoir_vitop, false);
    assert.strictEqual(active.pipe_vair_colltee, false);
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

  it('lights up the direct dip-tube inlet and the reservoir→VI-top outlet', () => {
    // tank gas_out → reservoir.left_dip (direct), and reservoir.left_submerged
    // → VI-top (direct). No intermediate tees on the reservoir's left side.
    assert.strictEqual(active.pipe_dip_reservoir, true);
    assert.strictEqual(active.pipe_reservoir_vitop, true);
  });

  it('lights up pipe_votank_tank as the radiator return path', () => {
    assert.strictEqual(active.pipe_votank_tank, true);
  });

  it('does NOT light up the collector-top path (no vo_coll/vi_coll)', () => {
    assert.strictEqual(active.pipe_coll_top_tee, false);
    assert.strictEqual(active.pipe_coll_top_reservoir, false);
    assert.strictEqual(active.pipe_vair_colltee, false);
  });

  it('does NOT light up the drain-only tee_lower → tee_upper link', () => {
    // Radiator return enters the upper tee directly via its trunk and exits
    // via arm_right to the tank — the lower tee is not on the path.
    assert.strictEqual(active.pipe_tee_lower_tee_upper, false);
    assert.strictEqual(active.pipe_votank_tee_lower, false);
  });
});

describe('computeActivePipes — active_drain (vi_coll + vo_tank + v_air + pump)', () => {
  const s = state({
    pump: true,
    valves: { vi_coll: true, vo_tank: true, v_air: true },
  });
  const active = computeActivePipes(s, PIPES);

  it('lights up collector → tee → vi_coll → pump → vo_tank → tee chain → tank path', () => {
    for (const id of [
      'pipe_collbtm_vicoll',
      'pipe_tee_collectors_vicoll',
      'pipe_vicoll_pump',
      'pipe_pump_votank',
      'pipe_votank_tee_lower',
      'pipe_tee_lower_tee_upper',
      'pipe_votank_tank',
    ]) {
      assert.strictEqual(active[id], true, `${id} should be active`);
    }
  });

  it('lights up the passive collector-top chain (vi_coll branch) reversed and cold', () => {
    // Both collector-top segments animate in reverse / cold during drain.
    for (const id of ['pipe_coll_top_tee', 'pipe_coll_top_reservoir']) {
      assert.strictEqual(active[id], true, `${id} should be active`);
      assert.ok(PIPES[id].reverseWhen.includes('vi_coll'), `${id}.reverseWhen`);
      assert.ok(PIPES[id].coldWhen.includes('vi_coll'), `${id}.coldWhen`);
    }
  });

  it('opens the V-air intake stub, reversed and cold', () => {
    assert.strictEqual(active.pipe_vair_colltee, true);
    assert.ok(PIPES.pipe_vair_colltee.reverseWhen.includes('v_air'));
    assert.ok(PIPES.pipe_vair_colltee.coldWhen.includes('v_air'));
  });

  it('leaves dip-tube and direct reservoir→VI-top paths inactive', () => {
    assert.strictEqual(active.pipe_dip_reservoir, false);
    assert.strictEqual(active.pipe_reservoir_vitop, false);
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
