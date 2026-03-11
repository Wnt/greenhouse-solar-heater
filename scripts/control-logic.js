// control-logic.js — Pure decision logic for greenhouse solar heating
// Shelly-compatible JavaScript: no const/let, no arrow functions,
// no destructuring, no template literals, no ES6 classes
// All decisions via evaluate(state, config) — no side effects, no Shelly APIs

var MODES = {
  IDLE: "IDLE",
  SOLAR_CHARGING: "SOLAR_CHARGING",
  GREENHOUSE_HEATING: "GREENHOUSE_HEATING",
  ACTIVE_DRAIN: "ACTIVE_DRAIN",
  EMERGENCY_HEATING: "EMERGENCY_HEATING"
};

var MODE_VALVES = {
  IDLE: {
    vi_btm: false, vi_top: false, vi_coll: false,
    vo_coll: false, vo_rad: false, vo_tank: false,
    v_ret: false, v_air: false
  },
  SOLAR_CHARGING: {
    vi_btm: true, vi_top: false, vi_coll: false,
    vo_coll: true, vo_rad: false, vo_tank: false,
    v_ret: true, v_air: false
  },
  GREENHOUSE_HEATING: {
    vi_btm: false, vi_top: true, vi_coll: false,
    vo_coll: false, vo_rad: true, vo_tank: false,
    v_ret: false, v_air: false
  },
  ACTIVE_DRAIN: {
    vi_btm: false, vi_top: false, vi_coll: true,
    vo_coll: false, vo_rad: false, vo_tank: true,
    v_ret: false, v_air: true
  },
  EMERGENCY_HEATING: {
    vi_btm: false, vi_top: false, vi_coll: false,
    vo_coll: false, vo_rad: false, vo_tank: false,
    v_ret: false, v_air: false
  }
};

var MODE_ACTUATORS = {
  IDLE: {
    pump: false, fan: false, space_heater: false, immersion_heater: false
  },
  SOLAR_CHARGING: {
    pump: true, fan: false, space_heater: false, immersion_heater: false
  },
  GREENHOUSE_HEATING: {
    pump: true, fan: true, space_heater: false, immersion_heater: false
  },
  ACTIVE_DRAIN: {
    pump: true, fan: false, space_heater: false, immersion_heater: false
  },
  EMERGENCY_HEATING: {
    pump: false, fan: false, space_heater: true, immersion_heater: true
  }
};

var DEFAULT_CONFIG = {
  solarEnterDelta: 7,
  solarExitDelta: 3,
  greenhouseEnterTemp: 10,
  greenhouseExitTemp: 12,
  greenhouseMinTankTop: 25,
  emergencyEnterTemp: 5,
  emergencyExitTemp: 8,
  freezeDrainTemp: 2,
  overheatDrainTemp: 85,
  overheatResumeTemp: 75,
  minModeDuration: 300,
  minRunTimeAfterRefill: 600,
  refillRetryCooldown: 1800,
  sensorStaleThreshold: 150,
  drainTimeout: 180
};

function applyDefaults(config) {
  var result = {};
  var key;
  for (key in DEFAULT_CONFIG) {
    result[key] = DEFAULT_CONFIG[key];
  }
  if (config) {
    for (key in config) {
      result[key] = config[key];
    }
  }
  return result;
}

function anySensorStale(sensorAge, threshold) {
  var names = ["collector", "tank_top", "tank_bottom", "greenhouse", "outdoor"];
  for (var i = 0; i < names.length; i++) {
    if (sensorAge[names[i]] > threshold) {
      return true;
    }
  }
  return false;
}

function makeResult(mode, flags) {
  var valves = {};
  var actuators = {};
  var key;
  var mv = MODE_VALVES[mode];
  for (key in mv) {
    valves[key] = mv[key];
  }
  var ma = MODE_ACTUATORS[mode];
  for (key in ma) {
    actuators[key] = ma[key];
  }
  return {
    nextMode: mode,
    valves: valves,
    actuators: actuators,
    flags: flags
  };
}

function getMinDuration(state, cfg) {
  if (state.currentMode === MODES.SOLAR_CHARGING &&
      state.lastRefillAttempt > 0 &&
      state.now - state.lastRefillAttempt < cfg.minRunTimeAfterRefill) {
    return cfg.minRunTimeAfterRefill;
  }
  return cfg.minModeDuration;
}

