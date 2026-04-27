// Shared mutable state for the playground. Leaf module — imports
// NOTHING from ../main.js or any ./main/* sibling. Main.js and the
// sibling modules all read from here, so the module graph stays
// a DAG rooted at main.js with state.js at the bottom.
//
// Writes go through the exported setters (ESM `let`-bindings are
// read-only from the importer side). Mutations on the exported
// const objects (params, timeSeriesStore, MODE_INFO) are fine
// because the binding itself isn't reassigned.

// Thermal model instance, installed by main.js init() once the
// YAML config has loaded. Null until then.
export let model = null;
export function setModel(v) { model = v; }

// ControlStateMachine instance, installed by main.js init().
export let controller = null;
export function setController(v) { controller = v; }

// True whenever the simLoop is ticking. Toggled by togglePlay /
// resetSim / connection.switchToLive (which pauses the sim before
// live mode takes over).
export let running = false;
export function setRunning(v) { running = v; }

// Sim speed multiplier — changed by the Sim Speed slider in
// Controls. simLoop multiplies real dt by this.
export let simSpeed = 3000;
export function setSimSpeed(v) { simSpeed = v; }

// Visible window width of the history graph, in seconds. Changed
// by the 1H/6H/12H/24H pill buttons.
export let graphRange = 86400; // 24 h default
export function setGraphRange(v) { graphRange = v; }

// When true the graph draws the Tank Top and Tank Bottom lines
// alongside the tank average. Off by default.
export let showAllSensors = false;
export function setShowAllSensors(v) { showAllSensors = v; }

// Input parameters for the simulation. Mutated by slider
// callbacks in setupControls — properties change, but the object
// reference stays put so all importers see the updates.
export const params = {
  t_outdoor: 10,
  irradiance: 500,
  t_tank_top: 12,
  t_tank_bottom: 9,
  t_greenhouse: 11,
  sim_speed: 3000,
  day_night_cycle: true,
  gh_thermal_mass: 250000,
  gh_heat_loss: 100,
};

// Rolling time-series buffer shared by the history graph, the
// inspector, and the clipboard export. Entries are appended by
// simLoop (sim mode) and by recordLiveHistoryPoint (live mode).
export const timeSeriesStore = {
  maxPoints: 20000,
  times: [],
  values: [],  // { t_tank_top, t_tank_bottom, t_collector, t_greenhouse, t_outdoor }
  modes: [],   // mode string at each sample
  addPoint(time, vals, mode) {
    this.times.push(time);
    this.values.push({ ...vals });
    this.modes.push(mode);
    if (this.times.length > this.maxPoints) {
      const trim = this.times.length - this.maxPoints;
      this.times.splice(0, trim);
      this.values.splice(0, trim);
      this.modes.splice(0, trim);
    }
  },
  reset() { this.times = []; this.values = []; this.modes = []; },
};

// Mode-transition log, unified across sim and live. Appended by
// simLoop (sim mode) and fetchLiveEvents / detectLiveTransition
// (live mode); read by renderLogsList + buildLogsClipboardText.
// Lives here rather than in logs.js so simulation.js and logs.js
// both reach it through state.js without a cycle.
export const transitionLog = [];

// Last frame rendered by display-update.js. Stashed here (rather than
// kept private in display-update) so logs.js can read it without
// re-importing display-update — that import would close the cycle
// display-update → logs → display-update, which the ESM-graph guard
// in tests/playground-esm-imports.test.js rejects.
export let lastLiveFrame = { state: null, result: null };
export function setLastLiveFrame(state, result) {
  lastLiveFrame = { state, result };
}

// Static per-mode UI metadata (label, description, icon). No
// writes.
export const MODE_INFO = {
  idle: { label: 'Idle', desc: 'System waiting for triggers.', icon: 'mode_night', iconFill: false },
  solar_charging: { label: 'Collecting Solar Energy', desc: 'Optimal photon absorption in progress.', icon: 'wb_sunny', iconFill: true },
  greenhouse_heating: { label: 'Heating Greenhouse', desc: 'Thermal redirection active.', icon: 'nest_eco_leaf', iconFill: false },
  active_drain: { label: 'Active Drain', desc: 'Freeze protection draining collectors.', icon: 'water_drop', iconFill: false },
  overheat_drain: { label: 'Overheat Drain', desc: 'Draining to prevent overheating.', icon: 'warning', iconFill: false },
  emergency_heating: { label: 'Emergency Heating', desc: 'Space heater active — tank too cold.', icon: 'local_fire_department', iconFill: true },
};
