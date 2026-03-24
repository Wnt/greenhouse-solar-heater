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
  greenhouseMinTankDelta: 5,
  greenhouseExitTankDelta: 2,
  emergencyEnterTemp: 9,
  emergencyExitTemp: 12,
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

function makeResult(mode, flags, deviceConfig) {
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
  var result = {
    nextMode: mode,
    valves: valves,
    actuators: actuators,
    flags: flags,
    suppressed: false
  };
  // If device config disables controls, mark actuator commands as suppressed
  if (deviceConfig && !deviceConfig.controls_enabled) {
    result.suppressed = true;
  } else if (deviceConfig && deviceConfig.enabled_actuators) {
    var ea = deviceConfig.enabled_actuators;
    if (!ea.pump) actuators.pump = false;
    if (!ea.fan) actuators.fan = false;
    if (!ea.space_heater) actuators.space_heater = false;
    if (!ea.immersion_heater) actuators.immersion_heater = false;
    if (!ea.valves) {
      for (key in valves) { valves[key] = false; }
    }
  }
  return result;
}

function getMinDuration(state, cfg) {
  if (state.currentMode === MODES.SOLAR_CHARGING &&
      state.lastRefillAttempt > 0 &&
      state.now - state.lastRefillAttempt < cfg.minRunTimeAfterRefill) {
    return cfg.minRunTimeAfterRefill;
  }
  return cfg.minModeDuration;
}

function evaluate(state, config, deviceConfig) {
  var cfg = applyDefaults(config);
  var dc = deviceConfig || null;
  var t = state.temps;
  var elapsed = state.now - state.modeEnteredAt;
  var flags = {
    collectorsDrained: state.collectorsDrained,
    lastRefillAttempt: state.lastRefillAttempt,
    emergencyHeatingActive: state.emergencyHeatingActive || false
  };

  // Sensor staleness — any sensor stale triggers IDLE, emergency off
  if (anySensorStale(state.sensorAge, cfg.sensorStaleThreshold)) {
    flags.emergencyHeatingActive = false;
    return makeResult(MODES.IDLE, flags, dc);
  }

  // Already draining — stay until shell completes or timeout
  if (state.currentMode === MODES.ACTIVE_DRAIN) {
    if (elapsed > cfg.drainTimeout) {
      flags.collectorsDrained = true;
      return makeResult(MODES.IDLE, flags, dc);
    }
    return makeResult(MODES.ACTIVE_DRAIN, flags, dc);
  }

  // Freeze protection — preempts immediately, ignores min duration
  if (t.outdoor !== null && t.outdoor < cfg.freezeDrainTemp &&
      !state.collectorsDrained) {
    return makeResult(MODES.ACTIVE_DRAIN, flags, dc);
  }

  // Overheat protection — preempts immediately
  if (t.tank_top !== null && t.tank_top > cfg.overheatDrainTemp &&
      !state.collectorsDrained) {
    return makeResult(MODES.ACTIVE_DRAIN, flags, dc);
  }

  // Minimum mode duration (not for IDLE or EMERGENCY_HEATING, not for drain above)
  if (state.currentMode !== MODES.IDLE &&
      state.currentMode !== MODES.EMERGENCY_HEATING &&
      elapsed < getMinDuration(state, cfg)) {
    var result = makeResult(state.currentMode, flags, dc);
    // Emergency overlay still applies during min-duration hold
    if (t.greenhouse !== null && flags.emergencyHeatingActive) {
      result.actuators.space_heater = true;
    }
    return result;
  }

  // ── Emergency heating overlay (independent of pump mode) ──
  // Space heater activates whenever greenhouse is critically cold.
  // Tracked separately so it works alongside greenhouse heating.
  if (t.greenhouse !== null) {
    if (flags.emergencyHeatingActive) {
      if (t.greenhouse > cfg.emergencyExitTemp) {
        flags.emergencyHeatingActive = false;
      }
    } else if (t.greenhouse < cfg.emergencyEnterTemp) {
      flags.emergencyHeatingActive = true;
    }
  }

  // ── Pump mode selection (greenhouse heating > solar > idle) ──
  var pumpMode = MODES.IDLE;

  // Greenhouse heating — use tank when it has useful delta over greenhouse
  // Exit when tank < greenhouse + 2°C to avoid cooling via radiator
  if (t.greenhouse !== null && t.tank_top !== null) {
    if (state.currentMode === MODES.GREENHOUSE_HEATING) {
      if (t.greenhouse <= cfg.greenhouseExitTemp &&
          t.tank_top >= t.greenhouse + cfg.greenhouseExitTankDelta) {
        pumpMode = MODES.GREENHOUSE_HEATING;
      }
      // Above exit temp or tank too close to greenhouse, fall through
    } else if (t.greenhouse < cfg.greenhouseEnterTemp &&
               t.tank_top > t.greenhouse + cfg.greenhouseMinTankDelta) {
      pumpMode = MODES.GREENHOUSE_HEATING;
    }
  }

  // Solar charging (only if not greenhouse heating)
  if (pumpMode === MODES.IDLE && t.collector !== null && t.tank_bottom !== null) {
    if (state.currentMode === MODES.SOLAR_CHARGING) {
      if (t.collector >= t.tank_bottom + cfg.solarExitDelta) {
        pumpMode = MODES.SOLAR_CHARGING;
      }
      // Below exit delta, fall through to IDLE
    } else if (!state.collectorsDrained) {
      // Normal solar entry
      if (t.collector > t.tank_bottom + cfg.solarEnterDelta) {
        pumpMode = MODES.SOLAR_CHARGING;
      }
    } else {
      // Speculative refill — collectors drained, conditions suggest daylight
      if (t.collector > t.tank_bottom + cfg.solarEnterDelta &&
          t.outdoor !== null && t.outdoor > cfg.freezeDrainTemp + 3) {
        if (state.now - state.lastRefillAttempt > cfg.refillRetryCooldown) {
          flags.collectorsDrained = false;
          flags.lastRefillAttempt = state.now;
          pumpMode = MODES.SOLAR_CHARGING;
        }
      }
    }
  }

  // ── Forced mode override (for staged deployment / manual testing) ──
  if (dc && dc.forced_mode) {
    var fm = dc.forced_mode.toUpperCase();
    if (MODES[fm]) {
      pumpMode = MODES[fm];
      flags.emergencyHeatingActive = false;
      return makeResult(pumpMode, flags, dc);
    }
  }

  // ── Combine pump mode + emergency overlay ──
  if (flags.emergencyHeatingActive && pumpMode === MODES.IDLE) {
    // No useful pump mode — pure emergency (space heater + immersion)
    return makeResult(MODES.EMERGENCY_HEATING, flags, dc);
  }

  var result = makeResult(pumpMode, flags, dc);
  if (flags.emergencyHeatingActive) {
    // Pump mode active + emergency — overlay space heater onto pump mode
    result.actuators.space_heater = true;
  }

  // ── Allowed modes filter (for staged deployment) ──
  if (dc && dc.allowed_modes && dc.allowed_modes.length > 0) {
    var allowed = false;
    for (var ami = 0; ami < dc.allowed_modes.length; ami++) {
      if (dc.allowed_modes[ami].toUpperCase() === result.nextMode) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      return makeResult(MODES.IDLE, flags, dc);
    }
  }

  return result;
}

