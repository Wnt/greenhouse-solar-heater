import { loadSystemYaml } from './yaml-loader.js';
import { ThermalModel } from './physics.js';
import { ControlStateMachine, initControlLogic } from './control.js';
import { createSlider, formatTime } from './ui.js';
import { LiveSource, SimulationSource } from './data-source.js';
import { startVersionCheck, triggerVersionCheck } from './version-check.js';
import { initSensorsView, destroySensorsView } from './sensors.js';
import { store, derived } from './app-state.js';
import { initSubscriptions, setViewLifecycle } from './subscriptions.js';
import { initNavigation } from './actions/navigation.js';
import { initAuth } from './auth.js';
// connection.js actions will be used in later phases — import deferred to avoid name collisions
// import { switchToLive, switchToSimulation, ... } from './actions/connection.js';
// Expose for e2e testing
window.__triggerVersionCheck = triggerVersionCheck;

// ── Data Source ──
// Detect deployment context: GitHub Pages = simulation only, deployed app = live capable
const isGitHubPages = location.hostname.endsWith('.github.io');
const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const forceSimulation = new URLSearchParams(location.search).get('mode') === 'sim';
const isLiveCapable = !isGitHubPages && !forceSimulation;
store.set('isLiveCapable', isLiveCapable);

// activeSource is eliminated — use store.get('phase') instead
let liveSource = null;
let simSource = new SimulationSource();

// Connection status tracking
let connectionStatus = 'disconnected';
let lastDataTime = 0;
let stalenessTimer = null;

function updateConnectionUI(status) {
  connectionStatus = status;
  refreshConnectionIndicator();
  updateConnectionOverlays();
  updateDevicePushState();
}

function refreshConnectionIndicator() {
  const dot = document.getElementById('connection-dot');
  const label = document.getElementById('connection-label');
  if (!dot || !label) return;

  if (connectionStatus === 'reconnecting') {
    dot.className = 'connection-dot reconnecting';
    label.textContent = 'Reconnecting\u2026';
    return;
  }

  var displayState = getConnectionDisplayState();
  switch (displayState) {
    case 'active':
      dot.className = 'connection-dot connected';
      label.textContent = 'Live';
      break;
    case 'connecting':
      dot.className = 'connection-dot reconnecting';
      label.textContent = 'Connecting\u2026';
      break;
    case 'device_offline':
      dot.className = 'connection-dot device-offline';
      label.textContent = 'Controller offline';
      break;
    case 'stale':
      dot.className = 'connection-dot reconnecting';
      label.textContent = 'Stale';
      break;
    default:
      dot.className = 'connection-dot disconnected';
      label.textContent = 'Offline';
  }
}

function checkStaleness() {
  if (store.get('phase') !== 'live') return;
  const banner = document.getElementById('staleness-banner');
  if (banner) {
    const elapsed = Date.now() - lastDataTime;
    banner.classList.toggle('visible', elapsed > 60000 && lastDataTime > 0);
  }
  refreshConnectionIndicator();
  updateConnectionOverlays();
  updateDevicePushState();
  updateSidebarSubtitle();
}

var OVERLAY_MESSAGES = {
  connecting: {
    title: 'Reaching out to your sanctuary.',
    subtitle: 'Connecting to the server...'
  },
  never_connected: {
    title: 'Your sanctuary is sleeping.',
    subtitle: 'Cannot reach the server.'
  },
  device_offline: {
    title: 'Your sanctuary is sleeping.',
    subtitle: 'The server is running, but the controller is unreachable.'
  },
  disconnected: {
    title: 'Lost touch with your sanctuary.',
    subtitle: 'Connection to the server was lost.'
  },
  stale: {
    title: 'Your sanctuary has gone quiet.',
    subtitle: 'No data received for over 60 seconds.'
  }
};

function getConnectionDisplayState() {
  if (store.get('phase') !== 'live') return 'active';
  var hasData = liveSource && liveSource.hasReceivedData;
  var mqttStatus = liveSource ? liveSource.mqttStatus : 'unknown';

  if (connectionStatus === 'connected') {
    // WS is open — check MQTT and device data status
    if (mqttStatus === 'disconnected' || mqttStatus === 'reconnecting') {
      return 'device_offline';
    }
    if (hasData) {
      if (lastDataTime > 0 && (Date.now() - lastDataTime) > 60000) return 'stale';
      return 'active';
    }
    // WS connected, waiting for MQTT status or data — show connecting overlay
    // Brief grace period (2s) before declaring device offline
    var connectedAt = liveSource ? liveSource._connectedAt : 0;
    if (connectedAt > 0 && (Date.now() - connectedAt) > 2000) {
      return 'device_offline';
    }
    return 'connecting';
  }

  // WS is not connected or reconnecting
  var wsEverFailed = liveSource && liveSource._wsEverFailed;
  if (!hasData) return wsEverFailed ? 'never_connected' : 'connecting';
  return 'disconnected';
}

function updateConnectionOverlays() {
  var state = getConnectionDisplayState();
  var overlayIds = ['overlay-modes', 'overlay-gauge', 'overlay-components'];
  var msg = OVERLAY_MESSAGES[state];
  for (var i = 0; i < overlayIds.length; i++) {
    var overlay = document.getElementById(overlayIds[i]);
    if (!overlay) continue;
    if (msg) {
      overlay.classList.add('visible');
      var titleEl = document.getElementById(overlayIds[i] + '-title');
      var subtitleEl = document.getElementById(overlayIds[i] + '-subtitle');
      if (titleEl) titleEl.textContent = msg.title;
      if (subtitleEl) subtitleEl.textContent = msg.subtitle;
    } else {
      overlay.classList.remove('visible');
    }
  }
}

function updateDevicePushState() {
  var btn = document.getElementById('dc-save');
  var warning = document.getElementById('dc-connection-warning');
  if (!btn || !warning) return;
  var displayState = getConnectionDisplayState();
  var canPush = store.get('phase') !== 'live' || displayState === 'active' || displayState === 'stale';
  if (canPush) {
    btn.classList.remove('disabled');
    btn.disabled = false;
    warning.style.display = 'none';
  } else {
    btn.classList.add('disabled');
    btn.disabled = true;
    warning.style.display = '';
  }
}

function initModeToggle() {
  const toggle = document.getElementById('mode-toggle');
  const sw = document.getElementById('mode-toggle-switch');
  const label = document.getElementById('mode-toggle-label');
  if (!toggle || !isLiveCapable) {
    store.set('phase', 'simulation');
    return;
  }

  toggle.classList.add('visible');
  // Default to live mode on deployed app
  switchToLive();

  sw.addEventListener('click', function () {
    if (store.get('phase') === 'live') {
      switchToSimulation();
    } else {
      switchToLive();
    }
  });
}

function updateModeToggleUI(isLive) {
  const sw = document.getElementById('mode-toggle-switch');
  const label = document.getElementById('mode-toggle-label');
  if (isLive) {
    if (sw) sw.classList.add('active');
    if (label) { label.textContent = 'Live'; label.classList.add('active'); }
  } else {
    if (sw) sw.classList.remove('active');
    if (label) { label.textContent = 'Simulation'; label.classList.remove('active'); }
  }
}

function ensureLiveSource() {
  if (!liveSource) {
    liveSource = new LiveSource();
    liveSource.onCommandResponse(handleOverrideResponse);
    liveSource.onUpdate(function (state, result) {
      lastDataTime = Date.now();
      if (store.get('phase') !== 'live') return;
      // Defense-in-depth: each step is independent. A bug in updateDisplay
      // must not break the manual override controls (or vice versa).
      var steps = [
        ['updateDisplay',           function () { updateDisplay(state, result); }],
        ['refreshConnectionIndicator', refreshConnectionIndicator],
        ['updateConnectionOverlays',   updateConnectionOverlays],
        ['updateSidebarSubtitle',      updateSidebarSubtitle],
        ['updateDevicePushState',      updateDevicePushState],
        ['updateRelayBoard',        function () { updateRelayBoard(result); }],
      ];
      for (var i = 0; i < steps.length; i++) {
        try { steps[i][1](); }
        catch (e) { console.error('liveSource.onUpdate ' + steps[i][0] + ' failed:', e); }
      }
    });
    liveSource.onConnectionChange(function (status) {
      if (store.get('phase') === 'live') {
        updateConnectionUI(status);
        updateSidebarSubtitle();
      }
    });
  }
  liveSource.start();
}

function startStalenessTimer() {
  if (!stalenessTimer) {
    stalenessTimer = setInterval(checkStaleness, 5000);
  }
}

function stopStalenessTimer() {
  if (stalenessTimer) { clearInterval(stalenessTimer); stalenessTimer = null; }
}

function switchToLive() {
  store.set('phase', 'live');
  updateModeToggleUI(true);
  ensureLiveSource();
  running = false;
  fetchLiveHistory(graphRange);
  startStalenessTimer();
  clearLiveDisplay();
  updateConnectionUI('disconnected');
  updateSidebarSubtitle();
  updatePhaseAwareCopy();
}

function clearLiveDisplay() {
  // Reset display to placeholder values — never show simulation defaults in live mode
  document.getElementById('mode-card-title').textContent = '--';
  document.getElementById('mode-card-status').innerHTML = '';
  document.getElementById('tank-temp-val').textContent = '--';
  document.getElementById('tank-temp-status').textContent = '';
  document.getElementById('tank-temp-message').textContent = '';
  document.getElementById('tank-stat-energy').textContent = '--';
  document.getElementById('tank-stat-greenhouse').textContent = '--';
  document.getElementById('inactive-modes').innerHTML = '';
  document.getElementById('graph-peak-label').textContent = "Yesterday's High: --";
  var arc = document.getElementById('tank-gauge-arc');
  if (arc) arc.setAttribute('stroke-dashoffset', '628');
  // Clear component statuses
  var compEls = document.querySelectorAll('.comp-status');
  compEls.forEach(function(el) { el.textContent = '--'; });
  // Clear simulation graph data and redraw empty canvas
  timeSeriesStore.reset();
  drawHistoryGraph();
}

