// Forecast preview for the device-view Tuning thresholds section.
//
// Asks the real forecast engine (server-side: FMI weather + fitted
// thermal coefficients / ML model, see server/lib/forecast/) for two
// 48 h projections and draws them on a canvas:
//   - solid lines  — the values typed into the tuning form, sent as the
//                    `?tu=` what-if override
//   - dashed lines — the live forecast (values currently saved on the
//                    controller), i.e. plain /api/forecast
// plus predicted mode bars (charging / heating / emergency) along the
// bottom, so the operator can see what a threshold change does before
// pushing it. Recomputes (debounced) as the form is edited. A crosshair
// inspector reads off the projected values on hover.
//
// External API:
//   initTuningForecast()    — wire view/resize/inspector triggers + sync.
//   setForecastEntered(tu)  — set the typed-into-form tuning map (sparse,
//                             numeric short keys); schedules a redraw.

import { store } from '../app-state.js';
import { registerDataSource } from '../sync/registry.js';
import { getForecastEngine, setForecastEngine, onForecastEngineChange } from '../forecast.js';
import { aggregateForecastBucket } from './forecast-overlay.js';
import { drawEmergencyStripes } from './emergency-stripes.js';

// Series + mode-bar colours mirror the main history graph.
const COLORS = { tank: '#e9c349', greenhouse: '#69d0c5', outdoor: '#42a5f5' };
const MODE_FILL = { charging: 'rgba(238, 125, 119, 0.55)', heating: 'rgba(233, 195, 73, 0.55)' };
const EMERGENCY_STRIPE = 'rgba(255, 112, 67, 0.8)';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

let _enteredTu = {};    // tuning typed into the form (drives the `?tu=` override)
let _timer = null;
let _abort = null;
// Stashed geometry + data from the last draw, so the hover inspector
// can map a cursor x back to projected values. Null until first paint.
let _chart = null;

// ── Public API ───────────────────────────────────────────────────────────────

export function initTuningForecast() {
  store.subscribe('currentView', () => {
    if (store.get('currentView') === 'device') scheduleRender();
  });
  window.addEventListener('resize', () => {
    if (store.get('currentView') === 'device') scheduleRender();
  });
  wireInspector();
  wireEngineToggle();
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

// ── Engine selector ──────────────────────────────────────────────────────────

// Wires the Forecast-preview 2-way segmented switch (ML / Physics). The
// engine choice is shared app-wide via forecast.js — selecting here
// flips it for the whole app (and the Status-graph selector stays in
// sync). onForecastEngineChange fires for changes from either place, so
// the buttons and the preview both refresh.
function wireEngineToggle() {
  const seg = document.getElementById('tuning-forecast-seg');
  if (!seg) return;
  const btns = Array.from(seg.querySelectorAll('.forecast-seg-btn'));
  if (btns.length === 0) return;

  const render = () => {
    const sel = getForecastEngine();
    for (const b of btns) {
      const on = b.dataset.mode === sel;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    }
  };

  for (const b of btns) {
    b.addEventListener('click', () => setForecastEngine(b.dataset.mode));
  }
  seg.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    let idx = btns.findIndex((b) => b.dataset.mode === getForecastEngine());
    idx = e.key === 'ArrowLeft'
      ? (idx - 1 + btns.length) % btns.length
      : (idx + 1) % btns.length;
    btns[idx].focus();
    setForecastEngine(btns[idx].dataset.mode);
  });

  onForecastEngineChange(() => { render(); scheduleRender(); });
  render();
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
  hideInspector();
  showLoading(true);
  setStatus(statusEl, '');

  fetchForecasts(signal)
    .then((data) => {
      if (signal.aborted) return;
      showLoading(false);
      drawForecasts(data);
    })
    .catch((err) => {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      showLoading(false);
      _chart = null;
      clearCanvas(canvas);
      updateLegendRanges(null, null);
      setStatus(statusEl, 'Forecast unavailable: ' + err.message);
    });
}

