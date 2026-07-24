'use strict';

// In-process ML forecast trainer.
//
// On a daily timer: pulls recent history from the DB, trains a
// candidate random forest, and promotes it ONLY if it clears a gate
// (absolute accuracy floors + a regression guard against the model
// currently serving + the mode-schedule guard in mode-gate.js, which
// rejects candidates that degrade the 48 h mode schedule even when
// their temperature RMSE is better). A passing model is hot-swapped
// via the model store and persisted to S3; a failing one is dropped
// and the current model keeps serving.
//
// Training is pure CPU and runs off the request path. Disabled in
// PREVIEW_MODE (preview pods must never overwrite prod's S3 model) and
// in tests.
//
// createMlTrainer({ db, log, getForecastDataset, modelStore })
//   -> { start(), stop(), retrainOnce(cb), getStatus() }

const rf = require('./random-forest');
const { FEATURE_NAMES, MODEL_VERSION, STEP_FINE_MS, STEP_COARSE_MS, featureRanges } = require('./features');
const { buildDataset } = require('../../../../scripts/forecast-ml/dataset.js');
const { evaluateModeGuard } = require('./mode-gate');

const RETRAIN_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const INITIAL_DELAY_MS = 3 * 60 * 1000;          // first run 3 min after boot
// Training window — NOT 'all'. sensor_readings_30s accumulates forever
// (CLAUDE.md: never pruned), so range 'all' grew the in-memory training set
// without bound and OOM-killed the app's V8 heap (~250 MB) on the 3-min
// initial run, crash-looping the pod (nginx 503s, 2026-06-22).
//
// We pull a rolling 30-day window at a FIXED 5-minute resolution via
// db.getTrainingHistory. Decoupling span from bucket size is what makes
// this cheap: the dominant memory cost is the raw point rows, which scale
// as sensors × days × (1440/bucketMinutes) — ~30 d at 5 min is ~20× lighter
// than the old all-history-at-30s load, yet it keeps the full month of
// behavioural diversity (a 7-day window under-fit the tank R2 floor and the
// gate kept rejecting). 5 minutes == STEP_FINE_MS, so near-term fine-step
// fidelity is preserved (UI ranges like '30d' would coarsen to 30-min
// buckets and smear it). TRAIN_RANGE is the matching window key for the
// sparse loaders (events + forecast inputs), which need no re-bucketing.
const TRAIN_WINDOW_DAYS = 30;
const TRAIN_BUCKET = '5 minutes';
const TRAIN_RANGE = '30d';
const MIN_SAMPLES = 300;     // refuse to train on too little history
const TANK_R2_FLOOR = 0.55;  // absolute sanity floors
const GH_R2_FLOOR = 0.30;
const REGRESSION_FACTOR = 1.25; // candidate may not exceed current RMSE by >25%
// Minimum size of the unseen-by-current test subset for the regression
// guard to use it. One day of history yields ~190 samples (15-min
// anchors × 2 step sizes), so this only trips when the current model is
// hours old — where falling back to the (biased, conservative) full
// test split is harmless.
const MIN_FRESH_SAMPLES = 50;

// ── metrics ──

function rmse(pred, y) {
  let s = 0;
  for (let i = 0; i < pred.length; i++) { const e = pred[i] - y[i]; s += e * e; }
  return Math.sqrt(s / pred.length);
}

function r2(pred, y) {
  let mean = 0;
  for (let i = 0; i < y.length; i++) mean += y[i];
  mean /= y.length;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < y.length; i++) {
    ssRes += (pred[i] - y[i]) * (pred[i] - y[i]);
    ssTot += (y[i] - mean) * (y[i] - mean);
  }
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
}

function evalForest(forest, X, y) {
  const pred = X.map(function one(row) { return rf.predictForest(forest, row); });
  return { rmse: rmse(pred, y), r2: r2(pred, y), finite: pred.every(Number.isFinite) };
}

