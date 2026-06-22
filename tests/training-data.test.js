'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createTrainingDataLoader } = require('../server/lib/forecast/ml/training-data');

// Bounded, fixed-resolution history feed for the ML trainer. Decouples the
// training window (span) from bucket size, so the trainer can pull a long
// window at fine resolution without loading raw 30 s rows (the old range
// 'all' load OOM-killed the app heap — nginx 503s, 2026-06-22). The module
// is pure given `db`, so we drive it with a fake db that captures SQL.

function fakeDb(onQuery) {
  return {
    getPool() {
      return {
        query(sql, params, cb) { onQuery(sql, params); cb(null, { rows: [] }); },
      };
    },
    pivotReadings(rows) { return rows; },
  };
}

test('re-buckets the 30s aggregate at the requested fixed resolution over an N-day window', (t, done) => {
  let sql = null;
  const load = createTrainingDataLoader(fakeDb((s) => { sql = s; }));
  load(30, '5 minutes', function (err) {
    assert.ifError(err);
    assert.match(sql, /FROM sensor_readings_30s/, 'should query the 30s aggregate table');
    assert.match(sql, /time_bucket\('5 minutes'/, 'should re-bucket to the requested resolution');
    assert.match(sql, /INTERVAL '30 days'/, 'should bound to the N-day window');
    assert.doesNotMatch(sql, /FROM sensor_readings\b(?!_30s)/, 'must not touch raw sensor_readings (pruned at 48h)');
    done();
  });
});

test('rejects an out-of-range window (guards against an unbounded "all"-style load)', (t, done) => {
  let queried = false;
  const load = createTrainingDataLoader(fakeDb(() => { queried = true; }));
  load(0, '5 minutes', function (err) {
    assert.ok(err && /days/.test(err.message), 'days=0 should error');
    load(9999, '5 minutes', function (err2) {
      assert.ok(err2 && /days/.test(err2.message), 'absurd day count should error');
      assert.strictEqual(queried, false, 'must not issue SQL on invalid input');
      done();
    });
  });
});

test('rejects a non-whitelisted bucket interval (SQL-injection guard)', (t, done) => {
  let queried = false;
  const load = createTrainingDataLoader(fakeDb(() => { queried = true; }));
  load(30, "5 minutes'); DROP TABLE sensor_readings_30s;--", function (err) {
    assert.ok(err && /bucket/.test(err.message), 'malicious bucket string should error');
    assert.strictEqual(queried, false, 'must not issue SQL on invalid input');
    done();
  });
});
