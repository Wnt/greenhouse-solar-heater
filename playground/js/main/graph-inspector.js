// History-graph crosshair inspector. Owns the tooltip + crosshair DOM
// and exposes show/hide so the touch-gesture module
// (chart-pinch-zoom.js) can drive long-press from its single source of
// pointer-event truth. Desktop hover is wired here directly; touch is
// handled by the gesture module so pan / pinch / tap / long-press
// dispatch through one disambiguator.

import { store } from '../app-state.js';
import { SIM_START_HOUR } from '../sim-bootstrap.js';
import { timeSeriesStore, showAllSensors, showForecast, forecastData } from './state.js';
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

// Last bucket index the inspector was anchored to. Used for the
// haptic tick when the user drags across a bar boundary while the
// tooltip is visible — null once the tooltip is hidden so the next
// open doesn't fire on its first paint.
let lastInspectorBi = null;
function hapticBucketTick() {
  try { if (navigator.vibrate) navigator.vibrate(8); } catch (_) { /* noop */ }
}

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
  lastInspectorBi = null;
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

  // Forecast side? When the user crosses the "now" divider with the
  // Forecast toggle on, the inspector should pull from forecastData
  // instead of timeSeriesStore — otherwise the closest-sample search
  // anchors to the latest live reading and the tooltip lies, showing
  // "live" values for an hour that's actually projected.
  const isLivePhase = store.get('phase') === 'live';
  const nowSec = isLivePhase ? Math.floor(Date.now() / 1000) : null;
  if (isLivePhase && showForecast && forecastData && nowSec !== null && simTime > nowSec) {
    renderForecastInspector(simTime, visibleRange);
    return;
  }

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
  if (isLivePhase) {
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
  if (lastInspectorBi !== null && lastInspectorBi !== bi) hapticBucketTick();
  lastInspectorBi = bi;
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

// Render the inspector against forecastData (post-now side). Picks the
// nearest hourly trajectory point for tank / greenhouse, the nearest
// FMI hourly forecast for outside, and aggregates modeForecast entries
// inside the chart's bucket window for charging / heating / emergency
// percentages — same bucketSec as the predicted bars on the canvas.
function renderForecastInspector(simTime, visibleRange) {
  const fc = forecastData.forecast || {};
  const wx = forecastData.weather || [];
  const fmtInspTemp = function (v) { return isNum(v) ? v.toFixed(1) + '°C' : TEMP_PLACEHOLDER; };

  // Time label — forecast trajectory points are at hourly boundaries,
  // so just use the cursor position directly (rounded later if needed).
  document.getElementById('inspector-time').textContent = formatClockTime(simTime * 1000);

  function nearest(arr, tsField, valFn) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let best = null, bestDist = Infinity;
    for (let i = 0; i < arr.length; i++) {
      const t = Math.floor(new Date(arr[i][tsField]).getTime() / 1000);
      const d = Math.abs(t - simTime);
      if (d < bestDist) { bestDist = d; best = arr[i]; }
    }
    return best ? valFn(best) : null;
  }

  // Collector isn't simulated by the engine — leave blank rather than
  // misleadingly carrying the last live reading forward.
  document.getElementById('inspector-coll').textContent = TEMP_PLACEHOLDER;

  document.getElementById('inspector-tank').textContent =
    fmtInspTemp(nearest(fc.tankTrajectory, 'ts', function (p) { return p.avg; }));
  if (showAllSensors) {
    document.getElementById('inspector-tank-top').textContent =
      fmtInspTemp(nearest(fc.tankTrajectory, 'ts', function (p) { return p.top; }));
    document.getElementById('inspector-tank-bottom').textContent =
      fmtInspTemp(nearest(fc.tankTrajectory, 'ts', function (p) { return p.bottom; }));
  }
  document.getElementById('inspector-gh').textContent =
    fmtInspTemp(nearest(fc.greenhouseTrajectory, 'ts', function (p) { return p.temp; }));
  document.getElementById('inspector-out').textContent =
    fmtInspTemp(nearest(wx, 'validAt', function (p) { return p.temperature; }));

  // Mode percentages from modeForecast aggregated into the same
  // bucketSec window as the projected bars above.
  const bucketSec = pickBucketSize(visibleRange);
  const bi = Math.floor(simTime / bucketSec);
  if (lastInspectorBi !== null && lastInspectorBi !== bi) hapticBucketTick();
  lastInspectorBi = bi;
  const bStart = bi * bucketSec;
  const bEnd = (bi + 1) * bucketSec;
  let chHrs = 0, htHrs = 0, emHrs = 0;
  const modes = fc.modeForecast || [];
  for (let i = 0; i < modes.length; i++) {
    const t = Math.floor(new Date(modes[i].ts).getTime() / 1000);
    if (t < bStart || t >= bEnd) continue;
    if (modes[i].mode === 'solar_charging')          chHrs += 1;
    else if (modes[i].mode === 'greenhouse_heating') htHrs += 1;
    else if (modes[i].mode === 'emergency_heating')  emHrs += 1;
  }
  const bucketHrs = Math.max(1 / 60, bucketSec / 3600);
  const clampPct = function (n) { return Math.min(100, Math.max(0, n)); };
  document.getElementById('inspector-charging').textContent  = clampPct(Math.round(100 * chHrs / bucketHrs)) + '%';
  document.getElementById('inspector-heating').textContent   = clampPct(Math.round(100 * htHrs / bucketHrs)) + '%';
  document.getElementById('inspector-emergency').textContent = clampPct(Math.round(100 * emHrs / bucketHrs)) + '%';
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
