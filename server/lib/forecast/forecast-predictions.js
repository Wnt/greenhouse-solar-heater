'use strict';

/**
 * Forecast-prediction capture + recall.
 *
 * Persists the engine's "next hour" prediction once per hour (HH:30) so
 * an operator can later compare what the algorithm projected against
 * what actually happened (sensor_readings_30s holds the ground truth).
 *
 * create({ pool, log, isPreviewMode, scheduleNow }) → {
 *   start, stop,
 *   captureFromForecast(response, callback)  // pure-ish; testable
 *   listRecent(limit, callback)
 * }
 *
 * The scheduler is wired by start() — it computes the next HH:30 wall-
 * clock, fires once, then re-schedules. captureFromForecast is exposed
 * separately so server-side tests can drive it without a clock dance.
 *
 * Capture rule: take the FIRST modeForecast timestamp in the response.
 * That entry covers the hour starting "now"; trajectory[1] is the
 * predicted state at the END of that hour (= start of the next index)
 * which is what we want to compare against the actual reading an hour
 * later. When solar_charging overlays a pump mode the engine emits two
 * entries with the same ts — we collapse them like the export does.
 */

const SECONDS_PER_HOUR = 3600;
const RECENT_DEFAULT_LIMIT = 48;
const { ALGORITHM_VERSION } = require('./version');

