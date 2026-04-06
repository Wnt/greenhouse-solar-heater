// Shelly Pro 4PM — Solar Thermal Greenhouse Control (Shell)
// All decision logic is in control-logic.js (concatenated at deploy time)
// This file handles: timers, RPC, relays, KVS, sensors, config, events

var SHELL_CFG = {
  POLL_INTERVAL: 30000,
  VALVE_SETTLE_MS: 1000,
  PUMP_PRIME_MS: 5000,
  DRAIN_MONITOR_INTERVAL: 200,
  DRAIN_POWER_THRESHOLD: 20,
};

var VALVES = {
  vi_btm:  {ip: "192.168.30.11", id: 0},
  vi_top:  {ip: "192.168.30.11", id: 1},
  vi_coll: {ip: "192.168.30.12", id: 0},
  vo_coll: {ip: "192.168.30.12", id: 1},
  vo_rad:  {ip: "192.168.30.13", id: 0},
  vo_tank: {ip: "192.168.30.13", id: 1},
  v_ret:   {ip: "192.168.30.14", id: 0},
  v_air:   {ip: "192.168.30.14", id: 1},
};

// Sensor config — loaded from KVS on boot, updated via sensor_config_changed events
// Compact format: s={role:{h:hostIndex,i:componentId},...}, h=[hostIp,...], v=version
// If null, sensor polling is skipped (all temps stay null → IDLE mode, safe default)
var sensorConfig = null;

// Device config — loaded from KVS on boot, updated via events from telemetry script
// Compact config: ce=controls_enabled, ea=actuator bitmask, fm=forced_mode, am=allowed_modes, v=version
var deviceConfig = { ce: false, ea: 0, fm: null, am: null, v: 0 };

var state = {
  mode: MODES.IDLE,
  mode_start: 0,
  temps: {
    collector: null, tank_top: null, tank_bottom: null,
    greenhouse: null, outdoor: null,
  },
  sensor_last_valid: {
    collector: 0, tank_top: 0, tank_bottom: 0,
    greenhouse: 0, outdoor: 0,
  },
  collectors_drained: false,
  last_refill_attempt: 0,
  emergency_heating_active: false,
  last_error: null,
  valve_states: {},
  pump_on: false,
  fan_on: false,
  space_heater_on: false,
  immersion_heater_on: false,
  transitioning: false,
  drain_timer: null,
};

// ── Actuator commands with config guards ──

function setPump(on) {
  if (on && !deviceConfig.ce) { state.pump_on = false; return; }
  if (on && !(deviceConfig.ea & EA_PUMP)) { state.pump_on = false; return; }
  Shelly.call("Switch.Set", {id: 0, on: on});
  state.pump_on = on;
}

function setFan(on) {
  if (on && !deviceConfig.ce) return;
  if (on && !(deviceConfig.ea & EA_FAN)) return;
  Shelly.call("Switch.Set", {id: 1, on: on});
  state.fan_on = on;
}

function setImmersion(on) {
  if (on && !deviceConfig.ce) return;
  if (on && !(deviceConfig.ea & EA_IMMERSION)) return;
  Shelly.call("Switch.Set", {id: 2, on: on});
  state.immersion_heater_on = on;
}

function setSpaceHeater(on) {
  if (on && !deviceConfig.ce) return;
  if (on && !(deviceConfig.ea & EA_SPACE_HEATER)) return;
  Shelly.call("Switch.Set", {id: 3, on: on});
  state.space_heater_on = on;
}

function setValve(name, open, cb) {
  if (open && !deviceConfig.ce) { if (cb) cb(true); return; }
  if (open && !(deviceConfig.ea & EA_VALVES)) { if (cb) cb(true); return; }
  var v = VALVES[name];
  // V_air physical actuator is normally-open (de-energized = open) for fail-safe
  // drain on power loss. Invert the relay command so logical true=open works.
  var cmd = (name === "v_air") ? !open : open;
  var url = "http://" + v.ip + "/rpc/Switch.Set?id=" + v.id +
    "&on=" + (cmd ? "true" : "false");
  Shelly.call("HTTP.GET", {url: url}, function(res, err) {
    if (err || !res || res.code !== 200) {
      Shelly.call("HTTP.GET", {url: url}, function(res2, err2) {
        if (err2 || !res2 || res2.code !== 200) {
          state.last_error = "valve_" + name;
          if (cb) cb(false);
          return;
        }
        state.valve_states[name] = open;
        if (cb) cb(true);
      });
      return;
    }
    state.valve_states[name] = open;
    if (cb) cb(true);
  });
}

