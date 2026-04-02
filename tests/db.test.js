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
      assert.deepStrictEqual(insertQ.params, [ts, 'mode', 'mode', 'idle', 'solar_charging']);
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
});
