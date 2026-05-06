// PostgreSQL/TimescaleDB module for sensor readings and state events.
// Connection URL resolves from DATABASE_URL env var, falling back to S3
// (database-url.json) via resolveUrl().
// CLI: node monitor/lib/db.js --init   (creates schema)

const createLogger = require('./logger');
const log = createLogger('db');

let pool = null;
let resolvedUrl = null;
let resolvedCa = null;

function getConnectionUrl() {
  return resolvedUrl || process.env.DATABASE_URL || null;
}

function resolveUrl(callback) {
  const hasEnvUrl = !!process.env.DATABASE_URL;
  if (hasEnvUrl) {
    resolvedUrl = process.env.DATABASE_URL;
  }
  // Always check S3 for the CA cert (and the URL if it's not in env).
  const dbConfig = require('./db-config');
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
  const url = getConnectionUrl();
  if (!url) return null;
  const Pool = require('pg').Pool;
  // pg merges config as Object.assign({}, config, parse(url)) so an
  // sslmode in the URL silently overrides our explicit ssl option;
  // strip it so the CA-cert path below actually wins.
  const cleanUrl = url.replace(/[?&]sslmode=[^&]*/g, '');
  const opts = {
    connectionString: cleanUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    ssl: resolvedCa
      ? { ca: resolvedCa, rejectUnauthorized: true }
      : url.indexOf('sslmode=') !== -1,
  };
  const rawPool = new Pool(opts);
  rawPool.on('error', function (err) {
    log.error('unexpected pool error', { error: err.message });
  });
  // pool.query() requires a params array — schema/maintenance paths
  // that need string-templated SQL must go through pool.connect() →
  // client.query() instead.
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

const { SCHEMA_SQL, AGGREGATE_SQL } = require('./db-schema');
const maintenance = require('./db-maintenance').create(getPool, log);

function initSchema(callback) {
  const p = getPool();
  let client;

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

function runStatements(client, stmts, idx, callback) {
  if (idx >= stmts.length) { callback(null); return; }
  client.query(stmts[idx], function (err) {
    if (err) { callback(err); return; }
    runStatements(client, stmts, idx + 1, callback);
  });
}

// ── Insert functions ──

function insertSensorReadings(ts, temps, callback) {
  const p = getPool();
  const names = ['collector', 'tank_top', 'tank_bottom', 'greenhouse', 'outdoor'];
  const values = [];
  const params = [];
  let paramIdx = 1;

  for (let i = 0; i < names.length; i++) {
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

  const sql = 'INSERT INTO sensor_readings (ts, sensor_id, value) VALUES ' + values.join(', ');
  p.query(sql, params, function (err) {
    if (callback) callback(err || null);
  });
}

// opts = {cause, reason, sensors} carries mode-transition context for
// state_events rows that need it. Valve/actuator writes pass no opts
// and end up with NULLs there.
function insertStateEvent(ts, entityType, entityId, oldValue, newValue, optsOrCallback, maybeCallback) {
  const p = getPool();
  let opts, callback;
  if (typeof optsOrCallback === 'function') {
    opts = null;
    callback = optsOrCallback;
  } else {
    opts = optsOrCallback || null;
    callback = maybeCallback;
  }
  const cause = opts && opts.cause !== undefined ? opts.cause : null;
  const reason = opts && opts.reason !== undefined ? opts.reason : null;
  const sensors = opts && opts.sensors !== undefined ? opts.sensors : null;
  const sql = 'INSERT INTO state_events (ts, entity_type, entity_id, old_value, new_value, cause, reason, sensors) ' +
            'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)';
  p.query(sql, [ts, entityType, entityId, oldValue, newValue, cause, reason, sensors], function (err) {
    if (callback) callback(err || null);
  });
}

// One row per wb/mo/ea delta — see db-schema.js for column semantics.
// The System Logs view interleaves these with mode transitions.
function insertConfigEvent(row, callback) {
  const p = getPool();
  const sql = 'INSERT INTO config_events (ts, kind, key, old_value, new_value, source, actor) ' +
              'VALUES ($1, $2, $3, $4, $5, $6, $7)';
  const params = [
    row.ts || new Date(),
    row.kind,
    row.key || null,
    row.old_value === undefined ? null : row.old_value,
    row.new_value === undefined ? null : row.new_value,
    row.source,
    row.actor || null,
  ];
  p.query(sql, params, function (err) {
    if (callback) callback(err || null);
  });
}

// Newest-first cursor pagination (limit ≤ 100, before = Unix-ms cursor).
function getConfigEventsPaginated(limit, before, callback) {
  const p = getPool();
  const cap = 100;
  const effLimit = Math.max(1, Math.min(cap, parseInt(limit, 10) || 10));
  const fetchLimit = effLimit + 1;

  const params = [];
  let sql = 'SELECT ts, kind, key, old_value, new_value, source, actor FROM config_events';
  if (before !== null && before !== undefined) {
    params.push(new Date(before));
    sql += ' WHERE ts < $' + params.length;
  }
  params.push(fetchLimit);
  sql += ' ORDER BY ts DESC LIMIT $' + params.length;

  p.query(sql, params, function (err, result) {
    if (err) { callback(err); return; }
    let rows = result.rows;
    const hasMore = rows.length > effLimit;
    if (hasMore) rows = rows.slice(0, effLimit);
    const events = rows.map(function (row) {
      return {
        ts: new Date(row.ts).getTime(),
        type: 'config',
        kind: row.kind,
        key: row.key,
        from: row.old_value,
        to: row.new_value,
        source: row.source,
        actor: row.actor,
      };
    });
    callback(null, { events, hasMore });
  });
}

// ── History queries ──

const RANGE_INTERVALS = {
  '1h': '1 hour',
  '6h': '6 hours',
  '12h': '12 hours',
  '24h': '24 hours',
  '48h': '48 hours',
  '3d': '3 days',
  '7d': '7 days',
  '14d': '14 days',
  '1mo': '1 month',
  '30d': '30 days',
  '2mo': '2 months',
  '4mo': '4 months',
  '1y': '1 year',
};

// SQL fragments interpolated into time_bucket() — must stay constant
// (never user input) since we string-concat them. Re-buckets the 30 s
// aggregate so 7 d / 30 d / 1 y views stay under the client's point
// cap. `all` is intentionally absent — pg-mem has no time_bucket().
const COARSE_BUCKETS = {
  '3d': '2 minutes',
  '7d': '5 minutes',
  '14d': '10 minutes',
  '1mo': '30 minutes',
  '30d': '30 minutes',
  '2mo': '1 hour',
  '4mo': '2 hours',
  '1y': '6 hours',
};

function getHistory(range, sensor, callback) {
  const p = getPool();
  const interval = RANGE_INTERVALS[range];
  if (!interval && range !== 'all') {
    callback(new Error('Invalid range: ' + range));
    return;
  }

  // Raw for ≤6h, 30s aggregate for ≥3d (raw is pruned at 48h), blended for 24h/48h.
  const useAggregate = range === '3d' || range === '7d' || range === '14d'
    || range === '1mo' || range === '30d' || range === '2mo'
    || range === '4mo' || range === '1y' || range === 'all';
  const useBlended = range === '24h' || range === '48h';

  const params = [];
  let paramIdx = 1;
  let sql;

  if (useAggregate) {
    const aggWhereTime = range === 'all' ? '' : " WHERE bucket > NOW() - INTERVAL '" + interval + "'";
    let aggWhereSensor = '';
    if (sensor) {
      aggWhereSensor = (aggWhereTime ? ' AND' : ' WHERE') + ' sensor_id = $' + paramIdx;
      params.push(sensor);
    }
    const coarse = COARSE_BUCKETS[range];
    if (coarse) {
      sql = "SELECT time_bucket('" + coarse + "', bucket) AS ts, sensor_id," +
        " AVG(avg_value) AS value FROM sensor_readings_30s" +
        aggWhereTime + aggWhereSensor +
        ' GROUP BY ts, sensor_id ORDER BY ts';
    } else {
      sql = 'SELECT bucket AS ts, sensor_id, avg_value AS value FROM sensor_readings_30s' +
        aggWhereTime + aggWhereSensor + ' ORDER BY bucket';
    }
  } else if (useBlended) {
    // Raw for last 6h, aggregate for older. Sensor param appears in both sub-queries.
    let rawSensorClause = '';
    let aggSensorClause = '';
    if (sensor) {
      aggSensorClause = ' AND sensor_id = $' + paramIdx;
      params.push(sensor);
      paramIdx++;
      rawSensorClause = ' AND sensor_id = $' + paramIdx;
      params.push(sensor);
    }
    const rawSql = "SELECT ts, sensor_id, value FROM sensor_readings WHERE ts > NOW() - INTERVAL '6 hours'" +
      rawSensorClause;
    const aggSql = "SELECT bucket AS ts, sensor_id, avg_value AS value FROM sensor_readings_30s WHERE bucket <= NOW() - INTERVAL '6 hours' AND bucket > NOW() - INTERVAL '" + interval + "'" +
      aggSensorClause;
    sql = '(' + aggSql + ') UNION ALL (' + rawSql + ') ORDER BY ts';
  } else {
    const whereTime = range === 'all' ? '' : " WHERE ts > NOW() - INTERVAL '" + interval + "'";
    let whereSensor = '';
    if (sensor) {
      whereSensor = (whereTime ? ' AND' : ' WHERE') + ' sensor_id = $' + paramIdx;
      params.push(sensor);
      paramIdx++;
    }
    // Raw window data (rows inside the range).
    const windowSql = 'SELECT ts, sensor_id, value FROM sensor_readings' + whereTime + whereSensor;

    if (range === 'all') {
      sql = windowSql + ' ORDER BY ts';
    } else {
      // Last reading BEFORE the window per sensor — the line renderer
      // joins it to the first in-window point so a wide gap (e.g.
      // 11:18 → 11:33) doesn't leave the chart's left side blank.
      const leadingSensorClause = sensor
        ? ' AND sensor_id = $' + paramIdx
        : '';
      if (sensor) {
        params.push(sensor);
      }
      const leadingSql = "SELECT DISTINCT ON (sensor_id) ts, sensor_id, value" +
        " FROM sensor_readings" +
        " WHERE ts <= NOW() - INTERVAL '" + interval + "'" + leadingSensorClause +
        " ORDER BY sensor_id, ts DESC";
      sql = '(' + leadingSql + ') UNION ALL (' + windowSql + ') ORDER BY ts';
    }
  }

  p.query(sql, params, function (err, result) {
    if (err) { callback(err); return; }

    // Pivot rows into {ts, collector, tank_top, ...} format
    const points = pivotReadings(result.rows);
    callback(null, points);
  });
}

// Newest-first cursor pagination over state_events.
// entityType: 'mode' / 'valve' / 'actuator'. limit ≤ 100.
function getEventsPaginated(entityType, limit, before, callback) {
  const p = getPool();
  const cap = 100;
  const effLimit = Math.max(1, Math.min(cap, parseInt(limit, 10) || 10));
  // limit+1 lets us detect whether older rows exist for hasMore.
  const fetchLimit = effLimit + 1;

  const params = [entityType];
  let sql = 'SELECT ts, entity_type, entity_id, old_value, new_value, cause, reason, sensors FROM state_events WHERE entity_type = $1';
  if (before !== null && before !== undefined) {
    params.push(new Date(before));
    sql += ' AND ts < $' + params.length;
  }
  params.push(fetchLimit);
  sql += ' ORDER BY ts DESC LIMIT $' + params.length;

  p.query(sql, params, function (err, result) {
    if (err) { callback(err); return; }
    let rows = result.rows;
    const hasMore = rows.length > effLimit;
    if (hasMore) rows = rows.slice(0, effLimit);
    const events = rows.map(function (row) {
      return {
        ts: new Date(row.ts).getTime(),
        type: row.entity_type,
        id: row.entity_id,
        from: row.old_value,
        to: row.new_value,
        cause: row.cause,
        reason: row.reason,
        sensors: row.sensors,
      };
    });
    callback(null, { events, hasMore });
  });
}

// getEvents(range, entityType, [entityId,] callback). entityId narrows
// to a single entity (e.g. just `space_heater`) for the /api/history
// EMERGENCY-band feed.
function getEvents(range, entityType, entityIdOrCallback, maybeCallback) {
  const entityId = typeof entityIdOrCallback === 'function' ? null : (entityIdOrCallback || null);
  const callback = typeof entityIdOrCallback === 'function' ? entityIdOrCallback : maybeCallback;

  const p = getPool();
  const interval = RANGE_INTERVALS[range];
  const hasWindow = !!interval && range !== 'all';
  const whereTime = hasWindow ? " WHERE ts > NOW() - INTERVAL '" + interval + "'" : '';

  const params = [];
  let filter = '';
  const addClause = (col, val) => {
    if (!val) return;
    filter += (whereTime || filter ? ' AND' : ' WHERE') + ' ' + col + ' = $' + (params.length + 1);
    params.push(val);
  };
  addClause('entity_type', entityType);
  addClause('entity_id', entityId);

  const cols = 'ts, entity_type, entity_id, old_value, new_value';
  const windowSql = 'SELECT ' + cols + ' FROM state_events' + whereTime + filter;

  // Leading edge: the single most recent event from before the window.
  // Without it the client can't resolve "what mode was active at
  // window-start" and defaults to idle, mislabelling the bar chart and
  // clipboard table.
  let sql;
  if (hasWindow) {
    // Same filter clauses but anchored to the pre-window range.
    const leading = filter.replace(/^ WHERE/, ' AND');
    const leadingSql = 'SELECT ' + cols + ' FROM state_events' +
      " WHERE ts <= NOW() - INTERVAL '" + interval + "'" + leading +
      ' ORDER BY ts DESC LIMIT 1';
    sql = '(' + leadingSql + ') UNION ALL (' + windowSql + ') ORDER BY ts';
  } else {
    sql = windowSql + ' ORDER BY ts';
  }
  p.query(sql, params, function (err, result) {
    if (err) { callback(err); return; }
    const events = result.rows.map(function (row) {
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

// Postgres-only: crashes are rare and worth a durable record. When the
// DB is down, script-monitor keeps an in-process ring buffer so the WS
// layer still surfaces the crash.
function insertScriptCrash(row, callback) {
  const p = getPool();
  if (!p) { callback(new Error('no_db')); return; }
  const sql = 'INSERT INTO script_crashes (ts, error_msg, error_trace, sys_status, recent_states) ' +
            'VALUES ($1, $2, $3, $4, $5) RETURNING id';
  const params = [
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
  const p = getPool();
  if (!p) { callback(null, []); return; }
  const effLimit = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const sql = 'SELECT id, ts, error_msg, resolved_at FROM script_crashes ' +
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
  const p = getPool();
  if (!p) { callback(new Error('no_db')); return; }
  const parsed = parseInt(id, 10);
  if (!parsed || parsed <= 0) { callback(null, null); return; }
  const sql = 'SELECT id, ts, error_msg, error_trace, sys_status, recent_states, resolved_at ' +
            'FROM script_crashes WHERE id = $1';
  p.query(sql, [parsed], function (err, result) {
    if (err) { callback(err); return; }
    const r = result.rows[0];
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
  const p = getPool();
  if (!p) { callback(new Error('no_db')); return; }
  const parsed = parseInt(id, 10);
  if (!parsed || parsed <= 0) { callback(null, false); return; }
  const sql = 'UPDATE script_crashes SET resolved_at = NOW() WHERE id = $1 AND resolved_at IS NULL';
  p.query(sql, [parsed], function (err, result) {
    if (err) { callback(err); return; }
    callback(null, (result && result.rowCount) ? result.rowCount > 0 : false);
  });
}

function pivotReadings(rows) {
  const buckets = {};
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const ts = new Date(row.ts).getTime();
    if (!buckets[ts]) {
      buckets[ts] = { ts };
    }
    buckets[ts][row.sensor_id] = row.value;
  }

  const keys = Object.keys(buckets).sort(function (a, b) { return a - b; });
  const result = [];
  for (let j = 0; j < keys.length; j++) {
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
  resolveUrl,
  getPool,
  initSchema,
  startMaintenance: maintenance.start,
  stopMaintenance: maintenance.stop,
  insertSensorReadings,
  insertStateEvent,
  insertConfigEvent,
  getConfigEventsPaginated,
  insertScriptCrash,
  listScriptCrashes,
  getScriptCrash,
  resolveScriptCrash,
  getHistory,
  getEvents,
  getEventsPaginated,
  close,
  _reset: function () { pool = null; resolvedCa = null; maintenance.stop(); },
  _runMaintenanceForTest: maintenance.run,
};
