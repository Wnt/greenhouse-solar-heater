'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const forecastPredictions = require('../server/lib/forecast/forecast-predictions.js');

function makeLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makePool(scriptedQuery) {
  return {
    query: function (sql, params, cb) {
      try { scriptedQuery(sql, params, cb); }
      catch (e) { cb(e); }
    },
  };
}

const HOUR0 = '2026-05-05T08:00:00.000Z';
const HOUR1 = '2026-05-05T09:00:00.000Z';
const HOUR2 = '2026-05-05T10:00:00.000Z';

// Convenience: take the first row from buildRows. Most legacy assertions
// pin behavior at horizon_h=1 (the +1 h projection), so the array's
// first element is what they used to look at.
function firstRow(rows) { return Array.isArray(rows) && rows.length > 0 ? rows[0] : null; }

// Minimal forecast response shaped like forecast-handler returns.
// Trajectory length: HOUR0 → HOUR1 → HOUR2 means two horizon rows.
function makeForecastResponse(opts) {
  opts = opts || {};
  return Object.assign({
    generatedAt: opts.generatedAt || '2026-05-05T07:30:00.000Z',
    weather: opts.weather || [
      { validAt: HOUR0, temperature: 6.5, radiationGlobal: 410, windSpeed: 2, precipitation: 0 },
      { validAt: HOUR1, temperature: 7.1, radiationGlobal: 480, windSpeed: 2, precipitation: 0 },
      { validAt: HOUR2, temperature: 7.8, radiationGlobal: 520, windSpeed: 2, precipitation: 0 },
    ],
    prices: opts.prices || [
      { validAt: HOUR0, priceCKwh: 11.5, source: 'sahkotin' },
      { validAt: HOUR1, priceCKwh: 12.0, source: 'sahkotin' },
      { validAt: HOUR2, priceCKwh: 12.4, source: 'sahkotin' },
    ],
    forecast: Object.assign({
      modeForecast: [
        { ts: HOUR0, mode: 'greenhouse_heating' },
        { ts: HOUR1, mode: 'idle' },
      ],
      tankTrajectory: [
        { ts: HOUR0, top: 16, bottom: 14, avg: 15 },
        { ts: HOUR1, top: 14.5, bottom: 13, avg: 13.75 },
        { ts: HOUR2, top: 13.6, bottom: 12.4, avg: 13 },
      ],
      greenhouseTrajectory: [
        { ts: HOUR0, temp: 12.4 },
        { ts: HOUR1, temp: 11.8 },
        { ts: HOUR2, temp: 11.4 },
      ],
      componentTrajectory: [
        { ts: HOUR0, solarGainKwh: 0.1, radDeliveredW: 250, heaterKwh: 0, tankLossW: 5, cloudFactor: 0.8 },
        { ts: HOUR1, solarGainKwh: 0,   radDeliveredW: 0,   heaterKwh: 0, tankLossW: 4, cloudFactor: 0.0 },
      ],
    }, opts.forecast || {}),
  }, opts.coefficients !== undefined ? { coefficients: opts.coefficients } : {});
}

