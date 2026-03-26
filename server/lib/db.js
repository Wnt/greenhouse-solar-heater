/**
 * PostgreSQL/TimescaleDB module for sensor readings and state events.
 *
 * Connection URL resolution (in order):
 *   1. DATABASE_URL environment variable
 *   2. S3 object storage (database-url.json) — loaded via resolveUrl()
 *
 * CLI: node monitor/lib/db.js --init   (creates schema)
 */

var createLogger = require('./logger');
var log = createLogger('db');

var pool = null;
var resolvedUrl = null;
var resolvedCa = null;

function getConnectionUrl() {
  return resolvedUrl || process.env.DATABASE_URL || null;
}

function resolveUrl(callback) {
  var hasEnvUrl = !!process.env.DATABASE_URL;
  if (hasEnvUrl) {
    resolvedUrl = process.env.DATABASE_URL;
  }

  // Always check S3 for CA cert (and URL if not in env)
  var dbConfig = require('./db-config');
  dbConfig.load(function (err, url, ca) {
    if (err) {
      log.warn('failed to load config from S3', { error: err.message });
      callback(null, resolvedUrl);
      return;
    }
    if (!hasEnvUrl && url) {
      resolvedUrl = url;
      log.info('DATABASE_URL loaded from S3');
    }
    if (ca) {
      resolvedCa = ca;
      log.info('DB CA certificate loaded from S3');
    }
    callback(null, resolvedUrl);
  });
}

function getPool() {
  if (pool) return pool;
  var url = getConnectionUrl();
  if (!url) return null;
  var Pool = require('pg').Pool;
  // pg merges config as: Object.assign({}, config, parse(connectionString))
  // so parsed sslmode overrides explicit ssl options. To use our CA cert,
  // strip sslmode from the URL and configure SSL entirely via the ssl option.
  var cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, '');
  var opts = {
    connectionString: cleanUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    ssl: resolvedCa
      ? { ca: resolvedCa, rejectUnauthorized: true }
      : url.indexOf('sslmode=') !== -1,
  };
  pool = new Pool(opts);
  pool.on('error', function (err) {
    log.error('unexpected pool error', { error: err.message });
  });
  return pool;
}

// ── Schema initialization ──

var SCHEMA_SQL = [
  'CREATE EXTENSION IF NOT EXISTS timescaledb',

  "CREATE TABLE IF NOT EXISTS sensor_readings (\n" +
  "  ts         TIMESTAMPTZ NOT NULL,\n" +
  "  sensor_id  TEXT        NOT NULL,\n" +
  "  value      DOUBLE PRECISION NOT NULL\n" +
  ")",

  "SELECT create_hypertable('sensor_readings', 'ts', if_not_exists => true)",

  "CREATE INDEX IF NOT EXISTS sensor_readings_sensor_ts ON sensor_readings (sensor_id, ts DESC)",

  "CREATE TABLE IF NOT EXISTS state_events (\n" +
  "  ts          TIMESTAMPTZ NOT NULL,\n" +
  "  entity_type TEXT        NOT NULL,\n" +
  "  entity_id   TEXT        NOT NULL,\n" +
  "  old_value   TEXT,\n" +
  "  new_value   TEXT        NOT NULL\n" +
  ")",

  "SELECT create_hypertable('state_events', 'ts', if_not_exists => true)",

  "CREATE INDEX IF NOT EXISTS state_events_type_ts ON state_events (entity_type, ts DESC)",
];

// Regular materialized view (no TSL license required, unlike continuous aggregates).
// Refreshed periodically by the app via startMaintenance().
var AGGREGATE_SQL = [
  "CREATE MATERIALIZED VIEW IF NOT EXISTS sensor_readings_30s AS\n" +
  "SELECT time_bucket('30 seconds', ts) AS bucket,\n" +
  "       sensor_id,\n" +
  "       AVG(value) AS avg_value,\n" +
  "       MIN(value) AS min_value,\n" +
  "       MAX(value) AS max_value\n" +
  "FROM sensor_readings\n" +
  "GROUP BY bucket, sensor_id",

  // Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY
  "CREATE UNIQUE INDEX IF NOT EXISTS sensor_readings_30s_uniq ON sensor_readings_30s (bucket, sensor_id)",
];

