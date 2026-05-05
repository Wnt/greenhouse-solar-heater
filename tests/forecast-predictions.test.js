'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const forecastPredictions = require('../server/lib/forecast/forecast-predictions.js');

function makeLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makePool(scriptedQuery) {
  // scriptedQuery: function(sql, params, cb) — caller-supplied behavior.
  return {
    query: function (sql, params, cb) {
      try { scriptedQuery(sql, params, cb); }
      catch (e) { cb(e); }
    },
  };
}

const HOUR0 = '2026-05-05T08:00:00.000Z';
const HOUR1 = '2026-05-05T09:00:00.000Z';

// Minimal forecast response shaped like forecast-handler returns.
function makeForecastResponse(opts) {
  opts = opts || {};
  return {
    generatedAt: opts.generatedAt || '2026-05-05T07:30:00.000Z',
    weather: opts.weather || [
      { validAt: HOUR0, temperature: 6.5, radiationGlobal: 410, windSpeed: 2, precipitation: 0 },
      { validAt: HOUR1, temperature: 7.1, radiationGlobal: 480, windSpeed: 2, precipitation: 0 },
    ],
    prices: opts.prices || [
      { validAt: HOUR0, priceCKwh: 11.5, source: 'sahkotin' },
      { validAt: HOUR1, priceCKwh: 12.0, source: 'sahkotin' },
    ],
    forecast: Object.assign({
      modeForecast: [{ ts: HOUR0, mode: 'greenhouse_heating' }],
      tankTrajectory: [
        { ts: HOUR0, top: 16, bottom: 14, avg: 15 },
        { ts: HOUR1, top: 14.5, bottom: 13, avg: 13.75 },
      ],
      greenhouseTrajectory: [
        { ts: HOUR0, temp: 12.4 },
        { ts: HOUR1, temp: 11.8 },
      ],
    }, opts.forecast || {}),
  };
}

describe('forecast-predictions._buildRow', () => {
  const svc = forecastPredictions.create({ pool: null, log: makeLog() });

  it('sets forHour to the END of the predicted hour (= time the actual reading will be taken)', () => {
    // PRE-FIX: forHour was modeForecast[0].ts (= generation time). That
    // made the export show the same timestamp in both "Predicted at" and
    // "For hour" columns and forced the operator to mentally add 1 h to
    // know which actual reading to compare against. forHour should be
    // trajectory[1].ts — the wall clock when the predicted state will
    // actually exist, so a row reads "for hour HOUR1, predicted X" and
    // the operator can directly look up the sensor value at HOUR1.
    const row = svc._buildRow(makeForecastResponse());
    assert.equal(row.forHour, HOUR1);
    assert.equal(row.mode, 'greenhouse_heating');
    assert.equal(row.hasSolarOverlay, false);
    assert.equal(row.duty, null);
    // Trajectory[1] is the predicted state at the end of hour 0 — what an
    // operator wants to compare against the actual reading at HOUR1.
    assert.equal(row.tankAvgC, 13.75);
    assert.equal(row.greenhouseC, 11.8);
    assert.equal(row.outdoorC, 6.5);
    assert.equal(row.radiationWm2, 410);
    assert.equal(row.priceCKwh, 11.5);
  });

  it('flags solar overlay when the engine emits solar_charging alongside the pump mode', () => {
    const row = svc._buildRow(makeForecastResponse({
      forecast: {
        modeForecast: [
          { ts: HOUR0, mode: 'greenhouse_heating' },
          { ts: HOUR0, mode: 'solar_charging' },
          { ts: HOUR1, mode: 'idle' },
        ],
      },
    }));
    assert.equal(row.mode, 'greenhouse_heating');
    assert.equal(row.hasSolarOverlay, true);
  });

  it('handles solar-only hours (no pump-mode entry)', () => {
    const row = svc._buildRow(makeForecastResponse({
      forecast: {
        modeForecast: [{ ts: HOUR0, mode: 'solar_charging' }],
      },
    }));
    assert.equal(row.mode, 'solar_charging');
    assert.equal(row.hasSolarOverlay, false);
  });

  it('captures heater duty for emergency_heating', () => {
    const row = svc._buildRow(makeForecastResponse({
      forecast: {
        modeForecast: [{ ts: HOUR0, mode: 'emergency_heating', duty: 0.55 }],
      },
    }));
    assert.equal(row.mode, 'emergency_heating');
    assert.equal(row.duty, 0.55);
  });

  it('returns null when modeForecast is empty', () => {
    assert.equal(svc._buildRow(makeForecastResponse({ forecast: { modeForecast: [] } })), null);
  });

  it('returns null on missing forecast', () => {
    assert.equal(svc._buildRow({}), null);
    assert.equal(svc._buildRow(null), null);
  });

  it('falls back to nulls when weather/price arrays are empty', () => {
    const row = svc._buildRow(makeForecastResponse({ weather: [], prices: [] }));
    assert.equal(row.outdoorC, null);
    assert.equal(row.radiationWm2, null);
    assert.equal(row.priceCKwh, null);
  });

  it('stamps the algorithm_version provided to create()', () => {
    const pinned = forecastPredictions.create({
      pool: null, log: makeLog(), algorithmVersion: 'cafef00d',
    });
    const row = pinned._buildRow(makeForecastResponse());
    assert.equal(row.algorithmVersion, 'cafef00d');
  });

  it('captures the live tu (sparse threshold overrides) from the response', () => {
    const tu = { geT: 13, gxT: 14, ehE: 11 };
    const row = svc._buildRow(makeForecastResponse({ generatedAt: '2026-05-05T07:30:00.000Z' }));
    // Default fixture has no tu — should be null.
    assert.equal(row.tu, null);
    // With tu attached on the response, the row carries it through.
    const withTu = svc._buildRow(Object.assign(makeForecastResponse(), { tu }));
    assert.deepStrictEqual(withTu.tu, tu);
  });

  it('joins weather rows that are hour-aligned even when modeForecast.ts has a sub-hour offset', () => {
    // Real-world: modeForecast.ts = now + h*3600 (carries minute offset),
    // weather.validAt = top of the hour. The capture must still join.
    const row = svc._buildRow(makeForecastResponse({
      forecast: {
        modeForecast: [{ ts: '2026-05-05T08:21:08.459Z', mode: 'greenhouse_heating' }],
        tankTrajectory: [
          { ts: '2026-05-05T08:21:08.459Z', top: 16, bottom: 14, avg: 15 },
          { ts: '2026-05-05T09:21:08.459Z', top: 15, bottom: 13, avg: 14 },
        ],
        greenhouseTrajectory: [
          { ts: '2026-05-05T08:21:08.459Z', temp: 12.4 },
          { ts: '2026-05-05T09:21:08.459Z', temp: 11.8 },
        ],
      },
    }));
    assert.equal(row.outdoorC, 6.5);
    assert.equal(row.priceCKwh, 11.5);
  });
});

