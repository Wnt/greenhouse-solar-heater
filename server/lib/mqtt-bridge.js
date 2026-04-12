/**
 * MQTT-to-WebSocket bridge.
 * Subscribes to greenhouse/state, decomposes into sensor_readings + state_events,
 * and broadcasts live state to WebSocket clients.
 */

var createLogger = require('./logger');
var log = createLogger('mqtt-bridge');
var { trace } = require('@opentelemetry/api');
var tracer = trace.getTracer('mqtt-bridge');

var notifications = require('./notifications');

var mqttClient = null;
var wsServer = null;
var db = null;
var deviceConfigRef = null;
var pushRef = null;
var previousState = null;
var connectionStatus = 'disconnected';

function start(options) {
  var mqtt = require('mqtt');
  db = options.db || null;
  wsServer = options.wsServer || null;
  deviceConfigRef = options.deviceConfig || null;
  pushRef = options.push || null;

  notifications.init({ push: pushRef, deviceConfig: deviceConfigRef });

  var host = options.mqttHost || process.env.MQTT_HOST || '127.0.0.1';
  var port = options.mqttPort || process.env.MQTT_PORT || 1883;
  var url = 'mqtt://' + host + ':' + port;

  log.info('connecting to MQTT', { url: url });

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
    subscribeResponseTopics();
    republishDeviceConfig();
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
    if (topic !== 'greenhouse/state') return;

    var span = tracer.startSpan('mqtt.message', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': topic } });
    var payload;
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
  var ts = payload.ts ? new Date(payload.ts) : new Date();

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
  var d = _db || db;
  if (!d) return;
  // Mode changes
  if (prev.mode !== curr.mode) {
    d.insertStateEvent(ts, 'mode', 'mode', prev.mode, curr.mode, function (err) {
      if (err) log.error('db insert mode event failed', { error: err.message });
    });
  }

  // Valve changes
  if (prev.valves && curr.valves) {
    var valveNames = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air'];
    for (var i = 0; i < valveNames.length; i++) {
      var v = valveNames[i];
      if (prev.valves[v] !== curr.valves[v]) {
        var oldVal = prev.valves[v] ? 'open' : 'closed';
        var newVal = curr.valves[v] ? 'open' : 'closed';
        d.insertStateEvent(ts, 'valve', v, oldVal, newVal, function (err) {
          if (err) log.error('db insert valve event failed', { error: err.message });
        });
      }
    }
  }

  // Actuator changes
  if (prev.actuators && curr.actuators) {
    var actuatorNames = ['pump', 'fan', 'space_heater', 'immersion_heater'];
    for (var j = 0; j < actuatorNames.length; j++) {
      var a = actuatorNames[j];
      if (prev.actuators[a] !== curr.actuators[a]) {
        var oldA = prev.actuators[a] ? 'on' : 'off';
        var newA = curr.actuators[a] ? 'on' : 'off';
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
  var cfg = deviceConfigRef.getConfig();
  if (cfg && cfg.mo && cfg.mo.a) {
    return Object.assign({}, payload, {
      manual_override: { active: true, expiresAt: cfg.mo.ex, suppressSafety: cfg.mo.ss },
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
  var enriched = enrichState(payload);
  var msg = JSON.stringify({ type: 'state', data: enriched });
  wsServer.clients.forEach(function (client) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  });
}

function broadcastConnection(status) {
  if (!wsServer) return;
  var msg = JSON.stringify({ type: 'connection', status: status });
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
  var span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': 'greenhouse/config' } });
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
  var cfg = deviceConfigRef.getConfig();
  if (!cfg) return;
  publishConfig(cfg);
}

function publishSensorConfig(config) {
  if (!mqttClient || !mqttClient.connected) {
    log.warn('cannot publish sensor config: MQTT not connected');
    return false;
  }
  var span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': 'greenhouse/sensor-config' } });
  mqttClient.publish('greenhouse/sensor-config', JSON.stringify(config), { qos: 1, retain: true });
  span.end();
  return true;
}

function publishRelayCommand(relay, on) {
  if (!mqttClient || !mqttClient.connected) {
    log.warn('cannot publish relay command: MQTT not connected');
    return false;
  }
  var span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': 'greenhouse/relay-command' } });
  mqttClient.publish('greenhouse/relay-command', JSON.stringify({ relay: relay, on: on }), { qos: 1, retain: false });
  span.end();
  return true;
}

// ── MQTT request/response helpers ──

var pendingRequests = {};

function handleResponseMessage(topic, message) {
  var payload;
  try {
    payload = JSON.parse(message.toString());
  } catch (e) {
    log.warn('invalid JSON on response topic', { topic: topic, error: e.message });
    return;
  }
  if (!payload || !payload.id) return;
  var pending = pendingRequests[payload.id];
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
  var id = payload.id;
  var span = tracer.startSpan('mqtt.request', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': requestTopic } });

  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () {
      delete pendingRequests[id];
      span.end();
      reject(new Error('Request timed out'));
    }, timeoutMs || 30000);

    pendingRequests[id] = { resolve: function (result) { span.end(); resolve(result); }, timer: timer };
    mqttClient.publish(requestTopic, JSON.stringify(payload), { qos: 1, retain: false });
  });
}

function publishSensorConfigApply(request) {
  return mqttRequest('greenhouse/sensor-config-apply', 'greenhouse/sensor-config-result', request, 30000);
}

function publishDiscoveryRequest(hosts, options) {
  var id = 'disc-' + Date.now();
  var skipTemp = options && options.skipTemp;
  // Without temp polling: ~5s per host (OneWireScan only). With: ~15s per host.
  var perHost = skipTemp ? 8000 : 15000;
  var timeoutMs = Math.max(30000, (hosts ? hosts.length : 1) * perHost);
  var payload = { id: id, hosts: hosts };
  if (skipTemp) payload.skipTemp = true;
  return mqttRequest('greenhouse/discover-sensors', 'greenhouse/discover-sensors-result', payload, timeoutMs);
}

function stop(callback) {
  if (!mqttClient) { if (callback) callback(); return; }
  mqttClient.end(false, {}, function () {
    mqttClient = null;
    previousState = null;
    connectionStatus = 'disconnected';
    if (callback) callback();
  });
}

module.exports = {
  start: start,
  stop: stop,
  getConnectionStatus: getConnectionStatus,
  getLastState: getLastState,
  publishConfig: publishConfig,
  publishSensorConfig: publishSensorConfig,
  publishRelayCommand: publishRelayCommand,
  publishSensorConfigApply: publishSensorConfigApply,
  publishDiscoveryRequest: publishDiscoveryRequest,
  handleStateMessage: handleStateMessage,
  detectStateChanges: detectStateChanges,
  _setDeviceConfigRefForTest: function (ref) { deviceConfigRef = ref; },
  _reset: function () {
    mqttClient = null;
    wsServer = null;
    db = null;
    deviceConfigRef = null;
    pushRef = null;
    previousState = null;
    connectionStatus = 'disconnected';
    notifications._reset();
    // Clear any pending requests
    for (var id in pendingRequests) {
      clearTimeout(pendingRequests[id].timer);
    }
    pendingRequests = {};
  },
};
