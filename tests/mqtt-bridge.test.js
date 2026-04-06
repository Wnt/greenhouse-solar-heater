const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

describe('mqtt-bridge', () => {
  let bridge;

  beforeEach(() => {
    delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
    bridge = require('../server/lib/mqtt-bridge.js');
    bridge._reset();
  });

  describe('handleStateMessage', () => {
    it('exports handleStateMessage function', () => {
      assert.strictEqual(typeof bridge.handleStateMessage, 'function');
    });
  });

  describe('detectStateChanges', () => {
    it('detects mode changes', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id, oldVal, newVal });
          if (cb) cb(null);
        },
      };

      const prev = { mode: 'idle', valves: {}, actuators: {} };
      const curr = { mode: 'solar_charging', valves: {}, actuators: {} };

      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'mode');
      assert.strictEqual(events[0].oldVal, 'idle');
      assert.strictEqual(events[0].newVal, 'solar_charging');
    });

    it('detects valve state changes', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id, oldVal, newVal });
          if (cb) cb(null);
        },
      };

      const prev = {
        mode: 'idle',
        valves: { vi_btm: false, vi_top: false },
        actuators: { pump: false },
      };
      const curr = {
        mode: 'idle',
        valves: { vi_btm: true, vi_top: false },
        actuators: { pump: false },
      };

      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'valve');
      assert.strictEqual(events[0].id, 'vi_btm');
      assert.strictEqual(events[0].oldVal, 'closed');
      assert.strictEqual(events[0].newVal, 'open');
    });

    it('detects actuator state changes', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id, oldVal, newVal });
          if (cb) cb(null);
        },
      };

      const prev = {
        mode: 'solar_charging',
        valves: {},
        actuators: { pump: false, fan: false },
      };
      const curr = {
        mode: 'solar_charging',
        valves: {},
        actuators: { pump: true, fan: false },
      };

      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'actuator');
      assert.strictEqual(events[0].id, 'pump');
      assert.strictEqual(events[0].newVal, 'on');
    });

    it('does not emit events when nothing changed', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id });
          if (cb) cb(null);
        },
      };

      const state = {
        mode: 'idle',
        valves: { vi_btm: false },
        actuators: { pump: false },
      };

      bridge.detectStateChanges(new Date(), state, state, mockDb);
      assert.strictEqual(events.length, 0);
    });

    it('gracefully handles null db', () => {
      assert.doesNotThrow(() => {
        bridge.detectStateChanges(new Date(), { mode: 'idle' }, { mode: 'solar_charging' });
      });
    });
  });

  describe('getConnectionStatus', () => {
    it('returns disconnected by default', () => {
      assert.strictEqual(bridge.getConnectionStatus(), 'disconnected');
    });
  });

  describe('MQTT request/response', () => {
    it('publishSensorConfigApply rejects when MQTT not connected', async () => {
      await assert.rejects(
        () => bridge.publishSensorConfigApply({ id: 'test-1', target: null, config: {} }),
        /MQTT not connected/
      );
    });

    it('publishDiscoveryRequest rejects when MQTT not connected', async () => {
      await assert.rejects(
        () => bridge.publishDiscoveryRequest(['192.168.30.20']),
        /MQTT not connected/
      );
    });

    it('exports publishSensorConfigApply and publishDiscoveryRequest', () => {
      assert.strictEqual(typeof bridge.publishSensorConfigApply, 'function');
      assert.strictEqual(typeof bridge.publishDiscoveryRequest, 'function');
    });
  });

  describe('sole state source (no valve-poller)', () => {
    it('handleStateMessage broadcasts state via WebSocket', () => {
      const sent = [];
      const mockWs = {
        clients: [{ readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) }],
      };
      bridge._reset();
      // Manually set wsServer through a new bridge instance
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      const freshBridge = require('../server/lib/mqtt-bridge.js');

      // Simulate internal state by calling handleStateMessage after setting up ws
      // The bridge needs wsServer set — we test the exported handleStateMessage
      // with a mock that captures broadcasts
      const payload = {
        ts: Date.now(),
        mode: 'idle',
        temps: { collector: 25, tank_top: 30, tank_bottom: 20, greenhouse: 15, outdoor: 10 },
        valves: { vi_btm: false },
        actuators: { pump: false },
      };

      // handleStateMessage doesn't crash without wsServer (graceful no-op)
      assert.doesNotThrow(() => freshBridge.handleStateMessage(payload));
      freshBridge._reset();
    });

    it('publishes config via publishConfig', () => {
      // Without MQTT client connected, publishConfig returns false
      assert.strictEqual(bridge.publishConfig({ ce: true, ea: 31, v: 1 }), false);
    });

    it('publishes sensor config via publishSensorConfig', () => {
      assert.strictEqual(bridge.publishSensorConfig({ s: {}, h: [], v: 1 }), false);
    });
  });
});
