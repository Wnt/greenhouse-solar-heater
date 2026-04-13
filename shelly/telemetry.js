// Shelly Pro 4PM — Telemetry Script
// MQTT publish/subscribe, config bootstrap (HTTP GET), KVS config persistence
// Communicates with control script via Shelly.emitEvent/addEventHandler
// ES5 compatible — no const/let, no arrow functions

var CONFIG_TOPIC = "greenhouse/config";
var SENSOR_CONFIG_TOPIC = "greenhouse/sensor-config";
var SENSOR_CONFIG_APPLY_TOPIC = "greenhouse/sensor-config-apply";
var SENSOR_CONFIG_RESULT_TOPIC = "greenhouse/sensor-config-result";
var DISCOVER_TOPIC = "greenhouse/discover-sensors";
var DISCOVER_RESULT_TOPIC = "greenhouse/discover-sensors-result";
var RELAY_COMMAND_TOPIC = "greenhouse/relay-command";
var STATE_TOPIC = "greenhouse/state";
var WATCHDOG_EVENT_TOPIC = "greenhouse/watchdog/event";
var WATCHDOG_CMD_TOPIC = "greenhouse/watchdog/cmd";
var CONFIG_KVS_KEY = "config";
var SENSOR_CONFIG_KVS_KEY = "sensor_config";
var CONFIG_URL = "";  // Set via KVS "config_url" or default

var currentVersion = 0;
var currentSensorVersion = 0;

// ── Config management ──

function loadConfig(cb) {
  Shelly.call("KVS.Get", {key: CONFIG_KVS_KEY}, function(res) {
    if (res && res.value) {
      try {
        var cfg = JSON.parse(res.value);
        currentVersion = cfg.v || 0;
        if (cb) cb(cfg);
        return;
      } catch(e) {}
    }
    if (cb) cb(null);
  });
}

function saveConfig(cfg) {
  currentVersion = cfg.v || 0;
  Shelly.call("KVS.Set", {key: CONFIG_KVS_KEY, value: JSON.stringify(cfg)});
}

function isSafetyCritical(oldCfg, newCfg) {
  if (!oldCfg) return true;
  if (oldCfg.ce !== newCfg.ce) return true;
  if (oldCfg.ea !== newCfg.ea) return true;
  if (oldCfg.fm !== newCfg.fm) return true;
  if (JSON.stringify(oldCfg.wb) !== JSON.stringify(newCfg.wb)) return true;
  return false;
}

function applyConfig(newCfg, oldCfg) {
  if (newCfg.v === currentVersion) return;
  var critical = isSafetyCritical(oldCfg, newCfg);
  saveConfig(newCfg);
  Shelly.emitEvent("config_changed", {
    config: newCfg,
    safety_critical: critical,
  });
}

// ── HTTP config bootstrap ──

function bootstrapConfig() {
  Shelly.call("KVS.Get", {key: "config_url"}, function(res) {
    var url = (res && res.value) ? res.value : "";
    if (!url) return;
    CONFIG_URL = url;

    Shelly.call("HTTP.GET", {url: url, timeout: 10}, function(httpRes, err) {
      if (err || !httpRes || httpRes.code !== 200 || !httpRes.body) return;
      try {
        var cfg = JSON.parse(httpRes.body);
        if (cfg.v && cfg.v !== currentVersion) {
          loadConfig(function(oldCfg) {
            applyConfig(cfg, oldCfg);
          });
        }
      } catch(e) {}
    });
  });
}

// ── Sensor config management ──

function loadSensorConfig(cb) {
  Shelly.call("KVS.Get", {key: SENSOR_CONFIG_KVS_KEY}, function(res) {
    if (res && res.value) {
      try {
        var cfg = JSON.parse(res.value);
        currentSensorVersion = cfg.v || 0;
        if (cb) cb(cfg);
        return;
      } catch(e) {}
    }
    if (cb) cb(null);
  });
}

function saveSensorConfig(cfg) {
  currentSensorVersion = cfg.v || 0;
  Shelly.call("KVS.Set", {key: SENSOR_CONFIG_KVS_KEY, value: JSON.stringify(cfg)});
}

function applySensorConfig(newCfg) {
  if (newCfg.v === currentSensorVersion) return;
  saveSensorConfig(newCfg);
  Shelly.emitEvent("sensor_config_changed", {
    config: newCfg,
  });
}

// ── MQTT config subscription ──

var mqttSubscribed = false;

