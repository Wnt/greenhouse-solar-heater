// Shelly Pro 4PM — Telemetry Script
// MQTT publish/subscribe, config bootstrap (HTTP GET), KVS config persistence
// Communicates with control script via Shelly.emitEvent/addEventHandler
// ES5 compatible — no const/let, no arrow functions

var CONFIG_TOPIC = "greenhouse/config";
var STATE_TOPIC = "greenhouse/state";
var CONFIG_KVS_KEY = "config";
var CONFIG_URL = "";  // Set via KVS "config_url" or default

var currentVersion = 0;

// ── Config management ──

function loadConfig(cb) {
  Shelly.call("KVS.Get", {key: CONFIG_KVS_KEY}, function(res) {
    if (res && res.value) {
      try {
        var cfg = JSON.parse(res.value);
        currentVersion = cfg.version || 0;
        if (cb) cb(cfg);
        return;
      } catch(e) {}
    }
    if (cb) cb(null);
  });
}

function saveConfig(cfg) {
  currentVersion = cfg.version || 0;
  Shelly.call("KVS.Set", {key: CONFIG_KVS_KEY, value: JSON.stringify(cfg)});
}

function isSafetyCritical(oldCfg, newCfg) {
  if (!oldCfg) return true;
  if (oldCfg.ce !== newCfg.ce) return true;
  if (oldCfg.ea !== newCfg.ea) return true;
  if (oldCfg.fm !== newCfg.fm) return true;
  if (JSON.stringify(oldCfg.am) !== JSON.stringify(newCfg.am)) return true;
  return false;
}

function applyConfig(newCfg, oldCfg) {
  if (newCfg.version === currentVersion) return;
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
        if (cfg.version && cfg.version !== currentVersion) {
          loadConfig(function(oldCfg) {
            applyConfig(cfg, oldCfg);
          });
        }
      } catch(e) {}
    });
  });
}

// ── MQTT config subscription ──

function setupMqttSubscription() {
  if (!MQTT.isConnected()) return;
  MQTT.subscribe(CONFIG_TOPIC, function(topic, message) {
    if (topic !== CONFIG_TOPIC) return;
    try {
      var newCfg = JSON.parse(message);
      if (newCfg.version && newCfg.version !== currentVersion) {
        loadConfig(function(oldCfg) {
          applyConfig(newCfg, oldCfg);
        });
      }
    } catch(e) {}
  });
}

// ── MQTT state publishing ──

Shelly.addEventHandler(function(ev) {
  if (!ev || !ev.info || ev.info.event !== "state_updated") return;
  var snapshot = ev.info.data;
  if (!snapshot) return;
  if (!MQTT.isConnected()) return;
  MQTT.publish(STATE_TOPIC, JSON.stringify(snapshot), 1, true);
});

// ── MQTT connection handler ──

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
