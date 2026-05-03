'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../server/lib/forecast-refresher.js');

// ── Minimal pool stub ──

function makePool() {
  var queries = [];
  return {
    queries,
    query: function (sql, params, cb) {
      queries.push({ sql, params });
      if (cb) cb(null, { rows: [] });
    },
  };
}

// ── Minimal logger stub ──

function makeLog() {
  var msgs = [];
  var stub = function (level) {
    return function (msg, meta) { msgs.push({ level, msg, meta }); };
  };
  return {
    msgs,
    info:  stub('info'),
    warn:  stub('warn'),
    error: stub('error'),
  };
}

// ── Minimal FMI client stub ──

function makeWeatherRows() {
  return [
    { validAt: new Date('2026-05-04T00:00:00Z'), temperature: 7.2, radiationGlobal: 0, windSpeed: 1.5, precipitation: 0 },
    { validAt: new Date('2026-05-04T01:00:00Z'), temperature: 6.9, radiationGlobal: 0, windSpeed: 1.6, precipitation: 0 },
  ];
}

function makePriceRows() {
  return [
    { validAt: new Date('2026-05-04T00:00:00Z'), priceCKwh: 12.5, source: 'sahkotin' },
    { validAt: new Date('2026-05-04T01:00:00Z'), priceCKwh: 11.0, source: 'nordpool-predict' },
  ];
}

describe('forecast-refresher', () => {
  // ── 1. start() triggers immediate fetch and writes to both tables ──

  it('start() immediately fetches weather + prices and inserts rows', async () => {
    var pool = makePool();
    var log  = makeLog();
    var weatherFetched = 0;
    var pricesFetched  = 0;

    var fmiClient = {
      fetchForecast: function () {
        weatherFetched++;
        return Promise.resolve(makeWeatherRows());
      },
    };
    var spotClient = {
      fetchPrices: function () {
        pricesFetched++;
        return Promise.resolve(makePriceRows());
      },
    };

    var refresher = create({
      pool,
      log,
      config: { location: { lat: 60.41, lon: 22.37 }, refreshIntervalMs: 9999999 },
      isPreviewMode: false,
      fmiClient,
      spotPriceClient: spotClient,
    });

    refresher.start();
    await refresher.stop(); // waits for in-flight cycle

    assert.equal(weatherFetched, 1, 'weather fetched once');
    assert.equal(pricesFetched,  1, 'prices fetched once');

    // Pool should have received weather INSERT rows
    var weatherInserts = pool.queries.filter(function (q) { return q.sql.includes('weather_forecasts'); });
    var priceInserts   = pool.queries.filter(function (q) { return q.sql.includes('spot_prices'); });
    assert.ok(weatherInserts.length >= 2, 'at least 2 weather upserts (one per row)');
    assert.ok(priceInserts.length   >= 2, 'at least 2 price upserts (one per row)');
  });

  // ── 2. FMI error doesn't block price writes ──

  it('FMI error does not prevent spot-price writes', async () => {
    var pool = makePool();
    var log  = makeLog();

    var fmiClient = {
      fetchForecast: function () {
        return Promise.reject(new Error('FMI timeout'));
      },
    };
    var spotClient = {
      fetchPrices: function () {
        return Promise.resolve(makePriceRows());
      },
    };

    var refresher = create({
      pool,
      log,
      config: { location: { lat: 60.41, lon: 22.37 }, refreshIntervalMs: 9999999 },
      isPreviewMode: false,
      fmiClient,
      spotPriceClient: spotClient,
    });

    refresher.start();
    await refresher.stop();

    // Price inserts must still have happened despite FMI failure
    var priceInserts = pool.queries.filter(function (q) { return q.sql.includes('spot_prices'); });
    assert.ok(priceInserts.length >= 2, 'price upserts succeeded despite FMI error');

    // Error was logged
    var errorLogs = log.msgs.filter(function (m) { return m.level === 'error' && /weather/.test(m.msg); });
    assert.ok(errorLogs.length >= 1, 'weather error was logged');
  });

  // ── 3. isPreviewMode: no fetches, no DB writes ──

  it('isPreviewMode disables all fetches and DB writes', async () => {
    var pool = makePool();
    var log  = makeLog();
    var fetchCalled = 0;

    var fmiClient    = { fetchForecast: function () { fetchCalled++; return Promise.resolve([]); } };
    var spotClient   = { fetchPrices:   function () { fetchCalled++; return Promise.resolve([]); } };

    var refresher = create({
      pool,
      log,
      config: { location: { lat: 60.41, lon: 22.37 }, refreshIntervalMs: 9999999 },
      isPreviewMode: true,
      fmiClient,
      spotPriceClient: spotClient,
    });

    refresher.start();
    await refresher.stop();

    assert.equal(fetchCalled, 0, 'no fetches in preview mode');
    assert.equal(pool.queries.length, 0, 'no DB writes in preview mode');

    var infoLogs = log.msgs.filter(function (m) { return /preview/.test(m.msg); });
    assert.ok(infoLogs.length >= 1, 'preview mode logged');
  });

  // ── 4. stop() clears interval ──

  it('stop() clears the interval so no extra cycles fire', async () => {
    var pool = makePool();
    var log  = makeLog();
    var fetchCalls = 0;

    var fmiClient = {
      fetchForecast: function () {
        fetchCalls++;
        return Promise.resolve([]);
      },
    };
    var spotClient = {
      fetchPrices: function () {
        return Promise.resolve([]);
      },
    };

    var refresher = create({
      pool,
      log,
      config: { location: { lat: 60.41, lon: 22.37 }, refreshIntervalMs: 50 }, // short interval
      isPreviewMode: false,
      fmiClient,
      spotPriceClient: spotClient,
    });

    refresher.start();
    // Stop immediately — the interval shouldn't have fired yet beyond the initial cycle
    await refresher.stop();
    var countAfterStop = fetchCalls;

    // Wait longer than the interval to confirm no more cycles fire
    await new Promise(function (resolve) { setTimeout(resolve, 120); });
    assert.equal(fetchCalls, countAfterStop, 'no extra fetches after stop()');
  });

  // ── 5. Spot price error doesn't crash the cycle ──

  it('spot price error does not prevent weather writes', async () => {
    var pool = makePool();
    var log  = makeLog();

    var fmiClient = {
      fetchForecast: function () {
        return Promise.resolve(makeWeatherRows());
      },
    };
    var spotClient = {
      fetchPrices: function () {
        return Promise.reject(new Error('sahkotin HTTP 503'));
      },
    };

    var refresher = create({
      pool,
      log,
      config: { location: { lat: 60.41, lon: 22.37 }, refreshIntervalMs: 9999999 },
      isPreviewMode: false,
      fmiClient,
      spotPriceClient: spotClient,
    });

    refresher.start();
    await refresher.stop();

    var weatherInserts = pool.queries.filter(function (q) { return q.sql.includes('weather_forecasts'); });
    assert.ok(weatherInserts.length >= 2, 'weather upserts succeeded despite price error');

    var errorLogs = log.msgs.filter(function (m) { return m.level === 'error' && /prices/.test(m.msg); });
    assert.ok(errorLogs.length >= 1, 'price error was logged');
  });
});
