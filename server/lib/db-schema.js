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

  // Routine-fire log. Each row = one POST to the Claude incident-response
  // routine's /fire endpoint, i.e. one routine run — a daily-capped
  // subscription resource. routine-trigger.js reads the rolling-24h count
  // to enforce a DURABLE daily budget that survives pod restarts; an
  // in-process counter would reset on exactly the crash-loops that fire.
  "CREATE TABLE IF NOT EXISTS routine_fires (\n" +
  "  id   BIGSERIAL PRIMARY KEY,\n" +
  "  ts   TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n" +
  "  kind TEXT\n" +
  ")",

  "CREATE INDEX IF NOT EXISTS routine_fires_ts ON routine_fires (ts DESC)",

  // Config-mutation events. Captures every wb (mode-ban) and mo (manual-
  // override) change so the System Logs view can render an audit trail
  // alongside mode transitions. Sources:
  //   'api'           — PUT /api/device-config (mode-enablement UI, etc.)
  //   'ws_override'   — WS override-enter/exit/update (refill, drain)
  //   'watchdog_auto' — device-side auto-shutdown after watchdog fired,
  //                     surfaced via the watchdog "resolved" MQTT event
  //   'watchdog_user' — user-acknowledged watchdog shutdown via banner
  // For wb events, `key` is the mode short code (SC/GH/AD/EH/I); for mo
  // events `key` is null (the mo field has only one slot per device).
  // old_value / new_value carry the raw value as a string: unix-sec
  // timestamp for wb, JSON for mo, null = absent. `actor` is the
  // username for human actions or 'device' for watchdog_auto.
  "CREATE TABLE IF NOT EXISTS config_events (\n" +
  "  ts        TIMESTAMPTZ NOT NULL,\n" +
  "  kind      TEXT        NOT NULL,\n" +
  "  key       TEXT,\n" +
  "  old_value TEXT,\n" +
  "  new_value TEXT,\n" +
  "  source    TEXT        NOT NULL,\n" +
  "  actor     TEXT\n" +
  ")",

  "SELECT create_hypertable('config_events', 'ts', if_not_exists => true)",

  "CREATE INDEX IF NOT EXISTS config_events_ts ON config_events (ts DESC)",

  "CREATE TABLE IF NOT EXISTS weather_forecasts (\n" +
  "  fetched_at        TIMESTAMPTZ        NOT NULL,\n" +
  "  valid_at          TIMESTAMPTZ        NOT NULL,\n" +
  "  temperature       DOUBLE PRECISION,\n" +
  "  radiation_global  DOUBLE PRECISION,\n" +
  "  wind_speed        DOUBLE PRECISION,\n" +
  "  precipitation     DOUBLE PRECISION,\n" +
  "  PRIMARY KEY (fetched_at, valid_at)\n" +
  ")",

  "SELECT create_hypertable('weather_forecasts', 'valid_at', if_not_exists => true)",

  // 2026-05-08: enrich the forecast row with the rest of the HARMONIE
  // simple-stored-query parameters. cloud_cover replaces the radiation-
  // derived cloud factor; humidity/dew_point feed an upcoming greenhouse
  // moisture model; wind_gust + pressure are kept for future fits.
  // ALTER TABLE … ADD COLUMN IF NOT EXISTS is idempotent — pre-existing
  // prod rows get NULLs in the new columns until the next FMI refresh.
  "ALTER TABLE weather_forecasts ADD COLUMN IF NOT EXISTS humidity         DOUBLE PRECISION",
  "ALTER TABLE weather_forecasts ADD COLUMN IF NOT EXISTS dew_point        DOUBLE PRECISION",
  "ALTER TABLE weather_forecasts ADD COLUMN IF NOT EXISTS cloud_cover      DOUBLE PRECISION",
  "ALTER TABLE weather_forecasts ADD COLUMN IF NOT EXISTS wind_gust        DOUBLE PRECISION",
  "ALTER TABLE weather_forecasts ADD COLUMN IF NOT EXISTS pressure         DOUBLE PRECISION",

  "CREATE INDEX IF NOT EXISTS weather_forecasts_valid_at ON weather_forecasts (valid_at DESC)",

  "CREATE TABLE IF NOT EXISTS spot_prices (\n" +
  "  fetched_at  TIMESTAMPTZ        NOT NULL,\n" +
  "  valid_at    TIMESTAMPTZ        NOT NULL,\n" +
  "  source      TEXT               NOT NULL,\n" +
  "  price_c_kwh DOUBLE PRECISION   NOT NULL,\n" +
  "  PRIMARY KEY (valid_at, source)\n" +
  ")",

  "SELECT create_hypertable('spot_prices', 'valid_at', if_not_exists => true)",

  "CREATE INDEX IF NOT EXISTS spot_prices_valid_at ON spot_prices (valid_at DESC)",

  // Captured forecast predictions — one row per (engine, generated_at,
  // horizon_h) tuple, written in batches of 48 per engine by the HH:30
  // scheduler so the full 48 h forecast trajectory is auditable against
  // future ground truth.
  //
  // Replaces the pre-2026-05-08 single-row-per-for_hour layout, which
  // only kept the +1 h projection — useless for verifying the 48 h
  // trajectory the user actually reads on the forecast graph. Schema
  // migration is JS-side (db.js initSchema): detects the legacy shape
  // by absence of horizon_h and DROPs the table so the CREATE below
  // takes over. Idempotent — once horizon_h exists, the migration is a
  // no-op.
  //
  // 2026-07-24: engine discriminator added (findings doc
  // design/docs/ml-mode-forecast-findings.md, recommendation #2): the
  // ML engine is the UI default yet only the physics engine's forecasts
  // were captured, so ML tuning decisions rested on offline backtests
  // alone. Existing prod tables are migrated JS-side too — see
  // migrateForecastPredictionsEnginePk below.
  "CREATE TABLE IF NOT EXISTS forecast_predictions (\n" +
  "  engine              TEXT        NOT NULL DEFAULT 'physics',\n" +
  "  generated_at        TIMESTAMPTZ NOT NULL,\n" +
  "  horizon_h           SMALLINT    NOT NULL,\n" +
  "  for_hour            TIMESTAMPTZ NOT NULL,\n" +
  "  mode                TEXT        NOT NULL,\n" +
  "  has_solar_overlay   BOOLEAN     NOT NULL DEFAULT FALSE,\n" +
  "  duty                DOUBLE PRECISION,\n" +
  "  tank_top_c          DOUBLE PRECISION,\n" +
  "  tank_bottom_c       DOUBLE PRECISION,\n" +
  "  tank_avg_c          DOUBLE PRECISION,\n" +
  "  greenhouse_c        DOUBLE PRECISION,\n" +
  "  pred_solar_gain_kwh    DOUBLE PRECISION,\n" +
  "  pred_rad_delivered_w   DOUBLE PRECISION,\n" +
  "  pred_heater_kwh        DOUBLE PRECISION,\n" +
  "  pred_tank_loss_w       DOUBLE PRECISION,\n" +
  "  pred_cloud_factor      DOUBLE PRECISION,\n" +
  "  outdoor_c           DOUBLE PRECISION,\n" +
  "  radiation_w_m2      DOUBLE PRECISION,\n" +
  "  wind_speed_m_s      DOUBLE PRECISION,\n" +
  "  precipitation_mm    DOUBLE PRECISION,\n" +
  "  price_c_kwh         DOUBLE PRECISION,\n" +
  // Algorithm version — sha256[:8] of forecast/* + extra sources.
  "  algorithm_version   TEXT,\n" +
  // Live tuning overrides (geT/gxT/ehE/…) and fitted coefficients used
  // by this generation. Stored as JSONB so the schema doesn't have to
  // chase every new fit parameter — a tuning analysis just unpacks the
  // JSON.
  "  tu                  JSONB,\n" +
  "  coefficients        JSONB,\n" +
  "  PRIMARY KEY (engine, generated_at, horizon_h)\n" +
  ")",

  "SELECT create_hypertable('forecast_predictions', 'generated_at', if_not_exists => true)",

  "CREATE INDEX IF NOT EXISTS forecast_predictions_for_hour ON forecast_predictions (for_hour DESC)",
  "CREATE INDEX IF NOT EXISTS forecast_predictions_horizon ON forecast_predictions (horizon_h, generated_at DESC)",
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

