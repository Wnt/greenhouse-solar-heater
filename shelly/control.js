// Shelly Pro 4PM — Solar Thermal Greenhouse Control (Shell)
// All decision logic is in control-logic.js (concatenated at deploy time)
// This file handles: timers, RPC, relays, KVS, sensors, status endpoint

var SHELL_CFG = {
  POLL_INTERVAL: 30000,
  VALVE_SETTLE_MS: 1000,
  PUMP_PRIME_MS: 5000,
  DRAIN_MONITOR_INTERVAL: 200,
  DRAIN_POWER_THRESHOLD: 20,
};

var VALVES = {
  vi_btm:  {ip: "192.168.1.11", id: 0},
  vi_top:  {ip: "192.168.1.11", id: 1},
  vi_coll: {ip: "192.168.1.12", id: 0},
  vo_coll: {ip: "192.168.1.12", id: 1},
  vo_rad:  {ip: "192.168.1.13", id: 0},
  vo_tank: {ip: "192.168.1.13", id: 1},
  v_ret:   {ip: "192.168.1.14", id: 0},
  v_air:   {ip: "192.168.1.14", id: 1},
};

var SENSOR_IP = "192.168.1.20";
var SENSOR_IDS = {
  collector: 0,
  tank_top: 1,
  tank_bottom: 2,
  greenhouse: 3,
  outdoor: 4,
};

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
  last_error: null,
  valve_states: {},
  pump_on: false,
  transitioning: false,
  drain_timer: null,
};

function setPump(on) {
  Shelly.call("Switch.Set", {id: 0, on: on});
  state.pump_on = on;
}

function setFan(on) {
  Shelly.call("Switch.Set", {id: 1, on: on});
}

function setImmersion(on) {
  Shelly.call("Switch.Set", {id: 2, on: on});
}

function setSpaceHeater(on) {
  Shelly.call("Switch.Set", {id: 3, on: on});
}

function setValve(name, open, cb) {
  var v = VALVES[name];
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
  if (idx >= pairs.length) {
    if (cb) cb(true);
    return;
  }
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
  var names = [
    "vi_btm", "vi_top", "vi_coll", "vo_coll",
    "vo_rad", "vo_tank", "v_ret", "v_air",
  ];
  var pairs = [];
  for (var i = 0; i < names.length; i++) {
    pairs.push([names[i], false]);
  }
  setValves(pairs, 0, cb);
}

function pollSensor(name, id, cb) {
  var url = "http://" + SENSOR_IP + "/rpc/Temperature.GetStatus?id=" + id;
  Shelly.call("HTTP.GET", {url: url}, function(res, err) {
    if (err || !res || res.code !== 200 ||
        !res.body || res.body.indexOf("tC") < 0) {
      if (cb) cb(name, null);
      return;
    }
    var data = JSON.parse(res.body);
    if (cb) cb(name, data.tC);
  });
}

function pollAllSensors(cb) {
  var names = ["collector", "tank_top", "tank_bottom", "greenhouse", "outdoor"];

  function next(i) {
    if (i >= names.length) {
      if (cb) cb();
      return;
    }
    pollSensor(names[i], SENSOR_IDS[names[i]], function(name, val) {
      if (val !== null) {
        state.temps[name] = val;
        state.sensor_last_valid[name] = Date.now();
      }
      next(i + 1);
    });
  }

  next(0);
}

// ── Display: update Pro 4PM channel names to show status ──
// formatDuration, formatTemp, buildDisplayLabels are in control-logic.js

function updateDisplay() {
  var labels = buildDisplayLabels({
    mode: state.mode,
    modeDurationMs: Date.now() - state.mode_start,
    temps: state.temps,
    lastError: state.last_error,
    collectorsDrained: state.collectors_drained,
  });
  for (var i = 0; i < 4; i++) {
    Shelly.call("Switch.SetConfig", {
      id: i,
      config: { name: labels[i] }
    }, function() {});
  }
}