function switchToSimulation() {
  store.set('phase', 'simulation');
  updateModeToggleUI(false);
  if (liveSource) liveSource.stop();
  updateConnectionUI('disconnected');
  liveHistoryData = null;
  stopStalenessTimer();
  const banner = document.getElementById('staleness-banner');
  if (banner) banner.classList.remove('visible');
  updateConnectionOverlays();
  updateDevicePushState();
  updateSidebarSubtitle();
  updatePhaseAwareCopy();
}

// Swap user-facing copy that differs between live and simulation modes,
// so the Status view doesn't tell live users to "Adjust parameters in
// Controls" or "Start the simulation".
function updatePhaseAwareCopy() {
  var isLive = store.get('phase') === 'live';
  var desc = document.getElementById('status-view-description');
  if (desc) {
    desc.textContent = isLive
      ? 'Live readings from the Shelly controller. Mode, valves, actuators, and 24h history.'
      : 'Thermal simulation of the solar heating system. Adjust parameters in Controls and observe behavior here.';
  }
  var logsEmpty = document.getElementById('logs-list');
  if (logsEmpty && logsEmpty.children.length <= 1) {
    // Only replace the placeholder, not real log entries
    var placeholder = logsEmpty.querySelector('div[data-empty]') || (logsEmpty.children.length === 0 ? null : logsEmpty.firstElementChild);
    if (placeholder && placeholder.dataset && placeholder.dataset.empty === 'true') {
      placeholder.textContent = isLive
        ? 'No transitions yet. Awaiting controller activity…'
        : 'No transitions yet. Start the simulation.';
    }
  }
  var ctrl = document.getElementById('comp-controller');
  if (ctrl && isLive) {
    // In live mode the simulation "running" flag is meaningless. Show
    // ACTIVE when the controller is responsive (will be re-evaluated by
    // the next state broadcast).
    ctrl.textContent = 'ACTIVE';
  }
}

function updateSidebarSubtitle() {
  var el = document.getElementById('sidebar-subtitle');
  if (!el) return;

  if (store.get('phase') === 'simulation') {
    el.textContent = running ? 'Simulating...' : 'Ready';
    el.className = '';
    return;
  }

  // Live mode: reflect connection state
  var displayState = getConnectionDisplayState();
  switch (displayState) {
    case 'active':
      el.textContent = 'Live';
      el.className = 'subtitle-live';
      break;
    case 'connecting':
      el.textContent = 'Connecting\u2026';
      el.className = 'subtitle-connecting';
      break;
    case 'device_offline':
      el.textContent = 'Controller Offline';
      el.className = 'subtitle-offline';
      break;
    case 'stale':
      el.textContent = 'Stale';
      el.className = 'subtitle-offline';
      break;
    case 'disconnected':
    case 'never_connected':
      el.textContent = 'Offline';
      el.className = 'subtitle-offline';
      break;
  }
}

// ── State ──
let config = null;
let model = null;
let controller = null;
let running = false;
let lastFrame = 0;
let simSpeed = 3000;
let simTimeAccum = 0;
const DT = 1;
let graphRange = 86400; // default 24h
let yesterdayHigh = 0;
let confirmedYesterdayHigh = 0;
let lastDay = 0;

// ── Graph Inspector state ──
let inspectorX = null; // null = hidden, otherwise CSS pixel x relative to canvas

function setupInspector() {
  const canvas = document.getElementById('chart');
  const container = canvas.parentElement;
  const tooltip = document.getElementById('graph-inspector');
  const crosshair = document.getElementById('graph-crosshair');

  function getCanvasX(clientX) {
    const rect = canvas.getBoundingClientRect();
    return clientX - rect.left;
  }

  function showInspector(x) {
    inspectorX = x;
    crosshair.style.display = 'block';
    crosshair.style.left = x + 'px';
    tooltip.style.display = 'block';
    // Position tooltip: flip side if near right edge
    const containerW = container.offsetWidth;
    if (x > containerW * 0.6) {
      tooltip.style.left = 'auto';
      tooltip.style.right = (containerW - x + 12) + 'px';
    } else {
      tooltip.style.left = (x + 12) + 'px';
      tooltip.style.right = 'auto';
    }
    updateInspectorData(x);
  }

  function hideInspector() {
    inspectorX = null;
    tooltip.style.display = 'none';
    crosshair.style.display = 'none';
  }

  function updateInspectorData(x) {
    if (timeSeriesStore.times.length < 2) return;
    const dw = canvas.offsetWidth;
    const pad = { top: 16, right: 16, bottom: 24, left: 8 };
    const pw = dw - pad.left - pad.right;

    const latestTime = timeSeriesStore.times[timeSeriesStore.times.length - 1];
    const tMax = Math.max(graphRange, latestTime);
    const tMin = tMax - graphRange;

    // Convert pixel x to simulation time
    const frac = (x - pad.left) / pw;
    if (frac < 0 || frac > 1) { hideInspector(); return; }
    const simTime = tMin + frac * graphRange;

    // Find nearest data point
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < timeSeriesStore.times.length; i++) {
      const d = Math.abs(timeSeriesStore.times[i] - simTime);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }

    const v = timeSeriesStore.values[bestIdx];
    const t = timeSeriesStore.times[bestIdx];

    // Time of day — live data stores Unix epoch seconds, simulation
    // stores seconds since sim start + SIM_START_HOUR offset.
    let todH, todM;
    if (store.get('phase') === 'live') {
      const d = new Date(t * 1000);
      todH = d.getHours();
      todM = d.getMinutes();
    } else {
      todH = Math.floor((SIM_START_HOUR + t / 3600) % 24);
      todM = Math.floor(((SIM_START_HOUR + t / 3600) % 1) * 60);
    }
    document.getElementById('inspector-time').textContent =
      todH.toString().padStart(2, '0') + ':' + todM.toString().padStart(2, '0');

    // Temperature values (null-tolerant for unbound live sensors)
    const fmtInspTemp = function (x) { return isNum(x) ? x.toFixed(1) + '\u00b0C' : TEMP_PLACEHOLDER; };
    document.getElementById('inspector-tank').textContent = fmtInspTemp(v.t_tank_top);
    document.getElementById('inspector-gh').textContent = fmtInspTemp(v.t_greenhouse);
    document.getElementById('inspector-out').textContent = fmtInspTemp(v.t_outdoor);

    // Duty cycle for the hour containing this point
    const hourSeconds = 3600;
    const hr = Math.floor(t / hourSeconds);
    const hrStart = hr * hourSeconds;
    const hrEnd = (hr + 1) * hourSeconds;
    let chargingSec = 0, heatingSec = 0, emergencySec = 0, totalSec = 0;
    for (let j = 0; j < timeSeriesStore.times.length; j++) {
      const st = timeSeriesStore.times[j];
      if (st >= hrStart && st < hrEnd) {
        totalSec += 5;
        if (timeSeriesStore.modes[j] === 'solar_charging') chargingSec += 5;
        if (timeSeriesStore.modes[j] === 'greenhouse_heating') heatingSec += 5;
        if (timeSeriesStore.modes[j] === 'emergency_heating') emergencySec += 5;
      }
    }
    const chPct = totalSec > 0 ? Math.round(100 * chargingSec / totalSec) : 0;
    const htPct = totalSec > 0 ? Math.round(100 * heatingSec / totalSec) : 0;
    const emPct = totalSec > 0 ? Math.round(100 * emergencySec / totalSec) : 0;
    document.getElementById('inspector-charging').textContent = chPct + '%';
    document.getElementById('inspector-heating').textContent = htPct + '%';
    document.getElementById('inspector-emergency').textContent = emPct + '%';
  }

  // Desktop: hover
  canvas.addEventListener('mousemove', function(e) {
    showInspector(getCanvasX(e.clientX));
  });
  canvas.addEventListener('mouseleave', hideInspector);

  // Mobile: long press
  let longPressTimer = null;
  let longPressActive = false;

  canvas.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const startX = touch.clientX;
    const startY = touch.clientY;
    longPressTimer = setTimeout(function() {
      longPressActive = true;
      showInspector(getCanvasX(startX));
    }, 400);
  }, { passive: true });

  canvas.addEventListener('touchmove', function(e) {
    if (longPressActive) {
      e.preventDefault();
      showInspector(getCanvasX(e.touches[0].clientX));
    } else {
      // User is scrolling, cancel long press
      clearTimeout(longPressTimer);
    }
  }, { passive: false });

  canvas.addEventListener('touchend', function() {
    clearTimeout(longPressTimer);
    if (longPressActive) {
      longPressActive = false;
      hideInspector();
    }
  });

  canvas.addEventListener('touchcancel', function() {
    clearTimeout(longPressTimer);
    longPressActive = false;
    hideInspector();
  });
}

