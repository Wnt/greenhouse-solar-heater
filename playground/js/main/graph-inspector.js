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

  // When the cursor is past "now" and the forecast overlay is on, read
  // values from the forecast payload instead of the historical buffer —
  // otherwise the nearest-neighbor search clamps to the last live sample
  // and the tooltip lies about the future. forecastData is null in sim
  // mode (forecast is live-only), so this branch is naturally skipped.
  const isLivePhase = store.get('phase') === 'live';
  const nowSec = isLivePhase ? Math.floor(Date.now() / 1000) : null;
  const fc = forecastData && forecastData.forecast;
  const inForecast = isLivePhase && showForecast && fc && nowSec !== null && simTime > nowSec;

  let v, t;
  if (inForecast) {
    v = forecastValuesAt(fc, simTime);
    t = simTime;
  } else {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < timeSeriesStore.times.length; i++) {
      const d = Math.abs(timeSeriesStore.times[i] - simTime);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    v = timeSeriesStore.values[bestIdx];
    t = timeSeriesStore.times[bestIdx];
  }

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
  let chPct, htPct, emPct;
  if (inForecast) {
    // Forecast modeForecast is at 1-hour resolution; mirror
    // drawForecastModeBars by counting slots inside the post-now slice
    // of the bucket, so the percentages line up visually with the
    // dashed bars under the cursor.
    const segStart = Math.max(bStart, nowSec);
    const segEnd = bEnd;
    const segHours = Math.max(1 / 60, (segEnd - segStart) / 3600);
    let chHours = 0, htHours = 0, emHours = 0;
    const list = Array.isArray(fc.modeForecast) ? fc.modeForecast : [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const ts = Math.floor(new Date(e.ts).getTime() / 1000);
      if (ts < segStart || ts >= segEnd) continue;
      if (e.mode === 'solar_charging') chHours += 1;
      else if (e.mode === 'greenhouse_heating') htHours += 1;
      else if (e.mode === 'emergency_heating') emHours += 1;
    }
    chPct = Math.round(100 * Math.min(1, chHours / segHours));
    htPct = Math.round(100 * Math.min(1, htHours / segHours));
    emPct = Math.round(100 * Math.min(1, emHours / segHours));
  } else {
    const cov = coverageInBucket(bStart, bEnd);
    chPct = Math.round(100 * cov.charging / bucketSec);
    htPct = Math.round(100 * cov.heating / bucketSec);
    emPct = Math.round(100 * cov.emergency / bucketSec);
  }
  document.getElementById('inspector-charging').textContent = chPct + '%';
  document.getElementById('inspector-heating').textContent = htPct + '%';
  document.getElementById('inspector-emergency').textContent = emPct + '%';
}

// Linearly interpolate a forecast trajectory at simTime (Unix seconds)
// and return a row shaped like timeSeriesStore.values so the inspector's
// downstream rendering doesn't branch. Collector and outdoor aren't part
// of the forecast — they fall through as null and render as the placeholder.
function forecastValuesAt(fc, simTime) {
  const tank = interpTrajPoint(fc.tankTrajectory, simTime);
  const gh   = interpTrajPoint(fc.greenhouseTrajectory, simTime);
  return {
    t_collector:   null,
    t_tank_top:    tank ? tank.top : null,
    t_tank_bottom: tank ? tank.bottom : null,
    t_greenhouse:  gh ? gh.temp : null,
    t_outdoor:     null,
  };
}

function interpTrajPoint(traj, simTime) {
  if (!Array.isArray(traj) || traj.length === 0) return null;
  for (let i = 0; i < traj.length; i++) {
    const t = Math.floor(new Date(traj[i].ts).getTime() / 1000);
    if (t >= simTime) {
      if (i === 0) return traj[0];
      const prev = traj[i - 1];
      const pT = Math.floor(new Date(prev.ts).getTime() / 1000);
      if (t === pT) return traj[i];
      const f = (simTime - pT) / (t - pT);
      const out = { ts: traj[i].ts };
      const keys = ['top', 'bottom', 'avg', 'temp'];
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (typeof traj[i][key] === 'number' && typeof prev[key] === 'number') {
          out[key] = prev[key] + (traj[i][key] - prev[key]) * f;
        }
      }
      return out;
    }
  }
  return traj[traj.length - 1];
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
