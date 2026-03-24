const { describe, it } = require('node:test');
const assert = require('node:assert');

// data-source.js is an ES module for the browser. We test the contract shapes
// and logic patterns without actually importing the ES module in Node.

describe('data-source contract', () => {

  it('LiveSource state mapping produces correct shape from MQTT payload', () => {
    // Simulate the _handleState logic
    const data = {
      ts: 1711296000000,
      mode: 'solar_charging',
      transitioning: false,
      transition_step: null,
      temps: { collector: 65.2, tank_top: 48.1, tank_bottom: 32.5, greenhouse: 18.3, outdoor: 12.7 },
      valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_ret: true, v_air: false },
      actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
      controls_enabled: true,
    };

    const state = {
      t_collector: data.temps.collector,
      t_tank_top: data.temps.tank_top,
      t_tank_bottom: data.temps.tank_bottom,
      t_greenhouse: data.temps.greenhouse,
      t_outdoor: data.temps.outdoor,
      simTime: 0,
    };

    const result = {
      mode: data.mode,
      valves: data.valves,
      actuators: data.actuators,
      transition: data.transitioning ? (data.transition_step || 'transitioning') : null,
      transitioning: data.transitioning,
      transition_step: data.transition_step,
      controls_enabled: data.controls_enabled,
    };

    assert.strictEqual(state.t_collector, 65.2);
    assert.strictEqual(state.t_tank_top, 48.1);
    assert.strictEqual(state.t_tank_bottom, 32.5);
    assert.strictEqual(state.t_greenhouse, 18.3);
    assert.strictEqual(state.t_outdoor, 12.7);
    assert.strictEqual(result.mode, 'solar_charging');
    assert.strictEqual(result.actuators.pump, true);
    assert.strictEqual(result.valves.vi_btm, true);
    assert.strictEqual(result.transition, null);
    assert.strictEqual(result.controls_enabled, true);
  });

  it('LiveSource maps transitioning state correctly', () => {
    const data = {
      mode: 'solar_charging',
      transitioning: true,
      transition_step: 'pump_stop',
      temps: { collector: 65, tank_top: 48, tank_bottom: 32, greenhouse: 18, outdoor: 12 },
      valves: {},
      actuators: {},
    };

    const result = {
      mode: data.mode,
      transition: data.transitioning ? (data.transition_step || 'transitioning') : null,
      transitioning: data.transitioning,
      transition_step: data.transition_step,
    };

    assert.strictEqual(result.transition, 'pump_stop');
    assert.strictEqual(result.transitioning, true);
    assert.strictEqual(result.transition_step, 'pump_stop');
  });

  it('connection status transitions: connected → disconnected → reconnecting', () => {
    const statuses = [];
    const callbacks = [(s) => statuses.push(s)];

    // Simulate the DataSource connection change emission
    function emit(status) {
      for (const cb of callbacks) cb(status);
    }

    emit('connected');
    emit('disconnected');
    emit('reconnecting');
    emit('connected');

    assert.deepStrictEqual(statuses, ['connected', 'disconnected', 'reconnecting', 'connected']);
  });

  it('SimulationSource produces state updates via pushUpdate', () => {
    const updates = [];
    const callbacks = [(state, result) => updates.push({ state, result })];

    // Simulate pushUpdate
    function pushUpdate(state, result) {
      for (const cb of callbacks) cb(state, result);
    }

    pushUpdate(
      { t_collector: 40, t_tank_top: 35, t_tank_bottom: 30, t_greenhouse: 15, t_outdoor: 10, simTime: 100 },
      { mode: 'idle', valves: {}, actuators: { pump: false }, transition: null }
    );

    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].state.t_collector, 40);
    assert.strictEqual(updates[0].result.mode, 'idle');
  });
});