// ── Time Series Store (extended with mode tracking) ──
const timeSeriesStore = {
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

// ── Transition log ──
const transitionLog = [];

// ── Scenario presets ──
const PRESETS = {
  spring_fall:   { label: 'Spring / Fall',      t_outdoor: 10,   irradiance: 500, t_tank_top: 12, t_tank_bottom: 9,  t_greenhouse: 11 },
  summer_peak:   { label: 'Summer Peak Heat',   t_outdoor: 26,   irradiance: 500, t_tank_top: 88, t_tank_bottom: 85, t_greenhouse: 11 },
  early_late:    { label: 'Late / Early Season', t_outdoor: -5.5, irradiance: 240, t_tank_top: 13, t_tank_bottom: 13, t_greenhouse: 5 },
};

// ── Input parameters ──
const params = {
  t_outdoor: 10,
  irradiance: 500,
  t_tank_top: 12,
  t_tank_bottom: 9,
  t_greenhouse: 11,
  sim_speed: 3000,
  day_night_cycle: true,
};

// ── Mode metadata ──
const MODE_INFO = {
  idle: { label: 'Idle', desc: 'System waiting for triggers.', icon: 'mode_night', iconFill: false },
  solar_charging: { label: 'Collecting Solar Energy', desc: 'Optimal photon absorption in progress.', icon: 'wb_sunny', iconFill: true },
  greenhouse_heating: { label: 'Heating Greenhouse', desc: 'Thermal redirection active.', icon: 'nest_eco_leaf', iconFill: false },
  active_drain: { label: 'Active Drain', desc: 'Freeze protection draining collectors.', icon: 'water_drop', iconFill: false },
  overheat_drain: { label: 'Overheat Drain', desc: 'Draining to prevent overheating.', icon: 'warning', iconFill: false },
  emergency_heating: { label: 'Emergency Heating', desc: 'Space heater active — tank too cold.', icon: 'local_fire_department', iconFill: true },
};

// ── Init ──
async function init() {
  try {
    config = await loadSystemYaml('../system.yaml');
  } catch {
    config = buildFallbackConfig();
  }

  await initControlLogic();
  model = new ThermalModel();
  controller = new ControlStateMachine(config.modes);

  // Set up view lifecycle callbacks for the store-driven navigation
  setViewLifecycle({
    sensors: {
      mount: (container, s) => {
        initSensorsView();
        return () => destroySensorsView();
      }
    }
  });

  // Initialize store subscriptions (nav, overlays, indicators)
  initSubscriptions(store);

  // Initialize hash-based navigation via store
  initNavigation(store);

  setupControls();
  setupTimeRangePills();
  setupFAB();
  resetSim();
  buildSchematic();
  setupInspector();
  updateDisplay(model.getState(), { mode: 'idle', valves: config.modes.idle.valve_states, actuators: { pump: false, fan: false, space_heater: false }, transition: null });

  // Initialize live/simulation mode toggle
  initModeToggle();
  initDeviceConfig();
  initRelayBoard();

  // Initialize auth UI (logout + invite buttons) — noop when auth disabled
  initAuth();

  // Start polling for JS source updates
  startVersionCheck();
}

function buildFallbackConfig() {
  return {
    modes: {
      idle: { description: 'Default', valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_ret: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'OFF', fan: 'OFF' } },
      solar_charging: { description: 'Solar charging', trigger: 't_collector > t_tank_bottom + 7', exit: 't_collector < t_tank_bottom + 3', valve_states: { vi_btm: 'OPEN', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'OPEN', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_ret: 'OPEN', v_air: 'CLOSED' }, actuators: { pump: 'ON', fan: 'OFF' } },
      greenhouse_heating: { description: 'Greenhouse heating', trigger: 't_greenhouse < 10 AND t_tank_top > 25', exit: 't_greenhouse > 12', valve_states: { vi_btm: 'CLOSED', vi_top: 'OPEN', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'OPEN', vo_tank: 'CLOSED', v_ret: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'ON', fan: 'ON' } },
      active_drain: { description: 'Active drain', trigger: 't_outdoor < 2', exit: null, valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'OPEN', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'OPEN', v_ret: 'CLOSED', v_air: 'OPEN' }, actuators: { pump: 'ON', fan: 'OFF' } },
      overheat_drain: { description: 'Overheat drain', trigger: 't_tank_top > 85', exit: null, valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'OPEN', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'OPEN', v_ret: 'CLOSED', v_air: 'OPEN' }, actuators: { pump: 'ON', fan: 'OFF' } },
      emergency_heating: { description: 'Emergency', trigger: 't_greenhouse < 5 AND t_tank_top < 25', exit: 't_greenhouse > 8', valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_ret: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'OFF', fan: 'OFF', space_heater: 'ON' } },
    },
    valves: {}, sensors: {}, components: {}, safety: [],
    project: { name: 'Greenhouse Solar Heater' },
  };
}

// ── Navigation is now store-driven via js/actions/navigation.js + js/subscriptions.js ──

// ── FAB ──
function setupFAB() {
  document.getElementById('fab-play').addEventListener('click', togglePlay);
}

function togglePlay() {
  running = !running;
  updateFABIcon();
  if (running) {
    lastFrame = 0;
    simTimeAccum = 0;
    if (model.state.simTime === 0) {
      model.reset({
        t_tank_top: params.t_tank_top,
        t_tank_bottom: params.t_tank_bottom,
        t_greenhouse: params.t_greenhouse,
        t_outdoor: params.t_outdoor,
        irradiance: params.irradiance,
      });
      controller.reset();
      timeSeriesStore.reset();
      transitionLog.length = 0;
    }
    document.getElementById('sim-status-text').textContent = 'Running — press pause to stop';
    updateSidebarSubtitle();
    requestAnimationFrame(simLoop);
  } else {
    document.getElementById('sim-status-text').textContent = 'Paused — press play to resume';
    updateSidebarSubtitle();
  }
}

function updateFABIcon() {
  const fab = document.getElementById('fab-play');
  fab.querySelector('.material-symbols-outlined').textContent = running ? 'pause' : 'play_arrow';
  fab.title = running ? 'Pause simulation' : 'Start simulation';
}

// ── Time range pills ──
// ── Live history fetch ──
const RANGE_MAP = { 3600: '1h', 21600: '6h', 43200: '12h', 86400: '24h', 604800: '7d', 2592000: '30d', 31536000: '1y' };
let liveHistoryData = null;

function fetchLiveHistory(rangeSeconds) {
  if (store.get('phase') !== 'live') return;
  const rangeKey = RANGE_MAP[rangeSeconds] || '6h';
  fetch('/api/history?range=' + rangeKey)
    .then(r => r.json())
    .then(data => {
      // Only apply to the current phase — the user may have switched
      // back to simulation while the request was in flight.
      if (store.get('phase') !== 'live') return;
      liveHistoryData = data;
      loadLiveHistoryIntoStore(data);
      drawHistoryGraph();
    })
    .catch(() => { liveHistoryData = null; });
}

// Convert /api/history response into timeSeriesStore format.
// Live-mode times are stored as Unix epoch seconds so the graph/inspector
// can render both simulation (simTime seconds) and live (epoch seconds)
// data with a single sliding-window routine.
function loadLiveHistoryIntoStore(data) {
  timeSeriesStore.reset();
  if (!data || !Array.isArray(data.points)) return;

  const modeEvents = Array.isArray(data.events)
    ? data.events.filter(e => e && e.type === 'mode').sort((a, b) => a.ts - b.ts)
    : [];
  let currentMode = 'idle';
  let eventIdx = 0;

  for (let i = 0; i < data.points.length; i++) {
    const p = data.points[i];
    if (!p || typeof p.ts !== 'number') continue;
    while (eventIdx < modeEvents.length && modeEvents[eventIdx].ts <= p.ts) {
      currentMode = modeEvents[eventIdx].to || currentMode;
      eventIdx++;
    }
    const tSec = Math.floor(p.ts / 1000);
    timeSeriesStore.addPoint(tSec, {
      t_tank_top: p.tank_top,
      t_tank_bottom: p.tank_bottom,
      t_collector: p.collector,
      t_greenhouse: p.greenhouse,
      t_outdoor: p.outdoor,
    }, currentMode);
  }
}

// Append an incoming live state frame to the history store so the
// graph ticks forward in real time. Rate-limited to one sample every
// ~5 seconds to match the simulation recording cadence.
function recordLiveHistoryPoint(state, result) {
  if (store.get('phase') !== 'live') return;
  const tSec = Math.floor(Date.now() / 1000);
  const last = timeSeriesStore.times.length - 1;
  if (last >= 0 && (tSec - timeSeriesStore.times[last]) < 5) return;
  timeSeriesStore.addPoint(tSec, {
    t_tank_top: state.t_tank_top,
    t_tank_bottom: state.t_tank_bottom,
    t_collector: state.t_collector,
    t_greenhouse: state.t_greenhouse,
    t_outdoor: state.t_outdoor,
  }, result.mode || 'idle');
}

// Test hook: report the number of history samples currently in the
// store. Used by e2e tests to verify that live data populates the graph.
window.__getHistoryPointCount = function () { return timeSeriesStore.times.length; };

function setupTimeRangePills() {
  document.getElementById('time-range-pills').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    graphRange = parseInt(btn.dataset.range);
    document.querySelectorAll('#time-range-pills button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (store.get('phase') === 'live') {
      fetchLiveHistory(graphRange);
    } else {
      drawHistoryGraph();
    }
  });
}

// ── Controls ──
const liveStateKeys = { t_tank_top: 't_tank_top', t_tank_bottom: 't_tank_bottom', t_greenhouse: 't_greenhouse' };

const sliderRefs = {};