describe('forecast-predictions._buildRows', () => {
  const svc = forecastPredictions.create({ pool: null, log: makeLog() });

  it('returns one row per horizon hour, indexed from 1', () => {
    const rows = svc._buildRows(makeForecastResponse());
    assert.equal(rows.length, 2);
    assert.equal(rows[0].horizonH, 1);
    assert.equal(rows[1].horizonH, 2);
  });

  it('horizon_h=1 carries the predicted state at the END of hour 0 (= HOUR1)', () => {
    // Pre-multi-horizon, this was the only row stored. Keep the same
    // assertions on the +1 h slice — that's the slice the System Logs
    // view still shows.
    const row = firstRow(svc._buildRows(makeForecastResponse()));
    assert.equal(row.forHour, HOUR1);
    assert.equal(row.mode, 'greenhouse_heating');
    assert.equal(row.hasSolarOverlay, false);
    assert.equal(row.duty, null);
    assert.equal(row.tankTopC, 14.5);
    assert.equal(row.tankBottomC, 13);
    assert.equal(row.tankAvgC, 13.75);
    assert.equal(row.greenhouseC, 11.8);
    assert.equal(row.outdoorC, 7.1);
    assert.equal(row.radiationWm2, 480);
    assert.equal(row.priceCKwh, 12.0);
  });

  it('per-hour components ride along on each horizon row', () => {
    const rows = svc._buildRows(makeForecastResponse());
    assert.equal(rows[0].predSolarGainKwh, 0.1);
    assert.equal(rows[0].predRadDeliveredW, 250);
    assert.equal(rows[0].predHeaterKwh, 0);
    assert.equal(rows[0].predTankLossW, 5);
    assert.equal(rows[0].predCloudFactor, 0.8);
  });

  it('flags solar overlay when the engine emits solar_charging alongside the pump mode', () => {
    const row = firstRow(svc._buildRows(makeForecastResponse({
      forecast: {
        modeForecast: [
          { ts: HOUR0, mode: 'greenhouse_heating' },
          { ts: HOUR0, mode: 'solar_charging' },
          { ts: HOUR1, mode: 'idle' },
        ],
      },
    })));
    assert.equal(row.mode, 'greenhouse_heating');
    assert.equal(row.hasSolarOverlay, true);
  });

  it('handles solar-only hours (no pump-mode entry)', () => {
    const row = firstRow(svc._buildRows(makeForecastResponse({
      forecast: {
        modeForecast: [{ ts: HOUR0, mode: 'solar_charging' }],
      },
    })));
    assert.equal(row.mode, 'solar_charging');
    assert.equal(row.hasSolarOverlay, false);
  });

  it('captures heater duty for emergency_heating', () => {
    const row = firstRow(svc._buildRows(makeForecastResponse({
      forecast: {
        modeForecast: [{ ts: HOUR0, mode: 'emergency_heating', duty: 0.55 }],
      },
    })));
    assert.equal(row.mode, 'emergency_heating');
    assert.equal(row.duty, 0.55);
  });

  it('returns null when the trajectory is too short to project anything', () => {
    assert.equal(svc._buildRows(makeForecastResponse({
      forecast: { tankTrajectory: [{ ts: HOUR0, top: 16, bottom: 14, avg: 15 }],
        greenhouseTrajectory: [{ ts: HOUR0, temp: 12 }] },
    })), null);
  });

  it('returns null on missing forecast', () => {
    assert.equal(svc._buildRows({}), null);
    assert.equal(svc._buildRows(null), null);
  });

  it('falls back to nulls when weather/price arrays are empty', () => {
    const row = firstRow(svc._buildRows(makeForecastResponse({ weather: [], prices: [] })));
    assert.equal(row.outdoorC, null);
    assert.equal(row.radiationWm2, null);
    assert.equal(row.priceCKwh, null);
  });

  it('stamps the algorithm_version provided to create()', () => {
    const pinned = forecastPredictions.create({
      pool: null, log: makeLog(), algorithmVersion: 'cafef00d',
    });
    const row = firstRow(pinned._buildRows(makeForecastResponse()));
    assert.equal(row.algorithmVersion, 'cafef00d');
  });

  it('captures the live tu (sparse threshold overrides) from the response', () => {
    const tu = { geT: 13, gxT: 14, ehE: 11 };
    const row = firstRow(svc._buildRows(makeForecastResponse()));
    assert.equal(row.tu, null);
    const withTu = firstRow(svc._buildRows(Object.assign(makeForecastResponse(), { tu })));
    assert.deepStrictEqual(withTu.tu, tu);
  });

  it('captures the fitted coefficients from the response', () => {
    const coeff = { ghTimeConstantH: 1.8, ghSolarAlphaCPerWm2: 0.027, tankLeakageWPerK: 3 };
    const row = firstRow(svc._buildRows(makeForecastResponse({ coefficients: coeff })));
    assert.deepStrictEqual(row.coefficients, coeff);
  });

  it('defaults engine to physics when the response does not set it', () => {
    // The physics handler predates the engine field on its response.
    const rows = svc._buildRows(makeForecastResponse());
    assert.equal(rows[0].engine, 'physics');
    assert.equal(rows[1].engine, 'physics');
  });

  it('tags every row with response.engine when present (ml capture)', () => {
    const rows = svc._buildRows(Object.assign(makeForecastResponse(), { engine: 'ml' }));
    assert.equal(rows[0].engine, 'ml');
    assert.equal(rows[1].engine, 'ml');
  });

  it('joins weather rows that are hour-aligned even when forecast ts has a sub-hour offset', () => {
    const offset = '2026-05-05T08:21:08.459Z';
    const offset1 = '2026-05-05T09:21:08.459Z';
    const row = firstRow(svc._buildRows(makeForecastResponse({
      forecast: {
        modeForecast: [{ ts: offset, mode: 'greenhouse_heating' }],
        tankTrajectory: [
          { ts: offset, top: 16, bottom: 14, avg: 15 },
          { ts: offset1, top: 15, bottom: 13, avg: 14 },
        ],
        greenhouseTrajectory: [
          { ts: offset, temp: 12.4 },
          { ts: offset1, temp: 11.8 },
        ],
        componentTrajectory: [
          { ts: offset, solarGainKwh: 0, radDeliveredW: 0, heaterKwh: 0, tankLossW: 0, cloudFactor: 0 },
        ],
      },
    })));
    // Within the 90-min window, the hour-aligned weather rows resolve.
    assert.ok(row.outdoorC !== null);
    assert.ok(row.priceCKwh !== null);
  });
});

