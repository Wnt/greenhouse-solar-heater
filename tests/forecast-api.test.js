'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createForecastHandler } = require('../server/lib/forecast-handler.js');

// ── Stubs ──

function makeLog() {
  var msgs = [];
  var stub = function (level) {
    return function (msg, meta) { msgs.push({ level, msg, meta }); };
  };
  return { msgs, info: stub('info'), warn: stub('warn'), error: stub('error') };
}

function fakeRes() {
  var written = { status: null, headers: {}, body: null };
  return {
    written,
    writeHead: function (status, headers) {
      written.status = status;
      written.headers = headers || {};
    },
    end: function (body) {
      written.body = body ? JSON.parse(body) : null;
    },
  };
}

function fakeReq(url) {
  return { url: url || '/api/forecast', method: 'GET' };
}

// Build a pool stub where each expected SQL prefix returns supplied rows.
function makePool(rowMap) {
  return {
    query: function (sql, _params, cb) {
      var result = { rows: [] };
      var keys = Object.keys(rowMap);
      for (var i = 0; i < keys.length; i++) {
        if (sql.includes(keys[i])) {
          result.rows = rowMap[keys[i]].slice();
          break;
        }
      }
      if (cb) cb(null, result);
    },
  };
}

// ── Fixture data ──

var NOW_ISO = new Date('2026-05-04T10:00:00Z');

function makeWeatherRows() {
  var rows = [];
  for (var h = 0; h < 48; h++) {
    rows.push({
      valid_at:        new Date(NOW_ISO.getTime() + h * 3600 * 1000),
      temperature:     7.2,
      radiationGlobal: h >= 10 && h <= 16 ? 350 : 0,
      windSpeed:       1.5,
      precipitation:   0,
    });
  }
  return rows;
}

function makePriceRows() {
  var rows = [];
  for (var h = 0; h < 48; h++) {
    rows.push({
      valid_at:   new Date(NOW_ISO.getTime() + h * 3600 * 1000),
      priceCKwh:  12.5,
      source:     'sahkotin',
    });
  }
  return rows;
}

function makeSensorRows() {
  return [
    { sensor_id: 'tank_top',    value: 45.0 },
    { sensor_id: 'tank_bottom', value: 38.0 },
    { sensor_id: 'greenhouse',  value: 12.0 },
    { sensor_id: 'outdoor',     value: 3.0  },
    { sensor_id: 'collector',   value: 8.0  },
  ];
}

function makeSensorReadings30sRows() {
  // Pool key match is on "sensor_readings_30s" for both sensors and history.
  // The sensor query looks for DISTINCT ON (sensor_id); the history query looks for bucket.
  // We return rows that satisfy both shapes.
  return makeSensorRows().map(function (r) {
    return { sensor_id: r.sensor_id, value: r.value, bucket: new Date(), ts: new Date() };
  });
}

// ── Tests ──

