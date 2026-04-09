// Shelly Pro 4PM — Control Shell (decision logic in control-logic.js)
// Handles: timers, RPC, relays, KVS, sensors, config, MQTT commands

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

// toSchedulerView / fromSchedulerView live in control-logic.js (pure). They
// are globally available in the concatenated Shelly script; Node tests
// import them from control-logic.js.

// Sensor config from KVS (null = skip polling, safe IDLE default)
var sensorConfig = null;
// Device config from KVS
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
  // ── 023-limit-valve-operations: staged-transition state ──
  // In-memory only (not persisted to KVS, see FR-015 / research.md R7).
  valveOpenSince: {},       // name → epoch-ms when the current opening window ended
  valveOpening: {},         // name → epoch-ms when the current opening window will end
  valvePendingOpen: [],     // queued opens (waiting for a slot)
  valvePendingClose: [],    // queued closes (waiting for the min-open hold)
  targetValves: null,       // target valve map (scheduler polarity) during a transition
  targetResult: null,       // full evaluate() result held for end-of-transition finalization
  transitionTimer: null,    // transition-scoped timer handle
  transition_step: null,
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

// Seed valveOpenSince so that every valve is treated as "hold satisfied" on
// boot. FR-015: any valve observed to already be open at boot is allowed to
// close without waiting for the min-open hold. Fresh opens after boot get a
// real timestamp when their opening window ends.
function seedValveOpenSinceOnBoot() {
  var names = ["vi_btm","vi_top","vi_coll","vo_coll","vo_rad","vo_tank","v_ret","v_air"];
  for (var i = 0; i < names.length; i++) {
    state.valveOpenSince[names[i]] = 0;
  }
  state.valveOpening = {};
  state.valvePendingOpen = [];
  state.valvePendingClose = [];
  state.targetValves = null;
  state.targetResult = null;
  state.transitionTimer = null;
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

function updateDisplay(cb) {
  var labels = buildDisplayLabels({
    mode: state.mode,
    modeDurationMs: Date.now() - state.mode_start,
    temps: state.temps,
    lastError: state.last_error,
    collectorsDrained: state.collectors_drained,
  });
  function nextLabel(i) {
    if (i >= 4) { if (cb) cb(); return; }
    Shelly.call("Switch.SetConfig", {id: i, config: {name: labels[i]}}, function() {
      nextLabel(i + 1);
    });
  }
  nextLabel(0);
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

// buildSnapshotFromState is the pure snapshot builder (defined in
// control-logic.js so it is unit-testable in Node).
function buildStateSnapshot() {
  return buildSnapshotFromState(state, deviceConfig, Date.now());
}

function emitStateUpdate() {
  Shelly.emitEvent("state_updated", buildStateSnapshot());
}

function applyFlags(flags) {
  state.collectors_drained = flags.collectorsDrained;
  state.last_refill_attempt = flags.lastRefillAttempt * 1000;
  state.emergency_heating_active = flags.emergencyHeatingActive;
}

// ── Staged transitions (023-limit-valve-operations) ──
//
// The staged transition is a small state machine:
//
//   IDLE → PUMP_STOP → [SCHEDULE → … → SCHEDULE] → PUMP_PRIME → RUNNING
//
// Entry point transitionTo() stops the pump/fan/heaters, waits
// VALVE_SETTLE_MS, then invokes the SCHEDULE step. SCHEDULE calls the pure
// planValveTransition() helper, fires the returned closeNow + startOpening
// batches via a bounded worker pool (max 4 concurrent HTTP calls), stores
// the queued/deferred entries in state, and either:
//   - schedules a single transition-scoped Timer at plan.nextResumeAt if
//     work remains, OR
//   - proceeds to PUMP_PRIME → RUNNING if plan.targetReached is true.
//
// See specs/023-limit-valve-operations/data-model.md for the full model.

// Legacy transition_step values ("pump_stop", "valves_closing",
// "valves_opening", "pump_start") are preserved so existing playground and
// e2e code that reads this field keeps working.

// Bounded-parallelism actuation. Shelly scripts have a 5-concurrent-HTTP
// limit; we reserve one slot for telemetry / relay-command queue and cap
// the actuation pool at 4 (T050b). The pool logic is in control-logic.js
// (runBoundedPool) so it is unit-testable.
var VALVE_PARALLELISM = 4;

function runValveBatch(pairs, cb) {
  runBoundedPool(pairs, VALVE_PARALLELISM, function(pair, inner) {
    setValve(pair[0], pair[1], inner);
  }, cb);
}

function clearTransitionTimer() {
  if (state.transitionTimer !== null) {
    Timer.clear(state.transitionTimer);
    state.transitionTimer = null;
  }
}

function finalizeTransitionOK(result) {
  state.transition_step = "pump_start";
  emitStateUpdate();
  Timer.set(SHELL_CFG.PUMP_PRIME_MS, false, function() {
    state.mode = result.nextMode;
    state.mode_start = Date.now();
    state.transitioning = false;
    state.transition_step = null;
    state.targetValves = null;
    state.targetResult = null;
    state.valvePendingOpen = [];
    state.valvePendingClose = [];
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
}

function finalizeTransitionFail() {
  clearTransitionTimer();
  state.targetValves = null;
  state.targetResult = null;
  state.valvePendingOpen = [];
  state.valvePendingClose = [];
  setPump(false);
  state.mode = MODES.IDLE;
  state.mode_start = Date.now();
  state.transitioning = false;
  state.transition_step = null;
  emitStateUpdate();
}

// Build the scheduler view of the current physical valve state. Any valve
// whose state is unknown (e.g. never commanded) is treated as closed.
function currentSchedulerView() {
  var names = ["vi_btm","vi_top","vi_coll","vo_coll","vo_rad","vo_tank","v_ret","v_air"];
  var cur = {};
  for (var i = 0; i < names.length; i++) {
    cur[names[i]] = !!state.valve_states[names[i]];
  }
  return toSchedulerView(cur);
}

function scheduleStep() {
  // Called by transitionTo (initial entry after PUMP_STOP) and by
  // resumeTransition. Reads the stored target, calls the pure scheduler,
  // executes closeNow + startOpening, updates queued/pending state, then
  // either schedules the next resume or finalizes the transition.
  if (state.targetValves === null || state.targetResult === null) {
    // Transition was cancelled while we were waiting.
    return;
  }
  state.transition_step = "valves_opening";

  var now = Date.now();
  var schedulerTarget = state.targetValves;
  var schedulerCurrent = currentSchedulerView();
  var plan = planValveTransition(
    schedulerTarget, schedulerCurrent,
    state.valveOpenSince, state.valveOpening,
    now, VALVE_TIMING
  );

  // Record queued/deferred work before actuation — emitStateUpdate during
  // the batch will reflect the intended steady-state.
  state.valvePendingOpen = plan.queuedOpens.slice(0);
  state.valvePendingClose = [];
  for (var dn in plan.deferredCloses) {
    state.valvePendingClose.push(dn);
    // Observability for FR-010 / US4: log any deferred close with its
    // reason so operators investigating a "slow drain" can see why.
    console.log("defer_close " + dn + " openSince=" + state.valveOpenSince[dn] +
                " readyAt=" + plan.deferredCloses[dn]);
  }

  if (plan.targetReached) {
    emitStateUpdate();
    finalizeTransitionOK(state.targetResult);
    return;
  }

  // Pre-compute actuation pairs.
  // Open commands: write opening[v] = now + openWindowMs BEFORE the HTTP
  // call, so that concurrent reads of the state (snapshot broadcasts,
  // concurrent re-schedules) see the slot as consumed.
  var openPairs = [];
  var closePairs = [];
  var i;
  for (i = 0; i < plan.startOpening.length; i++) {
    var ov = plan.startOpening[i];
    state.valveOpening[ov] = now + VALVE_TIMING.openWindowMs;
    // Translate scheduler polarity → logical polarity for setValve().
    var logicalOpen = (ov === "v_air") ? false : true;
    openPairs.push([ov, logicalOpen]);
  }
  for (i = 0; i < plan.closeNow.length; i++) {
    var cv = plan.closeNow[i];
    // FR-017 defensive guard: never close a valve that is inside its
    // opening window. Should never happen (scheduler enforces this), but
    // refuse to act if somehow bypassed.
    if (state.valveOpening[cv] !== undefined && state.valveOpening[cv] > now) {
      continue;
    }
    var logicalClose = (cv === "v_air") ? true : false;
    closePairs.push([cv, logicalClose]);
    // Closing a valve clears the openSince so future opens start fresh.
    state.valveOpenSince[cv] = 0;
  }

  emitStateUpdate();

  // Fire closes in parallel, then fire new opens in parallel. Both batches
  // obey the bounded worker pool.
  runValveBatch(closePairs, function(okC) {
    if (!okC) { finalizeTransitionFail(); return; }
    runValveBatch(openPairs, function(okO) {
      if (!okO) { finalizeTransitionFail(); return; }

      // Always re-enter scheduleStep via Timer.set so the next step
      // runs on a fresh JS stack. Shelly's Espruino runtime has a
      // shallow stack limit (~10-20 frames); synchronously re-entering
      // scheduleStep from inside the runBoundedPool → HTTP callback
      // chain pushed the depth past the limit and crashed the script
      // with "Too much recursion" on the SC → IDLE transition
      // (2026-04-10). The delay is 1 ms when we just need to
      // re-evaluate after immediate actions, or the scheduler-chosen
      // remaining window otherwise.
      clearTransitionTimer();
      var delay;
      if (plan.nextResumeAt !== null) {
        delay = plan.nextResumeAt - Date.now();
        if (delay < 1) delay = 1;
      } else {
        delay = 1;
      }
      state.transitionTimer = Timer.set(delay, false, resumeTransition);
    });
  });
}

function resumeTransition() {
  state.transitionTimer = null;
  if (state.targetValves === null) return; // cancelled

  // Expire any opening windows whose time has come and record the moment
  // the capacitor started charging (research.md R3). We use the window-end
  // timestamp (stored at opening[v]) so that a slightly-late resume does
  // not push readyAt later than the physical reality.
  var now = Date.now();
  var toClear = [];
  for (var v in state.valveOpening) {
    if (state.valveOpening[v] <= now) {
      toClear.push(v);
    }
  }
  for (var i = 0; i < toClear.length; i++) {
    var n = toClear[i];
    state.valveOpenSince[n] = state.valveOpening[n];
    delete state.valveOpening[n];
  }

  scheduleStep();
}

function transitionTo(result) {
  if (state.transitioning) {
    // Allow in-place target change during an in-flight staged transition.
    if (state.targetValves !== null) {
      state.targetValves = toSchedulerView(result.valves);
      state.targetResult = result;
      // Do not interrupt any live opening windows — the next resume will
      // re-plan against the new target.
    }
    return;
  }
  state.transitioning = true;
  state.transition_step = "pump_stop";
  state.targetResult = result;
  state.targetValves = toSchedulerView(result.valves);

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
    scheduleStep();
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
  state.collectors_drained = true;
  Shelly.call("KVS.Set", {key: "drained", value: "1"});
  state.last_error = (reason === "timeout") ? "drain_timeout" : null;
  // Route through the staged transition so that valve closes honor the
  // PSU slot budget (trivially satisfied for closes) and the min-open
  // hold (FR-007) — same hardware rules as any other mode transition.
  var idleResult = {
    nextMode: MODES.IDLE,
    valves: {
      vi_btm: false, vi_top: false, vi_coll: false,
      vo_coll: false, vo_rad: false, vo_tank: false,
      v_ret: false, v_air: false
    },
    actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
    flags: {
      collectorsDrained: true,
      lastRefillAttempt: state.last_refill_attempt / 1000,
      emergencyHeatingActive: false
    },
    suppressed: false,
    safetyOverride: false
  };
  transitionTo(idleResult);
}

// ── Manual override helpers ──

function isManualOverrideActive() {
  if (!deviceConfig.mo || !deviceConfig.mo.a) return false;
  var now = Shelly.getComponentStatus("sys").unixtime || 0;
  if (now >= deviceConfig.mo.ex) {
    // TTL expired — clear override and persist
    deviceConfig.mo = null;
    Shelly.call("KVS.Set", {key: "config", value: JSON.stringify(deviceConfig)});
    return false;
  }
  return true;
}

// Manual override relay command queue. Serializes commands so at most one
// Shelly.call is in flight from this path at any moment AND emits at most
// one state update per burst. Without this, a user toggling 4 relays in
// quick succession would queue 4 fire-and-forget Switch.Set calls plus 4
// state emits plus 4 MQTT publishes within milliseconds — combined with
// the control loop's in-flight HTTP.GET sensor polls and the buildStateSnapshot
// allocations, the script ran out of heap or the firmware task watchdog
// fired and the entire Pro 4PM rebooted. Reproduced on device 2026-04-09.
//
// NOTE: Shelly's Espruino runtime does NOT support Array.prototype.shift().
// We use an index-pointer scheme: relayCmdHead advances, queue is replaced
// with [] when drained.
var relayCmdQueue = [];
var relayCmdHead = 0;
var relayCmdInFlight = false;

function handleRelayCommand(relay, on) {
  relayCmdQueue.push({relay: relay, on: on});
  processRelayCmdQueue();
}

function processRelayCmdQueue() {
  if (relayCmdInFlight) return;
  if (relayCmdHead >= relayCmdQueue.length) {
    // Queue drained — emit a single state snapshot for the whole burst,
    // then compact memory.
    relayCmdQueue = [];
    relayCmdHead = 0;
    emitStateUpdate();
    return;
  }
  if (!isManualOverrideActive()) {
    relayCmdQueue = [];
    relayCmdHead = 0;
    return;
  }
  var cmd = relayCmdQueue[relayCmdHead];
  relayCmdHead++;
  relayCmdInFlight = true;

  function done() {
    relayCmdInFlight = false;
    // Empirical Shelly Pro 4PM firmware bug (1.7.4): rapidly switching
    // multiple internal relays driving inductive loads (pump motor, fan
    // motor) causes the device to reboot, even when the calls are made
    // sequentially via HTTP RPC bypassing our script. Verified on
    // 2026-04-09: 50ms gap reboots, 100ms gap survives, 250ms gap survives.
    // Bypassing the script entirely (direct VPN HTTP RPC) reproduces the
    // crash. Switching id=3 with no load does NOT reboot.
    // Use 200ms for a safety margin above the empirical threshold.
    Timer.set(200, false, processRelayCmdQueue);
  }

  if (cmd.relay === "pump") {
    if (cmd.on && (!deviceConfig.ce || !(deviceConfig.ea & EA_PUMP))) { state.pump_on = false; done(); return; }
    Shelly.call("Switch.Set", {id: 0, on: cmd.on}, function() {
      state.pump_on = cmd.on;
      done();
    });
  } else if (cmd.relay === "fan") {
    if (cmd.on && (!deviceConfig.ce || !(deviceConfig.ea & EA_FAN))) { done(); return; }
    Shelly.call("Switch.Set", {id: 1, on: cmd.on}, function() {
      state.fan_on = cmd.on;
      done();
    });
  } else if (VALVES[cmd.relay]) {
    setValve(cmd.relay, cmd.on, function() { done(); });
  } else {
    done();
  }
}

// ── Control loop ──

function controlLoop() {
  if (state.transitioning) return;
  pollAllSensors(function() {
    updateDisplay(function() {
      if (state.transitioning) return;

      // Manual override guard: skip evaluate() when override is active
      if (isManualOverrideActive()) {
        if (!deviceConfig.mo.ss) {
          // Safety not suppressed — check for safety overrides only
          var evalState = buildEvalState();
          var result = evaluate(evalState, null, deviceConfig);
          if (result.safetyOverride) {
            // Safety takes precedence — end override and transition
            deviceConfig.mo = null;
            Shelly.call("KVS.Set", {key: "config", value: JSON.stringify(deviceConfig)});
            transitionTo(result);
            return;
          }
        }
        // Override active, no safety intervention — just emit state
        emitStateUpdate();
        processPendingCommands();
        return;
      }

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
  });
}

// ── MQTT command queue (sensor config apply + discovery) ──

var pendingApply = null;
var pendingDisc = null;

function processPendingCommands() {
  if (pendingApply) { var r = pendingApply; pendingApply = null; doApply(r); }
  else if (pendingDisc) { var d = pendingDisc; pendingDisc = null; doDiscover(d); }
}

function addonRpc(ip, method, params, cb) {
  var body = JSON.stringify({id:1,method:method,params:params||{}});
  Shelly.call("HTTP.POST",{url:"http://"+ip+"/rpc",body:body,content_type:"application/json",timeout:5},function(r,e){
    if(e||!r||r.code!==200||!r.body){cb(e?"RPC error: "+JSON.stringify(e):(r?"HTTP "+r.code:"No response from "+ip),null);return;}
    try{cb(null,JSON.parse(r.body));}catch(x){cb("Invalid JSON response",null);}
  });
}

function getDs18b20(res) {
  if (!res) return {};
  // JSON-RPC response: {id, result: {ds18b20: {...}}}
  if (res.result && res.result.ds18b20) return res.result.ds18b20;
  // Direct response: {ds18b20: {...}}
  if (res.ds18b20) return res.ds18b20;
  return {};
}

function getOneWireDevices(res) {
  if (!res) return [];
  // JSON-RPC response: {id, result: {devices: [...]}}
  if (res.result && res.result.devices) return res.result.devices;
  // Direct response: {devices: [...]}
  if (res.devices) return res.devices;
  return [];
}

function doApply(req) {
  var cfg=req.config;
  if(!cfg||!cfg.h||!cfg.s){Shelly.emitEvent("sensor_config_apply_result",{id:req.id,success:false,results:[]});return;}
  var tgt=req.target,hosts=[];
  for(var i=0;i<cfg.h.length;i++){if(!tgt||cfg.h[i]===tgt)hosts.push(cfg.h[i]);}
  var res=[];
  function next(idx){
    if(idx>=hosts.length){
      var ok=true;for(var j=0;j<res.length;j++){if(!res[j].ok)ok=false;}
      Shelly.emitEvent("sensor_config_apply_result",{id:req.id,success:ok,results:res});return;
    }
    var ip=hosts[idx],hi=-1;
    for(var k=0;k<cfg.h.length;k++){if(cfg.h[k]===ip){hi=k;break;}}
    addonRpc(ip,"SensorAddon.GetPeripherals",null,function(e,r){
      if(e){res.push({host:ip,ok:false,error:e,peripherals:0});next(idx+1);return;}
      var ex=[];var d=getDs18b20(r);for(var c in d)ex.push(c);
      function rm(ri){
        if(ri>=ex.length){add();return;}
        addonRpc(ip,"SensorAddon.RemovePeripheral",{component:ex[ri]},function(){rm(ri+1);});
      }
      function add(){
        var ta=[];for(var rl in cfg.s){if(cfg.s[rl].h===hi)ta.push({i:cfg.s[rl].i});}
        var n=0;
        function an(ai){
          if(ai>=ta.length){res.push({host:ip,ok:true,peripherals:n});next(idx+1);return;}
          addonRpc(ip,"SensorAddon.AddPeripheral",{type:"ds18b20",attrs:{cid:ta[ai].i}},function(ae){if(!ae)n++;an(ai+1);});
        }
        an(0);
      }
      rm(0);
    });
  }
  next(0);
}

function doDiscover(req) {
  var hosts=req.hosts||[],res=[];
  var wantTemp=!req.skipTemp;
  function next(idx){
    if(idx>=hosts.length){Shelly.emitEvent("discover_sensors_result",{id:req.id,results:res});return;}
    var ip=hosts[idx];
    addonRpc(ip,"SensorAddon.OneWireScan",null,function(e,r){
      if(e){res.push({host:ip,ok:false,error:e,sensors:[]});next(idx+1);return;}
      var devs=getOneWireDevices(r);
      var sns=[];
      for(var i=0;i<devs.length;i++){
        sns.push({addr:devs[i].addr||"",component:devs[i].component||null,tC:null});
      }
      if(!wantTemp){res.push({host:ip,ok:true,sensors:sns});next(idx+1);return;}
      // Poll temperature for each sensor that has a component
      function pollTemp(si){
        if(si>=sns.length){res.push({host:ip,ok:true,sensors:sns});next(idx+1);return;}
        var comp=sns[si].component;
        if(!comp||comp.indexOf("temperature:")!==0){pollTemp(si+1);return;}
        var cid=comp.replace("temperature:","");
        pollSensor("_disc",ip,cid,function(_n,val){
          if(val!==null)sns[si].tC=val;
          pollTemp(si+1);
        });
      }
      pollTemp(0);
    });
  }
  next(0);
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
      pendingApply = applyData.request;
    }
  } else if (ev.info.event === "discover_sensors") {
    var discData = ev.info.data;
    if (discData && discData.request) {
      pendingDisc = discData.request;
    }
  } else if (ev.info.event === "relay_command") {
    var relayData = ev.info.data;
    if (relayData && typeof relayData.relay === "string" && typeof relayData.on === "boolean") {
      handleRelayCommand(relayData.relay, relayData.on);
    }
  }
});

// ── Boot ──

function boot() {
  setPump(false);
  setFan(false);
  setSpaceHeater(false);
  setImmersion(false);

  seedValveOpenSinceOnBoot();

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
