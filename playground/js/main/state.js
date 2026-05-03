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

// Custom zoom window for the history graph, set by two-finger pinch on
// the canvas. null = use the default sliding window of width graphRange
// anchored to the most recent data; { tMin, tMax } = render that exact
// span instead. Always narrower than graphRange — a pinch that would
// zoom out beyond it snaps back to null.
export let chartZoom = null;
export function setChartZoom(v) { chartZoom = v; }

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
//
// Per-sample mode tagging is gone: the bar chart, the inspector, and
// the clipboard table all read mode from the mode-events store
// (./mode-events.js), which is the single source of truth populated by
// /api/history's events list (with a leading event from before the
// window) and by detectLiveTransition / simLoop on transitions.
export const timeSeriesStore = {
  maxPoints: 20000,
  times: [],
  values: [],  // { t_tank_top, t_tank_bottom, t_collector, t_greenhouse, t_outdoor }
  addPoint(time, vals) {
    this.times.push(time);
    this.values.push({ ...vals });
    if (this.times.length > this.maxPoints) {
      const trim = this.times.length - this.maxPoints;
      this.times.splice(0, trim);
      this.values.splice(0, trim);
    }
  },
  reset() { this.times = []; this.values = []; },
};

// Dedicated short-window buffer for the rising/falling trend arrows
// shown in the Status gauge and Components view. Kept separate from
// timeSeriesStore so picking a longer graph range (which calls
// timeSeriesStore.reset() and reloads downsampled history) does not
// blow away the high-resolution recent samples the trend computation
// reads from. Pruned by age (TREND_RETENTION_S of headroom over the
// 5 min trend window) so it stays cheap. Survives phase flips; only
// the explicit reset() (called from sim reset / phase flip) clears it.
//
// addPoint accepts samples in any order so the live boot race —
// where the WebSocket state frame may land before the /api/history
// seed (whose points are all older) — does not throw away the
// pre-window history. Out-of-order inserts go to their sorted
// position; duplicate timestamps are dropped (the earlier write
// wins, so a later live-WS sample at the same second can't silently
// overwrite a history point already trusted).
const TREND_RETENTION_S = 600;
export const trendStore = {
  times: [],
  values: [],
  addPoint(time, vals) {
    let lo = 0;
    let hi = this.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.times[mid] < time) lo = mid + 1;
      else hi = mid;
    }
    if (lo < this.times.length && this.times[lo] === time) return;
    this.times.splice(lo, 0, time);
    this.values.splice(lo, 0, { ...vals });
    const latest = this.times[this.times.length - 1];
    const cutoff = latest - TREND_RETENTION_S;
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < cutoff) drop++;
    if (drop > 0) {
      this.times.splice(0, drop);
      this.values.splice(0, drop);
    }
  },
  reset() { this.times = []; this.values = []; },
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
