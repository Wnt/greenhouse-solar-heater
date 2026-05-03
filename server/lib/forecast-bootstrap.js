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

function start({ pool, log, repoRoot, isPreviewMode }) {
  const systemYaml = loadSystemYaml(repoRoot, log);
  const handler = createForecastHandler({ pool, log, systemYaml });
  // The e2e harness uses pg-mem (no weather_forecasts/spot_prices tables)
  // and runs offline; skip refresher fetches under NODE_ENV=test.
  const isTestEnv = process.env.NODE_ENV === 'test';
  const refresher = createForecastRefresher({
    pool,
    log,
    config: {
      location: systemYaml.location || {},
      refreshIntervalMs: 30 * 60 * 1000,
    },
    isPreviewMode: isPreviewMode || isTestEnv,
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