// Wrap a single subscribe so a "Invalid topic" throw (e.g. from
// re-subscribing to a topic Shelly already has registered) cannot kill
// the script. Real Shelly devices throw on duplicate subscribe even
// though our guard flag should prevent it — defense in depth.
function safeSubscribe(topic, cb) {
  try {
    MQTT.subscribe(topic, cb);
  } catch (e) {
    // Already subscribed in this Shelly session — safe to ignore.
  }
}

function setupMqttSubscription() {
  if (!MQTT.isConnected()) return;
  if (mqttSubscribed) return;
  mqttSubscribed = true;
  safeSubscribe(CONFIG_TOPIC, function(topic, message) {
    if (topic !== CONFIG_TOPIC) return;
    try {
      var newCfg = JSON.parse(message);
      if (newCfg.v && newCfg.v !== currentVersion) {
        loadConfig(function(oldCfg) {
          applyConfig(newCfg, oldCfg);
        });
      }
    } catch(e) {}
  });
  safeSubscribe(SENSOR_CONFIG_TOPIC, function(topic, message) {
    if (topic !== SENSOR_CONFIG_TOPIC) return;
    try {
      var newCfg = JSON.parse(message);
      if (newCfg.v && newCfg.v !== currentSensorVersion) {
        applySensorConfig(newCfg);
      }
    } catch(e) {}
  });
  safeSubscribe(SENSOR_CONFIG_APPLY_TOPIC, function(topic, message) {
    if (topic !== SENSOR_CONFIG_APPLY_TOPIC) return;
    try {
      var req = JSON.parse(message);
      if (req && req.id) {
        Shelly.emitEvent("sensor_config_apply", {request: req});
      }
    } catch(e) {}
  });
  safeSubscribe(DISCOVER_TOPIC, function(topic, message) {
    if (topic !== DISCOVER_TOPIC) return;
    try {
      var req = JSON.parse(message);
      if (req && req.id) {
        Shelly.emitEvent("discover_sensors", {request: req});
      }
    } catch(e) {}
  });
  safeSubscribe(RELAY_COMMAND_TOPIC, function(topic, message) {
    if (topic !== RELAY_COMMAND_TOPIC) return;
    try {
      var cmd = JSON.parse(message);
      if (cmd && typeof cmd.relay === "string" && typeof cmd.on === "boolean") {
        Shelly.emitEvent("relay_command", {relay: cmd.relay, on: cmd.on});
      }
    } catch(e) {}
  });
  safeSubscribe(WATCHDOG_CMD_TOPIC, function(topic, message) {
    if (topic !== WATCHDOG_CMD_TOPIC) return;
    try {
      var cmd = JSON.parse(message);
      if (cmd && typeof cmd.t === "string") {
        Shelly.emitEvent("watchdog_cmd", cmd);
      }
    } catch(e) {}
  });
}

// ── MQTT state publishing ──

Shelly.addEventHandler(function(ev) {
  if (!ev || !ev.info) return;
  if (ev.info.event === "state_updated") {
    var snapshot = ev.info.data;
    if (!snapshot) return;
    if (!MQTT.isConnected()) return;
    MQTT.publish(STATE_TOPIC, JSON.stringify(snapshot), 1, true);
  } else if (ev.info.event === "sensor_config_apply_result") {
    var applyResult = ev.info.data;
    if (!applyResult || !MQTT.isConnected()) return;
    MQTT.publish(SENSOR_CONFIG_RESULT_TOPIC, JSON.stringify(applyResult), 1, false);
  } else if (ev.info.event === "discover_sensors_result") {
    var discResult = ev.info.data;
    if (!discResult || !MQTT.isConnected()) return;
    MQTT.publish(DISCOVER_RESULT_TOPIC, JSON.stringify(discResult), 1, false);
  } else if (ev.info.event === "watchdog_event") {
    var wdPayload = ev.info.data;
    if (!wdPayload || !MQTT.isConnected()) return;
    MQTT.publish(WATCHDOG_EVENT_TOPIC, JSON.stringify(wdPayload), 1, false);
  }
});

// ── MQTT connection handler ──

// Shelly's MQTT client maintains its subscriptions across (re)connects, so
// we do NOT clear the guard flag here. Resetting it caused setupMqttSubscription
// to re-call MQTT.subscribe on already-subscribed topics, which throws
// "Invalid topic" and crashes the script — symptom: relay commands stop
// reaching the controller because the topic handler is dead.
MQTT.setConnectHandler(function() {
  setupMqttSubscription();
});

// ── Boot ──

function bootTelemetry() {
  loadConfig(function() {
    bootstrapConfig();
    if (MQTT.isConnected()) {
      setupMqttSubscription();
    }
  });
}

bootTelemetry();
