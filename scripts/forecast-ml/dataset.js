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

// Feature contract (column list + row builder) is shared with the
// server-side inference engine — see server/lib/forecast/ml/features.js.
const { MODES, STEP_MS, FEATURE_NAMES, featureRow, weatherUsable } =
  require('../../server/lib/forecast/ml/features.js');

const ANCHOR_STEP_MS = 900000; // new training anchor every 15 min
const MAX_GAP_MS = 8 * 60000;  // skip samples straddling a sensor gap

function lerp(a, b, w) { return a + (b - a) * w; }

// ── mode timeline ───────────────────────────────────────────────────

function buildModeTimeline(events) {
  return (events || [])
    .filter(function isMode(e) { return e.type === 'mode'; })
    .slice()
    .sort(function cmp(a, b) { return a.ts - b.ts; });
}

// ── tuning-threshold timeline ───────────────────────────────────────
// Controller thresholds (greenhouse-heating + emergency setpoints) as
// they changed over time, reconstructed from the per-generation `tu`
// snapshots in the public feed. Used by the threshold-feature
// experiment in train-forecast-model.mjs.

const TU_KEYS = ['geT', 'gxT', 'gmD', 'gxD', 'ehE', 'ehX'];
const TU_DEFAULTS = { geT: 10, gxT: 12, gmD: 5, gxD: 2, ehE: 9, ehX: 12 };

function buildTuTimeline(generations) {
  return (generations || [])
    .filter(function hasTu(g) { return g && g.tu && typeof g.tu === 'object'; })
    .map(function row(g) { return { ts: Date.parse(g.generatedAt), tu: g.tu }; })
    .filter(function valid(r) { return !isNaN(r.ts); })
    .sort(function cmp(a, b) { return a.ts - b.ts; });
}

// Thresholds active at time t. Before the first recorded snapshot the
// earliest known set is carried back; missing keys fall to defaults.
function tuAt(timeline, t) {
  const out = Object.assign({}, TU_DEFAULTS);
  if (!timeline.length) return out;
  let pick = timeline[0].tu;
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i].ts <= t) pick = timeline[i].tu; else break;
  }
  TU_KEYS.forEach(function set(k) {
    if (typeof pick[k] === 'number') out[k] = pick[k];
  });
  return out;
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

// ── dataset assembly ────────────────────────────────────────────────

// Returns { X, yTank, yGh, t0s, tu, index } where `tu` is the parallel
// per-sample controller-threshold snapshot and `index` bundles the
// stateAt / weatherAt / modeFractions accessors for the rollout eval.
function buildDataset(payload) {
  const stateIdx = buildStateIndex(payload.points);
  const weatherAt = buildWeatherIndex(payload.weather);
  const modeEvs = buildModeTimeline(payload.events);
  const tuTimeline = buildTuTimeline(payload.generations);

  const X = [], yTank = [], yGh = [], t0s = [], tu = [];
  if (stateIdx.firstTs === null) {
    return { X, yTank, yGh, t0s, tu, index: null };
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
    tu.push(tuAt(tuTimeline, t0));
  }

  return {
    X,
    yTank,
    yGh,
    t0s,
    tu,
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
  TU_KEYS,
  buildDataset,
  featureRow,
  weatherUsable,
};
