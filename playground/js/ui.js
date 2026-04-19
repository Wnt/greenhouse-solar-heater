/**
 * UI utilities for the playground.
 * Shared slider creation, SVG manipulation, and chart helpers.
 */

/** Create a labeled slider control.
 *  Uses a custom touch-friendly slider that doesn't reset when
 *  the finger drifts vertically outside the track area.
 *  Supports logarithmic mode via opts.log (value mapped on log scale).
 *  Supports discrete steps via opts.steps (array of allowed values).
 */
export function createSlider(container, { id, label, min, max, step, value, unit, onChange, log, steps }) {
  const group = document.createElement('div');
  group.className = 'control-group';

  const row = document.createElement('div');
  row.className = 'control-row';

  const lbl = document.createElement('label');
  lbl.htmlFor = id;
  lbl.textContent = label;

  // Custom slider track + thumb
  const track = document.createElement('div');
  track.className = 'custom-slider-track';
  track.id = id;

  const fill = document.createElement('div');
  fill.className = 'custom-slider-fill';

  const thumb = document.createElement('div');
  thumb.className = 'custom-slider-thumb';

  track.appendChild(fill);
  track.appendChild(thumb);

  const val = document.createElement('span');
  val.className = 'value';
  val.id = id + '-val';
  val.textContent = formatSliderValue(value, unit, steps);

  // Value <-> fraction conversion
  function valToFrac(v) {
    if (steps) return steps.indexOf(v) / (steps.length - 1);
    if (log) return Math.log(v / min) / Math.log(max / min);
    return (v - min) / (max - min);
  }

  function fracToVal(f) {
    f = Math.max(0, Math.min(1, f));
    if (steps) {
      const idx = Math.round(f * (steps.length - 1));
      return steps[idx];
    }
    if (log) {
      return Math.round(min * Math.pow(max / min, f));
    }
    const raw = min + f * (max - min);
    return Math.round(raw / (step || 1)) * (step || 1);
  }

  let currentValue = value;

  function setPosition(frac) {
    frac = Math.max(0, Math.min(1, frac));
    const pct = frac * 100;
    fill.style.width = pct + '%';
    thumb.style.left = pct + '%';
  }

  function update(newVal) {
    currentValue = newVal;
    setPosition(valToFrac(newVal));
    val.textContent = formatSliderValue(newVal, unit, steps);
    if (onChange) onChange(newVal);
  }

  // Initialize position
  setPosition(valToFrac(value));

  // Expose update on the DOM element for programmatic access (e.g. tests)
  track._sliderUpdate = update;

  // Pointer handling — works for both mouse and touch
  let dragging = false;

  function getFrac(clientX) {
    const rect = track.getBoundingClientRect();
    return (clientX - rect.left) / rect.width;
  }

  function onStart(clientX) {
    dragging = true;
    thumb.classList.add('active');
    update(fracToVal(getFrac(clientX)));
  }

  function onMove(clientX) {
    if (!dragging) return;
    update(fracToVal(getFrac(clientX)));
  }

  function onEnd() {
    dragging = false;
    thumb.classList.remove('active');
  }

  // Mouse events
  track.addEventListener('mousedown', (e) => { e.preventDefault(); onStart(e.clientX); });
  window.addEventListener('mousemove', (e) => { if (dragging) onMove(e.clientX); });
  window.addEventListener('mouseup', onEnd);

  // Touch events — passive: false prevents scroll cancellation
  track.addEventListener('touchstart', (e) => {
    e.preventDefault();
    onStart(e.touches[0].clientX);
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (dragging) {
      e.preventDefault();
      onMove(e.touches[0].clientX);
    }
  }, { passive: false });
  window.addEventListener('touchend', onEnd);
  window.addEventListener('touchcancel', onEnd);

  group.appendChild(lbl);
  row.appendChild(track);
  row.appendChild(val);
  group.appendChild(row);
  container.appendChild(group);

  return { track, val, group, update };
}

function formatSliderValue(v, unit, steps) {
  if (steps) return v.toLocaleString() + (unit || '');
  const display = Number.isInteger(v) ? v : parseFloat(v.toFixed(1));
  return display + (unit || '');
}

/** Format seconds as HH:MM:SS */
export function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// ── History-chart x-axis ticks ──
// The previous drawHistoryGraph hard-coded a 1–4 h step, so 7d / 30d / 1y
// ranges produced hundreds of "HH:00" labels packed into an illegible bar.
// These two helpers replace that: pickTickStep chooses a step that keeps the
// label count under a readability budget, and formatTick picks a format
// suited to the step size (HH:MM for sub-day, D.M for multi-day, MMM YY for
// month-spanning).

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;

// Candidate step sizes in seconds, smallest to largest. The first one that
// satisfies the label budget wins — preserves the "round number" feel (1 h,
// 6 h, 1 day, 1 week, 1 month, etc.).
const TICK_STEPS = [
  5 * 60,               // 5 min
  15 * 60,
  30 * 60,
  HOUR_SECONDS,         // 1 h
  2 * HOUR_SECONDS,
  3 * HOUR_SECONDS,
  6 * HOUR_SECONDS,
  12 * HOUR_SECONDS,
  DAY_SECONDS,          // 1 d
  2 * DAY_SECONDS,
  7 * DAY_SECONDS,      // 1 w
  14 * DAY_SECONDS,
  30 * DAY_SECONDS,     // ~1 month
  60 * DAY_SECONDS,
  90 * DAY_SECONDS,
  180 * DAY_SECONDS,
  365 * DAY_SECONDS,    // 1 y — last resort
];

