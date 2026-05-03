// History graph rendering extracted from main.js.
//
// Depends on mutable state re-exported from main.js (timeSeriesStore,
// graphRange, showAllSensors) via ESM live bindings — a reassignment
// in main.js is observed here on the next call.

import { store } from '../app-state.js';
import { pickTickStep, formatTick, pickBucketSize, formatBucketLabel } from '../ui.js';
import { SIM_START_HOUR } from '../sim-bootstrap.js';
import { timeSeriesStore, graphRange, showAllSensors, chartZoom } from './state.js';
import { coverageInBucket } from './mode-events.js';

function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

const DAY_SEC = 86400;

// Pure: pick a centered moving-average window for the temperature lines.
// Below 7 days the server already serves raw or 30-second data and the
// lines look fine as-is. Larger spans switch on a 5-min / 10-min /
// 30-min / 1-h / 2-h server bucket — short collector spikes still come
// through as 60-90°C peaks even after bucket averaging, so this layer
// has to be wide enough to actually round them off. Zooming in
// (smaller visibleRange) drops the window so detail re-emerges.
//
// Window × bucket size translates to wall time: e.g. 11 × 5 min ≈ 55 min
// at 7d, 17 × 30 min ≈ 8.5 h at 30d.
export function lineSmoothingWindow(visibleRange) {
  if (visibleRange < 7 * DAY_SEC) return 1;
  if (visibleRange <= 14 * DAY_SEC) return 11;
  if (visibleRange <= 30 * DAY_SEC) return 13;
  if (visibleRange <= 90 * DAY_SEC) return 17;
  return 21;
}

// Pure: centered moving-average over y (length-preserving). Edge points
// shrink the window naturally so the line still reaches both edges.
export function smoothPoints(pts, windowSize) {
  if (windowSize <= 1 || pts.length < 2) return pts;
  const half = Math.floor(windowSize / 2);
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(pts.length - 1, i + half);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += pts[j].y;
    out[i] = { x: pts[i].x, y: sum / (hi - lo + 1) };
  }
  return out;
}

// Pure: list duty-cycle buckets that overlap the [firstSampleT, lastSampleT]
// data span and the [tMin, tMax) visible window. Each entry exposes the bucket
// boundaries (hrStart/hrEnd) for placement and the data-clamped segment
// (segStart/segEnd) the coverage query should run on. Buckets entirely outside
// the data span are dropped — without the right-edge clamp, modeAt() would
// happily extrapolate the latest known mode across hours that haven't been
// observed yet, painting full-height bars for empty future buckets.
export function dutyBucketsIn({ tMin, tMax, bucketSec, firstSampleT, lastSampleT }) {
  const out = [];
  if (lastSampleT <= firstSampleT) return out;
  const firstBucket = Math.floor(tMin / bucketSec);
  const lastBucket = Math.ceil(tMax / bucketSec);
  for (let bi = firstBucket; bi < lastBucket; bi++) {
    const hrStart = bi * bucketSec;
    const hrEnd = (bi + 1) * bucketSec;
    if (hrEnd <= tMin || hrStart >= tMax) continue;
    if (hrEnd <= firstSampleT) continue;
    if (hrStart >= lastSampleT) continue;
    const segStart = Math.max(hrStart, firstSampleT);
    const segEnd = Math.min(hrEnd, lastSampleT);
    if (segEnd <= segStart) continue;
    out.push({ hrStart, hrEnd, segStart, segEnd });
  }
  return out;
}

// Resolve the visible time window to render. Pinch zoom (chartZoom) takes
// precedence; otherwise the chart slides so the right edge sits at the
// latest sample (sim) or wall-clock now (live), with width = graphRange.
// Shared with graph-inspector so its crosshair math stays aligned with
// what's drawn — without this, zooming would desync the two.
export function getChartWindow() {
  if (chartZoom) return { tMin: chartZoom.tMin, tMax: chartZoom.tMax };
  const isLivePhase = store.get('phase') === 'live';
  const latestTime = timeSeriesStore.times.length > 0
    ? timeSeriesStore.times[timeSeriesStore.times.length - 1]
    : 0;
  const tMax = isLivePhase ? Math.floor(Date.now() / 1000) : Math.max(graphRange, latestTime);
  return { tMin: tMax - graphRange, tMax };
}