function create(opts) {
  const pool          = opts.pool;
  const log           = opts.log;
  const isPreviewMode = opts.isPreviewMode || false;
  // Optional injection so tests can drive the scheduler with a mock clock
  // and a synchronous capture trigger.
  const scheduleNow   = typeof opts.scheduleNow === 'function' ? opts.scheduleNow : null;
  // Override the version (tests pin a known value to assert persistence
  // shape). Production reads the live module-load digest.
  const algorithmVersion = opts.algorithmVersion || ALGORITHM_VERSION;

  let _timeoutHandle = null;

  // Pure: extract the prediction record from a forecast-handler response.
  // Returns null when the response shape is missing the bits needed for a
  // useful row (no first hour, no trajectory anchor) so the scheduler can
  // log a "skipped" instead of writing partial data.
  function buildRow(response) {
    if (!response || !response.forecast) return null;
    const fc = response.forecast;
    const modes = Array.isArray(fc.modeForecast) ? fc.modeForecast : [];
    if (modes.length === 0) return null;
    const firstTs = modes[0].ts;
    let primary = null;
    let hasSolar = false;
    let duty = null;
    for (let i = 0; i < modes.length && modes[i].ts === firstTs; i++) {
      const m = modes[i];
      if (m.mode === 'solar_charging') {
        if (primary === null) primary = 'solar_charging';
        else hasSolar = true;
      } else {
        if (primary === 'solar_charging') hasSolar = true;
        primary = m.mode;
        if (typeof m.duty === 'number') duty = m.duty;
      }
    }
    // Trajectory[1] is the state at the END of the first forecast hour
    // (= start of hour 1). That's the comparable anchor a real operator
    // wants when checking the prediction against future actuals.
    const tank = Array.isArray(fc.tankTrajectory) && fc.tankTrajectory.length > 1
      ? fc.tankTrajectory[1] : null;
    const gh   = Array.isArray(fc.greenhouseTrajectory) && fc.greenhouseTrajectory.length > 1
      ? fc.greenhouseTrajectory[1] : null;
    // for_hour names the wall clock when the predicted state will
    // actually exist — i.e. trajectory[1].ts (one hour after generation).
    // Pre-fix this carried modeForecast[0].ts (= generation time), which
    // forced the operator to mentally add an hour to know which actual
    // sensor reading to compare against. Falls back to firstTs if the
    // trajectory is shorter than expected (engine bug / incomplete data),
    // so we never write a NULL into the PK column.
    const forHourTs = (tank && tank.ts) ? tank.ts : firstTs;
    // Weather rows are hour-aligned but firstTs carries a sub-hour offset
    // (now + h*3600s). Pick the closest row within ±90 min — same window
    // the export uses, same justification.
    const wx = nearestRow(response.weather, firstTs, 'validAt', 90 * 60 * 1000);
    const px = nearestRow(response.prices,  firstTs, 'validAt', 90 * 60 * 1000);
    // Live tuning overrides at capture time. Sourced from the response
    // (handler attaches it) so the row reflects the same `tu` snapshot
    // the engine just used. Falls back to null when the handler hasn't
    // been wired to attach it (older tests, etc.).
    const tu = response.tu && typeof response.tu === 'object' ? response.tu : null;
    return {
      forHour:        forHourTs,
      generatedAt:    response.generatedAt || new Date().toISOString(),
      mode:           primary || 'idle',
      hasSolarOverlay: hasSolar,
      duty,
      tankAvgC:       tank ? round2(tank.avg) : null,
      greenhouseC:    gh   ? round2(gh.temp) : null,
      outdoorC:       wx && typeof wx.temperature     === 'number' ? wx.temperature     : null,
      radiationWm2:   wx && typeof wx.radiationGlobal === 'number' ? wx.radiationGlobal : null,
      priceCKwh:      px && typeof px.priceCKwh       === 'number' ? px.priceCKwh       : null,
      algorithmVersion,
      tu,
    };
  }

  function persistRow(row, callback) {
    const sql =
      'INSERT INTO forecast_predictions ' +
      '(for_hour, generated_at, mode, has_solar_overlay, duty, ' +
      ' tank_avg_c, greenhouse_c, outdoor_c, radiation_w_m2, price_c_kwh, ' +
      ' algorithm_version, tu) ' +
      'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ' +
      'ON CONFLICT (for_hour) DO UPDATE SET ' +
      '  generated_at = EXCLUDED.generated_at, ' +
      '  mode = EXCLUDED.mode, ' +
      '  has_solar_overlay = EXCLUDED.has_solar_overlay, ' +
      '  duty = EXCLUDED.duty, ' +
      '  tank_avg_c = EXCLUDED.tank_avg_c, ' +
      '  greenhouse_c = EXCLUDED.greenhouse_c, ' +
      '  outdoor_c = EXCLUDED.outdoor_c, ' +
      '  radiation_w_m2 = EXCLUDED.radiation_w_m2, ' +
      '  price_c_kwh = EXCLUDED.price_c_kwh, ' +
      '  algorithm_version = EXCLUDED.algorithm_version, ' +
      '  tu = EXCLUDED.tu';
    pool.query(sql, [
      row.forHour, row.generatedAt, row.mode, row.hasSolarOverlay, row.duty,
      row.tankAvgC, row.greenhouseC, row.outdoorC, row.radiationWm2, row.priceCKwh,
      row.algorithmVersion, row.tu ? JSON.stringify(row.tu) : null,
    ], callback);
  }

  function captureFromForecast(response, callback) {
    const row = buildRow(response);
    if (!row) {
      if (callback) callback(null, null);
      return;
    }
    persistRow(row, function (err) {
      if (err) {
        log.error('forecast-predictions: insert failed', { error: err.message });
      } else {
        log.info('forecast-predictions: captured', { for_hour: row.forHour, mode: row.mode });
      }
      if (callback) callback(err, err ? null : row);
    });
  }

  function listRecent(limit, callback) {
    const n = Math.max(1, Math.min(parseInt(limit, 10) || RECENT_DEFAULT_LIMIT, 500));
    const sql =
      'SELECT for_hour, generated_at, mode, has_solar_overlay, duty, ' +
      '  tank_avg_c, greenhouse_c, outdoor_c, radiation_w_m2, price_c_kwh, ' +
      '  algorithm_version, tu ' +
      'FROM forecast_predictions ORDER BY for_hour DESC LIMIT $1';
    pool.query(sql, [n], function (err, result) {
      if (err) return callback(err);
      const rows = (result.rows || []).map(function (r) {
        return {
          forHour:         r.for_hour instanceof Date ? r.for_hour.toISOString() : r.for_hour,
          generatedAt:     r.generated_at instanceof Date ? r.generated_at.toISOString() : r.generated_at,
          mode:            r.mode,
          hasSolarOverlay: !!r.has_solar_overlay,
          duty:            r.duty,
          tankAvgC:        r.tank_avg_c,
          greenhouseC:     r.greenhouse_c,
          outdoorC:        r.outdoor_c,
          radiationWm2:    r.radiation_w_m2,
          priceCKwh:       r.price_c_kwh,
          algorithmVersion: r.algorithm_version,
          // node-postgres returns JSONB as a parsed object directly; pg-mem
          // sometimes returns the raw string, hence the defensive parse.
          tu: typeof r.tu === 'string' ? safeParseJson(r.tu) : (r.tu || null),
        };
      });
      callback(null, rows);
    });
  }

  // ── Scheduling ──
  // Run at HH:30 of every hour, regardless of when the server started.
  // setTimeout is preferred over setInterval so each invocation re-aims
  // at the next wall-clock boundary (interval drifts under load).
  function msUntilNextHH30(now) {
    const d = new Date(now);
    d.setMinutes(30, 0, 0);
    if (d.getTime() <= now) d.setHours(d.getHours() + 1);
    return d.getTime() - now;
  }

  function scheduleNext(captureCb) {
    const delay = msUntilNextHH30(Date.now());
    log.info('forecast-predictions: next capture in ' + Math.round(delay / 1000) + ' s');
    _timeoutHandle = setTimeout(function () {
      captureCb(function () { scheduleNext(captureCb); });
    }, delay);
  }

  function start(captureCb) {
    if (isPreviewMode) {
      log.info('preview mode: forecast-predictions disabled');
      return;
    }
    if (!captureCb) {
      log.warn('forecast-predictions: start() requires a captureCb; scheduler not armed');
      return;
    }
    if (scheduleNow) {
      // Test injection: fire immediately so tests don't wait for HH:30.
      scheduleNow(captureCb);
      return;
    }
    scheduleNext(captureCb);
  }

  function stop() {
    if (_timeoutHandle !== null) {
      clearTimeout(_timeoutHandle);
      _timeoutHandle = null;
    }
  }

  return {
    start, stop,
    captureFromForecast,
    listRecent,
    // exported for tests
    _buildRow: buildRow,
    _msUntilNextHH30: msUntilNextHH30,
  };
}

function nearestRow(rows, targetIso, key, maxDeltaMs) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const target = new Date(targetIso).getTime();
  let best = null;
  let bestDelta = Infinity;
  for (let i = 0; i < rows.length; i++) {
    const ts = rows[i] && rows[i][key];
    if (!ts) continue;
    const t = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
    const delta = Math.abs(t - target);
    if (delta < bestDelta) { bestDelta = delta; best = rows[i]; }
  }
  return bestDelta <= maxDeltaMs ? best : null;
}

function round2(v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; }

function safeParseJson(s) {
  try { return JSON.parse(s); } catch (_e) { return null; }
}

module.exports = { create, _SECONDS_PER_HOUR: SECONDS_PER_HOUR };