describe('forecast-predictions._buildRows — ML multi-resolution capture', () => {
  const svc = forecastPredictions.create({ pool: null, log: makeLog() });
  const { computeMlForecast } = require('../server/lib/forecast/ml/ml-forecast.js');
  const { FEATURE_NAMES } = require('../server/lib/forecast/ml/features.js');

  // Stub-forest patterns from tests/ml-forecast.test.js: leaf-only trees
  // add a fixed residual; a multi-value greenhouse stub gives per-tree
  // spread so the probabilistic emergency entry fires deterministically.
  function stubForest(values) {
    return { trees: values.map((v) => ({ leaf: true, value: v })), nFeatures: FEATURE_NAMES.length };
  }
  function stubModel(tankValues, ghValues) {
    return { tank: stubForest(tankValues), greenhouse: stubForest(ghValues), featureRanges: [] };
  }
  function flatWeather48h(tempC, radiation) {
    const out = [];
    for (let h = 0; h < 48; h++) {
      out.push({ temperature: tempC, radiationGlobal: radiation, windSpeed: 3, precipitation: 0 });
    }
    return out;
  }
  function makePrices48h() {
    const out = [];
    for (let h = 0; h < 48; h++) out.push({ priceCKwh: 12 });
    return out;
  }

  // A GENUINE ML engine response, wrapped the way ml-forecast-handler
  // wraps it for capture. gh pinned at 10 degC with a 3 degC-spread
  // greenhouse forest -> probabilistic emergency entry from step 0, so
  // the first hour's schedule is known.
  function genuineMlResponse() {
    const fc = computeMlForecast({
      now: new Date('2026-05-05T08:00:00.000Z'),
      tankTop: 10, tankBottom: 10, greenhouseTemp: 10,
      currentMode: 'idle',
      weather48h: flatWeather48h(10, 0),
      prices48h: makePrices48h(),
      model: stubModel([0], [-3, 3]),
    });
    return {
      generatedAt: fc.generatedAt,
      engine: 'ml',
      algorithmVersion: 'ml',
      tu: {},
      weather: [],
      prices: [],
      forecast: fc,
    };
  }

  it('resamples the multi-resolution trajectory so horizon_h=h is truly +h hours', () => {
    const response = genuineMlResponse();
    // Preconditions: this really is the multi-resolution rollout shape
    // (48 five-min steps + 44 hourly + trailing point; 92 mode entries).
    assert.equal(response.forecast.tankTrajectory.length, 93);
    assert.equal(response.forecast.greenhouseTrajectory.length, 93);
    assert.equal(response.forecast.modeForecast.length, 92);

    const rows = svc._buildRows(response);
    assert.equal(rows.length, 48, 'one row per horizon HOUR, not per rollout step');
    const t0 = Date.parse(response.generatedAt);
    for (let i = 0; i < rows.length; i++) {
      assert.equal(rows[i].horizonH, i + 1);
      assert.equal(Date.parse(rows[i].forHour), t0 + (i + 1) * 3600000,
        'row ' + (i + 1) + ' for_hour must be generatedAt + ' + (i + 1) + ' h');
      assert.equal(rows[i].engine, 'ml');
    }
    // Row 1's mode reflects the first hour's aggregated fine-step
    // schedule: emergency entry at step 0 wins the hour.
    assert.equal(rows[0].mode, 'emergency_heating');
    assert.equal(typeof rows[0].duty, 'number');
    // ML responses carry no componentTrajectory — components stay null.
    assert.equal(rows[0].predSolarGainKwh, null);
    assert.equal(rows[0].predRadDeliveredW, null);
    assert.equal(rows[0].predHeaterKwh, null);
    assert.equal(rows[0].predTankLossW, null);
    assert.equal(rows[0].predCloudFactor, null);
  });

  it('persists 48 rows for a genuine ML response via captureFromForecast', (t, done) => {
    let captured = null;
    const pool = makePool((sql, params, cb) => { captured = { sql, params }; cb(null, { rowCount: 48 }); });
    const withPool = forecastPredictions.create({ pool, log: makeLog() });
    withPool.captureFromForecast(genuineMlResponse(), function (err, rows) {
      assert.ifError(err);
      assert.equal(rows.length, 48);
      assert.equal(captured.params.length, 48 * 24, '48 rows x 24 columns');
      assert.equal(captured.params[0], 'ml');
      done();
    });
  });

  it('collapses fine-step hours by max occupancy: order-independent, winner-only duty (PR #283 review)', () => {
    const t0 = Date.parse(HOUR0);
    const fiveMin = 5 * 60 * 1000;
    const iso = (ms) => new Date(ms).toISOString();
    // Three hours of 5-min steps (37 points) — hour points at 12/24/36.
    const tank = [];
    const gh = [];
    for (let k = 0; k <= 36; k++) {
      tank.push({ ts: iso(t0 + k * fiveMin), top: 16, bottom: 14, avg: 15 });
      gh.push({ ts: iso(t0 + k * fiveMin), temp: 12 });
    }
    const modeForecast = [];
    // Hour 0 — the reviewer's demotion case: solar x11 with a TRAILING
    // idle step. The old last-writer collapse labelled this hour idle;
    // occupancy must label it solar_charging regardless of order.
    for (let k = 0; k < 11; k++) modeForecast.push({ ts: iso(t0 + k * fiveMin), mode: 'solar_charging' });
    modeForecast.push({ ts: iso(t0 + 11 * fiveMin), mode: 'idle' });
    // Hour 1 — emergency holds most of the hour (7 steps, duties up to
    // 0.7) over greenhouse_heating (5): emergency wins with ITS max duty.
    for (let k = 12; k < 19; k++) {
      modeForecast.push({ ts: iso(t0 + k * fiveMin), mode: 'emergency_heating', duty: k === 15 ? 0.7 : 0.4 });
    }
    for (let k = 19; k < 24; k++) modeForecast.push({ ts: iso(t0 + k * fiveMin), mode: 'greenhouse_heating' });
    // Hour 2 — greenhouse-heating hour with a 2-step emergency blip
    // (duty 0.9): the blip must NOT relabel the hour (old behaviour) and
    // the winning greenhouse label must NOT inherit the blip's duty.
    for (let k = 24; k < 34; k++) modeForecast.push({ ts: iso(t0 + k * fiveMin), mode: 'greenhouse_heating' });
    for (let k = 34; k < 36; k++) modeForecast.push({ ts: iso(t0 + k * fiveMin), mode: 'emergency_heating', duty: 0.9 });
    const rows = svc._buildRows({
      generatedAt: HOUR0,
      engine: 'ml',
      weather: [], prices: [],
      forecast: { tankTrajectory: tank, greenhouseTrajectory: gh, modeForecast },
    });
    assert.equal(rows.length, 3);
    assert.equal(rows[0].mode, 'solar_charging', 'a solar-dominated hour must not be demoted by a trailing idle step');
    assert.equal(rows[0].hasSolarOverlay, false, 'solar-labelled hour keeps the overlay flag false');
    assert.equal(rows[0].duty, null);
    assert.equal(rows[1].mode, 'emergency_heating', 'max-occupancy mode wins the hour');
    assert.equal(rows[1].duty, 0.7, 'the winning mode keeps its own max duty');
    assert.equal(rows[2].mode, 'greenhouse_heating', 'a 10-minute emergency blip must not relabel the hour');
    assert.equal(rows[2].duty, null, 'the winner must not inherit the losing blip\'s duty');
  });

  it('breaks occupancy ties by severity, preserving physics same-ts heat+solar semantics', () => {
    const t0 = Date.parse(HOUR0);
    const iso = (ms) => new Date(ms).toISOString();
    const hourly = (n, fields) => {
      const out = [];
      for (let k = 0; k <= n; k++) out.push(Object.assign({ ts: iso(t0 + k * 3600 * 1000) }, fields));
      return out;
    };
    // Physics shape: one heat entry + one solar duplicate at the same ts
    // (a 1-1 occupancy tie) — severity tie-break keeps the heat label
    // with the solar overlay flagged, exactly the old per-ts semantics.
    const rows = svc._buildRows({
      generatedAt: HOUR0,
      weather: [], prices: [],
      forecast: {
        tankTrajectory: hourly(1, { top: 16, bottom: 14, avg: 15 }),
        greenhouseTrajectory: hourly(1, { temp: 12 }),
        modeForecast: [
          { ts: iso(t0), mode: 'greenhouse_heating' },
          { ts: iso(t0), mode: 'solar_charging' },
        ],
      },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].mode, 'greenhouse_heating');
    assert.equal(rows[0].hasSolarOverlay, true);
  });
});