function setValves(pairs, idx, cb) {
  if (idx >= pairs.length) { if (cb) cb(true); return; }
  setValve(pairs[idx][0], pairs[idx][1], function(ok) {
    if (!ok) {
      setPump(false);
      state.mode = MODES.IDLE;
      state.mode_start = Date.now();
      state.transitioning = false;
      if (cb) cb(false);
      return;
    }
    setValves(pairs, idx + 1, cb);
  });
}

function closeAllValves(cb) {
  var names = ["vi_btm","vi_top","vi_coll","vo_coll","vo_rad","vo_tank","v_ret","v_air"];
  var pairs = [];
  for (var i = 0; i < names.length; i++) pairs.push([names[i], false]);
  setValves(pairs, 0, cb);
}

function pollSensor(name, hostIp, componentId, cb) {
  var url = "http://" + hostIp + "/rpc/Temperature.GetStatus?id=" + componentId;
  Shelly.call("HTTP.GET", {url: url}, function(res, err) {
    if (err || !res || res.code !== 200 || !res.body || res.body.indexOf("tC") < 0) {
      if (cb) cb(name, null);
      return;
    }
    var data = JSON.parse(res.body);
    if (cb) cb(name, data.tC);
  });
}

function pollAllSensors(cb) {
  // If no sensor config loaded, skip polling (safe: all temps stay null → IDLE)
  if (!sensorConfig || !sensorConfig.s || !sensorConfig.h) {
    if (cb) cb();
    return;
  }
  var names = [];
  for (var sName in sensorConfig.s) {
    names.push(sName);
  }
  function next(i) {
    if (i >= names.length) { if (cb) cb(); return; }
    var name = names[i];
    var cfg = sensorConfig.s[name];
    var hostIp = sensorConfig.h[cfg.h];
    if (!hostIp) { next(i + 1); return; }
    pollSensor(name, hostIp, cfg.i, function(n, val) {
      if (val !== null) {
        state.temps[n] = val;
        state.sensor_last_valid[n] = Date.now();
      }
      next(i + 1);
    });
  }
  next(0);
}

// ── Display ──

function updateDisplay() {
  var labels = buildDisplayLabels({
    mode: state.mode,
    modeDurationMs: Date.now() - state.mode_start,
    temps: state.temps,
    lastError: state.last_error,
    collectorsDrained: state.collectors_drained,
  });
  for (var i = 0; i < 4; i++) {
    Shelly.call("Switch.SetConfig", {id: i, config: {name: labels[i]}}, function() {});
  }
}

// ── State snapshot for evaluate() and events ──

function buildEvalState() {
  var now = Date.now();
  var sensorAge = {};
  var names = ["collector","tank_top","tank_bottom","greenhouse","outdoor"];
  for (var i = 0; i < names.length; i++) {
    var n = names[i];
    sensorAge[n] = state.sensor_last_valid[n] > 0 ? (now - state.sensor_last_valid[n]) / 1000 : 999;
  }
  return {
    temps: state.temps,
    currentMode: state.mode,
    modeEnteredAt: state.mode_start / 1000,
    now: now / 1000,
    collectorsDrained: state.collectors_drained,
    lastRefillAttempt: state.last_refill_attempt / 1000,
    emergencyHeatingActive: state.emergency_heating_active,
    sensorAge: sensorAge,
  };
}

