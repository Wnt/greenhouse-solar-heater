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
const {
  MODES, MS_PER_HOUR, STEP_FINE_MS, STEP_COARSE_MS,
  FEATURE_NAMES, featureRow, weatherUsable, featureRanges,
} = require('../../server/lib/forecast/ml/features.js');

// Physics step shared with the inference engine — the ML model learns
// the residual (observed − physics), so training and rollout MUST call
// the same per-step physics. See server/lib/forecast/physics-step.js.
const { physicsStep } = require('../../server/lib/forecast/physics-step.js');

const ANCHOR_STEP_MS = 900000; // new training anchor every 15 min
const MAX_GAP_MS = 8 * 60000;  // skip samples straddling a sensor gap

// Each anchor yields one sample per prediction-step size — the rollout
// runs 5-min steps near-term and 1-h steps for the tail, so the model
// must learn both. `step_h` (set inside featureRow) lets the forest
// tell the two regimes apart.
const STEPS_MS = [STEP_FINE_MS, STEP_COARSE_MS];

// Hour-of-day in Helsinki (matches the engine's solar profile lookup).
// `Intl.DateTimeFormat` carries the DST rules so this stays correct
// across spring/autumn — important because the solar gain profile
// shifts by an hour at the boundary.
const HELSINKI_HH = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki', hour: '2-digit', hour12: false,
});
function helsinkiHour(ms) { return parseInt(HELSINKI_HH.format(new Date(ms)), 10) || 0; }

// Mode at time `t` from a sorted mode-transition timeline. Pure.
function dominantModeFromFrac(frac) {
  let bestMode = 'idle';
  let bestFrac = 0;
  MODES.forEach(function each(m) {
    const f = frac[m] || 0;
    if (f > bestFrac) { bestFrac = f; bestMode = m; }
  });
  return bestMode;
}

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

// ── actuator / overlay on-off timelines ─────────────────────────────
// The space heater and fan-cooling run as on/off overlays inside the
// controller modes; their duty over the step window is reconstructed
// the same way modeFractions reconstructs the mode mix.

function buildOnOffTimeline(events, type, id) {
  return (events || [])
    .filter(function match(e) { return e.type === type && e.id === id; })
    .slice()
    .sort(function cmp(a, b) { return a.ts - b.ts; });
}

function onStateAt(tl, t) {
  if (!tl.length) return false;
  if (t < tl[0].ts) return tl[0].from === 'on';
  let on = false;
  for (let i = 0; i < tl.length; i++) {
    if (tl[i].ts <= t) on = tl[i].to === 'on'; else break;
  }
  return on;
}

// Fraction of [t0, t1] the entity spent in the 'on' state.
function onFraction(tl, t0, t1) {
  const span = t1 - t0;
  if (span <= 0) return onStateAt(tl, t0) ? 1 : 0;
  let cur = t0;
  let on = onStateAt(tl, t0);
  let onMs = 0;
  for (let i = 0; i < tl.length; i++) {
    if (tl[i].ts <= t0) continue;
    if (tl[i].ts >= t1) break;
    if (on) onMs += tl[i].ts - cur;
    cur = tl[i].ts;
    on = tl[i].to === 'on';
  }
  if (on) onMs += t1 - cur;
  return onMs / span;
}

// ── sensor state index ──────────────────────────────────────────────