// Drop pre-2026-05-08 forecast_predictions (single PK on for_hour) so
// the SCHEMA_SQL CREATE recreates it with the (generated_at, horizon_h)
// PK. Idempotent — no-op once horizon_h exists. Lives here next to the
// SCHEMA_SQL it migrates so any future shape change touches one file.
// Once the current shape is confirmed, chains into the 2026-07-24
// engine-PK migration below (same idempotent-probe pattern).
function migrateLegacyForecastPredictions(client, log, callback) {
  const TBL = "table_schema='public' AND table_name='forecast_predictions'";
  client.query("SELECT 1 AS x FROM information_schema.tables WHERE " + TBL,
    function (err, exists) {
      if (err || !exists.rows || exists.rows.length === 0) { callback(null); return; }
      client.query("SELECT 1 AS x FROM information_schema.columns WHERE " + TBL + " AND column_name='horizon_h'",
        function (cErr, hasCol) {
          if (cErr) { callback(null); return; }
          if (!hasCol.rows || hasCol.rows.length === 0) {
            log.info('forecast_predictions: dropping legacy shape for horizon_h migration');
            client.query('DROP TABLE forecast_predictions', callback);
            return;
          }
          migrateForecastPredictionsEnginePk(client, log, callback);
        });
    });
}

// True when the primary key's column list lacks the engine
// discriminator, i.e. the (generated_at, horizon_h) shape that predates
// dual-engine capture. Pure so the probe decision is unit-testable.
function pkNeedsEngineMigration(pkColumns) {
  if (!Array.isArray(pkColumns) || pkColumns.length === 0) return true;
  return pkColumns.indexOf('engine') === -1;
}

