/**
 * Regression: switching the status-page graph to "7d" only showed ~48 h of
 * data even though the server was supposed to retain pre-aggregated history
 * for far longer.
 *
 * Root cause: `sensor_readings_30s` was a regular MATERIALIZED VIEW, and
 * runMaintenance() did `REFRESH MATERIALIZED VIEW CONCURRENTLY`, which
 * rebuilds the view from scratch off the current contents of
 * `sensor_readings`. Raw readings are pruned at 48 h (RETENTION_INTERVAL),
 * so each refresh wiped every aggregate older than that. The 7d/30d/1y
 * queries hit the aggregate, but the aggregate itself only ever held 48 h.
 *
 * Fix: `sensor_readings_30s` is now a real (hyper)table; maintenance does
 * an incremental UPSERT (`INSERT ... ON CONFLICT DO UPDATE`) of new buckets
 * so historical aggregates persist beyond the raw retention window.
 *
 * Related: for ranges > 24 h the server now coarsens the 30 s aggregates
 * via an additional `time_bucket()` (5 min for 7d, 30 min for 30d, 6 h for
 * 1y). 7 days × 2 points/min = 20 160 points was visually noisy and bumped
 * up against the client's 20 000-point store cap.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('sensor_readings_30s schema — table, not materialized view', () => {
  const schemaSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'lib', 'db-schema.js'),
    'utf8',
  );

  it('does NOT declare sensor_readings_30s as a MATERIALIZED VIEW', () => {
    // A MATERIALIZED VIEW is computed from sensor_readings on REFRESH, so
    // pruning raw readings at 48 h would discard all older aggregates.
    assert.doesNotMatch(
      schemaSrc,
      /CREATE\s+MATERIALIZED\s+VIEW[^;]*sensor_readings_30s/i,
      'sensor_readings_30s must not be a MATERIALIZED VIEW — it loses data on REFRESH after raw retention prunes',
    );
  });

  it('declares sensor_readings_30s as a CREATE TABLE', () => {
    assert.match(
      schemaSrc,
      /CREATE\s+TABLE[^;]*sensor_readings_30s/i,
      'sensor_readings_30s must be a real table so aggregates can outlive raw retention',
    );
  });

  it('drops any pre-existing materialized view to migrate prod deployments', () => {
    // Existing prod has the old MATERIALIZED VIEW. Schema must drop it
    // before creating the new table or the CREATE TABLE will fail with
    // "relation already exists".
    assert.match(
      schemaSrc,
      /DROP\s+MATERIALIZED\s+VIEW[^;]*sensor_readings_30s/i,
      'schema must drop the legacy MATERIALIZED VIEW before creating the table',
    );
  });

  it('keeps the (bucket, sensor_id) uniqueness constraint for ON CONFLICT upserts', () => {
    // The upsert path needs a unique constraint to target.
    assert.match(
      schemaSrc,
      /sensor_readings_30s[\s\S]*?(PRIMARY\s+KEY|UNIQUE)/i,
      'sensor_readings_30s must have a unique key on (bucket, sensor_id) for ON CONFLICT',
    );
  });
});

describe('runMaintenance — incremental UPSERT, never REFRESH', () => {
  let db;
  let capturedQueries;

  beforeEach(() => {
    capturedQueries = [];
    delete require.cache[require.resolve('../server/lib/db.js')];

    const mockPool = {
      on: function () {},
      query: function (sql, params, cb) {
        if (typeof params === 'function') { cb = params; params = []; }
        capturedQueries.push({ sql, params });
        // MAX(bucket) probe returns a sentinel timestamp.
        if (/MAX\(bucket\)/i.test(sql)) {
          if (cb) cb(null, { rows: [{ max_bucket: new Date('2026-04-22T00:00:00Z') }] });
          return;
        }
        if (cb) cb(null, { rows: [] });
      },
      connect: function (cb) {
        const mockClient = {
          query: function (sql, cb2) {
            capturedQueries.push({ sql });
            if (cb2) cb2(null, { rows: [] });
          },
        };
        cb(null, mockClient, function () {});
      },
      end: function (cb) { if (cb) cb(); },
    };

    require.cache[require.resolve('pg')] = {
      id: require.resolve('pg'),
      exports: { Pool: function () { return mockPool; } },
    };

    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db = require('../server/lib/db.js');
  });

  it('does not call REFRESH MATERIALIZED VIEW (would discard old aggregates)', (t, done) => {
    db._runMaintenanceForTest(function () {
      const refresh = capturedQueries.find(q => /REFRESH\s+MATERIALIZED\s+VIEW/i.test(q.sql || ''));
      assert.equal(
        refresh,
        undefined,
        'maintenance must not REFRESH the aggregate; that drops every bucket older than raw retention',
      );
      done();
    });
  });

  it('upserts new buckets into sensor_readings_30s using INSERT ... ON CONFLICT', (t, done) => {
    db._runMaintenanceForTest(function () {
      const upsert = capturedQueries.find(q =>
        /INSERT\s+INTO\s+sensor_readings_30s/i.test(q.sql || '') &&
        /ON\s+CONFLICT/i.test(q.sql || ''),
      );
      assert.ok(
        upsert,
        'maintenance must INSERT ... ON CONFLICT into sensor_readings_30s to incrementally extend the aggregate',
      );
      // The upsert should reference time_bucket so it actually aggregates raw rows.
      assert.match(upsert.sql, /time_bucket/i,
        'upsert SQL must use time_bucket to aggregate raw readings');
    });
    done();
  });

  // Load-bearing invariant: old aggregate buckets must persist forever so the
  // 7d/30d/1y graph views keep filling in beyond raw retention (48 h). These
  // guards catch the "someone adds a cleanup job to the aggregate" refactor
  // that would silently re-break long-range history with the same symptom as
  // the original bug.
  it('never issues DELETE or TRUNCATE against sensor_readings_30s', (t, done) => {
    db._runMaintenanceForTest(function () {
      const destructive = capturedQueries.find(q =>
        typeof q.sql === 'string' &&
        /sensor_readings_30s/i.test(q.sql) &&
        /\b(DELETE\s+FROM|TRUNCATE|DROP\s+TABLE)\b/i.test(q.sql),
      );
      assert.equal(
        destructive,
        undefined,
        'aggregate rows must persist forever; any cleanup job here re-introduces the ' +
        '"7d view shows only 48 h" bug. Found: ' + (destructive && destructive.sql),
      );
      done();
    });
  });

  it('retention DELETE only targets sensor_readings, never the aggregate', (t, done) => {
    db._runMaintenanceForTest(function () {
      const deletes = capturedQueries.filter(q =>
        typeof q.sql === 'string' && /\bDELETE\s+FROM\b/i.test(q.sql),
      );
      assert.ok(deletes.length > 0, 'expected a raw-retention DELETE for sanity');
      for (const q of deletes) {
        // The DELETE must reference sensor_readings (raw) and must NOT reference
        // the aggregate. Matching the raw table alone is not enough — a naive
        // `DELETE FROM sensor_readings_30s` also contains the substring
        // "sensor_readings".
        assert.match(q.sql, /DELETE\s+FROM\s+sensor_readings\b(?!_30s)/i,
          'retention DELETE must target sensor_readings (raw), not the aggregate: ' + q.sql);
        assert.doesNotMatch(q.sql, /sensor_readings_30s/i,
          'retention DELETE must not touch sensor_readings_30s: ' + q.sql);
      }
      done();
    });
  });
});

describe('getHistory — long-range smoothing via coarser time_buckets', () => {
  let db;
  let capturedQueries;

  beforeEach(() => {
    capturedQueries = [];
    delete require.cache[require.resolve('../server/lib/db.js')];

    const mockPool = {
      on: function () {},
      query: function (sql, params, cb) {
        if (typeof params === 'function') { cb = params; params = []; }
        capturedQueries.push({ sql, params });
        if (cb) cb(null, { rows: [] });
      },
      connect: function (cb) {
        cb(null, { query: function (s, c) { if (c) c(null, { rows: [] }); } }, function () {});
      },
      end: function (cb) { if (cb) cb(); },
    };
    require.cache[require.resolve('pg')] = {
      id: require.resolve('pg'),
      exports: { Pool: function () { return mockPool; } },
    };
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db = require('../server/lib/db.js');
  });

  function findHistoryQuery() {
    return capturedQueries.find(q =>
      q.sql && /sensor_readings_30s/i.test(q.sql) && /SELECT/i.test(q.sql),
    );
  }

  it('7d uses time_bucket coarser than 30 s to smooth the long view', (t, done) => {
    db.getHistory('7d', null, function () {
      const q = findHistoryQuery();
      assert.ok(q, 'expected an aggregate-table query for 7d');
      assert.match(q.sql, /time_bucket\s*\(\s*'5 minutes'/i,
        '7d should re-bucket the 30 s aggregates to 5-minute resolution');
      done();
    });
  });

  it('30d uses 30-minute buckets', (t, done) => {
    db.getHistory('30d', null, function () {
      const q = findHistoryQuery();
      assert.ok(q);
      assert.match(q.sql, /time_bucket\s*\(\s*'30 minutes'/i,
        '30d should re-bucket to 30-minute resolution');
      done();
    });
  });

  it('1y uses 6-hour buckets', (t, done) => {
    db.getHistory('1y', null, function () {
      const q = findHistoryQuery();
      assert.ok(q);
      assert.match(q.sql, /time_bucket\s*\(\s*'6 hours'/i,
        '1y should re-bucket to 6-hour resolution');
      done();
    });
  });

  it('24h still serves 30 s resolution (no extra coarsening)', (t, done) => {
    // 24h is already a manageable point count and benefits from full
    // resolution near the right edge — leave it on the blended path.
    db.getHistory('24h', null, function () {
      const allSql = capturedQueries.map(q => q.sql || '').join('\n');
      // 24h must NOT include a time_bucket coarser than 30 seconds.
      const coarseMatch = allSql.match(/time_bucket\s*\(\s*'(\d+)\s*(minute|hour|day)s?'/i);
      if (coarseMatch) {
        // Allow only the 30-seconds bucket if present (it isn't, but be explicit).
        assert.fail('24h should not coarsen the aggregate, found: ' + coarseMatch[0]);
      }
      done();
    });
  });
});
