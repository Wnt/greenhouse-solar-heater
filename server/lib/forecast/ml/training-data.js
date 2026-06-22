'use strict';

// Bounded, fixed-resolution history feed for the ML trainer.
//
// db.getHistory couples span to bucket size (a UI range like '30d' forces
// 30-minute buckets), so it can't give "a long window at fine resolution".
// The trainer needs exactly that: ~1 month of behavioural diversity AND
// 5-minute resolution (= STEP_FINE_MS) for the near-term forecast step.
// This re-buckets the 30 s aggregate to an explicit `bucketInterval` over a
// rolling `days`-day window, so row count is sensors × days × (1440 /
// bucketMinutes) — bounded and modest regardless of how long the system has
// been collecting. (Replaces the trainer's old range:'all', which returned
// raw 30 s rows over ALL history and OOM-killed the app heap once the table
// grew large — nginx 503s, 2026-06-22.)
//
// Lives outside db.js (which is at its size cap) and is injected into the
// trainer, so it stays unit-testable in isolation.
//
// `db` must expose getPool() and pivotReadings(rows).
function createTrainingDataLoader(db) {
  return function getTrainingHistory(days, bucketInterval, callback) {
    const d = parseInt(days, 10);
    if (!(d > 0) || d > 366) {
      callback(new Error('getTrainingHistory: days must be 1..366, got ' + days));
      return;
    }
    // bucketInterval is string-interpolated into SQL, so it must never be
    // user-controlled — restrict to a simple "<n> minutes|hours" whitelist.
    if (typeof bucketInterval !== 'string' || !/^[1-9][0-9]* (minutes|hours)$/.test(bucketInterval)) {
      callback(new Error('getTrainingHistory: invalid bucket interval ' + bucketInterval));
      return;
    }
    const p = db.getPool();
    if (!p) { callback(new Error('getTrainingHistory: no database pool')); return; }
    const sql = "SELECT time_bucket('" + bucketInterval + "', bucket) AS ts, sensor_id," +
      " AVG(avg_value) AS value FROM sensor_readings_30s" +
      " WHERE bucket > NOW() - INTERVAL '" + d + " days'" +
      ' GROUP BY ts, sensor_id ORDER BY ts';
    p.query(sql, [], function (err, result) {
      if (err) { callback(err); return; }
      callback(null, db.pivotReadings(result.rows));
    });
  };
}

module.exports = { createTrainingDataLoader };
