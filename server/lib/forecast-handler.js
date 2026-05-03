'use strict';

/**
 * GET /api/forecast handler.
 *
 * Returns latest weather, prices, and the 48 h sustain forecast.
 * Read-only — accessible to all authenticated roles (admin + readonly).
 * Caches the full response for 60 s in-process.
 *
 * createForecastHandler({ pool, log, systemYaml }) → { handle(req, res) }
 */

var { fitEmpiricalCoefficients, computeSustainForecast } = require('./sustain-forecast');
var { jsonResponse } = require('./http-handlers');

var CACHE_TTL_MS         = 60 * 1000;     // 60 s response cache
var COEFF_CACHE_TTL_MS   = 60 * 60 * 1000; // 1 h coefficient cache

function createForecastHandler(opts) {
  var pool       = opts.pool;
  var log        = opts.log;
  var systemYaml = opts.systemYaml || {};

  // ── Per-instance caches (so tests don't share state across handlers) ──
  var _responseCache    = null;
  var _responseCachedAt = 0;
  var _coeffCache       = null;
  var _coeffCachedAt    = 0;

  // Read config from system.yaml with fallbacks matching sustain-forecast defaults.
  var location     = systemYaml.location || {};
  var electricity  = systemYaml.electricity || {};
  var spaceHeater  = systemYaml.space_heater || {};
  var collectors   = (systemYaml.components && systemYaml.components.solar_collectors) || {};

  var configFromYaml = {
    spaceHeaterKw:    typeof spaceHeater.assumed_continuous_power_kw === 'number'
                        ? spaceHeater.assumed_continuous_power_kw : 1,
    transferFeeCKwh:  typeof electricity.transfer_fee_c_kwh === 'number'
                        ? electricity.transfer_fee_c_kwh : 5,
    // total_area is stored as "4m²" string in yaml; extract number.
    collectorAreaM2: (function () {
      var raw = collectors.total_area;
      if (typeof raw === 'number') return raw;
      if (typeof raw === 'string') {
        var m = raw.match(/([0-9.]+)/);
        if (m) return parseFloat(m[1]);
      }
      return 4;
    }()),
    collectorEfficiency: 0.5,
  };

  // ── Query helpers ──

  function queryLatestSensorReadings(callback) {
    // Latest value per sensor from the 30 s aggregate (last 24 h).
    var sql =
      'SELECT DISTINCT ON (sensor_id) sensor_id, avg_value AS value ' +
      'FROM sensor_readings_30s ' +
      "WHERE bucket > NOW() - INTERVAL '24 hours' " +
      'ORDER BY sensor_id, bucket DESC';
    pool.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      var sensors = {};
      (result.rows || []).forEach(function (row) {
        sensors[row.sensor_id] = row.value;
      });
      callback(null, sensors);
    });
  }

  function queryCurrentMode(callback) {
    var sql =
      "SELECT new_value AS mode FROM state_events " +
      "WHERE entity_type = 'mode' ORDER BY ts DESC LIMIT 1";
    pool.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      var mode = (result.rows && result.rows[0]) ? result.rows[0].mode : 'idle';
      callback(null, mode);
    });
  }

  function queryWeather48h(callback) {
    // Latest fetched_at per valid_at for the next 48 h.
    var sql =
      'SELECT DISTINCT ON (valid_at) valid_at, temperature, ' +
      '  radiation_global AS "radiationGlobal", ' +
      '  wind_speed AS "windSpeed", precipitation ' +
      'FROM weather_forecasts ' +
      "WHERE valid_at >= NOW() AND valid_at <= NOW() + INTERVAL '48 hours' " +
      'ORDER BY valid_at, fetched_at DESC';
    pool.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      var rows = (result.rows || []).map(function (r) {
        return {
          validAt:         new Date(r.valid_at).toISOString(),
          temperature:     r.temperature,
          radiationGlobal: r.radiationGlobal,
          windSpeed:       r.windSpeed,
          precipitation:   r.precipitation,
        };
      });
      callback(null, rows);
    });
  }

  function queryPrices48h(callback) {
    // Latest fetched_at per (valid_at, source); prefer sahkotin over nordpool-predict.
    var sql =
      'SELECT DISTINCT ON (valid_at) valid_at, source, price_c_kwh AS "priceCKwh" ' +
      'FROM spot_prices ' +
      "WHERE valid_at >= NOW() AND valid_at <= NOW() + INTERVAL '48 hours' " +
      "ORDER BY valid_at, CASE source WHEN 'sahkotin' THEN 0 ELSE 1 END, fetched_at DESC";
    pool.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      var rows = (result.rows || []).map(function (r) {
        return {
          validAt:   new Date(r.valid_at).toISOString(),
          priceCKwh: r.priceCKwh,
          source:    r.source,
        };
      });
      callback(null, rows);
    });
  }

  function queryHistory14d(callback) {
    // 14 days of sensor_readings_30s + mode events for coefficient fitting.
    var sensorSql =
      'SELECT bucket AS ts, sensor_id, avg_value AS value ' +
      'FROM sensor_readings_30s ' +
      "WHERE bucket > NOW() - INTERVAL '14 days' " +
      'ORDER BY bucket';
    var modeSql =
      'SELECT ts, new_value AS mode ' +
      'FROM state_events ' +
      "WHERE entity_type = 'mode' AND ts > NOW() - INTERVAL '14 days' " +
      'ORDER BY ts';

    pool.query(sensorSql, [], function (err, sensorResult) {
      if (err) { callback(err); return; }
      pool.query(modeSql, [], function (mErr, modeResult) {
        if (mErr) { callback(mErr); return; }

        // Pivot sensor rows into { ts, tankTop, tankBottom, greenhouse, outdoor, collector }
        var buckets = {};
        (sensorResult.rows || []).forEach(function (row) {
          var tsMs = new Date(row.ts).getTime();
          if (!buckets[tsMs]) { buckets[tsMs] = { ts: new Date(row.ts) }; }
          var field = {
            tank_top:    'tankTop',
            tank_bottom: 'tankBottom',
            greenhouse:  'greenhouse',
            outdoor:     'outdoor',
            collector:   'collector',
          }[row.sensor_id];
          if (field) { buckets[tsMs][field] = row.value; }
        });
        var readings = Object.keys(buckets)
          .sort(function (a, b) { return a - b; })
          .map(function (k) { return buckets[k]; });

        var modes = (modeResult.rows || []).map(function (r) {
          return { ts: new Date(r.ts), mode: r.mode };
        });

        callback(null, { readings: readings, modes: modes });
      });
    });
  }

  // ── Coefficients with 1 h in-process cache ──

  function getCoefficients(callback) {
    var now = Date.now();
    if (_coeffCache && (now - _coeffCachedAt) < COEFF_CACHE_TTL_MS) {
      callback(null, _coeffCache);
      return;
    }
    queryHistory14d(function (err, history) {
      if (err) {
        log.warn('forecast-handler: history query failed, using defaults', { error: err.message });
        var defaults = fitEmpiricalCoefficients({});
        _coeffCache = defaults;
        _coeffCachedAt = now;
        callback(null, defaults);
        return;
      }
      var coeff = fitEmpiricalCoefficients(history);
      coeff.fitBucketCount = history.readings ? history.readings.length : 0;
      _coeffCache    = coeff;
      _coeffCachedAt = now;
      callback(null, coeff);
    });
  }

  // ── Handle ──

  function handle(req, res) {
    if (!pool) {
      jsonResponse(res, 503, { error: 'Database not available' });
      return;
    }

    var now = Date.now();
    if (_responseCache && (now - _responseCachedAt) < CACHE_TTL_MS) {
      jsonResponse(res, 200, _responseCache);
      return;
    }

    // Gather all data in parallel where possible.
    var pending = 4;
    var sensors, currentMode, weather, prices, coeff, fetchErr;

    function onPart(err) {
      if (err && !fetchErr) fetchErr = err;
      pending -= 1;
      if (pending > 0) return;

      getCoefficients(function (cErr, c) {
        if (cErr) { log.warn('forecast-handler: coefficients failed', { error: cErr.message }); }
        coeff = c || fitEmpiricalCoefficients({});

        if (fetchErr) {
          log.error('forecast-handler: query failed', { error: fetchErr.message });
          jsonResponse(res, 500, { error: 'Forecast query failed' });
          return;
        }

        var tankTop    = (sensors && sensors.tank_top)    || null;
        var tankBottom = (sensors && sensors.tank_bottom) || null;
        var ghTemp     = (sensors && sensors.greenhouse)  || null;

        // Config for sustain engine
        var forecastConfig = {
          spaceHeaterKw:   configFromYaml.spaceHeaterKw,
          transferFeeCKwh: configFromYaml.transferFeeCKwh,
          collectorAreaM2: configFromYaml.collectorAreaM2,
          collectorEfficiency: configFromYaml.collectorEfficiency,
          fitBucketCount: coeff.fitBucketCount || 0,
          weatherFetchedAt: weather.length > 0 ? new Date() : null,
        };

        // Coerce weather/prices rows for the engine (validAt → ts)
        var wx48 = weather.map(function (r) {
          return {
            ts:              r.validAt,
            temperature:     r.temperature,
            radiationGlobal: r.radiationGlobal,
            windSpeed:       r.windSpeed,
            precipitation:   r.precipitation,
          };
        });
        var px48 = prices.map(function (r) {
          return { ts: r.validAt, priceCKwh: r.priceCKwh };
        });

        var forecast = computeSustainForecast({
          now:           new Date(),
          tankTop:       tankTop !== null ? tankTop : 20,
          tankBottom:    tankBottom !== null ? tankBottom : 18,
          greenhouseTemp: ghTemp !== null ? ghTemp : 10,
          currentMode:   currentMode || 'idle',
          weather48h:    wx48,
          prices48h:     px48,
          coefficients:  coeff,
          config:        forecastConfig,
        });

        var response = {
          generatedAt: new Date().toISOString(),
          weather:     weather,
          prices:      prices,
          forecast:    forecast,
        };

        _responseCache    = response;
        _responseCachedAt = Date.now();

        jsonResponse(res, 200, response);
      });
    }

    queryLatestSensorReadings(function (err, s) {
      sensors = s || {};
      onPart(err);
    });
    queryCurrentMode(function (err, m) {
      currentMode = m;
      onPart(err);
    });
    queryWeather48h(function (err, w) {
      weather = w || [];
      onPart(err);
    });
    queryPrices48h(function (err, p) {
      prices = p || [];
      onPart(err);
    });
  }

  return { handle: handle };
}

module.exports = { createForecastHandler: createForecastHandler };
