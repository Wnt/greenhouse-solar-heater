// Shelly Pro 4PM — Solar Thermal Greenhouse Control

let CFG = {
  POLL_INTERVAL: 30000,
  MIN_MODE_DURATION: 300000,
  DRAIN_TIMEOUT: 180000,
  DRAIN_MONITOR_INTERVAL: 200,
  VALVE_SETTLE_MS: 1000,
  PUMP_PRIME_MS: 5000,
  DRAIN_POWER_THRESHOLD: 20, // calibrate empirically during commissioning
  SOLAR_ENTER_DIFF: 7,
  SOLAR_EXIT_DIFF: 3,
  HEAT_ENTER_TEMP: 10,
  HEAT_EXIT_TEMP: 12,
  HEAT_MIN_TANK: 25,
  DRAIN_ENTER_TEMP: 2,
  EMERG_ENTER_TEMP: 5,
  EMERG_EXIT_TEMP: 8,
  EMERG_MIN_TANK: 25,
  MAX_STALE_CYCLES: 5,
};

let VALVES = {
  vi_btm:  {ip: "192.168.1.11", id: 0},
  vi_top:  {ip: "192.168.1.11", id: 1},
  vi_coll: {ip: "192.168.1.12", id: 0},
  vo_coll: {ip: "192.168.1.12", id: 1},
  vo_rad:  {ip: "192.168.1.13", id: 0},
  vo_tank: {ip: "192.168.1.13", id: 1},
  v_ret:   {ip: "192.168.1.14", id: 0},
  v_air:   {ip: "192.168.1.14", id: 1},
};

let SENSOR_IP = "192.168.1.20";
let SENSOR_IDS = {
  collector: 0,
  tank_top: 1,
  tank_bottom: 2,
  greenhouse: 3,
  outdoor: 4,
};

let MODE = {IDLE: 0, SOLAR: 1, HEATING: 2, DRAIN: 3, EMERGENCY: 4};
let MODE_NAMES = [
  "IDLE", "SOLAR_CHARGING", "GREENHOUSE_HEATING",
  "ACTIVE_DRAIN", "EMERGENCY_HEATING",
];

let MODE_VALVES = {};
MODE_VALVES[MODE.IDLE] = {
  vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false,
  vo_rad: false, vo_tank: false, v_ret: false, v_air: false,
};
MODE_VALVES[MODE.SOLAR] = {
  vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true,
  vo_rad: false, vo_tank: false, v_ret: true, v_air: false,
};
MODE_VALVES[MODE.HEATING] = {
  vi_btm: false, vi_top: true, vi_coll: false, vo_coll: false,
  vo_rad: true, vo_tank: false, v_ret: false, v_air: false,
};
MODE_VALVES[MODE.DRAIN] = {
  vi_btm: false, vi_top: false, vi_coll: true, vo_coll: false,
  vo_rad: false, vo_tank: true, v_ret: false, v_air: true,
};
MODE_VALVES[MODE.EMERGENCY] = {
  vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false,
  vo_rad: false, vo_tank: false, v_ret: false, v_air: false,
};

let state = {
  mode: MODE.IDLE,
  mode_start: 0,
  temps: {
    collector: null, tank_top: null, tank_bottom: null,
    greenhouse: null, outdoor: null,
  },
  temp_updated: 0,
  stale_cycles: 0,
  collectors_drained: false,
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
      state.mode = MODE.IDLE;
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
  var any_success = false;

  function next(i) {
    if (i >= names.length) {
      if (any_success) {
        state.temp_updated = Date.now();
        state.stale_cycles = 0;
      } else {
        state.stale_cycles++;
      }
      if (cb) cb(any_success);
      return;
    }
    pollSensor(names[i], SENSOR_IDS[names[i]], function(name, val) {
      if (val !== null) {
        state.temps[name] = val;
        any_success = true;
      }
      next(i + 1);
    });
  }

  next(0);
}

function evaluateMode() {
  var t = state.temps;
  var now = Date.now();
  var elapsed = now - state.mode_start;

  // Active drain — highest priority, always preempts
  if (t.outdoor !== null && t.outdoor < CFG.DRAIN_ENTER_TEMP &&
      !state.collectors_drained) {
    if (state.mode !== MODE.DRAIN) return MODE.DRAIN;
  }

  // Minimum mode duration (does not apply to drain preemption above)
  if (elapsed < CFG.MIN_MODE_DURATION && state.mode !== MODE.IDLE) {
    return state.mode;
  }

  // Emergency heating
  if (t.greenhouse !== null && t.tank_top !== null) {
    if (state.mode === MODE.EMERGENCY) {
      if (t.greenhouse > CFG.EMERG_EXIT_TEMP) {
        return evaluateNonEmergency();
      }
      return MODE.EMERGENCY;
    }
    if (t.greenhouse < CFG.EMERG_ENTER_TEMP &&
        t.tank_top < CFG.EMERG_MIN_TANK) {
      return MODE.EMERGENCY;
    }
  }

  return evaluateNonEmergency();
}

function evaluateNonEmergency() {
  var t = state.temps;

  // Solar charging
  if (t.collector !== null && t.tank_bottom !== null) {
    if (state.mode === MODE.SOLAR) {
      if (t.collector >= t.tank_bottom + CFG.SOLAR_EXIT_DIFF) {
        return MODE.SOLAR;
      }
      // Below exit threshold — fall through
    } else if (t.collector > t.tank_bottom + CFG.SOLAR_ENTER_DIFF) {
      return MODE.SOLAR;
    }
  }

  // Greenhouse heating
  if (t.greenhouse !== null && t.tank_top !== null) {
    if (state.mode === MODE.HEATING) {
      if (t.greenhouse <= CFG.HEAT_EXIT_TEMP) {
        return MODE.HEATING;
      }
      return MODE.IDLE;
    }
    if (t.greenhouse < CFG.HEAT_ENTER_TEMP &&
        t.tank_top > CFG.HEAT_MIN_TANK) {
      return MODE.HEATING;
    }
  }

  return MODE.IDLE;
}