function buildStateIndex(points) {
  const pts = (points || []).slice().sort(function cmp(a, b) { return a.ts - b.ts; });
  const ts = pts.map(function pick(p) { return p.ts; });

  function stateAt(t) {
    if (ts.length === 0) return null;
    if (t < ts[0]) return (ts[0] - t) <= MAX_GAP_MS ? finiteState(sample(pts[0])) : null;
    if (t > ts[ts.length - 1]) {
      return (t - ts[ts.length - 1]) <= MAX_GAP_MS ? finiteState(sample(pts[pts.length - 1])) : null;
    }
    let lo = 0, hi = ts.length - 1;
    while (lo < hi - 1) {
      const m = (lo + hi) >> 1;
      if (ts[m] <= t) lo = m; else hi = m;
    }
    const a = pts[lo], b = pts[hi];
    if ((t - a.ts) > MAX_GAP_MS || (b.ts - t) > MAX_GAP_MS) return null;
    const w = b.ts === a.ts ? 0 : (t - a.ts) / (b.ts - a.ts);
    return finiteState({
      tankAvg: lerp((a.tank_top + a.tank_bottom) / 2, (b.tank_top + b.tank_bottom) / 2, w),
      greenhouse: lerp(a.greenhouse, b.greenhouse, w),
      outdoor: lerp(a.outdoor, b.outdoor, w),
    });
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

// A bucket where a sensor dropped out has a missing (undefined) reading,
// so the carried state comes out non-finite. Treat it like a sensor gap
// (return null) rather than letting NaN flow into the training targets —
// a NaN ΔT poisons random-forest leaves and the model then emits NaN
// predictions at serving time (the "ML forecast unavailable" failure).
function finiteState(st) {
  if (!st) return null;
  if (!isFinite(st.tankAvg) || !isFinite(st.greenhouse) || !isFinite(st.outdoor)) return null;
  return st;
}

// ── weather index ───────────────────────────────────────────────────

function buildWeatherIndex(weather) {
  const byHour = {};
  (weather || []).forEach(function add(w) {
    const ms = Date.parse(w.validAt);
    if (!isNaN(ms)) byHour[ms] = w;
  });
  return function weatherAt(t) {
    return byHour[Math.floor(t / MS_PER_HOUR) * MS_PER_HOUR] || null;
  };
}

// ── dataset assembly ────────────────────────────────────────────────

// Returns { X, yTank, yGh, t0s, tu, index } where the targets are
// RESIDUALS over the physics step (observed Δ minus physicsStep Δ).
// The ML rollout composes physics + residual back together, so the
// training and inference physics MUST be the same — both call
// physicsStep with the same cfg (thresholds from the active tu at t0)
// and the dominant mode of the step window. `tu` is the parallel
// per-sample controller-threshold snapshot; `index` bundles the
// stateAt / weatherAt / modeFractions accessors for the rollout eval.
function buildDataset(payload) {
  const stateIdx = buildStateIndex(payload.points);
  const weatherAt = buildWeatherIndex(payload.weather);
  const modeEvs = buildModeTimeline(payload.events);
  const tuTimeline = buildTuTimeline(payload.generations);
  const heaterTl = buildOnOffTimeline(payload.actuators, 'actuator', 'space_heater');
  const fanCoolTl = buildOnOffTimeline(payload.overlays, 'overlay', 'greenhouse_fan_cooling');
  function auxFractions(a, b) {
    return {
      heaterOn: onFraction(heaterTl, a, b),
      fanCooling: onFraction(fanCoolTl, a, b),
    };
  }

  const X = [], yTank = [], yGh = [], t0s = [], tu = [];
  if (stateIdx.firstTs === null) {
    return { X, yTank, yGh, t0s, tu, index: null };
  }

  const start = Math.ceil(stateIdx.firstTs / ANCHOR_STEP_MS) * ANCHOR_STEP_MS;
  const end = stateIdx.lastTs - STEP_FINE_MS;
  for (let t0 = start; t0 <= end; t0 += ANCHOR_STEP_MS) {
    const s0 = stateIdx.stateAt(t0);
    if (!s0) continue;
    const wx = weatherAt(t0);
    if (!weatherUsable(wx)) continue;
    const tu0 = tuAt(tuTimeline, t0);
    for (let si = 0; si < STEPS_MS.length; si++) {
      const stepMs = STEPS_MS[si];
      const s1 = stateIdx.stateAt(t0 + stepMs);
      if (!s1) continue;
      const frac = modeFractions(modeEvs, t0, t0 + stepMs);
      const aux = auxFractions(t0, t0 + stepMs);
      const physMode = dominantModeFromFrac(frac);
      const phys = physicsStep({
        tankAvg: s0.tankAvg, gh: s0.greenhouse, outdoor: s0.outdoor,
        radiation: wx.radiationGlobal || 0,
        mode: physMode, stepHours: stepMs / MS_PER_HOUR,
        hourOfDayHelsinki: helsinkiHour(t0),
        cfg: { emergencyEnterC: tu0.ehE, emergencyExitC: tu0.ehX },
      });
      X.push(featureRow(s0.tankAvg, s0.greenhouse, s0.outdoor, wx, frac, aux, t0, stepMs));
      yTank.push((s1.tankAvg - s0.tankAvg) - phys.dTankC);
      yGh.push((s1.greenhouse - s0.greenhouse) - phys.dGhC);
      t0s.push(t0);
      tu.push(tu0);
    }
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
      auxFractions,
      firstTs: stateIdx.firstTs,
      lastTs: stateIdx.lastTs,
    },
  };
}

// Re-export from the canonical features.js so consumers (CLI trainer)
// can pull everything from one module.
const { MODEL_VERSION } = require('../../server/lib/forecast/ml/features.js');

module.exports = {
  MODES,
  MODEL_VERSION,
  FEATURE_NAMES,
  STEP_FINE_MS,
  STEP_COARSE_MS,
  TU_KEYS,
  buildDataset,
  featureRow,
  weatherUsable,
  featureRanges,
};