function showLoading(on) {
  const el = document.getElementById('tuning-forecast-loading');
  if (el) el.hidden = !on;
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

// Hourly mode buckets from the engine's modeForecast — each carries the
// charging / heating / emergency fraction (0..1) of that clock hour.
function modeBucketsOf(resp, tMinMs, tMaxMs) {
  const fc = resp && resp.forecast;
  const list = fc && Array.isArray(fc.modeForecast) ? fc.modeForecast : [];
  const buckets = [];
  if (list.length === 0 || !isFinite(tMinMs) || !isFinite(tMaxMs)) return buckets;
  const HOUR = 3600000;
  for (let t = Math.floor(tMinMs / HOUR) * HOUR; t < tMaxMs; t += HOUR) {
    const agg = aggregateForecastBucket(list, t / 1000, (t + HOUR) / 1000);
    buckets.push({
      t0: t,
      t1: t + HOUR,
      charging: Math.min(1, agg.chargingHours),
      heating: Math.min(1, agg.heatingHours),
      emergency: Math.min(1, agg.emergencyHours),
    });
  }
  return buckets;
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
    _chart = null;
    hideInspector();
    clearCanvas(canvas);
    updateLegendRanges(null, null);
    setStatus(statusEl,
      'No forecast data yet — weather forecast not available for this device.');
    return;
  }
  setStatus(statusEl, '');
  updateLegendRanges(seriesRange(series.enteredTank), seriesRange(series.enteredGh));
  draw(canvas, series, entered);
}

// Min/max of a [timeMs, value] series, or null if empty.
function seriesRange(pts) {
  if (!pts || pts.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i][1];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min)) return null;
  return { min, max };
}

function updateLegendRanges(tank, gh) {
  setText('tfl-tank-range', tank ? rangeText(tank) : '');
  setText('tfl-gh-range', gh ? rangeText(gh) : '');
}

function rangeText(r) {
  return r.min.toFixed(1) + '°…' + r.max.toFixed(1) + '°';
}

function draw(canvas, series, enteredResp) {
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

  const pad = { top: 12, right: 12, bottom: 30, left: 34 };
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

  const xOf = (t) => pad.left + ((t - tMin) / (tMax - tMin)) * pw;
  const yOf = (v) => pad.top + ph - ((v - yMin) / (yMax - yMin)) * ph;

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

  drawXAxis(ctx, tMin, tMax, xOf, pad, ph, dh);

  const modeBuckets = modeBucketsOf(enteredResp, tMin, tMax);
  drawModeBars(ctx, modeBuckets, xOf, pad, ph);

  // Baseline first (dashed, faint), entered on top (solid). Outdoor is
  // weather-driven and identical for both runs — drawn once.
  drawLine(ctx, series.outdoor, xOf, yOf, COLORS.outdoor, 1, false, 0.55);
  drawLine(ctx, series.baselineTank, xOf, yOf, COLORS.tank, 2, true, 0.4);
  drawLine(ctx, series.baselineGh, xOf, yOf, COLORS.greenhouse, 1.5, true, 0.4);
  drawLine(ctx, series.enteredTank, xOf, yOf, COLORS.tank, 2, false, 0.95);
  drawLine(ctx, series.enteredGh, xOf, yOf, COLORS.greenhouse, 1.5, false, 0.95);

  // Stash geometry + data for the hover inspector.
  _chart = {
    tMin, tMax, padLeft: pad.left, pw,
    enteredTank: series.enteredTank,
    enteredGh: series.enteredGh,
    outdoor: series.outdoor,
    modeBuckets,
  };
}

// X-axis: a tick every 6 h (local time). Midnight ticks get a brighter
// day-divider line + a weekday/date label so day boundaries stand out;
// the rest get a muted HH:00 label.
function drawXAxis(ctx, tMin, tMax, xOf, pad, ph, dh) {
  const HOUR = 3600000;
  ctx.textBaseline = 'alphabetic';
  for (let t = Math.ceil(tMin / HOUR) * HOUR; t <= tMax; t += HOUR) {
    const d = new Date(t);
    const h = d.getHours();
    if (h % 6 !== 0) continue;
    const x = xOf(t);
    const midnight = h === 0;
    ctx.strokeStyle = midnight ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + ph);
    ctx.stroke();
    ctx.textAlign = 'center';
    if (midnight) {
      ctx.fillStyle = '#e6e8ec';
      ctx.fillText(WEEKDAYS[d.getDay()] + ' ' + d.getDate(), x, dh - 4);
    } else {
      ctx.fillStyle = '#7f8694';
      ctx.fillText((h < 10 ? '0' : '') + h + ':00', x, dh - 4);
    }
  }
}