// The subset of the test split the CURRENT model has never seen:
// samples anchored at or after its trainedAt. The shipped model is
// retrained on the full window at promotion, so anything older is in
// its training set and evaluating it there just measures memorization.
// Returns null when there is no current model (or no trainedAt) —
// i.e. no restriction needed.
function freshTestSubset(Xte, yTankTe, yGhTe, t0sTe, current) {
  const trainedAtMs = current && Date.parse(current.trainedAt);
  if (!Number.isFinite(trainedAtMs)) return null;
  const X = [], yTank = [], yGh = [];
  for (let i = 0; i < Xte.length; i++) {
    if (t0sTe[i] >= trainedAtMs) {
      X.push(Xte[i]);
      yTank.push(yTankTe[i]);
      yGh.push(yGhTe[i]);
    }
  }
  return { X, yTank, yGh };
}

// Pure gate — exported for tests. `current` is the full model object
// (with .tank / .greenhouse forests) or null on first ever run.
// `fresh` (optional) is the unseen-by-current test subset from
// freshTestSubset; when big enough, the candidate-vs-current regression
// comparison runs on it instead of the full test split. Without it the
// comparison leaks: the current model was trained on most of the test
// window and its memorized RMSE vetoes honest candidates (the 2026-07
// staleness incident — promotions only landed every 3-5 days).
function evaluateGate(candTank, candGh, current, Xte, yTankTe, yGhTe, fresh) {
  const ct = evalForest(candTank, Xte, yTankTe);
  const cg = evalForest(candGh, Xte, yGhTe);
  const reasons = [];
  if (!ct.finite || !cg.finite) reasons.push('non-finite predictions');
  // A non-finite RMSE/R2 means the TEST TARGETS carried NaN (a missing
  // sensor reading in the window) even though predictions were finite.
  // `NaN < FLOOR` is false, so without this guard a degenerate model
  // slips past the accuracy floors — the bug that took the ML forecast
  // offline. Reject explicitly.
  if (!Number.isFinite(ct.rmse) || !Number.isFinite(ct.r2)
    || !Number.isFinite(cg.rmse) || !Number.isFinite(cg.r2)) {
    reasons.push('non-finite metrics (NaN in test targets)');
  }
  if (ct.r2 < TANK_R2_FLOOR) reasons.push('tank R2 ' + ct.r2.toFixed(3) + ' below floor ' + TANK_R2_FLOOR);
  if (cg.r2 < GH_R2_FLOOR) reasons.push('greenhouse R2 ' + cg.r2.toFixed(3) + ' below floor ' + GH_R2_FLOOR);
  if (current && current.tank && current.greenhouse) {
    const useFresh = fresh && fresh.X.length >= MIN_FRESH_SAMPLES;
    const gx = useFresh ? fresh.X : Xte;
    const gyT = useFresh ? fresh.yTank : yTankTe;
    const gyG = useFresh ? fresh.yGh : yGhTe;
    const where = useFresh ? ' on ' + gx.length + ' fresh samples' : '';
    const candT = useFresh ? evalForest(candTank, gx, gyT) : ct;
    const candG = useFresh ? evalForest(candGh, gx, gyG) : cg;
    const curT = evalForest(current.tank, gx, gyT);
    const curG = evalForest(current.greenhouse, gx, gyG);
    if (candT.rmse > curT.rmse * REGRESSION_FACTOR) {
      reasons.push('tank RMSE regressed (' + candT.rmse.toFixed(3) + ' vs current ' + curT.rmse.toFixed(3) + where + ')');
    }
    if (candG.rmse > curG.rmse * REGRESSION_FACTOR) {
      reasons.push('greenhouse RMSE regressed (' + candG.rmse.toFixed(3) + ' vs current ' + curG.rmse.toFixed(3) + where + ')');
    }
  }
  return {
    pass: reasons.length === 0,
    reasons,
    metrics: {
      tankRmse: round(ct.rmse), tankR2: round(ct.r2),
      ghRmse: round(cg.rmse), ghR2: round(cg.r2),
    },
  };
}

function round(v) { return Math.round(v * 1000) / 1000; }