function buildStateSnapshot() {
  return {
    ts: Date.now(),
    mode: state.mode.toLowerCase(),
    transitioning: state.transitioning,
    transition_step: state.transition_step || null,
    temps: {
      collector: state.temps.collector,
      tank_top: state.temps.tank_top,
      tank_bottom: state.temps.tank_bottom,
      greenhouse: state.temps.greenhouse,
      outdoor: state.temps.outdoor,
    },
    valves: {
      vi_btm: !!state.valve_states.vi_btm,
      vi_top: !!state.valve_states.vi_top,
      vi_coll: !!state.valve_states.vi_coll,
      vo_coll: !!state.valve_states.vo_coll,
      vo_rad: !!state.valve_states.vo_rad,
      vo_tank: !!state.valve_states.vo_tank,
      v_ret: !!state.valve_states.v_ret,
      v_air: !!state.valve_states.v_air,
    },
    actuators: {
      pump: state.pump_on,
      fan: state.fan_on,
      space_heater: state.space_heater_on,
      immersion_heater: state.immersion_heater_on,
    },
    flags: {
      collectors_drained: state.collectors_drained,
      emergency_heating_active: state.emergency_heating_active,
    },
    controls_enabled: deviceConfig.ce,
  };
}

function emitStateUpdate() {
  Shelly.emitEvent("state_updated", buildStateSnapshot());
}

function applyFlags(flags) {
  state.collectors_drained = flags.collectorsDrained;
  state.last_refill_attempt = flags.lastRefillAttempt * 1000;
  state.emergency_heating_active = flags.emergencyHeatingActive;
}

// ── Transitions ──

function transitionTo(result) {
  if (state.transitioning) return;
  state.transitioning = true;
  state.transition_step = "pump_stop";

  if (state.drain_timer !== null) {
    Timer.clear(state.drain_timer);
    state.drain_timer = null;
  }

  setPump(false);
  setFan(false);
  setSpaceHeater(false);
  setImmersion(false);
  emitStateUpdate();

  Timer.set(SHELL_CFG.VALVE_SETTLE_MS, false, function() {
    state.transition_step = "valves_closing";
    emitStateUpdate();
    closeAllValves(function(ok) {
      if (!ok) return;

      state.transition_step = "valves_opening";
      emitStateUpdate();
      var pairs = [];
      var names = ["vi_btm","vi_top","vi_coll","vo_coll","vo_rad","vo_tank","v_ret","v_air"];
      for (var i = 0; i < names.length; i++) {
        if (result.valves[names[i]]) pairs.push([names[i], true]);
      }

      setValves(pairs, 0, function(ok2) {
        if (!ok2) return;

        state.transition_step = "pump_start";
        emitStateUpdate();
        Timer.set(SHELL_CFG.PUMP_PRIME_MS, false, function() {
          state.mode = result.nextMode;
          state.mode_start = Date.now();
          state.transitioning = false;
          state.transition_step = null;
          applyFlags(result.flags);

          if (result.actuators.pump) setPump(true);
          if (result.actuators.fan) setFan(true);
          if (result.actuators.space_heater) setSpaceHeater(true);
          if (result.actuators.immersion_heater) setImmersion(true);

          if (result.nextMode === MODES.SOLAR_CHARGING) {
            Shelly.call("KVS.Set", {key: "drained", value: "0"});
          } else if (result.nextMode === MODES.ACTIVE_DRAIN) {
            startDrainMonitor();
          }
          emitStateUpdate();
        });
      });
    });
  });
}

function startDrainMonitor() {
  var drain_start = Date.now();
  var low_count = 0;
  state.drain_timer = Timer.set(SHELL_CFG.DRAIN_MONITOR_INTERVAL, true, function() {
    if (Date.now() - drain_start > DEFAULT_CONFIG.drainTimeout * 1000) {
      stopDrain("timeout");
      return;
    }
    var sw = Shelly.getComponentStatus("switch", 0);
    if (sw && sw.apower < SHELL_CFG.DRAIN_POWER_THRESHOLD) {
      low_count++;
      if (low_count >= 3) stopDrain("dry_run");
    } else {
      low_count = 0;
    }
  });
}

