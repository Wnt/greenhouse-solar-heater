// Connection state, live/sim mode switching, staleness + overlay rendering.

import { LiveSource } from '../data-source.js';
import { store } from '../app-state.js';
import { initSyncCoordinator } from '../sync/coordinator.js';
import { attachScriptStatusWebSocket } from '../actions/script-monitor.js';
import { graphRange, timeSeriesStore, running } from './state.js';
import { attachWatchdogWebSocket } from './watchdog-ui.js';
import { handleOverrideResponse, updateRelayBoard } from './relay-board.js';
import { updateDrainageControl } from './drainage-control.js';
import {
  updateDisplay, setLiveFrameSeen, rerenderWithHistoryFallback,
} from './display-update.js';
import { drawHistoryGraph } from './history-graph.js';
import { resetChartZoom } from './chart-pinch-zoom.js';
import {
  transitionLog, fetchLiveEvents, resetEventsState,
  registerLogsEventsSource,
} from './logs.js';
import {
  fetchBalanceHistory, renderBalanceCard,
  resetLiveYesterdayHigh, resetBalanceState,
  registerBalanceHistorySource,
} from './balance-card.js';
import {
  fetchLiveHistory, clearLiveHistoryData,
  registerLiveHistorySource,
} from './live-history.js';

// __simulateGitHubPagesDeploy is a Playwright test hatch — lets the
// e2e suite exercise pages-mode auto-bootstrap without a github.io URL.
const isGitHubPages = window.__simulateGitHubPagesDeploy === true
  || location.hostname.endsWith('.github.io');
const isLiveCapable = !isGitHubPages;
const urlModePreference = new URLSearchParams(location.search).get('mode');
store.set('isLiveCapable', isLiveCapable);

let liveSource = null;

let connectionStatus = 'disconnected';
let lastDataTime = 0;
let stalenessTimer = null;

let _setRunning = () => {};

export function getLiveSource() { return liveSource; }

export function initConnection({ setRunning } = {}) {
  if (typeof setRunning === 'function') _setRunning = setRunning;

  // Pre-auth runtime metadata. PR previews carry { pr, branch }; prod /
  // local dev carry null. Stash into the store so the toggle label and
  // sidebar subtitle render their preview branding on the first paint
  // after the fetch lands. Best-effort — a network failure leaves the
  // UI in its prod default (which is the safe fallback).
  fetch('/api/runtime', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      const preview = data && data.preview ? data.preview : null;
      store.set('runtimePreview', preview);
      if (preview) {
        updateModeToggleUI(store.get('phase') === 'live');
        updateSidebarSubtitle();
      }
    })
    .catch(function () { /* silent; prod default applies */ });

  // All three sources gate on phase==='live' so they're inert in sim
  // mode without an explicit deregister.
  registerLiveHistorySource(() => graphRange);
  registerBalanceHistorySource();
  registerLogsEventsSource();

  // Single repaint on the syncing edge collapses the old two-step
  // ("blur clears, then banner clears") into one transition.
  store.subscribe('syncing', function () {
    if (store.get('phase') !== 'live') return;
    refreshConnectionIndicator();
    updateConnectionOverlays();
    updateSidebarSubtitle();
    const banner = document.getElementById('staleness-banner');
    if (banner && store.get('syncing')) banner.classList.remove('visible');
  });

  // Reset live-frame flag on resume so stale lastState doesn't feed
  // wrong trend arrows until a new WS frame arrives. Re-render on
  // completion in case no WS frame has landed yet.
  initSyncCoordinator({
    onResyncStart: function () {
      if (store.get('phase') !== 'live') return;
      setLiveFrameSeen(false);
      // Reset the staleness clock so the banner doesn't briefly
      // re-flash 'stale' between syncing → active.
      lastDataTime = Date.now();
    },
    onResyncComplete: function () {
      if (store.get('phase') !== 'live') return;
      rerenderWithHistoryFallback();
      // Repaint the connection indicator + overlays now that
      // store.syncing has flipped back to false.
      refreshConnectionIndicator();
      updateConnectionOverlays();
      updateSidebarSubtitle();
    },
  });
}

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
    label.textContent = 'Reconnecting…';
    return;
  }

  const displayState = getConnectionDisplayState();
  switch (displayState) {
    case 'active':
      dot.className = 'connection-dot connected';
      label.textContent = 'Live';
      break;
    case 'syncing':
      dot.className = 'connection-dot reconnecting';
      label.textContent = 'Syncing…';
      break;
    case 'connecting':
      dot.className = 'connection-dot reconnecting';
      label.textContent = 'Connecting…';
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
    // Suppress the banner while a resync is in flight — the
    // unified syncing overlay already communicates the catch-up
    // state. Otherwise the banner would briefly show "stale" right
    // before fresh data arrives, repeating the old two-step UX.
    const syncing = !!store.get('syncing');
    const elapsed = Date.now() - lastDataTime;
    banner.classList.toggle(
      'visible',
      !syncing && elapsed > 60000 && lastDataTime > 0,
    );
  }
  refreshConnectionIndicator();
  updateConnectionOverlays();
  updateDevicePushState();
  updateSidebarSubtitle();
}

