'use strict';

/**
 * Forecast-prediction capture + recall.
 *
 * Persists the engine's full 48 h trajectory once per hour (HH:30) so an
 * operator can later compare what the algorithm projected against what
 * actually happened (sensor_readings_30s holds the ground truth) at any
 * horizon — not just +1 h.
 *
 * Each capture writes one row per `(engine, generated_at, horizon_h)`
 * tuple — both the physics and the ML engine are captured each cycle
 * (design/docs/ml-mode-forecast-findings.md, recommendation #2) —
 * with the predicted state at the END of horizon hour h plus the
 * per-hour components (predicted solar gain, radiator W, heater kWh,
 * tank loss, cloud factor) consumed during that hour. Inputs the
 * engine actually used (FMI weather, spot price) and the active fitted
 * coefficients ride alongside so analyses don't have to cross-reference
 * weather_forecasts to know what the engine saw.
 *
 * create({ pool, log, isPreviewMode, scheduleNow }) → {
 *   start, stop,
 *   captureFromForecast(response, callback)  // pure-ish; testable
 *   listRecent(limit, callback)              // returns horizon_h=1 only
 * }
 */

const SECONDS_PER_HOUR = 3600;
const MS_PER_HOUR = SECONDS_PER_HOUR * 1000;
const RECENT_DEFAULT_LIMIT = 48;
const { ALGORITHM_VERSION } = require('./version');

