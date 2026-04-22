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
  var rawPool = new Pool(opts);
  rawPool.on('error', function (err) {
    log.error('unexpected pool error', { error: err.message });
  });
  // Safe wrapper: pool.query() requires a params array to prevent SQL injection.
  // Schema/maintenance queries use pool.connect() → client.query() which bypasses this.
  pool = {
    query: function safeQuery(sql, params, cb) {
      if (typeof params === 'function') {
        throw new Error('pool.query() requires a params array — use [] for no parameters');
      }
      if (!Array.isArray(params)) {
        throw new Error('pool.query() params must be an array, got ' + typeof params);
      }
      return rawPool.query(sql, params, cb);
    },
    connect: function (cb) { return rawPool.connect(cb); },
    on: function (ev, fn) { return rawPool.on(ev, fn); },
    end: function (cb) { return rawPool.end(cb); },
  };
  return pool;
}

var { SCHEMA_SQL, AGGREGATE_SQL } = require('./db-schema');

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

  p.query('REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_30s', [], function (err) {
    if (err) {
      log.warn('materialized view refresh failed', { error: err.message });
    } else {
      log.info('materialized view refreshed');
    }

    p.query("DELETE FROM sensor_readings WHERE ts < NOW() - INTERVAL '" + RETENTION_INTERVAL + "'", [], function (err2) {
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

// Signature accepts an optional opts object {cause, reason, sensors} so
// mode rows can carry transition context (what triggered the change,
// the evaluator's decision code, and the sensor snapshot at transition
// time). Valve/actuator writes omit opts and store NULL in those
// columns. Positional signature preserved for callers that don't need
// the extension.
function insertStateEvent(ts, entityType, entityId, oldValue, newValue, optsOrCallback, maybeCallback) {
  var p = getPool();
  var opts, callback;
  if (typeof optsOrCallback === 'function') {
    opts = null;
    callback = optsOrCallback;
  } else {
    opts = optsOrCallback || null;
    callback = maybeCallback;
  }
  var cause = opts && opts.cause !== undefined ? opts.cause : null;
  var reason = opts && opts.reason !== undefined ? opts.reason : null;
  var sensors = opts && opts.sensors !== undefined ? opts.sensors : null;
  var sql = 'INSERT INTO state_events (ts, entity_type, entity_id, old_value, new_value, cause, reason, sensors) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
  p.query(sql, [ts, entityType, entityId, oldValue, newValue, cause, reason, sensors], function (err) {
    if (callback) callback(err || null);
  });
}

// ── History queries ──

var RANGE_INTERVALS = {
  '1h': '1 hour',
  '6h': '6 hours',
  '12h': '12 hours',
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

  var params = [];
  var paramIdx = 1;
  var sql;

  if (useAggregate) {
    var aggWhereTime = range === 'all' ? '' : " WHERE bucket > NOW() - INTERVAL '" + interval + "'";
    var aggWhereSensor = '';
    if (sensor) {
      aggWhereSensor = (aggWhereTime ? ' AND' : ' WHERE') + ' sensor_id = $' + paramIdx;
      params.push(sensor);
      paramIdx++;
    }
    sql = 'SELECT bucket AS ts, sensor_id, avg_value AS value FROM sensor_readings_30s' +
      aggWhereTime + aggWhereSensor + ' ORDER BY bucket';
  } else if (useBlended) {
    // Raw for last 6h, aggregate for older. Sensor param appears in both sub-queries.
    var rawSensorClause = '';
    var aggSensorClause = '';
    if (sensor) {
      aggSensorClause = ' AND sensor_id = $' + paramIdx;
      params.push(sensor);
      paramIdx++;
      rawSensorClause = ' AND sensor_id = $' + paramIdx;
      params.push(sensor);
      paramIdx++;
    }
    var rawSql = "SELECT ts, sensor_id, value FROM sensor_readings WHERE ts > NOW() - INTERVAL '6 hours'" +
      rawSensorClause;
    var aggSql = "SELECT bucket AS ts, sensor_id, avg_value AS value FROM sensor_readings_30s WHERE bucket <= NOW() - INTERVAL '6 hours' AND bucket > NOW() - INTERVAL '" + interval + "'" +
      aggSensorClause;
    sql = '(' + aggSql + ') UNION ALL (' + rawSql + ') ORDER BY ts';
  } else {
    var whereTime = range === 'all' ? '' : " WHERE ts > NOW() - INTERVAL '" + interval + "'";
    var whereSensor = '';
    if (sensor) {
      whereSensor = (whereTime ? ' AND' : ' WHERE') + ' sensor_id = $' + paramIdx;
      params.push(sensor);
      paramIdx++;
    }
    // Raw window data (rows inside the range).
    var windowSql = 'SELECT ts, sensor_id, value FROM sensor_readings' + whereTime + whereSensor;

    if (range === 'all') {
      sql = windowSql + ' ORDER BY ts';
    } else {
      // Leading-edge row per sensor: the last reading BEFORE the window
      // starts. Without this, a gap between the last pre-window reading
      // (e.g. at 11:18) and the first in-window reading (e.g. at 11:33)
      // leaves the chart's left side blank. The client's line renderer
      // connects these leading-edge points across the window boundary,
      // visually interpolating through the gap.
      var leadingSensorClause = sensor
        ? ' AND sensor_id = $' + paramIdx
        : '';
      if (sensor) {
        params.push(sensor);
        paramIdx++;
      }
      var leadingSql = "SELECT DISTINCT ON (sensor_id) ts, sensor_id, value" +
        " FROM sensor_readings" +
        " WHERE ts <= NOW() - INTERVAL '" + interval + "'" + leadingSensorClause +
        " ORDER BY sensor_id, ts DESC";
      sql = '(' + leadingSql + ') UNION ALL (' + windowSql + ') ORDER BY ts';
    }
  }

  p.query(sql, params, function (err, result) {
    if (err) { callback(err); return; }

    // Pivot rows into {ts, collector, tank_top, ...} format
    var points = pivotReadings(result.rows);
    callback(null, points);
  });
}

// Paginated newest-first query for state_events, with a cursor for
// infinite-scroll UIs. Returns { events, hasMore } where `hasMore` is true
// if at least one row exists older than the oldest returned row.
//
//   entityType — required (e.g. 'mode', 'valve', 'actuator')
//   limit      — capped at 100
//   before     — optional Unix ms cursor; returns rows with ts < before
function getEventsPaginated(entityType, limit, before, callback) {
  var p = getPool();
  var cap = 100;
  var effLimit = Math.max(1, Math.min(cap, parseInt(limit, 10) || 10));
  // Query limit+1 so we can detect whether more rows exist beyond this page.
  var fetchLimit = effLimit + 1;

  var params = [entityType];
  var sql = 'SELECT ts, entity_type, entity_id, old_value, new_value, cause, reason, sensors FROM state_events WHERE entity_type = $1';
  if (before !== null && before !== undefined) {
    params.push(new Date(before));
    sql += ' AND ts < $' + params.length;
  }
  params.push(fetchLimit);
  sql += ' ORDER BY ts DESC LIMIT $' + params.length;

  p.query(sql, params, function (err, result) {
    if (err) { callback(err); return; }
    var rows = result.rows;
    var hasMore = rows.length > effLimit;
    if (hasMore) rows = rows.slice(0, effLimit);
    var events = rows.map(function (row) {
      return {
        ts: new Date(row.ts).getTime(),
        type: row.entity_type,
        id: row.entity_id,
        from: row.old_value,
        to: row.new_value,
        // cause / sensors populated only for mode rows written after
        // 2026-04-20; reason added 2026-04-21. Older rows and
        // valve/actuator rows carry null.
        cause: row.cause,
        reason: row.reason,
        sensors: row.sensors,
      };
    });
    callback(null, { events: events, hasMore: hasMore });
  });
}

function getEvents(range, entityType, callback) {
  var p = getPool();
  var interval = RANGE_INTERVALS[range];
  var whereTime = (!interval && range !== 'all') ? '' : (range === 'all' ? '' : " WHERE ts > NOW() - INTERVAL '" + interval + "'");

  var params = [];
  var whereType = '';
  if (entityType) {
    whereType = (whereTime ? ' AND' : ' WHERE') + ' entity_type = $1';
    params.push(entityType);
  }

  var sql = 'SELECT ts, entity_type, entity_id, old_value, new_value FROM state_events' + whereTime + whereType + ' ORDER BY ts';
  p.query(sql, params, function (err, result) {
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

// ── Script crash log ──
//
// Writers go through insertScriptCrash; the UI reads via listScriptCrashes
// / getScriptCrash. Postgres-only: crashes are rare and we prefer a real
// record over an ephemeral ring buffer. If the DB is down when a crash
// fires, script-monitor logs the drop and keeps the crash in memory on
// its own in-process ring buffer for the WS layer.
function insertScriptCrash(row, callback) {
  var p = getPool();
  if (!p) { callback(new Error('no_db')); return; }
  var sql = 'INSERT INTO script_crashes (ts, error_msg, error_trace, sys_status, recent_states) ' +
            'VALUES ($1, $2, $3, $4, $5) RETURNING id';
  var params = [
    row.ts || new Date(),
    row.error_msg || null,
    row.error_trace || null,
    row.sys_status ? JSON.stringify(row.sys_status) : null,
    row.recent_states ? JSON.stringify(row.recent_states) : null,
  ];
  p.query(sql, params, function (err, result) {
    if (err) { callback(err); return; }
    callback(null, result.rows[0].id);
  });
}

function listScriptCrashes(limit, callback) {
  var p = getPool();
  if (!p) { callback(null, []); return; }
  var effLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  var sql = 'SELECT id, ts, error_msg, resolved_at FROM script_crashes ' +
            'ORDER BY ts DESC LIMIT $1';
  p.query(sql, [effLimit], function (err, result) {
    if (err) { callback(err); return; }
    callback(null, result.rows.map(function (r) {
      return {
        id: r.id,
        ts: new Date(r.ts).getTime(),
        error_msg: r.error_msg,
        resolved_at: r.resolved_at ? new Date(r.resolved_at).getTime() : null,
      };
    }));
  });
}

function getScriptCrash(id, callback) {
  var p = getPool();
  if (!p) { callback(new Error('no_db')); return; }
  var parsed = parseInt(id, 10);
  if (!parsed || parsed <= 0) { callback(null, null); return; }
  var sql = 'SELECT id, ts, error_msg, error_trace, sys_status, recent_states, resolved_at ' +
            'FROM script_crashes WHERE id = $1';
  p.query(sql, [parsed], function (err, result) {
    if (err) { callback(err); return; }
    var r = result.rows[0];
    if (!r) { callback(null, null); return; }
    callback(null, {
      id: r.id,
      ts: new Date(r.ts).getTime(),
      error_msg: r.error_msg,
      error_trace: r.error_trace,
      sys_status: r.sys_status,
      recent_states: r.recent_states,
      resolved_at: r.resolved_at ? new Date(r.resolved_at).getTime() : null,
    });
  });
}

function resolveScriptCrash(id, callback) {
  var p = getPool();
  if (!p) { callback(new Error('no_db')); return; }
  var parsed = parseInt(id, 10);
  if (!parsed || parsed <= 0) { callback(null, false); return; }
  var sql = 'UPDATE script_crashes SET resolved_at = NOW() WHERE id = $1 AND resolved_at IS NULL';
  p.query(sql, [parsed], function (err, result) {
    if (err) { callback(err); return; }
    callback(null, (result && result.rowCount) ? result.rowCount > 0 : false);
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
  insertScriptCrash: insertScriptCrash,
  listScriptCrashes: listScriptCrashes,
  getScriptCrash: getScriptCrash,
  resolveScriptCrash: resolveScriptCrash,
  getHistory: getHistory,
  getEvents: getEvents,
  getEventsPaginated: getEventsPaginated,
  close: close,
  _reset: function () { pool = null; resolvedCa = null; stopMaintenance(); },
};
