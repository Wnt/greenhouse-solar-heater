// Shelly Pro 4PM — Telemetry Script
// MQTT publish/subscribe, config bootstrap (HTTP GET), KVS config persistence
// Communicates with control script via Shelly.emitEvent/addEventHandler
// ES5 compatible — no const/let, no arrow functions

var CONFIG_TOPIC = "greenhouse/config";
var SENSOR_CONFIG_TOPIC = "greenhouse/sensor-config";
// sensor-config-apply and discover-sensors topics were removed:
// the server drives both flows directly over HTTP (see
// server/lib/sensor-apply.js and sensor-discovery.js). Keeping the
// subscriptions here was pure overhead that pushed the Pro 4PM's
// shared JS heap over the edge and OOM'd this telemetry script.
var RELAY_COMMAND_TOPIC = "greenhouse/relay-command";
var STATE_TOPIC = "greenhouse/state";
// Watchdog events are device→server only. There is intentionally NO
// matching watchdog/cmd subscription on the device — user ack and
// shutdownnow commands round-trip via the existing greenhouse/config
// retained topic (the server PUTs a partial wz/wb update). This keeps
// the device under its MQTT subscription budget.
var WATCHDOG_EVENT_TOPIC = "greenhouse/watchdog/event";
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
  // Mode bans (wb) gate evaluate() immediately — changes must trigger a
  // safety-critical re-eval so a newly-enforced ban takes effect on the
  // next tick rather than after an unrelated mode change.
  if (JSON.stringify(oldCfg.wb) !== JSON.stringify(newCfg.wb)) return true;
  // Watchdog enable/disable (we) and snooze (wz) changes do not require
  // an immediate re-eval — they only affect the per-tick detectAnomaly
  // call in control.js, which runs every POLL_INTERVAL anyway. We still
  // reference these fields here so the regression guard in
  // tests/shelly-telemetry.test.js catches schema drift in either
  // direction.
  if (JSON.stringify(oldCfg.we) !== JSON.stringify(newCfg.we)) return false;
  if (JSON.stringify(oldCfg.wz) !== JSON.stringify(newCfg.wz)) return false;
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
  safeSubscribe(RELAY_COMMAND_TOPIC, function(topic, message) {
    if (topic !== RELAY_COMMAND_TOPIC) return;
    try {
      var cmd = JSON.parse(message);
      if (cmd && typeof cmd.relay === "string" && typeof cmd.on === "boolean") {
        Shelly.emitEvent("relay_command", {relay: cmd.relay, on: cmd.on});
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
