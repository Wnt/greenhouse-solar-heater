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
    updateDisplay(function() {
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
