// Forecast preview for the device-view Tuning thresholds section.
//
// Asks the real forecast engine (server-side: FMI weather + fitted
// thermal coefficients / ML model, see server/lib/forecast/) for two
// 48 h projections and draws them on a canvas:
//   - solid lines  — the values typed into the tuning form, sent as the
//                    `?tu=` what-if override
//   - dashed lines — the live forecast (values currently saved on the
//                    controller), i.e. plain /api/forecast
// so the operator can see what a threshold change does before pushing
// it. Recomputes (debounced) as the form is edited.
//
// External API:
//   initTuningForecast()    — wire view/resize triggers + sync source.
//   setForecastEntered(tu)  — set the typed-into-form tuning map (sparse,
//                             numeric short keys); schedules a redraw.

import { store } from '../app-state.js';
import { registerDataSource } from '../sync/registry.js';
import { getForecastEngine } from '../forecast.js';

// Series colours mirror the main history graph.
const COLORS = { tank: '#e9c349', greenhouse: '#69d0c5', outdoor: '#42a5f5' };

let _enteredTu = {};    // tuning typed into the form (drives the `?tu=` override)
let _timer = null;
let _abort = null;

// ── Public API ───────────────────────────────────────────────────────────────

export function initTuningForecast() {
  store.subscribe('currentView', () => {
    if (store.get('currentView') === 'device') scheduleRender();
  });
  window.addEventListener('resize', () => {
    if (store.get('currentView') === 'device') scheduleRender();
  });
  // Refresh on Android resume / tab focus / network recovery / periodic
  // resync — the underlying weather forecast updates every 30 min.
  registerDataSource({
    id: 'tuning-forecast',
    isActive: () => store.get('phase') === 'live' && store.get('currentView') === 'device',
    fetch: (signal) => fetchForecasts(signal),
    applyToStore: (data) => drawForecasts(data),
  });
}

export function setForecastEntered(tu) {
  _enteredTu = tu || {};
  scheduleRender();
}

// ── Render orchestration ─────────────────────────────────────────────────────

function scheduleRender() {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => { _timer = null; render(); }, 350);
}

function render() {
  const canvas = document.getElementById('tuning-forecast-chart');
  const statusEl = document.getElementById('tuning-forecast-status');
  if (!canvas) return;
  // Skip while the device view is hidden — a display:none canvas has no
  // layout size. The currentView subscription redraws on entry.
  if (canvas.offsetWidth === 0) return;

  if (_abort) _abort.abort();
  _abort = new AbortController();
  const signal = _abort.signal;
  setStatus(statusEl, 'Computing forecast…');

  fetchForecasts(signal)
    .then((data) => {
      if (signal.aborted) return;
      drawForecasts(data);
    })
    .catch((err) => {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      clearCanvas(canvas);
      setStatus(statusEl, 'Forecast unavailable: ' + err.message);
    });
}

// Build the /api/forecast URL — engine-aware, with an optional `tu`
// what-if override. Mirrors playground/js/forecast.js's engine choice.
function forecastUrl(tu) {
  const params = new URLSearchParams();
  if (getForecastEngine() === 'ml') params.set('engine', 'ml');
  if (tu) params.set('tu', JSON.stringify(tu));
  const qs = params.toString();
  return '/api/forecast' + (qs ? '?' + qs : '');
}

function fetchOne(url, signal) {
  return fetch(url, { signal }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

// Fetch the baseline (live device-config tuning) and the entered
// (what-if `?tu=`) forecasts in parallel.
function fetchForecasts(signal) {
  return Promise.all([
    fetchOne(forecastUrl(null), signal),
    fetchOne(forecastUrl(_enteredTu), signal),
  ]).then(([baseline, entered]) => ({ baseline, entered }));
}

// ── Series extraction ────────────────────────────────────────────────────────

function isNum(v) { return typeof v === 'number' && !Number.isNaN(v); }

// Pull a [timeMs, value] series out of an array of forecast points.
function seriesOf(arr, tsKey, valKey) {
  const out = [];
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < arr.length; i++) {
    const t = Date.parse(arr[i][tsKey]);
    const v = arr[i][valKey];
    if (!Number.isNaN(t) && isNum(v)) out.push([t, v]);
  }
  return out;
}

function tankSeries(resp) {
  const fc = resp && resp.forecast;
  return fc ? seriesOf(fc.tankTrajectory, 'ts', 'avg') : [];
}
function greenhouseSeries(resp) {
  const fc = resp && resp.forecast;
  return fc ? seriesOf(fc.greenhouseTrajectory, 'ts', 'temp') : [];
}
function outdoorSeries(resp) {
  return resp ? seriesOf(resp.weather, 'validAt', 'temperature') : [];
}

// ── Canvas rendering ─────────────────────────────────────────────────────────

function setStatus(el, text) {
  if (el) el.textContent = text;
}

function clearCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.offsetWidth * dpr;
  canvas.height = canvas.offsetHeight * dpr;
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
}

