'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const diagnostics = require('../server/lib/forecast/forecast-diagnostics.js');

function makeLog() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

// pool stub — accepts a list of [matcherFn, rows] pairs and returns the
// first matching rowset for each query.
function makePool(scripts) {
  return {
    query: function (sql, params, cb) {
      for (let i = 0; i < scripts.length; i++) {
        const [match, rows] = scripts[i];
        if (match(sql, params)) {
          process.nextTick(function () { cb(null, { rows }); });
          return;
        }
      }
      process.nextTick(function () { cb(new Error('No script matched: ' + sql.slice(0, 60))); });
    },
  };
}

describe('forecast-diagnostics: parseHorizon', () => {
  it('defaults to 24 when missing', () => {
    assert.equal(diagnostics._parseHorizon(null), 24);
    assert.equal(diagnostics._parseHorizon(''), 24);
  });
  it('accepts 1, 6, 12, 24, 48', () => {
    assert.equal(diagnostics._parseHorizon('1'), 1);
    assert.equal(diagnostics._parseHorizon('6'), 6);
    assert.equal(diagnostics._parseHorizon('48'), 48);
  });
  it('rejects unsupported values', () => {
    assert.equal(diagnostics._parseHorizon('3'), null);
    assert.equal(diagnostics._parseHorizon('72'), null);
    assert.equal(diagnostics._parseHorizon('abc'), null);
  });
});

describe('forecast-diagnostics: parseRange', () => {
  it('defaults to last 7 days', () => {
    const r = diagnostics._parseRange(null, null);
    assert.ok(r);
    const span = r.until.getTime() - r.since.getTime();
    assert.equal(span, 7 * 24 * 3600 * 1000);
  });
  it('rejects since >= until', () => {
    const r = diagnostics._parseRange('2026-05-08T00:00:00Z', '2026-05-07T00:00:00Z');
    assert.equal(r, null);
  });
  it('clamps span to 31 days', () => {
    const r = diagnostics._parseRange('2025-01-01T00:00:00Z', '2026-05-08T00:00:00Z');
    const span = r.until.getTime() - r.since.getTime();
    assert.equal(span, 31 * 24 * 3600 * 1000);
  });
  it('rejects invalid ISO strings', () => {
    assert.equal(diagnostics._parseRange('not-a-date', null), null);
    assert.equal(diagnostics._parseRange(null, 'also-bad'), null);
  });
});

describe('forecast-diagnostics: nearestActual', () => {
  const target = '2026-05-05T09:00:00.000Z';
  const ts = (iso) => new Date(iso).getTime();
  const bySensor = {
    greenhouse: [
      { ts: ts('2026-05-05T08:50:00.000Z'), value: 11.5 },
      { ts: ts('2026-05-05T09:05:00.000Z'), value: 12.0 },
      { ts: ts('2026-05-05T09:30:00.000Z'), value: 12.5 },
    ],
    tank_top: [{ ts: ts('2026-05-05T09:00:30.000Z'), value: 40 }],
    tank_bottom: [{ ts: ts('2026-05-05T09:00:30.000Z'), value: 30 }],
    outdoor: [{ ts: ts('2026-05-05T09:00:00.000Z'), value: 7.2 }],
  };

  it('picks the closest bucket within the window', () => {
    const a = diagnostics._nearestActual(bySensor, target, 30);
    assert.equal(a.greenhouse_c, 12.0); // 5 min after, closer than 10 min before
    assert.equal(a.outdoor_c, 7.2);
  });

  it('averages tank_top + tank_bottom into tank_avg_c', () => {
    const a = diagnostics._nearestActual(bySensor, target, 30);
    assert.equal(a.tank_top_c, 40);
    assert.equal(a.tank_bottom_c, 30);
    assert.equal(a.tank_avg_c, 35);
  });

  it('returns nulls when no buckets fall within the window', () => {
    const sparse = { greenhouse: [{ ts: ts('2026-05-05T07:00:00.000Z'), value: 11 }] };
    const a = diagnostics._nearestActual(sparse, target, 30);
    assert.equal(a.greenhouse_c, null);
    assert.equal(a.tank_avg_c, null);
  });

  it('falls back to whichever tank channel is present', () => {
    const partial = { tank_top: [{ ts: ts('2026-05-05T09:00:00.000Z'), value: 50 }] };
    const a = diagnostics._nearestActual(partial, target, 30);
    assert.equal(a.tank_top_c, 50);
    assert.equal(a.tank_bottom_c, null);
    assert.equal(a.tank_avg_c, 50);
  });
});

