'use strict';

/**
 * Forecast diagnostics — predicted-vs-actual analysis for offline tuning.
 *
 * Three modes, served by the same handler:
 *
 *   GET /api/forecast/diagnostics?horizon=H&since=ISO&until=ISO[&engine=...]
 *     "Series" mode. Returns forecast_predictions rows at horizon=H
 *     across [since, until] joined with the closest sensor_readings_30s
 *     bucket per for_hour. Drives the operator-facing predicted-vs-actual
 *     line plot.
 *
 *   GET /api/forecast/diagnostics?generated_at=ISO[&engine=...]
 *     "Generation" mode. Returns all 1..48 horizon rows for one
 *     generation timestamp plus the actuals out to that horizon — drives
 *     the per-generation drilldown including the per-component breakdown
 *     (solar gain, radiator W, heater kWh, tank loss, cloud factor) and
 *     the fitted coefficients used by that generation.
 *
 *   Both pre-existing modes pin engine='physics' unless overridden with
 *   a validated ?engine=physics|ml — both engines' rows share
 *   forecast_predictions since dual-engine capture, and without the
 *   predicate ML rows would interleave into these responses.
 *
 *   GET /api/forecast/diagnostics?summary=mode-accuracy[&engine=physics|ml][&days=N]
 *     "Mode-accuracy" mode (findings doc #3/#7). Scores the captured
 *     mode schedule (forecast_predictions, per engine) against the mode
 *     transitions the controller actually logged (state_events), via
 *     the pure scorer in mode-metrics.js: accuracy by horizon bucket,
 *     per-mode precision/recall, solar + emergency detection, and the
 *     hour-of-day climatology baseline the engines must beat (measured:
 *     63–71 % beyond 4 h vs 71 % climatology).
 *
 * Read-only. Accessible to all authenticated roles (admin + readonly):
 * the table itself contains no operating credentials, only telemetry,
 * and the view's primary user is the admin operator anyway.
 *
 * create({ pool, log }) → { handle(req, res) }
 */

const { jsonResponse } = require('../http-handlers');
const modeMetrics = require('./mode-metrics');

const ALLOWED_HORIZONS = [1, 6, 12, 24, 48];
// Bound on the mode-accuracy prediction scan, mirroring the dataset
// module's MAX_PREDICTION_ROWS: 90 d x 24 generations x 48 horizons
// exceeds 100k rows per engine.
const MAX_MODE_ACCURACY_ROWS = 100000;
const DEFAULT_HORIZON  = 24;
const MAX_RANGE_DAYS   = 31;
const DEFAULT_RANGE_MS = 7  * 24 * 60 * 60 * 1000;
const ACTUAL_WINDOW_MIN = 30; // sensor_readings_30s buckets within ±30 min count

// sensor_id strings used in the `actuals` join. The frontend wants
// greenhouse + tank avg + outdoor; tank_top + tank_bottom are averaged
// JS-side.
const SENSOR_IDS = ['greenhouse', 'tank_top', 'tank_bottom', 'outdoor', 't_collector'];

// Valid ?engine= values for all three modes; default 'physics'.
const ENGINES = ['physics', 'ml'];

// Mode-accuracy summary knobs. 30 days default keeps the sample large
// enough to be meaningful (≈ 720 hours × up to 48 horizons) without
// scanning months of hypertable; 90-day cap bounds the query.
const MODE_ACCURACY_DEFAULT_DAYS = 30;
const MODE_ACCURACY_MAX_DAYS     = 90;