describe('forecast-predictions.captureFromForecast', () => {
  it('persists 48-row batch using INSERT ... ON CONFLICT (engine, generated_at, horizon_h) DO UPDATE', (t, done) => {
    let captured = null;
    const pool = makePool((sql, params, cb) => {
      captured = { sql, params };
      cb(null, { rowCount: 2 });
    });
    const svc = forecastPredictions.create({
      pool, log: makeLog(), algorithmVersion: 'cafef00d',
    });
    const tu = { geT: 13, gxT: 14 };
    const coefficients = { tankLeakageWPerK: 3.1, ghTimeConstantH: 1.8 };
    const response = Object.assign(makeForecastResponse(), { tu, coefficients });
    svc.captureFromForecast(response, function (err, rows) {
      assert.ifError(err);
      assert.ok(captured.sql.includes('INSERT INTO forecast_predictions'));
      assert.ok(captured.sql.includes('(engine, generated_at, horizon_h'),
        'engine must lead the column list');
      assert.ok(captured.sql.includes('ON CONFLICT (engine, generated_at, horizon_h) DO UPDATE'));
      // engine is part of the conflict target — it must not be updated.
      assert.ok(!captured.sql.includes('engine = EXCLUDED.engine'));
      assert.ok(captured.sql.includes('algorithm_version'));
      assert.ok(captured.sql.includes('coefficients'));
      // Two horizon rows means a multi-row VALUES list with two parens.
      const valuesMatches = captured.sql.match(/\),\s*\(/g);
      assert.ok(valuesMatches && valuesMatches.length === 1,
        'expected one VALUES separator for 2 rows');
      assert.equal(rows.length, 2);
      assert.equal(rows[0].horizonH, 1);
      assert.equal(rows[0].forHour, HOUR1);
      // engine rides first in each row's params (physics default here).
      assert.equal(captured.params[0], 'physics');
      // tu and coefficients are JSON.stringified for the JSONB columns.
      // Find them in the params: 24 fields per row, tu at position 22, coefficients at 23.
      assert.deepStrictEqual(JSON.parse(captured.params[22]), tu);
      assert.deepStrictEqual(JSON.parse(captured.params[23]), coefficients);
      done();
    });
  });

  it('persists engine=ml rows when capturing the ML response', (t, done) => {
    let captured = null;
    const pool = makePool((sql, params, cb) => { captured = { sql, params }; cb(null, { rowCount: 2 }); });
    const svc = forecastPredictions.create({ pool, log: makeLog() });
    const response = Object.assign(makeForecastResponse(), { engine: 'ml' });
    svc.captureFromForecast(response, function (err, rows) {
      assert.ifError(err);
      assert.equal(rows[0].engine, 'ml');
      assert.equal(captured.params[0], 'ml');
      // second row's engine param sits one full column-set later
      assert.equal(captured.params[24], 'ml');
      done();
    });
  });

  it('skips persistence (no DB call) when trajectory is too short', (t, done) => {
    let queryCalls = 0;
    const pool = makePool((_sql, _params, cb) => { queryCalls++; cb(null, {}); });
    const svc = forecastPredictions.create({ pool, log: makeLog() });
    svc.captureFromForecast(makeForecastResponse({
      forecast: {
        tankTrajectory: [{ ts: HOUR0, top: 1, bottom: 1, avg: 1 }],
        greenhouseTrajectory: [{ ts: HOUR0, temp: 1 }],
      },
    }), function (err, row) {
      assert.ifError(err);
      assert.equal(row, null);
      assert.equal(queryCalls, 0);
      done();
    });
  });

  it('propagates DB errors via the callback', (t, done) => {
    const pool = makePool((_sql, _params, cb) => cb(new Error('db down')));
    const svc = forecastPredictions.create({ pool, log: makeLog() });
    svc.captureFromForecast(makeForecastResponse(), function (err) {
      assert.ok(err);
      assert.match(err.message, /db down/);
      done();
    });
  });
});