function create(opts) {
  const pool          = opts.pool;
  const log           = opts.log;
  const isPreviewMode = opts.isPreviewMode || false;
  const scheduleNow   = typeof opts.scheduleNow === 'function' ? opts.scheduleNow : null;
  const algorithmVersion = opts.algorithmVersion || ALGORITHM_VERSION;

  let _timeoutHandle = null;

  // Build one row per horizon hour from a forecast response. Returns
  // null when the response shape is unusable (no trajectory). Each row
  // describes the predicted state at the END of horizon hour h (= start
  // of hour h+1) and the components consumed during that hour.
  function buildRows(response) {
    if (!response || !response.forecast) return null;
    const fc = response.forecast;
    const tank = Array.isArray(fc.tankTrajectory) ? fc.tankTrajectory : [];
    const gh   = Array.isArray(fc.greenhouseTrajectory) ? fc.greenhouseTrajectory : [];
    const cmp  = Array.isArray(fc.componentTrajectory) ? fc.componentTrajectory : [];
    const modeEntries = Array.isArray(fc.modeForecast) ? fc.modeForecast : [];
    if (tank.length < 2 || gh.length < 2) return null;

    // The ML engine's trajectory is multi-resolution (5-min steps over
    // the first hours, then hourly); the physics engine's is hourly.
    // Resample onto the hour grid: horizon hour h reads the point at
    // exactly t0 + h hours (t0 = first trajectory point), which for the
    // physics engine's arrays is the identity selection. Compare parsed
    // ms, not ISO strings, so formatting drift can't break the match.
    const t0 = tsToMs(tank[0].ts);
    if (t0 === null) return null;
    const tankByMs = indexByTsMs(tank);
    const ghByMs   = indexByTsMs(gh);
    const cmpByMs  = indexByTsMs(cmp);

    // Collapse modeForecast into hour buckets: bucket h-1 holds every
    // entry with ts in [t0+(h-1) h, t0+h h) and describes captured hour
    // h. The captured label is the MAX-OCCUPANCY mode of the bucket —
    // an order-dependent last-writer-wins collapse let a single
    // trailing idle step relabel a 55-minute solar hour as idle,
    // systematically depressing the ML engine's solar rate in exactly
    // the diagnostics this capture feeds (PR #283 review). Ties break
    // by severity (emergency > heating > solar > idle), which also
    // preserves the physics engine's semantics where a heat-mode entry
    // and its solar-overlay duplicate share one ts. duty is the max
    // among entries of the WINNING mode only (a greenhouse-heating
    // hour must not inherit an emergency blip's heater duty).
    const MODE_RANK = { emergency_heating: 4, greenhouse_heating: 3, active_drain: 2, solar_charging: 1, idle: 0 };
    const hourBuckets = {};
    for (let i = 0; i < modeEntries.length; i++) {
      const m = modeEntries[i];
      const mMs = m ? tsToMs(m.ts) : null;
      if (mMs === null || mMs < t0) continue;
      const bucket = Math.floor((mMs - t0) / MS_PER_HOUR);
      let b = hourBuckets[bucket];
      if (!b) { b = { counts: {}, dutyMax: {}, solarSeen: false }; hourBuckets[bucket] = b; }
      b.counts[m.mode] = (b.counts[m.mode] || 0) + 1;
      if (m.mode === 'solar_charging') b.solarSeen = true;
      if (typeof m.duty === 'number') {
        const prev = b.dutyMax[m.mode];
        if (prev === undefined || m.duty > prev) b.dutyMax[m.mode] = m.duty;
      }
    }
    const modeByHour = {};
    for (const bucket of Object.keys(hourBuckets)) {
      const b = hourBuckets[bucket];
      let winner = 'idle';
      let winCount = -1;
      for (const mode of Object.keys(b.counts)) {
        const n = b.counts[mode];
        if (n > winCount || (n === winCount && (MODE_RANK[mode] || 0) > (MODE_RANK[winner] || 0))) {
          winner = mode;
          winCount = n;
        }
      }
      modeByHour[bucket] = {
        mode: winner,
        // hasSolar flags solar coexisting with a non-solar label; a
        // solar-labelled hour keeps it false (unchanged semantics).
        hasSolar: b.solarSeen && winner !== 'solar_charging',
        duty: b.dutyMax[winner] !== undefined ? b.dutyMax[winner] : null,
      };
    }

    const generatedAt = response.generatedAt || new Date().toISOString();
    // The ML handler stamps engine:'ml' on its response; the physics
    // handler predates the field, so absent means physics.
    const engine = typeof response.engine === 'string' && response.engine !== ''
      ? response.engine : 'physics';
    const algo = response.algorithmVersion || algorithmVersion;
    const tu   = response.tu && typeof response.tu === 'object' ? response.tu : null;
    const coeff = response.coefficients && typeof response.coefficients === 'object'
      ? response.coefficients : null;

    const rows = [];
    for (let h = 1; ; h++) {
      const hourMs = t0 + h * MS_PER_HOUR;
      const tankAt = tankByMs[hourMs];
      const ghAt   = ghByMs[hourMs];
      if (!tankAt || !ghAt) break;
      const me = modeByHour[h - 1] || { mode: 'idle', hasSolar: false, duty: null };
      // Physics component entries are keyed by their start-of-hour ts
      // (ML responses carry no componentTrajectory → all-null columns).
      const c  = cmpByMs[hourMs - MS_PER_HOUR] || {};
      const wx = nearestRow(response.weather, ghAt.ts, 'validAt', 90 * 60 * 1000);
      const px = nearestRow(response.prices,  ghAt.ts, 'validAt', 90 * 60 * 1000);
      rows.push({
        engine,
        generatedAt,
        horizonH:        h,
        forHour:         ghAt.ts,
        mode:            me.mode,
        hasSolarOverlay: me.hasSolar,
        duty:            me.duty,
        tankTopC:        round2(tankAt.top),
        tankBottomC:     round2(tankAt.bottom),
        tankAvgC:        round2(tankAt.avg),
        greenhouseC:     round2(ghAt.temp),
        predSolarGainKwh:    typeof c.solarGainKwh  === 'number' ? c.solarGainKwh  : null,
        predRadDeliveredW:   typeof c.radDeliveredW === 'number' ? c.radDeliveredW : null,
        predHeaterKwh:       typeof c.heaterKwh     === 'number' ? c.heaterKwh     : null,
        predTankLossW:       typeof c.tankLossW     === 'number' ? c.tankLossW     : null,
        predCloudFactor:     typeof c.cloudFactor   === 'number' ? c.cloudFactor   : null,
        outdoorC:        wx && typeof wx.temperature     === 'number' ? wx.temperature     : null,
        radiationWm2:    wx && typeof wx.radiationGlobal === 'number' ? wx.radiationGlobal : null,
        windSpeedMs:     wx && typeof wx.windSpeed       === 'number' ? wx.windSpeed       : null,
        precipitationMm: wx && typeof wx.precipitation   === 'number' ? wx.precipitation   : null,
        priceCKwh:       px && typeof px.priceCKwh       === 'number' ? px.priceCKwh       : null,
        algorithmVersion: algo,
        tu, coefficients: coeff,
      });
    }
    return rows.length > 0 ? rows : null;
  }

  // Bulk INSERT … VALUES (…)·48 ON CONFLICT DO UPDATE. One round-trip
  // per HH:30 capture; cheaper than 48 separate INSERTs. Column order
  // mirrors db-schema.js's CREATE TABLE for grep-ability.
  function persistRows(rows, callback) {
    if (!rows || rows.length === 0) { callback(null); return; }
    const cols = [
      'engine', 'generated_at', 'horizon_h', 'for_hour', 'mode', 'has_solar_overlay', 'duty',
      'tank_top_c', 'tank_bottom_c', 'tank_avg_c', 'greenhouse_c',
      'pred_solar_gain_kwh', 'pred_rad_delivered_w', 'pred_heater_kwh',
      'pred_tank_loss_w', 'pred_cloud_factor',
      'outdoor_c', 'radiation_w_m2', 'wind_speed_m_s', 'precipitation_mm',
      'price_c_kwh', 'algorithm_version', 'tu', 'coefficients',
    ];
    const values = [];
    const placeholders = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const base = i * cols.length;
      const ph = []; for (let j = 0; j < cols.length; j++) ph.push('$' + (base + j + 1));
      placeholders.push('(' + ph.join(',') + ')');
      values.push(
        r.engine, r.generatedAt, r.horizonH, r.forHour, r.mode, r.hasSolarOverlay, r.duty,
        r.tankTopC, r.tankBottomC, r.tankAvgC, r.greenhouseC,
        r.predSolarGainKwh, r.predRadDeliveredW, r.predHeaterKwh,
        r.predTankLossW, r.predCloudFactor,
        r.outdoorC, r.radiationWm2, r.windSpeedMs, r.precipitationMm,
        r.priceCKwh, r.algorithmVersion,
        r.tu ? JSON.stringify(r.tu) : null,
        r.coefficients ? JSON.stringify(r.coefficients) : null
      );
    }
    const updateCols = cols.filter(function (c) {
      return c !== 'engine' && c !== 'generated_at' && c !== 'horizon_h';
    });
    const sql =
      'INSERT INTO forecast_predictions (' + cols.join(', ') + ') ' +
      'VALUES ' + placeholders.join(', ') + ' ' +
      'ON CONFLICT (engine, generated_at, horizon_h) DO UPDATE SET ' +
        updateCols.map(function (c) { return c + ' = EXCLUDED.' + c; }).join(', ');
    pool.query(sql, values, callback);
  }

  function captureFromForecast(response, callback) {
    const rows = buildRows(response);
    if (!rows) {
      if (callback) callback(null, null);
      return;
    }
    persistRows(rows, function (err) {
      if (err) {
        log.error('forecast-predictions: insert failed', { error: err.message });
      } else {
        log.info('forecast-predictions: captured', {
          generated_at: rows[0].generatedAt, count: rows.length,
        });
      }
      if (callback) callback(err, err ? null : rows);
    });
  }

  // Returns the most recent +1 h projections for the System Logs view.
  // The multi-horizon table is for offline analysis; the operator-
  // visible "Prediction History" section keeps showing one row per hour.
  // Pinned to engine='physics': the section predates dual-engine capture
  // and its content contract is the physics projection. Follow-up:
  // surfacing ML rows here is a UX decision (second section? engine
  // toggle?), not something to sneak in via a shared query.
  function listRecent(limit, callback) {
    const n = Math.max(1, Math.min(parseInt(limit, 10) || RECENT_DEFAULT_LIMIT, 500));
    const sql =
      'SELECT for_hour, generated_at, mode, has_solar_overlay, duty, ' +
      '  tank_avg_c, greenhouse_c, outdoor_c, radiation_w_m2, price_c_kwh, ' +
      '  algorithm_version, tu, coefficients ' +
      "FROM forecast_predictions WHERE horizon_h = 1 AND engine = 'physics' " +
      'ORDER BY for_hour DESC LIMIT $1';
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
          // node-postgres returns JSONB as a parsed object; pg-mem
          // sometimes returns the raw string, hence the defensive parse.
          tu:               typeof r.tu === 'string' ? safeParseJson(r.tu) : (r.tu || null),
          coefficients:     typeof r.coefficients === 'string' ? safeParseJson(r.coefficients) : (r.coefficients || null),
        };
      });
      callback(null, rows);
    });
  }

  // ── Scheduling (unchanged from pre-multi-horizon) ──
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
    _buildRows: buildRows,
    _msUntilNextHH30: msUntilNextHH30,
  };
}

function tsToMs(ts) {
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  return isNaN(ms) ? null : ms;
}

// Index trajectory points by their parsed-ms timestamp (last one wins
// on a duplicate ts — engines never emit duplicates in practice).
function indexByTsMs(points) {
  const byMs = {};
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const ms = p && p.ts != null ? tsToMs(p.ts) : null;
    if (ms !== null) byMs[ms] = p;
  }
  return byMs;
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