function drawForecasts(data) {
  const canvas = document.getElementById('tuning-forecast-chart');
  const statusEl = document.getElementById('tuning-forecast-status');
  if (!canvas || canvas.offsetWidth === 0) return;

  const entered = data && data.entered;
  const baseline = data && data.baseline;

  const series = {
    enteredTank: tankSeries(entered),
    enteredGh: greenhouseSeries(entered),
    baselineTank: tankSeries(baseline),
    baselineGh: greenhouseSeries(baseline),
    outdoor: outdoorSeries(entered),
  };

  if (series.enteredTank.length < 2 && series.enteredGh.length < 2) {
    clearCanvas(canvas);
    setStatus(statusEl,
      'No forecast data yet — weather forecast not available for this device.');
    return;
  }
  setStatus(statusEl, '');
  draw(canvas, series);
}

function draw(canvas, series) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const dw = canvas.offsetWidth;
  const dh = canvas.offsetHeight;
  canvas.width = dw * dpr;
  canvas.height = dh * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, dw, dh);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const pad = { top: 12, right: 12, bottom: 22, left: 34 };
  const pw = dw - pad.left - pad.right;
  const ph = dh - pad.top - pad.bottom;
  if (pw <= 0 || ph <= 0) return;

  const all = [
    series.enteredTank, series.enteredGh,
    series.baselineTank, series.baselineGh, series.outdoor,
  ];

  // Time + temperature range across every plotted series.
  let tMin = Infinity;
  let tMax = -Infinity;
  let lo = Infinity;
  let hi = -Infinity;
  for (let s = 0; s < all.length; s++) {
    for (let i = 0; i < all[s].length; i++) {
      const t = all[s][i][0];
      const v = all[s][i][1];
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!isFinite(tMin) || !isFinite(lo) || tMax <= tMin) return;
  if (hi - lo < 10) hi = lo + 10;
  const span = hi - lo;
  const yMin = Math.floor((lo - span * 0.08) / 5) * 5;
  const yMax = Math.ceil((hi + span * 0.08) / 5) * 5;

  // Grid lines + Y-axis labels.
  ctx.font = '10px Manrope, sans-serif';
  ctx.fillStyle = '#a5abb9';
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const frac = i / 4;
    const y = pad.top + ph - frac * ph;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + pw, y);
    ctx.stroke();
    ctx.fillText(Math.round(yMin + frac * (yMax - yMin)) + '°', pad.left - 4, y);
  }

  // X-axis labels — hour-of-day every 12 h.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  const HOUR = 3600 * 1000;
  const firstTick = Math.ceil(tMin / (12 * HOUR)) * 12 * HOUR;
  for (let t = firstTick; t <= tMax; t += 12 * HOUR) {
    const x = pad.left + ((t - tMin) / (tMax - tMin)) * pw;
    const h = new Date(t).getHours();
    ctx.fillText((h < 10 ? '0' : '') + h + ':00', x, dh - 6);
  }

  const xOf = (t) => pad.left + ((t - tMin) / (tMax - tMin)) * pw;
  const yOf = (v) => pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

  // Baseline first (dashed, faint), entered on top (solid). Outdoor is
  // weather-driven and identical for both runs — drawn once.
  drawLine(ctx, series.outdoor, xOf, yOf, COLORS.outdoor, 1, false, 0.55);
  drawLine(ctx, series.baselineTank, xOf, yOf, COLORS.tank, 2, true, 0.4);
  drawLine(ctx, series.baselineGh, xOf, yOf, COLORS.greenhouse, 1.5, true, 0.4);
  drawLine(ctx, series.enteredTank, xOf, yOf, COLORS.tank, 2, false, 0.95);
  drawLine(ctx, series.enteredGh, xOf, yOf, COLORS.greenhouse, 1.5, false, 0.95);
}

function drawLine(ctx, pts, xOf, yOf, color, width, dashed, alpha) {
  if (pts.length < 2) return;
  ctx.save();
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = alpha;
  if (dashed) ctx.setLineDash([4, 3]);
  ctx.moveTo(xOf(pts[0][0]), yOf(pts[0][1]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(xOf(pts[i][0]), yOf(pts[i][1]));
  ctx.stroke();
  ctx.restore();
}
