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
