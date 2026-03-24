# Data Model: Connect Playground to Live System

**Feature**: 010-live-system-playground
**Date**: 2026-03-24
**Database**: UpCloud Managed PostgreSQL with TimescaleDB extension

## Database Schema

### Table: `sensor_readings` (TimescaleDB hypertable)

A single temperature measurement from one of the five DS18B20 sensors. Converted to a hypertable for automatic time-based partitioning and retention policies.

```sql
CREATE TABLE sensor_readings (
  ts         TIMESTAMPTZ NOT NULL,
  sensor_id  TEXT        NOT NULL,
  value      DOUBLE PRECISION NOT NULL
);

SELECT create_hypertable('sensor_readings', 'ts');
```

| Column | Type | Description |
|--------|------|-------------|
| ts | TIMESTAMPTZ | When the reading was taken |
| sensor_id | TEXT | One of: `collector`, `tank_top`, `tank_bottom`, `greenhouse`, `outdoor` |
| value | DOUBLE PRECISION | Temperature in °C |

**Retention policy**: Raw data automatically dropped after 48 hours.
```sql
SELECT add_retention_policy('sensor_readings', INTERVAL '48 hours');
```

### Continuous Aggregate: `sensor_readings_30s`

Automatic 30-second downsampled view. TimescaleDB materializes this incrementally — no application-level cron needed.

```sql
CREATE MATERIALIZED VIEW sensor_readings_30s
WITH (timescaledb.continuous) AS
SELECT time_bucket('30 seconds', ts) AS bucket,
       sensor_id,
       AVG(value) AS avg_value,
       MIN(value) AS min_value,
       MAX(value) AS max_value
FROM sensor_readings
GROUP BY bucket, sensor_id;

-- Refresh every 30 minutes, covering data up to 5 minutes ago
SELECT add_continuous_aggregate_policy('sensor_readings_30s',
  start_offset  => INTERVAL '1 hour',
  end_offset    => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '30 minutes');
```

**Retention**: The continuous aggregate is retained indefinitely. Only raw data is dropped.

### Table: `state_events`

Records every change to a valve, actuator, or operating mode — kept forever at full resolution.

```sql
CREATE TABLE state_events (
  ts          TIMESTAMPTZ NOT NULL,
  entity_type TEXT        NOT NULL,
  entity_id   TEXT        NOT NULL,
  old_value   TEXT,
  new_value   TEXT        NOT NULL
);

SELECT create_hypertable('state_events', 'ts');
```

| Column | Type | Description |
|--------|------|-------------|
| ts | TIMESTAMPTZ | When the change occurred |
| entity_type | TEXT | `mode`, `valve`, or `actuator` |
| entity_id | TEXT | e.g., `vi_btm`, `pump`, `mode` |
| old_value | TEXT | Previous state (e.g., `open`, `off`, `idle`). NULL for first event. |
| new_value | TEXT | New state (e.g., `closed`, `on`, `solar_charging`) |

**Retention**: No retention policy — all state events are kept indefinitely.

### Entity: System State Snapshot (MQTT message — not persisted directly)

The consolidated JSON payload published by the Shelly control script via MQTT and forwarded to browser clients via WebSocket. Decomposed into `sensor_readings` and `state_events` rows on the server.

| Field | Type | Description |
|-------|------|-------------|
| ts | integer (ms) | Device timestamp |
| mode | string | Current operating mode |
| transitioning | boolean | Whether a mode transition is in progress |
| transition_step | string or null | Current step: `pump_stop`, `valves_closing`, `valves_opening`, `pump_start`, or null |
| temps | object | `{ collector, tank_top, tank_bottom, greenhouse, outdoor }` — all reals in °C |
| valves | object | `{ vi_btm, vi_top, vi_coll, vo_coll, vo_rad, vo_tank, v_ret, v_air }` — all booleans (true=open) |
| actuators | object | `{ pump, fan, space_heater, immersion_heater }` — all booleans (true=on) |
| flags | object | `{ collectors_drained, emergency_heating_active }` |
| controls_enabled | boolean | Whether actuator control is active (from device config) |

**Published on**: MQTT topic `greenhouse/state` with QoS 1 and retain flag.

**Publish triggers**:
- Every poll cycle (~30 seconds)
- Immediately on mode transition (each step of the transition sequence)
- Immediately on any valve or actuator state change

### Entity: Data Source (browser-side abstraction — not persisted)

Represents the active data provider for the playground UI.

