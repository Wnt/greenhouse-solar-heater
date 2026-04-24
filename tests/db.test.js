const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');

// Test the db module's pure logic without requiring a real PostgreSQL connection.
// We mock the pg Pool to capture SQL statements.

describe('db module', () => {
  let db;
  let capturedQueries;

  beforeEach(() => {
    capturedQueries = [];
    // Clear module cache to get fresh state
    delete require.cache[require.resolve('../server/lib/db.js')];

    // Mock pg module
    const mockPool = {
      on: function () {},
      query: function (sql, params, cb) {
        if (typeof params === 'function') { cb = params; params = []; }
        capturedQueries.push({ sql, params });
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

    // Inject mock
    require.cache[require.resolve('pg')] = {
      id: require.resolve('pg'),
      exports: { Pool: function () { return mockPool; } },
    };

    db = require('../server/lib/db.js');
  });

  it('initSchema runs all schema SQL statements', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db.initSchema(function (err) {
      assert.ifError(err);
      // Should have run CREATE EXTENSION, CREATE TABLE x2, create_hypertable x2, CREATE INDEX x2
      assert.ok(capturedQueries.length >= 7, 'expected at least 7 schema statements, got ' + capturedQueries.length);
      assert.ok(capturedQueries[0].sql.includes('timescaledb'));
      assert.ok(capturedQueries[1].sql.includes('sensor_readings'));
      done();
    });
  });

  it('insertSensorReadings builds correct INSERT with all sensors', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();

    // Re-require with mock still in place
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    const ts = new Date('2024-01-01T12:00:00Z');
    db.insertSensorReadings(ts, {
      collector: 65.2,
      tank_top: 48.1,
      tank_bottom: 32.5,
      greenhouse: 18.3,
      outdoor: 12.7,
    }, function (err) {
      assert.ifError(err);
      const insertQ = capturedQueries.find(q => q.sql && q.sql.includes('INSERT INTO sensor_readings'));
      assert.ok(insertQ, 'should have an INSERT query');
      assert.strictEqual(insertQ.params.length, 15); // 5 sensors × 3 params each
      done();
    });
  });

  it('insertSensorReadings skips null values', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    const ts = new Date();
    db.insertSensorReadings(ts, {
      collector: 65.2,
      tank_top: null,
      tank_bottom: 32.5,
    }, function (err) {
      assert.ifError(err);
      const insertQ = capturedQueries.find(q => q.sql && q.sql.includes('INSERT INTO sensor_readings'));
      assert.ok(insertQ);
      assert.strictEqual(insertQ.params.length, 6); // 2 sensors × 3 params
      done();
    });
  });

  it('insertStateEvent stores event with correct parameters', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    const ts = new Date();
    db.insertStateEvent(ts, 'mode', 'mode', 'idle', 'solar_charging', function (err) {
      assert.ifError(err);
      const insertQ = capturedQueries.find(q => q.sql && q.sql.includes('INSERT INTO state_events'));
      assert.ok(insertQ);
      // cause + reason + sensors default to null when not supplied
      // (valve/actuator rows, or mode rows from pre-2026-04-21 firmware).
      assert.deepStrictEqual(insertQ.params, [ts, 'mode', 'mode', 'idle', 'solar_charging', null, null, null]);
      done();
    });
  });

  it('insertStateEvent persists cause, reason, and sensors from opts', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    const ts = new Date();
    const sensors = { collector: 62.3, tank_top: 41, tank_bottom: 29, greenhouse: 12, outdoor: 8 };
    db.insertStateEvent(ts, 'mode', 'mode', 'idle', 'solar_charging',
      { cause: 'automation', reason: 'solar_enter', sensors }, function (err) {
        assert.ifError(err);
        const insertQ = capturedQueries.find(q => q.sql && q.sql.includes('INSERT INTO state_events'));
        assert.ok(insertQ);
        assert.deepStrictEqual(insertQ.params,
          [ts, 'mode', 'mode', 'idle', 'solar_charging', 'automation', 'solar_enter', sensors]);
        done();
      });
  });

  it('getHistory uses parameterized query when sensor is provided', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    db.getHistory('6h', 'collector', function (err) {
      assert.ifError(err);
      const historyQ = capturedQueries.find(q => q.sql && q.sql.includes('sensor_readings'));
      assert.ok(historyQ, 'should have a sensor_readings query');
      assert.ok(Array.isArray(historyQ.params), 'params should be an array');
      assert.ok(historyQ.params.includes('collector'), 'params should contain the sensor value');
      assert.ok(!historyQ.sql.includes("'collector'"), 'SQL should not contain the sensor value as a literal string');
      assert.ok(historyQ.sql.includes('$1'), 'SQL should use $1 placeholder');
      done();
    });
  });

  it('getEvents uses parameterized query when entityType is provided', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    db.getEvents('6h', 'mode', function (err) {
      assert.ifError(err);
      const eventsQ = capturedQueries.find(q => q.sql && q.sql.includes('state_events'));
      assert.ok(eventsQ, 'should have a state_events query');
      assert.ok(Array.isArray(eventsQ.params), 'params should be an array');
      assert.ok(eventsQ.params.includes('mode'), 'params should contain the entityType value');
      assert.ok(!eventsQ.sql.includes("'mode'"), 'SQL should not contain the entityType value as a literal string');
      assert.ok(eventsQ.sql.includes('$1'), 'SQL should use $1 placeholder');
      done();
    });
  });

  it('getEventsPaginated returns events newest-first limited by limit', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    db.getEventsPaginated('mode', 10, null, function (err) {
      assert.ifError(err);
      const eventsQ = capturedQueries.find(q => q.sql && q.sql.includes('state_events'));
      assert.ok(eventsQ, 'should have a state_events query');
      assert.ok(/ORDER BY\s+ts\s+DESC/i.test(eventsQ.sql), 'should order newest-first');
      assert.ok(/LIMIT\s+\$\d+/.test(eventsQ.sql), 'limit must be parameterized');
      assert.ok(eventsQ.params.includes('mode'));
      assert.ok(eventsQ.params.includes(11), 'should query limit+1 to compute hasMore');
      done();
    });
  });

  it('getEventsPaginated supports cursor-based pagination with `before`', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    const beforeMs = 1_700_000_000_000;
    db.getEventsPaginated('mode', 10, beforeMs, function (err) {
      assert.ifError(err);
      const eventsQ = capturedQueries.find(q => q.sql && q.sql.includes('state_events'));
      assert.ok(eventsQ);
      // Cursor should be parameterized and applied as strict inequality
      assert.ok(/ts\s*<\s*\$\d+/.test(eventsQ.sql), 'should use a strict-less-than cursor on ts');
      // Parameter should be a Date derived from beforeMs (not the raw number)
      const cursorParam = eventsQ.params.find(p => p instanceof Date);
      assert.ok(cursorParam, 'cursor must be passed as a Date');
      assert.strictEqual(cursorParam.getTime(), beforeMs);
      done();
    });
  });

  it('getEventsPaginated caps limit at 100', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    db.getEventsPaginated('mode', 999, null, function (err) {
      assert.ifError(err);
      const eventsQ = capturedQueries.find(q => q.sql && q.sql.includes('state_events'));
      assert.ok(eventsQ);
      // Must query at most 101 rows (100 cap + 1 for hasMore)
      assert.ok(eventsQ.params.includes(101), 'limit should be capped at 100 (+1 for hasMore)');
      done();
    });
  });

  it('getEventsPaginated returns {events, hasMore:false} when row count <= limit', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();

    // Custom pool that returns 2 rows for a limit of 10
    const rows = [
      { ts: new Date('2026-04-09T12:00:00Z'), entity_type: 'mode', entity_id: 'mode', old_value: 'idle',           new_value: 'solar_charging' },
      { ts: new Date('2026-04-09T11:00:00Z'), entity_type: 'mode', entity_id: 'mode', old_value: 'solar_charging', new_value: 'idle' },
    ];
    require.cache[require.resolve('pg')] = {
      id: require.resolve('pg'),
      exports: { Pool: function () { return {
        on: function () {},
        query: function (sql, params, cb) { cb(null, { rows }); },
      }; } },
    };
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    db.getEventsPaginated('mode', 10, null, function (err, result) {
      assert.ifError(err);
      assert.strictEqual(result.events.length, 2);
      assert.strictEqual(result.hasMore, false);
      // Events should carry { ts, type, id, from, to }
      assert.strictEqual(result.events[0].type, 'mode');
      assert.strictEqual(result.events[0].from, 'idle');
      assert.strictEqual(result.events[0].to, 'solar_charging');
      assert.strictEqual(typeof result.events[0].ts, 'number');
      done();
    });
  });

  it('getEventsPaginated returns {events, hasMore:true} when row count > limit', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();

    // limit=2, return 3 rows (2 + 1 extra for hasMore)
    const rows = [
      { ts: new Date('2026-04-09T12:00:00Z'), entity_type: 'mode', entity_id: 'mode', old_value: 'idle',           new_value: 'solar_charging' },
      { ts: new Date('2026-04-09T11:00:00Z'), entity_type: 'mode', entity_id: 'mode', old_value: 'solar_charging', new_value: 'idle' },
      { ts: new Date('2026-04-09T10:00:00Z'), entity_type: 'mode', entity_id: 'mode', old_value: 'idle',           new_value: 'solar_charging' },
    ];
    require.cache[require.resolve('pg')] = {
      id: require.resolve('pg'),
      exports: { Pool: function () { return {
        on: function () {},
        query: function (sql, params, cb) { cb(null, { rows }); },
      }; } },
    };
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    db.getEventsPaginated('mode', 2, null, function (err, result) {
      assert.ifError(err);
      assert.strictEqual(result.events.length, 2, 'trailing sentinel row should be dropped');
      assert.strictEqual(result.hasMore, true);
      done();
    });
  });

  it('getHistory with SQL metacharacters in sensor uses parameterized query', (t, done) => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    const maliciousSensor = "collector' OR '1'='1";
    db.getHistory('6h', maliciousSensor, function (err) {
      assert.ifError(err);
      const historyQ = capturedQueries.find(q => q.sql && q.sql.includes('sensor_readings'));
      assert.ok(historyQ, 'should have a sensor_readings query');
      assert.ok(Array.isArray(historyQ.params), 'params should be an array');
      assert.ok(historyQ.params.includes(maliciousSensor), 'malicious string should be in params, not interpolated into SQL');
      assert.ok(!historyQ.sql.includes(maliciousSensor), 'SQL should not contain the malicious string');
      done();
    });
  });

  it('pool.query() rejects calls without a params array', () => {
    process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
    db._reset();
    delete require.cache[require.resolve('../server/lib/db.js')];
    db = require('../server/lib/db.js');

    const pool = db.getPool();
    assert.throws(
      () => pool.query('SELECT 1', function () {}),
      /requires a params array/,
      'calling pool.query(sql, cb) without params should throw'
    );
  });
});

