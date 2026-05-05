'use strict';

/**
 * Cron-style refresher that pulls FMI weather forecasts and spot prices
 * every 30 minutes and persists them to the DB.
 *
 * create({ pool, log, config, isPreviewMode, fmiClient, spotPriceClient })
 *   → { start(), stop() }
 *
 * config = { location: { lat, lon }, refreshIntervalMs }
 */

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const FORECAST_HOURS = 48;

function create(opts) {
  const pool          = opts.pool;
  const log           = opts.log;
  const config        = opts.config || {};
  const isPreviewMode = opts.isPreviewMode || false;
  const fmiClient     = opts.fmiClient;
  const spotClient    = opts.spotPriceClient;

  const intervalMs = config.refreshIntervalMs || DEFAULT_INTERVAL_MS;
  const lat        = config.location && config.location.lat;
  const lon        = config.location && config.location.lon;

  let _intervalHandle = null;
  let _inFlightPromise = null;

  function upsertWeather(rows, fetchedAt) {
    if (!rows || rows.length === 0) return Promise.resolve();
    const sql = 'INSERT INTO weather_forecasts ' +
      '(fetched_at, valid_at, temperature, radiation_global, wind_speed, precipitation) ' +
      'VALUES ($1, $2, $3, $4, $5, $6) ' +
      'ON CONFLICT (fetched_at, valid_at) DO UPDATE SET ' +
      '  temperature = EXCLUDED.temperature, ' +
      '  radiation_global = EXCLUDED.radiation_global, ' +
      '  wind_speed = EXCLUDED.wind_speed, ' +
      '  precipitation = EXCLUDED.precipitation';

    let chain = Promise.resolve();
    rows.forEach(function (row) {
      chain = chain.then(function () {
        return new Promise(function (resolve, reject) {
          pool.query(sql, [
            fetchedAt,
            row.validAt,
            row.temperature,
            row.radiationGlobal,
            row.windSpeed,
            row.precipitation,
          ], function (err) {
            if (err) { reject(err); } else { resolve(); }
          });
        });
      });
    });
    return chain;
  }

  function upsertPrices(rows, fetchedAt) {
    if (!rows || rows.length === 0) return Promise.resolve();
    const sql = 'INSERT INTO spot_prices (fetched_at, valid_at, source, price_c_kwh) ' +
      'VALUES ($1, $2, $3, $4) ' +
      'ON CONFLICT (valid_at, source) DO UPDATE SET ' +
      '  fetched_at = EXCLUDED.fetched_at, ' +
      '  price_c_kwh = EXCLUDED.price_c_kwh';

    let chain = Promise.resolve();
    rows.forEach(function (row) {
      chain = chain.then(function () {
        return new Promise(function (resolve, reject) {
          pool.query(sql, [
            fetchedAt,
            row.validAt,
            row.source,
            row.priceCKwh,
          ], function (err) {
            if (err) { reject(err); } else { resolve(); }
          });
        });
      });
    });
    return chain;
  }

  function runCycle() {
    const fetchedAt = new Date();

    const weatherPromise = fmiClient.fetchForecast({ lat, lon, hours: FORECAST_HOURS })
      .then(function (rows) {
        return upsertWeather(rows, fetchedAt).then(function () {
          log.info('forecast-refresher: weather upserted', { rows: rows.length });
        });
      })
      .catch(function (err) {
        log.error('forecast-refresher: weather fetch failed', { error: err.message });
      });

    const pricesPromise = spotClient.fetchPrices({ horizonHours: FORECAST_HOURS })
      .then(function (rows) {
        return upsertPrices(rows, fetchedAt).then(function () {
          log.info('forecast-refresher: prices upserted', { rows: rows.length });
        });
      })
      .catch(function (err) {
        log.error('forecast-refresher: prices fetch failed', { error: err.message });
      });

    return Promise.all([weatherPromise, pricesPromise]);
  }

  function start() {
    if (isPreviewMode) {
      log.info('preview mode: forecast-refresher disabled');
      return;
    }

    _inFlightPromise = runCycle();

    _intervalHandle = setInterval(function () {
      _inFlightPromise = runCycle();
    }, intervalMs);
  }

  function stop() {
    if (_intervalHandle !== null) {
      clearInterval(_intervalHandle);
      _intervalHandle = null;
    }
    return _inFlightPromise || Promise.resolve();
  }

  return { start, stop };
}

module.exports = { create };