function setupControls() {
  const el = document.getElementById('controls');
  const sliders = [
    { id: 'outdoor', label: 'Outdoor Temp', min: -30, max: 40, step: 0.5, value: params.t_outdoor, unit: '°C', key: 't_outdoor' },
    { id: 'irradiance', label: 'Solar Irradiance', min: 0, max: 1000, step: 10, value: params.irradiance, unit: ' W/m²', key: 'irradiance' },
    { id: 'tank-top', label: 'Tank Top', min: 5, max: 95, step: 1, value: params.t_tank_top, unit: '°C', key: 't_tank_top' },
    { id: 'tank-bot', label: 'Tank Bottom', min: 5, max: 95, step: 1, value: params.t_tank_bottom, unit: '°C', key: 't_tank_bottom' },
    { id: 'greenhouse', label: 'Greenhouse', min: -10, max: 40, step: 0.5, value: params.t_greenhouse, unit: '°C', key: 't_greenhouse' },
    { id: 'speed', label: 'Sim Speed', min: 1, max: 10000, step: 1, value: params.sim_speed, unit: '×', key: 'sim_speed',
      steps: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 3000, 5000, 10000] },
  ];

  for (const s of sliders) {
    const ref = createSlider(el, {
      ...s,
      onChange: (v) => {
        params[s.key] = v;
        if (s.key === 'sim_speed') simSpeed = v;
        if (model && running && liveStateKeys[s.key]) {
          model.state[liveStateKeys[s.key]] = v;
        }
        // Tank top must be >= tank bottom
        if (s.key === 't_tank_bottom' && v > params.t_tank_top) {
          params.t_tank_top = v;
          sliderRefs.t_tank_top.update(v);
        }
        if (s.key === 't_tank_top' && v < params.t_tank_bottom) {
          params.t_tank_bottom = v;
          sliderRefs.t_tank_bottom.update(v);
        }
      },
    });
    sliderRefs[s.key] = ref;
  }

  // Scenario presets
  const bar = document.getElementById('preset-bar');
  for (const [key, preset] of Object.entries(PRESETS)) {
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = preset.label;
    btn.dataset.preset = key;
    btn.addEventListener('click', () => applyPreset(key));
    bar.appendChild(btn);
  }
  updatePresetHighlight('spring_fall');

  // Day/night toggle
  const dnGroup = document.createElement('div');
  dnGroup.className = 'control-group';
  dnGroup.innerHTML = `
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="checkbox" id="day-night-toggle" checked> Day / Night Cycle
    </label>
    <div id="day-night-info" style="font-size:12px;color:var(--text-muted);margin-top:4px;">
      Sliders set base outdoor temp &amp; peak irradiance.<br>
      Time of day: <strong id="sim-time-of-day" style="color:var(--text-bright);">08:00</strong>
    </div>
  `;
  el.appendChild(dnGroup);

  document.getElementById('day-night-toggle').addEventListener('change', (e) => {
    params.day_night_cycle = e.target.checked;
    document.getElementById('day-night-info').style.display = e.target.checked ? '' : 'none';
  });

  // Reset
  document.getElementById('btn-reset').addEventListener('click', () => resetSim());
}

function resetSim() {
  model.reset({
    t_tank_top: params.t_tank_top,
    t_tank_bottom: params.t_tank_bottom,
    t_greenhouse: params.t_greenhouse,
    t_outdoor: params.t_outdoor,
    irradiance: params.irradiance,
  });
  controller.reset();
  timeSeriesStore.reset();
  transitionLog.length = 0;
  yesterdayHigh = 0;
  confirmedYesterdayHigh = 0;
  lastDay = 0;
  running = false;
  lastFrame = 0;
  simTimeAccum = 0;
  updateFABIcon();
  document.getElementById('sim-status-text').textContent = 'Ready — press play to start';
  updateSidebarSubtitle();
  document.getElementById('logs-list').innerHTML = '<div style="color:var(--on-surface-variant);font-size:13px;">No transitions yet. Start the simulation.</div>';
  updateDisplay(model.getState(), { mode: 'idle', valves: config.modes.idle.valve_states, actuators: { pump: false, fan: false, space_heater: false }, transition: null });
}

function applyPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;
  const keys = ['t_outdoor', 'irradiance', 't_tank_top', 't_tank_bottom', 't_greenhouse'];
  for (const k of keys) {
    params[k] = preset[k];
    if (sliderRefs[k]) sliderRefs[k].update(preset[k]);
  }
  updatePresetHighlight(key);
  resetSim();
}

function updatePresetHighlight(activeKey) {
  for (const btn of document.querySelectorAll('.preset-btn')) {
    btn.classList.toggle('preset-active', btn.dataset.preset === activeKey);
  }
}

// ── Day/Night ──
const SIM_START_HOUR = 8;

function formatTimeOfDay(simSeconds) {
  const totalHours = SIM_START_HOUR + simSeconds / 3600;
  const h = Math.floor(totalHours % 24);
  const m = Math.floor((totalHours * 60) % 60);
  return h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0');
}

function getDayNightEnv(simTime, baseOutdoor, peakIrradiance) {
  const hour = (SIM_START_HOUR + simTime / 3600) % 24;
  let irradiance = 0;
  if (hour >= 6 && hour <= 20) {
    irradiance = peakIrradiance * Math.sin((hour - 6) / 14 * Math.PI);
  }
  const t_outdoor = baseOutdoor + 5 * Math.cos((hour - 15) / 24 * 2 * Math.PI);
  return { t_outdoor, irradiance };
}

function getTimeOfDay(simTime) {
  const h = SIM_START_HOUR + simTime / 3600;
  return `${Math.floor(h % 24).toString().padStart(2, '0')}:${Math.floor((h * 60) % 60).toString().padStart(2, '0')}`;
}

// ── Sim loop ──
function simLoop(timestamp) {
  if (!running) return;
  if (!lastFrame) lastFrame = timestamp;
  const realDt = (timestamp - lastFrame) / 1000;
  lastFrame = timestamp;

  simTimeAccum += realDt * simSpeed;
  const steps = Math.min(Math.floor(simTimeAccum / DT), 50);
  simTimeAccum -= steps * DT;

  let result;
  for (let i = 0; i < steps; i++) {
    let env;
    if (params.day_night_cycle) {
      env = getDayNightEnv(model.state.simTime, params.t_outdoor, params.irradiance);
    } else {
      env = { t_outdoor: params.t_outdoor, irradiance: params.irradiance };
    }

    const sensors = {
      t_collector: model.state.t_collector,
      t_tank_top: model.state.t_tank_top,
      t_tank_bottom: model.state.t_tank_bottom,
      t_greenhouse: model.state.t_greenhouse,
      t_outdoor: model.state.t_outdoor,
    };

    result = controller.evaluate(sensors, model.state.simTime);

    if (result.transition) {
      transitionLog.unshift({ time: model.state.simTime, text: result.transition, mode: result.mode });
    }

    model.step(DT, env, result.actuators, result.mode);

    // Record every ~5 seconds of sim time
    if (Math.floor(model.state.simTime) % 5 === 0) {
      timeSeriesStore.addPoint(model.state.simTime, {
        t_tank_top: model.state.t_tank_top,
        t_tank_bottom: model.state.t_tank_bottom,
        t_collector: model.state.t_collector,
        t_greenhouse: model.state.t_greenhouse,
        t_outdoor: model.state.t_outdoor,
      }, result.mode);
    }
  }

  // Update day/night display
  if (params.day_night_cycle) {
    const tod = getTimeOfDay(model.state.simTime);
    const el = document.getElementById('sim-time-of-day');
    if (el) el.textContent = tod;
  }

  if (result) updateDisplay(model.getState(), result);
  requestAnimationFrame(simLoop);
}

// ── Display update ──
// Null-tolerant helpers for live data: the Shelly publishes `null` for any
// sensor whose role is not assigned. Display "—" instead of crashing.
const TEMP_PLACEHOLDER = '\u2014';
function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }
function fmtTemp(v, digits) {
  if (digits === undefined) digits = 0;
  return isNum(v) ? v.toFixed(digits) : TEMP_PLACEHOLDER;
}

