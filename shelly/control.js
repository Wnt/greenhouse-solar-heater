// Shelly Pro 4PM — Control Shell (decision logic in control-logic.js)
// Handles: timers, RPC, relays, KVS, sensors, config, MQTT commands

var SHELL_CFG = {
  POLL_INTERVAL: 30000,
  VALVE_SETTLE_MS: 1000,
  PUMP_PRIME_MS: 5000,
  // Fixed pump run duration inside ACTIVE_DRAIN. Replaces the
  // earlier pump-power-threshold heuristic — the Wilo Star Z20/4's
  // power draw drops only a few watts when the collectors go dry,
  // which is well inside the noise floor of the Pro 4PM's aenergy
  // metering (verified 2026-04-20 field log). 5 minutes is an
  // empirical figure that fully evacuates the ~12 L collector loop
  // at Wilo spec flow rate with margin.
  DRAIN_PUMP_RUN_MS: 5 * 60 * 1000,
  // Post-valve pump-run window on ACTIVE_DRAIN exit. See CLAUDE.md
  // "Safety: stop pump BEFORE switching valves" for the one-sentence rule
  // and system.yaml active_drain.sequence step 8 for the physical reason.
  DRAIN_EXIT_PUMP_RUN_MS: 20000,
};

// Minimum delay before resumeTransition fires. Timer.set on Shelly can
// invoke its callback on almost the same stack for very small delays;
// keeping this ≥ 20 ms forces an event-loop yield between scheduleStep
// iterations, which is the only guarantee that the 2026-04-20 stack-
// overflow recursion cannot re-establish itself from a new pathway.
var MIN_RESUME_MS = 20;

// ── MQTT topics and KVS keys (absorbed from former telemetry.js) ──
var CONFIG_TOPIC = "greenhouse/config";
var SENSOR_CONFIG_TOPIC = "greenhouse/sensor-config";
var RELAY_COMMAND_TOPIC = "greenhouse/relay-command";
var STATE_TOPIC = "greenhouse/state";
// Watchdog events are device→server only. User ack and shutdownnow round-trip
// via the existing greenhouse/config retained topic — no matching watchdog/cmd
// subscription, which keeps the device within its MQTT subscription budget.
var WATCHDOG_EVENT_TOPIC = "greenhouse/watchdog/event";
var CONFIG_KVS_KEY = "config";
var SENSOR_CONFIG_KVS_KEY = "sensor_config";

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
  // 192.168.30.54 id 1 is a reserved spare (passive T joint at collector top — spec 024)
  v_air:   {ip: "192.168.30.54", id: 0},
};

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
  // Previous mo.a value used to detect override-exit so the watchdog
  // baseline can be re-captured on the NEXT automation tick. Same role
  // prev_ss had before hard override was introduced (2026-04-21) —
  // now keyed on the override itself, since the ss flag is gone.
  prev_mo_active: false,
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
  transitionFromMode: null, // mode snapshot at transitionTo() entry; drives drain-exit branch
  transition_step: null,
  // What triggered the most recent mode transition. One of:
  //   boot | automation | forced | watchdog_auto | user_shutdown |
  //   drain_complete | failed. Published in every state snapshot; server
  //   records it alongside the mode-change row so the UI can show
  //   operators why the system changed state.
  lastTransitionCause: "boot",
};

// ── Actuator commands with config guards ──

function setPump(on) {
  if (on && !deviceConfig.ce) { state.pump_on = false; return; }
  if (on && !(deviceConfig.ea & EA_PUMP)) { state.pump_on = false; return; }
  Shelly.call("Switch.Set", {id: 0, on: on});
  state.pump_on = on;
}