| Property | Type | Description |
|----------|------|-------------|
| type | string | `simulation` or `live` |
| connected | boolean | Whether the data source is actively providing data |
| lastUpdate | integer (ms) | Timestamp of most recent data point |

**State transitions**:
- `simulation` ↔ `live` (user toggle on greenhouse.madekivi.com)
- On GitHub Pages: always `simulation`, no transitions possible

### Entity: Device Configuration (S3/local persisted)

Runtime settings for the Shelly controller. Persisted on the server via the S3/local storage adapter (same pattern as credentials and push subscriptions). Also cached in Shelly KVS for offline resilience.

| Property | Type | Description |
|----------|------|-------------|
| controls_enabled | boolean | Master switch — if false, no actuators are commanded |
| enabled_actuators | object | `{ valves, pump, fan, space_heater, immersion_heater }` — all booleans |
| version | integer | Auto-incremented on each update, used by Shelly to detect changes |

**Default** (safe): `controls_enabled: false`, all actuators disabled.

**Persistence**:
- Server: `device-config.json` in S3/local storage
- Shelly: `config` key in KVS (JSON string)

**Update flow**: Operator updates via `PUT /api/device-config` → server persists to S3 → Shelly fetches on next config poll (≤5 min) → Shelly updates KVS → new config takes effect on next poll cycle.

## Relationships

```
Shelly Control Script
  └─ publishes → System State Snapshot (MQTT)
                    └─ consumed by → Node.js Server
                                       ├─ decomposes into → sensor_readings (PostgreSQL hypertable)
                                       ├─ decomposes into → state_events (PostgreSQL hypertable)
                                       └─ forwards via WebSocket → Browser Data Source (live)

TimescaleDB (automatic, internal)
  └─ sensor_readings → continuous aggregate → sensor_readings_30s
  └─ sensor_readings → retention policy → drops rows older than 48h

Browser Data Source (simulation)
  └─ produces → same data shape as System State Snapshot
                  (from local ThermalModel + ControlStateMachine)
```

## Indexes

TimescaleDB hypertables automatically create time-based chunk indexes. Additional indexes:

| Table/View | Index | Purpose |
|------------|-------|---------|
| sensor_readings | (sensor_id, ts DESC) | Time-range queries per sensor |
| sensor_readings_30s | (sensor_id, bucket DESC) | Long-term history queries |
| state_events | (entity_type, ts DESC) | Query events by type over time range |

```sql
CREATE INDEX ON sensor_readings (sensor_id, ts DESC);
CREATE INDEX ON state_events (entity_type, ts DESC);
```

## Example Queries

### Recent readings (last 6h, raw resolution)
```sql
SELECT ts, sensor_id, value
FROM sensor_readings
WHERE ts > NOW() - INTERVAL '6 hours'
ORDER BY ts;
```

### Long-term history (last 30 days, 30s resolution)
```sql
SELECT bucket AS ts, sensor_id, avg_value AS value
FROM sensor_readings_30s
WHERE bucket > NOW() - INTERVAL '30 days'
ORDER BY bucket;
```

### Mode transitions in time range
```sql
SELECT ts, old_value, new_value
FROM state_events
WHERE entity_type = 'mode'
  AND ts > NOW() - INTERVAL '7 days'
ORDER BY ts;
```

## Data Volume Estimates

| Metric | Value |
|--------|-------|
| Sensors polled | 5 temperatures every ~5s |
| Raw readings/day | ~86,400 per sensor × 5 = ~432,000 |
| Raw retention | 48 hours (~864,000 rows, auto-dropped) |
| Downsampled readings/day | ~2,880 per sensor × 5 = ~14,400 (continuous aggregate) |
| Downsampled storage/year | ~5.3M rows ≈ 300 MB (with compression: ~30-60 MB) |
| State change events/day | ~50-200 (mode + valve + actuator changes) |
| State events/year | ~18K-73K rows ≈ 5 MB |
| Total after 1 year | ~100-400 MB (with TimescaleDB compression) |
| Total after 5 years | ~500 MB-2 GB (well within 25 GB managed storage) |

## Infrastructure

**UpCloud Managed PostgreSQL**:
- Plan: `1x1xCPU-2GB-25GB` (Development tier, single node)
- Zone: `fi-hel1` (same as application server)
- Backups: 2-day retention, 24h PITR (automatic)
- Extension: TimescaleDB (enabled via `CREATE EXTENSION timescaledb;`)
- Connection: SSL required (`sslmode=require`)
- Access: Private (no public access, server connects via internal network)

**Environment variable**: `DATABASE_URL` passed to app via cloud-init `.env.secrets`
