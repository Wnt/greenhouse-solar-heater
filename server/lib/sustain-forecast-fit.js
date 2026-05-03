'use strict';

// sustain-forecast-fit.js — empirical-coefficient fitting for the
// 48 h sustain forecast engine. Pure functions, no I/O.
//
// Split out of sustain-forecast.js purely to keep both files under
// the 600-line cap. The engine imports the fit functions and the
// shared Helsinki-time helpers (so all hour-of-day computation goes
// through the same path).

// ── Physical constants (shared with engine) ──
const TANK_THERMAL_MASS_J_PER_K = 300 * 4186;
const GH_THERMAL_MASS_J_PER_K   = 200 * 1.2 * 1005;

// ── Fit defaults ──
const DEFAULT_TANK_LEAKAGE_W_PER_K = 3.0;
const DEFAULT_GH_LOSS_W_PER_K_BASE = 25.0;
const DEFAULT_WIND_FACTOR          = 0.05;

// Per-hour-of-day "no data" mask: assume sun is effective 10..16 local time.
const DEFAULT_SOLAR_EFFECTIVENESS = (function () {
  const mask = new Array(24);
  for (let h = 0; h < 24; h++) mask[h] = (h >= 10 && h <= 16) ? 1.0 : 0;
  return mask;
}());

// Fit thresholds.
const MIN_IDLE_BUCKET_MINUTES = 20;
const MIN_BUCKETS_FOR_FIT     = 5;
const MIN_ROWS_PER_HOUR_FOR_SHADE = 3;
const MIN_PEAK_EXCESS_K       = 5;

// ── Helsinki TZ helpers (deterministic across server timezones) ──
const HELSINKI_HOUR_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', hour12: false, hour: '2-digit',
});
const HELSINKI_HHMM_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', hour12: false, hour: '2-digit', minute: '2-digit',
});
function helsinkiHour(date) {
  const h = parseInt(HELSINKI_HOUR_FMT.format(date), 10);
  return h === 24 ? 0 : h;
}
function helsinkiHHMM(date) {
  return HELSINKI_HHMM_FMT.format(date);
}

// ── Least-squares slope through origin: slope = Σ(xi·yi) / Σ(xi²) ──
function slopeThruOrigin(xs, ys) {
  let sumXY = 0, sumX2 = 0;
  for (let i = 0; i < xs.length; i++) {
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i];
  }
  return sumX2 === 0 ? null : sumXY / sumX2;
}

// ── p-th percentile (p in [0,1]) of a numeric array ──
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = arr.slice().sort(function (a, b) { return a - b; });
  const idx = p * (sorted.length - 1);
  const lo  = Math.floor(idx);
  const hi  = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

/**
 * Derive per-hour-of-day solar effectiveness from collector history.
 *
 * Algorithm:
 *   1. Group readings by Helsinki hour-of-day.
 *   2. Per row: collectorExcess = collector − outdoor.
 *   3. Per hour: 80th-percentile of collectorExcess (sunny-day envelope).
 *   4. Normalise by global peak → values in [0, 1].
 *   5. Clamp values < 0.1 to 0 (kills pre-sunrise warm-up noise).
 *
 * Falls back to the flat 10..16 mask when:
 *   - Any hour has fewer than MIN_ROWS_PER_HOUR_FOR_SHADE rows, OR
 *   - Global peak excess < MIN_PEAK_EXCESS_K (no real sun observed).
 */
function fitSolarEffectivenessByHour(history) {
  if (!history || !Array.isArray(history.readings) || history.readings.length === 0) {
    return DEFAULT_SOLAR_EFFECTIVENESS.slice();
  }

  const readings = history.readings;
  const byHour = [];
  for (let h = 0; h < 24; h++) byHour.push([]);

  for (let i = 0; i < readings.length; i++) {
    const r = readings[i];
    if (typeof r.collector !== 'number' || typeof r.outdoor !== 'number') continue;
    const ts = r.ts instanceof Date ? r.ts : new Date(r.ts);
    const hour = helsinkiHour(ts);
    byHour[hour].push(r.collector - r.outdoor);
  }

  for (let h = 0; h < 24; h++) {
    if (byHour[h].length < MIN_ROWS_PER_HOUR_FOR_SHADE) {
      return DEFAULT_SOLAR_EFFECTIVENESS.slice();
    }
  }

  const percentile80 = new Array(24);
  for (let h = 0; h < 24; h++) percentile80[h] = percentile(byHour[h], 0.80);

  let peakExcess = percentile80[0];
  for (let h = 1; h < 24; h++) {
    if (percentile80[h] > peakExcess) peakExcess = percentile80[h];
  }
  if (peakExcess < MIN_PEAK_EXCESS_K) return DEFAULT_SOLAR_EFFECTIVENESS.slice();

  const mask = new Array(24);
  for (let h = 0; h < 24; h++) {
    let v = percentile80[h] / peakExcess;
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    if (v < 0.1) v = 0;
    mask[h] = v;
  }
  return mask;
}

/**
 * Fit empirical thermal coefficients from historical sensor + mode data.
 */
