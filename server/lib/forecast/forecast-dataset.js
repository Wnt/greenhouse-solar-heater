'use strict';

/**
 * Forecast tuning dataset — the full set of inputs and outputs an
 * external tool needs to fine-tune the projection algorithm, assembled
 * for one time window:
 *
 *   weather      FMI HARMONIE forecast rows (latest fetch per hour:
 *                temperature, radiation, wind, precipitation, humidity,
 *                dew point, cloud cover, wind gust, pressure)
 *   prices       electricity spot prices, both upstream sources
 *                (sähkötin + Nord Pool predict), latest fetch per hour
 *   predictions  multi-horizon forecast_predictions rows — the engine's
 *                projected tank/greenhouse state and per-hour components
 *                at every horizon, plus the weather/price inputs it used
 *   generations  per-generation algorithm fingerprint — algorithm_version
 *                plus the tuning overrides (tu) and fitted coefficients,
 *                de-duplicated out of the prediction rows so the payload
 *                doesn't repeat the same JSONB blob 48× per generation
 *   sources      health/status of each external data source
 *
 * Read-only. Backs the public, unauthenticated /api/public/history feed.
 *
 * create({ pool, log, getRefresherStatus }) → { getDataset(opts, cb) }
 *   opts = { range: string, horizon: number|null }
 */

// Range string → window length in hours. null = unbounded ('all').
// Mirrors the range vocabulary accepted by db.getHistory / db.getEvents.
const RANGE_HOURS = {
  '1h': 1, '6h': 6, '12h': 12, '24h': 24, '48h': 48,
  '3d': 72, '7d': 168, '14d': 336,
  '1mo': 720, '30d': 720, '2mo': 1440, '4mo': 2880, '1y': 8760,
  'all': null,
};
const DEFAULT_RANGE = '24h';
// Safety valve on the prediction bulk export — 48 horizons × hourly
// generations adds up fast on long ranges.
const MAX_PREDICTION_ROWS = 100000;
// A source is stale once it has missed two refresh cycles.
const STALE_CYCLES = 2;