function create(opts) {
  const pool = opts.pool;
  const log  = opts.log || { info: function () {}, warn: function () {}, error: function () {} };

  function handle(req, res) {
    if (!pool) {
      jsonResponse(res, 503, { error: 'Database not available' });
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    // `summary` is a new param — requests without it fall through to the
    // two pre-existing modes untouched.
    const summaryRaw = url.searchParams.get('summary');
    if (summaryRaw) {
      if (summaryRaw !== 'mode-accuracy') {
        jsonResponse(res, 400, { error: 'summary must be mode-accuracy' });
        return;
      }
      const engine = parseEngine(url.searchParams.get('engine'));
      if (engine === null) { jsonResponse(res, 400, { error: 'engine must be one of ' + ENGINES.join(',') }); return; }
      const days = parseDays(url.searchParams.get('days'));
      if (days === null) { jsonResponse(res, 400, { error: 'Invalid days' }); return; }
      runModeAccuracyMode(engine, days, function (err, body) {
        if (err) {
          log.warn('forecast-diagnostics: mode-accuracy query failed', { error: err.message });
          jsonResponse(res, 500, { error: 'Diagnostics query failed' });
          return;
        }
        jsonResponse(res, 200, body);
      });
      return;
    }
    // Engine pinning for the two pre-existing modes: default physics,
    // optional validated override (see header).
    const engine = parseEngine(url.searchParams.get('engine'));
    if (engine === null) { jsonResponse(res, 400, { error: 'engine must be one of ' + ENGINES.join(',') }); return; }
    const generatedAtRaw = url.searchParams.get('generated_at');
    if (generatedAtRaw) {
      const t = parseIso(generatedAtRaw);
      if (!t) { jsonResponse(res, 400, { error: 'Invalid generated_at' }); return; }
      runGenerationMode(t.toISOString(), engine, function (err, body) {
        if (err) {
          log.warn('forecast-diagnostics: generation query failed', { error: err.message });
          jsonResponse(res, 500, { error: 'Diagnostics query failed' });
          return;
        }
        jsonResponse(res, 200, body);
      });
      return;
    }

    const horizon = parseHorizon(url.searchParams.get('horizon'));
    if (horizon === null) { jsonResponse(res, 400, { error: 'horizon must be one of ' + ALLOWED_HORIZONS.join(',') }); return; }
    const range = parseRange(url.searchParams.get('since'), url.searchParams.get('until'));
    if (!range) { jsonResponse(res, 400, { error: 'Invalid since/until' }); return; }

    runSeriesMode(horizon, range.since, range.until, engine, function (err, body) {
      if (err) {
        log.warn('forecast-diagnostics: series query failed', { error: err.message });
        jsonResponse(res, 500, { error: 'Diagnostics query failed' });
        return;
      }
      jsonResponse(res, 200, body);
    });
  }

  // ── Series mode ────────────────────────────────────────────────────

  function runSeriesMode(horizon, since, until, engine, callback) {
    const predSql =
      'SELECT generated_at, horizon_h, for_hour, mode, has_solar_overlay, duty, ' +
      '  tank_top_c, tank_bottom_c, tank_avg_c, greenhouse_c, ' +
      '  pred_solar_gain_kwh, pred_rad_delivered_w, pred_heater_kwh, ' +
      '  pred_tank_loss_w, pred_cloud_factor, ' +
      '  outdoor_c, radiation_w_m2, wind_speed_m_s, precipitation_mm, ' +
      '  price_c_kwh, algorithm_version ' +
      'FROM forecast_predictions ' +
      'WHERE engine = $1 AND horizon_h = $2 AND for_hour >= $3 AND for_hour <= $4 ' +
      'ORDER BY for_hour';
    pool.query(predSql, [engine, horizon, since, until], function (err, predResult) {
      if (err) return callback(err);
      const preds = (predResult.rows || []).map(toPredJson);
      if (preds.length === 0) {
        callback(null, {
          kind: 'series', horizon,
          since: since.toISOString(), until: until.toISOString(),
          rows: [],
        });
        return;
      }
      // Pull all relevant 30s buckets in one go and match per for_hour
      // in JS.
      const minTs = preds[0].for_hour;
      const maxTs = preds[preds.length - 1].for_hour;
      queryActuals(minTs, maxTs, function (aErr, byTs) {
        if (aErr) return callback(aErr);
        const rows = preds.map(function (p) {
          return {
            generated_at: p.generated_at,
            for_hour: p.for_hour,
            horizon_h: p.horizon_h,
            algorithm_version: p.algorithm_version,
            predicted: predictedSlim(p),
            actual: nearestActual(byTs, p.for_hour, ACTUAL_WINDOW_MIN),
          };
        });
        callback(null, {
          kind: 'series', horizon,
          since: since.toISOString(), until: until.toISOString(),
          rows,
        });
      });
    });
  }

  // ── Generation mode ────────────────────────────────────────────────

  function runGenerationMode(generatedAtIso, engine, callback) {
    const sql =
      'SELECT generated_at, horizon_h, for_hour, mode, has_solar_overlay, duty, ' +
      '  tank_top_c, tank_bottom_c, tank_avg_c, greenhouse_c, ' +
      '  pred_solar_gain_kwh, pred_rad_delivered_w, pred_heater_kwh, ' +
      '  pred_tank_loss_w, pred_cloud_factor, ' +
      '  outdoor_c, radiation_w_m2, wind_speed_m_s, precipitation_mm, ' +
      '  price_c_kwh, algorithm_version, tu, coefficients ' +
      'FROM forecast_predictions ' +
      'WHERE engine = $1 AND generated_at = $2 ' +
      'ORDER BY horizon_h';
    pool.query(sql, [engine, generatedAtIso], function (err, predResult) {
      if (err) return callback(err);
      const rawRows = (predResult.rows || []).map(toPredJson);
      if (rawRows.length === 0) {
        callback(null, { kind: 'generation', generated_at: generatedAtIso, horizons: [], tu: null, coefficients: null });
        return;
      }
      const tu = parseJson(rawRows[0]._tu);
      const coefficients = parseJson(rawRows[0]._coefficients);
      const minTs = rawRows[0].for_hour;
      const maxTs = rawRows[rawRows.length - 1].for_hour;
      queryActuals(minTs, maxTs, function (aErr, byTs) {
        if (aErr) return callback(aErr);
        const horizons = rawRows.map(function (p) {
          return {
            horizon_h: p.horizon_h,
            for_hour: p.for_hour,
            predicted: predictedFull(p),
            actual: nearestActual(byTs, p.for_hour, ACTUAL_WINDOW_MIN),
          };
        });
        callback(null, {
          kind: 'generation',
          generated_at: rawRows[0].generated_at,
          algorithm_version: rawRows[0].algorithm_version,
          tu, coefficients,
          horizons,
        });
      });
    });
  }

  // ── Mode-accuracy mode ─────────────────────────────────────────────

  function runModeAccuracyMode(engine, days, callback) {
    const until = Date.now();
    const since = until - days * 24 * 3600 * 1000;
    const sinceIso = new Date(since).toISOString();
    const untilIso = new Date(until).toISOString();
    // Mode fields only — temps/components are irrelevant to schedule
    // scoring and this scans up to 90 d × 48 horizons of rows. Scoring
    // is order-independent, so no ORDER BY; the LIMIT mirrors the
    // dataset module's MAX_PREDICTION_ROWS bound — days=90 can reach
    // ~100k+ rows per engine and this endpoint is reachable repeatedly
    // by any authenticated readonly user, so the worst case must be an
    // intentional cap, not an accident (PR #283 review).
    const predSql =
      'SELECT for_hour, horizon_h, mode, has_solar_overlay ' +
      'FROM forecast_predictions ' +
      'WHERE engine = $1 AND for_hour >= $2 AND for_hour <= $3 ' +
      'LIMIT ' + MAX_MODE_ACCURACY_ROWS;
    pool.query(predSql, [engine, sinceIso, untilIso], function (err, predResult) {
      if (err) return callback(err);
      const predictions = (predResult.rows || []).map(function (r) {
        return {
          forHour: r.for_hour instanceof Date ? r.for_hour.getTime() : new Date(r.for_hour).getTime(),
          horizonH: r.horizon_h,
          mode: r.mode,
          hasSolarOverlay: !!r.has_solar_overlay,
        };
      });
      // Ground truth: mode transitions in the window PLUS the latest one
      // at-or-before the window start, so the first hours have full
      // coverage (mode-metrics treats pre-first-transition time as
      // unknown → uncovered).
      const evSql =
        "(SELECT ts, new_value FROM state_events " +
        " WHERE entity_type = 'mode' AND ts <= $1 ORDER BY ts DESC LIMIT 1) " +
        'UNION ALL ' +
        "(SELECT ts, new_value FROM state_events " +
        " WHERE entity_type = 'mode' AND ts > $1 AND ts <= $2 ORDER BY ts)";
      pool.query(evSql, [sinceIso, untilIso], function (evErr, evResult) {
        if (evErr) return callback(evErr);
        const transitions = (evResult.rows || []).map(function (r) {
          return { ts: r.ts, mode: r.new_value };
        });
        const summary = modeMetrics.summarizeModeAccuracy({
          predictions,
          transitions,
          windowStartMs: since,
          windowEndMs: until,
        });
        callback(null, {
          engine,
          windowDays: days,
          sampleCount: summary.sampleCount,
          accuracyByHorizon: summary.accuracyByHorizon,
          perMode: summary.perMode,
          solar: summary.solar,
          emergency: summary.emergency,
          baselines: summary.baselines,
          generatedAt: new Date().toISOString(),
        });
      });
    });
  }

  // ── Actuals lookup ─────────────────────────────────────────────────

  function queryActuals(minIsoMaybe, maxIsoMaybe, callback) {
    const minIso = toIso(minIsoMaybe);
    const maxIso = toIso(maxIsoMaybe);
    const sql =
      'SELECT bucket, sensor_id, avg_value FROM sensor_readings_30s ' +
      "WHERE sensor_id = ANY($1) " +
      '  AND bucket >= $2::timestamptz - INTERVAL \'' + ACTUAL_WINDOW_MIN + ' minutes\' ' +
      '  AND bucket <= $3::timestamptz + INTERVAL \'' + ACTUAL_WINDOW_MIN + ' minutes\' ' +
      'ORDER BY bucket';
    pool.query(sql, [SENSOR_IDS, minIso, maxIso], function (err, result) {
      if (err) return callback(err);
      // Build a per-sensor sorted list of { ts, value } to do a fast
      // closest-bucket lookup.
      const bySensor = {};
      (result.rows || []).forEach(function (r) {
        const sid = r.sensor_id;
        if (!bySensor[sid]) bySensor[sid] = [];
        bySensor[sid].push({
          ts: r.bucket instanceof Date ? r.bucket.getTime() : new Date(r.bucket).getTime(),
          value: r.avg_value,
        });
      });
      // Each list is already ordered by bucket asc.
      callback(null, bySensor);
    });
  }

  return { handle, _runSeriesMode: runSeriesMode, _runGenerationMode: runGenerationMode };
}

// ── Pure helpers (exported via _ for tests) ─────────────────────────

function parseHorizon(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_HORIZON;
  const n = parseInt(raw, 10);
  if (!isFinite(n)) return null;
  for (let i = 0; i < ALLOWED_HORIZONS.length; i++) {
    if (ALLOWED_HORIZONS[i] === n) return n;
  }
  return null;
}

function parseRange(sinceRaw, untilRaw) {
  const now = Date.now();
  let until = now;
  if (untilRaw) {
    const t = parseIso(untilRaw); if (!t) return null;
    until = t.getTime();
  }
  let since = until - DEFAULT_RANGE_MS;
  if (sinceRaw) {
    const t = parseIso(sinceRaw); if (!t) return null;
    since = t.getTime();
  }
  if (since >= until) return null;
  if (until - since > MAX_RANGE_DAYS * 24 * 3600 * 1000) {
    since = until - MAX_RANGE_DAYS * 24 * 3600 * 1000;
  }
  return { since: new Date(since), until: new Date(until) };
}

function parseEngine(raw) {
  if (raw === null || raw === undefined || raw === '') return 'physics';
  return ENGINES.indexOf(raw) !== -1 ? raw : null;
}

function parseDays(raw) {
  if (raw === null || raw === undefined || raw === '') return MODE_ACCURACY_DEFAULT_DAYS;
  const n = parseInt(raw, 10);
  if (!isFinite(n) || n < 1) return null;
  return Math.min(n, MODE_ACCURACY_MAX_DAYS);
}

function parseIso(raw) {
  if (!raw) return null;
  const t = new Date(raw);
  if (isNaN(t.getTime())) return null;
  return t;
}

function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v;
  return new Date(v).toISOString();
}

