import { loadSystemYaml } from './yaml-loader.js';
import { ThermalModel, tankStoredEnergyKwh } from './physics.js';
import { ControlStateMachine, initControlLogic } from './control.js';
import { load as loadControlLogic } from './control-logic-loader.js';
import { createSlider, formatTime, pickTickStep, formatTick, pickBucketSize } from './ui.js';
import { LiveSource, SimulationSource } from './data-source.js';
import { startVersionCheck, triggerVersionCheck } from './version-check.js';
import { initSensorsView, destroySensorsView } from './sensors.js';
import { store, derived } from './app-state.js';
import { initSubscriptions, setViewLifecycle } from './subscriptions.js';
import { initNavigation } from './actions/navigation.js';
import { attachScriptStatusWebSocket, renderScriptCrashBanner } from './actions/script-monitor.js';
import { mountCrashesView } from './crashes-view.js';
import { initAuth } from './auth.js';
import { captureInstallPrompt, triggerInstall, wireInstallModal, initNotifications, subscribePush, updateCategories, unsubscribePush, isSubscribed, getSelectedCategories, sendTest } from './notifications.js';
import { buildSchematic as buildSchematicFromSvg } from './schematic.js';
import { SIM_START_HOUR, getDayNightEnv } from './sim-bootstrap.js';
import {
  formatClockTime, formatCauseLabel, formatReasonLabel,
  formatSensorsLine, formatFullTimeHelsinki, escapeHtml,
} from './main/time-format.js';
import {
  initWatchdogUI, attachWatchdogWebSocket,
  renderModeEnablement, getWatchdogSnapshot,
} from './main/watchdog-ui.js';
import { initRelayBoard, updateRelayBoard } from './main/relay-board.js';
import { initDeviceConfig } from './main/device-config.js';
import { drawHistoryGraph, tankAvgOf, toSchematicState } from './main/history-graph.js';
import {
  transitionLog, fetchLiveEvents, detectLiveTransition, renderLogsList,
  setupLogsScrollLoader, setupCopyLogsButton, resetEventsState,
} from './main/logs.js';
import {
  initBalanceCard, fetchBalanceHistory, appendBalanceLivePoint,
  renderBalanceCard, getLiveYesterdayHigh, resetLiveYesterdayHigh,
} from './main/balance-card.js';
import { setupInspector } from './main/graph-inspector.js';
import {
  fetchLiveHistory, getLiveHistoryData, clearLiveHistoryData,
  recordLiveHistoryPoint,
} from './main/live-history.js';
import {
  updateDisplay, rerenderWithHistoryFallback,
  setSchematicHandle, getLastFrame,
  setLiveFrameSeen, resetYesterdayTracking,
} from './main/display-update.js';
// Expose for e2e testing
window.__triggerVersionCheck = triggerVersionCheck;

// ── Data Source ──
// Detect deployment context: GitHub Pages = simulation only, deployed app = live capable
// `window.__simulateGitHubPagesDeploy` is a test-only hatch (set via
// Playwright's addInitScript) — it lets the e2e suite exercise the
// pages-mode auto-bootstrap path without needing a real github.io URL.
const isGitHubPages = window.__simulateGitHubPagesDeploy === true
  || location.hostname.endsWith('.github.io');
const isLocalhost = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
const isLiveCapable = !isGitHubPages;
const urlModePreference = new URLSearchParams(location.search).get('mode'); // 'sim' | 'live' | null
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
  // Respect URL mode preference, default to live on deployed app
  if (urlModePreference === 'sim') {
    switchToSimulation();
  } else {
    switchToLive();
  }

  sw.addEventListener('click', function () {
    if (store.get('phase') === 'live') {
      switchToSimulation();
    } else {
      switchToLive();
    }
  });
}

