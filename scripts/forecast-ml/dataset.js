'use strict';

// Feature engineering for the ML temperature forecast.
//
// Turns one /api/public/history payload into training samples. Each
// sample is one anchor time t0: features describe the conditions over
// the step window [t0, t0+1h] (FMI weather, carried tank/greenhouse
// state, time-of-day, and the controller mode mix), and the targets are
// the observed temperature changes over that window.
//
// Feature set is deliberately "rollout-safe": every feature is either a
// weather-forecast value (known ahead of time), a carried model state
// (tankAvg / greenhouse), a clock value, or a mode fraction. Tank top/
// bottom split and the collector sensor are NOT used — they cannot be
// carried forward in a recursive 48 h rollout without a second model.

const MODES = ['idle', 'solar_charging', 'greenhouse_heating', 'active_drain', 'emergency_heating'];

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
];

const STEP_MS = 3600000;        // 1 h prediction step
const ANCHOR_STEP_MS = 900000;  // new training anchor every 15 min
const MAX_GAP_MS = 8 * 60000;   // skip samples straddling a sensor gap

function lerp(a, b, w) { return a + (b - a) * w; }

// ── mode timeline ───────────────────────────────────────────────────

function buildModeTimeline(events) {
  return (events || [])
    .filter(function isMode(e) { return e.type === 'mode'; })
    .slice()
    .sort(function cmp(a, b) { return a.ts - b.ts; });
}

function modeAt(evs, t) {
  if (evs.length === 0) return 'idle';
  if (t < evs[0].ts) return evs[0].from || 'idle';
  let lo = 0, hi = evs.length - 1, res = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (evs[m].ts <= t) { res = m; lo = m + 1; } else hi = m - 1;
  }
  return evs[res].to || 'idle';
}

// Fraction of [t0, t1] spent in each mode — the controller's actual
// duty mix over the step window.
function modeFractions(evs, t0, t1) {
  const frac = {};
  MODES.forEach(function zero(m) { frac[m] = 0; });
  const span = t1 - t0;
  if (span <= 0) { frac[modeAt(evs, t0)] = 1; return frac; }

  let cur = t0;
  let mode = modeAt(evs, t0);
  for (let i = 0; i < evs.length; i++) {
    if (evs[i].ts <= t0) continue;
    if (evs[i].ts >= t1) break;
    if (frac[mode] !== undefined) frac[mode] += (evs[i].ts - cur) / span;
    cur = evs[i].ts;
    mode = evs[i].to || 'idle';
  }
  if (frac[mode] !== undefined) frac[mode] += (t1 - cur) / span;
  return frac;
}

// ── sensor state index ──────────────────────────────────────────────

function buildStateIndex(points) {
  const pts = (points || []).slice().sort(function cmp(a, b) { return a.ts - b.ts; });
  const ts = pts.map(function pick(p) { return p.ts; });

  function stateAt(t) {
    if (ts.length === 0) return null;
    if (t < ts[0]) return (ts[0] - t) <= MAX_GAP_MS ? sample(pts[0]) : null;
    if (t > ts[ts.length - 1]) {
      return (t - ts[ts.length - 1]) <= MAX_GAP_MS ? sample(pts[pts.length - 1]) : null;
    }
    let lo = 0, hi = ts.length - 1;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      if (ts[m] <= t) lo = m; else hi = m;
    }
    const a = pts[lo], b = pts[hi];
    if ((t - a.ts) > MAX_GAP_MS || (b.ts - t) > MAX_GAP_MS) return null;
    const w = b.ts === a.ts ? 0 : (t - a.ts) / (b.ts - a.ts);
    return {
      tankAvg: lerp((a.tank_top + a.tank_bottom) / 2, (b.tank_top + b.tank_bottom) / 2, w),
      greenhouse: lerp(a.greenhouse, b.greenhouse, w),
      outdoor: lerp(a.outdoor, b.outdoor, w),
    };
  }

  return {
    stateAt,
    firstTs: ts.length ? ts[0] : null,
    lastTs: ts.length ? ts[ts.length - 1] : null,
  };
}

function sample(p) {
  return {
    tankAvg: (p.tank_top + p.tank_bottom) / 2,
    greenhouse: p.greenhouse,
    outdoor: p.outdoor,
  };
}

// ── weather index ───────────────────────────────────────────────────

function buildWeatherIndex(weather) {
  const byHour = {};
  (weather || []).forEach(function add(w) {
    const ms = Date.parse(w.validAt);
    if (!isNaN(ms)) byHour[ms] = w;
  });
  return function weatherAt(t) {
    return byHour[Math.floor(t / STEP_MS) * STEP_MS] || null;
  };
}

// ── feature row ─────────────────────────────────────────────────────

// Build the model feature vector. `tankAvg`/`greenhouse` are the carried
// model state, `outdoor` the outdoor temperature used for the gradient
// features (FMI forecast temp during a rollout, sensor reading during
// training — they track within ~1-2 degC).
function featureRow(tankAvg, greenhouse, outdoor, wx, frac, t) {
  const hod = ((t / STEP_MS) % 24 + 24) % 24;
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
    frac.idle,
    frac.solar_charging,
    frac.greenhouse_heating,
    frac.active_drain,
    frac.emergency_heating,
  ];
}

function weatherUsable(w) {
  return w
    && typeof w.temperature === 'number'
    && typeof w.radiationGlobal === 'number'
    && typeof w.windSpeed === 'number'
    && typeof w.precipitation === 'number';
}

// ── dataset assembly ────────────────────────────────────────────────

// Returns { X, yTank, yGh, t0s, index } where index bundles the
// stateAt / weatherAt / modeFractions accessors for the rollout eval.
function buildDataset(payload) {
  const stateIdx = buildStateIndex(payload.points);
  const weatherAt = buildWeatherIndex(payload.weather);
  const modeEvs = buildModeTimeline(payload.events);

  const X = [], yTank = [], yGh = [], t0s = [];
  if (stateIdx.firstTs === null) {
    return { X, yTank, yGh, t0s, index: null };
  }

  const start = Math.ceil(stateIdx.firstTs / ANCHOR_STEP_MS) * ANCHOR_STEP_MS;
  const end = stateIdx.lastTs - STEP_MS;
  for (let t0 = start; t0 <= end; t0 += ANCHOR_STEP_MS) {
    const s0 = stateIdx.stateAt(t0);
    const s1 = stateIdx.stateAt(t0 + STEP_MS);
    if (!s0 || !s1) continue;
    const wx = weatherAt(t0);
    if (!weatherUsable(wx)) continue;
    const frac = modeFractions(modeEvs, t0, t0 + STEP_MS);
    X.push(featureRow(s0.tankAvg, s0.greenhouse, s0.outdoor, wx, frac, t0));
    yTank.push(s1.tankAvg - s0.tankAvg);
    yGh.push(s1.greenhouse - s0.greenhouse);
    t0s.push(t0);
  }

  return {
    X,
    yTank,
    yGh,
    t0s,
    index: {
      stateAt: stateIdx.stateAt,
      weatherAt,
      modeFractions: function frac(a, b) { return modeFractions(modeEvs, a, b); },
      firstTs: stateIdx.firstTs,
      lastTs: stateIdx.lastTs,
    },
  };
}

module.exports = {
  MODES,
  FEATURE_NAMES,
  STEP_MS,
  buildDataset,
  featureRow,
  weatherUsable,
};