// ── collector targets (findings-doc rec #6, Lane D) ─────────────────
// The optional third forest is a DIRECT regression of the collector
// outlet temperature (absolute degC — NOT a physics residual; there is
// no collector physics model) from the same feature row the tank and
// greenhouse forests use. The dataset builder deliberately keeps the
// collector out of the FEATURES (it can't be carried through a
// recursive rollout); here it is the TARGET, aligned to the same
// anchors buildDataset produced (data.t0s). The rollout then simulates
// the collector each step and runs the device's real solar entry/exit
// rules instead of the flat radiation gate (ml-forecast.js).

// Mirrors dataset.js MAX_GAP_MS: an anchor further than this from the
// nearest collector reading is a sensor gap, not a sample.
const COLLECTOR_MAX_GAP_MS = 8 * 60000;

// Sanity floor for the collector forest — NOT a promotion criterion.
// Deliberately below the tank/gh floors' bar: those gate PROMOTION on
// held-out generalization, while this only decides whether the OPTIONAL
// collector forest ships in the artifact, and it is evaluated on tail
// samples the full-window forest has already trained on — so any real
// fit clears it easily. It exists to catch degenerate fits (flatline
// targets → R2 0, NaN leaves) that would otherwise silently flip the
// rollout's solar schedule from the validated 300 W/m2 radiation gate
// to garbage device-rule rollouts.
const COLLECTOR_R2_FLOOR = 0.3;

// Interpolated collector reading at time t from a sorted, finite-only
// point list; NaN when t falls in a sensor gap.
function collectorAt(pts, t) {
  if (!pts.length) return NaN;
  if (t <= pts[0].ts) return (pts[0].ts - t) <= COLLECTOR_MAX_GAP_MS ? pts[0].collector : NaN;
  const last = pts[pts.length - 1];
  if (t >= last.ts) return (t - last.ts) <= COLLECTOR_MAX_GAP_MS ? last.collector : NaN;
  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi - 1) {
    const m = (lo + hi) >> 1;
    if (pts[m].ts <= t) lo = m; else hi = m;
  }
  const a = pts[lo];
  const b = pts[hi];
  if ((t - a.ts) > COLLECTOR_MAX_GAP_MS || (b.ts - t) > COLLECTOR_MAX_GAP_MS) return NaN;
  const w = b.ts === a.ts ? 0 : (t - a.ts) / (b.ts - a.ts);
  return a.collector + (b.collector - a.collector) * w;
}

// Per-anchor collector targets aligned with buildDataset's t0s; NaN
// where the collector column is missing or gapped (those samples are
// simply excluded from the collector forest's training set).
function buildCollectorTargets(points, t0s) {
  const pts = (points || [])
    .filter(function fin(p) { return p && Number.isFinite(p.ts) && Number.isFinite(p.collector); })
    .slice()
    .sort(function cmp(a, b) { return a.ts - b.ts; });
  return t0s.map(function at(t0) { return collectorAt(pts, t0); });
}