describe('forecast-diagnostics: series mode (integration via stubbed pool)', () => {
  it('joins predictions to actuals at the given horizon', (t, done) => {
    const forHour = new Date('2026-05-05T09:00:00.000Z');
    const pool = makePool([
      // prediction query — matched by horizon_h param
      [
        function (sql) { return /FROM forecast_predictions/.test(sql) && /horizon_h = \$1/.test(sql); },
        [{
          generated_at: new Date('2026-05-05T07:30:00.000Z'),
          horizon_h: 1,
          for_hour: forHour,
          mode: 'greenhouse_heating',
          has_solar_overlay: false,
          duty: 0.25,
          tank_top_c: 38, tank_bottom_c: 32, tank_avg_c: 35,
          greenhouse_c: 12.4,
          pred_solar_gain_kwh: 0.1, pred_rad_delivered_w: 250,
          pred_heater_kwh: 0, pred_tank_loss_w: 4, pred_cloud_factor: 0.8,
          outdoor_c: 6.5, radiation_w_m2: 410, wind_speed_m_s: 2, precipitation_mm: 0,
          price_c_kwh: 12, algorithm_version: 'abcd1234',
          tu: null, coefficients: null,
        }],
      ],
      // actuals query
      [
        function (sql) { return /FROM sensor_readings_30s/.test(sql); },
        [
          { sensor_id: 'greenhouse',  bucket: forHour, avg_value: 12.0 },
          { sensor_id: 'tank_top',    bucket: forHour, avg_value: 39 },
          { sensor_id: 'tank_bottom', bucket: forHour, avg_value: 31 },
          { sensor_id: 'outdoor',     bucket: forHour, avg_value: 6.2 },
        ],
      ],
    ]);

    const svc = diagnostics.create({ pool, log: makeLog() });
    svc._runSeriesMode(1, new Date('2026-05-05T08:00:00Z'), new Date('2026-05-05T10:00:00Z'),
      function (err, body) {
        assert.equal(err, null);
        assert.equal(body.kind, 'series');
        assert.equal(body.horizon, 1);
        assert.equal(body.rows.length, 1);
        const row = body.rows[0];
        assert.equal(row.for_hour, forHour.toISOString());
        assert.equal(row.predicted.greenhouse_c, 12.4);
        assert.equal(row.predicted.tank_avg_c, 35);
        assert.equal(row.predicted.mode, 'greenhouse_heating');
        assert.equal(row.actual.greenhouse_c, 12.0);
        assert.equal(row.actual.tank_avg_c, 35); // (39 + 31) / 2
        assert.equal(row.actual.outdoor_c, 6.2);
        done();
      });
  });

  it('returns an empty rows array when no predictions match', (t, done) => {
    const pool = makePool([[function () { return true; }, []]]);
    const svc = diagnostics.create({ pool, log: makeLog() });
    svc._runSeriesMode(24, new Date('2026-05-05T08:00:00Z'), new Date('2026-05-05T10:00:00Z'),
      function (err, body) {
        assert.equal(err, null);
        assert.deepEqual(body.rows, []);
        done();
      });
  });
});