// Architectural fitness test: scan db.js source for SQL injection patterns.
// This catches regressions where someone concatenates a variable into a WHERE clause.
describe('db module architectural constraints', () => {
  it('no string concatenation of variables into SQL WHERE/AND clauses', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'lib', 'db.js'),
      'utf8'
    );

    // Match patterns like: " column = '" + variable + "'"
    // These indicate SQL string interpolation of a variable into a query.
    const interpolationPattern = /["']\s*\+\s*\w+\s*\+\s*["']/g;
    const lines = source.split('\n');
    const violations = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Only flag lines that look like SQL (WHERE, AND, OR, =) with interpolation
      if (/(WHERE|AND|OR)\b/.test(line) && /=\s*'"\s*\+/.test(line)) {
        violations.push({ line: i + 1, text: line.trim() });
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      'Found SQL string interpolation in WHERE/AND clauses — use parameterized queries ($1, $2, ...) instead:\n' +
      violations.map(v => '  Line ' + v.line + ': ' + v.text).join('\n')
    );
  });

  it('all pool.query() calls pass a params array', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'lib', 'db.js'),
      'utf8'
    );

    const lines = source.split('\n');
    const violations = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match p.query(sql, function — missing params array between sql and callback
      if (/\.query\(\s*sql\s*,\s*function\b/.test(line)) {
        violations.push({ line: i + 1, text: line.trim() });
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      'Found pool.query() calls without params array — pass [] for no parameters:\n' +
      violations.map(v => '  Line ' + v.line + ': ' + v.text).join('\n')
    );
  });
});