describe('forecast-predictions.captureFromForecast', () => {
  it('inserts a row using INSERT … ON CONFLICT DO UPDATE, including algorithm_version and tu', (t, done) => {
    let captured = null;
    const pool = makePool((sql, params, cb) => {
      captured = { sql, params };
      cb(null, { rowCount: 1 });
    });
    const svc = forecastPredictions.create({
      pool, log: makeLog(), algorithmVersion: 'cafef00d',
    });
    const tu = { geT: 13, gxT: 14 };
    const response = Object.assign(makeForecastResponse(), { tu });
    svc.captureFromForecast(response, function (err, row) {
      assert.ifError(err);
      assert.ok(captured.sql.includes('INSERT INTO forecast_predictions'));
      assert.ok(captured.sql.includes('ON CONFLICT (for_hour) DO UPDATE'));
      assert.ok(captured.sql.includes('algorithm_version'));
      assert.ok(captured.sql.includes('tu'));
      // for_hour points at the END of the predicted hour (the wall-
      // clock when the predicted state will actually exist), so a
      // capture at HOUR0 carries for_hour=HOUR1.
      assert.equal(captured.params[0], HOUR1);
      assert.equal(captured.params[2], 'greenhouse_heating'); // mode
      assert.equal(captured.params[10], 'cafef00d');          // algorithm_version
      // tu is JSON.stringified for the JSONB column.
      assert.deepStrictEqual(JSON.parse(captured.params[11]), tu);
      assert.equal(row.forHour, HOUR1);
      done();
    });
  });

  it('skips persistence (no DB call) when modeForecast is empty', (t, done) => {
    let queryCalls = 0;
    const pool = makePool((_sql, _params, cb) => { queryCalls++; cb(null, {}); });
    const svc = forecastPredictions.create({ pool, log: makeLog() });
    svc.captureFromForecast(makeForecastResponse({ forecast: { modeForecast: [] } }), function (err, row) {
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
  it('returns rows in DESC order with camelCase keys', (t, done) => {
    const pool = makePool((sql, params, cb) => {
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
        assert.equal(seen[0], 48); // 0 → falsy → default limit
        svc.listRecent(-5, function () {
          assert.equal(seen[0], 1);
          done();
        });
      });
    });
  });
});

describe('forecast-predictions._msUntilNextHH30', () => {
  const svc = forecastPredictions.create({ pool: null, log: makeLog() });

  it('aims at HH:30 in the same hour when called before :30', () => {
    const at = new Date('2026-05-05T08:15:00.000Z').getTime();
    const ms = svc._msUntilNextHH30(at);
    assert.equal(ms, 15 * 60 * 1000); // 15 min ahead
  });

  it('aims at the next hour when called after :30', () => {
    const at = new Date('2026-05-05T08:45:00.000Z').getTime();
    const ms = svc._msUntilNextHH30(at);
    // 09:30 - 08:45 = 45 min
    assert.equal(ms, 45 * 60 * 1000);
  });

  it('aims at the next hour when called exactly at :30', () => {
    const at = new Date('2026-05-05T08:30:00.000Z').getTime();
    const ms = svc._msUntilNextHH30(at);
    assert.equal(ms, 60 * 60 * 1000);
  });
});
