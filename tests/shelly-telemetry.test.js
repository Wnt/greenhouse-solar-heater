/**
 * Shelly telemetry script behavioral tests.
 *
 * Loads shelly/telemetry.js into a simulated Shelly runtime and verifies
 * that the script correctly handshakes with the server's device-config
 * schema. Catches schema-key drift between server (server/lib/device-config.js)
 * and the on-device script — a class of bug that silently breaks the
 * config push pipeline without any logged error.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const deviceConfig = require('../server/lib/device-config');

const TELEMETRY_PATH = path.join(__dirname, '..', 'shelly', 'telemetry.js');

/**
 * Builds a minimal Shelly runtime sufficient for telemetry.js.
 *
 * Exposes test-side helpers:
 *   publishMqtt(topic, message)  — deliver an MQTT message to subscribed handlers
 *   getKvs(key) / setKvs(key,v)  — inspect / pre-populate device KVS
 *   onEvent(name, fn)            — listen for events emitted by the script
 *   flush()                      — drain pending Shelly.call callbacks (returns a Promise)
 */
function createTelemetryRuntime(options) {
  options = options || {};
  const kvs = Object.assign({}, options.kvs || {});
  const mqttSubscriptions = [];
  const eventHandlers = [];
  const eventListeners = [];
  let mqttConnected = options.mqttConnected !== false;
  let mqttConnectHandler = null;

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
        if (cb) cb(null, { code: 0, body: '' });
        return;
      }
      if (cb) cb(response, null);
    });
  }

  function emitEvent(name, data) {
    const ev = { info: { event: name, data: data } };
    for (let i = 0; i < eventHandlers.length; i++) {
      try { eventHandlers[i](ev); } catch (_e) { /* swallow */ }
    }
    for (let i = 0; i < eventListeners.length; i++) {
      if (eventListeners[i].name === name) {
        try { eventListeners[i].fn(data); } catch (_e) { /* swallow */ }
      }
    }
  }

  const mqtt = {
    subscribe: function (topic, cb) {
      mqttSubscriptions.push({ topic: topic, cb: cb });
    },
    publish: function () {},
    isConnected: function () { return mqttConnected; },
    setConnectHandler: function (cb) { mqttConnectHandler = cb; },
  };

  const globals = {
    Shelly: {
      call: shellyCall,
      emitEvent: emitEvent,
      addEventHandler: function (fn) { eventHandlers.push(fn); },
      addStatusHandler: function () {},
      getComponentStatus: function () { return {}; },
    },
    Timer: { set: function () { return 0; }, clear: function () {} },
    MQTT: mqtt,
    JSON: JSON,
    Date: Date,
    Math: Math,
    parseInt: parseInt,
    print: function () {},
  };

  function loadTelemetry() {
    const src = fs.readFileSync(TELEMETRY_PATH, 'utf8');
    const fn = new Function(
      'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
      src
    );
    fn(globals.Shelly, globals.Timer, globals.MQTT, globals.JSON, globals.Date, globals.Math, globals.parseInt, globals.print);
  }

  function flush() {
    // Drain at least two macrotask cycles so chained Shelly.call setImmediate
    // callbacks (loadConfig → applyConfig → KVS.Set) all complete before assertions.
    return new Promise(function (resolve) {
      setImmediate(function () { setImmediate(function () { setImmediate(resolve); }); });
    });
  }

  return {
    loadTelemetry: loadTelemetry,
    publishMqtt: function (topic, message) {
      for (let i = 0; i < mqttSubscriptions.length; i++) {
        if (mqttSubscriptions[i].topic === topic) {
          mqttSubscriptions[i].cb(topic, message);
        }
      }
    },
    getKvs: function (key) { return kvs[key]; },
    setKvs: function (key, value) { kvs[key] = value; },
    onEvent: function (name, fn) { eventListeners.push({ name: name, fn: fn }); },
    triggerMqttConnect: function () {
      mqttConnected = true;
      if (mqttConnectHandler) mqttConnectHandler();
    },
    flush: flush,
  };
}

describe('shelly/telemetry.js — config sync with server', function () {

  it('applies a fresh greenhouse/config message that uses the server\'s compact `v` schema', async function () {
    const runtime = createTelemetryRuntime({ mqttConnected: true });
    runtime.loadTelemetry();
    await runtime.flush();

    const received = [];
    runtime.onEvent('config_changed', function (data) { received.push(data); });

    // Build a payload using the SERVER'S DEFAULT_CONFIG so the test breaks
    // automatically if the schemas ever drift again.
    const payload = Object.assign({}, deviceConfig.DEFAULT_CONFIG, {
      ce: true,
      ea: 31,
      v: 8,
    });
    runtime.publishMqtt('greenhouse/config', JSON.stringify(payload));
    await runtime.flush();

    assert.strictEqual(received.length, 1,
      'telemetry should emit exactly one config_changed event for a new config');
    assert.deepStrictEqual(received[0].config, payload);
    assert.strictEqual(received[0].safety_critical, true);

    const stored = runtime.getKvs('config');
    assert.ok(stored, 'config should be persisted to KVS so a reboot keeps the new state');
    assert.deepStrictEqual(JSON.parse(stored), payload);
  });

  it('treats a config message with the same `v` as the KVS-stored version as a no-op', async function () {
    const runtime = createTelemetryRuntime({
      mqttConnected: true,
      kvs: { config: JSON.stringify({ ce: true, ea: 31, fm: null, am: null, v: 5 }) },
    });
    runtime.loadTelemetry();
    await runtime.flush();

    const received = [];
    runtime.onEvent('config_changed', function (data) { received.push(data); });

    runtime.publishMqtt(
      'greenhouse/config',
      JSON.stringify({ ce: false, ea: 0, fm: null, am: null, v: 5 })
    );
    await runtime.flush();

    assert.strictEqual(received.length, 0,
      'same version should be idempotent — proves loadConfig() initialized currentVersion from KVS using the right key');
  });

  it('applies a newer `v` even when the previous KVS version is non-zero', async function () {
    const runtime = createTelemetryRuntime({
      mqttConnected: true,
      kvs: { config: JSON.stringify({ ce: false, ea: 0, fm: null, am: null, v: 5 }) },
    });
    runtime.loadTelemetry();
    await runtime.flush();

    const received = [];
    runtime.onEvent('config_changed', function (data) { received.push(data); });

    runtime.publishMqtt(
      'greenhouse/config',
      JSON.stringify({ ce: true, ea: 31, fm: null, am: null, v: 6 })
    );
    await runtime.flush();

    assert.strictEqual(received.length, 1, 'newer version should trigger config_changed');
    assert.strictEqual(received[0].config.v, 6);
    assert.strictEqual(received[0].config.ce, true);
  });

  it('uses the same field names that server/lib/device-config.js uses (regression guard)', function () {
    // Static contract check: every key in the server's DEFAULT_CONFIG must
    // appear in the on-device script. This catches schema drift at the source.
    const src = fs.readFileSync(TELEMETRY_PATH, 'utf8');
    const expectedKeys = Object.keys(deviceConfig.DEFAULT_CONFIG);
    for (let i = 0; i < expectedKeys.length; i++) {
      const key = expectedKeys[i];
      const pattern = new RegExp('\\.' + key + '\\b');
      assert.ok(
        pattern.test(src),
        'shelly/telemetry.js should reference the `' + key + '` field used by server/lib/device-config.js DEFAULT_CONFIG'
      );
    }
  });
});
