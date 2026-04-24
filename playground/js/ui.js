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
  let dragging = false;

  function setPosition(frac) {
    frac = Math.max(0, Math.min(1, frac));
    const pct = frac * 100;
    fill.style.width = pct + '%';
    thumb.style.left = pct + '%';
  }

  function update(newVal) {
    // Haptic tick when the discrete value changes during a user drag.
    // Suppressed for programmatic updates so cross-slider sync (e.g.
    // tank-top <-> tank-bot clamping) stays silent.
    if (dragging && newVal !== currentValue) {
      try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
    }
    currentValue = newVal;
    setPosition(valToFrac(newVal));
    val.textContent = formatSliderValue(newVal, unit, steps);
    if (onChange) onChange(newVal);
  }

  // Initialize position
  setPosition(valToFrac(value));

  // Expose update on the DOM element for programmatic access (e.g. tests)
  track._sliderUpdate = update;

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
const HELSINKI_TZ = 'Europe/Helsinki';
const fmtTickClock = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: HELSINKI_TZ,
});
const fmtTickParts = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric', month: 'numeric', day: 'numeric', timeZone: HELSINKI_TZ,
});
function tickDateParts(d) {
  const out = {};
  for (const p of fmtTickParts.formatToParts(d)) {
    if (p.type === 'literal') continue;
    out[p.type] = parseInt(p.value, 10);
  }
  return out;
}

/**
 * Pick the bucket size (seconds) for the duty-cycle mode bars on the history
 * chart. Must divide the range cleanly and yield a readable number of bars:
 *
 *   - 1h range  → 15 min (4 bars — the operator asked for this explicitly)
 *   - ≤ 6h      → 30 min
 *   - ≤ 48h     → 1 h  (previous fixed default)
 *   - > 48h     → 1 day
 */
export function pickBucketSize(rangeSec) {
  if (rangeSec <= HOUR_SECONDS) return 15 * 60;
  if (rangeSec <= 6 * HOUR_SECONDS) return 30 * 60;
  if (rangeSec <= 48 * HOUR_SECONDS) return HOUR_SECONDS;
  return DAY_SECONDS;
}

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
    return fmtTickClock.format(d);
  }
  const p = tickDateParts(d);
  if (stepSec < 30 * DAY_SECONDS) {
    return `${p.day}.${p.month}.`;
  }
  return `${MONTHS_SHORT[p.month - 1]} ${p.year % 100}`;
}