function persistModeInUrl(mode) {
  var params = new URLSearchParams(location.search);
  if (mode === 'live') {
    params.delete('mode');
  } else {
    params.set('mode', mode);
  }
  var qs = params.toString();
  var url = location.pathname + (qs ? '?' + qs : '') + location.hash;
  history.replaceState(null, '', url);
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
      setLiveFrameSeen(true);
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
    // Re-attach the watchdog broadcast listener now that liveSource exists.
    attachWatchdogWebSocket();
    attachScriptStatusWebSocket(liveSource);
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
  persistModeInUrl('live');
  ensureLiveSource();
  running = false;
  fetchLiveHistory(graphRange);
  fetchLiveEvents(null);
  fetchBalanceHistory();
  startStalenessTimer();
  clearLiveDisplay();
  updateConnectionUI('disconnected');
  updateSidebarSubtitle();
  updatePhaseAwareCopy();
}

function clearLiveDisplay() {
  // Reset display to placeholder values — never show simulation defaults in live mode
  setLiveFrameSeen(false);
  document.getElementById('mode-card-title').textContent = '--';
  document.getElementById('mode-card-status').innerHTML = '';
  document.getElementById('tank-temp-val').textContent = '--';
  document.getElementById('tank-temp-status').textContent = '';
  document.getElementById('tank-temp-message').textContent = '';
  document.getElementById('tank-stat-energy').textContent = '--';
  document.getElementById('tank-stat-greenhouse').textContent = '--';
  var ghTrendResetEl = document.getElementById('tank-stat-greenhouse-trend');
  if (ghTrendResetEl) ghTrendResetEl.innerHTML = '';
  document.getElementById('inactive-modes').innerHTML = '';
  resetLiveYesterdayHigh();
  document.getElementById('graph-peak-label').textContent = "Yesterday's High: --";
  var arc = document.getElementById('tank-gauge-arc');
  if (arc) arc.setAttribute('stroke-dashoffset', '628');
  // Clear component statuses
  var compEls = document.querySelectorAll('.comp-status');
  compEls.forEach(function(el) { el.textContent = '--'; });
  // Clear simulation graph data and redraw empty canvas
  timeSeriesStore.reset();
  drawHistoryGraph();
  // Clear the transition log — fetchLiveEvents() will repopulate it from the DB
  transitionLog.length = 0;
  resetEventsState();
  var logsEl = document.getElementById('logs-list');
  if (logsEl) {
    logsEl.innerHTML = '<div data-empty="true" style="color:var(--on-surface-variant);font-size:13px;">Loading transitions…</div>';
  }
}

