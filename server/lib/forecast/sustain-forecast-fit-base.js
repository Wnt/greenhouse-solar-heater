'use strict';

// sustain-forecast-fit-base.js — shared constants, sanity bounds and
// pure helpers for the sustain-forecast fitting + engine code. Split
// out of sustain-forecast-fit.js purely to keep every file in this
// directory under the 600-line cap. No I/O, no deps.

// ── Physical constants (shared with engine) ──
const TANK_THERMAL_MASS_J_PER_K = 300 * 4186;
// Tank energy capacity in kWh per K (300 L water, 4186 J/(kg·K)):
// 300 × 4186 / 3.6e6 = 0.349 kWh/K — the operationally meaningful unit.
const TANK_KWH_PER_K = TANK_THERMAL_MASS_J_PER_K / 3.6e6;

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
// User's logged cooldown 27.8 → 12.1 °C in 4 h (outdoor 10 °C) implies
// τ ≈ 1.9 h. Long-tail soil/structure thermal mass biases the 14d-
// average fit upward toward 4 h, which makes the simulation hold gh
// well above ehE all night (heater never fires). Cap at 3 h: above
// this is implausible for an air-temperature-driven control loop.
const GH_TAU_MAX_H        = 3.0;
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
// Cloud-reference radiation (W/m²) — the gain-weighted mean RadiationGlobal
// over historical charging hours. Outside this band the fit is rejected
// (too few samples / a radiation column with no spread) and the engine
// keeps DEFAULT_CONFIG.cloudReferenceWm2.
const CLOUD_REF_MIN_WM2 = 200;
const CLOUD_REF_MAX_WM2 = 900;

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

module.exports = {
  TANK_THERMAL_MASS_J_PER_K, TANK_KWH_PER_K, DEFAULT_TANK_LEAKAGE_W_PER_K,
  MIN_IDLE_BUCKET_MINUTES, MIN_BUCKETS_FOR_FIT, MIN_BUCKETS_FOR_GH_FIT,
  GH_TAU_MIN_H, GH_TAU_MAX_H, GH_ALPHA_MIN, GH_ALPHA_MAX,
  RAD_UA_MIN_W_PER_K, RAD_UA_MAX_W_PER_K,
  GH_LOSS_MIN_W_PER_K, GH_LOSS_MAX_W_PER_K,
  TANK_LEAK_MIN_W_PER_K, TANK_LEAK_MAX_W_PER_K,
  CLOUD_REF_MIN_WM2, CLOUD_REF_MAX_WM2,
  helsinkiHour, helsinkiHHMM, labelModes, slopeThruOrigin,
};
