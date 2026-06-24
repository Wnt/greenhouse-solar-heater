// MQTT → WebSocket bridge. Subscribes to greenhouse/state, decomposes
// it into sensor_readings + state_events, and broadcasts to WS clients.

const createLogger = require('./logger');
const log = createLogger('mqtt-bridge');
const { trace } = require('@opentelemetry/api');
const tracer = trace.getTracer('mqtt-bridge');

const notifications = require('./notifications');
const relayStatus = require('./relay-status');
const stateEvents = require('./state-events');

// Topic the device publishes its slimmed decision-state payload on
// (Epic #254). The server assembles the full byte-compatible greenhouse/state
// from this + native relay status + device config, then re-publishes it.
const STATE_MIN_TOPIC = 'greenhouse/state/min';
const STATE_TOPIC = 'greenhouse/state';
// Additive sidecar: per-relay freshness/health. NEVER folded into
// greenhouse/state (which stays byte-identical). Retained, server-published,
// PREVIEW_MODE-gated exactly like the greenhouse/state republish.
const RELAY_HEALTH_TOPIC = 'greenhouse/relay-health';

let mqttClient = null;
let wsServer = null;
let db = null;
let deviceConfigRef = null;
let sensorConfigRef = null;
let pushRef = null;
let anomalyManagerRef = null;
let stateSnapshotListener = null;
let previousState = null;
// Per-relay freshness from the PREVIOUS assembled tick (logical-name →
// { status, ageMs }). Threaded into detectStateChanges so a valve/actuator
// state_events row is only written when BOTH the prior and current reads were
// fresh — fallback (stale/missing) reads never fabricate a transition.
let previousFreshness = null;
let connectionStatus = 'disconnected';

// PREVIEW_MODE: this server is a preview/branch deploy that shares the
// production DB and MQTT broker but is NOT the persistence owner. It
// subscribes (so the frontend gets live updates) and broadcasts to its
// own WebSocket clients, but never publishes to MQTT and never writes
// state-derived rows or notifications — those belong to prod.
function isPreviewMode() {
  return process.env.PREVIEW_MODE === 'true';
}

// Persistent, queryable health flag for relay topic-map coverage. In prod we
// throw (start() aborts), so this stays { ok:true } there; it exists for
// preview mode, where we warn-and-continue but still expose the gap.
let relayTopicCoverage = { ok: true, missing: [] };

function getRelayTopicCoverage() {
  return relayTopicCoverage;
}

// #2a: verify RELAY_TOPIC_MAP (or topic_prefix==IP) resolves every device IP in
// RELAY_MAP. Prod → throw (fail loud). Preview → record + log at error, but do
// not abort (preview is a passive observer that may lack the prod map).
function assertRelayTopicCoverage() {
  const cov = relayStatus.checkTopicMapCoverage();
  relayTopicCoverage = cov;
  if (cov.ok) return;
  const msg = 'RELAY_TOPIC_MAP does not resolve every device IP in RELAY_MAP — '
    + 'unmapped relays would silently read false. Missing: ' + cov.missing.join(', ');
  if (isPreviewMode()) {
    log.error('relay topic-map coverage incomplete (preview: continuing)', { missing: cov.missing });
    return;
  }
  throw new Error(msg);
}

