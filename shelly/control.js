// Shelly Pro 4PM — Control Shell (decision logic in control-logic.js)
// Handles: timers, RPC, relays, KVS, sensors, config, MQTT commands

var SHELL_CFG = {
  POLL_INTERVAL: 30000,
  VALVE_SETTLE_MS: 1000,
  PUMP_PRIME_MS: 5000,
  DRAIN_MONITOR_INTERVAL: 200,
  DRAIN_POWER_THRESHOLD: 20,
};

// Watchdog id → mode short code. Used by applyBanAndShutdown to
// translate a watchdog id to the mode code stored in wb.
var WATCHDOG_MODE = { sng: "SC", scs: "SC", ggr: "GH" };

var VALVES = {
  vi_btm:  {ip: "192.168.30.51", id: 0},
  vi_top:  {ip: "192.168.30.51", id: 1},
  vi_coll: {ip: "192.168.30.52", id: 0},
  vo_coll: {ip: "192.168.30.52", id: 1},
  vo_rad:  {ip: "192.168.30.53", id: 0},
  vo_tank: {ip: "192.168.30.53", id: 1},
  // 192.168.30.54 id 0 is a reserved spare (passive T joint at collector top — spec 024)
  v_air:   {ip: "192.168.30.54", id: 1},
};

// toSchedulerView / fromSchedulerView live in control-logic.js (pure). They
// are globally available in the concatenated Shelly script; Node tests
// import them from control-logic.js.

// Sensor config from KVS (null = skip polling, safe IDLE default)
var sensorConfig = null;
// Device config from KVS
var deviceConfig = { ce: false, ea: 0, fm: null, we: {}, wz: {}, wb: {}, v: 0 };

var state = {
  mode: MODES.IDLE,
  mode_start: 0,
  // Watchdog baseline: captured at every mode entry; lost on reboot.
  // Used by detectAnomaly() each tick to check if the expected
  // temperature delta materialized within the per-watchdog window.
  watchdog_baseline: null,
  // Pending watchdog fire: { id, firedAt }. Null when no fire is in
  // flight. Auto-shutdown fires at firedAt + 300s (5 min) from the
  // 30s controlLoop tick (no new Timer.set).
  watchdogPending: null,
  // Previous mo.ss value used to detect transitions from
  // suppressSafety=true → false so we can re-capture the baseline.
  prev_ss: false,
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
  // Solar-charging tank-rise tracking (mirrors evaluate() flags). Tank
  // top temperature is tracked so we can keep pumping until the tank
  // stops accepting heat (no rise for 5 min, or 2°C drop from peak).
  solar_charge_peak_tank_top: null,
  solar_charge_peak_tank_top_at: 0,
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

// setActuators — sequentially sets the 4 local switches (pump, fan, immersion
// heater, space heater) to the requested states with callback chaining. Only
// one Shelly.call is in flight at any moment, so this path never contributes
// more than 1 concurrent RPC to the 5-call limit shared with telemetry
// KVS.Set / MQTT operations.
//
// Without the chaining, firing setPump+setFan+setSpaceHeater+setImmersion
// back-to-back (as the original code did) queued 4 simultaneous Shelly.call
// invocations; combined with a telemetry KVS.Set in flight from a concurrent
// config_changed event, this hit the Shelly RPC_NUMBER_OF_CALLS limit and
// crashed the control script with "Too many calls in progress" on the
// setImmersion line (verified on device 2026-04-10).
//
// states is an object with keys {pump, fan, immersion_heater, space_heater},
// each a bool. If a key is omitted the actuator is left untouched. All on=true
// assignments still go through the device config guards (ce + ea bits); we
// short-circuit disallowed on=true ops without a Shelly.call.
function setActuators(states, cb) {
  var plan = [
    { key: "pump", id: 0, eaBit: EA_PUMP, stateKey: "pump_on" },
    { key: "fan", id: 1, eaBit: EA_FAN, stateKey: "fan_on" },
    { key: "immersion_heater", id: 2, eaBit: EA_IMMERSION, stateKey: "immersion_heater_on" },
    { key: "space_heater", id: 3, eaBit: EA_SPACE_HEATER, stateKey: "space_heater_on" }
  ];
  function next(i) {
    if (i >= plan.length) { if (cb) cb(); return; }
    var op = plan[i];
    if (!(op.key in states)) { next(i + 1); return; }
    var on = !!states[op.key];
    if (on && !deviceConfig.ce) {
      state[op.stateKey] = false;
      next(i + 1);
      return;
    }
    if (on && !(deviceConfig.ea & op.eaBit)) {
      state[op.stateKey] = false;
      next(i + 1);
      return;
    }
    Shelly.call("Switch.Set", { id: op.id, on: on }, function() {
      state[op.stateKey] = on;
      next(i + 1);
    });
  }
  next(0);
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
      captureWatchdogBaseline();
      state.transitioning = false;
      if (cb) cb(false);
      return;
    }
    setValves(pairs, idx + 1, cb);
  });
}

