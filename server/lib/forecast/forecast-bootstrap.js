'use strict';

/**
 * Forecast bootstrap: loads system.yaml once, builds the /api/forecast
 * handler and the periodic weather/spot-price refresher.
 *
 * Extracted from server.js purely to keep that file under the 600-line
 * hard cap; if/when more cross-cutting bootstrap helpers exist, fold
 * this into a shared init module.
 */

const fs = require('fs');
const path = require('path');
const { load: loadYaml } = require('../../../scripts/lib/yaml-load');
const { create: createForecastRefresher } = require('./forecast-refresher');
const { createForecastHandler } = require('./forecast-handler');
const { create: createForecastPredictions } = require('./forecast-predictions');
const { create: createForecastDiagnostics } = require('./forecast-diagnostics');
const { create: createForecastDataset } = require('./forecast-dataset');
const { createMlForecastHandler } = require('./ml/ml-forecast-handler');
const { createModelStore } = require('./ml/model-store');
const { createMlTrainer } = require('./ml/ml-trainer');
const { createTrainingDataLoader } = require('./ml/training-data');
const fmiClient = require('./fmi-client');
const spotPriceClient = require('./spot-price-client');

function loadSystemYaml(repoRoot, log) {
  try {
    return loadYaml(fs.readFileSync(path.join(repoRoot, 'system.yaml'), 'utf8'));
  } catch (e) {
    log.warn('failed to load system.yaml for forecast config', { error: e.message });
    return {};
  }
}

// Whether the in-process ML trainer should run. Pure so the incident
// responder's kill-switch contract is unit-testable: the trainer OOM'd the
// app pod (2026-06-22), so `DISABLE_ML_TRAINER=true` lets a rollout-restart
// quarantine it at runtime without a code deploy. Disabled in tests and
// preview (a preview pod must never overwrite prod's shared S3 model).
function mlTrainerEnabled(env, isPreviewMode) {
  if (env.NODE_ENV === 'test') return false;
  if (isPreviewMode) return false;
  if (env.DISABLE_ML_TRAINER === 'true') return false;
  return true;
}

// One HH:30 capture cycle over BOTH forecast engines
// (design/docs/ml-mode-forecast-findings.md, recommendation #2: the ML
// engine is the UI default, yet only the physics engine's forecasts were
// persisted, so every ML tuning decision rested on offline backtests).
// Physics compute+capture runs first, exactly as before dual-engine
// capture; the ML engine follows. Failures are independent per engine —
// in particular an ML failure (model not loaded, transient DB error)
// logs at warn and never blocks the physics capture or the scheduler
// loop. Extracted from start() so stub handlers can drive it in tests.
function runCaptureCycle({ physicsCompute, mlCompute, capture, log }, done) {
  function captureMl() {
    try {
      mlCompute(function (mlErr, mlResponse) {
        if (mlErr) {
          log.warn('forecast-predictions: ml compute failed; physics capture unaffected',
            { error: mlErr.message });
          done();
          return;
        }
        capture(mlResponse, function () { done(); });
      });
    } catch (e) {
      log.warn('forecast-predictions: ml compute threw', { error: e.message });
      done();
    }
  }
  physicsCompute(function (err, response) {
    if (err) {
      log.warn('forecast-predictions: compute failed', { error: err.message });
      captureMl();
      return;
    }
    capture(response, captureMl);
  });
}

