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
  solarEnterDelta: 7,
  solarExitDelta: 3,
  greenhouseEnterTemp: 10,
  greenhouseExitTemp: 12,
  greenhouseMinTankDelta: 5,
  greenhouseExitTankDelta: 2,
  emergencyEnterTemp: 9,
  emergencyExitTemp: 12,
  freezeDrainTemp: 2,
  overheatDrainTemp: 95,
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

// Device config uses compact keys to fit Shelly KVS 256-byte limit:
//   ce (bool)   = controls_enabled
//   ea (int)    = enabled_actuators bitmask: valves=1, pump=2, fan=4, sh=8, ih=16
//   fm (string) = forced_mode: "I","SC","GH","AD","EH", or null
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

function expandModeCode(code) {
  if (!code) return null;
  return MODE_CODE[code] || code.toUpperCase();
}

function makeResult(mode, flags, deviceConfig, safetyOverride) {
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
    safetyOverride: !!safetyOverride
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
  // safetyOverride=true: MUST NOT be suppressed by device config
  if (t.outdoor !== null && t.outdoor < cfg.freezeDrainTemp &&
      !state.collectorsDrained) {
    return makeResult(MODES.ACTIVE_DRAIN, flags, dc, true);
  }

  // Collector overheat protection — drain only as a last resort.
  // If already circulating (solar charging) and collector still exceeds the
  // threshold, circulation can't keep up — drain to prevent boiling.
  // safetyOverride=true: MUST NOT be suppressed by device config
  if (t.collector !== null && t.collector > cfg.overheatDrainTemp &&
      state.currentMode === MODES.SOLAR_CHARGING && !state.collectorsDrained) {
    return makeResult(MODES.ACTIVE_DRAIN, flags, dc, true);
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

  // ── Pump mode selection (solar > greenhouse heating > idle) ──
  // Solar charging has priority: free energy, time-limited (daylight only).
  // Greenhouse heating uses stored energy and can run any time.
  var pumpMode = MODES.IDLE;

  // Solar charging — capture free energy first
  if (t.collector !== null && t.tank_bottom !== null) {
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
          t.outdoor !== null && t.outdoor >= cfg.freezeDrainTemp) {
        if (state.now - state.lastRefillAttempt > cfg.refillRetryCooldown) {
          flags.collectorsDrained = false;
          flags.lastRefillAttempt = state.now;
          pumpMode = MODES.SOLAR_CHARGING;
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
      }
      // Above exit temp or tank too close to greenhouse, fall through
    } else if (t.greenhouse < cfg.greenhouseEnterTemp &&
               t.tank_top > t.greenhouse + cfg.greenhouseMinTankDelta) {
      pumpMode = MODES.GREENHOUSE_HEATING;
    }
  }

  // ── Collector overheat: force solar charging to circulate and cool ──
  // Overrides greenhouse heating or idle when collector is dangerously hot.
  // If circulation can't keep up, the preemption above will trigger drain.
  if (t.collector !== null && t.collector > cfg.overheatDrainTemp &&
      !state.collectorsDrained && pumpMode !== MODES.SOLAR_CHARGING) {
    pumpMode = MODES.SOLAR_CHARGING;
  }

  // ── Forced mode override (for staged deployment / manual testing) ──
  if (dc && dc.fm) {
    var forcedMode = expandModeCode(dc.fm);
    if (MODES[forcedMode]) {
      pumpMode = MODES[forcedMode];
      flags.emergencyHeatingActive = false;
      return makeResult(pumpMode, flags, dc);
    }
  }

  // ── Combine pump mode + emergency overlay ──
  if (flags.emergencyHeatingActive && pumpMode === MODES.IDLE) {
    return makeResult(MODES.EMERGENCY_HEATING, flags, dc);
  }

  var result = makeResult(pumpMode, flags, dc);
  if (flags.emergencyHeatingActive) {
    result.actuators.space_heater = true;
  }

  // ── Allowed modes filter (for staged deployment) ──
  if (dc && dc.am && dc.am.length > 0) {
    var allowed = false;
    for (var ami = 0; ami < dc.am.length; ami++) {
      if (expandModeCode(dc.am[ami]) === result.nextMode) {
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

// ── Valve polarity translation ──
//
// V_air is physically normally-open (de-energized = open) for fail-safe
// drain on power loss. Every other valve is physically normally-closed
// (energized = open). The pure scheduler works in a uniform "energized
// = opening" model: when a valve is "energizing" it is drawing current
// from the 24 V PSU and its capacitor is charging, regardless of whether
// that corresponds to a logical open or a logical close. So at the
// scheduler boundary we swap the v_air entry: logical open ↔ de-
// energized, logical close ↔ energized. The scheduler sees the energized
// form; the rest of control.js and MODE_VALVES work in the logical form.
//
// The mapping is self-inverse, so `fromSchedulerView` is the same
// function exposed under a second name for readability at call sites.
function toSchedulerView(valves) {
  if (!valves) return valves;
  var result = {};
  for (var k in valves) {
    if (k === "v_air") {
      result.v_air = !valves.v_air;
    } else {
      result[k] = valves[k];
    }
  }
  return result;
}

function fromSchedulerView(valves) {
  return toSchedulerView(valves);
}

// ── Valve transition scheduler (pure, no Shelly calls) ──
//
// planValveTransition is the sole decision-maker for staged opens, deferred
// closes, and resume scheduling. It is pure: no Date.now(), no globals, no
// platform APIs. Inputs:
//   target    — desired valve map (keys = valve names, values = bool; for the
//               scheduler's view, "true" means "energized/opening/open",
//               not logical open — the shell applies v_air polarity at the
//               boundary).
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
  var hasDeferred = false;
  for (var dk in plan.deferredCloses) { hasDeferred = true; break; }
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
  function drain() {
    if (finished) return;
    while (inFlight < limit && idx < items.length) {
      var it = items[idx]; idx++;
      inFlight++;
      dispatch(it, function(ok) {
        inFlight--;
        if (!ok) okAll = false;
        if (idx >= items.length && inFlight === 0) {
          if (!finished) { finished = true; if (done) done(okAll); }
          return;
        }
        drain();
      });
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
      emergency_heating_active: st.emergency_heating_active
    },
    controls_enabled: dc.ce,
    manual_override: (dc.mo && dc.mo.a) ? {
      active: true,
      expiresAt: dc.mo.ex,
      suppressSafety: dc.mo.ss
    } : null,
    opening: opening,
    queued_opens: queuedOpens,
    pending_closes: pendingCloses
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

// Export for Node.js testing (Shelly ignores this)
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    evaluate: evaluate,
    MODES: MODES,
    MODE_VALVES: MODE_VALVES,
    MODE_ACTUATORS: MODE_ACTUATORS,
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    VALVE_NAMES_SORTED: VALVE_NAMES_SORTED,
    VALVE_TIMING: VALVE_TIMING,
    planValveTransition: planValveTransition,
    toSchedulerView: toSchedulerView,
    fromSchedulerView: fromSchedulerView,
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
