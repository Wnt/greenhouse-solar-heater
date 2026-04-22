#!/usr/bin/env node
// Real-server test harness used as the Playwright webServer command
// for the `e2e` project. Single process, three layers:
//
//   1. pg-mem stands in for PostgreSQL/TimescaleDB. `require('pg')` is
//      intercepted via require.cache so server/lib/db.js transparently
//      talks to an in-memory db. TimescaleDB-specific DDL
//      (create_hypertable, CREATE EXTENSION, materialized view with
//      time_bucket) is not supported by pg-mem, so we replace
//      `./lib/db-schema` with a plain-Postgres subset that preserves
//      the same table shape. The test corpus only exercises row-level
//      reads/writes — aggregates + retention are not in scope here.
//
//   2. aedes runs an in-process MQTT broker on 127.0.0.1:1883. The
//      server points at mqtt://127.0.0.1:1883 via MQTT_HOST, so the
//      existing mqtt-bridge code runs unmodified. Tests can publish
//      as a fake Shelly device and subscribe to what the server
//      publishes.
//
//   3. server/server.js boots on PORT 3220 via its test-only
//      `_startServer` export. AUTH_ENABLED=false to keep the seed
//      specs narrow — readonly-role enforcement is a follow-up that
//      will gate behind a session bypass.
//
// Shutdown is handled by SIGTERM/SIGINT — Playwright tears the
// process down between runs.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');

// ── 1. pg-mem with TimescaleDB-compatible schema ──────────────

const { newDb } = require('pg-mem');
const memDb = newDb({ autoCreateForeignKeyIndices: true });

// Inject a plain-SQL schema before server/lib/db.js resolves db-schema.
const schemaPath = path.resolve(__dirname, '..', '..', '..', 'server', 'lib', 'db-schema.js');
require.cache[schemaPath] = {
  id: schemaPath,
  filename: schemaPath,
  loaded: true,
  exports: {
    SCHEMA_SQL: [
      'CREATE TABLE IF NOT EXISTS sensor_readings (ts TIMESTAMPTZ NOT NULL, sensor_id TEXT NOT NULL, value DOUBLE PRECISION NOT NULL)',
      'CREATE INDEX IF NOT EXISTS sensor_readings_sensor_ts ON sensor_readings (sensor_id, ts DESC)',
      'CREATE TABLE IF NOT EXISTS state_events (ts TIMESTAMPTZ NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, old_value TEXT, new_value TEXT NOT NULL, cause TEXT, sensors JSONB, reason TEXT)',
      'CREATE INDEX IF NOT EXISTS state_events_type_ts ON state_events (entity_type, ts DESC)',
      'CREATE TABLE IF NOT EXISTS script_crashes (id BIGSERIAL PRIMARY KEY, ts TIMESTAMPTZ NOT NULL DEFAULT NOW(), error_msg TEXT, error_trace TEXT, sys_status JSONB, recent_states JSONB, resolved_at TIMESTAMPTZ)',
      'CREATE INDEX IF NOT EXISTS script_crashes_ts ON script_crashes (ts DESC)',
      // pg-mem has no materialized views + no time_bucket. Stand in
      // with a plain view so queries that target the aggregate (range
      // = '7d'/'30d'/'1y'/'all') resolve. Values are passed through
      // 1:1 rather than bucketed — fine for seed specs, which publish
      // one reading at a time and just want to see it come back.
      'CREATE VIEW sensor_readings_30s AS SELECT ts AS bucket, sensor_id, value AS avg_value, value AS min_value, value AS max_value FROM sensor_readings',
    ],
    AGGREGATE_SQL: [],
  },
};

// Swap require('pg') for pg-mem's shim.
const pgPath = require.resolve('pg');
const pgAdapter = memDb.adapters.createPg();
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: pgAdapter,
};

// ── 2. aedes MQTT broker ──────────────────────────────────────

const { Aedes } = require('aedes');
const MQTT_PORT = 1883;

// aedes@1 moved to an async factory; the old `new Aedes()` constructor
// throws a migration error. `createBroker()` returns a promise — we
// boot the rest of the harness inside its `.then` so the broker is
// accepting connections before server/server.js tries to dial out.
Aedes.createBroker().then((broker) => {
  const mqttServer = net.createServer(broker.handle);
  mqttServer.listen(MQTT_PORT, '127.0.0.1', () => {
    process.stdout.write(`[e2e-harness] aedes listening on 127.0.0.1:${MQTT_PORT}\n`);
    bootServer();
  });

  // Register teardown hooks once the broker is live.
  const shutdown = () => {
    try { mqttServer.close(); } catch (_) { /* noop */ }
    broker.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
});

// ── 3. Env + server boot ──────────────────────────────────────

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-server-'));
process.env.PORT = '3220';
process.env.DATABASE_URL = 'postgres://test:test@localhost/test';
process.env.MQTT_HOST = '127.0.0.1';
process.env.MQTT_PORT = String(MQTT_PORT);
// script-monitor polls a real Shelly by default (192.168.30.50). Point
// at 127.0.0.1:0 so its HTTP RPC fails fast instead of blocking on DNS
// or cross-LAN timeouts. The failures are swallowed by the monitor's
// error handler — the test harness doesn't need a fake controller.
process.env.CONTROLLER_IP = '127.0.0.1:1';
process.env.AUTH_ENABLED = 'false';
process.env.DEVICE_CONFIG_PATH = path.join(tmpRoot, 'device-config.json');
// sensor-config + push writes land in server/ by default. Point them at tmp.
process.env.SENSOR_CONFIG_PATH = path.join(tmpRoot, 'sensor-config.json');
process.env.PUSH_CONFIG_PATH = path.join(tmpRoot, 'push-config.json');

// Silence noisy startup banners when running under Playwright.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

function bootServer() {
  const server = require(path.resolve(__dirname, '..', '..', '..', 'server', 'server.js'));
  server._startServer();
}