function start({ pool, db, log, repoRoot, isPreviewMode }) {
  const systemYaml = loadSystemYaml(repoRoot, log);
  const isTestEnv = process.env.NODE_ENV === 'test';

  // Predictions service first (no deps on the handler) so we can pass
  // its listRecent into the handler. Capture is unidirectional via the
  // scheduler below (each engine's compute → predictions.
  // captureFromForecast) so there's no circular dep.
  const predictions = createForecastPredictions({
    pool, log,
    // Disable in PREVIEW_MODE (don't write through to prod's table) AND
    // in tests (pg-mem lacks the table on most fixtures).
    isPreviewMode: !!isPreviewMode || isTestEnv,
  });

  const handler = createForecastHandler({
    pool, log, systemYaml,
    listRecentPredictions: predictions.listRecent,
  });

  // The forecast refresher writes purely external/idempotent data
  // (FMI weather + Nord Pool prices), so it's safe to run from preview
  // pods alongside the prod pod — both upsert the same hourly rows
  // into the shared TimescaleDB. Skipping it would mean preview can't
  // exercise /api/forecast end-to-end. The only environment we still
  // skip is NODE_ENV=test, where pg-mem doesn't have the hypertables
  // and we run offline.
  const refresher = createForecastRefresher({
    pool,
    log,
    config: {
      location: systemYaml.location || {},
      refreshIntervalMs: 30 * 60 * 1000,
    },
    isPreviewMode: isTestEnv,
    fmiClient,
    spotPriceClient,
  });
  refresher.start();

  // Eagerly populate the engine's 14d coefficient cache so the first user
  // request after pod restart doesn't pay the ~1.5s history-fit cost.
  // Skip in tests (no real DB / pg-mem missing the hypertable structure).
  if (!isTestEnv) handler.prewarm();

  // Diagnostics handler — read-only predicted-vs-actual analysis over
  // the multi-horizon predictions table. Shares the pool; no state.
  const diagnostics = createForecastDiagnostics({ pool, log });

  // Tuning dataset — the full forecast input/output picture (weather,
  // prices, multi-horizon predictions, data-source status) for the
  // public /api/public/history feed. Reads the refresher's live status.
  const dataset = createForecastDataset({
    pool, log,
    getRefresherStatus: refresher.getStatus,
  });

  // ML model store + in-process trainer. The store loads the committed
  // model synchronously, then overrides it from S3 when a fresher
  // accepted model is present. The trainer retrains daily and promotes
  // only gated candidates — disabled in preview (a preview pod must
  // never overwrite prod's shared S3 model) and in tests.
  const modelStore = createModelStore({ log });
  modelStore.loadInitial(function loaded() {});
  const trainer = createMlTrainer({
    db, log, modelStore,
    getForecastDataset: dataset.getDataset,
    getTrainingHistory: createTrainingDataLoader(db),
  });
  if (mlTrainerEnabled(process.env, isPreviewMode)) trainer.start();

  // Alternative ML-driven forecast engine — /api/forecast?engine=ml.
  const mlHandler = createMlForecastHandler({
    pool, log, systemYaml,
    modelStore,
    getTrainerStatus: trainer.getStatus,
  });

  // Predictions scheduler — runs at HH:30 every hour. Computes a fresh
  // forecast from EACH engine and persists the 48 h trajectories so
  // predicted-vs-actual history accrues for both. Armed here (after the
  // ML handler exists) because a test-injected scheduleNow fires the
  // capture callback synchronously.
  predictions.start(function (done) {
    runCaptureCycle({
      physicsCompute: handler.compute,
      mlCompute: mlHandler.compute,
      capture: predictions.captureFromForecast,
      log,
    }, done);
  });

  // Dispatch /api/forecast on the `engine` query param — the user's
  // Settings toggle drives this. Default (and any unknown value) is the
  // physics engine.
  function handle(req, res) {
    let engine = 'physics';
    try {
      engine = new URL(req.url, 'http://localhost').searchParams.get('engine') || 'physics';
    } catch (_e) { /* malformed URL — fall through to physics */ }
    if (engine === 'ml') mlHandler.handle(req, res);
    else handler.handle(req, res);
  }

  return {
    handle,
    handleDiagnostics: function (req, res) { diagnostics.handle(req, res); },
    getForecastDataset: function (opts, cb) { dataset.getDataset(opts, cb); },
    stop:   function () { refresher.stop(); predictions.stop(); trainer.stop(); },
  };
}

module.exports = { start, mlTrainerEnabled, runCaptureCycle };