// Individual per-actuator setFan/setImmersion helpers were removed —
// all callers go through setActuators. setSpaceHeater kept as a thin
// standalone because controlLoop() fires it inside an in-flight chain
// (see its call site in controlLoop) without gating on ce/ea elsewhere.
function setSpaceHeater(on) {
  if (on && (!deviceConfig.ce || !(deviceConfig.ea & EA_SPACE_HEATER))) return;
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
  var url = "http://" + v.ip + "/rpc/Switch.Set?id=" + v.id +
    "&on=" + (open ? "true" : "false");
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
// control-logic.js so it is unit-testable in Node). Called once from
// emitStateUpdate below — inlined directly, no wrapper.
function emitStateUpdate() {
  if (!MQTT.isConnected()) return;
  MQTT.publish(STATE_TOPIC, JSON.stringify(buildSnapshotFromState(state, deviceConfig, Date.now())), 1, true);
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

// Publish a watchdog event directly via MQTT. Silently dropped if the
// broker is not connected.
function publishWatchdogEvent(payload) {
  if (!MQTT.isConnected()) return;
  MQTT.publish(WATCHDOG_EVENT_TOPIC, JSON.stringify(payload), 1, false);
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

// Forced-mode transitionTo-shaped result (bypasses evaluate()).
function makeModeResult(code) {
  var m = MODE_CODE[code];
  if (!m || !MODES[m]) return null;
  return { nextMode: MODES[m], valves: MODE_VALVES[MODES[m]], actuators: MODE_ACTUATORS[MODES[m]], flags: {} };
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
  // how is "shutdown_auto" from autoShutdown() or "shutdown_user" from
  // handleConfigDrivenResolution(). Matches the published "resolved"
  // event so UI logs line up.
  transitionTo(buildIdleTransitionResult(),
    how === "shutdown_user" ? "user_shutdown" : "watchdog_auto");
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
      transitionTo(buildIdleTransitionResult(), "user_shutdown");
      publishWatchdogEvent({
        t: "resolved", id: pid, how: "shutdown_user", ts: nowSec
      });
    }
  }
}

// mo.fm change / mo clear → staged transition. Called from applyConfig
// AFTER handleConfigDrivenResolution so watchdog paths take priority.
// Deferred 1 s so the caller's in-flight KVS.Set drains before we fire
// Switch.Set/HTTP.GET, keeping under the 3-call in-flight cap.
function handleForcedModeChange(prev, next) {
  var pMo = prev && prev.mo, nMo = next && next.mo;
  var pFm = (pMo && pMo.fm) || null, nFm = (nMo && nMo.fm) || null;
  var t = null;
  if (nMo && nMo.a && nFm && nFm !== pFm) t = makeModeResult(nFm);
  else if (pMo && pMo.a && (!nMo || !nMo.a)) t = buildIdleTransitionResult();
  if (t) Timer.set(1000, false, function() { transitionTo(t, "forced"); });
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
  // Default wait is pump-prime (5 s). For ACTIVE_DRAIN exit, extend to
  // DRAIN_EXIT_PUMP_RUN_MS (20 s) — see transitionTo() for the rule.
  var postValveWaitMs = (state.transitionFromMode === MODES.ACTIVE_DRAIN)
    ? SHELL_CFG.DRAIN_EXIT_PUMP_RUN_MS
    : SHELL_CFG.PUMP_PRIME_MS;
  Timer.set(postValveWaitMs, false, function() {
    state.mode = result.nextMode;
    state.mode_start = Date.now();
    captureWatchdogBaseline();
    state.transitioning = false;
    state.transition_step = null;
    state.targetValves = null;
    state.targetResult = null;
    state.transitionFromMode = null;
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
  state.transitionFromMode = null;
  state.valvePendingOpen = [];
  state.valvePendingClose = [];
  setPump(false);
  state.mode = MODES.IDLE;
  state.mode_start = Date.now();
  state.lastTransitionCause = "failed";
  captureWatchdogBaseline();
  state.transitioning = false;
  state.transition_step = null;
  emitStateUpdate();
}

// Build the current physical valve map. Any valve whose state is unknown
// (e.g. never commanded) is treated as closed.
function currentValves() {
  var names = ["vi_btm","vi_top","vi_coll","vo_coll","vo_rad","vo_tank","v_air"];
  var cur = {};
  for (var i = 0; i < names.length; i++) {
    cur[names[i]] = !!state.valve_states[names[i]];
  }
  return cur;
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
  var plan = planValveTransition(
    state.targetValves, currentValves(),
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
    openPairs.push([ov, true]);
  }
  for (i = 0; i < plan.closeNow.length; i++) {
    var cv = plan.closeNow[i];
    // FR-017 defensive guard: never close a valve that is inside its
    // opening window. Should never happen (scheduler enforces this), but
    // refuse to act if somehow bypassed.
    if (state.valveOpening[cv] !== undefined && state.valveOpening[cv] > now) {
      continue;
    }
    closePairs.push([cv, false]);
    // Closing a valve clears the openSince so future opens start fresh.
    state.valveOpenSince[cv] = 0;
  }

  emitStateUpdate();

  // Schedules the next resumeTransition. The minimum delay is kept
  // generous (20 ms) so Timer.set is guaranteed to yield to the
  // Espruino event loop — Timer.set(1) on Shelly can fire almost-
  // synchronously, and combined with the nested-callback chain below
  // that re-entry used to blow the ~15-frame stack. See MIN_RESUME_MS
  // above the SHELL_CFG block if you need to retune.
  function scheduleResume() {
    clearTransitionTimer();
    var delay;
    if (plan.nextResumeAt !== null) {
      delay = plan.nextResumeAt - Date.now();
      if (delay < MIN_RESUME_MS) delay = MIN_RESUME_MS;
    } else {
      delay = MIN_RESUME_MS;
    }
    state.transitionTimer = Timer.set(delay, false, resumeTransition);
  }

  // No work to actuate this tick: all closes are deferred by
  // minOpenMs and no new opens fit in the slot budget. Skip the
  // runValveBatch chain entirely — calling it with empty pairs still
  // synchronously nests ~5 frames per call (runValveBatch →
  // runBoundedPool → done inline), and the original control.js had
  // two of these nested. Drain-exit right after AD entry (2026-04-20
  // crash) hit exactly this state and overflowed the Espruino stack.
  if (closePairs.length === 0 && openPairs.length === 0) {
    scheduleResume();
    return;
  }

  // Closes first, then opens — independent batches, but closes
  // must complete before opens so slot accounting in the scheduler
  // stays consistent when the same valve is switching direction.
  function runOpens() {
    if (openPairs.length === 0) { scheduleResume(); return; }
    runValveBatch(openPairs, function(okO) {
      if (!okO) { finalizeTransitionFail(); return; }
      scheduleResume();
    });
  }

  if (closePairs.length === 0) { runOpens(); return; }

  runValveBatch(closePairs, function(okC) {
    if (!okC) { finalizeTransitionFail(); return; }
    runOpens();
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

function transitionTo(result, cause) {
  // Record what triggered the transition. Callers pass a short tag
  // ("automation", "forced", "watchdog_auto", "user_shutdown",
  // "drain_complete", "failed"). Default is "automation" for legacy
  // call sites that don't yet annotate themselves.
  if (cause) state.lastTransitionCause = cause;

  if (state.transitioning) {
    // Allow in-place target change during an in-flight staged transition.
    if (state.targetValves !== null) {
      state.targetValves = result.valves;
      state.targetResult = result;
      // Do not interrupt any live opening windows — the next resume will
      // re-plan against the new target.
    }
    return;
  }
  // Snapshot the source mode BEFORE state.transitioning flips — used by
  // the drain-exit branch below and by finalizeTransitionOK() to pick the
  // post-valve wait.
  state.transitionFromMode = state.mode;
  state.transitioning = true;
  state.targetResult = result;
  state.targetValves = result.valves;

  if (state.drain_timer !== null) {
    Timer.clear(state.drain_timer);
    state.drain_timer = null;
  }

  // ── Drain-exit ordering (exception to pump-first rule) ──
  // When exiting ACTIVE_DRAIN, close valves WHILE the pump is still
  // running so residual water in the manifold piping is pushed out to
  // the tank before the valves seal. The 20 s post-valve wait inside
  // finalizeTransitionOK() is what actually stops the pump.
  if (state.transitionFromMode === MODES.ACTIVE_DRAIN) {
    state.transition_step = "valves_opening";
    emitStateUpdate();
    scheduleStep();
    return;
  }

  // Default path: stop pump/fan/heaters first, then actuate valves.
  state.transition_step = "pump_stop";
  setActuators({ pump: false, fan: false, space_heater: false, immersion_heater: false }, function() {
    emitStateUpdate();
    Timer.set(SHELL_CFG.VALVE_SETTLE_MS, false, function() {
      scheduleStep();
    });
  });
}

// Run the drain pump for a fixed duration, then hand off to
// stopDrain() which stages the valves-first exit back to IDLE. The
// old power-threshold heuristic was retired after the 2026-04-20
// field log showed pump apower only drops a few watts on dry-run —
// well inside the metering noise floor, so "low_count >= 3" was
// firing unpredictably (early or never) and the drain timing
// became a wall-clock guarantee instead of a sensor reading.
function startDrainMonitor() {
  state.drain_timer = Timer.set(SHELL_CFG.DRAIN_PUMP_RUN_MS, false, function() {
    stopDrain("complete");
  });
}

function stopDrain(reason) {
  if (state.drain_timer !== null) {
    Timer.clear(state.drain_timer);
    state.drain_timer = null;
  }
  state.collectors_drained = true;
  Shelly.call("KVS.Set", {key: "drained", value: "1"});
  state.last_error = null;
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
  transitionTo(idleResult, "drain_complete");
}

// ── Manual override helpers ──

function isManualOverrideActive() {
  if (!deviceConfig.mo || !deviceConfig.mo.a) return false;
  var now = Shelly.getComponentStatus("sys").unixtime || 0;
  if (now >= deviceConfig.mo.ex) {
    // TTL expired: clear mo, persist, force IDLE inside the KVS.Set cb
    // so HTTP.GETs don't overlap with the KVS.Set (stays under cap).
    // AD→IDLE auto-uses valves-first via state.transitionFromMode.
    deviceConfig.mo = null;
    Shelly.call("KVS.Set", {key: "config", value: JSON.stringify(deviceConfig)}, function() {
      if (!state.transitioning) transitionTo(buildIdleTransitionResult());
    });
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

      // Manual override is HARD (2026-04-21): automation — including
      // freeze/overheat drain — is fully suspended until the user
      // clears override or the TTL expires. The user asked for this
      // explicitly, trading safety-net behaviour for deterministic
      // manual control. Freeze hazard is mitigated by the confirmation
      // dialog + TTL countdown in the playground, not by server-side
      // preemption.
      if (isManualOverrideActive()) {
        emitStateUpdate();
        return;
      }

      var evalState = buildEvalState();
      var result = evaluate(evalState, null, deviceConfig);

      if (result.nextMode !== state.mode) {
        if (result.safetyOverride) {
          transitionTo(result, "safety_override");
        } else if (result.suppressed) {
          applyFlags(result.flags);
          emitStateUpdate();
        } else {
          transitionTo(result, "automation");
        }
      } else {
        applyFlags(result.flags);
        setSpaceHeater(!!result.actuators.space_heater);
        emitStateUpdate();
      }

      // ── Watchdog tick block ──
      watchdogTick();
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

  // (b) Override-exit baseline reset — when the user leaves manual
  // override, the sensor readings captured before they started
  // poking relays are almost certainly stale; re-baseline so the
  // watchdog doesn't compare current temps against an hour-old entry.
  var moActiveNow = !!(deviceConfig.mo && deviceConfig.mo.a);
  if (state.prev_mo_active && !moActiveNow && state.watchdog_baseline) {
    captureWatchdogBaseline();
  }
  state.prev_mo_active = moActiveNow;

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

// Sensor-config apply and discovery are now driven directly from the
// server over HTTP (see server/lib/sensor-apply.js and sensor-discovery.js)
// rather than via MQTT → controller → HTTP. The on-device doApply /
// doDiscover functions and their helpers were removed to free ~3 KB of
// script RAM — previously the telemetry script kept OOM-ing because
// control.js's bytecode footprint left under 5 KB headroom for it.

// (doApply / doDiscover / addonRpc / getDs18b20 / getOneWireDevices /
// rpcError all removed — the server now drives sensor-config apply and
// discovery directly over HTTP. See the note above.)

// ── Config apply + MQTT setup (absorbed from former telemetry.js) ──

function isSafetyCritical(oldCfg, newCfg) {
  if (!oldCfg) return true;
  if (oldCfg.ce !== newCfg.ce) return true;
  if (oldCfg.ea !== newCfg.ea) return true;
  // mo.fm changes are handled synchronously inside applyConfig via
  // handleForcedModeChange — no need to re-fire controlLoop().
  // Mode bans (wb) gate evaluate() immediately — a newly-enforced ban
  // must take effect on the next tick rather than waiting for the next
  // unrelated mode change.
  if (JSON.stringify(oldCfg.wb) !== JSON.stringify(newCfg.wb)) return true;
  // we/wz changes are not safety-critical; next POLL_INTERVAL tick picks
  // them up via evaluate(). Still referenced here as a regression guard
  // against schema drift.
  if (JSON.stringify(oldCfg.we) !== JSON.stringify(newCfg.we)) return false;
  if (JSON.stringify(oldCfg.wz) !== JSON.stringify(newCfg.wz)) return false;
  return false;
}

function applyConfig(newCfg) {
  if (newCfg.v === deviceConfig.v) return;
  var prev = deviceConfig;
  var critical = isSafetyCritical(prev, newCfg);
  deviceConfig = newCfg;
  Shelly.call("KVS.Set", { key: CONFIG_KVS_KEY, value: JSON.stringify(newCfg) });
  // Watchdog snooze ack / user-initiated shutdown arrive as wz/wb config
  // updates rather than a separate MQTT cmd topic.
  handleConfigDrivenResolution(prev, newCfg);
  // mo.fm change → drive forced-mode transition. mo clear → force IDLE.
  handleForcedModeChange(prev, newCfg);
  if (critical) controlLoop();
}

function applySensorConfig(newCfg) {
  if (sensorConfig && newCfg.v === sensorConfig.v) return;
  sensorConfig = newCfg;
  Shelly.call("KVS.Set", { key: SENSOR_CONFIG_KVS_KEY, value: JSON.stringify(newCfg) });
}

// Tracks whether the device-side subscription for each topic is known
// to be live on the CURRENT JS callback. Persists across connectHandler
// re-invocations so we don't redo work if the handler fires on the
// same connection.
var mqttSubscribed = { };

function safeSubscribe(topic, cb) {
  if (mqttSubscribed[topic]) return true;
  // Belt-and-suspenders: try to clear any stale device-side
  // registration left over from Script.Stop/Start first, then attempt
  // subscribe. Both calls are wrapped — MQTT.unsubscribe may not exist
  // on every firmware, and MQTT.subscribe throws "Invalid topic" if
  // the device still thinks it's subscribed. On failure we leave the
  // flag false so connectHandler can retry.
  try { MQTT.unsubscribe(topic); } catch (e) {}
  try {
    MQTT.subscribe(topic, cb);
    mqttSubscribed[topic] = true;
    return true;
  } catch (e) {
    // 2026-04-20 incident: live Pro 4PM crashed with uncaught
    // "Invalid topic" here because the MQTT.unsubscribe above is not
    // synchronously honored by the firmware's MQTT client. Trap it
    // instead of propagating. Script keeps running and retries on the
    // next connectHandler callback — messages delivered to the stale
    // device-side subscription are silently dropped until then, but
    // the control loop continues on KVS-loaded config.
    state.last_error = "mqtt_subscribe_" + topic;
    return false;
  }
}

function setupMqttSubscriptions() {
  if (!MQTT.isConnected()) return;

  safeSubscribe(CONFIG_TOPIC, function(topic, message) {
    try {
      var newCfg = JSON.parse(message);
      if (newCfg.v && newCfg.v !== deviceConfig.v) applyConfig(newCfg);
    } catch (e) {}
  });
  safeSubscribe(SENSOR_CONFIG_TOPIC, function(topic, message) {
    try {
      var newCfg = JSON.parse(message);
      if (newCfg.v && (!sensorConfig || newCfg.v !== sensorConfig.v)) applySensorConfig(newCfg);
    } catch (e) {}
  });
  safeSubscribe(RELAY_COMMAND_TOPIC, function(topic, message) {
    try {
      var cmd = JSON.parse(message);
      if (cmd && typeof cmd.relay === "string" && typeof cmd.on === "boolean") {
        handleRelayCommand(cmd.relay, cmd.on);
      }
    } catch (e) {}
  });
}

// Shelly's MQTT client maintains subscriptions across (re)connects; the
// unsubscribe-first dance above makes connectHandler re-invocation safe.
MQTT.setConnectHandler(function() { setupMqttSubscriptions(); });

function bootstrapConfig() {
  Shelly.call("KVS.Get", { key: "config_url" }, function(res) {
    var url = (res && res.value) ? res.value : "";
    if (!url) return;
    Shelly.call("HTTP.GET", { url: url, timeout: 10 }, function(httpRes, err) {
      if (err || !httpRes || httpRes.code !== 200 || !httpRes.body) return;
      try {
        var cfg = JSON.parse(httpRes.body);
        if (cfg.v && cfg.v !== deviceConfig.v) applyConfig(cfg);
      } catch (e) {}
    });
  });
}

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

function loadPersistedState(cb) {
  Shelly.call("KVS.Get", { key: CONFIG_KVS_KEY }, function(cfgRes) {
    if (cfgRes && cfgRes.value) {
      try { deviceConfig = JSON.parse(cfgRes.value); } catch (e) {}
    }
    Shelly.call("KVS.Get", { key: SENSOR_CONFIG_KVS_KEY }, function(scRes) {
      if (scRes && scRes.value) {
        try { sensorConfig = JSON.parse(scRes.value); } catch (e) {}
      }
      Shelly.call("KVS.Get", { key: "drained" }, function(dRes) {
        if (dRes && dRes.value === "1") state.collectors_drained = true;
        if (cb) cb();
      });
    });
  });
}

function bootCloseValves() {
  closeAllValves(function(ok) {
    if (!ok) {
      Timer.set(5000, false, function() { bootCloseValves(); });
      return;
    }
    Timer.set(5000, false, function() {
      loadPersistedState(function() {
        pollAllSensors(function() {
          state.mode_start = Date.now();
          captureWatchdogBaseline();
          Timer.set(SHELL_CFG.POLL_INTERVAL, true, controlLoop);
          controlLoop();
          bootstrapConfig();
          if (MQTT.isConnected()) setupMqttSubscriptions();
        });
      });
    });
  });
}

// ── Test hook ──
// Only used by Node unit tests running control.js under a mocked Shelly host.
// The gate is a global `__TEST_HARNESS` symbol that the test runtime injects
// via `new Function(..., '__TEST_HARNESS', src)` — on the real Shelly device
// this identifier is undefined and the entire block is skipped, so production
// code paths are untouched.
if (typeof __TEST_HARNESS !== "undefined" && __TEST_HARNESS) {
  Shelly.__test_driveTransition = function(fromMode, result) {
    state.mode = MODES[fromMode] || fromMode;
    state.transitioning = false;
    // Seed valve_states so scheduleStep() sees real close work: boot already
    // closed every valve, so without seeding the source mode's open valves
    // the scheduler's plan.targetReached fires immediately and no valve HTTP
    // events appear, making ordering assertions meaningless. We seed only
    // valves that need to CLOSE in scheduler polarity — seeding an open that
    // needs to re-open would trigger a 20 s openWindowMs delay that pushes
    // finalizeTransitionOK past the test's advance window.
    var srcValves = MODE_VALVES[fromMode];
    if (srcValves && result.valves) {
      for (var vn in srcValves) {
        if (srcValves[vn] === true && result.valves[vn] === false) {
          state.valve_states[vn] = true;
        }
      }
    }
    // Seed pump_on/fan_on from the source mode's actuator config so that
    // the trailing setActuators({pump:false,...}) in finalizeTransitionOK
    // fires a real Switch.Set (pump was on → needs to turn off) rather
    // than being skipped.
    var srcAct = MODE_ACTUATORS[fromMode];
    if (srcAct) {
      state.pump_on = !!srcAct.pump;
      state.fan_on = !!srcAct.fan;
    }
    transitionTo(result, "automation");
  };

  // Inject sensor temps + optional mode so the controlLoop's next tick
  // can evaluate() against a deterministic state. Used by the
  // scheduler-stack-fuzz suite to drive automated (non-forced)
  // freeze/overheat transitions end-to-end.
  Shelly.__test_setTemps = function(temps, currentMode, opts) {
    opts = opts || {};
    var now = Date.now();
    var names = ['collector','tank_top','tank_bottom','greenhouse','outdoor'];
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (temps[n] !== undefined) {
        state.temps[n] = temps[n];
        state.sensor_last_valid[n] = now;
      }
    }
    if (currentMode) state.mode = MODES[currentMode] || currentMode;
    if (opts.collectorsDrained !== undefined) state.collectors_drained = !!opts.collectorsDrained;
  };

  // Manually fire the control-loop tick so the test doesn't have to
  // find the repeating Timer through the fake runtime.
  Shelly.__test_controlTick = function() {
    if (typeof controlLoop === 'function') controlLoop();
  };
}

boot();
