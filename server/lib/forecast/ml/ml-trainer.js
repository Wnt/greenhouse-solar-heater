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
const TRAIN_RANGE = 'all';
const MIN_SAMPLES = 300;     // refuse to train on too little history
const TANK_R2_FLOOR = 0.55;  // absolute sanity floors
const GH_R2_FLOOR = 0.30;
const REGRESSION_FACTOR = 1.25; // candidate may not exceed current RMSE by >25%

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

// Pure gate — exported for tests. `current` is the full model object
// (with .tank / .greenhouse forests) or null on first ever run.
function evaluateGate(candTank, candGh, current, Xte, yTankTe, yGhTe) {
  const ct = evalForest(candTank, Xte, yTankTe);
  const cg = evalForest(candGh, Xte, yGhTe);
  const reasons = [];
  if (!ct.finite || !cg.finite) reasons.push('non-finite predictions');
  if (ct.r2 < TANK_R2_FLOOR) reasons.push('tank R2 ' + ct.r2.toFixed(3) + ' below floor ' + TANK_R2_FLOOR);
  if (cg.r2 < GH_R2_FLOOR) reasons.push('greenhouse R2 ' + cg.r2.toFixed(3) + ' below floor ' + GH_R2_FLOOR);
  if (current && current.tank && current.greenhouse) {
    const curT = evalForest(current.tank, Xte, yTankTe);
    const curG = evalForest(current.greenhouse, Xte, yGhTe);
    if (ct.rmse > curT.rmse * REGRESSION_FACTOR) {
      reasons.push('tank RMSE regressed (' + ct.rmse.toFixed(3) + ' vs current ' + curT.rmse.toFixed(3) + ')');
    }
    if (cg.rmse > curG.rmse * REGRESSION_FACTOR) {
      reasons.push('greenhouse RMSE regressed (' + cg.rmse.toFixed(3) + ' vs current ' + curG.rmse.toFixed(3) + ')');
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
    db.getHistory(TRAIN_RANGE, null, function gotPoints(err, points) {
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

      let candTank;
      let candGh;
      try {
        candTank = rf.trainForest(Xtr, tankTr, { seed: 1 });
        candGh = rf.trainForest(Xtr, ghTr, { seed: 2 });
      } catch (e) {
        fail('candidate training failed: ' + e.message, done);
        return;
      }

      const gate = evaluateGate(candTank, candGh, modelStore.get(), Xte, tankTe, ghTe);
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

module.exports = { createMlTrainer, evaluateGate };