function toPredJson(r) {
  return {
    generated_at: r.generated_at instanceof Date ? r.generated_at.toISOString() : r.generated_at,
    horizon_h: r.horizon_h,
    for_hour: r.for_hour instanceof Date ? r.for_hour.toISOString() : r.for_hour,
    mode: r.mode,
    has_solar_overlay: !!r.has_solar_overlay,
    duty: r.duty,
    tank_top_c: r.tank_top_c, tank_bottom_c: r.tank_bottom_c, tank_avg_c: r.tank_avg_c,
    greenhouse_c: r.greenhouse_c,
    pred_solar_gain_kwh: r.pred_solar_gain_kwh,
    pred_rad_delivered_w: r.pred_rad_delivered_w,
    pred_heater_kwh: r.pred_heater_kwh,
    pred_tank_loss_w: r.pred_tank_loss_w,
    pred_cloud_factor: r.pred_cloud_factor,
    outdoor_c: r.outdoor_c, radiation_w_m2: r.radiation_w_m2,
    wind_speed_m_s: r.wind_speed_m_s, precipitation_mm: r.precipitation_mm,
    price_c_kwh: r.price_c_kwh,
    algorithm_version: r.algorithm_version,
    _tu: r.tu, _coefficients: r.coefficients,
  };
}

