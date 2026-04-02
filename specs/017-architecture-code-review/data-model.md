# Data Model: Architecture Code Review (P1 Security)

**Branch**: `017-architecture-code-review` | **Date**: 2026-04-02

This feature is a refactoring/security hardening effort. No new data entities are introduced. The changes affect how existing data is queried and how configuration is validated.

## Affected Entities

### Sensor Readings (existing, unchanged schema)

- **Table**: `sensor_readings` (TimescaleDB hypertable)
- **Fields**: `ts` (timestamptz), `sensor_id` (text), `value` (double precision)
- **Change**: Query access via `getHistory()` switches from string interpolation to parameterized queries
- **Validation**: `sensor_id` parameter now passed as `$1` placeholder instead of inline string

### State Events (existing, unchanged schema)

- **Table**: `state_events`
- **Fields**: `ts` (timestamptz), `entity_type` (text), `entity_id` (text), `old_value` (text), `new_value` (text)
- **Change**: Query access via `getEvents()` switches from string interpolation to parameterized queries

### Server Configuration (existing, behavioral change)

- **Source**: Environment variables
- **Change**: New startup validation gate when `AUTH_ENABLED=true`:
  - `SESSION_SECRET` must be present and not equal to `'dev-secret-change-me'`
  - `CONTROLLER_IP` must be present (now required for RPC proxy)
- **No schema change**: These are runtime environment variables, not persisted data

### RPC Proxy Request (existing, field removed)

- **Previous**: Client sends `{ _host: "ip", ...params }` in POST body
- **New**: Client sends `{ ...params }` only; server resolves host from `CONTROLLER_IP`
- **Removed field**: `_host` no longer accepted or required in request body
