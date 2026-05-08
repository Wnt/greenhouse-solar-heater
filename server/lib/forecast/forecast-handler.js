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

const { fitEmpiricalCoefficients, computeSustainForecast } = require('./sustain-forecast');
const { ALGORITHM_VERSION } = require('./version');
const deviceConfig = require('../device-config');
const { jsonResponse } = require('../http-handlers');

const CACHE_TTL_MS         = 60 * 1000;     // 60 s response cache
const COEFF_CACHE_TTL_MS   = 60 * 60 * 1000; // 1 h coefficient cache

function createForecastHandler(opts) {
  const pool       = opts.pool;
  const log        = opts.log;
  const systemYaml = opts.systemYaml || {};
  // Optional callback that produces { rows } of historical predictions
  // to attach to the response. Plumbed via createForecastHandler so the
  // module stays unaware of forecast-predictions itself (no circular
  // dep: the bootstrap creates predictions, then the handler).
  // Signature: listRecentPredictions(limit, cb)
  const listRecentPredictions = typeof opts.listRecentPredictions === 'function'
    ? opts.listRecentPredictions : null;
  const PREDICTIONS_LIMIT = 48;

  // ── Per-instance caches (so tests don't share state across handlers) ──
  let _responseCache    = null;
  let _responseCachedAt = 0;
  let _coeffCache       = null;
  let _coeffCachedAt    = 0;

  // Read config from system.yaml with fallbacks matching sustain-forecast defaults.
  // The engine no longer takes collector area / efficiency — solar gain is
  // empirical (see fitSolarGainByHour) so those physics constants are dead.
  const electricity  = systemYaml.electricity || {};
  const spaceHeater  = systemYaml.space_heater || {};

  const configFromYaml = {
    spaceHeaterKw:    typeof spaceHeater.assumed_continuous_power_kw === 'number'
                        ? spaceHeater.assumed_continuous_power_kw : 1,
    transferFeeCKwh:  typeof electricity.transfer_fee_c_kwh === 'number'
                        ? electricity.transfer_fee_c_kwh : 5,
  };

  // ── Query helpers ──

  function queryRecentRates(callback) {
    // Observed K/h drop rates for tank-avg AND greenhouse over the last
    // ~70 min. Both are used to calibrate the engine: the tank rate sets
    // the projected depletion, and the greenhouse rate captures whatever
    // heat balance is currently achieved (which the engine's first-
    // principles model can't easily reproduce — the greenhouse loss
    // coefficient depends on ventilation, soil moisture, etc.).
    const sql =
      "SELECT bucket, sensor_id, avg_value FROM sensor_readings_30s " +
      "WHERE sensor_id IN ('tank_top','tank_bottom','greenhouse') " +
      "  AND bucket > NOW() - INTERVAL '70 minutes' " +
      "ORDER BY bucket";
    pool.query(sql, [], function (err, result) {
      if (err) return callback(err);
      const tankByTs = {}; const ghByTs = {};
      (result.rows || []).forEach(function (r) {
        const k = r.bucket.toISOString();
        if (r.sensor_id === 'greenhouse') ghByTs[k] = r.avg_value;
        else {
          if (!tankByTs[k]) tankByTs[k] = { sum: 0, n: 0, ts: r.bucket };
          tankByTs[k].sum += r.avg_value; tankByTs[k].n += 1;
        }
      });
      const tankRows = Object.values(tankByTs).filter(function (x) { return x.n === 2; });
      tankRows.sort(function (a, b) { return a.ts - b.ts; });
      const ghKeys = Object.keys(ghByTs).sort();
      if (tankRows.length < 4 || ghKeys.length < 4) return callback(null, { tank: null, gh: null });
      const tankFirst = tankRows[0], tankLast = tankRows[tankRows.length - 1];
      const tankDtH   = (tankLast.ts - tankFirst.ts) / 3600000;
      if (tankDtH < 0.25) return callback(null, { tank: null, gh: null });
      const tankRate  = ((tankFirst.sum / 2) - (tankLast.sum / 2)) / tankDtH;
      const ghFirstTs = new Date(ghKeys[0]); const ghLastTs = new Date(ghKeys[ghKeys.length - 1]);
      const ghDtH     = (ghLastTs - ghFirstTs) / 3600000;
      const ghRate    = ghDtH > 0.25 ? (ghByTs[ghKeys[0]] - ghByTs[ghKeys[ghKeys.length - 1]]) / ghDtH : null;
      callback(null, { tank: tankRate, gh: ghRate });
    });
  }

  function queryLatestSensorReadings(callback) {
    // Latest value per sensor from the 30 s aggregate (last 24 h).
    const sql =
      'SELECT DISTINCT ON (sensor_id) sensor_id, avg_value AS value ' +
      'FROM sensor_readings_30s ' +
      "WHERE bucket > NOW() - INTERVAL '24 hours' " +
      'ORDER BY sensor_id, bucket DESC';
    pool.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      const sensors = {};
      (result.rows || []).forEach(function (row) {
        sensors[row.sensor_id] = row.value;
      });
      callback(null, sensors);
    });
  }

  function queryCurrentMode(callback) {
    // Pull the latest mode AND whether emergency_heating fired in the
    // past hour. The engine uses the recency flag to short-circuit
    // hoursUntilBackupNeeded — if the controller has already been
    // cycling backup, the tank is functionally exhausted right now,
    // not "in 4 hours when our simulation predicts emergency".
    const sql =
      "SELECT " +
      "  (SELECT new_value FROM state_events " +
      "   WHERE entity_type='mode' ORDER BY ts DESC LIMIT 1) AS mode, " +
      "  EXISTS(SELECT 1 FROM state_events " +
      "    WHERE entity_type='mode' AND new_value='emergency_heating' " +
      "      AND ts > NOW() - INTERVAL '1 hour'" +
      "  ) AS emergency_recent";
    pool.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      const row = (result.rows && result.rows[0]) || {};
      callback(null, {
        mode: row.mode || 'idle',
        emergencyRecentlyActive: !!row.emergency_recent,
      });
    });
  }

  function queryWeather48h(callback) {
    // Latest fetched_at per valid_at for the next 48 h.
    const sql =
      'SELECT DISTINCT ON (valid_at) valid_at, temperature, ' +
      '  radiation_global AS "radiationGlobal", ' +
      '  wind_speed AS "windSpeed", precipitation, ' +
      '  humidity, dew_point AS "dewPoint", cloud_cover AS "cloudCover", ' +
      '  wind_gust AS "windGust", pressure ' +
      'FROM weather_forecasts ' +
      "WHERE valid_at >= NOW() AND valid_at <= NOW() + INTERVAL '48 hours' " +
      'ORDER BY valid_at, fetched_at DESC';
    pool.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      const rows = (result.rows || []).map(function (r) {
        return {
          validAt:         new Date(r.valid_at).toISOString(),
          temperature:     r.temperature,
          radiationGlobal: r.radiationGlobal,
          windSpeed:       r.windSpeed,
          precipitation:   r.precipitation,
          humidity:        r.humidity,
          dewPoint:        r.dewPoint,
          cloudCover:      r.cloudCover,
          windGust:        r.windGust,
          pressure:        r.pressure,
        };
      });
      callback(null, rows);
    });
  }

  function queryPrices48h(callback) {
    // Latest fetched_at per (valid_at, source); prefer sahkotin over nordpool-predict.
    const sql =
      'SELECT DISTINCT ON (valid_at) valid_at, source, price_c_kwh AS "priceCKwh" ' +
      'FROM spot_prices ' +
      "WHERE valid_at >= NOW() AND valid_at <= NOW() + INTERVAL '48 hours' " +
      "ORDER BY valid_at, CASE source WHEN 'sahkotin' THEN 0 ELSE 1 END, fetched_at DESC";
    pool.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      const rows = (result.rows || []).map(function (r) {
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
    // Joins the closest hour-aligned weather_forecasts radiation onto each
    // reading so the GH-model fits can mask off sunny hours, and excludes
    // readings during maintenance intervals (manual override or mode-ban
    // active) so the fit isn't polluted by hours where the controller
    // wasn't free to actuate. config_events kind values: 'mo' = manual
    // override (any new_value JSON = active), 'wb' = mode ban (new_value
    // is the unix-second expiry; non-empty = banned). 'ea' bit-mask
    // changes are skipped here — disabling the space heater is captured
    // by 'wb EH' from the operator's perspective.
    const sensorSql =
      'SELECT bucket AS ts, sensor_id, avg_value AS value ' +
      'FROM sensor_readings_30s ' +
      "WHERE bucket > NOW() - INTERVAL '14 days' " +
      'ORDER BY bucket';
    const modeSql =
      'SELECT ts, new_value AS mode ' +
      'FROM state_events ' +
      "WHERE entity_type = 'mode' AND ts > NOW() - INTERVAL '14 days' " +
      'ORDER BY ts';
    const radSql =
      'SELECT DISTINCT ON (valid_at) valid_at, radiation_global ' +
      'FROM weather_forecasts ' +
      "WHERE valid_at > NOW() - INTERVAL '14 days' AND radiation_global IS NOT NULL " +
      'ORDER BY valid_at, fetched_at DESC';
    const maintSql =
      "SELECT ts, kind, key, new_value FROM config_events " +
      "WHERE ts > NOW() - INTERVAL '14 days' AND kind IN ('mo', 'wb') " +
      "ORDER BY ts";

    pool.query(sensorSql, [], function (err, sensorResult) {
      if (err) { callback(err); return; }
      pool.query(modeSql, [], function (mErr, modeResult) {
        if (mErr) { callback(mErr); return; }
        pool.query(radSql, [], function (rErr, radResult) {
          if (rErr) { callback(rErr); return; }
          pool.query(maintSql, [], function (cErr, maintResult) {
            if (cErr) { callback(cErr); return; }
            const result = pivotHistory(sensorResult.rows, modeResult.rows, radResult.rows, maintResult.rows);
            callback(null, result);
          });
        });
      });
    });
  }

  // ── Coefficients with 1 h in-process cache ──

  function getCoefficients(callback) {
    const now = Date.now();
    if (_coeffCache && (now - _coeffCachedAt) < COEFF_CACHE_TTL_MS) {
      callback(null, _coeffCache);
      return;
    }
    queryHistory14d(function (err, history) {
      if (err) {
        log.warn('forecast-handler: history query failed, using defaults', { error: err.message });
        const defaults = fitEmpiricalCoefficients({});
        _coeffCache = defaults;
        _coeffCachedAt = now;
        callback(null, defaults);
        return;
      }
      // Pass the heater wattage so fitGreenhouseLossWPerK can convert
      // observed duty cycles into watts. system.yaml ships 1 kW; if the
      // operator wires a different heater the YAML is the single source
      // of truth and the fit must reflect it.
      const heaterW = configFromYaml.spaceHeaterKw * 1000;
      const coeff = fitEmpiricalCoefficients(history, { heaterW });
      coeff.fitBucketCount = history.readings ? history.readings.length : 0;
      _coeffCache    = coeff;
      _coeffCachedAt = now;
      callback(null, coeff);
    });
  }

  // ── Handle ──

  // Programmatic entry point: computes (or returns from cache) the
  // forecast response object and hands it to callback(err, response).
  // The HTTP handler `handle()` and the prediction-capture scheduler
  // share this path so they always see the same numbers.
  function compute(callback) {
    if (!pool) { callback(new Error('Database not available')); return; }

    const now = Date.now();
    if (_responseCache && (now - _responseCachedAt) < CACHE_TTL_MS) {
      callback(null, _responseCache);
      return;
    }

    // Gather all data in parallel where possible.
    let pending = 5;
    let sensors, modeInfo, weather, prices, coeff,
        observedTankDropKPerH, observedGhDropKPerH, fetchErr;

    function onPart(err) {
      if (err && !fetchErr) fetchErr = err;
      pending -= 1;
      if (pending > 0) return;

      getCoefficients(function (cErr, c) {
        if (cErr) { log.warn('forecast-handler: coefficients failed', { error: cErr.message }); }
        coeff = c || fitEmpiricalCoefficients({});

        if (fetchErr) {
          log.error('forecast-handler: query failed', { error: fetchErr.message });
          callback(fetchErr);
          return;
        }

        const tankTop    = (sensors && sensors.tank_top)    || null;
        const tankBottom = (sensors && sensors.tank_bottom) || null;
        const ghTemp     = (sensors && sensors.greenhouse)  || null;

        // Pull live device-config heating thresholds. The engine uses these
        // (instead of hardcoded 10 °C) so when the user has e.g. set
        // greenhouse heat enter to 13 °C, "Tank lasts" reflects the actual
        // continuous-heating depletion at the current threshold.
        // effectiveTuning returns SHORT keys (geT, gxT, ehE) — same shape as
        // tu — and merges user overrides over the control-logic defaults.
        const dcfg     = deviceConfig.getConfig() || {};
        const tuning   = deviceConfig.effectiveTuning(dcfg.tu || {});
        const forecastConfig = {
          spaceHeaterKw:   configFromYaml.spaceHeaterKw,
          transferFeeCKwh: configFromYaml.transferFeeCKwh,
          greenhouseEnterC: tuning.geT,
          greenhouseExitC:  tuning.gxT,
          // Tank-vs-greenhouse delta gates so the projection skips
          // greenhouse_heating bars when the tank is too cold to drive
          // the radiator (matches control-logic.js entry/exit checks).
          greenhouseMinTankDeltaC:  tuning.gmD,
          greenhouseExitTankDeltaC: tuning.gxD,
          emergencyEnterC:  tuning.ehE,
          emergencyExitC:   tuning.ehX,
          fitBucketCount: coeff.fitBucketCount || 0,
          weatherFetchedAt: weather.length > 0 ? new Date() : null,
        };

        // Coerce weather/prices rows for the engine (validAt → ts)
        const wx48 = weather.map(function (r) {
          return {
            ts:              r.validAt,
            temperature:     r.temperature,
            radiationGlobal: r.radiationGlobal,
            windSpeed:       r.windSpeed,
            precipitation:   r.precipitation,
          };
        });
        const px48 = prices.map(function (r) {
          return { ts: r.validAt, priceCKwh: r.priceCKwh };
        });

        const forecast = computeSustainForecast({
          now:           new Date(),
          tankTop:       tankTop !== null ? tankTop : 20,
          tankBottom:    tankBottom !== null ? tankBottom : 18,
          greenhouseTemp: ghTemp !== null ? ghTemp : 10,
          currentMode:   (modeInfo && modeInfo.mode) || 'idle',
          emergencyRecentlyActive: !!(modeInfo && modeInfo.emergencyRecentlyActive),
          observedTankDropKPerH,
          observedGhDropKPerH,
          weather48h:    wx48,
          prices48h:     px48,
          coefficients:  coeff,
          config:        forecastConfig,
        });

        const baseResponse = {
          generatedAt: new Date().toISOString(),
          // Algorithm version + active tu + fitted coefficients ride on
          // the top-level response so the predictions scheduler can
          // stamp them on each captured row. The System Logs export
          // shows which code version + which fit produced the live
          // forecast, so a tuning analysis can correlate prediction
          // shifts with config / fit changes.
          algorithmVersion: ALGORITHM_VERSION,
          tu:               dcfg.tu || {},
          coefficients:     coeff || null,
          weather,
          prices,
          forecast,
        };

        // Attach the recent-predictions history when wired. Soft-fail:
        // missing service or DB read failure ships without it — the
        // rest of the forecast is still useful.
        attachPredictions(baseResponse, function (response) {
          _responseCache    = response;
          _responseCachedAt = Date.now();
          callback(null, response);
        });
      });
    }

    function attachPredictions(response, done) {
      if (!listRecentPredictions) { done(response); return; }
      listRecentPredictions(PREDICTIONS_LIMIT, function (err, rows) {
        if (err) {
          log.warn('forecast-handler: predictions query failed', { error: err.message });
          done(response);
          return;
        }
        response.predictions = rows || [];
        done(response);
      });
    }

    queryLatestSensorReadings(function (err, s) {
      sensors = s || {};
      onPart(err);
    });
    queryCurrentMode(function (err, m) {
      modeInfo = m;
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
    queryRecentRates(function (err, rates) {
      // Soft failure: missing observed rates fall back to engine defaults.
      if (err) log.warn('forecast-handler: observed-rate query failed', { error: err.message });
      observedTankDropKPerH = (rates && typeof rates.tank === 'number' && isFinite(rates.tank)) ? rates.tank : null;
      observedGhDropKPerH   = (rates && typeof rates.gh   === 'number' && isFinite(rates.gh))   ? rates.gh   : null;
      onPart(null);
    });
  }

  // HTTP wrapper around compute(). Translates compute's callback shape
  // into the response codes /api/forecast already promises.
  function handle(req, res) {
    compute(function (err, response) {
      if (err) {
        const status = /Database not available/i.test(err.message) ? 503 : 500;
        const body   = status === 503 ? { error: 'Database not available' } : { error: 'Forecast query failed' };
        jsonResponse(res, status, body);
        return;
      }
      jsonResponse(res, 200, response);
    });
  }

  // Pre-warm the coefficient cache. The 14d history fit is the dominant
  // cold-start cost (~1.5s, ~185k rows on prod). Running it eagerly at
  // bootstrap means the first user request hits a warm cache and feels
  // snappy. Soft-failure: errors are logged but never propagated, since
  // bootstrap must succeed even when the pool isn't ready (e.g. tests).
  function prewarm() {
    if (!pool) return;
    getCoefficients(function (err) {
      if (err) {
        log.warn('forecast-handler: prewarm failed', { error: err.message });
      } else {
        log.info('forecast-handler: coefficient cache prewarmed');
      }
    });
  }

  return { handle, compute, prewarm };
}

// ── History pivoting / fit-input shaping ────────────────────────────────
//
// Hoisted out of the handler closure so it can be unit-tested and reused.
// Pivots sensor rows into one record per timestamp, attaches the closest
// hour-aligned forecast radiation (used by the GH-air fits to mask off
// sunny hours), and drops readings that fall inside any maintenance
// interval (manual-override or mode-ban active). Maintenance reasoning:
//
//   * `mo` (manual override) events with a non-empty new_value JSON open
//     an interval; the next `mo` event closes it. Override leaves the
//     controller un-free to actuate, so any greenhouse cooling/warming
//     during the window doesn't reflect the automated dynamics we want
//     to fit.
//   * `wb` (mode ban) events open / close a per-mode ban. While GH or
//     EH is banned the controller can't fire heating, so an idle hour
//     during a ban doesn't represent the engine's "natural cooling"
//     dynamic — drop those hours from the fit.
//
// In both cases the affected greenhouse data is what we DON'T want
// driving the τ_gh / α_solar / loss fits; tank-side fits could in
// principle keep them, but consistency wins over a marginal data gain.
function pivotHistory(sensorRows, modeRows, radRows, maintRows) {
  const buckets = {};
  (sensorRows || []).forEach(function (row) {
    const tsMs = new Date(row.ts).getTime();
    if (!buckets[tsMs]) { buckets[tsMs] = { ts: new Date(row.ts) }; }
    const f = { tank_top: 'tankTop', tank_bottom: 'tankBottom',
      greenhouse: 'greenhouse', outdoor: 'outdoor', collector: 'collector' }[row.sensor_id];
    if (f) buckets[tsMs][f] = row.value;
  });

  // Pre-sort + index radiation by hour for O(1) lookup per reading.
  const radByHour = {};
  (radRows || []).forEach(function (r) {
    const k = new Date(r.valid_at).getTime();
    radByHour[k] = r.radiation_global;
  });

  // Build maintenance intervals from config_events. Each interval is an
  // open-close pair on the same (kind, key); we walk the rows in order
  // and pair each "set" event (non-empty new_value) with the next event
  // for the same key. Unpaired opens at end of window stay open
  // through the rest of the data — match by ts >= setTs.
  const intervals = buildMaintenanceIntervals(maintRows);

  const readings = Object.keys(buckets)
    .sort(function (a, b) { return a - b; })
    .map(function (k) {
      const b = buckets[k];
      const tsMs = b.ts.getTime();
      // Closest hour-aligned radiation (within ±1 h).
      const hourMs = Math.floor(tsMs / 3600000) * 3600000;
      let rad = radByHour[hourMs];
      if (rad === undefined) rad = radByHour[hourMs + 3600000];
      if (typeof rad === 'number') b.radiationGlobal = rad;
      b._maintenance = intervalsCover(intervals, tsMs);
      return b;
    })
    .filter(function (b) { return !b._maintenance; });

  const modes = (modeRows || []).map(function (r) {
    return { ts: new Date(r.ts), mode: r.mode };
  });

  return { readings, modes };
}

function buildMaintenanceIntervals(maintRows) {
  if (!Array.isArray(maintRows) || maintRows.length === 0) return [];
  // Pair each open (non-empty new_value) with the next event for the
  // same (kind, key). Unpaired opens stay open to +Infinity. If the
  // first event for a key is a "clear" with a non-empty old_value, the
  // ban/override was already active when the window started — record an
  // interval from -Infinity to the clear ts so those readings are also
  // dropped. Otherwise a 14d window straddling a multi-day ban that was
  // set just before the window starts would leak the entire ban into
  // the fit input.
  const intervals = [];
  const open = {}; // key = kind + ':' + (key || '')
  const sawAnyEvent = {}; // first event per key has special semantics
  maintRows.forEach(function (r) {
    const k = r.kind + ':' + (r.key || '');
    const ts = new Date(r.ts).getTime();
    const isSet = r.new_value && r.new_value !== '';
    const isFirst = !sawAnyEvent[k];
    sawAnyEvent[k] = true;
    if (!isSet && isFirst && r.old_value && r.old_value !== '') {
      intervals.push([-Infinity, ts]);
      // No open state to update — ban is already cleared.
      return;
    }
    if (isSet) {
      if (open[k] !== undefined) intervals.push([open[k], ts]);
      open[k] = ts;
    } else if (open[k] !== undefined) {
      intervals.push([open[k], ts]);
      open[k] = undefined;
    }
  });
  Object.keys(open).forEach(function (k) {
    if (open[k] !== undefined) intervals.push([open[k], Infinity]);
  });
  // Sort + merge overlapping intervals so intervalsCover is a clean
  // linear scan.
  intervals.sort(function (a, b) { return a[0] - b[0]; });
  const merged = [];
  intervals.forEach(function (iv) {
    if (merged.length === 0 || merged[merged.length - 1][1] < iv[0]) {
      merged.push([iv[0], iv[1]]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], iv[1]);
    }
  });
  return merged;
}

function intervalsCover(intervals, tsMs) {
  for (let i = 0; i < intervals.length; i++) {
    if (tsMs >= intervals[i][0] && tsMs <= intervals[i][1]) return true;
    if (tsMs < intervals[i][0]) return false;
  }
  return false;
}

module.exports = {
  createForecastHandler,
  // exported for tests
  _pivotHistory: pivotHistory,
  _buildMaintenanceIntervals: buildMaintenanceIntervals,
};
