'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../server/lib/forecast/forecast-dataset.js');

// ── Mock pool ──
// Routes each query by the table name in its SQL and returns canned
// rows (or an error) per table. Records every query for inspection.
// The dataset module's nested callbacks resolve synchronously here, so
// getDataset() completes before the call returns.
function makePool(opts) {
  opts = opts || {};
  const queries = [];
  return {
    queries,
    query: function (sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      queries.push({ sql, params });
      let table = 'other';
      if (sql.indexOf('weather_forecasts') !== -1) table = 'weather';
      else if (sql.indexOf('spot_prices') !== -1) table = 'prices';
      else if (sql.indexOf('forecast_predictions') !== -1) table = 'predictions';
      if (opts.errors && opts.errors[table]) {
        cb(new Error(table + ' boom'));
        return;
      }
      cb(null, { rows: (opts.rows && opts.rows[table]) || [] });
    },
  };
}

const silentLog = { error: function () {}, warn: function () {} };

function predRow(genIso, h, extra) {
  return Object.assign({
    generated_at: new Date(genIso),
    horizon_h: h,
    for_hour: new Date(genIso),
    mode: 'idle',
    has_solar_overlay: false,
    duty: null,
    tank_top_c: 50, tank_bottom_c: 40, tank_avg_c: 45,
    greenhouse_c: 18,
    pred_solar_gain_kwh: 0, pred_rad_delivered_w: 0, pred_heater_kwh: 0,
    pred_tank_loss_w: 0, pred_cloud_factor: 1,
    outdoor_c: 5, radiation_w_m2: 0, wind_speed_m_s: 2, precipitation_mm: 0,
    price_c_kwh: 10, algorithm_version: 'abc',
    tu: null, coefficients: null,
  }, extra || {});
}

function runSync(ds, opts) {
  let captured;
  ds.getDataset(opts, function (err, result) { captured = { err, result }; });
  assert.ok(captured, 'getDataset called back synchronously');
  assert.equal(captured.err, null);
  return captured.result;
}