function closeAllValves(cb) {
  var names = ["vi_btm","vi_top","vi_coll","vo_coll","vo_rad","vo_tank","v_air"];
  var pairs = [];
  for (var i = 0; i < names.length; i++) pairs.push([names[i], false]);
  setValves(pairs, 0, cb);
}

// Seed valveOpenSince so that every valve is treated as "hold satisfied" on
// boot. FR-015: any valve observed to already be open at boot is allowed to
// close without waiting for the min-open hold. Fresh opens after boot get a
// real timestamp when their opening window ends.
function seedValveOpenSinceOnBoot() {
  var names = ["vi_btm","vi_top","vi_coll","vo_coll","vo_rad","vo_tank","v_air"];
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
    solarChargePeakTankTop: state.solar_charge_peak_tank_top,
    solarChargePeakTankTopAt: state.solar_charge_peak_tank_top_at,
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
  state.solar_charge_peak_tank_top =
    flags.solarChargePeakTankTop !== undefined ? flags.solarChargePeakTankTop : null;
  state.solar_charge_peak_tank_top_at = flags.solarChargePeakTankTopAt || 0;
}

// ── Watchdog helpers ──

// Snapshot sensor values at mode-entry so detectAnomaly() can compare
// the current readings against the baseline every tick. Called at
// every state.mode_start = Date.now() site to piggyback on existing
// mode-transition points. Clears any in-flight pending, because a
// mode transition terminates the current watchdog window.
function captureWatchdogBaseline() {
  state.watchdog_baseline = {
    at: Math.floor(Date.now() / 1000),
    tankTop: state.temps.tank_top,
    collector: state.temps.collector,
    greenhouse: state.temps.greenhouse
  };
  state.watchdogPending = null;
}

// Publish a watchdog event via the telemetry script. Events are sent
// as Shelly.emitEvent and the telemetry.js handler forwards them to
// MQTT. Silently dropped if the event system is not ready.
function publishWatchdogEvent(payload) {
  Shelly.emitEvent("watchdog_event", payload);
}

// ── Watchdog resolution handlers ──

// Build an IDLE result for transitionTo() — used when a watchdog
// fires the auto-shutdown path or the user-initiated shutdown via
// config push.
function buildIdleTransitionResult() {
  return {
    nextMode: MODES.IDLE,
    valves: MODE_VALVES[MODES.IDLE],
    actuators: MODE_ACTUATORS[MODES.IDLE],
    flags: {
      collectorsDrained: state.collectors_drained,
      lastRefillAttempt: state.last_refill_attempt / 1000,
      emergencyHeatingActive: false,
      solarChargePeakTankTop: null,
      solarChargePeakTankTopAt: 0
    },
    suppressed: false,
    safetyOverride: false
  };
}

// Auto-shutdown path: called from watchdogTick() after the 5-minute
// pending grace period elapses with no user response. The device
// writes the cool-off ban to its own KVS and transitions to IDLE.
// User-initiated shutdownnow does NOT come through here — it arrives
// as a config update via the existing greenhouse/config subscription
// and is handled by handleConfigDrivenResolution() below.
function applyBanAndShutdown(id, how) {
  var modeCode = WATCHDOG_MODE[id];
  if (!modeCode) return;
  var nowSec = Math.floor(Date.now() / 1000);
  var banTtl = deviceConfig.watchdogBanSeconds || 14400;
  var newUntil = nowSec + banTtl;

  deviceConfig.wb = deviceConfig.wb || {};
  var existing = deviceConfig.wb[modeCode] || 0;
  // max() so a permanent ban (sentinel 9999999999) is never downgraded
  deviceConfig.wb[modeCode] = (existing > newUntil) ? existing : newUntil;

  Shelly.call("KVS.Set", {
    key: "config",
    value: JSON.stringify(deviceConfig)
  });

  state.watchdogPending = null;
  transitionTo(buildIdleTransitionResult());
  publishWatchdogEvent({ t: "resolved", id: id, how: how, ts: nowSec });
}

