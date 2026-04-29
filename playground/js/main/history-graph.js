// History graph rendering extracted from main.js.
//
// Depends on mutable state re-exported from main.js (timeSeriesStore,
// graphRange, showAllSensors) via ESM live bindings — a reassignment
// in main.js is observed here on the next call.

import { store } from '../app-state.js';
import { pickTickStep, formatTick, pickBucketSize } from '../ui.js';
import { SIM_START_HOUR } from '../sim-bootstrap.js';
import { timeSeriesStore, graphRange, showAllSensors } from './state.js';

function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

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

  const stepSeconds = pickTickStep(graphRange, pw);
  const firstTick = Math.ceil(tMin / stepSeconds) * stepSeconds;
  const hourSeconds = 3600;
  for (let t = firstTick; t <= tMax; t += stepSeconds) {
    const frac = (t - tMin) / graphRange;
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

  if (timeSeriesStore.times.length < 2) return;

  // ── Duty cycle bars ──
  // Bucket granularity scales with the visible range — see pickBucketSize
  // in ui.js. 1h view uses 15-minute buckets (4 bars/h), 6h uses 30-minute,
  // 12-48h uses 1h, longer ranges use daily. Previously this was a fixed
  // 1-hour bucket regardless of range.
  const barAreaH = ph * 0.3;
  const barY0 = pad.top + ph;
  const bucketSec = pickBucketSize(graphRange);

  const firstBucket = Math.floor(tMin / bucketSec);
  const lastBucket = Math.ceil(tMax / bucketSec);

  let hasEmergency = false;
  for (let bi = firstBucket; bi < lastBucket; bi++) {
    const hrStart = bi * bucketSec;
    const hrEnd = (bi + 1) * bucketSec;

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
    const chargingFrac = chargingSec / bucketSec;
    const heatingFrac = heatingSec / bucketSec;
    const emergencyFrac = emergencySec / bucketSec;

    const barX = pad.left + ((hrStart - tMin) / graphRange) * pw;
    const barW = Math.max(1, (bucketSec / graphRange) * pw - 2);

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
  // Tank line plots the top/bottom average — matches the central gauge
  // and keeps "Yesterday's High" consistent with the visible peak.
  // collectSeriesPts carries a pre-window sample forward as an
  // interpolated point at tMin so the line meets the chart's left edge
  // even when a real sensor-reading gap straddles the boundary.
  const pts = collectSeriesPts(timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, tankAvgOf);

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

  // ── Tank sub-sensor lines (only with the "All sensors" toggle) ──
  if (showAllSensors) {
    drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, 't_tank_top', '#ff9f43', 1);
    drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, 't_tank_bottom', '#b088d6', 1);
  }

  // ── Collector line (red) ──
  drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, 't_collector', '#ef5350', 1.5);

  // ── Greenhouse line (green) ──
  drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, 't_greenhouse', '#69d0c5', 1);

  // ── Outside line (blue) ──
  drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, 't_outdoor', '#42a5f5', 1);
}

// Collect visible plot points for a single series, carrying a leading-edge
// sample (the last point before tMin) forward as a linearly-interpolated
// value at tMin so the line starts at the chart's left edge even when the
// first in-window sample is several minutes late.
function collectSeriesPts(timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, key) {
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
    const x = pad.left + ((t - tMin) / graphRange) * pw;
    const y = pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph;
    pts.push({ x, y });
  }
  return pts;
}

function drawTempLine(ctx, timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, key, color, lineWidth) {
  const pts = collectSeriesPts(timeSeriesStore, tMin, tMax, graphRange, pad, pw, ph, yMin, yMax, key);
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
