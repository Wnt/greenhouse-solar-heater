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

function start({ pool, log, repoRoot, isPreviewMode }) {
  const systemYaml = loadSystemYaml(repoRoot, log);
  const isTestEnv = process.env.NODE_ENV === 'test';

  // Predictions service first (no deps on the handler) so we can pass
  // its listRecent into the handler. Capture is unidirectional via the
  // scheduler below (handler.compute → predictions.captureFromForecast)
  // so there's no circular dep.
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

  // Predictions scheduler — runs at HH:30 every hour. Computes a fresh
  // forecast and persists the first-hour prediction so we accumulate a
  // history of "what the algorithm thought" for later tuning.
  predictions.start(function (done) {
    handler.compute(function (err, response) {
      if (err) {
        log.warn('forecast-predictions: compute failed', { error: err.message });
        done();
        return;
      }
      predictions.captureFromForecast(response, function () { done(); });
    });
  });

  // Eagerly populate the engine's 14d coefficient cache so the first user
  // request after pod restart doesn't pay the ~1.5s history-fit cost.
  // Skip in tests (no real DB / pg-mem missing the hypertable structure).
  if (!isTestEnv) handler.prewarm();
  return {
    handle: function (req, res) { handler.handle(req, res); },
    stop:   function () { refresher.stop(); predictions.stop(); },
  };
}

module.exports = { start };