function autoShutdown(id) {
  applyBanAndShutdown(id, "shutdown_auto");
}

// User-driven resolution arrives as a device-config update (no
// dedicated watchdog/cmd subscription on the device — see telemetry.js
// notes). Detects two transitions:
//
//   1. wz[id] just became set to a future timestamp while a pending
//      fire exists for this id → snooze ack. Clear pending, publish
//      "resolved snoozed". Mode keeps running.
//
//   2. wb[modeCode] just became set to a future timestamp while a
//      pending fire exists for a watchdog of this mode → shutdown
//      now. Clear pending, transitionTo(IDLE), publish "resolved
//      shutdown_user".
//
// Called from the config_changed event handler immediately after the
// in-memory deviceConfig is replaced. The previous config is captured
// before the assignment so the comparison can detect "just changed".
//
// Edge cases:
// - If state.watchdogPending is already null (auto-shutdown won the
//   race), do nothing. The wz/wb value in the new config is still
//   honored for any future fire.
// - "Clear cool-off" (wb[modeCode]=0) and "Clear snooze" (wz[id]=0)
//   are filtered out by the `> nowSec` check since they delete the
//   entry rather than setting a future timestamp.
// - If a watchdog is pending and the user manually disables the same
//   mode (sets wb sentinel) for unrelated reasons, the device treats
//   it as a user-initiated shutdown of the in-flight watchdog.
//   Semantically correct — banning a running mode shuts it down.
function handleConfigDrivenResolution(prevCfg, newCfg) {
  if (!state.watchdogPending) return;
  var pid = state.watchdogPending.id;
  var nowSec = Math.floor(Date.now() / 1000);

  // Snooze: wz[pid] just became set/updated to a future time
  var newWz = newCfg.wz && newCfg.wz[pid];
  var oldWz = prevCfg && prevCfg.wz && prevCfg.wz[pid];
  if (newWz && newWz > nowSec && newWz !== oldWz) {
    state.watchdogPending = null;
    publishWatchdogEvent({
      t: "resolved", id: pid, how: "snoozed", ts: nowSec
    });
    // NOTE: mode keeps running — snooze does not transition.
    return;
  }

  // Shutdown: wb[modeCode] just became set/updated to a future time
  var modeCode = WATCHDOG_MODE[pid];
  if (modeCode) {
    var newWb = newCfg.wb && newCfg.wb[modeCode];
    var oldWb = prevCfg && prevCfg.wb && prevCfg.wb[modeCode];
    if (newWb && newWb > nowSec && newWb !== oldWb) {
      state.watchdogPending = null;
      transitionTo(buildIdleTransitionResult());
      publishWatchdogEvent({
        t: "resolved", id: pid, how: "shutdown_user", ts: nowSec
      });
    }
  }
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
    captureWatchdogBaseline();
    state.transitioning = false;
    state.transition_step = null;
    state.targetValves = null;
    state.targetResult = null;
    state.valvePendingOpen = [];
    state.valvePendingClose = [];
    applyFlags(result.flags);

    // Turn the requested actuators on via setActuators so only one
    // Shelly.call is in flight at a time (same concurrency-budget
    // reasoning as transitionTo's stop step).
    setActuators({
      pump: !!result.actuators.pump,
      fan: !!result.actuators.fan,
      space_heater: !!result.actuators.space_heater,
      immersion_heater: !!result.actuators.immersion_heater
    }, function() {
      if (result.nextMode === MODES.SOLAR_CHARGING) {
        Shelly.call("KVS.Set", {key: "drained", value: "0"});
      } else if (result.nextMode === MODES.ACTIVE_DRAIN) {
        startDrainMonitor();
      }
      emitStateUpdate();
    });
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
  captureWatchdogBaseline();
  state.transitioning = false;
  state.transition_step = null;
  emitStateUpdate();
}

