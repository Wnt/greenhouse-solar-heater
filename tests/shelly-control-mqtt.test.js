/**
 * Shelly merged-control MQTT behavioural tests.
 *
 * Loads the merged shelly/control.js (plus control-logic.js) into a
 * simulated Shelly runtime and verifies the config-push handshake with
 * the server's device-config schema. Catches schema-key drift between
 * server/lib/device-config.js and the on-device script — a class of bug
 * that silently breaks the config push pipeline without any logged error.
 *
 * Formerly tests/shelly-telemetry.test.js; renamed after the Section 2
 * merge collapsed telemetry.js into control.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const deviceConfig = require('../server/lib/device-config');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');
const CONTROL_PATH = path.join(SHELLY_DIR, 'control.js');

function createRuntime(options) {
  options = options || {};
  const kvs = Object.assign({}, options.kvs || {});
  const mqttSubscriptions = [];
  const publishes = [];
  let mqttConnected = options.mqttConnected !== false;
  let mqttConnectHandler = null;
  const timers = [];

  function shellyCall(method, params, cb) {
    setImmediate(function () {
      let response = null;
      if (method === 'KVS.Get') {
        const val = kvs[(params || {}).key];
        response = val !== undefined ? { value: val } : null;
      } else if (method === 'KVS.Set') {
        kvs[(params || {}).key] = (params || {}).value;
        response = {};
      } else if (method === 'HTTP.GET') {
        if (cb) cb({ code: 200, body: '{"tC":20}' }, null);
        return;
      } else if (method === 'Switch.Set' || method === 'Switch.SetConfig') {
        response = {};
      }
      if (cb) cb(response, null);
    });
  }

  const mqtt = {
    subscribe: function (topic, cb) {
      for (let i = 0; i < mqttSubscriptions.length; i++) {
        if (mqttSubscriptions[i].topic === topic) throw new Error('Invalid topic');
      }
      mqttSubscriptions.push({ topic, cb });
    },
    unsubscribe: function (topic) {
      for (let i = mqttSubscriptions.length - 1; i >= 0; i--) {
        if (mqttSubscriptions[i].topic === topic) mqttSubscriptions.splice(i, 1);
      }
    },
    publish: function (topic, payload, qos, retain) {
      publishes.push({ topic, payload, qos, retain });
    },
    isConnected: function () { return mqttConnected; },
    setConnectHandler: function (cb) { mqttConnectHandler = cb; },
  };

  let timerIdCounter = 0;
  function timerSet(ms, repeat, cb) {
    const id = ++timerIdCounter;
    timers.push({ id, ms, repeat, cb });
    return id;
  }
  function timerClear(id) {
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].id === id) timers.splice(i, 1);
  }

  const globals = {
    Shelly: {
      call: shellyCall,
      emitEvent: function () {},
      addEventHandler: function () {},
      addStatusHandler: function () {},
      getComponentStatus: function (type) {
        if (type === 'sys') return { unixtime: Math.floor(Date.now() / 1000) };
        return {};
      },
    },
    Timer: { set: timerSet, clear: timerClear },
    MQTT: mqtt,
    JSON, Date, Math, parseInt,
    print: function () {},
  };

  function loadControl() {
    const files = ['control-logic.js', 'control.js'];
    const src = files.map(f => fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8')).join('\n');
    const fn = new Function(
      'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print', '__TEST_HARNESS',
      src
    );
    fn(globals.Shelly, globals.Timer, globals.MQTT, globals.JSON, globals.Date, globals.Math, globals.parseInt, globals.print, false);
  }

  function flushTimers() {
    for (let round = 0; round < 10; round++) {
      const oneshot = timers.filter(t => !t.repeat);
      if (oneshot.length === 0) return;
      for (const t of oneshot) {
        const idx = timers.findIndex(x => x.id === t.id);
        if (idx >= 0) timers.splice(idx, 1);
        try { t.cb(); } catch (_e) {}
      }
    }
  }

  function settle() {
    return new Promise(resolve => {
      let rounds = 0;
      function loop() {
        flushTimers();
        if (++rounds >= 20) { resolve(); return; }
        setImmediate(loop);
      }
      setImmediate(loop);
    });
  }

  return {
    loadControl,
    publishMqtt: function (topic, message) {
      for (let i = 0; i < mqttSubscriptions.length; i++) {
        if (mqttSubscriptions[i].topic === topic) mqttSubscriptions[i].cb(topic, message);
      }
    },
    getKvs: function (key) { return kvs[key]; },
    setKvs: function (key, value) { kvs[key] = value; },
    getPublishes: function () { return publishes.slice(); },
    triggerMqttConnect: function () {
      mqttConnected = true;
      if (mqttConnectHandler) mqttConnectHandler();
    },
    settle,
  };
}

describe('shelly/control.js — MQTT config sync with server', function () {

  it('applies a fresh greenhouse/config and persists it to KVS', async function () {
    const runtime = createRuntime({ mqttConnected: true });
    runtime.loadControl();
    await runtime.settle();

    const payload = Object.assign({}, deviceConfig.DEFAULT_CONFIG, {
      ce: true,
      ea: 31,
      v: 8,
    });
    runtime.publishMqtt('greenhouse/config', JSON.stringify(payload));
    await runtime.settle();

    const stored = runtime.getKvs('config');
    assert.ok(stored, 'config should be persisted to KVS on receipt');
    assert.deepStrictEqual(JSON.parse(stored), payload);
  });

  it('treats a config message with the same v as a no-op (no KVS re-write)', async function () {
    const seeded = { ce: true, ea: 31, fm: null, am: null, we: {}, wz: {}, wb: {}, v: 5 };
    const runtime = createRuntime({
      mqttConnected: true,
      kvs: { config: JSON.stringify(seeded) },
    });
    runtime.loadControl();
    await runtime.settle();

    // Overwrite with a KVS-fingerprint that we can detect re-writes against.
    runtime.setKvs('config', JSON.stringify(seeded));
    const before = runtime.getKvs('config');

    runtime.publishMqtt(
      'greenhouse/config',
      JSON.stringify({ ce: false, ea: 0, fm: null, am: null, v: 5 })
    );
    await runtime.settle();

    const after = runtime.getKvs('config');
    assert.strictEqual(after, before,
      'same version should be idempotent — proves merged control initialised deviceConfig.v from KVS');
  });

  it('applies a newer v even when the previous KVS version is non-zero', async function () {
    const runtime = createRuntime({
      mqttConnected: true,
      kvs: {
        config: JSON.stringify({ ce: false, ea: 0, fm: null, am: null, we: {}, wz: {}, wb: {}, v: 5 }),
      },
    });
    runtime.loadControl();
    await runtime.settle();

    runtime.publishMqtt(
      'greenhouse/config',
      JSON.stringify({ ce: true, ea: 31, fm: null, am: null, we: {}, wz: {}, wb: {}, v: 6 })
    );
    await runtime.settle();

    const stored = JSON.parse(runtime.getKvs('config'));
    assert.strictEqual(stored.v, 6, 'newer version should be applied');
    assert.strictEqual(stored.ce, true);
  });

  it('uses the same field names that server/lib/device-config.js uses (regression guard)', function () {
    // Static contract check: every key in the server's DEFAULT_CONFIG must
    // appear in the on-device script. Catches schema drift at the source.
    const src = fs.readFileSync(CONTROL_PATH, 'utf8');
    const expectedKeys = Object.keys(deviceConfig.DEFAULT_CONFIG);
    for (const key of expectedKeys) {
      const pattern = new RegExp('\\.' + key + '\\b');
      assert.ok(
        pattern.test(src),
        'shelly/control.js should reference the `' + key + '` field used by server/lib/device-config.js DEFAULT_CONFIG'
      );
    }
  });
});
