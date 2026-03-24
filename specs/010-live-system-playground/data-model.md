# Data Model: Connect Playground to Live System

**Feature**: 010-live-system-playground
**Date**: 2026-03-24

## Entities

### 1. Sensor Reading

A single temperature measurement from one of the five DS18B20 sensors.

| Field | Type | Description |
|-------|------|-------------|
| timestamp | integer (ms since epoch) | When the reading was taken |
| sensor_id | string | One of: `collector`, `tank_top`, `tank_bottom`, `greenhouse`, `outdoor` |
| value | real | Temperature in °C |
| resolution | string | `raw` (full resolution) or `30s` (downsampled) |

**Identity**: (timestamp, sensor_id) is unique per resolution tier.

**Lifecycle**:
- `raw` readings: retained for 48 hours, then aggregated into `30s` and deleted
- `30s` readings: retained indefinitely
- Aggregation: average value over each 30-second bucket per sensor

### 2. State Change Event

Records every change to a valve, actuator, or operating mode — kept forever at full resolution.

| Field | Type | Description |
|-------|------|-------------|
| timestamp | integer (ms since epoch) | When the change occurred |
| entity_type | string | `mode`, `valve`, or `actuator` |
| entity_id | string | e.g., `vi_btm`, `pump`, `mode` |
| old_value | string | Previous state (e.g., `open`, `off`, `idle`) |
| new_value | string | New state (e.g., `closed`, `on`, `solar_charging`) |

**Identity**: (timestamp, entity_type, entity_id) is unique.

**Lifecycle**: Never deleted. All state change events are retained indefinitely.

### 3. System State Snapshot (MQTT message)

The consolidated JSON payload published by the Shelly control script via MQTT and forwarded to browser clients via WebSocket. Not persisted as a single document — decomposed into sensor readings and state change events on the server.

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

**Published on**: MQTT topic `greenhouse/state` with QoS 1 and retain flag.

**Publish triggers**:
- Every poll cycle (~30 seconds)
- Immediately on mode transition (each step of the transition sequence)
- Immediately on any valve or actuator state change

### 4. Data Source (browser-side abstraction)

Represents the active data provider for the playground UI. Not persisted.

| Property | Type | Description |
|----------|------|-------------|
| type | string | `simulation` or `live` |
| connected | boolean | Whether the data source is actively providing data |
| lastUpdate | integer (ms) | Timestamp of most recent data point |

**State transitions**:
- `simulation` ↔ `live` (user toggle on greenhouse.madekivi.com)
- On GitHub Pages: always `simulation`, no transitions possible

## Relationships

```
Shelly Control Script
  └─ publishes → System State Snapshot (MQTT)
                    └─ consumed by → Node.js Server
                                       ├─ decomposes into → Sensor Readings (SQLite)
                                       ├─ decomposes into → State Change Events (SQLite)
                                       └─ forwards via WebSocket → Browser Data Source (live)

Browser Data Source (simulation)
  └─ produces → same data shape as System State Snapshot
                  (from local ThermalModel + ControlStateMachine)
```

## Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| sensor_readings | (sensor_id, timestamp) | Time-range queries per sensor |
| sensor_readings | (resolution, timestamp) | Downsampling job: find raw data older than 48h |
| state_events | (entity_type, timestamp) | Query events by type over time range |
| state_events | (timestamp) | Recent events across all types |

## Data Volume Estimates

| Metric | Value |
|--------|-------|
| Sensors polled | 5 temperatures every ~5s |
| Raw readings/day | ~86,400 per sensor × 5 = ~432,000 |
| Raw retention | 48 hours (~864,000 rows) |
| Downsampled readings/day | ~2,880 per sensor × 5 = ~14,400 |
| Downsampled storage/year | ~5.3M rows ≈ 300 MB |
| State change events/day | ~50-200 (mode + valve + actuator changes) |
| State events/year | ~18K-73K rows ≈ 5 MB |
| Total after 1 year | ~300-400 MB |
| Total after 5 years | ~1.5-2 GB |