function stopDrain(reason) {
  if (state.drain_timer !== null) {
    Timer.clear(state.drain_timer);
    state.drain_timer = null;
  }
  state.transitioning = true;
  setPump(false);
  state.collectors_drained = true;
  Shelly.call("KVS.Set", {key: "drained", value: "1"});
  state.last_error = (reason === "timeout") ? "drain_timeout" : null;
  closeAllValves(function() {
    state.mode = MODES.IDLE;
    state.mode_start = Date.now();
    state.transitioning = false;
    state.transition_step = null;
    emitStateUpdate();
  });
}

// ── Control loop ──

function controlLoop() {
  if (state.transitioning) return;
  pollAllSensors(function() {
    updateDisplay();
    if (state.transitioning) return;

    var evalState = buildEvalState();
    var result = evaluate(evalState, null, deviceConfig);

    if (result.nextMode !== state.mode) {
      if (result.safetyOverride) {
        transitionTo(result);
      } else if (result.suppressed) {
        applyFlags(result.flags);
        emitStateUpdate();
      } else {
        transitionTo(result);
      }
    } else {
      applyFlags(result.flags);
      setSpaceHeater(!!result.actuators.space_heater);
      emitStateUpdate();
    }

    // Process pending MQTT commands after control cycle completes
    processPendingCommands();
  });
}

// ── Pending MQTT command queue ──

var pendingConfigApply = null;
var pendingDiscovery = null;

function processPendingCommands() {
  if (pendingConfigApply) {
    var applyReq = pendingConfigApply;
    pendingConfigApply = null;
    executeSensorConfigApply(applyReq);
  } else if (pendingDiscovery) {
    var discReq = pendingDiscovery;
    pendingDiscovery = null;
    executeDiscoveryScan(discReq);
  }
}

// ── Sensor config apply via MQTT ──

function sensorAddonRpc(hostIp, method, params, cb) {
  var url = "http://" + hostIp + "/rpc";
  var postData = JSON.stringify({id: 1, method: method, params: params || {}});
  Shelly.call("HTTP.POST", {url: url, body: postData, content_type: "application/json", timeout: 5}, function(res, err) {
    if (err || !res || res.code !== 200 || !res.body) {
      if (cb) cb(err ? "HTTP error" : "bad response", null);
      return;
    }
    try {
      var parsed = JSON.parse(res.body);
      if (cb) cb(null, parsed);
    } catch(e) {
      if (cb) cb("JSON parse error", null);
    }
  });
}

function executeSensorConfigApply(request) {
  var config = request.config;
  if (!config || !config.h || !config.s) {
    Shelly.emitEvent("sensor_config_apply_result", {id: request.id, success: false, results: []});
    return;
  }
  var targetHost = request.target;
  var hosts = [];
  for (var hi = 0; hi < config.h.length; hi++) {
    if (!targetHost || config.h[hi] === targetHost) {
      hosts.push(config.h[hi]);
    }
  }

  var results = [];
  function nextApplyHost(idx) {
    if (idx >= hosts.length) {
      var allOk = true;
      for (var ri = 0; ri < results.length; ri++) {
        if (!results[ri].ok) allOk = false;
      }
      Shelly.emitEvent("sensor_config_apply_result", {id: request.id, success: allOk, results: results});
      return;
    }
    var hostIp = hosts[idx];
    var hostIdx = -1;
    for (var h = 0; h < config.h.length; h++) {
      if (config.h[h] === hostIp) { hostIdx = h; break; }
    }
    // Get existing peripherals
    sensorAddonRpc(hostIp, "SensorAddon.GetPeripherals", null, function(err, res) {
      if (err) {
        results.push({host: hostIp, ok: false, error: err, peripherals: 0});
        nextApplyHost(idx + 1);
        return;
      }
      var existing = [];
      var ds18b20 = (res && res.ds18b20) || (res && res.params && res.params.ds18b20) || {};
      for (var comp in ds18b20) { existing.push(comp); }

      // Remove existing
      function removeExisting(ri) {
        if (ri >= existing.length) { addNew(); return; }
        sensorAddonRpc(hostIp, "SensorAddon.RemovePeripheral", {component: existing[ri]}, function() {
          removeExisting(ri + 1);
        });
      }

      // Add assigned sensors for this host
      function addNew() {
        var toAdd = [];
        for (var role in config.s) {
          var s = config.s[role];
          if (s.h === hostIdx) {
            // Find the addr from assignments if available
            toAdd.push({i: s.i, role: role});
          }
        }
        var added = 0;
        function addNext(ai) {
          if (ai >= toAdd.length) {
            results.push({host: hostIp, ok: true, peripherals: added});
            nextApplyHost(idx + 1);
            return;
          }
          // Note: compact format doesn't include addr — the controller needs full config
          // For now we add by component ID; the SensorAddon will auto-detect addresses
          sensorAddonRpc(hostIp, "SensorAddon.AddPeripheral", {
            type: "ds18b20",
            attrs: {cid: toAdd[ai].i}
          }, function(addErr) {
            if (!addErr) added++;
            addNext(ai + 1);
          });
        }
        addNext(0);
      }
      removeExisting(0);
    });
  }
  nextApplyHost(0);
}