function evaluate(state, config) {
  var cfg = applyDefaults(config);
  var t = state.temps;
  var elapsed = state.now - state.modeEnteredAt;
  var flags = {
    collectorsDrained: state.collectorsDrained,
    lastRefillAttempt: state.lastRefillAttempt
  };

  // Sensor staleness — any sensor stale triggers IDLE
  if (anySensorStale(state.sensorAge, cfg.sensorStaleThreshold)) {
    return makeResult(MODES.IDLE, flags);
  }

  // Already draining — stay until shell completes or timeout
  if (state.currentMode === MODES.ACTIVE_DRAIN) {
    if (elapsed > cfg.drainTimeout) {
      flags.collectorsDrained = true;
      return makeResult(MODES.IDLE, flags);
    }
    return makeResult(MODES.ACTIVE_DRAIN, flags);
  }

  // Freeze protection — preempts immediately, ignores min duration
  if (t.outdoor !== null && t.outdoor < cfg.freezeDrainTemp &&
      !state.collectorsDrained) {
    return makeResult(MODES.ACTIVE_DRAIN, flags);
  }

  // Overheat protection — preempts immediately
  if (t.tank_top !== null && t.tank_top > cfg.overheatDrainTemp &&
      !state.collectorsDrained) {
    return makeResult(MODES.ACTIVE_DRAIN, flags);
  }

  // Minimum mode duration (not for IDLE, not for drain preemption above)
  if (state.currentMode !== MODES.IDLE &&
      elapsed < getMinDuration(state, cfg)) {
    return makeResult(state.currentMode, flags);
  }

  // Emergency heating — T_greenhouse < 5°C AND T_tank_top < 25°C
  if (t.greenhouse !== null && t.tank_top !== null) {
    if (state.currentMode === MODES.EMERGENCY_HEATING) {
      if (t.greenhouse <= cfg.emergencyExitTemp) {
        return makeResult(MODES.EMERGENCY_HEATING, flags);
      }
      // Above exit temp, fall through to normal evaluation
    } else if (t.greenhouse < cfg.emergencyEnterTemp &&
               t.tank_top < cfg.greenhouseMinTankTop) {
      return makeResult(MODES.EMERGENCY_HEATING, flags);
    }
  }

  // Greenhouse heating — higher priority than solar
  if (t.greenhouse !== null && t.tank_top !== null) {
    if (state.currentMode === MODES.GREENHOUSE_HEATING) {
      if (t.greenhouse <= cfg.greenhouseExitTemp) {
        return makeResult(MODES.GREENHOUSE_HEATING, flags);
      }
      // Above exit temp, fall through
    } else if (t.greenhouse < cfg.greenhouseEnterTemp &&
               t.tank_top > cfg.greenhouseMinTankTop) {
      return makeResult(MODES.GREENHOUSE_HEATING, flags);
    }
  }

  // Solar charging
  if (t.collector !== null && t.tank_bottom !== null) {
    if (state.currentMode === MODES.SOLAR_CHARGING) {
      if (t.collector >= t.tank_bottom + cfg.solarExitDelta) {
        return makeResult(MODES.SOLAR_CHARGING, flags);
      }
      // Below exit delta, fall through to IDLE
    } else if (!state.collectorsDrained) {
      // Normal solar entry
      if (t.collector > t.tank_bottom + cfg.solarEnterDelta) {
        return makeResult(MODES.SOLAR_CHARGING, flags);
      }
    } else {
      // Speculative refill — collectors drained, conditions suggest daylight
      if (t.collector > t.tank_bottom + cfg.solarEnterDelta &&
          t.outdoor !== null && t.outdoor > cfg.freezeDrainTemp + 3) {
        if (state.now - state.lastRefillAttempt > cfg.refillRetryCooldown) {
          flags.collectorsDrained = false;
          flags.lastRefillAttempt = state.now;
          return makeResult(MODES.SOLAR_CHARGING, flags);
        }
      }
    }
  }

  return makeResult(MODES.IDLE, flags);
}

// Export for Node.js testing (Shelly ignores this)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    evaluate: evaluate,
    MODES: MODES,
    MODE_VALVES: MODE_VALVES,
    MODE_ACTUATORS: MODE_ACTUATORS,
    DEFAULT_CONFIG: DEFAULT_CONFIG
  };
}
