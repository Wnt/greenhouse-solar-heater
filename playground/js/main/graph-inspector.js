// History-graph crosshair inspector (hover on desktop, long-press on
// mobile). Self-contained: owns its own DOM-state (crosshair position)
// and reads shared state (timeSeriesStore / graphRange /
// showAllSensors) via ESM live bindings from main.js.

import { store } from '../app-state.js';
import { SIM_START_HOUR } from '../sim-bootstrap.js';
import { timeSeriesStore, graphRange, showAllSensors } from './state.js';
import { tankAvgOf } from './history-graph.js';
import { formatClockTime } from './time-format.js';

let inspectorX = null; // null = hidden, otherwise CSS pixel x relative to canvas

function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }
const TEMP_PLACEHOLDER = '—';

export function setupInspector() {
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

    // Time of day — live data stores Unix epoch seconds (shown in
    // Europe/Helsinki), simulation stores seconds since sim start +
    // SIM_START_HOUR offset.
    let label;
    if (store.get('phase') === 'live') {
      label = formatClockTime(t * 1000);
    } else {
      const todH = Math.floor((SIM_START_HOUR + t / 3600) % 24);
      const todM = Math.floor(((SIM_START_HOUR + t / 3600) % 1) * 60);
      label = todH.toString().padStart(2, '0') + ':' + todM.toString().padStart(2, '0');
    }
    document.getElementById('inspector-time').textContent = label;

    // Temperature values (null-tolerant for unbound live sensors)
    const fmtInspTemp = function (x) { return isNum(x) ? x.toFixed(1) + '°C' : TEMP_PLACEHOLDER; };
    document.getElementById('inspector-coll').textContent = fmtInspTemp(v.t_collector);
    document.getElementById('inspector-tank').textContent = fmtInspTemp(tankAvgOf(v));
    if (showAllSensors) {
      document.getElementById('inspector-tank-top').textContent = fmtInspTemp(v.t_tank_top);
      document.getElementById('inspector-tank-bottom').textContent = fmtInspTemp(v.t_tank_bottom);
    }
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
