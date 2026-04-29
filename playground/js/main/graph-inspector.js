// History-graph crosshair inspector. Owns the tooltip + crosshair DOM
// and exposes show/hide so the touch-gesture module
// (chart-pinch-zoom.js) can drive long-press from its single source of
// pointer-event truth. Desktop hover is wired here directly; touch is
// handled by the gesture module so pan / pinch / tap / long-press
// dispatch through one disambiguator.

import { store } from '../app-state.js';
import { SIM_START_HOUR } from '../sim-bootstrap.js';
import { timeSeriesStore, showAllSensors } from './state.js';
import { tankAvgOf, getChartWindow } from './history-graph.js';
import { formatClockTime } from './time-format.js';
import { coverageInBucket } from './mode-events.js';
import { pickBucketSize } from '../ui.js';

function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }
const TEMP_PLACEHOLDER = '—';

let canvasEl = null;
let containerEl = null;
let tooltipEl = null;
let crosshairEl = null;

export function showInspector(x) {
  if (!canvasEl) return;
  crosshairEl.style.display = 'block';
  crosshairEl.style.left = x + 'px';
  tooltipEl.style.display = 'block';
  const containerW = containerEl.offsetWidth;
  if (x > containerW * 0.6) {
    tooltipEl.style.left = 'auto';
    tooltipEl.style.right = (containerW - x + 12) + 'px';
  } else {
    tooltipEl.style.left = (x + 12) + 'px';
    tooltipEl.style.right = 'auto';
  }
  updateInspectorData(x);
}

export function hideInspector() {
  if (!tooltipEl) return;
  tooltipEl.style.display = 'none';
  crosshairEl.style.display = 'none';
}

function updateInspectorData(x) {
  if (timeSeriesStore.times.length < 2) return;
  const dw = canvasEl.offsetWidth;
  const pad = { top: 16, right: 16, bottom: 24, left: 8 };
  const pw = dw - pad.left - pad.right;

  const win = getChartWindow();
  const visibleRange = win.tMax - win.tMin;

  const frac = (x - pad.left) / pw;
  if (frac < 0 || frac > 1) { hideInspector(); return; }
  const simTime = win.tMin + frac * visibleRange;

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

  const fmtInspTemp = function (x) { return isNum(x) ? x.toFixed(1) + '°C' : TEMP_PLACEHOLDER; };
  document.getElementById('inspector-coll').textContent = fmtInspTemp(v.t_collector);
  document.getElementById('inspector-tank').textContent = fmtInspTemp(tankAvgOf(v));
  if (showAllSensors) {
    document.getElementById('inspector-tank-top').textContent = fmtInspTemp(v.t_tank_top);
    document.getElementById('inspector-tank-bottom').textContent = fmtInspTemp(v.t_tank_bottom);
  }
  document.getElementById('inspector-gh').textContent = fmtInspTemp(v.t_greenhouse);
  document.getElementById('inspector-out').textContent = fmtInspTemp(v.t_outdoor);

  // Duty cycle for the bucket containing this point. Bucket size matches
  // the bar chart (pickBucketSize): 1H view → 15-min, 6H → 30-min,
  // 12-48H → 1h, multi-day → 1d. Reading the same span the bar above
  // covers, so the percentage matches the bar height under the cursor.
  const bucketSec = pickBucketSize(visibleRange);
  const bi = Math.floor(t / bucketSec);
  const bStart = bi * bucketSec;
  const bEnd = (bi + 1) * bucketSec;
  const cov = coverageInBucket(bStart, bEnd);
  const chPct = Math.round(100 * cov.charging / bucketSec);
  const htPct = Math.round(100 * cov.heating / bucketSec);
  const emPct = Math.round(100 * cov.emergency / bucketSec);
  document.getElementById('inspector-charging').textContent = chPct + '%';
  document.getElementById('inspector-heating').textContent = htPct + '%';
  document.getElementById('inspector-emergency').textContent = emPct + '%';
}

export function setupInspector() {
  canvasEl = document.getElementById('chart');
  containerEl = canvasEl.parentElement;
  tooltipEl = document.getElementById('graph-inspector');
  crosshairEl = document.getElementById('graph-crosshair');

  // Desktop: hover. Touch goes through the gesture module which calls
  // showInspector / hideInspector after disambiguating tap vs long-press
  // vs pan vs pinch.
  canvasEl.addEventListener('mousemove', function(e) {
    const rect = canvasEl.getBoundingClientRect();
    showInspector(e.clientX - rect.left);
  });
  canvasEl.addEventListener('mouseleave', hideInspector);
}