var maintenanceTimer = null;
var MAINTENANCE_INTERVAL = 30 * 60 * 1000; // 30 minutes
var RETENTION_INTERVAL = '48 hours';

function initSchema(callback) {
  var p = getPool();
  var client;

  p.connect(function (err, c, release) {
    if (err) { callback(err); return; }
    client = c;

    runStatements(client, SCHEMA_SQL, 0, function (schemaErr) {
      if (schemaErr) { release(); callback(schemaErr); return; }

      runStatements(client, AGGREGATE_SQL, 0, function (aggErr) {
        if (aggErr) {
          log.warn('aggregate creation skipped (may already exist)', { error: aggErr.message });
        }
        release();
        callback(null);
      });
    });
  });
}

// Periodic maintenance: refresh materialized view + delete old raw data.
// Called automatically via startMaintenance() after server boot.
function runMaintenance(callback) {
  var p = getPool();
  if (!p) { if (callback) callback(); return; }

  p.query('REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_30s', function (err) {
    if (err) {
      log.warn('materialized view refresh failed', { error: err.message });
    } else {
      log.info('materialized view refreshed');
    }

    p.query("DELETE FROM sensor_readings WHERE ts < NOW() - INTERVAL '" + RETENTION_INTERVAL + "'", function (err2) {
      if (err2) {
        log.warn('retention cleanup failed', { error: err2.message });
      } else {
        log.info('retention cleanup done');
      }
      if (callback) callback();
    });
  });
}

function startMaintenance() {
  if (maintenanceTimer) return;
  // Run once shortly after boot (give time for initial data), then every 30 min
  maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_INTERVAL);
  // Initial refresh after 60s
  setTimeout(runMaintenance, 60 * 1000);
  log.info('maintenance scheduler started', { intervalMin: MAINTENANCE_INTERVAL / 60000 });
}