// "Slim" payload for series rows — the operator just needs the headline
// trajectories on the time-series chart, not the per-component breakdown.
function predictedSlim(p) {
  return {
    mode: p.mode, has_solar_overlay: p.has_solar_overlay, duty: p.duty,
    tank_avg_c: p.tank_avg_c, greenhouse_c: p.greenhouse_c,
    outdoor_c: p.outdoor_c, radiation_w_m2: p.radiation_w_m2,
  };
}

// "Full" payload for the generation drilldown — per-component + weather.
function predictedFull(p) {
  return {
    mode: p.mode, has_solar_overlay: p.has_solar_overlay, duty: p.duty,
    tank_top_c: p.tank_top_c, tank_bottom_c: p.tank_bottom_c, tank_avg_c: p.tank_avg_c,
    greenhouse_c: p.greenhouse_c,
    pred_solar_gain_kwh: p.pred_solar_gain_kwh,
    pred_rad_delivered_w: p.pred_rad_delivered_w,
    pred_heater_kwh: p.pred_heater_kwh,
    pred_tank_loss_w: p.pred_tank_loss_w,
    pred_cloud_factor: p.pred_cloud_factor,
    outdoor_c: p.outdoor_c, radiation_w_m2: p.radiation_w_m2,
    wind_speed_m_s: p.wind_speed_m_s, precipitation_mm: p.precipitation_mm,
    price_c_kwh: p.price_c_kwh,
  };
}

