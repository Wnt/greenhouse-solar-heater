// Postgres / TimescaleDB schema statements + materialized-view
// aggregates used by db.js's initSchema. Extracted so the main
// db.js stays focused on the query API.

const SCHEMA_SQL = [
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

// Pre-aggregated 30-second buckets, used by getHistory for ranges ≥ 24 h.
//
// History: this used to be a regular MATERIALIZED VIEW refreshed by
// `REFRESH MATERIALIZED VIEW CONCURRENTLY sensor_readings_30s`. That
// rebuilt the view from scratch off `sensor_readings`, which is pruned at
// 48 h by runMaintenance — so every refresh discarded all aggregates older
// than 48 h, and the 7d/30d/1y graph paths never had more than two days of
// data to draw. We now keep aggregates in a real (hyper)table and have
// runMaintenance UPSERT new buckets incrementally; old buckets persist
// indefinitely (independent of raw retention).
//
// The DROP MATERIALIZED VIEW migrates existing prod deployments. It runs
// before CREATE TABLE because pg refuses to create a table that collides
// with an existing relation of the same name. CASCADE handles the unique
// index that used to back CONCURRENT refreshes.
const AGGREGATE_SQL = [
  "DROP MATERIALIZED VIEW IF EXISTS sensor_readings_30s CASCADE",

  "CREATE TABLE IF NOT EXISTS sensor_readings_30s (\n" +
  "  bucket    TIMESTAMPTZ NOT NULL,\n" +
  "  sensor_id TEXT        NOT NULL,\n" +
  "  avg_value DOUBLE PRECISION NOT NULL,\n" +
  "  min_value DOUBLE PRECISION NOT NULL,\n" +
  "  max_value DOUBLE PRECISION NOT NULL,\n" +
  "  PRIMARY KEY (bucket, sensor_id)\n" +
  ")",

  // Hypertable for efficient time-range scans. if_not_exists guards against
  // re-runs; migrate_data is unnecessary because the table is empty on
  // first creation (the legacy MATERIALIZED VIEW was just dropped).
  "SELECT create_hypertable('sensor_readings_30s', 'bucket', if_not_exists => true)",

  "CREATE INDEX IF NOT EXISTS sensor_readings_30s_bucket ON sensor_readings_30s (bucket DESC)",
];

module.exports = { SCHEMA_SQL, AGGREGATE_SQL };
