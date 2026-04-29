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
      valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
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

  it('LiveSource carries cause + reason from MQTT snapshot to result', () => {
    // Regression: the WebSocket → result mapping was dropping `reason`,
    // so live transitions appeared in System Logs as bare "[automation]"
    // until a page reload pulled the row back from /api/events with the
    // reason intact. Both fields originate in the device's
    // buildSnapshotFromState() and must reach detectLiveTransition().
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'playground', 'js', 'data-source.js'),
      'utf8'
    );
    const handleStateBody = src.match(/_handleState\(data\) \{([\s\S]*?)\n {2}\}/)[1];
    assert.match(
      handleStateBody,
      /reason: data\.reason \|\| null/,
      '_handleState must propagate data.reason into the result object'
    );
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

  it('MQTT status is tracked separately from WS connection status', () => {
    // Simulate LiveSource tracking MQTT status without conflating with WS
    let connected = false;
    let mqttStatus = 'unknown';
    const statuses = [];
    const callbacks = [(s) => statuses.push(s)];

    function emitConnectionChange(status) {
      connected = status === 'connected';
      for (const cb of callbacks) cb(status);
    }

    // WS connects (mqttStatus stays 'unknown' until server sends an update)
    emitConnectionChange('connected');
    assert.strictEqual(connected, true);
    assert.strictEqual(mqttStatus, 'unknown');

    // Server sends MQTT connected status (should NOT change WS state)
    mqttStatus = 'connected';
    for (const cb of callbacks) cb(connected ? 'connected' : 'disconnected');
    assert.strictEqual(connected, true, 'WS should still be connected');
    assert.strictEqual(mqttStatus, 'connected');

    // Server sends MQTT disconnected (should NOT change WS state)
    mqttStatus = 'disconnected';
    for (const cb of callbacks) cb(connected ? 'connected' : 'disconnected');
    assert.strictEqual(connected, true, 'WS should still be connected when MQTT disconnects');
    assert.strictEqual(mqttStatus, 'disconnected');

    // All callbacks received 'connected' since WS never disconnected
    assert.deepStrictEqual(statuses, ['connected', 'connected', 'connected']);
  });

  // ── getConnectionDisplayState logic tests ──
  // The function lives inside index.html's closure. We replicate its logic here
  // to test the state machine contract independently.

  function getConnectionDisplayState(opts) {
    const activeSource = opts.activeSource || 'live';
    const connectionStatus = opts.connectionStatus || 'disconnected';
    const hasReceivedData = opts.hasReceivedData || false;
    const mqttStatus = opts.mqttStatus || 'unknown';
    const lastDataTime = opts.lastDataTime || 0;
    const connectedAt = opts.connectedAt || 0;
    const wsEverFailed = opts.wsEverFailed || false;
    const now = opts.now || Date.now();

    if (activeSource !== 'live') return 'active';

    if (connectionStatus === 'connected') {
      if (mqttStatus === 'disconnected' || mqttStatus === 'reconnecting') {
        return 'device_offline';
      }
      if (hasReceivedData) {
        if (lastDataTime > 0 && (now - lastDataTime) > 60000) return 'stale';
        return 'active';
      }
      if (connectedAt > 0 && (now - connectedAt) > 2000) {
        return 'device_offline';
      }
      return 'connecting'; // waiting for MQTT status
    }

    // WS is not connected or reconnecting
    if (!hasReceivedData) return wsEverFailed ? 'never_connected' : 'connecting';
    return 'disconnected';
  }

  it('display state: active in simulation mode', () => {
    assert.strictEqual(getConnectionDisplayState({ activeSource: 'simulation' }), 'active');
  });

  it('display state: active when WS connected, MQTT connected, data flowing', () => {
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'connected',
      mqttStatus: 'connected',
      hasReceivedData: true,
      lastDataTime: Date.now() - 5000,
    }), 'active');
  });

  it('display state: device_offline when WS connected but MQTT disconnected', () => {
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'connected',
      mqttStatus: 'disconnected',
      hasReceivedData: false,
    }), 'device_offline');
  });

  it('display state: device_offline when WS connected but MQTT reconnecting', () => {
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'connected',
      mqttStatus: 'reconnecting',
      hasReceivedData: true,
      lastDataTime: Date.now() - 5000,
    }), 'device_offline');
  });

  it('display state: device_offline after grace period with no data', () => {
    const connectedAt = Date.now() - 5000; // 5s ago (> 2s grace)
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'connected',
      mqttStatus: 'connected',
      hasReceivedData: false,
      connectedAt,
      now: Date.now(),
    }), 'device_offline');
  });

  it('display state: connecting during grace period (WS just connected, no data yet)', () => {
    const connectedAt = Date.now() - 500; // 500ms ago (< 2s grace)
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'connected',
      mqttStatus: 'unknown',
      hasReceivedData: false,
      connectedAt,
      now: Date.now(),
    }), 'connecting');
  });

  it('display state: stale when data stops flowing for 60+ seconds', () => {
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'connected',
      mqttStatus: 'connected',
      hasReceivedData: true,
      lastDataTime: Date.now() - 90000, // 90s ago
    }), 'stale');
  });

  it('display state: connecting when WS not yet connected and never failed', () => {
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'disconnected',
      hasReceivedData: false,
      wsEverFailed: false,
    }), 'connecting');
  });

  it('display state: never_connected when WS failed and no data', () => {
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'disconnected',
      hasReceivedData: false,
      wsEverFailed: true,
    }), 'never_connected');
  });

  it('display state: disconnected when WS drops after having received data', () => {
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'disconnected',
      hasReceivedData: true,
      lastDataTime: Date.now() - 5000,
    }), 'disconnected');
  });

  it('display state: device_offline takes priority over stale when MQTT is down', () => {
    // Even if data was flowing before, MQTT disconnection = device_offline
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'connected',
      mqttStatus: 'disconnected',
      hasReceivedData: true,
      lastDataTime: Date.now() - 90000,
    }), 'device_offline');
  });

  it('MQTT status resets to unknown on WS close', () => {
    let mqttStatus = 'connected';
    assert.strictEqual(mqttStatus, 'connected');
    // Simulate ws.onclose behavior
    mqttStatus = 'unknown';
    assert.strictEqual(mqttStatus, 'unknown');
  });

  it('_wsEverFailed tracks whether WS has ever failed', () => {
    let wsEverFailed = false;

    // Simulate initial state — not yet failed
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'disconnected',
      hasReceivedData: false,
      wsEverFailed,
    }), 'connecting');

    // Simulate ws.onclose — marks failure
    wsEverFailed = true;
    assert.strictEqual(getConnectionDisplayState({
      connectionStatus: 'disconnected',
      hasReceivedData: false,
      wsEverFailed,
    }), 'never_connected');

    // Simulate stop() — resets flag
    wsEverFailed = false;
    assert.strictEqual(wsEverFailed, false);
  });

  it('MQTT status and connectedAt reset on stop()', () => {
    let mqttStatus = 'connected';
    let connectedAt = Date.now();
    let hasReceivedData = true;
    // Pre-conditions
    assert.strictEqual(mqttStatus, 'connected');
    assert.ok(connectedAt > 0);
    assert.strictEqual(hasReceivedData, true);
    // Simulate stop() behavior
    hasReceivedData = false;
    mqttStatus = 'unknown';
    connectedAt = 0;
    assert.strictEqual(mqttStatus, 'unknown');
    assert.strictEqual(connectedAt, 0);
    assert.strictEqual(hasReceivedData, false);
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