describe('forecast-diagnostics: generation mode', () => {
  it('returns all horizons + tu + coefficients for one generation', (t, done) => {
    const generatedAt = new Date('2026-05-05T07:30:00.000Z');
    const tu = { ehE: 5, ehX: 3 };
    const coefficients = { tauGhH: 2, alphaSolar: 0.025 };
    const pool = makePool([
      [
        function (sql) { return /FROM forecast_predictions/.test(sql) && /generated_at = \$1/.test(sql); },
        [
          {
            generated_at: generatedAt, horizon_h: 1,
            for_hour: new Date('2026-05-05T08:00:00.000Z'),
            mode: 'idle', has_solar_overlay: false, duty: null,
            tank_top_c: 38, tank_bottom_c: 32, tank_avg_c: 35, greenhouse_c: 12,
            pred_solar_gain_kwh: 0, pred_rad_delivered_w: 0, pred_heater_kwh: 0,
            pred_tank_loss_w: 4, pred_cloud_factor: 0,
            outdoor_c: 6, radiation_w_m2: 0, wind_speed_m_s: 2, precipitation_mm: 0,
            price_c_kwh: 11, algorithm_version: 'abc',
            tu, coefficients,
          },
          {
            generated_at: generatedAt, horizon_h: 2,
            for_hour: new Date('2026-05-05T09:00:00.000Z'),
            mode: 'greenhouse_heating', has_solar_overlay: false, duty: 0.5,
            tank_top_c: 36, tank_bottom_c: 30, tank_avg_c: 33, greenhouse_c: 12.5,
            pred_solar_gain_kwh: 0.1, pred_rad_delivered_w: 250, pred_heater_kwh: 0,
            pred_tank_loss_w: 4, pred_cloud_factor: 0.7,
            outdoor_c: 6.5, radiation_w_m2: 410, wind_speed_m_s: 2, precipitation_mm: 0,
            price_c_kwh: 12, algorithm_version: 'abc',
            tu, coefficients,
          },
        ],
      ],
      [
        function (sql) { return /FROM sensor_readings_30s/.test(sql); },
        [
          { sensor_id: 'greenhouse', bucket: new Date('2026-05-05T08:00:00.000Z'), avg_value: 11.9 },
        ],
      ],
    ]);
    const svc = diagnostics.create({ pool, log: makeLog() });
    svc._runGenerationMode(generatedAt.toISOString(), function (err, body) {
      assert.equal(err, null);
      assert.equal(body.kind, 'generation');
      assert.equal(body.horizons.length, 2);
      assert.deepEqual(body.tu, tu);
      assert.deepEqual(body.coefficients, coefficients);
      assert.equal(body.horizons[0].horizon_h, 1);
      assert.equal(body.horizons[0].predicted.pred_solar_gain_kwh, 0);
      assert.equal(body.horizons[1].predicted.pred_rad_delivered_w, 250);
      assert.equal(body.horizons[0].actual.greenhouse_c, 11.9);
      done();
    });
  });

  it('parses JSON-string tu/coefficients (pg-mem fallback)', (t, done) => {
    const generatedAt = new Date('2026-05-05T07:30:00.000Z');
    const pool = makePool([
      [
        function (sql) { return /FROM forecast_predictions/.test(sql); },
        [{
          generated_at: generatedAt, horizon_h: 1,
          for_hour: new Date('2026-05-05T08:00:00.000Z'),
          mode: 'idle', has_solar_overlay: false, duty: null,
          tank_top_c: 38, tank_bottom_c: 32, tank_avg_c: 35, greenhouse_c: 12,
          pred_solar_gain_kwh: 0, pred_rad_delivered_w: 0, pred_heater_kwh: 0,
          pred_tank_loss_w: 4, pred_cloud_factor: 0,
          outdoor_c: 6, radiation_w_m2: 0, wind_speed_m_s: 2, precipitation_mm: 0,
          price_c_kwh: 11, algorithm_version: 'abc',
          tu: '{"ehE":5}', coefficients: '{"tauGhH":2}',
        }],
      ],
      [function (sql) { return /FROM sensor_readings_30s/.test(sql); }, []],
    ]);
    const svc = diagnostics.create({ pool, log: makeLog() });
    svc._runGenerationMode(generatedAt.toISOString(), function (err, body) {
      assert.equal(err, null);
      assert.deepEqual(body.tu, { ehE: 5 });
      assert.deepEqual(body.coefficients, { tauGhH: 2 });
      done();
    });
  });
});