function stopMaintenance() {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

function runStatements(client, stmts, idx, callback) {
  if (idx >= stmts.length) { callback(null); return; }
  client.query(stmts[idx], function (err) {
    if (err) { callback(err); return; }
    runStatements(client, stmts, idx + 1, callback);
  });
}

// ── Insert functions ──

function insertSensorReadings(ts, temps, callback) {
  var p = getPool();
  var names = ['collector', 'tank_top', 'tank_bottom', 'greenhouse', 'outdoor'];
  var values = [];
  var params = [];
  var paramIdx = 1;

  for (var i = 0; i < names.length; i++) {
    if (temps[names[i]] !== undefined && temps[names[i]] !== null) {
      values.push('($' + paramIdx + ', $' + (paramIdx + 1) + ', $' + (paramIdx + 2) + ')');
      params.push(ts, names[i], temps[names[i]]);
      paramIdx += 3;
    }
  }

  if (values.length === 0) {
    if (callback) callback(null);
    return;
  }

  var sql = 'INSERT INTO sensor_readings (ts, sensor_id, value) VALUES ' + values.join(', ');
  p.query(sql, params, function (err) {
    if (callback) callback(err || null);
  });
}

function insertStateEvent(ts, entityType, entityId, oldValue, newValue, callback) {
  var p = getPool();
  var sql = 'INSERT INTO state_events (ts, entity_type, entity_id, old_value, new_value) VALUES ($1, $2, $3, $4, $5)';
  p.query(sql, [ts, entityType, entityId, oldValue, newValue], function (err) {
    if (callback) callback(err || null);
  });
}

// ── History queries ──

var RANGE_INTERVALS = {
  '1h': '1 hour',
  '6h': '6 hours',
  '24h': '24 hours',
  '48h': '48 hours',
  '7d': '7 days',
  '30d': '30 days',
  '1y': '1 year',
};

function getHistory(range, sensor, callback) {
  var p = getPool();
  var interval = RANGE_INTERVALS[range];
  if (!interval && range !== 'all') {
    callback(new Error('Invalid range: ' + range));
    return;
  }

  // Choose resolution: raw for ≤6h, 30s aggregate for ≥7d, blended for 24h/48h
  var useAggregate = range === '7d' || range === '30d' || range === '1y' || range === 'all';
  var useBlended = range === '24h' || range === '48h';

  var whereTime = range === 'all' ? '' : " WHERE ts > NOW() - INTERVAL '" + interval + "'";
  var whereSensor = sensor ? (whereTime ? ' AND' : ' WHERE') + " sensor_id = '" + sensor + "'" : '';

  var sql;
  if (useAggregate) {
    var aggWhereTime = range === 'all' ? '' : " WHERE bucket > NOW() - INTERVAL '" + interval + "'";
    var aggWhereSensor = sensor ? (aggWhereTime ? ' AND' : ' WHERE') + " sensor_id = '" + sensor + "'" : '';
    sql = 'SELECT bucket AS ts, sensor_id, avg_value AS value FROM sensor_readings_30s' +
      aggWhereTime + aggWhereSensor + ' ORDER BY bucket';
  } else if (useBlended) {
    // Raw for last 6h, aggregate for older
    var rawSql = "SELECT ts, sensor_id, value FROM sensor_readings WHERE ts > NOW() - INTERVAL '6 hours'" +
      (sensor ? " AND sensor_id = '" + sensor + "'" : '');
    var aggSql = "SELECT bucket AS ts, sensor_id, avg_value AS value FROM sensor_readings_30s WHERE bucket <= NOW() - INTERVAL '6 hours' AND bucket > NOW() - INTERVAL '" + interval + "'" +
      (sensor ? " AND sensor_id = '" + sensor + "'" : '');
    sql = '(' + aggSql + ') UNION ALL (' + rawSql + ') ORDER BY ts';
  } else {
    sql = 'SELECT ts, sensor_id, value FROM sensor_readings' + whereTime + whereSensor + ' ORDER BY ts';
  }

  p.query(sql, function (err, result) {
    if (err) { callback(err); return; }

    // Pivot rows into {ts, collector, tank_top, ...} format
    var points = pivotReadings(result.rows);
    callback(null, points);
  });
}

function getEvents(range, entityType, callback) {
  var p = getPool();
  var interval = RANGE_INTERVALS[range];
  var whereTime = (!interval && range !== 'all') ? '' : (range === 'all' ? '' : " WHERE ts > NOW() - INTERVAL '" + interval + "'");
  var whereType = entityType ? (whereTime ? ' AND' : ' WHERE') + " entity_type = '" + entityType + "'" : '';

  var sql = 'SELECT ts, entity_type, entity_id, old_value, new_value FROM state_events' + whereTime + whereType + ' ORDER BY ts';
  p.query(sql, function (err, result) {
    if (err) { callback(err); return; }
    var events = result.rows.map(function (row) {
      return {
        ts: new Date(row.ts).getTime(),
        type: row.entity_type,
        id: row.entity_id,
        from: row.old_value,
        to: row.new_value,
      };
    });
    callback(null, events);
  });
}

function pivotReadings(rows) {
  var buckets = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var ts = new Date(row.ts).getTime();
    if (!buckets[ts]) {
      buckets[ts] = { ts: ts };
    }
    buckets[ts][row.sensor_id] = row.value;
  }

  var keys = Object.keys(buckets).sort(function (a, b) { return a - b; });
  var result = [];
  for (var j = 0; j < keys.length; j++) {
    result.push(buckets[keys[j]]);
  }
  return result;
}

// ── Shutdown ──

function close(callback) {
  if (!pool) { if (callback) callback(); return; }
  pool.end(function (err) {
    pool = null;
    if (callback) callback(err);
  });
}

// ── CLI entry point ──

if (require.main === module) {
  if (process.argv.includes('--init')) {
    resolveUrl(function (err, url) {
      if (!url) {
        console.error('DATABASE_URL not found (checked env and S3)');
        process.exit(1);
      }
      initSchema(function (schemaErr) {
        if (schemaErr) {
          console.error('Schema initialization failed:', schemaErr.message);
          process.exit(1);
        }
        console.log('Schema initialized successfully');
        close(function () { process.exit(0); });
      });
    });
  } else {
    console.error('Usage: node monitor/lib/db.js --init');
    process.exit(1);
  }
}

module.exports = {
  resolveUrl: resolveUrl,
  getPool: getPool,
  initSchema: initSchema,
  startMaintenance: startMaintenance,
  stopMaintenance: stopMaintenance,
  insertSensorReadings: insertSensorReadings,
  insertStateEvent: insertStateEvent,
  getHistory: getHistory,
  getEvents: getEvents,
  close: close,
  _reset: function () { pool = null; resolvedCa = null; stopMaintenance(); },
};
