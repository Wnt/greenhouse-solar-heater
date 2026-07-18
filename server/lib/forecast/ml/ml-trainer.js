'use strict';

// In-process ML forecast trainer.
//
// On a daily timer: pulls recent history from the DB, trains a
// candidate random forest, and promotes it ONLY if it clears a gate
// (absolute accuracy floors + a regression guard against the model
// currently serving). A passing model is hot-swapped via the model
// store and persisted to S3; a failing one is dropped and the current
// model keeps serving.
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

module.exports = { createMlTrainer, evaluateGate, freshTestSubset, MIN_FRESH_SAMPLES };
