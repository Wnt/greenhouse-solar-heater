'use strict';

// GET /api/forecast?engine=ml handler.
//
// Self-contained so the physics forecast-handler.js stays untouched
// (and under its line cap): own DB queries, own 60 s response cache,
// own model load. forecast-bootstrap.js dispatches to this handler when
// the request carries `engine=ml`.
//
// createMlForecastHandler({ pool, log, systemYaml }) -> { handle(req, res) }

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { computeMlForecast } = require('./ml-forecast');
const deviceConfig = require('../../device-config');
const { jsonResponse } = require('../../http-handlers');

const CACHE_TTL_MS = 60 * 1000;
const MODEL_PATH = path.join(__dirname, 'forecast-model.json.gz');

// Load + gunzip the committed model once. Returns null (and logs) when
// the artifact is missing or corrupt — the handler then answers 503.
function loadModel(log) {
  try {
    const json = zlib.gunzipSync(fs.readFileSync(MODEL_PATH)).toString('utf8');
    return JSON.parse(json);
  } catch (e) {
    log.warn('ml-forecast: model artifact unavailable', { error: e.message, path: MODEL_PATH });
    return null;
  }
}

function createMlForecastHandler(opts) {
  const pool = opts.pool;
  const log = opts.log;
  const systemYaml = opts.systemYaml || {};
  const model = loadModel(log);

  const electricity = systemYaml.electricity || {};
  const spaceHeater = systemYaml.space_heater || {};

  let cache = null;
  let cachedAt = 0;

  // ── DB queries (latest fetch per hour, next 48 h) ──

  function queryLatestSensors(callback) {
    const sql =
      'SELECT DISTINCT ON (sensor_id) sensor_id, avg_value AS value ' +
      'FROM sensor_readings_30s ' +
      "WHERE bucket > NOW() - INTERVAL '24 hours' " +
      'ORDER BY sensor_id, bucket DESC';
    pool.query(sql, [], function done(err, result) {
      if (err) { callback(err); return; }
      const s = {};
      (result.rows || []).forEach(function add(r) { s[r.sensor_id] = r.value; });
      callback(null, s);
    });
  }

  function queryCurrentMode(callback) {
    const sql =
      "SELECT " +
      "  (SELECT new_value FROM state_events " +
      "   WHERE entity_type='mode' ORDER BY ts DESC LIMIT 1) AS mode, " +
      "  EXISTS(SELECT 1 FROM state_events " +
      "    WHERE entity_type='mode' AND new_value='emergency_heating' " +
      "      AND ts > NOW() - INTERVAL '1 hour') AS emergency_recent";
    pool.query(sql, [], function done(err, result) {
      if (err) { callback(err); return; }
      const row = (result.rows && result.rows[0]) || {};
      callback(null, { mode: row.mode || 'idle', emergencyRecentlyActive: !!row.emergency_recent });
    });
  }

  function queryWeather48h(callback) {
    const sql =
      'SELECT DISTINCT ON (valid_at) valid_at, temperature, ' +
      '  radiation_global AS "radiationGlobal", wind_speed AS "windSpeed", precipitation ' +
      'FROM weather_forecasts ' +
      "WHERE valid_at >= NOW() AND valid_at <= NOW() + INTERVAL '48 hours' " +
      'ORDER BY valid_at, fetched_at DESC';
    pool.query(sql, [], function done(err, result) {
      if (err) { callback(err); return; }
      callback(null, (result.rows || []).map(function map(r) {
        return {
          validAt: new Date(r.valid_at).toISOString(),
          temperature: r.temperature,
          radiationGlobal: r.radiationGlobal,
          windSpeed: r.windSpeed,
          precipitation: r.precipitation,
        };
      }));
    });
  }

  function queryPrices48h(callback) {
    const sql =
      'SELECT DISTINCT ON (valid_at) valid_at, price_c_kwh AS "priceCKwh" ' +
      'FROM spot_prices ' +
      "WHERE valid_at >= NOW() AND valid_at <= NOW() + INTERVAL '48 hours' " +
      "ORDER BY valid_at, CASE source WHEN 'sahkotin' THEN 0 ELSE 1 END, fetched_at DESC";
    pool.query(sql, [], function done(err, result) {
      if (err) { callback(err); return; }
      callback(null, (result.rows || []).map(function map(r) {
        return { validAt: new Date(r.valid_at).toISOString(), priceCKwh: r.priceCKwh };
      }));
    });
  }

  // ── Compute ──

  function compute(callback) {
    if (!pool) { callback(new Error('Database not available')); return; }
    if (!model) { callback(new Error('ML model not available')); return; }

    const nowMs = Date.now();
    if (cache && (nowMs - cachedAt) < CACHE_TTL_MS) { callback(null, cache); return; }

    // Each section degrades to empty on a query failure rather than
    // sinking the whole forecast — a transient DB hiccup still yields a
    // (default-seeded) forecast instead of a 500.
    let pending = 4;
    let sensors = {};
    let modeInfo = null;
    let weather = [];
    let prices = [];

    function onPart(err, label) {
      if (err) log.warn('ml-forecast: ' + label + ' query failed', { error: err.message });
      pending -= 1;
      if (pending > 0) return;

      const dcfg = deviceConfig.getConfig() || {};
      const tuning = deviceConfig.effectiveTuning(dcfg.tu || {});
      const config = {
        spaceHeaterKw: typeof spaceHeater.assumed_continuous_power_kw === 'number'
          ? spaceHeater.assumed_continuous_power_kw : 1,
        transferFeeCKwh: typeof electricity.transfer_fee_c_kwh === 'number'
          ? electricity.transfer_fee_c_kwh : 5,
        greenhouseEnterC: tuning.geT,
        greenhouseExitC: tuning.gxT,
        greenhouseMinTankDeltaC: tuning.gmD,
        greenhouseExitTankDeltaC: tuning.gxD,
        emergencyEnterC: tuning.ehE,
        emergencyExitC: tuning.ehX,
        fanCoolEnterC: tuning.fcE,
        fanCoolExitC: tuning.fcX,
        weatherFetchedAt: weather.length > 0 ? new Date() : null,
      };

      const tankTop = (sensors && sensors.tank_top != null) ? sensors.tank_top : null;
      const tankBottom = (sensors && sensors.tank_bottom != null) ? sensors.tank_bottom : null;
      const ghTemp = (sensors && sensors.greenhouse != null) ? sensors.greenhouse : null;

      let forecast;
      try {
        forecast = computeMlForecast({
          now: new Date(),
          tankTop: tankTop !== null ? tankTop : 20,
          tankBottom: tankBottom !== null ? tankBottom : 18,
          greenhouseTemp: ghTemp !== null ? ghTemp : 10,
          currentMode: (modeInfo && modeInfo.mode) || 'idle',
          emergencyRecentlyActive: !!(modeInfo && modeInfo.emergencyRecentlyActive),
          weather48h: weather,
          prices48h: prices,
          model,
          config,
        });
      } catch (e) {
        callback(e);
        return;
      }

      cache = {
        generatedAt: forecast.generatedAt,
        engine: 'ml',
        algorithmVersion: 'ml',
        mlTrainedAt: model.trainedAt || null,
        tu: dcfg.tu || {},
        weather,
        prices,
        forecast,
      };
      cachedAt = Date.now();
      callback(null, cache);
    }

    queryLatestSensors(function got(err, s) { if (s) sensors = s; onPart(err, 'sensors'); });
    queryCurrentMode(function got(err, m) { if (m) modeInfo = m; onPart(err, 'mode'); });
    queryWeather48h(function got(err, w) { if (w) weather = w; onPart(err, 'weather'); });
    queryPrices48h(function got(err, p) { if (p) prices = p; onPart(err, 'prices'); });
  }

  function handle(req, res) {
    compute(function done(err, response) {
      if (err) {
        if (/Database not available/i.test(err.message)) {
          jsonResponse(res, 503, { error: 'Database not available' });
        } else if (/model not available/i.test(err.message)) {
          jsonResponse(res, 503, { error: 'ML forecast model not available' });
        } else {
          log.error('ml-forecast: query failed', { error: err.message });
          jsonResponse(res, 500, { error: 'Forecast query failed' });
        }
        return;
      }
      jsonResponse(res, 200, response);
    });
  }

  return { handle, compute, modelLoaded: !!model };
}

module.exports = { createMlForecastHandler };
