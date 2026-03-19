/**
 * Main PoC application — polls Shelly sensors, updates gauges and chart.
 * Also polls Pro 4PM for valve status and supports manual overrides.
 */
import { ShellyAPI } from './shelly-api.js';
import { renderGauge, renderGaugeNoData } from './gauge.js';
import { TimeSeriesStore, drawChart } from './chart.js';

// ── Configuration ──
const SENSOR_IDS = [100, 101];
const SENSOR_LABELS = ['Sensor 1', 'Sensor 2'];
const POLL_INTERVAL_MS = 10000; // 10 seconds
const HISTORY_WINDOWS = {
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '3h': 3 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
};
const MAX_HISTORY = 6 * 60 * 60 * 1000; // 6 hours
const STORAGE_KEY = 'poc-shelly-config';
const SCRIPT_ID = 1; // Pro 4PM script slot for sensor-display

// ── State ──
let api = null;
let pollTimer = null;
let chartWindowMs = HISTORY_WINDOWS['6h'];
const store = new TimeSeriesStore(MAX_HISTORY, SENSOR_LABELS);
let connected = false;
let lastPollTime = null;
let controllerIp = null; // Pro 4PM IP
let valveStatus = null; // latest valve status from 4PM
let cooldownTimer = null; // UI countdown interval

// ── DOM refs ──
const elIpInput = document.getElementById('device-ip');
const elControllerIpInput = document.getElementById('controller-ip');
const elConnectBtn = document.getElementById('connect-btn');
const elStatusDot = document.getElementById('status-dot');
const elStatusText = document.getElementById('status-text');
const elGauge0 = document.getElementById('gauge-0');
const elGauge1 = document.getElementById('gauge-1');
const elChart = document.getElementById('history-chart');
const elEventLog = document.getElementById('event-log');
const elDeviceName = document.getElementById('device-name');
const elLastPoll = document.getElementById('last-poll');

// Valve DOM refs
const elValvePanel = document.getElementById('valve-panel');
const elValveMode = document.getElementById('valve-mode');
const elV1Status = document.getElementById('v1-status');
const elV2Status = document.getElementById('v2-status');
const elV1Dot = document.getElementById('v1-dot');
const elV2Dot = document.getElementById('v2-dot');
const elV1Cooldown = document.getElementById('v1-cooldown');
const elV2Cooldown = document.getElementById('v2-cooldown');
const elV1OnBtn = document.getElementById('v1-on-btn');
const elV1OffBtn = document.getElementById('v1-off-btn');
const elV2OnBtn = document.getElementById('v2-on-btn');
const elV2OffBtn = document.getElementById('v2-off-btn');
const elAutoBtn = document.getElementById('auto-btn');

// ── Init ──
export function init() {
  loadConfig();
  setupEventListeners();
  renderGaugeNoData(elGauge0, { min: -20, max: 80 });
  renderGaugeNoData(elGauge1, { min: -20, max: 80 });
  drawChart(elChart, store);

  // Auto-connect if we have a saved IP
  if (elIpInput.value) {
    connect();
  }
}

function loadConfig() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const cfg = JSON.parse(saved);
      if (cfg.ip) elIpInput.value = cfg.ip;
      if (cfg.controllerIp) elControllerIpInput.value = cfg.controllerIp;
    }
  } catch (e) { /* ignore */ }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ip: elIpInput.value,
    controllerIp: elControllerIpInput.value,
  }));
}

function setupEventListeners() {
  elConnectBtn.addEventListener('click', () => {
    if (connected) {
      disconnect();
    } else {
      connect();
    }
  });

  elIpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect();
  });

  elControllerIpInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') connect();
  });

  // Time range buttons
  document.querySelectorAll('.time-range-btns button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.time-range-btns button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartWindowMs = HISTORY_WINDOWS[btn.dataset.range];
      drawChart(elChart, store, { windowMs: chartWindowMs });
    });
  });

  // Valve override buttons
  elV1OnBtn.addEventListener('click', () => sendOverride(true, getV2Desired()));
  elV1OffBtn.addEventListener('click', () => sendOverride(false, getV2Desired()));
  elV2OnBtn.addEventListener('click', () => sendOverride(getV1Desired(), true));
  elV2OffBtn.addEventListener('click', () => sendOverride(getV1Desired(), false));
  elAutoBtn.addEventListener('click', () => sendClearOverride());

  // Redraw chart on resize
  window.addEventListener('resize', () => {
    drawChart(elChart, store, { windowMs: chartWindowMs });
  });
}

