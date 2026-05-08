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

// ── Fit defaults ──
const DEFAULT_TANK_LEAKAGE_W_PER_K = 3.0;

// Fit thresholds.
const MIN_IDLE_BUCKET_MINUTES = 20;
const MIN_BUCKETS_FOR_FIT     = 5;
// GH-air fits run on far fewer rows than the tank/heater fits because
// they need radiation present + the right mode + non-maintenance — a
// lower bar lets them converge from days, not weeks, of clean history.
const MIN_BUCKETS_FOR_GH_FIT  = 3;

// Sanity bounds. Fits whose output falls outside these ranges are
// physically implausible for this greenhouse and are rejected (return
// null) — caller falls through to DEFAULT_CONFIG. Bounds are
// deliberately wide; the goal is to catch garbage fits (e.g. α near
// zero from a radiation column with no spread, or a τ that says the
// greenhouse cools fully in 6 minutes), not to second-guess plausible
// variations. Values seeded from operational observation: GH peaks at
// ~33 °C in sunny noon, cools to outdoor in ~2 h after vents close,
// radiator measured at ~80–100 W/K from logged tank-drop data.
const GH_TAU_MIN_H        = 0.5;
const GH_TAU_MAX_H        = 8.0;
const GH_ALPHA_MIN        = 0.005;
const GH_ALPHA_MAX        = 0.05;
const RAD_UA_MIN_W_PER_K  = 40;
// Empirically the car-radiator + fan setup measures 80–100 W/K from
// logged greenhouse_heating-mode tank-drop pairs. The fit's median
// drifts higher than this — likely because heating-mode tank loss
// includes both radiator output AND ambient leakage, and the fit
// attributes all of it to UA. 130 caps the upward bias while leaving
// headroom for genuinely high-flow operating points.
const RAD_UA_MAX_W_PER_K  = 130;
const GH_LOSS_MIN_W_PER_K = 30;
const GH_LOSS_MAX_W_PER_K = 300;
const TANK_LEAK_MIN_W_PER_K = 1;
const TANK_LEAK_MAX_W_PER_K = 30;

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