/**
 * Pick a tick step (seconds) for a time axis so the number of visible labels
 * stays within ~plotWidthPx / minPxPerLabel.
 *
 * @param {number} rangeSec      span of the axis in seconds
 * @param {number} plotWidthPx   pixel width of the plot area
 * @param {number} [minPxPerLabel=72]  rough minimum pixels per label
 */
export function pickTickStep(rangeSec, plotWidthPx, minPxPerLabel = 72) {
  const budget = Math.max(3, Math.floor(plotWidthPx / minPxPerLabel));
  for (const step of TICK_STEPS) {
    if (rangeSec / step <= budget) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Format a tick label for an epoch-seconds timestamp. The step determines the
 * granularity: sub-day ⇒ HH:MM, single-to-twoweek ⇒ D.M, month+ ⇒ MMM YY.
 *
 * @param {number} tEpochSec  unix time in seconds
 * @param {number} stepSec    the tick step returned by pickTickStep
 */
export function formatTick(tEpochSec, stepSec) {
  const d = new Date(tEpochSec * 1000);
  if (stepSec < DAY_SECONDS) {
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    return `${hh}:${mm}`;
  }
  if (stepSec < 30 * DAY_SECONDS) {
    return `${d.getDate()}.${d.getMonth() + 1}.`;
  }
  return `${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear() % 100}`;
}

/** Simple rolling time-series data store */
export class TimeSeriesStore {
  constructor(maxPoints = 500) {
    this.maxPoints = maxPoints;
    this.series = {};
    this.times = [];
  }

  addPoint(time, values) {
    this.times.push(time);
    for (const [key, val] of Object.entries(values)) {
      if (!this.series[key]) this.series[key] = [];
      this.series[key].push(val);
    }

    // Trim if needed
    if (this.times.length > this.maxPoints) {
      const trim = this.times.length - this.maxPoints;
      this.times.splice(0, trim);
      for (const key of Object.keys(this.series)) {
        this.series[key].splice(0, trim);
      }
    }
  }

  reset() {
    this.times = [];
    this.series = {};
  }
}

/** Draw a simple line chart on a canvas */
export function drawChart(canvas, store, config = {}) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width = canvas.offsetWidth * (window.devicePixelRatio || 1);
  const h = canvas.height = canvas.offsetHeight * (window.devicePixelRatio || 1);
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  const dw = canvas.offsetWidth;
  const dh = canvas.offsetHeight;

  ctx.clearRect(0, 0, dw, dh);

  const padding = { top: 20, right: 20, bottom: 30, left: 50 };
  const plotW = dw - padding.left - padding.right;
  const plotH = dh - padding.top - padding.bottom;

  if (store.times.length < 2) return;

  // Auto-range
  const tMin = store.times[0];
  const tMax = store.times[store.times.length - 1];
  let yMin = config.yMin ?? Infinity;
  let yMax = config.yMax ?? -Infinity;

  const seriesKeys = config.series || Object.keys(store.series);
  for (const key of seriesKeys) {
    const data = store.series[key];
    if (!data) continue;
    for (const v of data) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }

  if (yMin === yMax) { yMin -= 5; yMax += 5; }
  const yPad = (yMax - yMin) * 0.1;
  yMin -= yPad;
  yMax += yPad;

  // Grid — read theme colors from CSS variables
  var style = getComputedStyle(document.documentElement);
  var gridColor = style.getPropertyValue('--border').trim() || '#e2e6ea';
  var labelColor = style.getPropertyValue('--text-muted').trim() || '#64748b';

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  ctx.font = '10px Manrope, sans-serif';
  ctx.fillStyle = labelColor;

  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + plotH - (i / yTicks) * plotH;
    const val = yMin + (i / yTicks) * (yMax - yMin);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + plotW, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(val.toFixed(0) + '°C', padding.left - 4, y + 3);
  }

  // Time axis
  const tRange = tMax - tMin;
  const xTicks = 5;
  for (let i = 0; i <= xTicks; i++) {
    const x = padding.left + (i / xTicks) * plotW;
    const t = tMin + (i / xTicks) * tRange;
    ctx.textAlign = 'center';
    ctx.fillText(formatTime(t), x, dh - 5);
  }

  // Lines
  const colors = config.colors || {
    t_tank_top: '#ee7d77',
    t_tank_bottom: '#43aea4',
    t_collector: '#e9c349',
    t_greenhouse: '#69d0c5',
    t_outdoor: '#a5abb9',
  };

  for (const key of seriesKeys) {
    const data = store.series[key];
    if (!data || data.length < 2) continue;

    ctx.beginPath();
    ctx.strokeStyle = colors[key] || '#42a5f5';
    ctx.lineWidth = 1.5;

    for (let i = 0; i < data.length; i++) {
      const x = padding.left + ((store.times[i] - tMin) / tRange) * plotW;
      const y = padding.top + plotH - ((data[i] - yMin) / (yMax - yMin)) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // Legend
  ctx.font = '11px Manrope, sans-serif';
  let lx = padding.left + 8;
  for (const key of seriesKeys) {
    const color = colors[key] || '#42a5f5';
    const label = config.labels?.[key] || key.replace('t_', '').replace(/_/g, ' ');
    ctx.fillStyle = color;
    ctx.fillRect(lx, padding.top + 2, 12, 3);
    ctx.fillText(label, lx + 16, padding.top + 8);
    lx += ctx.measureText(label).width + 30;
  }
}

/** Mode badge color class */
export function modeBadgeClass(mode) {
  return 'mode-badge mode-' + (mode || 'idle');
}