function start(options) {
  const mqtt = require('mqtt');
  db = options.db || null;
  wsServer = options.wsServer || null;
  deviceConfigRef = options.deviceConfig || null;
  sensorConfigRef = options.sensorConfig || null;
  pushRef = options.push || null;
  anomalyManagerRef = options.anomalyManager || null;
  stateSnapshotListener = options.onStateSnapshot || null;

  // Fail loud on incomplete relay topic mapping (#2a). An unmapped device's
  // status notifications are silently dropped → every one of its relays falls
  // back to false, rendering a dead/unmapped controller as a confident
  // "closed/off". In prod we refuse to start rather than serve that lie.
  // Preview pods are passive observers (never publish, never persist) and may
  // run without the prod RELAY_TOPIC_MAP, so they only warn.
  assertRelayTopicCoverage();

  notifications.init({ push: pushRef, deviceConfig: deviceConfigRef, db });

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
    mqttClient.subscribe(STATE_MIN_TOPIC, { qos: 1 }, function (err) {
      if (err) log.error('subscribe state/min failed', { error: err.message });
    });
    // Native Shelly Gen2 per-switch status — the source of valves/actuators.
    mqttClient.subscribe(relayStatus.STATUS_WILDCARD, { qos: 1 }, function (err) {
      if (err) log.error('subscribe relay status failed', { error: err.message });
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
    // Native Shelly relay status → cache (the source of valves/actuators).
    if (relayStatus.parseStatusTopic(topic)) {
      let body;
      try {
        body = JSON.parse(message.toString());
      } catch (e) {
        log.warn('invalid JSON on relay status topic', { topic, error: e.message });
        return;
      }
      relayStatus.ingestStatus(topic, body);
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
      // PREVIEW_MODE: anomaly manager writes a watchdog row to history and
      // dispatches a push — both belong to prod. The preview's WS clients
      // still see the watchdog state via the next greenhouse/state payload.
      if (!isPreviewMode() && anomalyManagerRef && typeof anomalyManagerRef.handleDeviceEvent === 'function') {
        Promise.resolve(anomalyManagerRef.handleDeviceEvent(wdMsg)).catch(function (err) {
          log.error('anomaly handleDeviceEvent failed', { error: err.message });
        });
      }
      return;
    }
    if (topic !== STATE_MIN_TOPIC) return;

    const span = tracer.startSpan('mqtt.message', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': topic } });
    let minPayload;
    try {
      minPayload = JSON.parse(message.toString());
    } catch (e) {
      log.warn('invalid JSON on ' + STATE_MIN_TOPIC, { error: e.message });
      span.end();
      return;
    }

    handleStateMin(minPayload);
    span.end();
  });

  return mqttClient;
}

// Assemble the full, byte-compatible greenhouse/state from a device-minimal
// payload (greenhouse/state/min) + native relay status + device config, then:
//   1. re-publish to greenhouse/state (retained; gated by PREVIEW_MODE), and
//   2. feed it through the EXISTING handleStateMessage pipeline unchanged
//      (insertSensorReadings, detectStateChanges, enrichState, broadcast,
//      notifications, anomaly ring buffer).
function handleStateMin(minPayload) {
  let controlsEnabled = false;
  // manual_override is recomputed from device config so the RE-PUBLISHED
  // retained greenhouse/state is itself complete (matches what the device
  // used to emit). For WS clients, enrichState recomputes it again at
  // broadcast time and OVERWRITES this value, so the two never diverge.
  let manualOverride = null;
  if (deviceConfigRef && typeof deviceConfigRef.getConfig === 'function') {
    const cfg = deviceConfigRef.getConfig();
    if (cfg && typeof cfg.ce !== 'undefined') controlsEnabled = !!cfg.ce;
    if (cfg && cfg.mo && cfg.mo.a) {
      manualOverride = { active: true, expiresAt: cfg.mo.ex, forcedMode: cfg.mo.fm || null };
    }
  }

  const result = relayStatus.assembleState(minPayload, {
    previousState,
    controlsEnabled,
    manualOverride,
  });
  const assembled = result.payload;
  const freshness = result.freshness;

  // Re-publish the complete retained state so late subscribers / debuggers /
  // preview pods see the full picture. NEW publish — gated by PREVIEW_MODE.
  if (!isPreviewMode() && mqttClient && mqttClient.connected) {
    const span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': STATE_TOPIC } });
    try {
      mqttClient.publish(STATE_TOPIC, JSON.stringify(assembled), { qos: 1, retain: true });
    } catch (e) {
      log.error('re-publish greenhouse/state failed', { error: e.message });
    }
    span.end();
  }

  // Sidecar: publish relay-health (retained MQTT topic) + broadcast a separate
  // WS frame. greenhouse/state itself is untouched. Done AFTER the state
  // republish; the WS relay_health frame is broadcast right after the state
  // frame inside handleStateMessage's pipeline (see below).
  publishRelayHealth(freshness, assembled.ts);

  handleStateMessage(assembled, freshness);
}

// Publish the per-relay freshness sidecar to the retained greenhouse/relay-health
// MQTT topic. PREVIEW_MODE-gated exactly like the greenhouse/state republish.
function publishRelayHealth(freshness, ts) {
  if (isPreviewMode() || !mqttClient || !mqttClient.connected) return;
  const span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': RELAY_HEALTH_TOPIC } });
  try {
    mqttClient.publish(RELAY_HEALTH_TOPIC, JSON.stringify({ ts, relays: freshness }), { qos: 1, retain: true });
  } catch (e) {
    log.error('publish greenhouse/relay-health failed', { error: e.message });
  }
  span.end();
}

// Broadcast the relay-health sidecar as a separate WS frame (type:relay_health).
function broadcastRelayHealth(freshness, ts) {
  if (!wsServer || !freshness) return;
  const msg = JSON.stringify({ type: 'relay_health', data: { ts, relays: freshness } });
  wsServer.clients.forEach(function (client) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  });
}