function updateDisplay(state, result) {
  const mode = result.mode;
  const info = MODE_INFO[mode] || MODE_INFO.idle;

  // ── Status view ──
  // Active mode card
  document.getElementById('mode-badge-label').textContent = 'Current Mode';
  document.getElementById('mode-card-title').textContent = info.label;
  const statusEl = document.getElementById('mode-card-status');
  statusEl.innerHTML = running
    ? `<span class="pulse"></span> System Active`
    : `<span class="pulse"></span> System Ready`;
  const bgIcon = document.querySelector('.mode-card-bg-icon .material-symbols-outlined');
  bgIcon.textContent = info.icon;
  bgIcon.style.fontVariationSettings = info.iconFill
    ? "'FILL' 1, 'wght' 300, 'GRAD' 0, 'opsz' 48"
    : "'FILL' 0, 'wght' 300, 'GRAD' 0, 'opsz' 48";

  // Inactive modes
  const inactiveEl = document.getElementById('inactive-modes');
  const otherModes = ['solar_charging', 'greenhouse_heating', 'idle']
    .filter(m => m !== mode)
    .filter(m => !(m === 'idle' && !['solar_charging', 'greenhouse_heating', 'idle'].includes(mode)));
  inactiveEl.innerHTML = otherModes.map(m => {
    const mi = MODE_INFO[m];
    return `<div class="card mode-card mode-card-inactive" style="margin-bottom:8px;">
      <div><h4>${mi.label}</h4><p>${mi.desc}</p></div>
      <div class="mode-icon"><span class="material-symbols-outlined">${mi.icon}</span></div>
    </div>`;
  }).join('');

  // Tank temperature gauge (shows tank bottom)
  document.getElementById('tank-temp-val').textContent = fmtTemp(state.t_tank_bottom, 0);

  // Energy stored: Q = m * c * (T_avg - T_base), 300L water, base 12°C
  // Heat loss: estimated from 24h temperature history in store
  const TANK_MASS = 300; // kg
  const SPECIFIC_HEAT = 4.186; // kJ/(kg·K)
  const BASE_TEMP = 12; // °C
  const energyEl = document.getElementById('tank-stat-energy');
  if (isNum(state.t_tank_top) && isNum(state.t_tank_bottom)) {
    const avgTankTemp = (state.t_tank_top + state.t_tank_bottom) / 2;
    const grossKwh = TANK_MASS * SPECIFIC_HEAT * Math.max(0, avgTankTemp - BASE_TEMP) / 3600;
    // Estimate 24h heat loss from stored data
    let lossKwh = 0;
    if (timeSeriesStore.times.length > 1) {
      const now = timeSeriesStore.times[timeSeriesStore.times.length - 1];
      const dayAgo = now - 86400;
      // Sum temperature drops during idle periods (no active heating/charging)
      for (let i = 1; i < timeSeriesStore.times.length; i++) {
        if (timeSeriesStore.times[i] < dayAgo) continue;
        const m = timeSeriesStore.modes[i];
        if (m === 'idle' || m === 'greenhouse_heating') {
          const prev = timeSeriesStore.values[i - 1];
          const curr = timeSeriesStore.values[i];
          if (!isNum(prev.t_tank_top) || !isNum(prev.t_tank_bottom) ||
              !isNum(curr.t_tank_top) || !isNum(curr.t_tank_bottom)) continue;
          const prevAvg = (prev.t_tank_top + prev.t_tank_bottom) / 2;
          const currAvg = (curr.t_tank_top + curr.t_tank_bottom) / 2;
          const drop = prevAvg - currAvg;
          if (drop > 0) lossKwh += TANK_MASS * SPECIFIC_HEAT * drop / 3600;
        }
      }
    }
    const netKwh = Math.max(0, grossKwh - lossKwh);
    energyEl.textContent = netKwh.toFixed(1);
  } else {
    energyEl.textContent = TEMP_PLACEHOLDER;
  }

  // Greenhouse current temperature
  document.getElementById('tank-stat-greenhouse').textContent = fmtTemp(state.t_greenhouse, 0);

  // Track yesterday's high (peak from previous 24h simulated day)
  if (isNum(state.t_tank_bottom)) {
    if (state.t_tank_bottom > yesterdayHigh) yesterdayHigh = state.t_tank_bottom;
    const simDay = Math.floor(state.simTime / 86400);
    if (simDay > lastDay) {
      confirmedYesterdayHigh = yesterdayHigh;
      yesterdayHigh = state.t_tank_bottom;
      lastDay = simDay;
    }
  }

  // Gauge arc: 0°C = empty, 100°C = full circle (628 circumference)
  const arc = document.getElementById('tank-gauge-arc');
  if (arc) {
    if (isNum(state.t_tank_bottom)) {
      const tempFrac = Math.max(0, Math.min(1, state.t_tank_bottom / 100));
      const dashOffset = 628 - (tempFrac * 628);
      arc.setAttribute('stroke-dashoffset', dashOffset.toFixed(0));
    } else {
      arc.setAttribute('stroke-dashoffset', '628');
    }
  }

  // Status label: Rising/Falling/Stable based on rate of change
  // Check last 5 minutes (300s) of store data; threshold: 1°C/hr = 300/3600 ≈ 0.083°C per 5 min
  const statusLabel = document.getElementById('tank-temp-status');
  const ROC_WINDOW = 300; // 5 minutes in seconds
  const ROC_THRESHOLD = 1 / 12; // 1°C/hr expressed as °C per 5 min
  let rateStatus = 'STABLE';
  let rateColor = '#43aea4';
  if (timeSeriesStore.times.length >= 2) {
    const now = timeSeriesStore.times[timeSeriesStore.times.length - 1];
    const windowStart = now - ROC_WINDOW;
    // Find the earliest point within the window
    let startIdx = timeSeriesStore.times.length - 1;
    for (let i = timeSeriesStore.times.length - 2; i >= 0; i--) {
      if (timeSeriesStore.times[i] < windowStart) break;
      startIdx = i;
    }
    if (startIdx < timeSeriesStore.times.length - 1) {
      const latest = timeSeriesStore.values[timeSeriesStore.values.length - 1].t_tank_bottom;
      const earlier = timeSeriesStore.values[startIdx].t_tank_bottom;
      if (isNum(latest) && isNum(earlier)) {
        const tempChange = latest - earlier;
        if (tempChange >= ROC_THRESHOLD) { rateStatus = 'RISING'; rateColor = '#e9c349'; }
        else if (tempChange <= -ROC_THRESHOLD) { rateStatus = 'FALLING'; rateColor = '#ee7d77'; }
      }
    }
  }
  statusLabel.textContent = rateStatus;
  statusLabel.style.color = rateColor;

  // Message
  const msgEl = document.getElementById('tank-temp-message');
  if (!isNum(state.t_tank_bottom)) msgEl.textContent = 'Waiting for sensor data — assign sensors in the Sensors view.';
  else if (state.t_tank_bottom > 80) msgEl.textContent = 'Approaching maximum temperature.';
  else if (state.t_tank_bottom > 50) msgEl.textContent = 'Tank is well charged.';
  else if (state.t_tank_bottom > 25) msgEl.textContent = 'Moderate thermal storage.';
  else msgEl.textContent = 'Tank is cold — waiting for solar gain.';

  // Graph yesterday's high label
  document.getElementById('graph-peak-label').textContent =
    confirmedYesterdayHigh > 0 ? `Yesterday's High: ${confirmedYesterdayHigh.toFixed(0)}°C` : 'Yesterday\'s High: --';

  // Critical components
  updateComponent('comp-pump', result.actuators.pump, 'ACTIVE', 'OFF');
  updateComponent('comp-fan', result.actuators.fan, 'ON', 'OFF');
  updateComponent('comp-heater', result.actuators.space_heater, 'ON', 'OFF');
  // Live mode: 'running' is meaningless (sim-only). Reflect actual operation
  // by checking whether any actuator is active OR mode is non-idle.
  var isLivePhase = store.get('phase') === 'live';
  var ctrlEl = document.getElementById('comp-controller');
  if (isLivePhase) {
    var anyActive = result.mode && result.mode !== 'idle';
    ctrlEl.textContent = anyActive ? 'ACTIVE' : 'READY';
  } else {
    ctrlEl.textContent = running ? 'OPTIMAL' : 'READY';
  }

  // Logs
  if (transitionLog.length > 0) {
    const logHtml = transitionLog.slice(0, 20).map(t => {
      const mi = MODE_INFO[t.mode] || MODE_INFO.idle;
      const dotClass = t.mode === 'solar_charging' || t.mode === 'active_drain' ? 'log-dot-charging'
        : t.mode === 'greenhouse_heating' ? 'log-dot-heating'
        : t.mode === 'emergency_heating' ? 'log-dot-emergency' : 'log-dot-muted';
      return `<div class="log-item">
        <div class="log-dot ${dotClass}"></div>
        <div class="log-content">
          <div class="log-title">${mi.label}</div>
          <div class="log-desc">${t.text}</div>
        </div>
        <div class="log-time">${formatTimeOfDay(t.time)}</div>
      </div>`;
    }).join('');
    document.getElementById('logs-list').innerHTML = logHtml;
  }

  // ── Components view ──
  // Temperatures
  const tempBody = document.getElementById('temp-table');
  const temps = [
    ['Collector', state.t_collector],
    ['Tank Top', state.t_tank_top],
    ['Tank Bottom', state.t_tank_bottom],
    ['Greenhouse', state.t_greenhouse],
    ['Outdoor', state.t_outdoor],
  ];
  tempBody.innerHTML = temps.map(([n, v]) =>
    `<tr><td>${n}</td><td class="val">${isNum(v) ? v.toFixed(1) + '°C' : TEMP_PLACEHOLDER}</td></tr>`
  ).join('');

  // Valve grid
  const VALVE_LABELS = {
    vi_btm: 'In: Tank Btm',
    vi_top: 'In: Reservoir',
    vi_coll: 'In: Collector',
    vo_coll: 'Out: Collector',
    vo_rad: 'Out: Radiator',
    vo_tank: 'Out: Tank',
    v_ret: 'Return',
    v_air: 'Air Intake',
  };
  const valveNames = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_ret', 'v_air'];
  document.getElementById('valve-grid').innerHTML = valveNames.map(v => {
    const raw = result.valves[v];
    const isOpen = raw === true || raw === 'OPEN';
    const cls = isOpen ? 'valve-chip-open' : 'valve-chip-closed';
    return `<div class="valve-chip"><span class="valve-chip-name">${VALVE_LABELS[v]}</span><span class="valve-chip-state ${cls}">${isOpen ? 'OPEN' : 'CLOSED'}</span></div>`;
  }).join('');

  // Actuator grid
  const actuators = [
    ['Pump', result.actuators.pump, 'cyclone'],
    ['Fan', result.actuators.fan, 'mode_fan'],
    ['Space Heater', result.actuators.space_heater, 'heat_pump'],
  ];
  document.getElementById('actuator-grid').innerHTML = actuators.map(([name, on, icon]) => {
    const cls = on ? 'component-value-active' : 'component-value-off';
    return `<div class="component-card">
      <div><div class="component-label">${name}</div><div class="component-value ${cls}">${on ? 'ON' : 'OFF'}</div></div>
      <span class="material-symbols-outlined component-icon">${icon}</span>
    </div>`;
  }).join('');

  // ── Transition status (live mode) ──
  const transEl = document.getElementById('transition-status');
  const stepEl = document.getElementById('transition-step');
  if (transEl && stepEl) {
    if (result.transitioning && result.transition_step) {
      transEl.style.display = '';
      const stepLabels = {
        pump_stop: 'Stopping pump...',
        valves_closing: 'Closing all valves...',
        valves_opening: 'Opening new valves...',
        pump_start: 'Starting pump...',
      };
      stepEl.textContent = stepLabels[result.transition_step] || result.transition_step;
    } else {
      transEl.style.display = 'none';
    }
  }

  // ── Controls indicator ──
  const ctrlInd = document.getElementById('controls-indicator');
  if (ctrlInd && result.controls_enabled !== undefined) {
    ctrlInd.classList.toggle('visible', !result.controls_enabled);
  }

  // ── Schematic ──
  updateSchematic(state, result);

  // ── Graph ──
  // Live mode: each incoming state frame gets recorded so the sliding
  // window advances. Simulation mode records points directly from
  // simLoop(), so we don't duplicate them here.
  recordLiveHistoryPoint(state, result);
  drawHistoryGraph();
}