// ── Display label helpers (pure, no Shelly calls) ──

var MODE_SHORT = {
  IDLE: "IDLE",
  SOLAR_CHARGING: "SOLAR",
  GREENHOUSE_HEATING: "HEAT",
  ACTIVE_DRAIN: "DRAIN",
  EMERGENCY_HEATING: "EMERG",
};

function formatDuration(ms) {
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  if (m < 60) return m + "m";
  var h = Math.floor(m / 60);
  return h + "h" + (m % 60) + "m";
}

function formatTemp(t) {
  if (t === null || t === undefined) return "--";
  return Math.round(t) + "C";
}

function buildDisplayLabels(displayState) {
  var dur = formatDuration(displayState.modeDurationMs);
  var prefix = MODE_SHORT[displayState.mode] || displayState.mode;
  var ch0 = prefix + " " + dur;
  if (displayState.lastError) ch0 = "!" + ch0;
  if (displayState.collectorsDrained && displayState.mode === MODES.IDLE) ch0 = ch0 + " D";

  var t = displayState.temps;
  var ch1 = "Coll " + formatTemp(t.collector)
    + " Tk" + formatTemp(t.tank_top)
    + "/" + formatTemp(t.tank_bottom);
  var ch2 = "GH " + formatTemp(t.greenhouse);
  var ch3 = "Out " + formatTemp(t.outdoor);

  return [ch0, ch1, ch2, ch3];
}

// Export for Node.js testing (Shelly ignores this)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    evaluate: evaluate,
    MODES: MODES,
    MODE_VALVES: MODE_VALVES,
    MODE_ACTUATORS: MODE_ACTUATORS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    formatDuration: formatDuration,
    formatTemp: formatTemp,
    buildDisplayLabels: buildDisplayLabels,
    MODE_SHORT: MODE_SHORT
  };
}
