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

  // External-data-source health, surfaced via getStatus() for the public
  // forecast dataset feed. Updated per fetch in runCycle(). Dates here;
  // getStatus() converts to ISO strings.
  const _status = {
    weather: { lastAttemptAt: null, lastSuccessAt: null, lastSuccessRows: null, lastErrorAt: null, lastError: null },
    prices:  { lastAttemptAt: null, lastSuccessAt: null, lastSuccessRows: null, lastErrorAt: null, lastError: null },
  };

  function upsertWeather(rows, fetchedAt) {
    if (!rows || rows.length === 0) return Promise.resolve();
    const sql = 'INSERT INTO weather_forecasts ' +
      '(fetched_at, valid_at, temperature, radiation_global, wind_speed, precipitation, ' +
      ' humidity, dew_point, cloud_cover, wind_gust, pressure) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ' +
      'ON CONFLICT (fetched_at, valid_at) DO UPDATE SET ' +
      '  temperature = EXCLUDED.temperature, ' +
      '  radiation_global = EXCLUDED.radiation_global, ' +
      '  wind_speed = EXCLUDED.wind_speed, ' +
      '  precipitation = EXCLUDED.precipitation, ' +
      '  humidity = EXCLUDED.humidity, ' +
      '  dew_point = EXCLUDED.dew_point, ' +
      '  cloud_cover = EXCLUDED.cloud_cover, ' +
      '  wind_gust = EXCLUDED.wind_gust, ' +
      '  pressure = EXCLUDED.pressure';

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
            row.humidity,
            row.dewPoint,
            row.cloudCover,
            row.windGust,
            row.pressure,
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
    _status.weather.lastAttemptAt = fetchedAt;
    _status.prices.lastAttemptAt = fetchedAt;

    const weatherPromise = fmiClient.fetchForecast({ lat, lon, hours: FORECAST_HOURS })
      .then(function (rows) {
        return upsertWeather(rows, fetchedAt).then(function () {
          _status.weather.lastSuccessAt = new Date();
          _status.weather.lastSuccessRows = rows.length;
          _status.weather.lastError = null;
          _status.weather.lastErrorAt = null;
          log.info('forecast-refresher: weather upserted', { rows: rows.length });
        });
      })
      .catch(function (err) {
        _status.weather.lastErrorAt = new Date();
        _status.weather.lastError = err.message;
        log.error('forecast-refresher: weather fetch failed', { error: err.message });
      });

    const pricesPromise = spotClient.fetchPrices({ horizonHours: FORECAST_HOURS })
      .then(function (rows) {
        return upsertPrices(rows, fetchedAt).then(function () {
          _status.prices.lastSuccessAt = new Date();
          _status.prices.lastSuccessRows = rows.length;
          _status.prices.lastError = null;
          _status.prices.lastErrorAt = null;
          log.info('forecast-refresher: prices upserted', { rows: rows.length });
        });
      })
      .catch(function (err) {
        _status.prices.lastErrorAt = new Date();
        _status.prices.lastError = err.message;
        log.error('forecast-refresher: prices fetch failed', { error: err.message });
      });

    return Promise.all([weatherPromise, pricesPromise]);
  }

  // Health snapshot of both external data sources. Timestamps are ISO
  // strings so the value drops straight into a JSON response.
  function getStatus() {
    return {
      enabled: !isPreviewMode,
      refreshIntervalMs: intervalMs,
      weather: snapshotState(_status.weather),
      prices: snapshotState(_status.prices),
    };
  }

  function snapshotState(s) {
    return {
      lastAttemptAt: isoOrNull(s.lastAttemptAt),
      lastSuccessAt: isoOrNull(s.lastSuccessAt),
      lastSuccessRows: s.lastSuccessRows,
      lastErrorAt: isoOrNull(s.lastErrorAt),
      lastError: s.lastError,
    };
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

  return { start, stop, getStatus };
}

function isoOrNull(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

module.exports = { create };
