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
// state (tankAvg / greenhouse), a clock value, or a controller mode
// fraction. Tank top/bottom split and the collector sensor are NOT
// used — they cannot be carried through a recursive 48 h rollout
// without a second model.

const MODES = ['idle', 'solar_charging', 'greenhouse_heating', 'active_drain', 'emergency_heating'];

const STEP_MS = 3600000; // 1 h prediction step

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
];

// Build the model feature vector. `tankAvg`/`greenhouse` are the carried
// model state, `outdoor` the outdoor temperature used for the gradient
// features (FMI forecast temp during a rollout, sensor reading during
// training — they track within ~1-2 degC). `frac` is the controller
// mode mix over the step window (fractions of MODES, summing to 1).
// `aux` carries actuator duty over the window: { heaterOn, fanCooling }
// — each a 0..1 fraction.
function featureRow(tankAvg, greenhouse, outdoor, wx, frac, aux, t) {
  const hod = ((t / STEP_MS) % 24 + 24) % 24;
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
  STEP_MS,
  FEATURE_NAMES,
  featureRow,
  weatherUsable,
  featureRanges,
};
