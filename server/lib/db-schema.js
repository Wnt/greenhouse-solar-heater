// Postgres / TimescaleDB schema statements + materialized-view
// aggregates used by db.js's initSchema. Extracted so the main
// db.js stays focused on the query API.

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

  // 2026-04-20: mode transitions now carry a cause tag + a snapshot of
  // sensor readings at transition time. Added as ALTER statements so
  // existing prod deployments upgrade without a full rebuild. Old rows
  // stay NULL; the API maps NULL to null.
  "ALTER TABLE state_events ADD COLUMN IF NOT EXISTS cause TEXT",
  "ALTER TABLE state_events ADD COLUMN IF NOT EXISTS sensors JSONB",
  // 2026-04-21: reason carries the evaluator's finer-grained decision
  // code (solar_stall, freeze_drain, greenhouse_enter, ...) paired with
  // cause. Null for non-evaluator transitions (user_shutdown, forced,
  // drain_complete, failed) and for pre-2026-04-21 rows.
  "ALTER TABLE state_events ADD COLUMN IF NOT EXISTS reason TEXT",

  // Shelly control-script crash log. Written by server/lib/script-monitor.js
  // when the 30-second Script.GetStatus poll first observes running:false
  // with an error payload. error_msg/error_trace come straight from the
  // Shelly RPC; sys_status is the full Sys.GetStatus JSON at crash time;
  // recent_states is the server-side ring buffer of MQTT state snapshots
  // leading up to the crash — this is the piece that makes post-mortem
  // debugging tractable.
  "CREATE TABLE IF NOT EXISTS script_crashes (\n" +
  "  id            BIGSERIAL PRIMARY KEY,\n" +
  "  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n" +
  "  error_msg     TEXT,\n" +
  "  error_trace   TEXT,\n" +
  "  sys_status    JSONB,\n" +
  "  recent_states JSONB,\n" +
  "  resolved_at   TIMESTAMPTZ\n" +
  ")",

  "CREATE INDEX IF NOT EXISTS script_crashes_ts ON script_crashes (ts DESC)",
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

module.exports = { SCHEMA_SQL, AGGREGATE_SQL };