// ── Sensor discovery via MQTT ──

function executeDiscoveryScan(request) {
  var hosts = request.hosts || [];
  var results = [];
  function nextDiscoverHost(idx) {
    if (idx >= hosts.length) {
      Shelly.emitEvent("discover_sensors_result", {id: request.id, results: results});
      return;
    }
    var hostIp = hosts[idx];
    sensorAddonRpc(hostIp, "SensorAddon.GetPeripherals", null, function(err, res) {
      if (err) {
        results.push({host: hostIp, ok: false, error: err, sensors: []});
        nextDiscoverHost(idx + 1);
        return;
      }
      var sensors = [];
      var ds18b20 = (res && res.ds18b20) || (res && res.params && res.params.ds18b20) || {};
      for (var comp in ds18b20) {
        var info = ds18b20[comp];
        sensors.push({
          addr: info.addr || "",
          tC: (typeof info.tC === "number") ? info.tC : null,
          component: comp
        });
      }
      results.push({host: hostIp, ok: true, sensors: sensors});
      nextDiscoverHost(idx + 1);
    });
  }
  nextDiscoverHost(0);
}

// ── Config event handlers ──

Shelly.addEventHandler(function(ev) {
  if (!ev || !ev.info) return;
  if (ev.info.event === "config_changed") {
    var data = ev.info.data;
    if (data && data.config) {
      deviceConfig = data.config;
      if (data.safety_critical) {
        controlLoop();
      }
    }
  } else if (ev.info.event === "sensor_config_changed") {
    var scData = ev.info.data;
    if (scData && scData.config) {
      sensorConfig = scData.config;
    }
  } else if (ev.info.event === "sensor_config_apply") {
    var applyData = ev.info.data;
    if (applyData && applyData.request) {
      pendingConfigApply = applyData.request;
    }
  } else if (ev.info.event === "discover_sensors") {
    var discData = ev.info.data;
    if (discData && discData.request) {
      pendingDiscovery = discData.request;
    }
  }
});

// ── Boot ──

function boot() {
  setPump(false);
  setFan(false);
  setSpaceHeater(false);
  setImmersion(false);

  closeAllValves(function(ok) {
    if (!ok) {
      Timer.set(5000, false, function() { boot(); });
      return;
    }
    Timer.set(5000, false, function() {
      // Load persisted config from KVS
      Shelly.call("KVS.Get", {key: "config"}, function(cfgRes) {
        if (cfgRes && cfgRes.value) {
          try { deviceConfig = JSON.parse(cfgRes.value); } catch(e) {}
        }

        // Load sensor config from KVS
        Shelly.call("KVS.Get", {key: "sensor_config"}, function(scRes) {
          if (scRes && scRes.value) {
            try { sensorConfig = JSON.parse(scRes.value); } catch(e) {}
          }

          Shelly.call("KVS.Get", {key: "drained"}, function(res) {
            if (res && res.value === "1") state.collectors_drained = true;

            pollAllSensors(function() {
              state.mode_start = Date.now();
              Timer.set(SHELL_CFG.POLL_INTERVAL, true, controlLoop);
              controlLoop();
            });
          });
        });
      });
    });
  });
}

boot();