const OVERLAY_MESSAGES = {
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
  },
  // 'syncing' deliberately renders without the heavy
  // backdrop-blur copy block. It marks the overlays with
  // .connection-overlay--syncing instead, so style.css can apply a
  // light "Syncing…" pill while leaving the cards readable. This
  // gives a graceful fallback during the Android-resume re-fetch
  // instead of the old fully-blurred + banner combo.
  syncing: { title: '', subtitle: '', light: true }
};

function getConnectionDisplayState() {
  if (store.get('phase') !== 'live') return 'active';
  // A resync is in flight (Android resume / network recovery / focus).
  // Surface as a single 'syncing' state so the overlay + banner
  // unify into one transition. Cleared by onResyncComplete via
  // store.syncing → false.
  if (store.get('syncing')) return 'syncing';
  const hasData = liveSource && liveSource.hasReceivedData;
  const mqttStatus = liveSource ? liveSource.mqttStatus : 'unknown';

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
    const connectedAt = liveSource ? liveSource._connectedAt : 0;
    if (connectedAt > 0 && (Date.now() - connectedAt) > 2000) {
      return 'device_offline';
    }
    return 'connecting';
  }

  // WS is not connected or reconnecting
  const wsEverFailed = liveSource && liveSource._wsEverFailed;
  if (!hasData) return wsEverFailed ? 'never_connected' : 'connecting';
  return 'disconnected';
}

function updateConnectionOverlays() {
  const state = getConnectionDisplayState();
  const overlayIds = ['overlay-modes', 'overlay-gauge', 'overlay-components'];
  const msg = OVERLAY_MESSAGES[state];
  for (let i = 0; i < overlayIds.length; i++) {
    const overlay = document.getElementById(overlayIds[i]);
    if (!overlay) continue;
    if (msg) {
      overlay.classList.add('visible');
      // Light variant: the syncing state shows last-known values
      // through a subtle Syncing… pill instead of the full
      // backdrop-blur copy block. Cards stay readable.
      overlay.classList.toggle('connection-overlay--syncing', !!msg.light);
      const titleEl = document.getElementById(overlayIds[i] + '-title');
      const subtitleEl = document.getElementById(overlayIds[i] + '-subtitle');
      if (titleEl) titleEl.textContent = msg.title;
      if (subtitleEl) subtitleEl.textContent = msg.subtitle;
    } else {
      overlay.classList.remove('visible');
      overlay.classList.remove('connection-overlay--syncing');
    }
  }
}