function switchToSimulation() {
  store.set('phase', 'simulation');
  updateModeToggleUI(false);
  persistModeInUrl('sim');
  if (liveSource) liveSource.stop();
  updateConnectionUI('disconnected');
  clearLiveHistoryData();
  balanceHistory = null;
  balanceLivePoints = [];
  balanceLiveEvents = [];
  balanceLiveLastMode = null;
  resetLiveYesterdayHigh();
  renderBalanceCard();
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
export let model = null;
let controller = null;
export let running = false;
let lastFrame = 0;
let simSpeed = 3000;
let simTimeAccum = 0;

// schematicHandle, lastState, lastResult, liveFrameSeen,
// yesterdayHigh/confirmedYesterdayHigh/lastDay moved to
// ./main/display-update.js. liveYesterdayHigh moved to
// ./main/balance-card.js.
const DT = 1;
export let graphRange = 86400; // default 24h
// Graph "All sensors" toggle — when true, the Tank Top and Tank Bottom
// individual lines are drawn alongside the tank average and their
// legend / inspector rows become visible. Off by default.
export let showAllSensors = false;


// ── Time Series Store (extended with mode tracking) ──
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

// ── Transition log / events state moved to ./main/logs.js ──

// ── Scenario presets ──
const PRESETS = {
  spring_fall:   { label: 'Spring / Fall',      t_outdoor: 10,   irradiance: 500, t_tank_top: 12, t_tank_bottom: 9,  t_greenhouse: 11, gh_thermal_mass: 250000, gh_heat_loss: 100 },
  summer_peak:   { label: 'Summer Peak Heat',   t_outdoor: 26,   irradiance: 500, t_tank_top: 88, t_tank_bottom: 85, t_greenhouse: 11, gh_thermal_mass: 250000, gh_heat_loss: 100 },
  early_late:    { label: 'Late / Early Season', t_outdoor: -5.5, irradiance: 240, t_tank_top: 13, t_tank_bottom: 13, t_greenhouse: 5,  gh_thermal_mass: 250000, gh_heat_loss: 100 },
};

// ── Input parameters ──
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

// ── Mode metadata ──
export const MODE_INFO = {
  idle: { label: 'Idle', desc: 'System waiting for triggers.', icon: 'mode_night', iconFill: false },
  solar_charging: { label: 'Collecting Solar Energy', desc: 'Optimal photon absorption in progress.', icon: 'wb_sunny', iconFill: true },
  greenhouse_heating: { label: 'Heating Greenhouse', desc: 'Thermal redirection active.', icon: 'nest_eco_leaf', iconFill: false },
  active_drain: { label: 'Active Drain', desc: 'Freeze protection draining collectors.', icon: 'water_drop', iconFill: false },
  overheat_drain: { label: 'Overheat Drain', desc: 'Draining to prevent overheating.', icon: 'warning', iconFill: false },
  emergency_heating: { label: 'Emergency Heating', desc: 'Space heater active — tank too cold.', icon: 'local_fire_department', iconFill: true },
};

// ── PWA + Notification UI wiring ──
// The install button is always visible; when beforeinstallprompt is not
// available (Safari/Firefox) the handler shows a platform-specific
// instructions modal. The notifications section is also always visible;
// if push isn't supported the toggle stays disabled with an explanation.

function wireNotificationUI() {
  wireInstallModal();

  var installBtn = document.getElementById('pwa-install-btn');
  if (installBtn) {
    installBtn.addEventListener('click', function () {
      triggerInstall();
    });
  }

  var toggleBtn = document.getElementById('notif-toggle-btn');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      if (toggleBtn.disabled) return;
      if (isSubscribed()) {
        unsubscribePush();
      } else {
        var cats = getSelectedCategories();
        subscribePush(cats);
      }
    });
  }

  // Category checkboxes — update server on change
  var checkboxes = document.querySelectorAll('[id^="notif-cat-"]');
  checkboxes.forEach(function (cb) {
    cb.addEventListener('change', function () {
      if (isSubscribed()) {
        updateCategories(getSelectedCategories());
      }
    });
  });

  // Per-category test buttons — send a mock notification of the
  // selected category to this device's subscription.
  var testButtons = document.querySelectorAll('[data-test-category]');
  testButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.disabled) return;
      if (!isSubscribed()) {
        flashTestBtn(btn, 'error');
        return;
      }
      var category = btn.dataset.testCategory;
      btn.disabled = true;
      sendTest(category).then(function (ok) {
        flashTestBtn(btn, ok ? 'sent' : 'error');
      }).catch(function () {
        flashTestBtn(btn, 'error');
      });
    });
  });
}

function flashTestBtn(btn, state) {
  btn.dataset.testing = state;
  setTimeout(function () {
    btn.dataset.testing = '';
    btn.disabled = false;
  }, state === 'sent' ? 1500 : 2500);
}