function fitEmpiricalCoefficients(history) {
  const defaults = {
    tankLeakageWPerK:         DEFAULT_TANK_LEAKAGE_W_PER_K,
    greenhouseLossWPerKBase:  DEFAULT_GH_LOSS_W_PER_K_BASE,
    windFactor:               DEFAULT_WIND_FACTOR,
    solarEffectivenessByHour: DEFAULT_SOLAR_EFFECTIVENESS.slice(),
    usedDefaults:             true,
  };

  if (!history || !Array.isArray(history.readings) || history.readings.length < 2) {
    return defaults;
  }

  const readings = history.readings;
  const modes    = (history.modes || []).slice();

  // Forward-walking mode cursor: label each reading with its current mode.
  const modeLabels = new Array(readings.length);
  let cursor = 0;
  let currentMode = 'idle';
  while (cursor < modes.length) {
    const tsMs = modes[cursor].ts instanceof Date ? modes[cursor].ts.getTime() : Number(modes[cursor].ts);
    const r0Ms = readings[0].ts instanceof Date ? readings[0].ts.getTime() : Number(readings[0].ts);
    if (tsMs <= r0Ms) { currentMode = modes[cursor].mode; cursor++; }
    else break;
  }
  modeLabels[0] = currentMode;
  for (let i = 1; i < readings.length; i++) {
    const rMs = readings[i].ts instanceof Date ? readings[i].ts.getTime() : Number(readings[i].ts);
    while (cursor < modes.length) {
      const mMs = modes[cursor].ts instanceof Date ? modes[cursor].ts.getTime() : Number(modes[cursor].ts);
      if (mMs <= rMs) { currentMode = modes[cursor].mode; cursor++; }
      else break;
    }
    modeLabels[i] = currentMode;
  }

  // Bucket consecutive idle stretches and emit one (deltaK, powerW) sample per
  // consecutive reading pair within each ≥ MIN_IDLE_BUCKET_MINUTES bucket.
  const tankXs = [], tankYs = [];
  const ghXs   = [], ghYs   = [];

  let bucketStart = -1;
  for (let j = 0; j <= readings.length; j++) {
    const isIdle = j < readings.length && modeLabels[j] === 'idle';
    if (isIdle && bucketStart === -1) {
      bucketStart = j;
    } else if (!isIdle && bucketStart !== -1) {
      const bucketEnd = j - 1;
      const r0span = readings[bucketStart];
      const r1span = readings[bucketEnd];
      const t0SpanMs = r0span.ts instanceof Date ? r0span.ts.getTime() : Number(r0span.ts);
      const t1SpanMs = r1span.ts instanceof Date ? r1span.ts.getTime() : Number(r1span.ts);
      const spanDtMin = (t1SpanMs - t0SpanMs) / 60000;

      if (spanDtMin >= MIN_IDLE_BUCKET_MINUTES) {
        for (let p = bucketStart; p < bucketEnd; p++) {
          const r0 = readings[p];
          const r1 = readings[p + 1];
          const t0Ms = r0.ts instanceof Date ? r0.ts.getTime() : Number(r0.ts);
          const t1Ms = r1.ts instanceof Date ? r1.ts.getTime() : Number(r1.ts);
          const dtMs = t1Ms - t0Ms;
          if (dtMs <= 0) continue;
          const dtSec = dtMs / 1000;

          const tankAvg0 = (r0.tankTop + r0.tankBottom) / 2;
          const tankAvg1 = (r1.tankTop + r1.tankBottom) / 2;
          const ghMid    = ((r0.greenhouse || 0) + (r1.greenhouse || 0)) / 2;
          const dTankAvg = tankAvg1 - tankAvg0;
          const powerW   = (dTankAvg / dtSec) * TANK_THERMAL_MASS_J_PER_K;
          const deltaK   = ((tankAvg0 + tankAvg1) / 2) - ghMid;
          if (deltaK > 2 && isFinite(powerW) && isFinite(deltaK)) {
            tankXs.push(deltaK);
            tankYs.push(-powerW);
          }

          if (r0.outdoor !== undefined && r1.outdoor !== undefined &&
              r0.greenhouse !== undefined && r1.greenhouse !== undefined) {
            const ghAvgPair = (r0.greenhouse + r1.greenhouse) / 2;
            const outAvg    = (r0.outdoor + r1.outdoor) / 2;
            const dGhAvg    = r1.greenhouse - r0.greenhouse;
            const ghPowerW  = (dGhAvg / dtSec) * GH_THERMAL_MASS_J_PER_K;
            const ghDeltaK  = ghAvgPair - outAvg;
            if (ghDeltaK > 1 && isFinite(ghPowerW) && isFinite(ghDeltaK)) {
              ghXs.push(ghDeltaK);
              ghYs.push(-ghPowerW);
            }
          }
        }
      }
      bucketStart = -1;
    }
  }

  if (tankXs.length < MIN_BUCKETS_FOR_FIT && ghXs.length < MIN_BUCKETS_FOR_FIT) {
    return defaults;
  }

  const tankSlope = tankXs.length >= MIN_BUCKETS_FOR_FIT ? slopeThruOrigin(tankXs, tankYs) : null;
  const ghSlope   = ghXs.length   >= MIN_BUCKETS_FOR_FIT ? slopeThruOrigin(ghXs, ghYs)   : null;

  return {
    tankLeakageWPerK:         tankSlope !== null && tankSlope > 0 ? tankSlope : DEFAULT_TANK_LEAKAGE_W_PER_K,
    greenhouseLossWPerKBase:  ghSlope   !== null && ghSlope   > 0 ? ghSlope   : DEFAULT_GH_LOSS_W_PER_K_BASE,
    windFactor:               DEFAULT_WIND_FACTOR,
    solarEffectivenessByHour: fitSolarEffectivenessByHour(history),
    usedDefaults:             (tankSlope === null && ghSlope === null),
  };
}

module.exports = {
  // Constants the engine also needs.
  TANK_THERMAL_MASS_J_PER_K,
  GH_THERMAL_MASS_J_PER_K,
  DEFAULT_SOLAR_EFFECTIVENESS,
  // TZ helpers.
  helsinkiHour,
  helsinkiHHMM,
  // Fit functions.
  fitSolarEffectivenessByHour,
  fitEmpiricalCoefficients,
};