describe('forecast-predictions.listRecent', () => {
  it('filters to horizon_h=1 and returns rows in DESC order with camelCase keys', (t, done) => {
    const pool = makePool((sql, params, cb) => {
      // The new schema has 48 rows per generated_at; the System Logs
      // view still shows one row per hour, so the query must filter.
      // Dual-engine capture also stores ml rows — the operator-visible
      // history stays pinned to the physics engine for now.
      assert.match(sql, /WHERE horizon_h = 1 AND engine = 'physics'/);
      assert.match(sql, /ORDER BY for_hour DESC/);
      assert.equal(params[0], 48);
      cb(null, {
        rows: [
          {
            for_hour: new Date('2026-05-05T10:00:00.000Z'),
            generated_at: new Date('2026-05-05T09:30:00.000Z'),
            mode: 'greenhouse_heating',
            has_solar_overlay: false,
            duty: null,
            tank_avg_c: 13.75,
            greenhouse_c: 11.8,
            outdoor_c: 6.5,
            radiation_w_m2: 410,
            price_c_kwh: 11.5,
            algorithm_version: 'cafef00d',
            tu: { geT: 13 },
            coefficients: { ghTimeConstantH: 1.8 },
          },
        ],
      });
    });
    const svc = forecastPredictions.create({ pool, log: makeLog() });
    svc.listRecent(48, function (err, rows) {
      assert.ifError(err);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].forHour, '2026-05-05T10:00:00.000Z');
      assert.equal(rows[0].mode, 'greenhouse_heating');
      assert.equal(rows[0].tankAvgC, 13.75);
      assert.deepStrictEqual(rows[0].coefficients, { ghTimeConstantH: 1.8 });
      done();
    });
  });

  it('clamps limit to a sane window (1–500)', (t, done) => {
    let seen = null;
    const pool = makePool((_sql, params, cb) => { seen = params; cb(null, { rows: [] }); });
    const svc = forecastPredictions.create({ pool, log: makeLog() });
    svc.listRecent(99999, function () {
      assert.equal(seen[0], 500);
      svc.listRecent(0, function () {
        assert.equal(seen[0], 48);
        svc.listRecent(-5, function () {
          assert.equal(seen[0], 1);
          done();
        });
      });
    });
  });
});