// ── Init ──
async function init() {
  try {
    config = await loadSystemYaml('../system.yaml');
  } catch {
    config = buildFallbackConfig();
  }

  await initControlLogic();
  model = new ThermalModel({
    greenhouse_thermal_mass: params.gh_thermal_mass,
    greenhouse_UA: params.gh_heat_loss,
  });
  controller = new ControlStateMachine(config.modes);

  // Set up view lifecycle callbacks for the store-driven navigation.
  // Sensor discovery UI lives inside the merged Device view, so it mounts
  // when currentView === 'device'.
  setViewLifecycle({
    device: {
      mount: (container, s) => {
        initSensorsView();
        return () => destroySensorsView();
      }
    },
    crashes: {
      mount: () => mountCrashesView()
    }
  });

  // Initialize store subscriptions (nav, overlays, indicators)
  initSubscriptions(store);

  // Initialize hash-based navigation via store
  initNavigation(store);

  setupControls();
  setupTimeRangePills();
  setupAllSensorsToggle();
  setupFAB();
  resetSim();
  // Schematic view — async build, handle held in display-update module.
  (async () => {
    try {
      const handle = await buildSchematicFromSvg({
        container: document.getElementById('schematic'),
        svgUrl: './assets/system-topology.svg',
      });
      setSchematicHandle(handle);
      // If a result is already available, apply it immediately
      const last = getLastFrame();
      if (last.state && last.result) {
        handle.update(toSchematicState(last.state, last.result));
      }
    } catch (err) {
      console.error('[schematic] build failed:', err);
      const el = document.getElementById('schematic');
      if (el) el.textContent = 'Failed to load schematic';
    }
  })();
  setupInspector();
  setupLogsScrollLoader();
  setupCopyLogsButton();
  initBalanceCard({ onRerender: rerenderWithHistoryFallback });
  updateDisplay(model.getState(), { mode: 'idle', valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false }, actuators: { pump: false, fan: false, space_heater: false }, transition: null });

  // Initialize live/simulation mode toggle
  initModeToggle();
  initDeviceConfig();
  initRelayBoard({ getLiveSource: () => liveSource });
  initWatchdogUI({ getLiveSource: () => liveSource });

  // On deploys without live mode (e.g. GitHub Pages) load the
  // pre-baked simulation snapshot so the dashboard is populated on
  // first paint instead of empty. The snapshot is generated at build
  // time by `scripts/generate-bootstrap-history.mjs` and a drift test
  // in `tests/bootstrap-history-drift.test.js` ensures it stays in
  // sync with the current control logic + thermal model.
  if (!isLiveCapable) {
    // Fire-and-forget — async fetch + render. init() doesn't await it
    // so the rest of the page stays interactive.
    loadBootstrapSnapshotAndAutoStart();
  }

  // Initialize auth UI (logout + invite buttons) — noop when auth disabled
  initAuth();

  // PWA install prompt capture (must be early, before beforeinstallprompt fires)
  captureInstallPrompt();

  // Initialize push notifications (service worker, VAPID key, existing subscription)
  initNotifications().then(function () {
    wireNotificationUI();
  });

  // Start polling for JS source updates
  startVersionCheck();
}

function buildFallbackConfig() {
  return {
    modes: {
      idle: { description: 'Default', valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'OFF', fan: 'OFF' } },
      solar_charging: { description: 'Solar charging', trigger: 't_collector > t_tank_bottom + 7', exit: 't_collector < t_tank_bottom + 3', valve_states: { vi_btm: 'OPEN', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'OPEN', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'ON', fan: 'OFF' } },
      greenhouse_heating: { description: 'Greenhouse heating', trigger: 't_greenhouse < 10 AND t_tank_top > 25', exit: 't_greenhouse > 12', valve_states: { vi_btm: 'CLOSED', vi_top: 'OPEN', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'OPEN', vo_tank: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'ON', fan: 'ON' } },
      active_drain: { description: 'Active drain', trigger: 't_outdoor < 2', exit: null, valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'OPEN', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'OPEN', v_air: 'OPEN' }, actuators: { pump: 'ON', fan: 'OFF' } },
      overheat_drain: { description: 'Overheat drain', trigger: 't_tank_top > 85', exit: null, valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'OPEN', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'OPEN', v_air: 'OPEN' }, actuators: { pump: 'ON', fan: 'OFF' } },
      emergency_heating: { description: 'Emergency', trigger: 't_greenhouse < 5 AND t_tank_top < 25', exit: 't_greenhouse > 8', valve_states: { vi_btm: 'CLOSED', vi_top: 'CLOSED', vi_coll: 'CLOSED', vo_coll: 'CLOSED', vo_rad: 'CLOSED', vo_tank: 'CLOSED', v_air: 'CLOSED' }, actuators: { pump: 'OFF', fan: 'OFF', space_heater: 'ON' } },
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