// `freshness` (optional) is the per-relay freshness map from assembleState for
// THIS tick. When present it is threaded into detectStateChanges (#3) and
// broadcast as the relay_health sidecar. Absent for direct handleStateMessage
// callers (tests / legacy full-state paths) — those skip freshness gating and
// fall back to the prior diff-everything behaviour, which is correct because
// they carry device-authored valves/actuators (no relay-cache convergence).
function handleStateMessage(payload, freshness) {
  const ts = payload.ts ? new Date(payload.ts) : new Date();
  const preview = isPreviewMode();

  // Persist sensor readings (skipped in PREVIEW_MODE — prod owns this)
  if (db && payload.temps && !preview) {
    db.insertSensorReadings(ts, payload.temps, function (err) {
      if (err) log.error('db insert readings failed', { error: err.message });
    });
  }

  // Detect state changes and persist events (skipped in PREVIEW_MODE)
  if (db && previousState && !preview) {
    stateEvents.detectStateChanges(ts, previousState, payload, db, previousFreshness, freshness);
  }

  previousState = payload;
  if (typeof freshness !== 'undefined') previousFreshness = freshness;

  // Feed the script-monitor ring buffer so a later crash row captures
  // what the device was doing in the lead-up.
  if (stateSnapshotListener) {
    try { stateSnapshotListener(payload); } catch (e) {
      log.error('state snapshot listener failed', { error: e.message });
    }
  }

  // Evaluate notification conditions (skipped in PREVIEW_MODE — prod
  // already evaluates and dispatches; running this in parallel would
  // double-fire push notifications to subscribers).
  if (pushRef && !preview) {
    try { notifications.evaluate(payload); } catch (e) {
      log.error('notification evaluate failed', { error: e.message });
    }
  }

  // Broadcast to WebSocket clients (always — this is what makes preview
  // dashboards tick in real time).
  broadcastState(payload);
  // Sidecar WS frame right after the state frame (additive; clients that don't
  // know the type ignore it). Only when this tick carried freshness.
  if (typeof freshness !== 'undefined') broadcastRelayHealth(freshness, payload.ts);
}

// Thin delegate to the extracted state-events module. Kept on the bridge's
// public surface because direct callers (tests, legacy full-state paths) invoke
// bridge.detectStateChanges(ts, prev, curr, _db, …) and rely on the `_db || db`
// fallback to the module-level db handle. The freshness-gating contract (#3)
// lives in state-events.js.
function detectStateChanges(ts, prev, curr, _db, prevFreshness, currFreshness) {
  stateEvents.detectStateChanges(ts, prev, curr, _db || db, prevFreshness, currFreshness);
}

// Adds manual_override (from device config) to a greenhouse/state payload.
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

// Latest enriched state (or null) — sent on WebSocket upgrade so new
// clients see something immediately instead of waiting ~30 s for the
// next Shelly publish.
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
  if (isPreviewMode()) {
    log.warn('skipping publish (PREVIEW_MODE)', { topic: 'greenhouse/config' });
    return false;
  }
  if (!mqttClient || !mqttClient.connected) {
    log.warn('cannot publish config: MQTT not connected');
    return false;
  }
  const span = tracer.startSpan('mqtt.publish', { attributes: { 'messaging.system': 'mqtt', 'messaging.destination': 'greenhouse/config' } });
  mqttClient.publish('greenhouse/config', JSON.stringify(config), { qos: 1, retain: true });
  span.end();
  return true;
}

// Re-publish on every MQTT (re)connect — Mosquitto runs as a sidecar
// without persistence, so a broker restart drops the retained
// greenhouse/config and greenhouse/sensor-config and we'd otherwise
// only push them again on the next manual config edit.
function republishDeviceConfig() {
  if (!deviceConfigRef) return;
  const cfg = deviceConfigRef.getConfig();
  if (!cfg) return;
  publishConfig(cfg);
}

// Empty-assignments configs are skipped — publishing one would tell
// the controller to stop polling every sensor.
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
  if (isPreviewMode()) {
    log.warn('skipping publish (PREVIEW_MODE)', { topic: 'greenhouse/sensor-config' });
    return false;
  }
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
  if (isPreviewMode()) {
    log.warn('skipping publish (PREVIEW_MODE)', { topic: 'greenhouse/relay-command' });
    return false;
  }
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
  if (isPreviewMode()) {
    log.warn('skipping request (PREVIEW_MODE)', { topic: requestTopic });
    return Promise.reject(new Error('PREVIEW_MODE: request blocked'));
  }
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
    previousFreshness = null;
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
  handleStateMin,
  detectStateChanges,
  assertRelayTopicCoverage,
  getRelayTopicCoverage,
  _setDeviceConfigRefForTest: function (ref) { deviceConfigRef = ref; },
  _setDbForTest: function (val) { db = val; },
  _setWsServerForTest: function (val) { wsServer = val; },
  _setPushRefForTest: function (val) { pushRef = val; },
  _setMqttClientForTest: function (val) { mqttClient = val; },
  _reset: function () {
    mqttClient = null;
    wsServer = null;
    db = null;
    deviceConfigRef = null;
    sensorConfigRef = null;
    pushRef = null;
    previousState = null;
    previousFreshness = null;
    stateSnapshotListener = null;
    connectionStatus = 'disconnected';
    relayTopicCoverage = { ok: true, missing: [] };
    notifications._reset();
    relayStatus.reset();
    // Clear any pending requests
    for (const id in pendingRequests) {
      clearTimeout(pendingRequests[id].timer);
    }
    pendingRequests = {};
  },
};