describe('forecast-dataset', () => {
  it('queries weather, prices and predictions with a bounded window', () => {
    const pool = makePool();
    runSync(create({ pool, log: silentLog }), { range: '24h' });

    const tables = pool.queries.map(function (q) {
      if (q.sql.indexOf('weather_forecasts') !== -1) return 'weather';
      if (q.sql.indexOf('spot_prices') !== -1) return 'prices';
      if (q.sql.indexOf('forecast_predictions') !== -1) return 'predictions';
      return '?';
    });
    assert.deepEqual(tables.sort(), ['predictions', 'prices', 'weather']);
    pool.queries.forEach(function (q) {
      assert.match(q.sql, /INTERVAL '24 hours'/);
    });
  });

  it("range 'all' omits the time-window clause", () => {
    const pool = makePool();
    runSync(create({ pool, log: silentLog }), { range: 'all' });
    pool.queries.forEach(function (q) {
      assert.doesNotMatch(q.sql, /INTERVAL/);
    });
  });

  it('maps prediction rows to camelCase and de-dups generations', () => {
    const rows = [
      predRow('2026-05-16T12:00:00.000Z', 1, { tu: { geT: 18 }, coefficients: { tankLeakageWPerK: 5 } }),
      predRow('2026-05-16T12:00:00.000Z', 2, { tu: { geT: 18 }, coefficients: { tankLeakageWPerK: 5 } }),
      predRow('2026-05-16T13:00:00.000Z', 1, { tu: { geT: 19 }, coefficients: { tankLeakageWPerK: 6 } }),
    ];
    const result = runSync(
      create({ pool: makePool({ rows: { predictions: rows } }), log: silentLog }),
      { range: '24h' });

    assert.equal(result.predictions.length, 3);
    assert.equal(result.predictions[0].horizonH, 1);
    assert.equal(result.predictions[0].generatedAt, '2026-05-16T12:00:00.000Z');
    assert.equal(result.predictions[0].tankAvgC, 45);
    // The slim prediction rows carry no tu / coefficients blob.
    assert.equal(result.predictions[0].tu, undefined);
    assert.equal(result.predictions[0].coefficients, undefined);

    // One generations entry per distinct generated_at.
    assert.equal(result.generations.length, 2);
    assert.deepEqual(result.generations[0], {
      generatedAt: '2026-05-16T12:00:00.000Z',
      algorithmVersion: 'abc',
      tu: { geT: 18 },
      coefficients: { tankLeakageWPerK: 5 },
    });
  });

  it('horizon filter adds a horizon_h predicate with a bound parameter', () => {
    const pool = makePool();
    runSync(create({ pool, log: silentLog }), { range: '24h', horizon: 6 });
    const predQ = pool.queries.find(function (q) {
      return q.sql.indexOf('forecast_predictions') !== -1;
    });
    assert.match(predQ.sql, /horizon_h = \$1/);
    assert.deepEqual(predQ.params, [6]);
  });

  it('pins the predictions query to the physics engine', () => {
    const pool = makePool();
    runSync(create({ pool, log: silentLog }), { range: '24h', horizon: 6 });
    const predQ = pool.queries.find(function (q) {
      return q.sql.indexOf('forecast_predictions') !== -1;
    });
    assert.match(predQ.sql, /engine = 'physics'/);
    // weather / prices are engine-less tables and stay unfiltered
    pool.queries.forEach(function (q) {
      if (q.sql.indexOf('forecast_predictions') === -1) {
        assert.doesNotMatch(q.sql, /engine/);
      }
    });
  });

  it('yields physics-only rows from a mixed-engine table', () => {
    // ML rows share forecast_predictions since dual-engine capture —
    // unfiltered they would double row counts against the row cap and
    // inject a second engine's rows into offline tooling.
    const rows = [
      predRow('2026-05-16T12:00:00.000Z', 1, { engine: 'physics' }),
      predRow('2026-05-16T12:30:00.000Z', 1, { engine: 'ml', mode: 'solar_charging' }),
      predRow('2026-05-16T12:30:00.000Z', 2, { engine: 'ml' }),
    ];
    // Stub pool that honours an engine predicate like the real table.
    const pool = {
      query: function (sql, params, cb) {
        if (typeof params === 'function') { cb = params; }
        if (sql.indexOf('forecast_predictions') === -1) { cb(null, { rows: [] }); return; }
        const out = /engine = 'physics'/.test(sql)
          ? rows.filter(function (r) { return r.engine === 'physics'; })
          : rows;
        cb(null, { rows: out });
      },
    };
    const result = runSync(create({ pool, log: silentLog }), { range: '24h' });
    assert.equal(result.predictions.length, 1);
    assert.equal(result.predictions[0].generatedAt, '2026-05-16T12:00:00.000Z');
    assert.equal(result.predictions[0].mode, 'idle');
    assert.equal(result.generations.length, 1);
  });

  it('a failing section degrades to [] without sinking the rest', () => {
    const pool = makePool({
      errors: { weather: true },
      rows: {
        prices: [{
          valid_at: new Date('2026-05-16T12:00:00Z'),
          fetched_at: new Date(),
          source: 'sahkotin',
          price_c_kwh: 9,
        }],
      },
    });
    const result = runSync(create({ pool, log: silentLog }), { range: '24h' });
    assert.deepEqual(result.weather, []);
    assert.equal(result.prices.length, 1);
    assert.equal(result.prices[0].priceCKwh, 9);
    assert.equal(result.prices[0].source, 'sahkotin');
  });

  it('pool=null yields empty sections but still builds sources', () => {
    const ds = create({
      pool: null,
      log: silentLog,
      getRefresherStatus: function () {
        return { enabled: false, refreshIntervalMs: 1, weather: {}, prices: {} };
      },
    });
    const result = runSync(ds, { range: '24h' });
    assert.deepEqual(result.weather, []);
    assert.deepEqual(result.predictions, []);
    assert.equal(result.sources.length, 2);
  });

  describe('data source status', () => {
    function dsWith(status) {
      return create({
        pool: makePool(),
        log: silentLog,
        getRefresherStatus: function () { return status; },
      });
    }

    it('lists fmi-weather and spot-price sources', () => {
      const result = runSync(dsWith({
        enabled: true, refreshIntervalMs: 1800000,
        weather: { lastAttemptAt: null }, prices: { lastAttemptAt: null },
      }), { range: '24h' });
      assert.deepEqual(
        result.sources.map(function (s) { return s.id; }).sort(),
        ['fmi-weather', 'spot-price']);
    });

    it('reports disabled when the refresher is not enabled', () => {
      const result = runSync(dsWith({
        enabled: false, refreshIntervalMs: 1800000, weather: {}, prices: {},
      }), { range: '24h' });
      assert.ok(result.sources.every(function (s) { return s.status === 'disabled'; }));
    });

    it('reports pending when enabled but no attempt has happened', () => {
      const result = runSync(dsWith({
        enabled: true, refreshIntervalMs: 1800000,
        weather: { lastAttemptAt: null }, prices: { lastAttemptAt: null },
      }), { range: '24h' });
      assert.ok(result.sources.every(function (s) { return s.status === 'pending'; }));
    });

    it('reports ok after a recent success', () => {
      const recent = new Date().toISOString();
      const result = runSync(dsWith({
        enabled: true, refreshIntervalMs: 1800000,
        weather: { lastAttemptAt: recent, lastSuccessAt: recent, lastSuccessRows: 48 },
        prices: { lastAttemptAt: recent, lastSuccessAt: recent, lastSuccessRows: 30 },
      }), { range: '24h' });
      const w = result.sources.find(function (s) { return s.id === 'fmi-weather'; });
      assert.equal(w.status, 'ok');
      assert.equal(w.rowsLastFetch, 48);
    });

    it('reports error when the last attempt failed after the last success', () => {
      const old = new Date(Date.now() - 3600e3).toISOString();
      const now = new Date().toISOString();
      const result = runSync(dsWith({
        enabled: true, refreshIntervalMs: 1800000,
        weather: { lastAttemptAt: now, lastSuccessAt: old, lastErrorAt: now, lastError: 'FMI 503' },
        prices: { lastAttemptAt: now, lastSuccessAt: now },
      }), { range: '24h' });
      const w = result.sources.find(function (s) { return s.id === 'fmi-weather'; });
      assert.equal(w.status, 'error');
      assert.equal(w.lastError, 'FMI 503');
    });

    it('reports stale when the last success is older than two refresh cycles', () => {
      const stale = new Date(Date.now() - 3 * 1800000).toISOString();
      const result = runSync(dsWith({
        enabled: true, refreshIntervalMs: 1800000,
        weather: { lastAttemptAt: stale, lastSuccessAt: stale },
        prices: { lastAttemptAt: stale, lastSuccessAt: stale },
      }), { range: '24h' });
      assert.ok(result.sources.every(function (s) { return s.status === 'stale'; }));
    });
  });
});
