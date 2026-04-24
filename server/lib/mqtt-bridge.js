/**
 * MQTT-to-WebSocket bridge.
 * Subscribes to greenhouse/state, decomposes into sensor_readings + state_events,
 * and broadcasts live state to WebSocket clients.
 */

const createLogger = require('./logger');
const log = createLogger('mqtt-bridge');
const { trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('mqtt-bridge');

const notifications = require('./notifications');

let mqttClient = null;
let wsServer = null;
let db = null;
let deviceConfigRef = null;
let sensorConfigRef = null;
let pushRef = null;
let anomalyManagerRef = null;
let stateSnapshotListener = null;
let previousState = null;
let connectionStatus = 'disconnected';

function start(options) {
  const mqtt = require('mqtt');
  db = options.db || null;
  wsServer = options.wsServer || null;
  deviceConfigRef = options.deviceConfig || null;
  sensorConfigRef = options.sensorConfig || null;
  pushRef = options.push || null;
  anomalyManagerRef = options.anomalyManager || null;
  stateSnapshotListener = options.onStateSnapshot || null;

  notifications.init({ push: pushRef, deviceConfig: deviceConfigRef });

  const host = options.mqttHost || process.env.MQTT_HOST || '127.0.0.1';
  const port = options.mqttPort || process.env.MQTT_PORT || 1883;
  const url = 'mqtt://' + host + ':' + port;

  log.info('connecting to MQTT', { url });

  mqttClient = mqtt.connect(url, {
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  mqttClient.on('connect', function () {
    connectionStatus = 'connected';
    log.info('MQTT connected');
    mqttClient.subscribe('greenhouse/state', { qos: 1 }, function (err) {
      if (err) log.error('subscribe failed', { error: err.message });
    });
    mqttClient.subscribe('greenhouse/watchdog/event', { qos: 1 }, function (err) {
      if (err) log.error('subscribe watchdog/event failed', { error: err.message });
    });
    subscribeResponseTopics();
    republishDeviceConfig();
    republishSensorConfig();
    broadcastConnection('connected');
  });

  mqttClient.on('reconnect', function () {
    connectionStatus = 'reconnecting';
    broadcastConnection('reconnecting');
  });

  mqttClient.on('offline', function () {
    connectionStatus = 'disconnected';
    broadcastConnection('disconnected');
  });

  mqttClient.on('close', function () {
    if (connectionStatus !== 'reconnecting') {
      connectionStatus = 'disconnected';
      broadcastConnection('disconnected');
    }
  });

  mqttClient.on('error', function (err) {
    log.error('MQTT error', { error: err.message || String(err), code: err.code || undefined });
  });

  mqttClient.on('message', function (topic, message) {
    if (topic === 'greenhouse/sensor-config-result' || topic === 'greenhouse/discover-sensors-result') {
      handleResponseMessage(topic, message);
      return;
    }
    if (topic === 'greenhouse/watchdog/event') {
      let wdMsg;
      try {
        wdMsg = JSON.parse(message.toString());
      } catch (e) {
        log.warn('invalid JSON on watchdog/event', { error: e.message });
        return;
      }
      if (anomalyManagerRef && typeof anomalyManagerRef.handleDeviceEvent === 'function') {
        Promise.resolve(anomalyManagerRef.handleDeviceEvent(wdMsg)).catch(function (err) {
          log.error('anomaly handleDeviceEvent failed', { error: err.message });
        });
      }
      return;
    }
    if (topic !== 'greenhouse/state') return;

    const span = tracer.startSpan('mqtt.message', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': topic } });
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch (e) {
      log.warn('invalid JSON on greenhouse/state', { error: e.message });
      span.end();
      return;
    }

    handleStateMessage(payload);
    span.end();
  });

  return mqttClient;
}

function handleStateMessage(payload) {
  const ts = payload.ts ? new Date(payload.ts) : new Date();

  // Persist sensor readings
  if (db && payload.temps) {
    db.insertSensorReadings(ts, payload.temps, function (err) {
      if (err) log.error('db insert readings failed', { error: err.message });
    });
  }

  // Detect state changes and persist events
  if (db && previousState) {
    detectStateChanges(ts, previousState, payload);
  }

  previousState = payload;

  // Feed the script-monitor ring buffer so a later crash row captures
  // what the device was doing in the lead-up.
  if (stateSnapshotListener) {
    try { stateSnapshotListener(payload); } catch (e) {
      log.error('state snapshot listener failed', { error: e.message });
    }
  }

  // Evaluate notification conditions (pre-emergency alerts, scheduled reports)
  if (pushRef) {
    try { notifications.evaluate(payload); } catch (e) {
      log.error('notification evaluate failed', { error: e.message });
    }
  }

  // Broadcast to WebSocket clients
  broadcastState(payload);
}

function detectStateChanges(ts, prev, curr, _db) {
  const d = _db || db;
  if (!d) return;
  // Mode changes — record cause (why the transition happened) and a
  // snapshot of the sensor temps at transition time so operators
  // browsing the log can tell "automation fired SOLAR_CHARGING at
  // collector=62 °C" vs "user forced IDLE manually". Both fields are
  // nullable: pre-2026-04-20 payloads don't carry cause; firmware
  // without sensor polling yields null temps.
  if (prev.mode !== curr.mode) {
    const modeOpts = {
      cause: (typeof curr.cause === 'string' && curr.cause) || null,
      // reason is the evaluator's decision code (e.g. "solar_stall").
      // Only meaningful when cause is "automation" or "safety_override";
      // older payloads without the field store null.
      reason: (typeof curr.reason === 'string' && curr.reason) || null,
      sensors: (curr.temps && typeof curr.temps === 'object') ? curr.temps : null,
    };
    d.insertStateEvent(ts, 'mode', 'mode', prev.mode, curr.mode, modeOpts, function (err) {
      if (err) log.error('db insert mode event failed', { error: err.message });
    });
  }

  // Valve changes
  if (prev.valves && curr.valves) {
    const valveNames = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air'];
    for (let i = 0; i < valveNames.length; i++) {
      const v = valveNames[i];
      if (prev.valves[v] !== curr.valves[v]) {
        const oldVal = prev.valves[v] ? 'open' : 'closed';
        const newVal = curr.valves[v] ? 'open' : 'closed';
        d.insertStateEvent(ts, 'valve', v, oldVal, newVal, function (err) {
          if (err) log.error('db insert valve event failed', { error: err.message });
        });
      }
    }
  }

  // Actuator changes
  if (prev.actuators && curr.actuators) {
    const actuatorNames = ['pump', 'fan', 'space_heater', 'immersion_heater'];
    for (let j = 0; j < actuatorNames.length; j++) {
      const a = actuatorNames[j];
      if (prev.actuators[a] !== curr.actuators[a]) {
        const oldA = prev.actuators[a] ? 'on' : 'off';
        const newA = curr.actuators[a] ? 'on' : 'off';
        d.insertStateEvent(ts, 'actuator', a, oldA, newA, function (err) {
          if (err) log.error('db insert actuator event failed', { error: err.message });
        });
      }
    }
  }
}

// Enrich a raw greenhouse/state payload with the manual_override session
// from device config. Pure — safe to call from broadcasts and replays.
function enrichState(payload) {
  if (!deviceConfigRef) return payload;
  const cfg = deviceConfigRef.getConfig();
  if (cfg && cfg.mo && cfg.mo.a) {
    return Object.assign({}, payload, {
      manual_override: {
        active: true,
        expiresAt: cfg.mo.ex,
        forcedMode: cfg.mo.fm || null,
      },
    });
  }
  return Object.assign({}, payload, { manual_override: null });
}

// Returns the most recent enriched state payload, or null if none received yet.
// Used by the WebSocket upgrade handler to give new clients an immediate
// snapshot instead of waiting up to ~30s for the next Shelly publish.
function getLastState() {
  if (!previousState) return null;
  return enrichState(previousState);
}

function broadcastState(payload) {
  if (!wsServer) return;
  const enriched = enrichState(payload);
  const msg = JSON.stringify({ type: 'state', data: enriched });
  wsServer.clients.forEach(function (client) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  });
}

function broadcastConnection(status) {
  if (!wsServer) return;
  const msg = JSON.stringify({ type: 'connection', status });
  wsServer.clients.forEach(function (client) {
    if (client.readyState === 1) {
      client.send(msg);
    }
  });
}

function getConnectionStatus() {
  return connectionStatus;
}

function publishConfig(config) {
  if (!mqttClient || !mqttClient.connected) {
    log.warn('cannot publish config: MQTT not connected');
    return false;
  }
  const span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': 'greenhouse/config' } });
  mqttClient.publish('greenhouse/config', JSON.stringify(config), { qos: 1, retain: true });
  span.end();
  return true;
}

// Re-publish the current device config on every MQTT (re)connect so the
// retained `greenhouse/config` message survives broker restarts. Mosquitto
// in our deploy is a sidecar without persistence — without this, the Shelly
// would never see the latest config until someone manually clicked
// "Save & Push to Device" in the UI.
function republishDeviceConfig() {
  if (!deviceConfigRef) return;
  const cfg = deviceConfigRef.getConfig();
  if (!cfg) return;
  publishConfig(cfg);
}

// Sibling of republishDeviceConfig — the Mosquitto sidecar has no persistence,
// so a broker restart drops the retained greenhouse/sensor-config and the
// Shelly controller would otherwise keep polling whatever role→cid mapping
// its KVS still holds, diverging from the server-side config that the
// sensors tab reads via per-hub scans. Empty-assignments configs are skipped
// — publishing them would tell the controller to stop polling every sensor.
function republishSensorConfig() {
  if (!sensorConfigRef || typeof sensorConfigRef.getConfig !== 'function') return;
  const cfg = sensorConfigRef.getConfig();
  if (!cfg || !cfg.assignments || Object.keys(cfg.assignments).length === 0) return;
  const compact = typeof sensorConfigRef.toCompactFormat === 'function'
    ? sensorConfigRef.toCompactFormat(cfg)
    : null;
  if (!compact) return;
  publishSensorConfig(compact);
}

function publishSensorConfig(config) {
  if (!mqttClient || !mqttClient.connected) {
    log.warn('cannot publish sensor config: MQTT not connected');
    return false;
  }
  const span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': 'greenhouse/sensor-config' } });
  mqttClient.publish('greenhouse/sensor-config', JSON.stringify(config), { qos: 1, retain: true });
  span.end();
  return true;
}

function publishRelayCommand(relay, on) {
  if (!mqttClient || !mqttClient.connected) {
    log.warn('cannot publish relay command: MQTT not connected');
    return false;
  }
  const span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': 'greenhouse/relay-command' } });
  mqttClient.publish('greenhouse/relay-command', JSON.stringify({ relay, on }), { qos: 1, retain: false });
  span.end();
  return true;
}

// NOTE: there is intentionally no publishWatchdogCmd. Watchdog ack
// and shutdownnow round-trip via the existing greenhouse/config
// retained topic — the server PUTs a partial config update with the
// wz[id] (snooze) or wb[modeCode] (ban) field, the device picks it
// up in its existing config_changed handler, and reacts. This avoids
// adding a 6th MQTT subscription to the Shelly device, which has a
// limited subscription budget.

// ── MQTT request/response helpers ──

let pendingRequests = {};

function handleResponseMessage(topic, message) {
  let payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) {
    log.warn('invalid JSON on response topic', { topic, error: e.message });
    return;
  }
  if (!payload || !payload.id) return;
  const pending = pendingRequests[payload.id];
  if (pending) {
    clearTimeout(pending.timer);
    delete pendingRequests[payload.id];
    pending.resolve(payload);
  }
}

function subscribeResponseTopics() {
  if (!mqttClient) return;
  mqttClient.subscribe('greenhouse/sensor-config-result', { qos: 1 });
  mqttClient.subscribe('greenhouse/discover-sensors-result', { qos: 1 });
}

function mqttRequest(requestTopic, responseTopic, payload, timeoutMs) {
  if (!mqttClient || !mqttClient.connected) {
    return Promise.reject(new Error('MQTT not connected'));
  }
  const id = payload.id;
  const span = tracer.startSpan('mqtt.request', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': requestTopic } });

  return new Promise(function (resolve, reject) {
    const timer = setTimeout(function () {
      delete pendingRequests[id];
      span.end();
      reject(new Error('Request timed out'));
    }, timeoutMs || 30000);

    pendingRequests[id] = { resolve: function (result) { span.end(); resolve(result); }, timer };
    mqttClient.publish(requestTopic, JSON.stringify(payload), { qos: 1, retain: false });
  });
}

function publishSensorConfigApply(request) {
  // 60s budget — applying a multi-host config involves GetPeripherals +
  // RemovePeripheral×N + AddPeripheral×M (~1s each) on each hub, plus a
  // Shelly.Reboot on any hub that reports restart_required. 30s was
  // intermittently tight once reboots were added, producing "Failed to
  // fetch" in the client; bumping here gives slack without changing the
  // device-side code.
  return mqttRequest('greenhouse/sensor-config-apply', 'greenhouse/sensor-config-result', request, 60000);
}

function publishDiscoveryRequest(hosts, options) {
  const id = 'disc-' + Date.now();
  const skipTemp = options && options.skipTemp;
  // Without temp polling: ~5s per host (OneWireScan only). With: ~15s per host.
  const perHost = skipTemp ? 8000 : 15000;
  const timeoutMs = Math.max(30000, (hosts ? hosts.length : 1) * perHost);
  const payload = { id, hosts };
  if (skipTemp) payload.skipTemp = true;
  return mqttRequest('greenhouse/discover-sensors', 'greenhouse/discover-sensors-result', payload, timeoutMs);
}

function stop(callback) {
  notifications.stop();
  if (!mqttClient) { if (callback) callback(); return; }
  mqttClient.end(false, {}, function () {
    mqttClient = null;
    previousState = null;
    connectionStatus = 'disconnected';
    if (callback) callback();
  });
}

module.exports = {
  start,
  stop,
  getConnectionStatus,
  getLastState,
  publishConfig,
  publishSensorConfig,
  publishRelayCommand,
  publishSensorConfigApply,
  publishDiscoveryRequest,
  handleStateMessage,
  detectStateChanges,
  _setDeviceConfigRefForTest: function (ref) { deviceConfigRef = ref; },
  _reset: function () {
    mqttClient = null;
    wsServer = null;
    db = null;
    deviceConfigRef = null;
    sensorConfigRef = null;
    pushRef = null;
    previousState = null;
    stateSnapshotListener = null;
    connectionStatus = 'disconnected';
    notifications._reset();
    // Clear any pending requests
    for (const id in pendingRequests) {
      clearTimeout(pendingRequests[id].timer);
    }
    pendingRequests = {};
  },
};
