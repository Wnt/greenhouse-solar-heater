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
});
