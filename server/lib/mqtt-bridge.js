/**
 * MQTT-to-WebSocket bridge.
 * Subscribes to greenhouse/state, decomposes into sensor_readings + state_events,
 * and broadcasts live state to WebSocket clients.
 */

var createLogger = require('./logger');
var log = createLogger('mqtt-bridge');
var { trace } = require('@opentelemetry/api');
var tracer = trace.getTracer('mqtt-bridge');

var mqttClient = null;
var wsServer = null;
var db = null;
var previousState = null;
var connectionStatus = 'disconnected';

function start(options) {
  var mqtt = require('mqtt');
  db = options.db || null;
  wsServer = options.wsServer || null;

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
    var valveNames = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_ret', 'v_air'];
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

function broadcastState(payload) {
  if (!wsServer) return;
  var msg = JSON.stringify({ type: 'state', data: payload });
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
  publishConfig: publishConfig,
  publishSensorConfig: publishSensorConfig,
  handleStateMessage: handleStateMessage,
  detectStateChanges: detectStateChanges,
  _reset: function () {
    mqttClient = null;
    wsServer = null;
    db = null;
    previousState = null;
    connectionStatus = 'disconnected';
  },
};