// Tank value extractor shared by the graph, inspector, and yesterday-
// high calculation. Returns the top/bottom average when both sensors
// are valid, else null.
export function tankAvgOf(row) {
  if (!row) return null;
  if (!isNum(row.t_tank_top) || !isNum(row.t_tank_bottom)) return null;
  return (row.t_tank_top + row.t_tank_bottom) / 2;
}

export function drawHistoryGraph() {
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  // Set the backing-store size from the CSS size + DPR. The assignments
  // happen for their side effect; the resulting pixel dimensions are
  // not read back here.
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  ctx.scale(dpr, dpr);
  const dw = canvas.offsetWidth;
  const dh = canvas.offsetHeight;
  ctx.clearRect(0, 0, dw, dh);

  const pad = { top: 16, right: 16, bottom: 24, left: 8 };
  const pw = dw - pad.left - pad.right;
  const ph = dh - pad.top - pad.bottom;

  // Visible window — sliding by default, or a pinch-zoom span when set.
  const isLivePhase = store.get('phase') === 'live';
  const { tMin, tMax } = getChartWindow();
  const visibleRange = tMax - tMin;

  // Y range for temperature
  const yMin = 0, yMax = 100;

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

  // X-axis time labels — pick a step that keeps the label count readable
  // at any range (pickTickStep caps labels at ~plotWidth/72px). Sub-day
  // ranges render as HH:MM; multi-day as D.M.; month+ as "MMM YY".
  ctx.fillStyle = '#a5abb9';
  ctx.font = '10px Manrope, sans-serif';
  ctx.textAlign = 'center';

  const stepSeconds = pickTickStep(visibleRange, pw);
  const firstTick = Math.ceil(tMin / stepSeconds) * stepSeconds;
  const hourSeconds = 3600;
  for (let t = firstTick; t <= tMax; t += stepSeconds) {
    const frac = (t - tMin) / visibleRange;
    if (frac < -0.01 || frac > 1.01) continue;
    const x = pad.left + frac * pw;
    let label;
    if (isLivePhase) {
      // Live mode: t is Unix epoch seconds; formatTick switches format per step.
      label = formatTick(t, stepSeconds);
    } else {
      // Simulation mode: t is offset seconds from SIM_START_HOUR. Sub-day
      // view keeps the old "HH:00" behavior for familiarity.
      const todH = Math.floor((SIM_START_HOUR + t / hourSeconds) % 24);
      label = todH.toString().padStart(2, '0') + ':00';
    }
    ctx.fillText(label, x, dh - 4);
  }

  if (timeSeriesStore.times.length < 2) {
    updateLegendStats(tMin, tMax);
    return;
  }

  // ── Duty cycle bars ──
  // Bucket granularity scales with the visible range — see pickBucketSize
  // in ui.js. 1h view uses 15-minute buckets (4 bars/h), 6h uses 30-minute,
  // 12-48h uses 1h, longer ranges use daily. Previously this was a fixed
  // 1-hour bucket regardless of range.
  const barAreaH = ph * 0.3;
  const barY0 = pad.top + ph;
  const bucketSec = pickBucketSize(visibleRange);
  updateBucketBadge(bucketSec);

  let hasEmergency = false;
  const firstSampleT = timeSeriesStore.times.length > 0 ? timeSeriesStore.times[0] : tMax;
  const lastSampleT = timeSeriesStore.times.length > 0 ? timeSeriesStore.times[timeSeriesStore.times.length - 1] : tMin;
  const buckets = dutyBucketsIn({ tMin, tMax, bucketSec, firstSampleT, lastSampleT });
  for (let i = 0; i < buckets.length; i++) {
    const { hrStart, segStart, segEnd } = buckets[i];
    const cov = coverageInBucket(segStart, segEnd);
    const chargingFrac = cov.charging / bucketSec;
    const heatingFrac = cov.heating / bucketSec;
    const emergencyFrac = cov.emergency / bucketSec;

    const barX = pad.left + ((hrStart - tMin) / visibleRange) * pw;
    const barW = Math.max(1, (bucketSec / visibleRange) * pw - 2);

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
    }
  }
  document.getElementById('legend-emergency').style.display = hasEmergency ? 'flex' : 'none';

  // ── Temperature line (gold, matching Stitch design) ──
  // Tank line plots the top/bottom average — matches the central gauge.
  // collectSeriesPts carries a pre-window sample forward as an
  // interpolated point at tMin so the line meets the chart's left edge
  // even when a real sensor-reading gap straddles the boundary.
  const smoothW = lineSmoothingWindow(visibleRange);
  const pts = smoothPoints(
    collectSeriesPts(timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, tankAvgOf),
    smoothW,
  );

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

    // Current-point dot. Drawn only when the most recent sample is
    // inside the window — when zoomed/panned to a slice that ends
    // before the latest data, the dot at pts[last] would lie on some
    // earlier point and read as "now" to the eye.
    const latestSampleT = timeSeriesStore.times.length > 0
      ? timeSeriesStore.times[timeSeriesStore.times.length - 1]
      : null;
    if (latestSampleT !== null && latestSampleT <= tMax) {
      const last = pts[pts.length - 1];
      ctx.beginPath();
      ctx.arc(last.x, last.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#e9c349';
      ctx.fill();
    }
  }

  // ── Tank sub-sensor lines (only with the "All sensors" toggle) ──
  if (showAllSensors) {
    drawTempLine(ctx, timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, 't_tank_top', '#ff9f43', 1);
    drawTempLine(ctx, timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, 't_tank_bottom', '#b088d6', 1);
  }

  // ── Collector line (red) ──
  drawTempLine(ctx, timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, 't_collector', '#ef5350', 1.5);

  // ── Greenhouse line (green) ──
  drawTempLine(ctx, timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, 't_greenhouse', '#69d0c5', 1);

  // ── Outside line (blue) ──
  drawTempLine(ctx, timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, 't_outdoor', '#42a5f5', 1);

  updateLegendStats(tMin, tMax);
}