function getV1Desired() {
  return valveStatus ? valveStatus.valves.v1.output : false;
}

function getV2Desired() {
  return valveStatus ? valveStatus.valves.v2.output : false;
}

// ── Connection ──
async function connect() {
  const ip = elIpInput.value.trim();
  if (!ip) {
    logEvent('Enter a sensor device IP address', 'error');
    return;
  }

  controllerIp = elControllerIpInput.value.trim();

  saveConfig();
  setStatus('connecting');
  api = new ShellyAPI(ip);

  try {
    const info = await api.getDeviceInfo();
    const name = info.name || info.id || 'Unknown';
    elDeviceName.textContent = name;
    logEvent(`Connected to ${name} (${info.model || 'Shelly'})`, 'ok');

    // Test controller connection if IP provided
    if (controllerIp) {
      try {
        const ctrlInfo = await api.rpcTo(controllerIp, 'Shelly.GetDeviceInfo');
        logEvent(`Controller: ${ctrlInfo.name || ctrlInfo.id} (${ctrlInfo.model || '4PM'})`, 'ok');
        elValvePanel.classList.remove('hidden');
      } catch (e) {
        logEvent(`Controller at ${controllerIp} not reachable: ${e.message}`, 'error');
        controllerIp = null;
      }
    }

    setStatus('connected');
    connected = true;
    elConnectBtn.textContent = 'Disconnect';
    startPolling();
  } catch (e) {
    logEvent(`Connection failed: ${e.message}`, 'error');
    setStatus('disconnected');
    connected = false;
  }
}

function disconnect() {
  stopPolling();
  connected = false;
  api = null;
  controllerIp = null;
  valveStatus = null;
  elConnectBtn.textContent = 'Connect';
  setStatus('disconnected');
  elDeviceName.textContent = '-';
  elValvePanel.classList.add('hidden');
  stopCooldownTimer();
  logEvent('Disconnected', 'ok');
}