// Build the scheduler view of the current physical valve state. Any valve
// whose state is unknown (e.g. never commanded) is treated as closed.
function currentSchedulerView() {
  var names = ["vi_btm","vi_top","vi_coll","vo_coll","vo_rad","vo_tank","v_air"];
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

  // Turn off all non-valve actuators sequentially (one Shelly.call at a
  // time) before starting the valve transition. See setActuators comment
  // for the concurrency-budget rationale.
  setActuators({ pump: false, fan: false, space_heater: false, immersion_heater: false }, function() {
    emitStateUpdate();
    Timer.set(SHELL_CFG.VALVE_SETTLE_MS, false, function() {
      scheduleStep();
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
      v_air: false
    },
    actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
    flags: {
      collectorsDrained: true,
      lastRefillAttempt: state.last_refill_attempt / 1000,
      emergencyHeatingActive: false,
      solarChargePeakTankTop: null,
      solarChargePeakTankTopAt: 0
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

      // ── Watchdog tick block ──
      watchdogTick();

      // Process pending MQTT commands after control cycle completes
      processPendingCommands();
    });
  });
}

// Watchdog per-tick block: lazy-prune expired bans, reset baseline on
// override exit, check pending or run detection. Three mutually
// exclusive branches so the tick cost is bounded at O(1) even when
// all three watchdogs are enabled.
function watchdogTick() {
  var nowSec = Math.floor(Date.now() / 1000);

  // (a) Lazy prune of expired wb entries
  if (deviceConfig.wb) {
    var wbChanged = false;
    for (var m in deviceConfig.wb) {
      if (deviceConfig.wb[m] <= nowSec) {
        delete deviceConfig.wb[m];
        wbChanged = true;
      }
    }
    if (wbChanged) {
      Shelly.call("KVS.Set", {
        key: "config",
        value: JSON.stringify(deviceConfig)
      });
    }
  }

  // (b) Override-exit baseline reset
  var ssNow = !!(deviceConfig.mo && deviceConfig.mo.a && deviceConfig.mo.ss);
  if (state.prev_ss && !ssNow && state.watchdog_baseline) {
    captureWatchdogBaseline();
  }
  state.prev_ss = ssNow;

  // (c) Pending check OR detection — mutually exclusive
  if (state.watchdogPending) {
    if (nowSec - state.watchdogPending.firedAt >= 300) {
      autoShutdown(state.watchdogPending.id);
    }
  } else if (state.watchdog_baseline) {
    var entry = {
      mode: state.mode,
      at: state.watchdog_baseline.at,
      tankTop: state.watchdog_baseline.tankTop,
      collector: state.watchdog_baseline.collector,
      greenhouse: state.watchdog_baseline.greenhouse
    };
    var sensors = {
      collector: state.temps.collector,
      tank_top: state.temps.tank_top,
      greenhouse: state.temps.greenhouse
    };
    var fired = detectAnomaly(entry, nowSec, sensors, deviceConfig);
    if (fired) {
      state.watchdogPending = { id: fired, firedAt: nowSec };
      publishWatchdogEvent({
        t: "fired",
        id: fired,
        mode: entry.mode,
        el: nowSec - entry.at,
        dT: state.temps.tank_top - entry.tankTop,
        dC: entry.collector - state.temps.collector,
        dG: state.temps.greenhouse - entry.greenhouse,
        ts: nowSec
      });
    }
  }
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

function needsRestart(r) {
  // Shelly Gen2 RPC response: {id, result: {restart_required: bool, ...}}.
  // RemovePeripheral and AddPeripheral both set this when the hub needs to
  // reboot for the new bus configuration to take effect — without a reboot,
  // Temperature.GetStatus on freshly-added component IDs returns no tC and
  // the role shows as "—" in the UI.
  return !!(r && r.result && r.result.restart_required);
}

function rpcError(r) {
  // Shelly Gen2 returns {"id":1,"error":{"code":-103,"message":"..."}}
  // with HTTP 200 when the method was reached but rejected. addonRpc
  // treats this as a success, so pull the error out here.
  if (!r || !r.error) return null;
  return (r.error.code !== undefined ? r.error.code + ": " : "") + (r.error.message || "unknown");
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
    var ip=hosts[idx],hi=-1,reboot=false,errs=[];
    for(var k=0;k<cfg.h.length;k++){if(cfg.h[k]===ip){hi=k;break;}}
    addonRpc(ip,"SensorAddon.GetPeripherals",null,function(e,r){
      if(e){res.push({host:ip,ok:false,error:"GetPeripherals: "+e,peripherals:0});next(idx+1);return;}
      var re=rpcError(r);
      if(re){res.push({host:ip,ok:false,error:"GetPeripherals: "+re,peripherals:0});next(idx+1);return;}
      var ex=[];var d=getDs18b20(r);for(var c in d)ex.push(c);
      function rm(ri){
        if(ri>=ex.length){add();return;}
        addonRpc(ip,"SensorAddon.RemovePeripheral",{component:ex[ri]},function(rme,rmr){
          var rerr=rme||rpcError(rmr);
          if(rerr)errs.push("remove "+ex[ri]+": "+rerr);
          if(needsRestart(rmr))reboot=true;
          rm(ri+1);
        });
      }
      function add(){
        // SensorAddon.AddPeripheral requires BOTH attrs.addr (which probe on
        // the 1-Wire bus) and attrs.cid (which component slot). Earlier code
        // only passed cid, so the Add-on created empty slots that polled no
        // physical probe — symptom: some sensors showed "—" after apply.
        var ta=[];for(var rl in cfg.s){if(cfg.s[rl].h===hi)ta.push({i:cfg.s[rl].i,a:cfg.s[rl].a,r:rl});}
        var n=0;
        function an(ai){
          if(ai>=ta.length){finishHost();return;}
          var attrs={cid:ta[ai].i};
          if(ta[ai].a)attrs.addr=ta[ai].a;
          addonRpc(ip,"SensorAddon.AddPeripheral",{type:"ds18b20",attrs:attrs},function(ae,ar){
            var aerr=ae||rpcError(ar);
            if(aerr)errs.push("add "+ta[ai].r+" (cid "+ta[ai].i+", addr "+(ta[ai].a||"?")+"): "+aerr);
            else n++;
            if(needsRestart(ar))reboot=true;
            an(ai+1);
          });
        }
        an(0);
        function finishHost(){
          // Verify the adds actually landed. If AddPeripheral returned no
          // error but the Add-on never registered the peripheral (e.g. attrs
          // format mismatch), this is our only way to catch it — the
          // symptom otherwise is a silent "Apply complete" followed by
          // "No peripherals added" in the Shelly app.
          addonRpc(ip,"SensorAddon.GetPeripherals",null,function(ge,gr){
            var bound=0;
            if(!ge&&!rpcError(gr)){var dd=getDs18b20(gr);for(var cc in dd)bound++;}
            if(bound<n&&!errs.length){errs.push("post-add verify: "+bound+" of "+n+" peripherals actually persisted");}
            var hostRes={host:ip,ok:errs.length===0,peripherals:bound};
            if(errs.length)hostRes.error=errs.join("; ");
            function done(){res.push(hostRes);next(idx+1);}
            if(!reboot){done();return;}
            // delay_ms gives the Add-on 2s to flush the just-added peripherals
            // to flash before the reboot — without it, pending writes are lost
            // and the hub boots with no peripherals. The HTTP ACK comes back
            // immediately; the device then reboots on its own timer.
            addonRpc(ip,"Shelly.Reboot",{delay_ms:2000},function(){hostRes.rebooted=true;done();});
          });
        }
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
      // Capture the old config BEFORE overwriting so we can detect
      // watchdog-driven transitions (snooze ack and user-initiated
      // shutdown both arrive as wz/wb config updates rather than a
      // separate MQTT cmd subscription).
      var prevDeviceConfig = deviceConfig;
      deviceConfig = data.config;
      handleConfigDrivenResolution(prevDeviceConfig, deviceConfig);
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
  seedValveOpenSinceOnBoot();

  // Turn all actuators off sequentially before touching valves. Uses
  // setActuators so only one Shelly.call is in flight at any moment —
  // avoids exceeding the 5-call budget at boot when telemetry is also
  // firing KVS.Get calls concurrently.
  setActuators({ pump: false, fan: false, space_heater: false, immersion_heater: false }, function() {
    bootCloseValves();
  });
}

function bootCloseValves() {
  closeAllValves(function(ok) {
    if (!ok) {
      Timer.set(5000, false, function() { bootCloseValves(); });
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
              captureWatchdogBaseline();
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
