'use strict';

// Feature contract shared by ML-forecast training and inference.
//
// The offline trainer (scripts/forecast-ml) and the server-side engine
// (ml-forecast.js) MUST build feature rows identically, or the model
// sees a different input distribution at inference than it trained on.
// Keeping the column list and the row builder here — imported by both
// sides — is what guarantees that.
//
// Feature set is deliberately "rollout-safe": every column is either an
// FMI weather-forecast value (known ahead of time), a carried model
// state (tankAvg / greenhouse), a clock value, a controller mode
// fraction, or the prediction-step length. Tank top/bottom split and
// the collector sensor are NOT used — they cannot be carried through a
// recursive 48 h rollout without a second model.
//
// The rollout is multi-resolution: 5-min steps over the near term
// (FINE_HORIZON_MS), then 1-h steps for the tail — fine near-term mode
// timing without the recursive-error blow-up of running 5-min steps for
// the whole 48 h. One forest pair serves both regimes: the `step_h`
// feature lets the trees partition fine from coarse samples. At the
// 5-min step a sample window almost never spans a mode transition, so
// its mode fractions collapse to a one-hot of the real logged mode —
// which is the categorical "real transition log" signal, no aggregation.

const MODES = ['idle', 'solar_charging', 'greenhouse_heating', 'active_drain', 'emergency_heating'];

const MS_PER_HOUR = 3600000;

// Prediction-step sizes and the near-term horizon that uses the fine one.
const STEP_FINE_MS = 5 * 60 * 1000;
const STEP_COARSE_MS = 60 * 60 * 1000;
const FINE_HORIZON_MS = 4 * 60 * 60 * 1000;
const HORIZON_MS = 48 * 60 * 60 * 1000;

const FEATURE_NAMES = [
  'wx_temp_c',          // FMI forecast outdoor temperature
  'wx_radiation_w',     // FMI forecast global radiation
  'wx_wind_ms',         // FMI forecast wind speed
  'wx_precip_mm',       // FMI forecast precipitation
  'tank_avg_c',         // carried: tank average temperature
  'greenhouse_c',       // carried: greenhouse air temperature
  'tank_minus_outdoor', // tank loss gradient
  'gh_minus_outdoor',   // greenhouse loss gradient
  'tank_minus_gh',      // radiator delivery gradient
  'hour_sin',
  'hour_cos',
  'frac_idle',
  'frac_solar_charging',
  'frac_greenhouse_heating',
  'frac_active_drain',
  'frac_emergency_heating',
  'frac_heater_on',     // space-heater duty over the step window
  'frac_fan_cooling',   // greenhouse fan-cooling duty over the step window
  'step_h',             // prediction-step length in hours (~0.083 fine / 1 coarse)
];

// Build the model feature vector. `tankAvg`/`greenhouse` are the carried
// model state, `outdoor` the outdoor temperature used for the gradient
// features (FMI forecast temp during a rollout, sensor reading during
// training — they track within ~1-2 degC). `frac` is the controller
// mode mix over the step window (fractions of MODES, summing to 1).
// `aux` carries actuator duty over the window: { heaterOn, fanCooling }
// — each a 0..1 fraction. `stepMs` is the length of the window the
// targets span; `step_h` tells the model whether a row is a fine
// (5-min) or a coarse (1-h) sample.
function featureRow(tankAvg, greenhouse, outdoor, wx, frac, aux, t, stepMs) {
  const hod = ((t / MS_PER_HOUR) % 24 + 24) % 24;
  const a = aux || {};
  return [
    wx.temperature,
    wx.radiationGlobal,
    wx.windSpeed,
    wx.precipitation,
    tankAvg,
    greenhouse,
    tankAvg - outdoor,
    greenhouse - outdoor,
    tankAvg - greenhouse,
    Math.sin(2 * Math.PI * hod / 24),
    Math.cos(2 * Math.PI * hod / 24),
    frac.idle || 0,
    frac.solar_charging || 0,
    frac.greenhouse_heating || 0,
    frac.active_drain || 0,
    frac.emergency_heating || 0,
    a.heaterOn || 0,
    a.fanCooling || 0,
    (stepMs || STEP_COARSE_MS) / MS_PER_HOUR,
  ];
}

function weatherUsable(w) {
  return !!w
    && typeof w.temperature === 'number'
    && typeof w.radiationGlobal === 'number'
    && typeof w.windSpeed === 'number'
    && typeof w.precipitation === 'number';
}

// Per-feature [min, max] over a feature matrix — shipped with the model
// so the inference engine can flag out-of-distribution conditions.
function featureRanges(X) {
  if (!X.length) return [];
  const p = X[0].length;
  const out = [];
  for (let j = 0; j < p; j++) {
    let mn = Infinity;
    let mx = -Infinity;
    for (let i = 0; i < X.length; i++) {
      const v = X[i][j];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    out.push({ min: mn, max: mx });
  }
  return out;
}

module.exports = {
  MODES,
  MS_PER_HOUR,
  STEP_FINE_MS,
  STEP_COARSE_MS,
  FINE_HORIZON_MS,
  HORIZON_MS,
  FEATURE_NAMES,
  featureRow,
  weatherUsable,
  featureRanges,
};