function createMlTrainer(opts) {
  const db = opts.db;
  const log = opts.log;
  const getForecastDataset = opts.getForecastDataset;
  const getTrainingHistory = opts.getTrainingHistory;
  const modelStore = opts.modelStore;

  const status = {
    enabled: false,
    processStartAt: new Date().toISOString(),
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastMetrics: null,
    running: false,
  };
  let initialTimer = null;
  let intervalTimer = null;

  // Assemble the training payload — the same shape /api/public/history
  // serves, so the shared buildDataset consumes it unchanged.
  function loadTrainingData(callback) {
    getTrainingHistory(TRAIN_WINDOW_DAYS, TRAIN_BUCKET, function gotPoints(err, points) {
      if (err) { callback(err); return; }
      db.getEvents(TRAIN_RANGE, 'mode', function gotMode(e2, events) {
        db.getEvents(TRAIN_RANGE, 'actuator', function gotAct(e3, actuators) {
          db.getEvents(TRAIN_RANGE, 'overlay', function gotOv(e4, overlays) {
            getForecastDataset({ range: TRAIN_RANGE }, function gotFc(e5, fc) {
              callback(null, {
                points: points || [],
                events: events || [],
                actuators: actuators || [],
                overlays: overlays || [],
                weather: (fc && fc.weather) || [],
                generations: (fc && fc.generations) || [],
              });
            });
          });
        });
      });
    });
  }

  function fail(message, done) {
    status.lastError = message;
    status.running = false;
    log.warn('ml-trainer: retrain skipped', { reason: message });
    if (done) done();
  }

  function retrainOnce(done) {
    if (status.running) { if (done) done(); return; }
    status.running = true;
    status.lastAttemptAt = new Date().toISOString();

    loadTrainingData(function onData(err, payload) {
      if (err) { fail('training-data load failed: ' + err.message, done); return; }

      let data;
      try {
        data = buildDataset(payload);
      } catch (e) {
        fail('dataset build failed: ' + e.message, done);
        return;
      }
      if (data.X.length < MIN_SAMPLES) {
        fail('insufficient samples: ' + data.X.length + ' < ' + MIN_SAMPLES, done);
        return;
      }

      // Time-ordered 80/20 split — a random split leaks (adjacent
      // anchors overlap).
      const split = Math.floor(data.X.length * 0.8);
      const Xtr = data.X.slice(0, split);
      const Xte = data.X.slice(split);
      const tankTr = data.yTank.slice(0, split);
      const tankTe = data.yTank.slice(split);
      const ghTr = data.yGh.slice(0, split);
      const ghTe = data.yGh.slice(split);
      const t0sTe = data.t0s.slice(split);

      let candTank;
      let candGh;
      try {
        candTank = rf.trainForest(Xtr, tankTr, { seed: 1 });
        candGh = rf.trainForest(Xtr, ghTr, { seed: 2 });
      } catch (e) {
        fail('candidate training failed: ' + e.message, done);
        return;
      }

      const current = modelStore.get();
      const fresh = freshTestSubset(Xte, tankTe, ghTe, t0sTe, current);
      const gate = evaluateGate(candTank, candGh, current, Xte, tankTe, ghTe, fresh);
      status.lastMetrics = gate.metrics;
      if (!gate.pass) {
        fail('gate rejected candidate: ' + gate.reasons.join('; '), done);
        return;
      }

      // Mode-schedule guard (findings-doc rec #3, Lane E): temperature
      // RMSE alone cannot see schedule quality — the deployed schedule
      // measured 63-71 % hourly dominant-mode accuracy beyond 4 h vs a
      // 71 % hour-of-day climatology while the temperature metrics
      // looked fine. Replay episode rollouts from the held-out tail
      // with candidate vs serving forests; a candidate more than 3 pp
      // worse on dominant-mode accuracy is rejected even with better
      // RMSE. Skips (never blocks) on thin data — see mode-gate.js.
      const modeGuard = evaluateModeGuard({
        candidate: { tank: candTank, greenhouse: candGh, featureRanges: featureRanges(data.X) },
        serving: current,
        points: payload.points,
        events: payload.events,
        weather: payload.weather,
        testStartMs: t0sTe.length ? t0sTe[0] : NaN,
      });
      gate.metrics.modeGuard = {
        skipped: modeGuard.skipped,
        reason: modeGuard.reason,
        candidateAccuracy: modeGuard.candidateAccuracy,
        servingAccuracy: modeGuard.servingAccuracy,
        episodes: modeGuard.episodes,
        samples: modeGuard.samples,
      };
      if (modeGuard.skipped) {
        log.warn('ml-trainer: mode-schedule guard skipped', { reason: modeGuard.reason });
      }
      if (!modeGuard.pass) {
        fail('gate rejected candidate: ' + modeGuard.reason, done);
        return;
      }

      // Gate passed — train the shipped model on the full history.
      let fullTank;
      let fullGh;
      try {
        fullTank = rf.trainForest(data.X, data.yTank, { seed: 1 });
        fullGh = rf.trainForest(data.X, data.yGh, { seed: 2 });
      } catch (e) {
        fail('full-model training failed: ' + e.message, done);
        return;
      }
      // Optional collector forest (findings rec #6): same
      // hyperparameters as the other forests, trained only on anchors
      // where the collector sensor actually reported. Deliberately NOT
      // part of the promotion gate — no new pass/fail floors — so a
      // window without collector data (or a degenerate collector fit)
      // can never block a good tank/greenhouse model; the artifact just
      // ships without the key and the rollout falls back to the
      // radiation gate.
      let fullCollector = null;
      const yColl = buildCollectorTargets(payload.points, data.t0s);
      const Xc = [];
      const yc = [];
      for (let i = 0; i < data.X.length; i++) {
        if (Number.isFinite(yColl[i])) { Xc.push(data.X[i]); yc.push(yColl[i]); }
      }
      if (Xc.length >= MIN_SAMPLES) {
        try {
          fullCollector = rf.trainForest(Xc, yc, { seed: 3 });
        } catch (e) {
          log.warn('ml-trainer: collector forest training failed — omitting', { error: e.message });
        }
        if (fullCollector) {
          // Evaluate on the same held-out tail the gate uses before
          // attaching: finite predictions + the COLLECTOR_R2_FLOOR
          // sanity bar. A failing forest is logged and omitted;
          // promotion of the tank/greenhouse model is unaffected
          // either way (the rollout falls back to the radiation gate).
          const Xct = [];
          const yct = [];
          for (let i = split; i < data.X.length; i++) {
            if (Number.isFinite(yColl[i])) { Xct.push(data.X[i]); yct.push(yColl[i]); }
          }
          const ce = Xct.length > 0 ? evalForest(fullCollector, Xct, yct) : null;
          if (!ce || !ce.finite || !Number.isFinite(ce.r2) || ce.r2 < COLLECTOR_R2_FLOOR) {
            log.warn('ml-trainer: collector forest failed sanity check — omitting', {
              r2: ce && Number.isFinite(ce.r2) ? round(ce.r2) : null,
              samples: Xct.length,
            });
            fullCollector = null;
          }
        }
      } else if (Xc.length > 0) {
        log.warn('ml-trainer: collector forest skipped — too few finite samples', { samples: Xc.length });
      }

      const model = {
        version: MODEL_VERSION,
        featureNames: FEATURE_NAMES,
        steps: [STEP_FINE_MS, STEP_COARSE_MS],
        featureRanges: featureRanges(data.X),
        tank: fullTank,
        greenhouse: fullGh,
        trainedAt: new Date().toISOString(),
        trainSamples: data.X.length,
      };
      if (fullCollector) {
        model.collector = fullCollector;
        model.collectorTrainSamples = Xc.length;
      }
      modelStore.set(model, function persisted() {
        status.lastSuccessAt = model.trainedAt;
        status.lastError = null;
        status.running = false;
        log.info('ml-trainer: model promoted', {
          samples: data.X.length, metrics: gate.metrics,
        });
        if (done) done();
      });
    });
  }

  function runGuarded() {
    try {
      retrainOnce();
    } catch (e) {
      log.error('ml-trainer: unexpected error', { error: e.message });
      status.running = false;
    }
  }

  function start() {
    status.enabled = true;
    initialTimer = setTimeout(runGuarded, INITIAL_DELAY_MS);
    intervalTimer = setInterval(runGuarded, RETRAIN_INTERVAL_MS);
    log.info('ml-trainer: scheduled', { intervalHours: RETRAIN_INTERVAL_MS / 3600000 });
  }

  function stop() {
    if (initialTimer) clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
    initialTimer = null;
    intervalTimer = null;
  }

  function getStatus() {
    return Object.assign({}, status);
  }

  return { start, stop, retrainOnce, getStatus };
}

module.exports = {
  createMlTrainer, evaluateGate, freshTestSubset, buildCollectorTargets, MIN_FRESH_SAMPLES,
};
