const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// Test the db module's pure logic without requiring a real PostgreSQL connection.
// We mock the pg Pool to capture SQL statements.

// Intercept require('pg') even if pg isn't installed
const originalResolveFilename = Module._resolveFilename;
let mockPgExports = {};
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'pg') return 'pg';
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

describe('db module', () => {
  let db;
  let capturedQueries;

  beforeEach(() => {
    capturedQueries = [];
    // Clear module cache to get fresh state
    delete require.cache[require.resolve('../monitor/lib/db.js')];

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

    // Inject mock into require cache (key 'pg' matches our _resolveFilename override)
    require.cache['pg'] = {
      id: 'pg',
      exports: { Pool: function () { return mockPool; } },
    };

    db = require('../monitor/lib/db.js');
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
    delete require.cache[require.resolve('../monitor/lib/db.js')];
    db = require('../monitor/lib/db.js');

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
    delete require.cache[require.resolve('../monitor/lib/db.js')];
    db = require('../monitor/lib/db.js');

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
    delete require.cache[require.resolve('../monitor/lib/db.js')];
    db = require('../monitor/lib/db.js');

    const ts = new Date();
    db.insertStateEvent(ts, 'mode', 'mode', 'idle', 'solar_charging', function (err) {
      assert.ifError(err);
      const insertQ = capturedQueries.find(q => q.sql && q.sql.includes('INSERT INTO state_events'));
      assert.ok(insertQ);
      assert.deepStrictEqual(insertQ.params, [ts, 'mode', 'mode', 'idle', 'solar_charging']);
      done();
    });
  });
});