function setStatus(state) {
  elStatusDot.className = `status-dot ${state}`;
  const labels = { connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting...' };
  elStatusText.textContent = labels[state] || state;
}

// ── Polling ──
function startPolling() {
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce() {
  if (!api) return;
  try {
    const results = await api.getAllTemperatures(SENSOR_IDS);
    lastPollTime = new Date();
    elLastPoll.textContent = formatTimestamp(lastPollTime);

    const values = {};
    results.forEach((r, i) => {
      const label = SENSOR_LABELS[i];
      if (r.error) {
        renderGaugeNoData(i === 0 ? elGauge0 : elGauge1, { min: -20, max: 80 });
        values[label] = null;
      } else {
        renderGauge(i === 0 ? elGauge0 : elGauge1, {
          value: r.tC,
          min: -20,
          max: 80,
        });
        values[label] = r.tC;
      }
    });

    store.add(values);
    drawChart(elChart, store, { windowMs: chartWindowMs });

    // Update status to connected (in case we recovered from error)
    if (!connected) {
      connected = true;
      setStatus('connected');
    }
  } catch (e) {
    logEvent(`Poll error: ${e.message}`, 'error');
    setStatus('disconnected');
    connected = false;
    // Try to reconnect on next poll
  }

  // Poll valve status from controller
  if (controllerIp && api) {
    try {
      valveStatus = await api.getValveStatus(controllerIp, SCRIPT_ID);
      updateValveUI();
    } catch (e) {
      // Don't log every poll failure for valves — just update UI
      updateValveUIError();
    }
  }
}

// ── Valve UI ──

/** Timestamp of last valve status fetch (for cooldown countdown) */
let lastValveFetchTime = null;

function updateValveUI() {
  if (!valveStatus) return;

  lastValveFetchTime = Date.now();

  const v = valveStatus.valves;
  const ov = valveStatus.override;

  // Mode badge
  if (ov.active) {
    elValveMode.textContent = 'OVERRIDE';
    elValveMode.className = 'valve-mode-badge override';
  } else {
    elValveMode.textContent = 'AUTO';
    elValveMode.className = 'valve-mode-badge auto';
  }

  // Valve states
  setValveIndicator(elV1Dot, elV1Status, v.v1.output);
  setValveIndicator(elV2Dot, elV2Status, v.v2.output);

  // Cooldown displays
  updateCooldownDisplay(elV1Cooldown, v.v1.cooldownLeft);
  updateCooldownDisplay(elV2Cooldown, v.v2.cooldownLeft);

  // Start countdown timer for smoother UI
  startCooldownTimer();

  // Highlight active override buttons
  updateOverrideButtons();
}

function updateValveUIError() {
  elV1Status.textContent = '—';
  elV2Status.textContent = '—';
  elV1Cooldown.textContent = '';
  elV2Cooldown.textContent = '';
}

function setValveIndicator(dot, label, isOpen) {
  if (isOpen) {
    dot.className = 'valve-dot open';
    label.textContent = 'OPEN';
    label.className = 'valve-state open';
  } else {
    dot.className = 'valve-dot closed';
    label.textContent = 'CLOSED';
    label.className = 'valve-state closed';
  }
}

function updateCooldownDisplay(el, secondsLeft) {
  if (secondsLeft > 0) {
    el.textContent = secondsLeft + 's';
    el.className = 'valve-cooldown active';
  } else {
    el.textContent = 'ready';
    el.className = 'valve-cooldown';
  }
}

function updateOverrideButtons() {
  if (!valveStatus) return;
  const ov = valveStatus.override;
  const v = valveStatus.valves;

  // Highlight current valve state buttons
  elV1OnBtn.classList.toggle('active', v.v1.output);
  elV1OffBtn.classList.toggle('active', !v.v1.output);
  elV2OnBtn.classList.toggle('active', v.v2.output);
  elV2OffBtn.classList.toggle('active', !v.v2.output);
  elAutoBtn.classList.toggle('active', !ov.active);
}

// ── Cooldown countdown timer (counts down between polls for smoother UX) ──

function startCooldownTimer() {
  stopCooldownTimer();
  cooldownTimer = setInterval(() => {
    if (!valveStatus || !lastValveFetchTime) return;
    const elapsed = (Date.now() - lastValveFetchTime) / 1000;
    const v = valveStatus.valves;
    const v1Left = Math.max(0, Math.round(v.v1.cooldownLeft - elapsed));
    const v2Left = Math.max(0, Math.round(v.v2.cooldownLeft - elapsed));
    updateCooldownDisplay(elV1Cooldown, v1Left);
    updateCooldownDisplay(elV2Cooldown, v2Left);
  }, 1000);
}

function stopCooldownTimer() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

// ── Valve override commands ──

async function sendOverride(v1, v2) {
  if (!api || !controllerIp) return;
  try {
    const result = await api.setValveOverride(controllerIp, SCRIPT_ID, v1, v2);
    logEvent(`Override set: V1=${v1 ? 'OPEN' : 'CLOSED'}, V2=${v2 ? 'OPEN' : 'CLOSED'}`, 'ok');
    // Refresh valve status immediately
    valveStatus = await api.getValveStatus(controllerIp, SCRIPT_ID);
    updateValveUI();
  } catch (e) {
    logEvent(`Override failed: ${e.message}`, 'error');
  }
}

async function sendClearOverride() {
  if (!api || !controllerIp) return;
  try {
    await api.clearValveOverride(controllerIp, SCRIPT_ID);
    logEvent('Returned to AUTO mode', 'ok');
    valveStatus = await api.getValveStatus(controllerIp, SCRIPT_ID);
    updateValveUI();
  } catch (e) {
    logEvent(`Clear override failed: ${e.message}`, 'error');
  }
}

// ── Event log ──
function logEvent(message, type = '') {
  const entry = document.createElement('div');
  entry.className = 'entry';
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = formatTimestamp(new Date()) + ' ';
  const msg = document.createElement('span');
  msg.className = type;
  msg.textContent = message;
  entry.appendChild(time);
  entry.appendChild(msg);
  elEventLog.prepend(entry);

  // Keep max 100 entries
  while (elEventLog.children.length > 100) {
    elEventLog.removeChild(elEventLog.lastChild);
  }
}

function formatTimestamp(date) {
  return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ── Start ──
init();