function updateDevicePushState() {
  const btn = document.getElementById('dc-save');
  const warning = document.getElementById('dc-connection-warning');
  if (!btn || !warning) return;
  const displayState = getConnectionDisplayState();
  const canPush = store.get('phase') !== 'live' || displayState === 'active' || displayState === 'stale';
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

export function initModeToggle() {
  const toggle = document.getElementById('mode-toggle');
  const sw = document.getElementById('mode-toggle-switch');
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
  const params = new URLSearchParams(location.search);
  if (mode === 'live') {
    params.delete('mode');
  } else {
    params.set('mode', mode);
  }
  const qs = params.toString();
  const url = location.pathname + (qs ? '?' + qs : '') + location.hash;
  history.replaceState(null, '', url);
}

function updateModeToggleUI(isLive) {
  const sw = document.getElementById('mode-toggle-switch');
  const label = document.getElementById('mode-toggle-label');
  if (isLive) {
    if (sw) sw.classList.add('active');
    if (label) {
      // Preview deploys rebrand the live side as "Preview" so reviewers
      // know they're not staring at the prod controller.
      const preview = store.get('runtimePreview');
      label.textContent = preview ? 'Preview' : 'Live';
      label.classList.add('active');
    }
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
      // Defense-in-depth: each step is independent. A bug in
      // updateDisplay must not break the manual override controls
      // (or vice versa).
      const steps = [
        ['updateDisplay',              function () { updateDisplay(state, result); }],
        ['refreshConnectionIndicator', refreshConnectionIndicator],
        ['updateConnectionOverlays',   updateConnectionOverlays],
        ['updateSidebarSubtitle',      updateSidebarSubtitle],
        ['updateDevicePushState',      updateDevicePushState],
        ['updateRelayBoard',           function () { updateRelayBoard(result); }],
        ['updateDrainageControl',      function () { updateDrainageControl(result); }],
      ];
      for (let i = 0; i < steps.length; i++) {
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
  _setRunning(false);
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
  const ghTrendResetEl = document.getElementById('tank-stat-greenhouse-trend');
  if (ghTrendResetEl) ghTrendResetEl.innerHTML = '';
  document.getElementById('inactive-modes').innerHTML = '';
  resetLiveYesterdayHigh();
  document.getElementById('graph-peak-label').textContent = "Yesterday's High: --";
  const arc = document.getElementById('tank-gauge-arc');
  if (arc) arc.setAttribute('stroke-dashoffset', '628');
  // Clear component statuses
  const compEls = document.querySelectorAll('.comp-status');
  compEls.forEach(function(el) { el.textContent = '--'; });
  // Clear simulation graph data and redraw empty canvas
  timeSeriesStore.reset();
  resetChartZoom();
  drawHistoryGraph();
  // Clear the transition log — fetchLiveEvents() will repopulate it from the DB
  transitionLog.length = 0;
  resetEventsState();
  const logsEl = document.getElementById('logs-list');
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
  resetBalanceState();
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
  const isLive = store.get('phase') === 'live';
  const desc = document.getElementById('status-view-description');
  if (desc) {
    desc.textContent = isLive
      ? 'Live readings from the Shelly controller. Mode, valves, actuators, and 24h history.'
      : 'Thermal simulation of the solar heating system. Adjust parameters in Controls and observe behavior here.';
  }
  const logsEmpty = document.getElementById('logs-list');
  if (logsEmpty && logsEmpty.children.length <= 1) {
    // Only replace the placeholder, not real log entries
    const placeholder = logsEmpty.querySelector('div[data-empty]') || (logsEmpty.children.length === 0 ? null : logsEmpty.firstElementChild);
    if (placeholder && placeholder.dataset && placeholder.dataset.empty === 'true') {
      placeholder.textContent = isLive
        ? 'No transitions yet. Awaiting controller activity…'
        : 'No transitions yet. Start the simulation.';
    }
  }
  const ctrl = document.getElementById('comp-controller');
  if (ctrl && isLive) {
    // In live mode the simulation "running" flag is meaningless.
    // Show ACTIVE when the controller is responsive.
    ctrl.textContent = 'ACTIVE';
  }
}

export function updateSidebarSubtitle() {
  const el = document.getElementById('sidebar-subtitle');
  if (!el) return;

  if (store.get('phase') === 'simulation') {
    el.textContent = running ? 'Simulating...' : 'Ready';
    el.className = '';
    return;
  }

  // Live mode: reflect connection state. PR previews rebrand the
  // active state as "Preview #<n>"; the other states (syncing,
  // offline, stale) stay generic — they describe network conditions,
  // not the deploy's identity.
  const displayState = getConnectionDisplayState();
  const preview = store.get('runtimePreview');
  switch (displayState) {
    case 'active':
      el.textContent = preview && preview.pr != null
        ? 'Preview #' + preview.pr
        : 'Live';
      el.className = 'subtitle-live';
      break;
    case 'syncing':
      el.textContent = 'Syncing…';
      el.className = 'subtitle-connecting';
      break;
    case 'connecting':
      el.textContent = 'Connecting…';
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