// Pure: walk the time-series store once and pull min / max / latest for
// each requested key inside [tMin, tMax]. Returns null entries for series
// with no in-window samples so the caller can blank the label cleanly.
export function computeSeriesStats(store, tMin, tMax, keys) {
  const acc = {};
  for (let k = 0; k < keys.length; k++) {
    acc[keys[k].id] = { min: Infinity, max: -Infinity, latest: null, latestT: -Infinity };
  }
  for (let i = 0; i < store.times.length; i++) {
    const t = store.times[i];
    if (t < tMin || t > tMax) continue;
    const row = store.values[i];
    for (let k = 0; k < keys.length; k++) {
      const def = keys[k];
      const v = typeof def.extract === 'function' ? def.extract(row) : row[def.id];
      if (!isNum(v)) continue;
      const a = acc[def.id];
      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;
      if (t >= a.latestT) { a.latest = v; a.latestT = t; }
    }
  }
  const out = {};
  for (let k = 0; k < keys.length; k++) {
    const a = acc[keys[k].id];
    out[keys[k].id] = a.latest === null
      ? null
      : { min: a.min, max: a.max, latest: a.latest };
  }
  return out;
}

function fmtTempStat(v) { return Math.round(v).toString(); }

function renderLegendStats(el, stats) {
  if (!el) return;
  if (!stats) { el.textContent = ''; return; }
  // Latest value (with °) + a muted range span "(min–max°)". Single
  // unit at the tail of the range matches the issue's design ("15.8
  // → 68.2 °C") and keeps the legend line short on narrow viewports.
  el.textContent = fmtTempStat(stats.latest) + '°';
  const range = document.createElement('span');
  range.className = 'graph-legend-stats-range';
  range.textContent = '(' + fmtTempStat(stats.min) + '–' + fmtTempStat(stats.max) + '°)';
  el.appendChild(range);
}

// Per-series legend keys. tankAvgOf collapses top+bottom for the main
// Tank line; the individual sub-sensors are only shown when "All sensors"
// is on, but their stats still update so toggling reveals fresh numbers.
const LEGEND_SERIES = [
  { id: 't_collector',  domId: 'legend-stats-collector' },
  { id: 'tank',         domId: 'legend-stats-tank',         extract: tankAvgOf },
  { id: 't_tank_top',   domId: 'legend-stats-tank-top' },
  { id: 't_tank_bottom',domId: 'legend-stats-tank-bottom' },
  { id: 't_greenhouse', domId: 'legend-stats-greenhouse' },
  { id: 't_outdoor',    domId: 'legend-stats-outdoor' },
];