function buildEvalState() {
  var now = Date.now();
  var sensorAge = {};
  var names = ["collector", "tank_top", "tank_bottom", "greenhouse", "outdoor"];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    sensorAge[name] = state.sensor_last_valid[name] > 0 ?
      (now - state.sensor_last_valid[name]) / 1000 : 999;
  }
  return {
    temps: state.temps,
    currentMode: state.mode,
    modeEnteredAt: state.mode_start / 1000,
    now: now / 1000,
    collectorsDrained: state.collectors_drained,
    lastRefillAttempt: state.last_refill_attempt / 1000,
    sensorAge: sensorAge,
  };
}

function applyFlags(flags) {
  state.collectors_drained = flags.collectorsDrained;
  state.last_refill_attempt = flags.lastRefillAttempt * 1000;
}

function transitionTo(result) {
  if (state.transitioning) return;
  state.transitioning = true;

  // Clear drain monitor if leaving ACTIVE_DRAIN
  if (state.drain_timer !== null) {
    Timer.clear(state.drain_timer);
    state.drain_timer = null;
  }

  // Step 1: Stop pump and all actuators
  setPump(false);
  setFan(false);
  setSpaceHeater(false);
  setImmersion(false);

  // Step 2: Wait for settle, then close all valves
  Timer.set(SHELL_CFG.VALVE_SETTLE_MS, false, function() {
    closeAllValves(function(ok) {
      if (!ok) return;

      // Step 3: Open valves for new mode
      var pairs = [];
      var names = [
        "vi_btm", "vi_top", "vi_coll", "vo_coll",
        "vo_rad", "vo_tank", "v_ret", "v_air",
      ];
      for (var i = 0; i < names.length; i++) {
        if (result.valves[names[i]]) {
          pairs.push([names[i], true]);
        }
      }

      setValves(pairs, 0, function(ok2) {
        if (!ok2) return;

        // Step 4: Wait for valve travel + gravity prime
        Timer.set(SHELL_CFG.PUMP_PRIME_MS, false, function() {
          state.mode = result.nextMode;
          state.mode_start = Date.now();
          state.transitioning = false;

          // Apply flags from evaluate()
          applyFlags(result.flags);

          // Activate actuators
          if (result.actuators.pump) setPump(true);
          if (result.actuators.fan) setFan(true);
          if (result.actuators.space_heater) setSpaceHeater(true);
          if (result.actuators.immersion_heater) setImmersion(true);

          // Mode-specific: KVS update, drain monitor
          if (result.nextMode === MODES.SOLAR_CHARGING) {
            Shelly.call("KVS.Set", {key: "drained", value: "0"});
          } else if (result.nextMode === MODES.ACTIVE_DRAIN) {
            startDrainMonitor();
          }
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
      if (low_count >= 3) {
        stopDrain("dry_run");
      }
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
  });
}

HTTPServer.registerEndpoint("status", function(req, res) {
  var now = Date.now();
  var sw = Shelly.getComponentStatus("switch", 0);
  var sys = Shelly.getComponentStatus("sys");
  var body = JSON.stringify({
    mode: state.mode,
    mode_duration_s: Math.floor((now - state.mode_start) / 1000),
    temperatures: state.temps,
    sensor_age: buildEvalState().sensorAge,
    valves: state.valve_states,
    pump: {
      on: state.pump_on,
      power_w: sw ? sw.apower : null,
    },
    collectors_drained: state.collectors_drained,
    last_error: state.last_error,
    uptime_s: sys ? Math.floor(sys.uptime) : 0,
  });
  res.code = 200;
  res.body = body;
  res.send();
});

function controlLoop() {
  if (state.transitioning) return;

  pollAllSensors(function() {
    updateDisplay();
    if (state.transitioning) return;

    var evalState = buildEvalState();
    var result = evaluate(evalState, null);

    if (result.nextMode !== state.mode) {
      transitionTo(result);
    } else {
      applyFlags(result.flags);
    }
  });
}

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
      Shelly.call("KVS.Get", {key: "drained"}, function(res, err) {
        if (res && res.value === "1") {
          state.collectors_drained = true;
        }

        pollAllSensors(function() {
          state.mode_start = Date.now();
          Timer.set(SHELL_CFG.POLL_INTERVAL, true, controlLoop);
          controlLoop();
        });
      });
    });
  });
}

boot();
