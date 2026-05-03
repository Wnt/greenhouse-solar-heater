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
const loadYaml = require('../../scripts/lib/yaml-load');
const { create: createForecastRefresher } = require('./forecast-refresher');
const { createForecastHandler } = require('./forecast-handler');
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

function start({ pool, log, repoRoot, isPreviewMode: _isPreviewMode }) {
  const systemYaml = loadSystemYaml(repoRoot, log);
  const handler = createForecastHandler({ pool, log, systemYaml });
  // The forecast refresher writes purely external/idempotent data
  // (FMI weather + Nord Pool prices), so it's safe to run from preview
  // pods alongside the prod pod — both upsert the same hourly rows
  // into the shared TimescaleDB. Skipping it would mean preview can't
  // exercise /api/forecast end-to-end. The only environment we still
  // skip is NODE_ENV=test, where pg-mem doesn't have the hypertables
  // and we run offline.
  const isTestEnv = process.env.NODE_ENV === 'test';
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
  return {
    handle: function (req, res) { handler.handle(req, res); },
    stop:   function () { refresher.stop(); },
  };
}

module.exports = { start };