function create(opts) {
  const pool = opts.pool;
  const log = opts.log || { error: function () {}, warn: function () {} };
  const getRefresherStatus = typeof opts.getRefresherStatus === 'function'
    ? opts.getRefresherStatus
    : null;

  function windowHours(range) {
    if (Object.prototype.hasOwnProperty.call(RANGE_HOURS, range)) return RANGE_HOURS[range];
    return RANGE_HOURS[DEFAULT_RANGE];
  }

  // Compose a `col >= NOW() - INTERVAL 'N hours'` clause. `hours` is an
  // integer drawn from the fixed RANGE_HOURS map (never raw user input),
  // so interpolating it is safe. null hours ('all') → no lower bound.
  function sinceClause(col, hours) {
    if (hours === null || hours === undefined) return '';
    return ' WHERE ' + col + " >= NOW() - INTERVAL '" + hours + " hours'";
  }

  // Run one section query; on error log + yield [] so a single missing
  // table or transient failure degrades that section instead of sinking
  // the whole dataset.
  function section(label, sql, params, callback) {
    pool.query(sql, params, function (err, result) {
      if (err) {
        log.error('forecast-dataset: ' + label + ' query failed', { error: err.message });
        callback([]);
        return;
      }
      callback((result && result.rows) || []);
    });
  }

  function queryWeather(hours, callback) {
    const sql =
      'SELECT DISTINCT ON (valid_at) valid_at, fetched_at, temperature, ' +
      '  radiation_global, wind_speed, precipitation, humidity, dew_point, ' +
      '  cloud_cover, wind_gust, pressure ' +
      'FROM weather_forecasts' + sinceClause('valid_at', hours) +
      ' ORDER BY valid_at, fetched_at DESC';
    section('weather', sql, [], function (rows) {
      callback(rows.map(function (r) {
        return {
          validAt: iso(r.valid_at),
          fetchedAt: iso(r.fetched_at),
          temperature: r.temperature,
          radiationGlobal: r.radiation_global,
          windSpeed: r.wind_speed,
          precipitation: r.precipitation,
          humidity: r.humidity,
          dewPoint: r.dew_point,
          cloudCover: r.cloud_cover,
          windGust: r.wind_gust,
          pressure: r.pressure,
        };
      }));
    });
  }

  function queryPrices(hours, callback) {
    const sql =
      'SELECT DISTINCT ON (valid_at, source) valid_at, fetched_at, source, price_c_kwh ' +
      'FROM spot_prices' + sinceClause('valid_at', hours) +
      ' ORDER BY valid_at, source, fetched_at DESC';
    section('prices', sql, [], function (rows) {
      callback(rows.map(function (r) {
        return {
          validAt: iso(r.valid_at),
          fetchedAt: iso(r.fetched_at),
          source: r.source,
          priceCKwh: r.price_c_kwh,
        };
      }));
    });
  }

  function queryPredictions(hours, horizon, callback) {
    let sql =
      'SELECT generated_at, horizon_h, for_hour, mode, has_solar_overlay, duty, ' +
      '  tank_top_c, tank_bottom_c, tank_avg_c, greenhouse_c, ' +
      '  pred_solar_gain_kwh, pred_rad_delivered_w, pred_heater_kwh, ' +
      '  pred_tank_loss_w, pred_cloud_factor, ' +
      '  outdoor_c, radiation_w_m2, wind_speed_m_s, precipitation_mm, ' +
      '  price_c_kwh, algorithm_version, tu, coefficients ' +
      'FROM forecast_predictions' + sinceClause('for_hour', hours);
    const params = [];
    if (horizon !== null && horizon !== undefined) {
      sql += (sql.indexOf(' WHERE ') === -1 ? ' WHERE ' : ' AND ') + 'horizon_h = $1';
      params.push(horizon);
    }
    sql += ' ORDER BY generated_at, horizon_h LIMIT ' + MAX_PREDICTION_ROWS;
    section('predictions', sql, params, callback);
  }

  function mapPrediction(r) {
    return {
      generatedAt: iso(r.generated_at),
      horizonH: r.horizon_h,
      forHour: iso(r.for_hour),
      mode: r.mode,
      hasSolarOverlay: !!r.has_solar_overlay,
      duty: r.duty,
      tankTopC: r.tank_top_c,
      tankBottomC: r.tank_bottom_c,
      tankAvgC: r.tank_avg_c,
      greenhouseC: r.greenhouse_c,
      predSolarGainKwh: r.pred_solar_gain_kwh,
      predRadDeliveredW: r.pred_rad_delivered_w,
      predHeaterKwh: r.pred_heater_kwh,
      predTankLossW: r.pred_tank_loss_w,
      predCloudFactor: r.pred_cloud_factor,
      outdoorC: r.outdoor_c,
      radiationWm2: r.radiation_w_m2,
      windSpeedMs: r.wind_speed_m_s,
      precipitationMm: r.precipitation_mm,
      priceCKwh: r.price_c_kwh,
      algorithmVersion: r.algorithm_version,
    };
  }

  // De-duplicate the tu + coefficients JSONB blobs (identical across all
  // 48 horizon rows of one generation) into a generations index keyed by
  // generatedAt, so the prediction rows themselves can stay slim.
  function buildGenerations(rawRows) {
    const seen = {};
    const out = [];
    for (let i = 0; i < rawRows.length; i++) {
      const r = rawRows[i];
      const key = iso(r.generated_at);
      if (!key || seen[key]) continue;
      seen[key] = true;
      out.push({
        generatedAt: key,
        algorithmVersion: r.algorithm_version,
        tu: parseJson(r.tu),
        coefficients: parseJson(r.coefficients),
      });
    }
    return out;
  }

  function buildSources() {
    const st = getRefresherStatus ? getRefresherStatus() : null;
    const interval = st ? st.refreshIntervalMs : null;
    const enabled = st ? !!st.enabled : false;
    return [
      sourceEntry('fmi-weather', 'FMI HARMONIE weather forecast',
        st && st.weather, interval, enabled),
      sourceEntry('spot-price', 'Electricity spot price (sähkötin + Nord Pool predict)',
        st && st.prices, interval, enabled),
    ];
  }

  function sourceEntry(id, label, s, intervalMs, enabled) {
    const now = Date.now();
    const successMs = s && s.lastSuccessAt ? Date.parse(s.lastSuccessAt) : null;
    const errorMs = s && s.lastErrorAt ? Date.parse(s.lastErrorAt) : null;
    const ageSeconds = successMs ? Math.round((now - successMs) / 1000) : null;

    let status;
    if (!enabled) {
      status = 'disabled';
    } else if (!s || !s.lastAttemptAt) {
      status = 'pending';
    } else if (errorMs !== null && (successMs === null || errorMs >= successMs)) {
      status = 'error';
    } else if (successMs !== null && intervalMs && (now - successMs) > STALE_CYCLES * intervalMs) {
      status = 'stale';
    } else {
      status = 'ok';
    }

    return {
      id,
      label,
      status,
      enabled,
      lastAttemptAt: (s && s.lastAttemptAt) || null,
      lastSuccessAt: (s && s.lastSuccessAt) || null,
      lastErrorAt: (s && s.lastErrorAt) || null,
      lastError: (s && s.lastError) || null,
      rowsLastFetch: s && s.lastSuccessRows != null ? s.lastSuccessRows : null,
      ageSeconds,
      refreshIntervalMs: intervalMs || null,
    };
  }

  // Assemble the full window. Always calls back with (null, dataset);
  // individual sections degrade to [] on failure rather than erroring
  // out, and `sources` is built from in-memory refresher state so it
  // survives even when every DB query fails.
  function getDataset(options, callback) {
    const opts = options || {};
    const range = opts.range || DEFAULT_RANGE;
    const horizon = opts.horizon !== null && opts.horizon !== undefined && !isNaN(opts.horizon)
      ? opts.horizon
      : null;
    const hours = windowHours(range);
    const sources = buildSources();

    if (!pool) {
      callback(null, { weather: [], prices: [], predictions: [], generations: [], sources });
      return;
    }

    queryWeather(hours, function (weather) {
      queryPrices(hours, function (prices) {
        queryPredictions(hours, horizon, function (rawPredictions) {
          callback(null, {
            weather,
            prices,
            predictions: rawPredictions.map(mapPrediction),
            generations: buildGenerations(rawPredictions),
            sources,
          });
        });
      });
    });
  }

  return { getDataset };
}

function iso(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function parseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_e) { return null; }
}

module.exports = { create };