// 2026-07-24 dual-engine capture migration: add the engine column and
// widen the PK to (engine, generated_at, horizon_h). Runs on every boot;
// no-op once the PK already carries engine. Data is preserved (existing
// rows default to engine='physics', which is what wrote them). Probe
// failures are non-fatal, matching the legacy-shape probe above — the
// SCHEMA_SQL CREATE covers fresh installs regardless. PREVIEW_MODE
// never reaches this (schema init is skipped there); prod picks it up
// on the next deploy boot. TimescaleDB allows the PK swap because the
// new key still includes the partitioning column (generated_at).
function migrateForecastPredictionsEnginePk(client, log, callback) {
  const PK_SQL =
    "SELECT tc.constraint_name, kcu.column_name " +
    "FROM information_schema.table_constraints tc " +
    "JOIN information_schema.key_column_usage kcu " +
    "  ON kcu.constraint_name = tc.constraint_name AND kcu.table_name = tc.table_name " +
    "WHERE tc.table_schema='public' AND tc.table_name='forecast_predictions' AND tc.constraint_type='PRIMARY KEY' " +
    "ORDER BY kcu.ordinal_position";
  client.query(PK_SQL, function (err, pk) {
    if (err) { callback(null); return; }
    const rows = (pk && pk.rows) || [];
    if (!pkNeedsEngineMigration(rows.map(function (r) { return r.column_name; }))) {
      callback(null);
      return;
    }
    log.info('forecast_predictions: migrating primary key to (engine, generated_at, horizon_h)');
    client.query(
      "ALTER TABLE forecast_predictions ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'physics'",
      function (aErr) {
        if (aErr) { callback(aErr); return; }
        const pkName = rows.length > 0 ? rows[0].constraint_name : null;
        function addPk() {
          client.query(
            'ALTER TABLE forecast_predictions ADD PRIMARY KEY (engine, generated_at, horizon_h)',
            callback);
        }
        if (pkName == null) { addPk(); return; }
        client.query(
          'ALTER TABLE forecast_predictions DROP CONSTRAINT "' + pkName + '"',
          function (dErr) {
            if (dErr) { callback(dErr); return; }
            addPk();
          });
      });
  });
}

module.exports = {
  SCHEMA_SQL, AGGREGATE_SQL, migrateLegacyForecastPredictions,
  // exported for tests
  _pkNeedsEngineMigration: pkNeedsEngineMigration,
};