function nearestActual(bySensor, forHourIso, windowMin) {
  const target = new Date(forHourIso).getTime();
  const cap = windowMin * 60 * 1000;
  const picks = {};
  ['greenhouse', 'outdoor', 't_collector'].forEach(function (sid) {
    picks[sid] = closest(bySensor[sid], target, cap);
  });
  // Tank avg = average of the matched tank_top + tank_bottom buckets at
  // the same target hour. If only one matches, fall back to that one
  // (the operator-visible tank_avg in the engine is also the simple mean).
  const top = closest(bySensor.tank_top, target, cap);
  const bot = closest(bySensor.tank_bottom, target, cap);
  let tankAvg = null;
  if (top !== null && bot !== null) tankAvg = (top + bot) / 2;
  else if (top !== null) tankAvg = top;
  else if (bot !== null) tankAvg = bot;

  return {
    greenhouse_c: picks.greenhouse,
    tank_top_c: top,
    tank_bottom_c: bot,
    tank_avg_c: tankAvg,
    outdoor_c: picks.outdoor,
    collector_c: picks.t_collector,
  };
}

function closest(sortedList, targetMs, capMs) {
  if (!sortedList || sortedList.length === 0) return null;
  let best = null; let bestDelta = Infinity;
  for (let i = 0; i < sortedList.length; i++) {
    const ts = sortedList[i].ts;
    const d = Math.abs(ts - targetMs);
    if (d < bestDelta) { bestDelta = d; best = sortedList[i]; }
    if (ts > targetMs + capMs) break; // sorted asc
  }
  return best && bestDelta <= capMs ? best.value : null;
}

function parseJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (_e) { return null; }
}

module.exports = {
  create,
  // exposed for unit tests
  _parseHorizon: parseHorizon,
  _parseRange: parseRange,
  _parseEngine: parseEngine,
  _parseDays: parseDays,
  _nearestActual: nearestActual,
  _ALLOWED_HORIZONS: ALLOWED_HORIZONS,
};
