/**
 * Main PoC application — polls Shelly sensors, updates gauges and chart.
 */
import { ShellyAPI } from './shelly-api.js';
import { renderGauge, renderGaugeNoData } from './gauge.js';
import { TimeSeriesStore, drawChart } from './chart.js';

// ── Configuration ──
const SENSOR_IDS = [0, 1];
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

// ── State ──
let api = null;
let pollTimer = null;
let chartWindowMs = HISTORY_WINDOWS['6h'];
const store = new TimeSeriesStore(MAX_HISTORY, SENSOR_LABELS);
let connected = false;
let lastPollTime = null;

// ── DOM refs ──
const elIpInput = document.getElementById('device-ip');
const elConnectBtn = document.getElementById('connect-btn');
const elStatusDot = document.getElementById('status-dot');
const elStatusText = document.getElementById('status-text');
const elGauge0 = document.getElementById('gauge-0');
const elGauge1 = document.getElementById('gauge-1');
const elChart = document.getElementById('history-chart');
const elEventLog = document.getElementById('event-log');
const elDeviceName = document.getElementById('device-name');
const elLastPoll = document.getElementById('last-poll');

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
    }
  } catch (e) { /* ignore */ }
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ip: elIpInput.value }));
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

  // Time range buttons
  document.querySelectorAll('.time-range-btns button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.time-range-btns button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      chartWindowMs = HISTORY_WINDOWS[btn.dataset.range];
      drawChart(elChart, store, { windowMs: chartWindowMs });
    });
  });

  // Redraw chart on resize
  window.addEventListener('resize', () => {
    drawChart(elChart, store, { windowMs: chartWindowMs });
  });
}

// ── Connection ──
async function connect() {
  const ip = elIpInput.value.trim();
  if (!ip) {
    logEvent('Enter a device IP address', 'error');
    return;
  }

  saveConfig();
  setStatus('connecting');
  api = new ShellyAPI(ip);

  try {
    const info = await api.getDeviceInfo();
    const name = info.name || info.id || 'Unknown';
    elDeviceName.textContent = name;
    logEvent(`Connected to ${name} (${info.model || 'Shelly'})`, 'ok');
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
  elConnectBtn.textContent = 'Connect';
  setStatus('disconnected');
  elDeviceName.textContent = '-';
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
