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

// All valve names in alphabetical order. Used as a pre-sorted iteration
// key whenever a deterministic order is required without calling
// Array.prototype.sort() — Shelly's Espruino runtime does not implement
// sort() (same family of missing methods as Array.prototype.shift(); see
// the relayCmdQueue comment in control.js). Keep in sync with the valve
// set in MODE_VALVES below.
var VALVE_NAMES_SORTED = [
  "v_air", "vi_btm", "vi_coll", "vi_top",
  "vo_coll", "vo_rad", "vo_tank"
];

var MODE_VALVES = {
  IDLE: {
    vi_btm: false, vi_top: false, vi_coll: false,
    vo_coll: false, vo_rad: false, vo_tank: false,
    v_air: false
  },
  SOLAR_CHARGING: {
    vi_btm: true, vi_top: false, vi_coll: false,
    vo_coll: true, vo_rad: false, vo_tank: false,
    v_air: false
  },
  GREENHOUSE_HEATING: {
    vi_btm: false, vi_top: true, vi_coll: false,
    vo_coll: false, vo_rad: true, vo_tank: false,
    v_air: false
  },
  ACTIVE_DRAIN: {
    vi_btm: false, vi_top: false, vi_coll: true,
    vo_coll: false, vo_rad: false, vo_tank: true,
    v_air: true
  },
  EMERGENCY_HEATING: {
    vi_btm: false, vi_top: false, vi_coll: false,
    vo_coll: false, vo_rad: false, vo_tank: false,
    v_air: false
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

// Valve timing constants (FR-001, FR-002, FR-007).
//   maxConcurrentOpens: max valves that may be inside the energizing window
//                       simultaneously (24 V PSU current budget).
//   openWindowMs:       duration of the energizing window per valve (time
//                       for the motor to physically reach open).
//   minOpenMs:          minimum time a valve must remain energized holding
//                       open before a close command is allowed (closing-
//                       motion capacitor charging time).
var VALVE_TIMING = {
  maxConcurrentOpens: 2,
  openWindowMs: 20000,
  minOpenMs: 60000
};

var DEFAULT_CONFIG = {
  // Collector must exceed tank_bottom by this many K to start a solar
  // charging session. Raised from 5 → 10 in early testing to avoid
  // short-cycle entries on marginal irradiance; lowered back to 5 on
  // 2026-04-21 after logs showed the controller bypassing obvious
  // charging opportunities (e.g. 40 °C collector vs 32 °C bottom was
  // still below the 10 K bar). Lowered further 5 → 3 on 2026-04-22
  // after a diurnal simulation sweep showed ~1% more daily capture
  // with ~6 min earlier morning refill; below 3 K the refill pumping
  // is net-negative (pipe loss + flow-pinned collector exceed gain).
  solarEnterDelta: 3,
  // Solar charging exits when the tank has stopped accepting heat.
  // The "tank temperature" for this purpose is the mean of tank_top and
  // tank_bottom — a stratified tank can peg tank_top near the collector
  // return temperature while tank_bottom is still climbing, which is
  // energy flowing in at the cold end, not a stall. Tracking the mean
  // keeps those sessions running. Two exit conditions:
  //   - mean tank temp has not risen for solarExitStallSeconds, OR
  //   - mean tank temp has dropped solarExitTankDrop °C from the peak
  //
  // solarExitStallSeconds history:
  //   300 s → 180 s (2026-04-22, early simulator)
  //   180 s →  60 s (2026-04-23 first pass — v2 sim showed +1.8 % on
  //                 cloudy days; later found to be a simulator artifact)
  //    60 s → 300 s (2026-04-23 second pass — v2 sim with refit collector
  //                 thermal mass (50 kJ/K vs the earlier 5 kJ/K). Under
  //                 the corrected model energy is flat across 60–600 s
  //                 because a realistic collector holds heat through
  //                 cloud dips regardless of pump state, so the "fast
  //                 exit" advantage vanished. With energy tied, the
  //                 cycle-count tiebreaker favors longer stalls:
  //                 broken-cloud entries at stall = 60/180/300/600 s
  //                 were 12 / 10 / 8 / 6. Clear-day and weak-sun entries
  //                 are 3 and 1 regardless. Going back to 300 s — the
  //                 pre-2026-04-22 default — cuts broken-cloud cycles
  //                 ~20 % vs. 180 with no energy penalty. 600 s would
  //                 cut more but starts to conflict with the drop-from-
  //                 peak safety (we want to exit quickly if tank is
  //                 actually cooling, not just not-rising).
  solarExitTankDrop: 2,
  solarExitStallSeconds: 300,
  // Bypass the stall-timer exit when the collector is still clearly
  // much hotter than tank_top. Morning sessions with a cold tank can
  // sit with collector 40–60 K above tank_top while tank_top plateaus
  // (stratification reaches the collector return temperature). Exiting
  // after 180 s of plateau throws away huge thermodynamic head — the
  // collector will just run up to 90 °C+ while we sit idle. Drop-from-
  // peak still fires, so if the tank is actually *cooling* we still
  // exit. Set to 0 to disable the bypass (legacy behavior).
  solarStallBypassDelta: 10,
  greenhouseEnterTemp: 10,
  greenhouseExitTemp: 12,
  greenhouseMinTankDelta: 5,
  greenhouseExitTankDelta: 2,
  emergencyEnterTemp: 9,
  emergencyExitTemp: 12,
  // Fan-cool overlay hysteresis (overlays.greenhouse_fan_cooling in
  // system.yaml). Repurposes the radiator fan as a circulation aid
  // when the greenhouse runs hot.
  greenhouseFanCoolEnter: 30,
  greenhouseFanCoolExit: 28,
  // Drain threshold for the colder of (outdoor, collector). Raised
  // 2 → 4 on 2026-04-22 for a safety margin: at 2 °C the collector is
  // already close enough to freezing that a sharp cooling transient
  // could reach the ice point before the next 30 s eval tick. 4 °C
  // drains ~48 min earlier in a typical spring night with negligible
  // energy cost (refill fires 17 min later; charging minutes over a
  // diurnal cycle drop ~2%).
  freezeDrainTemp: 4,
  overheatDrainTemp: 95,
  overheatResumeTemp: 75,
  minModeDuration: 300,
  minRunTimeAfterRefill: 600,
  refillRetryCooldown: 1800,
  sensorStaleThreshold: 150,
  drainTimeout: 600,  // belt-and-suspenders safety net — normal drain completes at DRAIN_PUMP_RUN_MS=300s; this only fires if the shell's drain_timer never triggers stopDrain (hung Timer, crash, etc.)
  // Uniform watchdog cool-off ban duration in seconds (4 hours).
  // Applied when a watchdog fires and auto-shutdown or user-triggered
  // "Shutdown now" executes. Mode re-entry is blocked until this
  // duration elapses or the ban is explicitly cleared via the UI.
  watchdogBanSeconds: 14400
};

// Sentinel value stored in wb[mode] when the user has permanently
// disabled a mode via the device-config UI. Distinct from the 4-hour
// cool-off written by applyBanAndShutdown() (a unix timestamp ~now+4h).
// Mirrored from server/lib/device-config.js — keep them in sync if
// you ever change the magic number.
var WB_PERMANENT_SENTINEL = 9999999999;

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

// Device config uses compact keys to fit Shelly KVS 256-byte limit:
//   ce (bool)   = controls_enabled
//   ea (int)    = enabled_actuators bitmask: valves=1, pump=2, fan=4, sh=8, ih=16
//   mo (obj)    = manual override: {a, ex, ss, fm?} or null
//                 a=active, ex=expiry unix, ss=suppress safety, fm=forced mode
//   am (array)  = allowed_modes: ["I","SC",...] or null (all)
//   v  (int)    = version

var EA_VALVES = 1;
var EA_PUMP = 2;
var EA_FAN = 4;
var EA_SPACE_HEATER = 8;
var EA_IMMERSION = 16;

var MODE_CODE = {
  I: "IDLE", SC: "SOLAR_CHARGING", GH: "GREENHOUSE_HEATING",
  AD: "ACTIVE_DRAIN", EH: "EMERGENCY_HEATING"
};

// Map a full mode name back to its short code for wb ban lookup.
function shortCodeOf(mode) {
  if (mode === "IDLE") return "I";
  if (mode === "SOLAR_CHARGING") return "SC";
  if (mode === "GREENHOUSE_HEATING") return "GH";
  if (mode === "ACTIVE_DRAIN") return "AD";
  if (mode === "EMERGENCY_HEATING") return "EH";
  return null;
}

// Stamp the heater + fan-cool overlay actuators onto an already-built
// result. Used at every early-return path where overlays must survive
// alongside the chosen pump-mode result (drain modes, min-duration
// hold, the final result builder). The heater overlay is unmasked at
// this layer — control.js setSpaceHeater enforces the EA_SPACE_HEATER
// bit. Fan-cool is masked here because it's a comfort overlay that
// must respect the user's EA_FAN bit (see existing test commentary).
function stampOverlays(result, flags, deviceConfig) {
  if (flags.emergencyHeatingActive) {
    result.actuators.space_heater = true;
  }
  if (flags.greenhouseFanCoolingActive &&
      (!deviceConfig || (deviceConfig.ce && ((deviceConfig.ea || 0) & EA_FAN)))) {
    result.actuators.fan = true;
  }
  return result;
}

function makeResult(mode, flags, deviceConfig, safetyOverride, reason) {
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
    suppressed: false,
    safetyOverride: !!safetyOverride,
    // Reason code explaining which decision path the evaluator took this
    // tick. The server copies it alongside state_events.cause so the
    // System Logs UI can show "automation: solar_stall" instead of a
    // bare "automation" tag. Null only for legacy/missing paths.
    reason: reason || null
  };
  // Safety overrides (freeze drain, overheat drain) bypass all device config
  // suppression — they MUST actuate even when controls are disabled.
  if (safetyOverride) {
    return result;
  }
  if (deviceConfig && !deviceConfig.ce) {
    result.suppressed = true;
  } else if (deviceConfig) {
    var ea = deviceConfig.ea || 0;
    if (!(ea & EA_PUMP)) actuators.pump = false;
    if (!(ea & EA_FAN)) actuators.fan = false;
    if (!(ea & EA_SPACE_HEATER)) actuators.space_heater = false;
    if (!(ea & EA_IMMERSION)) actuators.immersion_heater = false;
    if (!(ea & EA_VALVES)) {
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
    emergencyHeatingActive: state.emergencyHeatingActive || false,
    greenhouseFanCoolingActive: state.greenhouseFanCoolingActive || false,
    // Solar-charging tank-rise tracking. Carried forward only while we
    // remain in SOLAR_CHARGING — cleared whenever pumpMode ends up
    // anything else (see end of function). Metric is the mean of
    // tank_top and tank_bottom so stratification (top plateaus, bottom
    // rises) still registers as "gaining heat".
    solarChargePeakTankAvg: null,
    solarChargePeakTankAvgAt: 0
  };

  // Carry forward and update peak tank-mean while in SOLAR_CHARGING. We
  // do this before the min-duration hold so peakAt advances during the
  // hold — otherwise the stall counter would fire the instant the hold
  // expires.
  if (state.currentMode === MODES.SOLAR_CHARGING) {
    var carriedPeak = (state.solarChargePeakTankAvg !== undefined &&
                       state.solarChargePeakTankAvg !== null)
      ? state.solarChargePeakTankAvg
      : null;
    var carriedPeakAt = state.solarChargePeakTankAvgAt || 0;
    if (t.tank_top !== null && t.tank_bottom !== null) {
      var tankAvgNow = (t.tank_top + t.tank_bottom) / 2;
      if (carriedPeak === null || tankAvgNow > carriedPeak) {
        carriedPeak = tankAvgNow;
        carriedPeakAt = state.now;
      } else if (carriedPeakAt === 0) {
        // First eval after entry where peak wasn't seeded — anchor now
        carriedPeakAt = state.now;
      }
    }
    flags.solarChargePeakTankAvg = carriedPeak;
    flags.solarChargePeakTankAvgAt = carriedPeakAt;
  }

  // Sensor staleness — any sensor stale triggers IDLE, all overlays off
  // (a failed greenhouse sensor must not strand emergency heat or the
  // fan-cool fan running indefinitely).
  if (anySensorStale(state.sensorAge, cfg.sensorStaleThreshold)) {
    flags.emergencyHeatingActive = false;
    flags.greenhouseFanCoolingActive = false;
    flags.solarChargePeakTankAvg = null;
    flags.solarChargePeakTankAvgAt = 0;
    return makeResult(MODES.IDLE, flags, dc, false, "sensor_stale");
  }

  // ── Overlay hysteresis + ban gate ──
  // Run BEFORE every early-return path below (drain modes, min-duration
  // hold) so overlays are decided per-tick on the latest temperature
  // and the latest wb.EH ban state. Pre-2026-05-02 these updates
  // happened only after the early returns, so:
  //   - freeze_drain at outdoor=2 °C left the heater off even when
  //     greenhouse was 4 °C (worst-case timing for plant safety).
  //   - a 5-min min-duration hold froze the emergency flag at its
  //     entry value, so a mid-hold greenhouse crash didn't fire heat.
  //   - a mid-hold "Disable Emergency Heating" via the app didn't
  //     take effect until the hold expired.
  if (t.greenhouse !== null) {
    if (flags.emergencyHeatingActive) {
      if (t.greenhouse > cfg.emergencyExitTemp) {
        flags.emergencyHeatingActive = false;
      }
    } else if (t.greenhouse < cfg.emergencyEnterTemp) {
      flags.emergencyHeatingActive = true;
    }
    if (flags.greenhouseFanCoolingActive) {
      if (t.greenhouse <= cfg.greenhouseFanCoolExit) {
        flags.greenhouseFanCoolingActive = false;
      }
    } else if (t.greenhouse >= cfg.greenhouseFanCoolEnter) {
      flags.greenhouseFanCoolingActive = true;
    }
  }
  // wb.EH ban (user-disabled sentinel OR watchdog cool-off) suppresses
  // the heater overlay everywhere it might fire below. Cleared here
  // rather than at the overlay return so drain-mode + min-duration
  // paths see the same gate.
  if (flags.emergencyHeatingActive && dc && dc.wb && dc.wb.EH && dc.wb.EH > state.now) {
    flags.emergencyHeatingActive = false;
  }

  // Already draining — stay until shell completes or timeout
  if (state.currentMode === MODES.ACTIVE_DRAIN) {
    if (elapsed > cfg.drainTimeout) {
      flags.collectorsDrained = true;
      return stampOverlays(makeResult(MODES.IDLE, flags, dc, false, "drain_timeout"), flags, dc);
    }
    return stampOverlays(makeResult(MODES.ACTIVE_DRAIN, flags, dc, false, "drain_running"), flags, dc);
  }

  // Freeze protection — preempts immediately, ignores min duration
  // safetyOverride=true: MUST NOT be suppressed by device config
  //
  // Trip point: the *colder* of the outdoor and collector sensors. On
  // clear nights the sky-facing collector radiates to deep space and
  // can sit 4–8 K below the sheltered outdoor probe — a collector at
  // -2 °C with an outdoor reading of 4 °C is a real freeze risk, so
  // checking only outdoor misses it. Either sensor null-guards
  // independently so a failed outdoor sensor still lets the collector
  // trigger, and vice versa.
  var coldest = null;
  if (t.outdoor !== null) coldest = t.outdoor;
  if (t.collector !== null && (coldest === null || t.collector < coldest)) coldest = t.collector;
  if (coldest !== null && coldest < cfg.freezeDrainTemp &&
      !state.collectorsDrained) {
    flags.solarChargePeakTankAvg = null;
    flags.solarChargePeakTankAvgAt = 0;
    return stampOverlays(makeResult(MODES.ACTIVE_DRAIN, flags, dc, true, "freeze_drain"), flags, dc);
  }

  // Collector overheat protection — drain only as a last resort.
  // If already circulating (solar charging) and collector still exceeds the
  // threshold, circulation can't keep up — drain to prevent boiling.
  // safetyOverride=true: MUST NOT be suppressed by device config
  if (t.collector !== null && t.collector > cfg.overheatDrainTemp &&
      state.currentMode === MODES.SOLAR_CHARGING && !state.collectorsDrained) {
    flags.solarChargePeakTankAvg = null;
    flags.solarChargePeakTankAvgAt = 0;
    return stampOverlays(makeResult(MODES.ACTIVE_DRAIN, flags, dc, true, "overheat_drain"), flags, dc);
  }

  // Minimum mode duration (not for IDLE or EMERGENCY_HEATING, not for drain above)
  if (state.currentMode !== MODES.IDLE &&
      state.currentMode !== MODES.EMERGENCY_HEATING &&
      elapsed < getMinDuration(state, cfg)) {
    return stampOverlays(makeResult(state.currentMode, flags, dc, false, "min_duration"), flags, dc);
  }

  // ── Pump mode selection (solar > greenhouse heating > idle) ──
  // Solar charging has priority: free energy, time-limited (daylight only).
  // Greenhouse heating uses stored energy and can run any time.
  var pumpMode = MODES.IDLE;
  // Decision reason for this tick. Updated as the evaluator progresses
  // through the branches below; the final value is attached to the result
  // and published with every state snapshot. See CAUSE_LABELS /
  // REASON_LABELS for the stable, UI-mapped codes.
  var reason = "idle";

  // Solar charging — capture free energy first
  if (t.collector !== null && t.tank_bottom !== null) {
    if (state.currentMode === MODES.SOLAR_CHARGING) {
      // Stay in solar charging until the tank stops accepting heat.
      // We keep pumping even when collector ≈ tank_bottom because the
      // collector continues absorbing irradiance while flow is on, and
      // the tank itself is the most direct signal of whether we are
      // still gaining energy. Two exit conditions:
      //   1. tank mean has not exceeded the session peak for the past
      //      cfg.solarExitStallSeconds seconds (stall), AND the collector
      //      is not still running far hotter than tank_top (see
      //      solarStallBypassDelta), OR
      //   2. tank mean has dropped >= cfg.solarExitTankDrop °C from the
      //      session peak (we're actively cooling the tank).
      var stalled = false;
      var droppedFromPeak = false;
      var tankAvg = (t.tank_top !== null && t.tank_bottom !== null)
        ? (t.tank_top + t.tank_bottom) / 2 : null;
      if (tankAvg !== null && flags.solarChargePeakTankAvg !== null) {
        droppedFromPeak =
          (flags.solarChargePeakTankAvg - tankAvg) >= cfg.solarExitTankDrop;
        stalled =
          (state.now - flags.solarChargePeakTankAvgAt) >= cfg.solarExitStallSeconds;
      }
      // Collector-much-hotter bypass: if the thermodynamic head is still
      // clearly large, ignore stall — the tank *is* gaining, just slowly
      // (flow-rate limited). Drop-from-peak still fires if we overshoot
      // and the tank starts cooling.
      if (stalled && cfg.solarStallBypassDelta > 0 &&
          t.collector !== null && t.tank_top !== null &&
          (t.collector - t.tank_top) > cfg.solarStallBypassDelta) {
        stalled = false;
      }
      if (!stalled && !droppedFromPeak) {
        pumpMode = MODES.SOLAR_CHARGING;
        reason = "solar_active";
      } else if (droppedFromPeak) {
        // droppedFromPeak wins over stalled when both are true — it's the
        // more decisive signal (tank is actively cooling).
        reason = "solar_drop_from_peak";
      } else {
        reason = "solar_stall";
      }
      // Otherwise fall through to IDLE / other modes
    } else if (!state.collectorsDrained) {
      // Normal solar entry — collector clearly hotter than tank bottom
      if (t.collector > t.tank_bottom + cfg.solarEnterDelta) {
        pumpMode = MODES.SOLAR_CHARGING;
        reason = "solar_enter";
        if (t.tank_top !== null && t.tank_bottom !== null) {
          flags.solarChargePeakTankAvg = (t.tank_top + t.tank_bottom) / 2;
          flags.solarChargePeakTankAvgAt = state.now;
        }
      }
    } else {
      // Speculative refill — collectors drained, conditions suggest daylight.
      // Both sensors must be above the freeze threshold before refilling:
      // a collector that is warming in the sun but still below freezing
      // would re-trigger the drain immediately after refill, and a warm
      // outdoor reading doesn't protect a still-cold collector (same
      // radiative-cooling asymmetry the drain trigger now handles).
      if (t.collector > t.tank_bottom + cfg.solarEnterDelta &&
          t.outdoor !== null && t.outdoor >= cfg.freezeDrainTemp &&
          t.collector >= cfg.freezeDrainTemp) {
        if (state.now - state.lastRefillAttempt > cfg.refillRetryCooldown) {
          flags.collectorsDrained = false;
          flags.lastRefillAttempt = state.now;
          pumpMode = MODES.SOLAR_CHARGING;
          reason = "solar_refill";
          if (t.tank_top !== null && t.tank_bottom !== null) {
            flags.solarChargePeakTankAvg = (t.tank_top + t.tank_bottom) / 2;
            flags.solarChargePeakTankAvgAt = state.now;
          }
        }
      }
    }
  }

  // Greenhouse heating — use tank when no solar available
  // Exit when tank < greenhouse + 2°C to avoid cooling via radiator
  if (pumpMode === MODES.IDLE && t.greenhouse !== null && t.tank_top !== null) {
    if (state.currentMode === MODES.GREENHOUSE_HEATING) {
      if (t.greenhouse <= cfg.greenhouseExitTemp &&
          t.tank_top >= t.greenhouse + cfg.greenhouseExitTankDelta) {
        pumpMode = MODES.GREENHOUSE_HEATING;
        reason = "greenhouse_active";
      } else if (t.greenhouse > cfg.greenhouseExitTemp) {
        // Greenhouse crossed the warm-enough threshold — stop heating.
        reason = "greenhouse_warm";
      } else {
        // Tank dropped below greenhouse + exit delta — no longer useful
        // energy available (further pumping would cool via radiator).
        reason = "greenhouse_tank_depleted";
      }
    } else if (t.greenhouse < cfg.greenhouseEnterTemp &&
               t.tank_top > t.greenhouse + cfg.greenhouseMinTankDelta) {
      pumpMode = MODES.GREENHOUSE_HEATING;
      reason = "greenhouse_enter";
    }
  }

  // ── Collector overheat: force solar charging to circulate and cool ──
  // Overrides greenhouse heating or idle when collector is dangerously hot.
  // If circulation can't keep up, the preemption above will trigger drain.
  if (t.collector !== null && t.collector > cfg.overheatDrainTemp &&
      !state.collectorsDrained && pumpMode !== MODES.SOLAR_CHARGING) {
    pumpMode = MODES.SOLAR_CHARGING;
    reason = "overheat_circulate";
    if (t.tank_top !== null && t.tank_bottom !== null &&
        flags.solarChargePeakTankAvg === null) {
      flags.solarChargePeakTankAvg = (t.tank_top + t.tank_bottom) / 2;
      flags.solarChargePeakTankAvgAt = state.now;
    }
  }

  // Clear peak tracking if we are not staying in / entering SOLAR_CHARGING
  if (pumpMode !== MODES.SOLAR_CHARGING) {
    flags.solarChargePeakTankAvg = null;
    flags.solarChargePeakTankAvgAt = 0;
  }

  // ── Banned-mode collapse ──
  // If physics picked a pump mode that wb bans (user-disabled sentinel
  // or watchdog cool-off), collapse it to IDLE here — BEFORE overlay
  // dispatch — so the emergency-overlay path below sees pumpMode ===
  // IDLE and can return EMERGENCY_HEATING when the greenhouse is
  // critically cold. Doing this only after `result` is built (the
  // previous post-evaluation ban check) silently dropped the
  // emergency / fan-cool overlay actuators when the rebuild swapped
  // them onto an IDLE template. See the 2026-05-02 field log:
  // wb.GH=disabled + greenhouse=4 °C left the space heater off for
  // hours despite EH being enabled. The ban reason is preserved so
  // the System Logs UI still surfaces "mode_disabled" /
  // "watchdog_ban" instead of plain "idle".
  if (dc && dc.wb && pumpMode !== MODES.IDLE) {
    var pumpCode = shortCodeOf(pumpMode);
    if (pumpCode && dc.wb[pumpCode] && dc.wb[pumpCode] > state.now) {
      reason = (dc.wb[pumpCode] >= WB_PERMANENT_SENTINEL) ? "mode_disabled" : "watchdog_ban";
      pumpMode = MODES.IDLE;
      flags.solarChargePeakTankAvg = null;
      flags.solarChargePeakTankAvgAt = 0;
    }
  }

  // ── Pump mode → mode result (with overlay return for pure emergency) ──
  // wb.EH is gated up at the hysteresis block so flags.emergencyHeatingActive
  // is already false when EH is banned. When pumpMode is IDLE and the
  // flag is set, the system "is" in Emergency Heating — so the natural
  // pumpMode reason (e.g. "greenhouse_tank_depleted") is replaced with
  // "emergency_enter" and the mode itself becomes EMERGENCY_HEATING.
  // For non-IDLE pump modes the heater rides as an overlay alongside.
  if (flags.emergencyHeatingActive && pumpMode === MODES.IDLE) {
    return makeResult(MODES.EMERGENCY_HEATING, flags, dc, false, "emergency_enter");
  }
  return stampOverlays(makeResult(pumpMode, flags, dc, false, reason), flags, dc);
}

// ── Valve transition scheduler (pure, no Shelly calls) ──
//
// planValveTransition is the sole decision-maker for staged opens, deferred
// closes, and resume scheduling. It is pure: no Date.now(), no globals, no
// platform APIs. Inputs:
//   target    — desired valve map (keys = valve names, values = bool where
//               true = open / energized). All valves (including v_air) are
//               physically normally-closed: energized = open, de-energized
//               = closed.
//   current   — current physical valve map (same polarity convention).
//   openSince — map of valve name → epoch-ms when the valve most recently
//               finished its opening window. `0` means "unknown / boot" and
//               the hold is treated as satisfied (FR-015).
//   opening   — map of valve name → epoch-ms at which the current opening
//               window ends. Presence + opening[v] > now means "still mid-
//               flight". Missing key means "not currently opening".
//   now       — epoch-ms supplied by caller (INV8: no Date.now() here).
//   cfg       — timing config. Defaults to VALVE_TIMING. Shape:
//               {maxConcurrentOpens, openWindowMs, minOpenMs}.
//
// Returns:
//   {
//     startOpening:   [names],        // open right now (slots available)
//     closeNow:       [names],        // close right now (hold satisfied)
//     queuedOpens:    [names],        // still need to open, no slot available
//     deferredCloses: {name: readyAt},// need to close, hold not yet satisfied
//     nextResumeAt:   number|null,    // earliest future ms for resume timer
//     targetReached:  bool            // true iff no more work remains
//   }
function planValveTransition(target, current, openSince, opening, now, cfg) {
  var timing = cfg || VALVE_TIMING;
  var plan = {
    startOpening: [],
    closeNow: [],
    queuedOpens: [],
    deferredCloses: {},
    nextResumeAt: null,
    targetReached: false
  };

  // Union of target + current keys, collected into a stable alphabetical
  // order so that every call with the same logical input produces the
  // same action arrays (checklist case 15 / INV8 determinism). We cannot
  // call Array.prototype.sort() on Shelly's Espruino runtime, so iterate
  // the pre-sorted VALVE_NAMES_SORTED constant and only include names
  // that actually appear in target or current. Any key present in target
  // or current but not in VALVE_NAMES_SORTED is appended at the end in
  // insertion order — defensive, since the shell always uses the 8 known
  // valve names.
  var seen = {};
  var names = [];
  var k;
  for (var si = 0; si < VALVE_NAMES_SORTED.length; si++) {
    var sname = VALVE_NAMES_SORTED[si];
    if (target[sname] !== undefined || current[sname] !== undefined) {
      seen[sname] = true;
      names.push(sname);
    }
  }
  for (k in target) { if (!seen[k]) { seen[k] = true; names.push(k); } }
  for (k in current) { if (!seen[k]) { seen[k] = true; names.push(k); } }

  // Count live opening windows. A window is live iff its entry exists and
  // opening[v] > now. Expired entries are ignored (the shell is expected to
  // have already cleared them in resumeTransition, but defend against stale
  // input).
  var liveOpens = 0;
  var earliestLiveOpen = null;
  for (k in opening) {
    if (opening[k] > now) {
      liveOpens++;
      if (earliestLiveOpen === null || opening[k] < earliestLiveOpen) {
        earliestLiveOpen = opening[k];
      }
    }
  }

  // Classify into needs-open / needs-close / satisfied. A valve whose
  // opening window is still live is left alone on this tick (FR-017,
  // contract §3 option b): it counts against the slot budget via
  // liveOpens, but does not enter any action list. When its window ends
  // the shell will write openSince[v] and the scheduler will see it as a
  // normal close candidate on the next invocation.
  var needsOpen = [];
  var needsClose = [];
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var mid = opening[name] !== undefined && opening[name] > now;
    if (mid) continue;
    var tgt = !!target[name];
    var cur = !!current[name];
    if (tgt === cur) continue; // FR-013 no-op
    if (tgt && !cur) needsOpen.push(name);
    else needsClose.push(name);
  }

  // ── Open set: slot-budget (FR-001, FR-004) ──
  var freeSlots = timing.maxConcurrentOpens - liveOpens;
  if (freeSlots < 0) freeSlots = 0;
  for (var j = 0; j < needsOpen.length; j++) {
    if (freeSlots > 0) {
      plan.startOpening.push(needsOpen[j]);
      freeSlots--;
    } else {
      plan.queuedOpens.push(needsOpen[j]);
    }
  }

  // ── Close set: min-open hold (FR-007, FR-015, FR-017) ──
  // For each valve that needs to close and is not mid-opening (already
  // filtered above), compute the earliest time the close is allowed:
  //   readyAt = openSince[v] + minOpenMs
  // If openSince[v] is 0 the valve is boot-recovered and the hold is
  // trivially satisfied (FR-015 / R7). If readyAt <= now the close fires
  // immediately; otherwise it is deferred with its ready time.
  for (var c = 0; c < needsClose.length; c++) {
    var cn = needsClose[c];
    var since = openSince[cn] || 0;
    if (since === 0) {
      plan.closeNow.push(cn);
      continue;
    }
    var readyAt = since + timing.minOpenMs;
    if (readyAt <= now) {
      plan.closeNow.push(cn);
    } else {
      plan.deferredCloses[cn] = readyAt;
    }
  }

  // ── nextResumeAt ──
  // Minimum of every live opening window end (pre-existing + freshly
  // started) and every deferred-close ready timestamp. Null iff nothing
  // remains (targetReached).
  var candidate = null;
  if (earliestLiveOpen !== null) candidate = earliestLiveOpen;
  if (plan.startOpening.length > 0) {
    var freshWindow = now + timing.openWindowMs;
    if (candidate === null || freshWindow < candidate) candidate = freshWindow;
  }
  for (var dn in plan.deferredCloses) {
    var ra = plan.deferredCloses[dn];
    if (candidate === null || ra < candidate) candidate = ra;
  }
  plan.nextResumeAt = candidate;

  // ── targetReached ──
  // True iff every action list is empty AND no opening windows are live
  // AND no deferred closes remain. Covers contract §5, checklist case 9,
  // INV6.
  // The `_dk` rebinding silences the lint's no-unused-vars rule (var
  // declarations match `^_`); we only care about presence, not the key.
  var hasDeferred = false;
  for (var _dk in plan.deferredCloses) { hasDeferred = true; break; }
  if (
    plan.startOpening.length === 0 &&
    plan.closeNow.length === 0 &&
    plan.queuedOpens.length === 0 &&
    !hasDeferred &&
    liveOpens === 0
  ) {
    plan.targetReached = true;
    plan.nextResumeAt = null;
  }

  return plan;
}

// ── Bounded-parallelism worker pool (pure, testable) ──
//
// runBoundedPool(items, limit, dispatch, done) — dispatches at most
// `limit` work items concurrently via the caller-supplied `dispatch`
// function, drains FIFO as slots free, invokes `done(okAll)` once every
// item has finished. `dispatch(item, cb)` is expected to call cb(ok)
// asynchronously (or synchronously). Used by control.js to cap valve
// actuation concurrency at N=4, leaving one of the 5 Shelly concurrent-
// HTTP slots free for telemetry + relay command queue.
function runBoundedPool(items, limit, dispatch, done) {
  if (!items || items.length === 0) { if (done) done(true); return; }
  var idx = 0;
  var inFlight = 0;
  var okAll = true;
  var finished = false;
  // Re-entry guard: when dispatch fires its callback synchronously, the
  // callback below calls drain() again. Without the guard that would recurse
  // once per item and blow Espruino's ~20-frame stack on the Shelly Pro 4PM
  // (2026-04-20 crash: forced-mode ACTIVE_DRAIN with EA_VALVES cleared made
  // setValve return synchronously for every valve, and drain() recursed all
  // the way to "Too much recursion - the stack is about to overflow").
  // With the guard, a sync completion unwinds to the enclosing while-loop
  // iteration instead of growing the stack.
  var draining = false;
  function onItem(ok) {
    inFlight--;
    if (!ok) okAll = false;
    if (idx >= items.length && inFlight === 0) {
      if (!finished) { finished = true; if (done) done(okAll); }
      return;
    }
    drain();
  }
  function drain() {
    if (finished || draining) return;
    draining = true;
    while (inFlight < limit && idx < items.length && !finished) {
      var it = items[idx]; idx++;
      inFlight++;
      dispatch(it, onItem);
    }
    draining = false;
    // A synchronous dispatch that drained every slot may have finished the
    // pool while we were in the loop above — check terminal condition now.
    if (!finished && idx >= items.length && inFlight === 0) {
      finished = true;
      if (done) done(okAll);
    }
  }
  drain();
}

// ── State snapshot builder (pure) ──
//
// Extracted from control.js so the JSON shape broadcast over MQTT is
// testable in Node. Takes the shell's state object, the device config
// object, and the current epoch-ms timestamp; returns the snapshot the
// telemetry layer publishes on greenhouse/state.
//
// US5 adds three fields used by the playground:
//   opening        — list of valves currently inside their 20 s window
//   queued_opens   — FIFO of valves waiting for an opening slot
//   pending_closes — valves deferred due to the minimum-open hold, with
//                    their ready-at timestamps (unix seconds)
function buildSnapshotFromState(st, dc, now) {
  // Iterate VALVE_NAMES_SORTED to produce a deterministic order without
  // calling Array.prototype.sort() (unsupported on Shelly Espruino).
  var opening = [];
  for (var oi = 0; oi < VALVE_NAMES_SORTED.length; oi++) {
    var oname = VALVE_NAMES_SORTED[oi];
    if (st.valveOpening[oname] !== undefined && st.valveOpening[oname] > now) {
      opening.push(oname);
    }
  }
  var pendingCloses = [];
  var pi;
  var pending = st.valvePendingClose || [];
  for (pi = 0; pi < pending.length; pi++) {
    var pv = pending[pi];
    var since = (st.valveOpenSince && st.valveOpenSince[pv]) || 0;
    var readyAt = since > 0 ? Math.floor((since + VALVE_TIMING.minOpenMs) / 1000) : 0;
    pendingCloses.push({ valve: pv, readyAt: readyAt });
  }
  var queuedOpens = st.valvePendingOpen ? st.valvePendingOpen.slice(0) : [];
  return {
    ts: now,
    mode: st.mode.toLowerCase(),
    transitioning: st.transitioning,
    transition_step: st.transition_step || null,
    temps: {
      collector: st.temps.collector,
      tank_top: st.temps.tank_top,
      tank_bottom: st.temps.tank_bottom,
      greenhouse: st.temps.greenhouse,
      outdoor: st.temps.outdoor
    },
    valves: {
      vi_btm: !!st.valve_states.vi_btm,
      vi_top: !!st.valve_states.vi_top,
      vi_coll: !!st.valve_states.vi_coll,
      vo_coll: !!st.valve_states.vo_coll,
      vo_rad: !!st.valve_states.vo_rad,
      vo_tank: !!st.valve_states.vo_tank,
      v_air: !!st.valve_states.v_air
    },
    actuators: {
      pump: st.pump_on,
      fan: st.fan_on,
      space_heater: st.space_heater_on,
      immersion_heater: st.immersion_heater_on
    },
    flags: {
      collectors_drained: st.collectors_drained,
      emergency_heating_active: st.emergency_heating_active,
      greenhouse_fan_cooling_active: !!st.greenhouse_fan_cooling_active
    },
    controls_enabled: dc.ce,
    manual_override: (dc.mo && dc.mo.a) ? {
      active: true,
      expiresAt: dc.mo.ex,
      forcedMode: dc.mo.fm || null
    } : null,
    opening: opening,
    queued_opens: queuedOpens,
    pending_closes: pendingCloses,
    // What triggered the most recent mode transition. Consumed by the
    // server's mqtt-bridge on mode-change detection and written to
    // state_events.cause. One of: boot | automation | forced |
    // safety_override | watchdog_auto | user_shutdown | drain_complete
    // | failed.
    cause: st.lastTransitionCause || "boot",
    // Finer-grained decision code from the evaluator (solar_enter,
    // solar_stall, freeze_drain, greenhouse_enter, ...). Null when the
    // transition was not produced by evaluate() — e.g. user_shutdown,
    // drain_complete, failed. Written to state_events.reason on mode
    // change. See REASON_LABELS in playground/js/main.js for UI mapping.
    reason: st.lastTransitionReason || null
  };
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

// ── Watchdog anomaly detection ──
//
// Pure: no side effects, no Shelly APIs, no Date.now.
// Returns one of "sng" / "scs" / "ggr" (the watchdog id that should
// fire this tick) or null. Caller (control.js) is responsible for
// pending state + timer management.
//
// Parameters:
//   entry : { mode, at, tankTop, collector, greenhouse } | null
//           at = unix seconds (mode entry time)
//   now   : unix seconds (caller passes Date.now()/1000 or test clock)
//   s     : sensor snapshot { collector, tank_top, greenhouse, ... }
//   cfg   : device config subset { ce, we, wz, mo }
//
// Early-exits:
//   - null entry  -> not in a mode yet
//   - !cfg.ce     -> controls disabled (commissioning)
//   - mo.a=true   -> manual override hard-blocks all automation (2026-04-21)
//
// Priority: first-fires-wins by shortest window.
function detectAnomaly(entry, now, s, cfg) {
  if (!entry) return null;
  if (!cfg.ce) return null;
  if (cfg.mo && cfg.mo.a) return null;

  var el = now - entry.at;
  var we = cfg.we || {};
  var wz = cfg.wz || {};

  if (entry.mode === "SOLAR_CHARGING") {
    if (we.scs && !(wz.scs > now) && el >= 300 &&
        (entry.collector - s.collector) < 3) return "scs";
    if (we.sng && !(wz.sng > now) && el >= 600 &&
        (s.tank_top - entry.tankTop) < 0.5) return "sng";
  } else if (entry.mode === "GREENHOUSE_HEATING") {
    if (we.ggr && !(wz.ggr > now) && el >= 900 &&
        (s.greenhouse - entry.greenhouse) < 0.5) return "ggr";
  }
  return null;
}

// Export for Node.js testing (Shelly ignores this)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    evaluate: evaluate,
    detectAnomaly: detectAnomaly,
    MODES: MODES,
    MODE_VALVES: MODE_VALVES,
    MODE_ACTUATORS: MODE_ACTUATORS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    VALVE_NAMES_SORTED: VALVE_NAMES_SORTED,
    VALVE_TIMING: VALVE_TIMING,
    planValveTransition: planValveTransition,
    buildSnapshotFromState: buildSnapshotFromState,
    runBoundedPool: runBoundedPool,
    formatDuration: formatDuration,
    formatTemp: formatTemp,
    buildDisplayLabels: buildDisplayLabels,
    MODE_SHORT: MODE_SHORT,
    MODE_CODE: MODE_CODE,
    EA_VALVES: EA_VALVES,
    EA_PUMP: EA_PUMP,
    EA_FAN: EA_FAN,
    EA_SPACE_HEATER: EA_SPACE_HEATER,
    EA_IMMERSION: EA_IMMERSION
  };
}