function updateLegendStats(tMin, tMax) {
  const stats = computeSeriesStats(timeSeriesStore, tMin, tMax, LEGEND_SERIES);
  for (let i = 0; i < LEGEND_SERIES.length; i++) {
    const def = LEGEND_SERIES[i];
    renderLegendStats(document.getElementById(def.domId), stats[def.id]);
  }
}

// Collect visible plot points for a single series, carrying a leading-edge
// sample (the last point before tMin) forward as a linearly-interpolated
// value at tMin so the line starts at the chart's left edge even when the
// first in-window sample is several minutes late.
function collectSeriesPts(timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, key) {
  const extract = typeof key === 'function'
    ? key
    : function (row) { return row[key]; };
  let preT = null, preV = null;
  const pts = [];
  for (let i = 0; i < timeSeriesStore.times.length; i++) {
    const t = timeSeriesStore.times[i];
    const v = extract(timeSeriesStore.values[i]);
    if (!isNum(v)) continue;
    if (t < tMin) {
      // Keep only the latest pre-window sample — in insertion order the
      // loop sees samples in ascending time, so this overwrites each time.
      preT = t; preV = v;
      continue;
    }
    if (t > tMax) break;
    // First in-window sample: synthesize an interpolated point at the
    // left edge (x = pad.left) from preT/preV + this sample so the line
    // covers the [tMin, t] gap without a visible hole.
    if (pts.length === 0 && preT !== null && t > tMin) {
      const frac = (tMin - preT) / (t - preT);
      const vAtTMin = preV + (v - preV) * frac;
      const yAtTMin = pad.top + ph - ((vAtTMin - yMin) / (yMax - yMin)) * ph;
      pts.push({ x: pad.left, y: yAtTMin });
    }
    const x = pad.left + ((t - tMin) / visibleRange) * pw;
    const y = pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
    pts.push({ x, y });
  }
  return pts;
}

function drawTempLine(ctx, timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, key, color, lineWidth) {
  const pts = smoothPoints(
    collectSeriesPts(timeSeriesStore, tMin, tMax, visibleRange, pad, pw, ph, yMin, yMax, key),
    lineSmoothingWindow(visibleRange),
  );
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

// Refresh the "<bucket> / bar" badge in the chart corner so the user
// always sees what each duty-cycle bar represents at the current zoom.
// Tooltip carries the long-form explanation; the visible label is just
// the short bucket size (e.g. "5 min", "1 day").
function updateBucketBadge(bucketSec) {
  const valEl = document.getElementById('chart-bucket-badge-val');
  if (!valEl) return;
  const label = formatBucketLabel(bucketSec);
  if (valEl.textContent !== label) valEl.textContent = label;
  const badge = document.getElementById('chart-bucket-badge');
  if (badge) badge.title = 'Each bar shows duty-cycle aggregated over ' + label;
}

// ── SVG Schematic ──
// Maps the tick payload (state + control evaluate() result) into the
// flat shape the schematic.js module expects.
export function toSchematicState(state, result) {
  if (!state || !result) return null;
  const valves = result.valves || {};
  const actuators = result.actuators || {};
  return {
    valves: {
      vi_btm:  !!valves.vi_btm,
      vi_top:  !!valves.vi_top,
      vi_coll: !!valves.vi_coll,
      vo_coll: !!valves.vo_coll,
      vo_rad:  !!valves.vo_rad,
      vo_tank: !!valves.vo_tank,
      v_air:   !!valves.v_air,
    },
    pump:         !!actuators.pump,
    space_heater: !!actuators.space_heater,
    sensors: {
      t_tank_top:    state.t_tank_top,
      t_tank_bottom: state.t_tank_bottom,
      t_collector:   state.t_collector,
      t_greenhouse:  state.t_greenhouse,
      t_outdoor:     state.t_outdoor,
    },
  };
}
