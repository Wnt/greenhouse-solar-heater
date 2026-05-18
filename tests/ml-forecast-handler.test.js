'use strict';

// GET /api/forecast?engine=ml — `tu` what-if override.
//
// The ML engine mirrors the physics engine's tuning-override support so
// the Tuning-thresholds forecast preview works regardless of which
// engine the operator has selected.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMlForecastHandler } = require('../server/lib/forecast/ml/ml-forecast-handler.js');

function makeLog() {
  const stub = () => () => {};
  return { info: stub(), warn: stub(), error: stub() };
}

function fakeRes() {
  const written = { status: null, body: null };
  return {
    written,
    writeHead(s) { written.status = s; },
    end(b) { written.body = b ? JSON.parse(b) : null; },
  };
}

function fakeReq(url) { return { url, method: 'GET' }; }

function makePool() {
  const now = new Date('2026-05-04T10:00:00Z');
  const weather = [];
  const prices = [];
  for (let h = 0; h < 48; h++) {
    const validAt = new Date(now.getTime() + h * 3600000);
    weather.push({ valid_at: validAt, temperature: 6, radiationGlobal: 120, windSpeed: 2, precipitation: 0 });
    prices.push({ valid_at: validAt, priceCKwh: 10 });
  }
  return {
    query(sql, _params, cb) {
      let rows = [];
      if (sql.includes('weather_forecasts')) rows = weather;
      else if (sql.includes('spot_prices')) rows = prices;
      else if (sql.includes('state_events')) rows = [{ mode: 'idle' }];
      else if (sql.includes('sensor_readings_30s')) {
        rows = [
          { sensor_id: 'tank_top', value: 45 },
          { sensor_id: 'tank_bottom', value: 38 },
          { sensor_id: 'greenhouse', value: 12 },
        ];
      }
      cb(null, { rows });
    },
  };
}

function handleAndWait(handler, url, done, assertFn) {
  const res = fakeRes();
  handler.handle(fakeReq(url), res);
  const deadline = Date.now() + 2000;
  (function poll() {
    if (res.written.status !== null) { assertFn(res.written); done(); }
    else if (Date.now() < deadline) setImmediate(poll);
    else done(new Error('handler did not respond: ' + url));
  })();
}

describe('GET /api/forecast?engine=ml — tu override', () => {
  it('threads a ?tu= override into the ML forecast response', function (t, done) {
    const handler = createMlForecastHandler({ pool: makePool(), log: makeLog(), systemYaml: {} });
    if (!handler.modelLoaded) { done(); return; } // model artifact missing — skip
    const url = '/api/forecast?engine=ml&tu=' + encodeURIComponent(JSON.stringify({ geT: 20 }));
    handleAndWait(handler, url, done, function (written) {
      assert.equal(written.status, 200);
      assert.equal(written.body.tu.geT, 20, 'response tu reflects the override');
    });
  });

  it('a ?tu= preview does not poison the live ML cache', function (t, done) {
    const handler = createMlForecastHandler({ pool: makePool(), log: makeLog(), systemYaml: {} });
    if (!handler.modelLoaded) { done(); return; }
    handleAndWait(handler, '/api/forecast?engine=ml', function (e1) {
      if (e1) return done(e1);
      const url = '/api/forecast?engine=ml&tu=' + encodeURIComponent(JSON.stringify({ geT: 20 }));
      handleAndWait(handler, url, function (e2) {
        if (e2) return done(e2);
        handleAndWait(handler, '/api/forecast?engine=ml', done, function (written) {
          assert.equal(written.status, 200);
          assert.equal(written.body.tu.geT, undefined, 'live cache not poisoned by the preview');
        });
      }, function (written) {
        assert.equal(written.status, 200);
        assert.equal(written.body.tu.geT, 20, 'preview recomputed despite the warm cache');
      });
    }, function (written) {
      assert.equal(written.status, 200);
    });
  });
});