describe('forecast-bootstrap.runCaptureCycle (dual-engine HH:30 capture)', () => {
  const { runCaptureCycle } = require('../server/lib/forecast/forecast-bootstrap.js');

  function makeWarnLog() {
    const warns = [];
    return { warns, info: () => {}, warn: (msg) => warns.push(msg), error: () => {} };
  }

  it('captures physics first, then ml, then signals done', (t, done) => {
    const order = [];
    const capturedResponses = [];
    runCaptureCycle({
      physicsCompute: (cb) => { order.push('physics-compute'); cb(null, { engine: undefined, id: 'phys' }); },
      mlCompute: (cb) => { order.push('ml-compute'); cb(null, { engine: 'ml', id: 'ml' }); },
      capture: (response, cb) => { capturedResponses.push(response); cb(null); },
      log: makeWarnLog(),
    }, function () {
      assert.deepStrictEqual(order, ['physics-compute', 'ml-compute']);
      assert.equal(capturedResponses.length, 2);
      assert.equal(capturedResponses[0].id, 'phys');
      assert.equal(capturedResponses[1].engine, 'ml');
      done();
    });
  });

  it('tolerates an ML compute failure: physics capture unaffected, loop continues', (t, done) => {
    const log = makeWarnLog();
    const capturedResponses = [];
    runCaptureCycle({
      physicsCompute: (cb) => cb(null, { id: 'phys' }),
      mlCompute: (cb) => cb(new Error('ML model not available')),
      capture: (response, cb) => { capturedResponses.push(response); cb(null); },
      log,
    }, function () {
      assert.equal(capturedResponses.length, 1);
      assert.equal(capturedResponses[0].id, 'phys');
      assert.ok(log.warns.some((m) => /ml/i.test(m)), 'expected a warn for the ML failure');
      done();
    });
  });

  it('tolerates an ML compute that throws synchronously', (t, done) => {
    const log = makeWarnLog();
    runCaptureCycle({
      physicsCompute: (cb) => cb(null, { id: 'phys' }),
      mlCompute: () => { throw new Error('boom'); },
      capture: (_response, cb) => cb(null),
      log,
    }, function () {
      assert.ok(log.warns.length > 0);
      done();
    });
  });

  it('tolerates a physics compute that throws synchronously (symmetric guard, PR #283 review)', (t, done) => {
    // Runs inside the HH:30 setTimeout callback: an unguarded sync throw
    // would crash the pod AND skip done(), disarming the loop forever.
    const log = makeWarnLog();
    const capturedResponses = [];
    runCaptureCycle({
      physicsCompute: () => { throw new Error('sync boom'); },
      mlCompute: (cb) => cb(null, { engine: 'ml' }),
      capture: (response, cb) => { capturedResponses.push(response); cb(null); },
      log,
    }, function () {
      assert.equal(capturedResponses.length, 1, 'the ML capture must still run');
      assert.equal(capturedResponses[0].engine, 'ml');
      assert.ok(log.warns.some((m) => /physics/i.test(m)), 'expected a warn for the physics throw');
      done();
    });
  });

  it('still attempts the ML capture when the physics compute fails', (t, done) => {
    const log = makeWarnLog();
    const capturedResponses = [];
    runCaptureCycle({
      physicsCompute: (cb) => cb(new Error('physics down')),
      mlCompute: (cb) => cb(null, { engine: 'ml' }),
      capture: (response, cb) => { capturedResponses.push(response); cb(null); },
      log,
    }, function () {
      assert.equal(capturedResponses.length, 1);
      assert.equal(capturedResponses[0].engine, 'ml');
      assert.ok(log.warns.length > 0);
      done();
    });
  });
});

describe('forecast-predictions._msUntilNextHH30', () => {
  const svc = forecastPredictions.create({ pool: null, log: makeLog() });

  it('aims at HH:30 in the same hour when called before :30', () => {
    const at = new Date('2026-05-05T08:15:00.000Z').getTime();
    const ms = svc._msUntilNextHH30(at);
    assert.equal(ms, 15 * 60 * 1000);
  });

  it('aims at the next hour when called after :30', () => {
    const at = new Date('2026-05-05T08:45:00.000Z').getTime();
    const ms = svc._msUntilNextHH30(at);
    assert.equal(ms, 45 * 60 * 1000);
  });

  it('aims at the next hour when called exactly at :30', () => {
    const at = new Date('2026-05-05T08:30:00.000Z').getTime();
    const ms = svc._msUntilNextHH30(at);
    assert.equal(ms, 60 * 60 * 1000);
  });
});