// Shared mode-labeller: returns one mode string per reading by
// forward-walking the modes array. Was duplicated in three fit
// functions (fitSolarGainByHour, fitGreenhouseLossWPerK,
// fitEmpiricalCoefficients) — consolidated here in 2026-05-08 when the
// new GH heat-balance fits added a fourth and fifth caller.
function labelModes(readings, modes) {
  const labels = new Array(readings.length);
  let cursor = 0;
  let currentMode = 'idle';
  while (cursor < modes.length) {
    const tsMs = modes[cursor].ts instanceof Date ? modes[cursor].ts.getTime() : Number(modes[cursor].ts);
    const r0Ms = readings[0].ts instanceof Date ? readings[0].ts.getTime() : Number(readings[0].ts);
    if (tsMs <= r0Ms) { currentMode = modes[cursor].mode; cursor++; }
    else break;
  }
  labels[0] = currentMode;
  for (let i = 1; i < readings.length; i++) {
    const rMs = readings[i].ts instanceof Date ? readings[i].ts.getTime() : Number(readings[i].ts);
    while (cursor < modes.length) {
      const mMs = modes[cursor].ts instanceof Date ? modes[cursor].ts.getTime() : Number(modes[cursor].ts);
      if (mMs <= rMs) { currentMode = modes[cursor].mode; cursor++; }
      else break;
    }
    labels[i] = currentMode;
  }
  return labels;
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

/**
 * Fit empirical thermal coefficients from historical sensor + mode data.
 */
// Tank energy capacity in kWh per K (300 L water, 4186 J/(kg·K)):
// 300 × 4186 / 3.6e6 = 0.349 kWh/K. Useful for converting between tank ΔK
// and kWh — the operationally meaningful unit.
const TANK_KWH_PER_K = TANK_THERMAL_MASS_J_PER_K / 3.6e6;

/**
 * Empirical solar gain by hour-of-day, in kWh of tank energy per clock hour
 * (averaged over the days covered by `history`). Captures the combined effect
 * of: (a) probability that the controller has the system in solar_charging
 * during that hour, (b) actual heat transfer rate when charging, (c) shading,
 * (d) typical weather over the historical window.
 *
 * The forecast engine multiplies this by a cloud factor derived from the FMI
 * forecast radiation, so a forecast hour that is much sunnier (or cloudier)
 * than the historical average scales appropriately.
 *
 * Why "per clock hour" rather than "per charging hour": we never know in
 * advance how many hours the controller will run solar_charging, so we
 * pre-multiply by the historical probability and produce kWh values directly
 * usable in the forecast loop (one value × one cloud factor = one prediction).
 *
 * Falls back to a conservative default mask (low gain 10..16) when history
 * is sparse.
 *
 * @param {object} history  { readings, modes } — same shape as fitEmpiricalCoefficients
 * @returns {number[24]}    Per-hour expected kWh tank gain (positive, typically 0–1).
 */
function fitSolarGainByHour(history) {
  const fallback = (function () {
    const arr = new Array(24);
    for (let h = 0; h < 24; h++) arr[h] = (h >= 10 && h <= 16) ? 0.4 : 0;
    return arr;
  }());

  if (!history || !Array.isArray(history.readings) || history.readings.length < 2 ||
      !Array.isArray(history.modes)) {
    return fallback;
  }

  const readings = history.readings;
  const modes    = history.modes;
  const modeLabels = labelModes(readings, modes);

  // Sum ΔKelvin gained per hour-of-day during solar_charging mode.
  // Then convert to kWh and divide by the number of distinct days covered
  // → average kWh per clock hour at that hour-of-day.
  const sumDeltaK = new Array(24).fill(0);
  const dayKey = function (ts) {
    // Use Helsinki day boundary so a "day" matches what the user perceives.
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(ts);
  };
  const daysSeen = new Set();

  for (let i = 0; i < readings.length - 1; i++) {
    if (modeLabels[i] !== 'solar_charging') continue;
    const r0 = readings[i];
    const r1 = readings[i + 1];
    const t0Ms = r0.ts instanceof Date ? r0.ts.getTime() : Number(r0.ts);
    const t1Ms = r1.ts instanceof Date ? r1.ts.getTime() : Number(r1.ts);
    const dtSec = (t1Ms - t0Ms) / 1000;
    // Skip degenerate gaps.
    if (dtSec <= 0 || dtSec > 600) continue;
    if (typeof r0.tankTop !== 'number' || typeof r0.tankBottom !== 'number' ||
        typeof r1.tankTop !== 'number' || typeof r1.tankBottom !== 'number') continue;
    const tankAvg0 = (r0.tankTop + r0.tankBottom) / 2;
    const tankAvg1 = (r1.tankTop + r1.tankBottom) / 2;
    const dK = tankAvg1 - tankAvg0;
    // Only count positive deltas — the system sometimes briefly enters
    // solar_charging when it's actually losing heat (e.g. start-up). We're
    // measuring "what does charging typically deliver", not "any temp delta".
    if (dK <= 0 || !isFinite(dK)) continue;
    const ts = r0.ts instanceof Date ? r0.ts : new Date(t0Ms);
    sumDeltaK[helsinkiHour(ts)] += dK;
    daysSeen.add(dayKey(ts));
  }

  const numDays = Math.max(1, daysSeen.size);
  const out = new Array(24);
  for (let h = 0; h < 24; h++) {
    out[h] = (sumDeltaK[h] * TANK_KWH_PER_K) / numDays;
  }

  // If we never observed any charging (cold start), use the fallback.
  let total = 0;
  for (let h = 0; h < 24; h++) total += out[h];
  if (total < 0.5) return fallback;
  return out;
}

/**
 * Empirical greenhouse heat-loss coefficient (W/K of gh-to-outdoor ΔT).
 *
 * Uses hourly buckets where the space heater is the SOLE heat source —
 * no greenhouse_heating (radiator delivering tank heat) and no
 * solar_charging (collector loop running, indirect gh warming) during
 * the bucket. In such an hour, energy balance over the bang-bang heater
 * cycle is just:
 *
 *     heaterW × duty = lossWPerK × (gh_avg − outdoor_avg)
 *
 * so a slope-through-origin fit on (ΔT, heaterW × duty) recovers the
 * loss coefficient. Buckets contaminated by other heat sources are
 * discarded — including a single 30 s sample of greenhouse_heating
 * within the hour, since the radiator can deliver hundreds of W and
 * skew the slope significantly.
 *
 * Falls back to null when fewer than MIN_BUCKETS_FOR_FIT clean buckets
 * are available; the engine then keeps its hardcoded default.
 *
 * @param {object} history       { readings, modes } — same shape as fitEmpiricalCoefficients
 * @param {object} [opts]
 * @param {number} [opts.heaterW=1000] Space-heater rated power in watts
 * @returns {number|null}        Fitted W/K, or null on insufficient data
 */
function fitGreenhouseLossWPerK(history, opts) {
  const heaterW = (opts && typeof opts.heaterW === 'number') ? opts.heaterW : 1000;
  if (!history || !Array.isArray(history.readings) || history.readings.length < 2 ||
      !Array.isArray(history.modes)) {
    return null;
  }
  const readings = history.readings;
  const modes    = history.modes;
  const modeLabels = labelModes(readings, modes);

  // Bucket consecutive reading pairs into hourly slots keyed by floor(ts/h).
  // For each bucket we accumulate per-mode seconds plus gh and outdoor
  // sums (averaged at the end). One reading per pair, weighted by dtSec.
  const buckets = {};
  for (let p = 0; p < readings.length - 1; p++) {
    const r0 = readings[p];
    const r1 = readings[p + 1];
    const t0 = r0.ts instanceof Date ? r0.ts.getTime() : Number(r0.ts);
    const t1 = r1.ts instanceof Date ? r1.ts.getTime() : Number(r1.ts);
    const dtSec = (t1 - t0) / 1000;
    if (dtSec <= 0 || dtSec > 600) continue;
    if (typeof r0.greenhouse !== 'number' || typeof r0.outdoor !== 'number') continue;
    const hourKey = Math.floor(t0 / 3600000);
    let b = buckets[hourKey];
    if (!b) {
      b = { emSec: 0, ghHeatSec: 0, scSec: 0, totalSec: 0, ghSum: 0, outSum: 0, n: 0 };
      buckets[hourKey] = b;
    }
    b.totalSec += dtSec;
    if (modeLabels[p] === 'emergency_heating')          b.emSec     += dtSec;
    else if (modeLabels[p] === 'greenhouse_heating')    b.ghHeatSec += dtSec;
    else if (modeLabels[p] === 'solar_charging')        b.scSec     += dtSec;
    b.ghSum  += r0.greenhouse;
    b.outSum += r0.outdoor;
    b.n      += 1;
  }

  // Filter clean buckets and produce slope-fit samples. A bucket is
  // clean iff (a) covers ≥ 30 min, (b) heater fired ≥ 5% of the slot,
  // (c) no greenhouse_heating or solar_charging contamination, and
  // (d) gh-outdoor ΔT ≥ 1 K so a tiny ΔT doesn't dominate the fit.
  const xs = [];
  const ys = [];
  const keys = Object.keys(buckets);
  for (let k = 0; k < keys.length; k++) {
    const bk = buckets[keys[k]];
    if (bk.totalSec < 1800) continue;
    if (bk.ghHeatSec > 0 || bk.scSec > 0) continue;
    if (bk.n < 4) continue;
    const duty = bk.emSec / bk.totalSec;
    if (duty < 0.05) continue;
    const ghAvg  = bk.ghSum / bk.n;
    const outAvg = bk.outSum / bk.n;
    const deltaK = ghAvg - outAvg;
    if (deltaK < 1) continue;
    xs.push(deltaK);
    ys.push(heaterW * duty);
  }
  if (xs.length < MIN_BUCKETS_FOR_FIT) return null;
  const slope = slopeThruOrigin(xs, ys);
  return (slope !== null && slope > 0) ? slope : null;
}

/**
 * Fit greenhouse passive cooling τ from idle, no-radiation hours.
 *
 * Energy balance during idle/no-sun: d(gh)/dt = (outdoor − gh)/τ.
 * Regress -d(gh)/dt against (gh − outdoor) over clean idle pairs where
 * radiation < 30 W/m² (joined from weather_forecasts upstream); slope's
 * reciprocal is τ. Pre-2026-05-08 the joint α/τ fit collapsed α → 0
 * because daytime idle hours dominated the radiation column with most
 * samples in steady state (perfectly collinear with the (out-gh)
 * column). Splitting τ from night and α from day re-establishes
 * identifiability — each regression sees only data where its
 * coefficient is the dominant driver.
 *
 * @returns {number|null} τ in hours within sanity bounds, else null
 */
function fitGhTauNight(history) {
  if (!history || !Array.isArray(history.readings) || history.readings.length < 2 ||
      !Array.isArray(history.modes)) return null;
  const readings = history.readings;
  const modeLabels = labelModes(readings, history.modes);
  // Require idle stable for IDLE_SETTLE_MS before counting a pair —
  // the engine's post-heating transient (radiator valves close,
  // residual hot pipe water cools rapidly toward gh) briefly inflates
  // the apparent cooling slope, biasing τ low. 15 min is enough to
  // skip the transient without losing too many samples in real data
  // where idle stretches between mode-cycles are short.
  const IDLE_SETTLE_MS = 15 * 60 * 1000;
  let idleSinceMs = -Infinity;
  let prevMode = null;
  const xs = []; const ys = [];
  for (let i = 0; i < readings.length - 1; i++) {
    const t0 = readings[i].ts instanceof Date ? readings[i].ts.getTime() : Number(readings[i].ts);
    if (modeLabels[i] !== prevMode) {
      idleSinceMs = modeLabels[i] === 'idle' ? t0 : Infinity;
      prevMode = modeLabels[i];
    }
    if (modeLabels[i] !== 'idle') continue;
    if (t0 - idleSinceMs < IDLE_SETTLE_MS) continue;
    const r0 = readings[i]; const r1 = readings[i + 1];
    const t1 = r1.ts instanceof Date ? r1.ts.getTime() : Number(r1.ts);
    const dtH = (t1 - t0) / 3600000;
    if (dtH <= 0 || dtH > 0.25) continue;
    if (typeof r0.greenhouse !== 'number' || typeof r0.outdoor !== 'number' ||
        typeof r1.greenhouse !== 'number') continue;
    // Hard requirement: radiation present and < 30 W/m². Without joined
    // radiation we can't tell night from day, and a sunny idle hour
    // collapses the slope (gh rises → -d(gh)/dt is negative).
    if (typeof r0.radiationGlobal !== 'number' || r0.radiationGlobal > 30) continue;
    const dT = r0.greenhouse - r0.outdoor;
    if (dT <= 1) continue;
    xs.push(dT);
    ys.push(-(r1.greenhouse - r0.greenhouse) / dtH);
  }
  if (xs.length < MIN_BUCKETS_FOR_GH_FIT) return null;
  const slope = slopeThruOrigin(xs, ys);
  if (slope === null || slope <= 0) return null;
  const tau = 1 / slope;
  if (tau < GH_TAU_MIN_H || tau > GH_TAU_MAX_H) return null;
  return tau;
}

/**
 * Fit greenhouse solar absorption α from sunny daytime non-heating
 * hours, using the differential heat balance with τ already known:
 *
 *     d(gh)/dt = (out-gh)/τ + α·rad
 *  ⇒  y_residual = d(gh)/dt − (out-gh)/τ  =  α·rad
 *
 * Slope of y_residual vs radiation is α directly. The differential
 * form handles transient daytime rises (gh climbing as sun heats it)
 * better than a steady-state slope, and removes the collinearity
 * between (out-gh) and rad that collapsed the prior joint fit.
 *
 * Mode filter excludes greenhouse/emergency heating (extra power into
 * gh breaks the model), and the vent-saturation buffer keeps the fit
 * in the linear regime. Sanity-bounded; out-of-range fits return null
 * and the engine uses DEFAULT_CONFIG.ghSolarAlphaCPerWm2.
 */
function fitGhAlphaDay(history, tauGhH, ventOpenC) {
  if (!history || !Array.isArray(history.readings) || history.readings.length < 2 ||
      !(tauGhH > 0)) return null;
  const readings = history.readings;
  const modeLabels = labelModes(readings, history.modes || []);
  const xs = []; const ys = [];
  for (let i = 0; i < readings.length - 1; i++) {
    if (modeLabels[i] === 'greenhouse_heating' || modeLabels[i] === 'emergency_heating') continue;
    const r0 = readings[i]; const r1 = readings[i + 1];
    const t0 = r0.ts instanceof Date ? r0.ts.getTime() : Number(r0.ts);
    const t1 = r1.ts instanceof Date ? r1.ts.getTime() : Number(r1.ts);
    const dtH = (t1 - t0) / 3600000;
    if (dtH <= 0 || dtH > 0.25) continue;
    if (typeof r0.greenhouse !== 'number' || typeof r0.outdoor !== 'number' ||
        typeof r1.greenhouse !== 'number' || typeof r0.radiationGlobal !== 'number') continue;
    if (r0.radiationGlobal < 100) continue;
    if (r0.greenhouse > ventOpenC - 3) continue;
    const dGhPerH   = (r1.greenhouse - r0.greenhouse) / dtH;
    const passive   = (r0.outdoor - r0.greenhouse) / tauGhH;
    xs.push(r0.radiationGlobal);
    ys.push(dGhPerH - passive);
  }
  if (xs.length < MIN_BUCKETS_FOR_GH_FIT) return null;
  const slope = slopeThruOrigin(xs, ys);
  if (slope === null || slope <= 0) return null;
  if (slope < GH_ALPHA_MIN || slope > GH_ALPHA_MAX) return null;
  return slope;
}

/**
 * Empirical radiator UA (W/K) — heat-transfer coefficient from tank to
 * greenhouse air. Computed from greenhouse_heating-mode hours where
 * the radiator is the only active heat path: UA = (tank-drop power) /
 * (tank_avg − gh). Median over hourly buckets is more robust than mean
 * (one rapid mode-transition bucket can drag the mean by 50 %).
 *
 * Replaces the hardcoded 80 W/K constant the engine used pre-2026-05-08.
 * Operational data shows real UA varies 60–120 W/K; the hardcoded mid-
 * value over-credited radiator output in cool-tank conditions and
 * under-predicted heater duty in nightly forecasts. Sanity-gated to
 * [40, 200] W/K so a single bad sample (e.g. radiator just started,
 * tank still mixing) doesn't propagate.
 */
function fitRadiatorUaWPerK(history) {
  if (!history || !Array.isArray(history.readings) || history.readings.length < 2 ||
      !Array.isArray(history.modes)) return null;
  const readings = history.readings;
  const modeLabels = labelModes(readings, history.modes);
  // Per-hour bucket of (UA samples). Sub-hourly noise gets averaged
  // within the bucket; the median across buckets is the headline value.
  const buckets = {};
  for (let i = 0; i < readings.length - 1; i++) {
    if (modeLabels[i] !== 'greenhouse_heating') continue;
    const r0 = readings[i]; const r1 = readings[i + 1];
    const t0 = r0.ts instanceof Date ? r0.ts.getTime() : Number(r0.ts);
    const t1 = r1.ts instanceof Date ? r1.ts.getTime() : Number(r1.ts);
    const dtSec = (t1 - t0) / 1000;
    if (dtSec <= 0 || dtSec > 600) continue;
    if (typeof r0.tankTop !== 'number' || typeof r0.tankBottom !== 'number' ||
        typeof r1.tankTop !== 'number' || typeof r1.tankBottom !== 'number' ||
        typeof r0.greenhouse !== 'number') continue;
    const tankAvg0 = (r0.tankTop + r0.tankBottom) / 2;
    const tankAvg1 = (r1.tankTop + r1.tankBottom) / 2;
    const dTankK   = tankAvg0 - tankAvg1;
    const deltaT   = tankAvg0 - r0.greenhouse;
    // Need a real ΔT (>5 K) for UA to be identifiable — small-ΔT
    // samples have too much noise (a 0.1 K reading jitter at ΔT=2
    // doubles the apparent UA). 5 K filter mirrors the operational
    // reality: heating-mode hours sample with tank well above gh.
    if (dTankK <= 0 || deltaT < 5) continue;
    const powerW = (dTankK / dtSec) * TANK_THERMAL_MASS_J_PER_K;
    const ua = powerW / deltaT;
    if (ua < 30 || ua > 250) continue; // drop obvious outliers
    const hourKey = Math.floor(t0 / 3600000);
    if (!buckets[hourKey]) buckets[hourKey] = { sum: 0, n: 0 };
    buckets[hourKey].sum += ua;
    buckets[hourKey].n   += 1;
  }
  const bucketUas = [];
  Object.keys(buckets).forEach(function (k) {
    const b = buckets[k];
    if (b.n >= 4) bucketUas.push(b.sum / b.n);
  });
  if (bucketUas.length < MIN_BUCKETS_FOR_GH_FIT) return null;
  bucketUas.sort(function (a, b) { return a - b; });
  const median = bucketUas[Math.floor(bucketUas.length / 2)];
  if (median < RAD_UA_MIN_W_PER_K || median > RAD_UA_MAX_W_PER_K) return null;
  return median;
}

function fitEmpiricalCoefficients(history, opts) {
  const defaults = {
    tankLeakageWPerK: DEFAULT_TANK_LEAKAGE_W_PER_K,
    usedDefaults:     true,
  };

  if (!history || !Array.isArray(history.readings) || history.readings.length < 2) {
    defaults.solarGainKwhByHour = fitSolarGainByHour(history);
    return defaults;
  }

  const readings = history.readings;
  const modes    = (history.modes || []).slice();
  const modeLabels = labelModes(readings, modes);

  // Bucket consecutive idle stretches and emit one (deltaK, powerW) sample per
  // consecutive reading pair within each ≥ MIN_IDLE_BUCKET_MINUTES bucket.
  // Only the tank-leakage slope is fit here. The greenhouse-loss slope was
  // also fit in a previous iteration but the engine never used it (the GH
  // simulation runs from observed K/h drop rates, not first-principles loss
  // coefficients) — removed when the data-driven model replaced it.
  const tankXs = [], tankYs = [];

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
        }
      }
      bucketStart = -1;
    }
  }

  // Tank leakage: gate to physical bounds. Out-of-range slopes happen
  // when the bucket loop sees rapid temperature drops from non-leakage
  // causes (residual radiator effect after mode transition, sensor
  // anomaly).
  let tankLeak = null;
  if (tankXs.length >= MIN_BUCKETS_FOR_FIT) {
    const slope = slopeThruOrigin(tankXs, tankYs);
    if (slope !== null && slope >= TANK_LEAK_MIN_W_PER_K && slope <= TANK_LEAK_MAX_W_PER_K) {
      tankLeak = slope;
    }
  }
  // Greenhouse loss: bound to plausible W/K. fitGreenhouseLossWPerK
  // already returns null on insufficient data; gate handles the case
  // where it converges to a non-physical value.
  let ghLoss = fitGreenhouseLossWPerK(history, opts);
  if (ghLoss !== null && (ghLoss < GH_LOSS_MIN_W_PER_K || ghLoss > GH_LOSS_MAX_W_PER_K)) ghLoss = null;
  // Sequential GH-air fits — τ from night-only idle hours (no solar
  // contamination), α from sunny daytime non-heating hours (vent-
  // saturation buffer applied). Replaces the joint 2-variable fit that
  // collapsed α → 0 due to (out-gh)/rad collinearity in steady-state
  // daytime data.
  const ghTau   = fitGhTauNight(history);
  const ghAlpha = ghTau !== null ? fitGhAlphaDay(history, ghTau, 33) : null;
  const radUa   = fitRadiatorUaWPerK(history);

  const out = {
    tankLeakageWPerK:   tankLeak !== null ? tankLeak : DEFAULT_TANK_LEAKAGE_W_PER_K,
    solarGainKwhByHour: fitSolarGainByHour(history),
    usedDefaults:       tankLeak === null,
  };
  if (ghLoss  !== null) out.greenhouseLossWPerK   = ghLoss;
  if (ghTau   !== null) out.ghTimeConstantH       = ghTau;
  if (ghAlpha !== null) out.ghSolarAlphaCPerWm2   = ghAlpha;
  if (radUa   !== null) out.radiatorUaWPerK       = radUa;
  return out;
}

module.exports = {
  // Constants the engine also needs.
  TANK_THERMAL_MASS_J_PER_K,
  TANK_KWH_PER_K,
  // TZ helpers.
  helsinkiHour,
  helsinkiHHMM,
  // Fit functions.
  fitSolarGainByHour,
  fitGreenhouseLossWPerK,
  fitGhTauNight,
  fitGhAlphaDay,
  fitRadiatorUaWPerK,
  fitEmpiricalCoefficients,
  // Sanity bounds (exported so tests can exercise gate behavior).
  _bounds: {
    GH_TAU_MIN_H, GH_TAU_MAX_H,
    GH_ALPHA_MIN, GH_ALPHA_MAX,
    RAD_UA_MIN_W_PER_K, RAD_UA_MAX_W_PER_K,
    GH_LOSS_MIN_W_PER_K, GH_LOSS_MAX_W_PER_K,
    TANK_LEAK_MIN_W_PER_K, TANK_LEAK_MAX_W_PER_K,
  },
};