function updateComponent(id, on, onLabel, offLabel) {
  const el = document.getElementById(id);
  el.textContent = on ? onLabel : offLabel;
  el.className = 'component-value ' + (on ? 'component-value-active' : 'component-value-off');
}

// ── History graph ──
function drawHistoryGraph() {
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width = canvas.offsetWidth * dpr;
  const h = canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  const dw = canvas.offsetWidth;
  const dh = canvas.offsetHeight;
  ctx.clearRect(0, 0, dw, dh);

  const pad = { top: 16, right: 16, bottom: 24, left: 8 };
  const pw = dw - pad.left - pad.right;
  const ph = dh - pad.top - pad.bottom;

  // Sliding window: right edge = latest sim time (or graphRange if sim
  // hasn't run that long). In live mode the time base is Unix epoch
  // seconds, so the sliding window always trails real wall-clock time.
  const isLivePhase = store.get('phase') === 'live';
  const latestTime = timeSeriesStore.times.length > 0 ? timeSeriesStore.times[timeSeriesStore.times.length - 1] : 0;
  const tMax = isLivePhase ? Math.floor(Date.now() / 1000) : Math.max(graphRange, latestTime);
  const tMin = tMax - graphRange;

  // Y range for temperature
  let yMin = 0, yMax = 100;

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = pad.top + ph - (i / 4) * ph;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + pw, y);
    ctx.stroke();
  }

  // X-axis time labels — show time of day at full hours
  ctx.fillStyle = '#a5abb9';
  ctx.font = '10px Manrope, sans-serif';
  ctx.textAlign = 'center';

  // Fixed time-of-day labels — anchor to absolute hour boundaries to avoid twitching
  const hourSeconds = 3600;
  const hoursInRange = graphRange / hourSeconds;
  const hourStep = hoursInRange <= 2 ? 1 : hoursInRange <= 8 ? 2 : hoursInRange <= 16 ? 3 : 4;
  // Snap to multiples of hourStep so labels stay fixed as time advances
  const stepSeconds = hourStep * hourSeconds;
  const firstTick = Math.ceil(tMin / stepSeconds) * stepSeconds;
  for (let t = firstTick; t <= tMax; t += stepSeconds) {
    const frac = (t - tMin) / graphRange;
    if (frac < -0.01 || frac > 1.01) continue;
    const x = pad.left + frac * pw;
    let todH;
    if (isLivePhase) {
      // Live mode: t is Unix epoch seconds; render in local time
      todH = new Date(t * 1000).getHours();
    } else {
      todH = Math.floor((SIM_START_HOUR + t / hourSeconds) % 24);
    }
    const label = todH.toString().padStart(2, '0') + ':00';
    ctx.fillText(label, x, dh - 4);
  }

  if (timeSeriesStore.times.length < 2) return;

  // ── Duty cycle bars ──
  const barAreaH = ph * 0.3;
  const barY0 = pad.top + ph;

  // Compute duty cycles for each hour in the visible window
  const firstVisibleHour = Math.floor(tMin / hourSeconds);
  const lastVisibleHour = Math.ceil(tMax / hourSeconds);

  let hasEmergency = false;
  for (let hr = firstVisibleHour; hr < lastVisibleHour; hr++) {
    const hrStart = hr * hourSeconds;
    const hrEnd = (hr + 1) * hourSeconds;

    // Skip if entirely outside visible range
    if (hrEnd <= tMin || hrStart >= tMax) continue;

    let chargingSec = 0, heatingSec = 0, emergencySec = 0, totalSec = 0;
    for (let j = 0; j < timeSeriesStore.times.length; j++) {
      const t = timeSeriesStore.times[j];
      if (t >= hrStart && t < hrEnd) {
        totalSec += 5;
        if (timeSeriesStore.modes[j] === 'solar_charging') chargingSec += 5;
        if (timeSeriesStore.modes[j] === 'greenhouse_heating') heatingSec += 5;
        if (timeSeriesStore.modes[j] === 'emergency_heating') emergencySec += 5;
      }
    }

    if (totalSec === 0) continue;
    const chargingFrac = chargingSec / hourSeconds;
    const heatingFrac = heatingSec / hourSeconds;
    const emergencyFrac = emergencySec / hourSeconds;

    const barX = pad.left + ((hrStart - tMin) / graphRange) * pw;
    const barW = Math.max(1, (hourSeconds / graphRange) * pw - 2);

    let stackH = 0;

    if (chargingFrac > 0) {
      const bh = chargingFrac * barAreaH;
      ctx.fillStyle = 'rgba(238, 125, 119, 0.6)';
      ctx.fillRect(barX, barY0 - bh, barW, bh);
      stackH += bh;
    }

    if (heatingFrac > 0) {
      const htBh = heatingFrac * barAreaH;
      ctx.fillStyle = 'rgba(233, 195, 73, 0.6)';
      ctx.fillRect(barX, barY0 - stackH - htBh, barW, htBh);
      stackH += htBh;
    }

    if (emergencyFrac > 0) {
      hasEmergency = true;
      const emBh = emergencyFrac * barAreaH;
      ctx.fillStyle = 'rgba(255, 112, 67, 0.7)';
      ctx.fillRect(barX, barY0 - stackH - emBh, barW, emBh);
      stackH += emBh;
    }
  }
  document.getElementById('legend-emergency').style.display = hasEmergency ? 'flex' : 'none';

  // ── Temperature line (gold, matching Stitch design) ──
  const pts = [];
  for (let i = 0; i < timeSeriesStore.times.length; i++) {
    const t = timeSeriesStore.times[i];
    if (t < tMin) continue;
    if (t > tMax) break;
    const v = timeSeriesStore.values[i].t_tank_top;
    if (!isNum(v)) continue;
    const x = pad.left + ((t - tMin) / graphRange) * pw;
    const y = pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
    pts.push({ x, y });
  }

  if (pts.length >= 2) {
    // Area fill gradient under the line
    const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ph);
    grad.addColorStop(0, 'rgba(233, 195, 73, 0.4)');
    grad.addColorStop(1, 'rgba(233, 195, 73, 0)');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(pts[pts.length - 1].x, pad.top + ph);
    ctx.lineTo(pts[0].x, pad.top + ph);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line stroke
    ctx.beginPath();
    ctx.strokeStyle = '#e9c349';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#e9c349';
    ctx.shadowBlur = 4;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Current point dot (glowing)
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#e9c349';
    ctx.fill();
  }

  // ── Greenhouse line (green) ──
  drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, 't_greenhouse', '#69d0c5', 1);

  // ── Outside line (blue) ──
  drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, 't_outdoor', '#42a5f5', 1);
}

function drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, key, color, lineWidth) {
  const pts = [];
  for (let i = 0; i < timeSeriesStore.times.length; i++) {
    const t = timeSeriesStore.times[i];
    if (t < tMin) continue;
    if (t > tMax) break;
    const v = timeSeriesStore.values[i][key];
    if (!isNum(v)) continue;
    const x = pad.left + ((t - tMin) / graphRange) * pw;
    const y = pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
    pts.push({ x, y });
  }
  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.globalAlpha = 0.7;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ── SVG Schematic ──
function buildSchematic() {
  const svg = document.getElementById('schematic');
  svg.innerHTML = `
    <svg viewBox="0 0 700 400" xmlns="http://www.w3.org/2000/svg" style="font-family: 'Manrope', sans-serif;">
      <rect id="s-tank" x="250" y="60" width="80" height="200" rx="4" fill="#161a21" stroke="#424854" stroke-width="2"/>
      <text x="290" y="50" fill="#a5abb9" font-size="12" text-anchor="middle">Tank 300L</text>
      <text id="s-t-top" x="290" y="100" fill="#a5abb9" font-size="11" text-anchor="middle">--°C</text>
      <text id="s-t-bot" x="290" y="230" fill="#a5abb9" font-size="11" text-anchor="middle">--°C</text>
      <defs>
        <linearGradient id="tank-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ee7d77" stop-opacity="0.5"/>
          <stop offset="100%" stop-color="#43aea4" stop-opacity="0.5"/>
        </linearGradient>
      </defs>
      <rect x="252" y="62" width="76" height="196" rx="3" fill="url(#tank-grad)"/>
      <rect id="s-reservoir" x="340" y="48" width="50" height="28" rx="3" fill="rgba(67,174,164,0.1)" stroke="#424854" stroke-width="1.5"/>
      <text x="365" y="45" fill="#a5abb9" font-size="9" text-anchor="middle">Reservoir</text>
      <text x="365" y="82" fill="#6f7683" font-size="7" text-anchor="middle">200–220cm</text>
      <path d="M345,48 L385,48" stroke="#43aea4" stroke-width="1" stroke-dasharray="3,2"/>
      <text x="392" y="52" fill="#43aea4" font-size="7">open</text>
      <line x1="355" y1="76" x2="330" y2="76" stroke="#6f7683" stroke-width="2" stroke-dasharray="4,2"/>
      <line x1="330" y1="62" x2="330" y2="76" stroke="#6f7683" stroke-width="2" stroke-dasharray="4,2"/>
      <rect id="s-coll" x="50" y="40" width="60" height="180" rx="4" fill="#e9c349" stroke="#6f7683" stroke-width="2" opacity="0.7"/>
      <text x="80" y="30" fill="#a5abb9" font-size="12" text-anchor="middle">Collectors</text>
      <text id="s-t-coll" x="80" y="140" fill="#e0e5f5" font-size="11" text-anchor="middle" font-weight="bold">--°C</text>
      <circle id="s-sun" cx="80" cy="15" r="10" fill="#e9c349" opacity="0.5"/>
      <text id="s-irr" x="100" y="19" fill="#a5abb9" font-size="10">-- W/m²</text>
      <rect x="500" y="120" width="150" height="140" rx="6" fill="rgba(67,174,164,0.05)" stroke="#424854" stroke-width="1.5" stroke-dasharray="6,3"/>
      <text x="575" y="115" fill="#a5abb9" font-size="12" text-anchor="middle">Greenhouse</text>
      <rect id="s-rad" x="520" y="160" width="50" height="40" rx="3" fill="#1b2029" stroke="#ee7d77" stroke-width="1.5"/>
      <text x="545" y="185" fill="#ee7d77" font-size="9" text-anchor="middle">Radiator</text>
      <text id="s-t-gh" x="575" y="240" fill="#a5abb9" font-size="11" text-anchor="middle">--°C</text>
      <circle id="s-pump" cx="200" cy="300" r="16" fill="#161a21" stroke="#6f7683" stroke-width="2"/>
      <text x="200" y="304" fill="#a5abb9" font-size="10" text-anchor="middle">P</text>
      <g id="pipe-solar" opacity="0.3">
        <path d="M250,260 L200,260 L200,284" stroke="#42a5f5" stroke-width="3" fill="none"/>
        <text x="225" y="255" fill="#42a5f5" font-size="8">VI-btm</text>
        <path d="M200,316 L200,340 L80,340 L80,220" stroke="#42a5f5" stroke-width="3" fill="none"/>
        <text x="140" y="355" fill="#42a5f5" font-size="8">VO-coll</text>
        <path d="M80,40 L80,20 L340,20 L340,48" stroke="#ee7d77" stroke-width="3" fill="none"/>
        <text x="170" y="16" fill="#ee7d77" font-size="8">V-ret → reservoir</text>
      </g>
      <g id="pipe-heating" opacity="0.3">
        <path d="M365,76 L365,90 L370,90 L370,284" stroke="#ee7d77" stroke-width="3" fill="none"/>
        <text x="392" y="90" fill="#ee7d77" font-size="8">via reservoir</text>
        <path d="M370,316 L370,340 L520,340 L520,200" stroke="#ee7d77" stroke-width="3" fill="none"/>
        <text x="440" y="355" fill="#ee7d77" font-size="8">VO-rad</text>
        <path d="M570,200 L570,370 L290,370 L290,260" stroke="#42a5f5" stroke-width="3" fill="none"/>
        <text x="430" y="385" fill="#42a5f5" font-size="8">return → tank bottom</text>
      </g>
      <g id="pipe-drain" opacity="0.3">
        <path d="M80,220 L80,284" stroke="#dab53d" stroke-width="3" fill="none"/>
        <text x="65" y="255" fill="#dab53d" font-size="8" transform="rotate(-90,65,255)">VI-coll</text>
        <path d="M80,316 L80,370 L250,370 L250,260" stroke="#dab53d" stroke-width="3" fill="none"/>
        <text x="165" y="385" fill="#dab53d" font-size="8">VO-tank</text>
        <path d="M110,40 L130,15" stroke="#dab53d" stroke-width="2" fill="none" stroke-dasharray="4,2"/>
        <text x="135" y="12" fill="#dab53d" font-size="8">V-air (open)</text>
      </g>
      <text id="s-t-out" x="15" y="390" fill="#a5abb9" font-size="11">Outdoor: --°C</text>
      <text id="s-fan" x="580" y="170" fill="#424854" font-size="10">Fan: OFF</text>
      <rect id="s-heater" x="590" y="200" width="40" height="20" rx="2" fill="none" stroke="#424854" stroke-width="1"/>
      <text x="610" y="214" fill="#a5abb9" font-size="8" text-anchor="middle">2kW</text>
    </svg>
  `;
}

function updateSchematic(state, result) {
  // Use the live state passed in by updateDisplay so the schematic
  // reflects real sensor readings in live mode. Fall back to the
  // simulation model for the initial render before any state arrives.
  const s = state || (model && model.getState ? model.getState() : {});
  const tempLabel = function (v) { return isNum(v) ? v.toFixed(1) + '°C' : TEMP_PLACEHOLDER + '°C'; };
  setText('s-t-top', tempLabel(s.t_tank_top));
  setText('s-t-bot', tempLabel(s.t_tank_bottom));
  setText('s-t-coll', tempLabel(s.t_collector));
  setText('s-t-gh', tempLabel(s.t_greenhouse));
  setText('s-t-out', 'Outdoor: ' + tempLabel(s.t_outdoor));

  // Irradiance is only available in simulation mode (no sensor on the device).
  const sun = document.getElementById('s-sun');
  if (isNum(s.irradiance)) {
    setText('s-irr', s.irradiance + ' W/m²');
    if (sun) sun.setAttribute('opacity', Math.min(s.irradiance / 800, 1).toFixed(2));
  } else {
    setText('s-irr', TEMP_PLACEHOLDER + ' W/m²');
    if (sun) sun.setAttribute('opacity', '0.3');
  }

  const mode = result.mode;
  setOpacity('pipe-solar', mode === 'solar_charging' ? 1 : 0.15);
  setOpacity('pipe-heating', mode === 'greenhouse_heating' ? 1 : 0.15);
  setOpacity('pipe-drain', (mode === 'active_drain' || mode === 'overheat_drain') ? 1 : 0.15);

  const pump = document.getElementById('s-pump');
  if (pump) {
    pump.setAttribute('fill', result.actuators.pump ? 'rgba(67,174,164,0.2)' : '#161a21');
    pump.setAttribute('stroke', result.actuators.pump ? '#43aea4' : '#6f7683');
  }

  setText('s-fan', 'Fan: ' + (result.actuators.fan ? 'ON' : 'OFF'));
  const fanEl = document.getElementById('s-fan');
  if (fanEl) fanEl.setAttribute('fill', result.actuators.fan ? '#43aea4' : '#424854');

  const heater = document.getElementById('s-heater');
  if (heater) heater.setAttribute('stroke', result.actuators.space_heater ? '#ee7d77' : '#424854');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}
function setOpacity(id, val) {
  const el = document.getElementById(id);
  if (el) el.setAttribute('opacity', val);
}

// ── Device Config UI ──
let deviceConfigData = null;

function initDeviceConfig() {
  // Toggle buttons (exclude relay override toggles — they have their own handlers)
  document.querySelectorAll('.device-toggle:not(#override-suppress-safety)').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('active'));
  });

  // Save button
  document.getElementById('dc-save').addEventListener('click', saveDeviceConfig);

  // "Try anyway" link
  var tryLink = document.getElementById('dc-try-anyway');
  if (tryLink) {
    tryLink.addEventListener('click', function (e) {
      e.preventDefault();
      saveDeviceConfig();
    });
  }

  // Load on first view
  loadDeviceConfig();
}

function loadDeviceConfig() {
  const loading = document.getElementById('device-config-loading');
  const form = document.getElementById('device-config-form');
  loading.style.display = '';
  form.style.display = 'none';

  fetch('/api/device-config')
    .then(r => r.json())
    .then(cfg => {
      deviceConfigData = cfg;
      populateDeviceForm(cfg);
      loading.style.display = 'none';
      form.style.display = '';
    })
    .catch(err => {
      loading.textContent = 'Failed to load config: ' + err.message;
    });
}

function populateDeviceForm(cfg) {
  // Controls enabled toggle
  setToggle('dc-ce', cfg.ce);

  // Actuator bitmask toggles
  const ea = cfg.ea || 0;
  setToggle('dc-ea-v', !!(ea & 1));
  setToggle('dc-ea-p', !!(ea & 2));
  setToggle('dc-ea-f', !!(ea & 4));
  setToggle('dc-ea-sh', !!(ea & 8));
  setToggle('dc-ea-ih', !!(ea & 16));

  // Forced mode
  document.getElementById('dc-fm').value = cfg.fm || '';

  // Allowed modes
  const allCodes = ['I', 'SC', 'GH', 'AD', 'EH'];
  const am = cfg.am; // null = all allowed
  allCodes.forEach(code => {
    const cb = document.getElementById('dc-am-' + code);
    if (cb) cb.checked = !am || am.indexOf(code) >= 0;
  });

  // Version & size
  document.getElementById('dc-version').textContent = cfg.v || '-';
  document.getElementById('dc-size').textContent = JSON.stringify(cfg).length;
}

function setToggle(id, on) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle('active', on);
}

function saveDeviceConfig() {
  const status = document.getElementById('dc-status');
  status.textContent = 'Saving...';
  status.style.color = 'var(--on-surface-variant)';

  // Read form state
  const ce = document.getElementById('dc-ce').classList.contains('active');
  let ea = 0;
  if (document.getElementById('dc-ea-v').classList.contains('active')) ea |= 1;
  if (document.getElementById('dc-ea-p').classList.contains('active')) ea |= 2;
  if (document.getElementById('dc-ea-f').classList.contains('active')) ea |= 4;
  if (document.getElementById('dc-ea-sh').classList.contains('active')) ea |= 8;
  if (document.getElementById('dc-ea-ih').classList.contains('active')) ea |= 16;

  const fmSelect = document.getElementById('dc-fm');
  const fm = fmSelect.value || null;

  // Allowed modes: null if all checked, array of codes otherwise
  const allCodes = ['I', 'SC', 'GH', 'AD', 'EH'];
  const checked = allCodes.filter(c => document.getElementById('dc-am-' + c).checked);
  const am = checked.length >= 5 ? null : (checked.length === 0 ? null : checked);

  const body = { ce, ea, fm, am };

  fetch('/api/device-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(cfg => {
      deviceConfigData = cfg;
      document.getElementById('dc-version').textContent = cfg.v;
      document.getElementById('dc-size').textContent = JSON.stringify(cfg).length;
      status.textContent = 'Saved (v' + cfg.v + ')';
      status.style.color = 'var(--secondary)';
      setTimeout(() => { status.textContent = ''; }, 3000);
    })
    .catch(err => {
      status.textContent = 'Error: ' + err.message;
      status.style.color = 'var(--error)';
    });
}

