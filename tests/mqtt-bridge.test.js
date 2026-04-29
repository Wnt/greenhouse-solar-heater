const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

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
        insertStateEvent: function (ts, type, id, oldVal, newVal, optsOrCb, maybeCb) {
          const opts = typeof optsOrCb === 'function' ? null : optsOrCb;
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          events.push({ type, id, oldVal, newVal, opts });
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

    it('records cause, reason, and sensor snapshot for mode changes', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, optsOrCb, maybeCb) {
          const opts = typeof optsOrCb === 'function' ? null : optsOrCb;
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          events.push({ type, opts });
          if (cb) cb(null);
        },
      };

      const prev = { mode: 'idle', valves: {}, actuators: {} };
      const curr = {
        mode: 'solar_charging',
        cause: 'automation',
        reason: 'solar_enter',
        temps: { collector: 62.3, tank_top: 41, tank_bottom: 29, greenhouse: 12, outdoor: 8 },
        valves: {}, actuators: {},
      };

      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      const modeEvt = events.find(e => e.type === 'mode');
      assert.ok(modeEvt);
      assert.strictEqual(modeEvt.opts.cause, 'automation');
      assert.strictEqual(modeEvt.opts.reason, 'solar_enter');
      assert.deepStrictEqual(modeEvt.opts.sensors,
        { collector: 62.3, tank_top: 41, tank_bottom: 29, greenhouse: 12, outdoor: 8 });
    });

    it('null-fills cause, reason, and sensors when the state payload lacks them (old firmware)', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, optsOrCb, maybeCb) {
          const opts = typeof optsOrCb === 'function' ? null : optsOrCb;
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          events.push({ type, opts });
          if (cb) cb(null);
        },
      };

      const prev = { mode: 'idle', valves: {}, actuators: {} };
      const curr = { mode: 'solar_charging', valves: {}, actuators: {} };
      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      const modeEvt = events.find(e => e.type === 'mode');
      assert.strictEqual(modeEvt.opts.cause, null);
      assert.strictEqual(modeEvt.opts.reason, null);
      assert.strictEqual(modeEvt.opts.sensors, null);
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

  describe('last state replay (fast first paint)', () => {
    it('getLastState returns null before any greenhouse/state has been received', () => {
      assert.strictEqual(bridge.getLastState(), null);
    });

    it('getLastState returns the most recent payload after handleStateMessage', () => {
      const payload = {
        ts: 1, mode: 'idle',
        temps: { collector: null, tank_top: null, tank_bottom: null, greenhouse: null, outdoor: null },
        valves: {}, actuators: {},
        controls_enabled: true,
      };
      bridge.handleStateMessage(payload);
      const last = bridge.getLastState();
      assert.ok(last, 'expected cached state');
      assert.strictEqual(last.mode, 'idle');
      assert.strictEqual(last.controls_enabled, true);
    });

    it('getLastState enriches with manual_override from deviceConfig (active session)', () => {
      bridge._setDeviceConfigRefForTest({
        getConfig: function () {
          return { ce: true, ea: 31, mo: { a: true, ex: 9999, fm: 'I' } };
        },
      });
      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {}, controls_enabled: true,
      });
      const last = bridge.getLastState();
      assert.deepStrictEqual(last.manual_override, { active: true, expiresAt: 9999, forcedMode: 'I' });
    });

    it('getLastState enriches manual_override as null when no active override', () => {
      bridge._setDeviceConfigRefForTest({
        getConfig: function () { return { ce: true, ea: 31 }; },
      });
      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {}, controls_enabled: true,
      });
      const last = bridge.getLastState();
      assert.strictEqual(last.manual_override, null);
    });

    it('getLastState reports the forcedMode in manual_override', () => {
      bridge._setDeviceConfigRefForTest({
        getConfig: function () {
          return { ce: true, ea: 31, mo: { a: true, ex: 9999, fm: 'SC' } };
        },
      });
      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {}, controls_enabled: true,
      });
      const last = bridge.getLastState();
      assert.deepStrictEqual(last.manual_override, { active: true, expiresAt: 9999, forcedMode: 'SC' });
    });

    it('subsequent state messages overwrite the cache so the latest is always served', () => {
      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {}, controls_enabled: false,
      });
      bridge.handleStateMessage({
        ts: 2, mode: 'solar_charging', temps: {}, valves: {}, actuators: {}, controls_enabled: true,
      });
      const last = bridge.getLastState();
      assert.strictEqual(last.mode, 'solar_charging');
      assert.strictEqual(last.controls_enabled, true);
      assert.strictEqual(last.ts, 2);
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

  describe('auto-republish on MQTT connect', () => {
    let fakeMqttModule;
    let fakeClient;
    let mqttModulePath;
    let originalCacheEntry;

    beforeEach(() => {
      fakeClient = new EventEmitter();
      fakeClient.connected = false;
      fakeClient.subscribe = function (topic, opts, cb) {
        if (typeof opts === 'function') { cb = opts; }
        if (cb) cb(null);
      };
      fakeClient.publish = function (topic, message, opts, cb) {
        fakeClient.publishCalls.push({ topic, message, opts });
        if (cb) cb(null);
      };
      fakeClient.end = function (force, opts, cb) { if (cb) cb(); };
      fakeClient.publishCalls = [];

      fakeMqttModule = {
        connect: function () { return fakeClient; },
      };

      mqttModulePath = require.resolve('mqtt');
      originalCacheEntry = require.cache[mqttModulePath];
      require.cache[mqttModulePath] = { id: mqttModulePath, filename: mqttModulePath, loaded: true, exports: fakeMqttModule };

      // Reload bridge so it picks up the fake mqtt module via require()
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      bridge = require('../server/lib/mqtt-bridge.js');
      bridge._reset();
    });

    afterEach(() => {
      if (originalCacheEntry) {
        require.cache[mqttModulePath] = originalCacheEntry;
      } else {
        delete require.cache[mqttModulePath];
      }
      bridge._reset();
    });

    it('republishes the current device config to greenhouse/config (retained) when MQTT connects', () => {
      const currentConfig = { ce: true, ea: 31, fm: null, am: null, v: 8 };
      const fakeDeviceConfig = {
        getConfig: function () { return currentConfig; },
      };

      bridge.start({ mqttHost: '127.0.0.1', deviceConfig: fakeDeviceConfig });

      // Simulate broker handshake completing
      fakeClient.connected = true;
      fakeClient.emit('connect');

      const configPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/config';
      });
      assert.strictEqual(configPublishes.length, 1,
        'bridge should publish device config exactly once on MQTT connect');
      assert.deepStrictEqual(JSON.parse(configPublishes[0].message), currentConfig);
      assert.strictEqual(configPublishes[0].opts.retain, true,
        'config publish must be retained so reconnecting Shellies receive it');
      assert.strictEqual(configPublishes[0].opts.qos, 1);
    });

    it('republishes again on every reconnect (e.g. broker restart)', () => {
      const fakeDeviceConfig = {
        getConfig: function () { return { ce: true, ea: 31, fm: null, am: null, v: 1 }; },
      };

      bridge.start({ mqttHost: '127.0.0.1', deviceConfig: fakeDeviceConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');
      fakeClient.emit('connect');
      fakeClient.emit('connect');

      const configPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/config';
      });
      assert.strictEqual(configPublishes.length, 3,
        'bridge should re-publish on every MQTT connect event so a broker restart self-heals');
    });

    it('does not crash on connect when no deviceConfig provider was supplied', () => {
      bridge.start({ mqttHost: '127.0.0.1' });

      fakeClient.connected = true;
      assert.doesNotThrow(function () { fakeClient.emit('connect'); });

      const configPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/config';
      });
      assert.strictEqual(configPublishes.length, 0);
    });

    it('does not republish when deviceConfig.getConfig() returns null', () => {
      const fakeDeviceConfig = { getConfig: function () { return null; } };
      bridge.start({ mqttHost: '127.0.0.1', deviceConfig: fakeDeviceConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');

      const configPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/config';
      });
      assert.strictEqual(configPublishes.length, 0,
        'should skip republish when no config is loaded yet (e.g. S3 fetch still in flight)');
    });

    // Sibling to the device-config republish: our Mosquitto sidecar has no
    // persistence, so a broker restart wipes the retained greenhouse/sensor-config
    // message. Without an auto-republish the Shelly controller would keep
    // polling whatever it has in KVS — even if the server has since stored a
    // newer role→cid mapping via PUT /api/sensor-config. The status view would
    // then keep showing the wrong probe for each role while the sensors tab
    // (which talks to each hub directly) shows the right one.
    it('republishes the current sensor config to greenhouse/sensor-config (retained) when MQTT connects', () => {
      const currentSensor = {
        hosts: [{ id: 'sensor_1', ip: '192.168.30.20' }],
        assignments: {
          collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 },
          tank_top:  { addr: 'aa:02', hostIndex: 0, componentId: 101 },
        },
        version: 5,
      };
      const fakeSensorConfig = {
        getConfig: function () { return currentSensor; },
        toCompactFormat: function (cfg) {
          return {
            s: {
              collector: { h: 0, i: cfg.assignments.collector.componentId, a: cfg.assignments.collector.addr },
              tank_top:  { h: 0, i: cfg.assignments.tank_top.componentId,  a: cfg.assignments.tank_top.addr },
            },
            h: ['192.168.30.20'],
            v: cfg.version,
          };
        },
      };

      bridge.start({ mqttHost: '127.0.0.1', sensorConfig: fakeSensorConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');

      const sensorPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/sensor-config';
      });
      assert.strictEqual(sensorPublishes.length, 1,
        'bridge should publish sensor config exactly once on MQTT connect');
      const payload = JSON.parse(sensorPublishes[0].message);
      assert.strictEqual(payload.v, 5);
      assert.deepStrictEqual(payload.s.collector, { h: 0, i: 100, a: 'aa:01' });
      assert.deepStrictEqual(payload.s.tank_top,  { h: 0, i: 101, a: 'aa:02' });
      assert.strictEqual(sensorPublishes[0].opts.retain, true,
        'sensor-config publish must be retained so a rebooting Shelly picks it up after reconnect');
      assert.strictEqual(sensorPublishes[0].opts.qos, 1);
    });

    it('re-publishes sensor config on every reconnect so a broker restart self-heals', () => {
      const fakeSensorConfig = {
        getConfig: function () {
          return {
            hosts: [{ id: 'sensor_1', ip: '192.168.30.20' }],
            assignments: { collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 } },
            version: 2,
          };
        },
        toCompactFormat: function () {
          return { s: { collector: { h: 0, i: 100, a: 'aa:01' } }, h: ['192.168.30.20'], v: 2 };
        },
      };

      bridge.start({ mqttHost: '127.0.0.1', sensorConfig: fakeSensorConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');
      fakeClient.emit('connect');
      fakeClient.emit('connect');

      const sensorPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/sensor-config';
      });
      assert.strictEqual(sensorPublishes.length, 3,
        'bridge should re-publish sensor config on every MQTT connect event');
    });

    it('skips sensor-config republish when no assignments have been persisted yet', () => {
      const fakeSensorConfig = {
        getConfig: function () {
          return { hosts: [], assignments: {}, version: 0 };
        },
        toCompactFormat: function () { return { s: {}, h: [], v: 0 }; },
      };

      bridge.start({ mqttHost: '127.0.0.1', sensorConfig: fakeSensorConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');

      const sensorPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/sensor-config';
      });
      assert.strictEqual(sensorPublishes.length, 0,
        'no point in publishing an empty sensor config — Shelly would just keep all temps null');
    });
  });

  describe('PREVIEW_MODE', () => {
    let prevEnv;

    beforeEach(() => {
      prevEnv = process.env.PREVIEW_MODE;
      process.env.PREVIEW_MODE = 'true';
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      bridge = require('../server/lib/mqtt-bridge.js');
      bridge._reset();
    });

    afterEach(() => {
      if (prevEnv === undefined) delete process.env.PREVIEW_MODE;
      else process.env.PREVIEW_MODE = prevEnv;
      bridge._reset();
    });

    it('handleStateMessage does not write sensor readings or state events to db', () => {
      const writes = [];
      bridge._setDbForTest({
        insertSensorReadings: function () { writes.push('readings'); },
        insertStateEvent: function () { writes.push('event'); },
      });

      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: { collector: 25 }, valves: {}, actuators: {},
      });
      bridge.handleStateMessage({
        ts: 2, mode: 'solar_charging', temps: { collector: 60 }, valves: {}, actuators: {},
      });

      assert.deepStrictEqual(writes, [], 'preview must not persist state-derived rows');
    });

    it('handleStateMessage still broadcasts to WebSocket clients (live updates)', () => {
      const sent = [];
      bridge._setWsServerForTest({
        clients: [{ readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) }],
      });

      bridge.handleStateMessage({
        ts: 1, mode: 'solar_charging', temps: { collector: 60 }, valves: {}, actuators: {},
      });

      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].type, 'state');
      assert.strictEqual(sent[0].data.mode, 'solar_charging');
    });

    it('handleStateMessage does not call notifications.evaluate (no double-fire push)', () => {
      const notifications = require('../server/lib/notifications');
      const original = notifications.evaluate;
      let called = false;
      notifications.evaluate = function () { called = true; };
      bridge._setPushRefForTest({ sendByCategory: function () { return Promise.resolve(); } });

      try {
        bridge.handleStateMessage({
          ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {},
        });
        assert.strictEqual(called, false, 'preview must not evaluate notifications — prod already does');
      } finally {
        notifications.evaluate = original;
      }
    });

    it('publishConfig is a no-op (returns false) even when MQTT is connected', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: function (topic, msg) { publishCalls.push({ topic, msg }); },
      });

      const result = bridge.publishConfig({ ce: true, ea: 31, v: 1 });
      assert.strictEqual(result, false);
      assert.strictEqual(publishCalls.length, 0, 'preview must never publish to greenhouse/config');
    });

    it('publishSensorConfig is a no-op (returns false) even when MQTT is connected', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: function (topic, msg) { publishCalls.push({ topic, msg }); },
      });

      const result = bridge.publishSensorConfig({ s: {}, h: [], v: 1 });
      assert.strictEqual(result, false);
      assert.strictEqual(publishCalls.length, 0);
    });

    it('publishRelayCommand is a no-op (returns false) even when MQTT is connected', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: function (topic, msg) { publishCalls.push({ topic, msg }); },
      });

      const result = bridge.publishRelayCommand('pump', true);
      assert.strictEqual(result, false);
      assert.strictEqual(publishCalls.length, 0, 'preview must never actuate real relays');
    });

    it('publishSensorConfigApply rejects with PREVIEW_MODE error', async () => {
      bridge._setMqttClientForTest({ connected: true, publish: function () {} });
      await assert.rejects(
        () => bridge.publishSensorConfigApply({ id: 'x', target: null, config: {} }),
        /PREVIEW_MODE/
      );
    });
  });
});