function setupAllSensorsToggle() {
  // Reuse the same pill-switch component the mode-toggle uses. The switch
  // itself (#graph-show-all-sensors) is a <div> whose `.active` class drives
  // the visual + aria state; the surrounding container (-toggle) captures
  // clicks on both the label text and the switch.
  const sw = document.getElementById('graph-show-all-sensors');
  const container = document.getElementById('graph-show-all-sensors-toggle');
  if (!sw || !container) return;

  const render = () => {
    sw.classList.toggle('active', showAllSensors);
    sw.setAttribute('aria-checked', showAllSensors ? 'true' : 'false');
  };
  const toggle = () => {
    showAllSensors = !showAllSensors;
    render();
    applyAllSensorsVisibility();
    drawHistoryGraph();
  };

  render();
  applyAllSensorsVisibility();
  container.addEventListener('click', toggle);
  sw.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
  });
}

function applyAllSensorsVisibility() {
  const display = showAllSensors ? '' : 'none';
  document.querySelectorAll('.sensor-detail').forEach((el) => {
    el.style.display = display;
  });
}

// ── Controls ──
const liveStateKeys = { t_tank_top: 't_tank_top', t_tank_bottom: 't_tank_bottom', t_greenhouse: 't_greenhouse' };

const sliderRefs = {};

function setupControls() {
  const el = document.getElementById('controls');
  const sliders = [
    { id: 'outdoor', label: 'Outdoor Temp', min: -30, max: 40, step: 2, value: params.t_outdoor, unit: '°C', key: 't_outdoor' },
    { id: 'irradiance', label: 'Solar Irradiance', min: 0, max: 1000, step: 50, value: params.irradiance, unit: ' W/m²', key: 'irradiance' },
    { id: 'tank-top', label: 'Tank Top', min: 5, max: 95, step: 5, value: params.t_tank_top, unit: '°C', key: 't_tank_top' },
    { id: 'tank-bot', label: 'Tank Bottom', min: 5, max: 95, step: 5, value: params.t_tank_bottom, unit: '°C', key: 't_tank_bottom' },
    { id: 'greenhouse', label: 'Greenhouse', min: -10, max: 40, step: 2, value: params.t_greenhouse, unit: '°C', key: 't_greenhouse' },
    { id: 'gh-thermal-mass', label: 'GH Thermal Mass', value: params.gh_thermal_mass, unit: ' J/K', key: 'gh_thermal_mass',
      steps: [10000, 25000, 50000, 100000, 250000, 500000] },
    { id: 'gh-heat-loss', label: 'GH Night Heat Loss', min: 5, max: 750, step: 25, value: params.gh_heat_loss, unit: ' W/K', key: 'gh_heat_loss' },
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
        // Physics params: push into model immediately
        if (model && s.key === 'gh_thermal_mass') model.p.greenhouse_thermal_mass = v;
        if (model && s.key === 'gh_heat_loss') model.p.greenhouse_UA = v;
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
  model.p.greenhouse_thermal_mass = params.gh_thermal_mass;
  model.p.greenhouse_UA = params.gh_heat_loss;
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
  resetYesterdayTracking();
  running = false;
  lastFrame = 0;
  simTimeAccum = 0;
  updateFABIcon();
  document.getElementById('sim-status-text').textContent = 'Ready — press play to start';
  updateSidebarSubtitle();
  updateDisplay(model.getState(), { mode: 'idle', valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false }, actuators: { pump: false, fan: false, space_heater: false }, transition: null });
}