// ── Relay Toggle Board ──
let overrideActive = false;
let overrideExpiresAt = 0;
let overrideCountdownTimer = null;
let relayPendingState = {}; // relay → expected state (for reconciliation)
let relayPendingTimers = {}; // relay → timeout ID
// Last known controls_enabled value from any state message — used for
// optimistic re-enable of the Enter button after Exit Override, so the
// user doesn't wait up to 30s for the next Shelly state broadcast.
let lastControlsEnabled = false;

function initRelayBoard() {
  // Enter override
  document.getElementById('override-enter-btn').addEventListener('click', enterOverride);

  // Exit override
  document.getElementById('override-exit-btn').addEventListener('click', exitOverride);

  // Suppress safety toggle
  document.getElementById('override-suppress-safety').addEventListener('click', function () {
    this.classList.toggle('active');
  });

  // TTL buttons
  document.querySelectorAll('.ttl-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.ttl-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      if (overrideActive) updateOverrideTtl(parseInt(this.dataset.ttl, 10));
    });
  });

  // Relay buttons
  document.querySelectorAll('.relay-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      if (this.disabled || !overrideActive) return;
      toggleRelay(this);
    });
  });

  // Command response handler
  if (liveSource) {
    liveSource.onCommandResponse(handleOverrideResponse);
  }
}

var overrideAckTimer = null;

function enterOverride() {
  if (!liveSource) return;
  var btn = document.getElementById('override-enter-btn');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  var ss = document.getElementById('override-suppress-safety').classList.contains('active');
  var activeTtlBtn = document.querySelector('.ttl-btn.active');
  var ttl = activeTtlBtn ? parseInt(activeTtlBtn.dataset.ttl, 10) : 300;
  var sent = liveSource.sendCommand({ type: 'override-enter', ttl: ttl, suppressSafety: ss });

  if (!sent) {
    btn.disabled = false;
    btn.textContent = 'Enter Manual Override';
    showOverrideMsg('WebSocket not connected.', 'var(--error)');
    return;
  }

  // Timeout if no ack received
  clearTimeout(overrideAckTimer);
  overrideAckTimer = setTimeout(function () {
    if (!overrideActive) {
      btn.disabled = false;
      btn.textContent = 'Enter Manual Override';
      showOverrideMsg('No response from server. Is the controller reachable?', 'var(--error)');
    }
  }, 5000);
}

function showOverrideMsg(text, color) {
  var el = document.getElementById('override-expired-msg');
  el.textContent = text;
  el.style.color = color || 'var(--on-surface-variant)';
  el.style.display = '';
  setTimeout(function () { el.style.display = 'none'; }, 6000);
}

function exitOverride() {
  if (!liveSource) return;
  liveSource.sendCommand({ type: 'override-exit' });
}

function updateOverrideTtl(ttl) {
  if (!liveSource || !overrideActive) return;
  liveSource.sendCommand({ type: 'override-update', ttl: ttl });
}

function handleOverrideResponse(msg) {
  clearTimeout(overrideAckTimer);
  if (msg.type === 'override-ack') {
    if (msg.active) {
      activateOverrideUI(msg.expiresAt, msg.suppressSafety);
    } else {
      deactivateOverrideUI();
    }
  } else if (msg.type === 'override-error') {
    // Restore enter button
    var btn = document.getElementById('override-enter-btn');
    btn.disabled = false;
    btn.textContent = 'Enter Manual Override';
    showOverrideMsg(msg.message, 'var(--error)');
  }
}

function activateOverrideUI(expiresAt, suppressSafety) {
  overrideActive = true;
  overrideExpiresAt = expiresAt;
  document.getElementById('override-entry').style.display = 'none';
  document.getElementById('override-active-header').style.display = '';
  document.getElementById('relay-board').style.display = '';
  document.getElementById('override-expired-msg').style.display = 'none';
  document.querySelectorAll('.relay-btn').forEach(btn => { btn.disabled = false; });
  startCountdown();
}

function deactivateOverrideUI(msg) {
  overrideActive = false;
  overrideExpiresAt = 0;
  clearCountdown();
  document.getElementById('override-entry').style.display = '';
  document.getElementById('override-active-header').style.display = 'none';
  document.getElementById('relay-board').style.display = 'none';
  document.querySelectorAll('.relay-btn').forEach(btn => {
    btn.disabled = true;
    btn.classList.remove('on', 'relay-btn--pending', 'relay-btn--error');
  });
  relayPendingState = {};
  for (var k in relayPendingTimers) clearTimeout(relayPendingTimers[k]);
  relayPendingTimers = {};
  // Reset the Enter button so the user doesn't see a stale "Connecting..."
  // and doesn't have to wait ~30s for the next state broadcast to recover.
  var enterBtn = document.getElementById('override-enter-btn');
  enterBtn.textContent = 'Enter Manual Override';
  enterBtn.disabled = !lastControlsEnabled;
  var gateMsg = document.getElementById('override-gate-msg');
  if (gateMsg) gateMsg.style.display = lastControlsEnabled ? 'none' : 'block';
  if (msg) {
    var expEl = document.getElementById('override-expired-msg');
    expEl.textContent = msg;
    expEl.style.display = '';
    expEl.style.color = 'var(--on-surface-variant)';
    setTimeout(() => { expEl.style.display = 'none'; }, 5000);
  }
}

function startCountdown() {
  clearCountdown();
  updateCountdownDisplay();
  overrideCountdownTimer = setInterval(updateCountdownDisplay, 1000);
}

function clearCountdown() {
  if (overrideCountdownTimer) { clearInterval(overrideCountdownTimer); overrideCountdownTimer = null; }
}

function updateCountdownDisplay() {
  var remaining = Math.max(0, overrideExpiresAt - Math.floor(Date.now() / 1000));
  var min = Math.floor(remaining / 60);
  var sec = remaining % 60;
  document.getElementById('override-countdown').textContent = min + ':' + (sec < 10 ? '0' : '') + sec;
  if (remaining <= 0 && overrideActive) {
    deactivateOverrideUI('Override expired — automation resumed.');
  }
}

function toggleRelay(btn) {
  var relay = btn.dataset.relay;
  var currentlyOn = btn.classList.contains('on');
  var newState = !currentlyOn;

  // Optimistic UI + haptic feedback
  btn.classList.toggle('on', newState);
  btn.classList.add('relay-btn--pending');
  try { if (navigator.vibrate) navigator.vibrate(50); } catch (e) {}

  // Send command
  if (liveSource) liveSource.sendCommand({ type: 'relay-command', relay: relay, on: newState });

  // Track pending state for reconciliation
  relayPendingState[relay] = newState;
  if (relayPendingTimers[relay]) clearTimeout(relayPendingTimers[relay]);
  relayPendingTimers[relay] = setTimeout(function () {
    // Reconciliation timeout — if state hasn't been confirmed, revert
    delete relayPendingState[relay];
    delete relayPendingTimers[relay];
    btn.classList.remove('relay-btn--pending');
    // Don't revert — next state broadcast will reconcile
  }, 2000);
}

function updateRelayBoard(result) {
  if (!result) return;
  var mo = result.manual_override;
  // Update last-known controls_enabled FIRST so deactivateOverrideUI()
  // can use the fresh value for its optimistic re-enable.
  lastControlsEnabled = !!result.controls_enabled;

  // Handle override state from server
  if (mo && mo.active && !overrideActive) {
    // Override started externally or on reconnect
    activateOverrideUI(mo.expiresAt, mo.suppressSafety);
  } else if ((!mo || !mo.active) && overrideActive) {
    // Override ended externally
    deactivateOverrideUI('Override ended — automation resumed.');
    return;
  } else if (mo && mo.active && overrideActive) {
    // Update expiry (may have been adjusted)
    overrideExpiresAt = mo.expiresAt;
  }

  // Update controls-enabled gate
  var ceEnabled = lastControlsEnabled;
  var enterBtn = document.getElementById('override-enter-btn');
  var gateMsg = document.getElementById('override-gate-msg');
  if (!overrideActive) {
    enterBtn.disabled = !ceEnabled;
    gateMsg.style.display = ceEnabled ? 'none' : 'block';
  }

  // ce=false during active override → force deactivate
  if (overrideActive && !ceEnabled) {
    deactivateOverrideUI('Controls disabled — override ended.');
    return;
  }

  if (!overrideActive) return;

  // Update relay button states from actual hardware state
  var valves = result.valves || {};
  var actuators = result.actuators || {};
  document.querySelectorAll('.relay-btn').forEach(btn => {
    var relay = btn.dataset.relay;
    var actual = (relay === 'pump' || relay === 'fan')
      ? !!actuators[relay]
      : !!valves[relay];

    // Reconcile with pending state
    if (relay in relayPendingState) {
      if (relayPendingState[relay] === actual) {
        // Confirmed — clear pending
        delete relayPendingState[relay];
        if (relayPendingTimers[relay]) { clearTimeout(relayPendingTimers[relay]); delete relayPendingTimers[relay]; }
        btn.classList.remove('relay-btn--pending');
      } else {
        // State doesn't match — command may have failed
        // Revert optimistic update
        delete relayPendingState[relay];
        if (relayPendingTimers[relay]) { clearTimeout(relayPendingTimers[relay]); delete relayPendingTimers[relay]; }
        btn.classList.remove('relay-btn--pending');
        btn.classList.add('relay-btn--error');
        setTimeout(() => btn.classList.remove('relay-btn--error'), 400);
      }
    }

    btn.classList.toggle('on', actual);
  });
}

init();