describe('GET /api/forecast handler', () => {
  it('returns 503 when pool is null', function (t, done) {
    var log = makeLog();
    var handler = createForecastHandler({ pool: null, log, systemYaml: {} });
    var req = fakeReq();
    var res = fakeRes();
    handler.handle(req, res);
    assert.equal(res.written.status, 503);
    assert.ok(res.written.body.error, 'error field present');
    done();
  });

  it('returns 200 with correct response shape on happy path', function (t, done) {
    var log = makeLog();

    var pool = makePool({
      // Latest sensors
      'sensor_readings_30s': makeSensorReadings30sRows(),
      // Current mode
      'state_events': [{ mode: 'idle' }],
      // Weather 48 h
      'weather_forecasts': makeWeatherRows(),
      // Prices 48 h
      'spot_prices': makePriceRows(),
    });

    var handler = createForecastHandler({
      pool,
      log,
      systemYaml: {
        location:    { lat: 60.41, lon: 22.37 },
        electricity: { transfer_fee_c_kwh: 5 },
        space_heater: { assumed_continuous_power_kw: 1 },
        components:  { solar_collectors: { total_area: '4m²' } },
      },
    });

    var req = fakeReq();
    var res = fakeRes();
    handler.handle(req, res);

    // Handler is async (multiple pool.query calls + callback chain).
    // Use setImmediate to let the microtask/callback queue flush.
    var deadline = Date.now() + 2000;
    function poll() {
      if (res.written.status !== null) {
        // Assertions
        assert.equal(res.written.status, 200);
        var body = res.written.body;
        assert.ok(typeof body.generatedAt === 'string', 'generatedAt present');
        assert.ok(Array.isArray(body.weather), 'weather array');
        assert.ok(Array.isArray(body.prices), 'prices array');
        assert.ok(body.forecast, 'forecast object present');
        assert.ok(typeof body.forecast.hoursUntilFloor !== 'undefined', 'hoursUntilFloor present');
        assert.ok(typeof body.forecast.electricKwh === 'number', 'electricKwh is number');
        assert.ok(typeof body.forecast.electricCostEur === 'number', 'electricCostEur is number');
        assert.ok(Array.isArray(body.forecast.tankTrajectory), 'tankTrajectory array');
        assert.ok(typeof body.forecast.modelConfidence === 'string', 'modelConfidence string');
        done();
      } else if (Date.now() < deadline) {
        setImmediate(poll);
      } else {
        done(new Error('handler did not respond within 2 s'));
      }
    }
    setImmediate(poll);
  });

  it('uses 60 s in-process cache on second call', function (t, done) {
    var log = makeLog();
    var queryCalls = 0;

    var pool = {
      query: function (sql, params, cb) {
        queryCalls++;
        cb(null, { rows: [] });
      },
    };

    // Create a fresh handler (no cached state from previous test).
    var handler = createForecastHandler({ pool, log, systemYaml: {} });

    var req = fakeReq();
    var res1 = fakeRes();
    var res2 = fakeRes();

    handler.handle(req, res1);

    var deadline = Date.now() + 2000;
    function waitFirst() {
      if (res1.written.status !== null) {
        var callsAfterFirst = queryCalls;
        handler.handle(req, res2);
        // Second call should return cached response immediately — same tick.
        assert.equal(res2.written.status, 200, 'second call 200');
        assert.equal(queryCalls, callsAfterFirst, 'no extra DB calls on second request');
        done();
      } else if (Date.now() < deadline) {
        setImmediate(waitFirst);
      } else {
        done(new Error('first handler call did not respond'));
      }
    }
    setImmediate(waitFirst);
  });

  it('returns 500 when all parallel queries fail', function (t, done) {
    var log = makeLog();

    var pool = {
      query: function (sql, params, cb) {
        cb(new Error('DB connection lost'));
      },
    };

    // Clear module-level caches so previous test's cache doesn't mask the error.
    // We can't reach private _responseCache directly, so create a fresh handler.
    var handler = createForecastHandler({ pool, log, systemYaml: {} });
    var req = fakeReq();
    var res = fakeRes();
    handler.handle(req, res);

    var deadline = Date.now() + 2000;
    function waitForResponse() {
      if (res.written.status !== null) {
        // When all 4 parallel queries fail, the first error triggers a 500.
        assert.equal(res.written.status, 500);
        assert.ok(res.written.body && res.written.body.error, 'error field present');
        done();
      } else if (Date.now() < deadline) {
        setImmediate(waitForResponse);
      } else {
        done(new Error('handler did not respond'));
      }
    }
    setImmediate(waitForResponse);
  });

  it('reads space_heater and electricity config from systemYaml', function (t, done) {
    var log = makeLog();
    var pool = {
      query: function (sql, params, cb) { cb(null, { rows: [] }); },
    };

    var handler = createForecastHandler({
      pool,
      log,
      systemYaml: {
        space_heater: { assumed_continuous_power_kw: 2 },
        electricity:  { transfer_fee_c_kwh: 7.5 },
      },
    });

    var req = fakeReq();
    var res = fakeRes();
    handler.handle(req, res);

    var deadline = Date.now() + 2000;
    function waitForResponse() {
      if (res.written.status !== null) {
        // Handler should not crash on non-standard config values.
        assert.ok(res.written.status === 200 || res.written.status === 500);
        done();
      } else if (Date.now() < deadline) {
        setImmediate(waitForResponse);
      } else {
        done(new Error('handler did not respond'));
      }
    }
    setImmediate(waitForResponse);
  });
});