// Restore the model + controller from a pre-baked snapshot. Used by
// the auto-bootstrap path on deploys where live mode is unavailable
// (GitHub Pages) — the snapshot is generated at build time by
// `scripts/generate-bootstrap-history.mjs` and lives at
// `playground/assets/bootstrap-history.json`. A drift test
// (`tests/bootstrap-history-drift.test.js`) ensures the snapshot is
// regenerated whenever the control logic or thermal model changes.
function restoreBootstrapSnapshot(snapshot) {
  // Re-init the model with default params, then overwrite the state
  // wholesale. Doing it via `model.reset()` plus direct assignment
  // (rather than constructing a new model) keeps the same instance
  // ref so simLoop keeps working.
  resetSim();

  const fms = snapshot.final_model_state;
  model.state.t_tank_top = fms.t_tank_top;
  model.state.t_tank_bottom = fms.t_tank_bottom;
  model.state.t_collector = fms.t_collector;
  model.state.t_greenhouse = fms.t_greenhouse;
  model.state.t_outdoor = fms.t_outdoor;
  model.state.irradiance = fms.irradiance;
  model.state.simTime = fms.simTime;

  const fcs = snapshot.final_controller_state;
  controller.currentMode = fcs.currentMode;
  controller.modeStartTime = fcs.modeStartTime;
  controller.collectorsDrained = fcs.collectorsDrained;
  controller.lastRefillAttempt = fcs.lastRefillAttempt;
  controller.emergencyHeatingActive = fcs.emergencyHeatingActive;
  controller.solarChargePeakTankTop = (fcs.solarChargePeakTankTop !== undefined)
    ? fcs.solarChargePeakTankTop
    : null;
  controller.solarChargePeakTankTopAt = fcs.solarChargePeakTankTopAt || 0;

  // Push the historical points + log entries into the UI stores.
  // resetSim() already cleared both, so we can just append.
  for (let i = 0; i < snapshot.points.length; i++) {
    const p = snapshot.points[i];
    timeSeriesStore.addPoint(p.time, p.values, p.mode);
  }
  for (let i = 0; i < snapshot.log_entries.length; i++) {
    transitionLog.unshift(snapshot.log_entries[i]);
  }
}

// Fetch the pre-baked bootstrap snapshot, restore it into the model,
// repaint the UI, and start the run loop. Used on deploys where live
// mode is unavailable so the user lands on a populated dashboard
// instead of an empty placeholder.
async function loadBootstrapSnapshotAndAutoStart() {
  let snapshot = null;
  try {
    const response = await fetch('./assets/bootstrap-history.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    snapshot = await response.json();
  } catch (err) {
    console.warn('[bootstrap] Failed to load bootstrap-history.json, starting empty:', err);
  }

  if (snapshot) {
    restoreBootstrapSnapshot(snapshot);
  }

  // Re-render with a synthesised idle result. togglePlay() immediately
  // steps the simLoop and overwrites this with a real result.
  const idleResult = {
    mode: (controller && controller.currentMode) || 'idle',
    actuators: { pump: false, fan: false, space_heater: false },
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    transition: null,
  };
  updateDisplay(model.getState(), idleResult);

  // Auto-start the run loop. togglePlay() preserves simTime since it's
  // non-zero after the snapshot restore, so our pre-rolled history is
  // kept. (And if the fetch failed, simTime is still 0 and togglePlay
  // will reset cleanly — the dashboard just starts with empty history.)
  togglePlay();
}

function applyPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;
  const keys = ['t_outdoor', 'irradiance', 't_tank_top', 't_tank_bottom', 't_greenhouse', 'gh_thermal_mass', 'gh_heat_loss'];
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
// SIM_START_HOUR + getDayNightEnv live in sim-bootstrap.js so the
// pre-baked snapshot generator and simLoop share one source of truth.

export function formatTimeOfDay(simSeconds) {
  const totalHours = SIM_START_HOUR + simSeconds / 3600;
  const h = Math.floor(totalHours % 24);
  const m = Math.floor((totalHours * 60) % 60);
  return h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0');
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
      transitionLog.unshift({ kind: 'sim', time: model.state.simTime, text: result.transition, mode: result.mode });
      // Prune sim entries older than 24h of simulated time
      const SIM_LOG_HORIZON = 86400; // 24h in seconds
      while (transitionLog.length > 0) {
        const oldest = transitionLog[transitionLog.length - 1];
        if (oldest.kind === 'sim' && (model.state.simTime - oldest.time) > SIM_LOG_HORIZON) {
          transitionLog.pop();
        } else {
          break;
        }
      }
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

}





init();