// Predicted mode bars along the bottom — charging (red, bottom), heating
// (gold, middle), emergency (orange stripes). Mirrors the main history
// graph's duty-cycle stack.
function drawModeBars(ctx, buckets, xOf, pad, ph) {
  if (!buckets || buckets.length === 0) return;
  const barAreaH = ph * 0.28;
  const barY0 = pad.top + ph;
  ctx.save();
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const x0 = xOf(b.t0);
    const x1 = xOf(b.t1);
    const w = Math.max(1, x1 - x0 - 1);
    let stackH = 0;
    if (b.charging > 0) {
      const bh = b.charging * barAreaH;
      ctx.fillStyle = MODE_FILL.charging;
      ctx.fillRect(x0, barY0 - bh, w, bh);
      stackH += bh;
    }
    if (b.heating > 0) {
      const bh = b.heating * barAreaH;
      ctx.fillStyle = MODE_FILL.heating;
      ctx.fillRect(x0, barY0 - stackH - bh, w, bh);
    }
    if (b.emergency > 0) {
      const bh = b.emergency * barAreaH;
      drawEmergencyStripes(ctx, x0, barY0 - bh, w, bh, EMERGENCY_STRIPE);
    }
  }
  ctx.restore();
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

// ── Hover inspector ──────────────────────────────────────────────────────────

function wireInspector() {
  const canvas = document.getElementById('tuning-forecast-chart');
  if (!canvas) return;
  const atClientX = (clientX) => clientX - canvas.getBoundingClientRect().left;
  canvas.addEventListener('mousemove', (e) => moveInspector(atClientX(e.clientX)));
  canvas.addEventListener('mouseleave', hideInspector);
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches[0]) moveInspector(atClientX(e.touches[0].clientX));
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches[0]) moveInspector(atClientX(e.touches[0].clientX));
  }, { passive: true });
  canvas.addEventListener('touchend', hideInspector);
}

function moveInspector(x) {
  const c = _chart;
  const tooltip = document.getElementById('tuning-forecast-inspector');
  const crosshair = document.getElementById('tuning-forecast-crosshair');
  const container = document.getElementById('tuning-forecast-container');
  if (!c || !tooltip || !crosshair || !container) return;

  const frac = (x - c.padLeft) / c.pw;
  if (frac < 0 || frac > 1) { hideInspector(); return; }
  const t = c.tMin + frac * (c.tMax - c.tMin);

  setText('tfi-time', formatStamp(t));
  setText('tfi-tank', fmtTemp(interpAt(c.enteredTank, t)));
  setText('tfi-gh', fmtTemp(interpAt(c.enteredGh, t)));
  setText('tfi-out', fmtTemp(interpAt(c.outdoor, t)));
  setText('tfi-mode', modeLabelAt(c.modeBuckets, t));

  crosshair.style.display = 'block';
  crosshair.style.left = x + 'px';
  tooltip.style.display = 'block';
  const containerW = container.offsetWidth;
  if (x > containerW * 0.6) {
    tooltip.style.left = 'auto';
    tooltip.style.right = (containerW - x + 12) + 'px';
  } else {
    tooltip.style.left = (x + 12) + 'px';
    tooltip.style.right = 'auto';
  }
}

function hideInspector() {
  const tooltip = document.getElementById('tuning-forecast-inspector');
  const crosshair = document.getElementById('tuning-forecast-crosshair');
  if (tooltip) tooltip.style.display = 'none';
  if (crosshair) crosshair.style.display = 'none';
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function fmtTemp(v) { return isNum(v) ? v.toFixed(1) + '°C' : '—'; }

function formatStamp(t) {
  const d = new Date(t);
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  return WEEKDAYS[d.getDay()] + ' ' + d.getDate() + ', ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

// Linear interpolation of a sorted [timeMs, value] series at time t.
function interpAt(series, t) {
  if (!series || series.length === 0) return null;
  if (t <= series[0][0]) return series[0][1];
  const last = series[series.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 1; i < series.length; i++) {
    if (series[i][0] >= t) {
      const a = series[i - 1];
      const b = series[i];
      if (b[0] === a[0]) return b[1];
      return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
    }
  }
  return last[1];
}

// Dominant predicted mode for the bucket containing time t.
function modeLabelAt(buckets, t) {
  if (!buckets) return '—';
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (t >= b.t0 && t < b.t1) {
      const max = Math.max(b.charging, b.heating, b.emergency);
      if (max <= 0) return 'Idle';
      if (b.emergency === max) return 'Emergency heating';
      if (b.heating === max) return 'Greenhouse heating';
      return 'Solar charging';
    }
  }
  return '—';
}
