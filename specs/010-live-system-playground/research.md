# Research: Connect Playground to Live System

**Feature**: 010-live-system-playground
**Date**: 2026-03-24

## R1: Shelly MQTT Publishing from Scripts

**Decision**: Use `MQTT.publish(topic, message, qos, retain)` from the Shelly control script.

**Rationale**: Shelly Gen2 scripting natively supports `MQTT.publish()` — no HTTP bridge or external proxy needed. The API returns `true` if enqueued, `false` if disconnected, making it safe to call fire-and-forget without disrupting control logic (FR-006).

**Constraints discovered**:
- MQTT must be enabled in device settings first (`Mqtt.SetConfig({enable: true, server: "..."})` + reboot)
- Current script size: `control.js` (9.9 KB) + `control-logic.js` (9.4 KB) = ~19.4 KB combined. 16 KB limit means deploy likely minifies/strips. Adding MQTT publishing needs to be compact.
- Current resource usage: 4 of 5 timers, 0 event subscriptions, ~12 `Shelly.call()` invocations. One timer slot available.
- No separate timer needed — publish at end of existing 30s poll cycle + on mode transitions

**Alternatives considered**:
- Built-in Shelly MQTT (enable MQTT in settings, auto-publishes standard topics): Rejected — publishes raw switch states without mode, transition status, or consolidated sensor data.
- External polling from server via HTTP RPC: Rejected — already exists in monitor but requires VPN hop per poll, adds latency, doesn't scale to sub-second updates.

## R2: Time Series Database

**Decision**: UpCloud Managed Database PostgreSQL with TimescaleDB extension, provisioned via Terraform.

**Rationale**: UpCloud offers managed PostgreSQL with TimescaleDB as a supported built-in extension. Using a managed database offloads operational burden (backups, PITR, failover) from the application server, fully satisfies Constitution VI (Durable Data Persistence) without custom S3 backup logic, and provides TimescaleDB's native features: hypertables for automatic time-based partitioning, continuous aggregates for downsampling, and compression for long-term storage efficiency.

**UpCloud Managed PostgreSQL details**:
- Smallest plan: `1x1xCPU-2GB-25GB` (1 CPU, 2 GB RAM, 25 GB storage)
- Single-node (Development tier): 2-day backup retention, 24h PITR
- TimescaleDB extension available — enable with `CREATE EXTENSION timescaledb;`
- Terraform resource: `upcloud_managed_database_postgresql`
- Connection: `postgres://user:password@host:port/defaultdb?sslmode=require`
- Zone: `fi-hel1` (same as server)

**Terraform provisioning**:
```hcl
resource "upcloud_managed_database_postgresql" "timeseries" {
  name  = "greenhouse-timeseries"
  plan  = "1x1xCPU-2GB-25GB"
  title = "Greenhouse TimescaleDB"
  zone  = "fi-hel1"

  properties {
    public_access = false
    timescaledb {
      max_background_workers = 4
    }
  }
}
```

**Node.js client**: `pg` npm package (node-postgres) — the standard PostgreSQL client for Node.js. CommonJS compatible, connection pooling, parameterized queries.

**Downsampling approach**: TimescaleDB continuous aggregates — define a materialized view that automatically aggregates raw data into 30-second buckets. Combined with a retention policy that drops raw data older than 48 hours. No application-level cron job needed.

```sql
-- Continuous aggregate for 30s downsampling
CREATE MATERIALIZED VIEW sensor_readings_30s
WITH (timescaledb.continuous) AS
SELECT time_bucket('30 seconds', ts) AS bucket,
       sensor_id,
       AVG(value) AS value
FROM sensor_readings
GROUP BY bucket, sensor_id;

-- Retention policy: drop raw data after 48 hours
SELECT add_retention_policy('sensor_readings', INTERVAL '48 hours');

-- Refresh policy: keep continuous aggregate up to date
SELECT add_continuous_aggregate_policy('sensor_readings_30s',
  start_offset => INTERVAL '1 hour',
  end_offset => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '30 minutes');
```

**Storage estimates**:
- Full resolution 48h (5s interval): ~590K rows/day × 2 days ≈ 30 MB (auto-dropped by retention policy)
- Downsampled 30s long-term: ~300 MB/year (with TimescaleDB compression: ~30-60 MB/year)
- State change events: sparse, negligible (<5 MB/year)
- Total after 5 years: ~200-400 MB (well within 25 GB managed storage)

**Persistence (Constitution VI)**: Fully satisfied — UpCloud Managed Database provides automated backups, PITR, and durable storage external to the application containers. No custom backup logic needed.

**Alternatives considered**:
- SQLite via `better-sqlite3` (in-process): Zero additional RAM, simple. Rejected because it requires custom S3 backup logic for Constitution VI compliance, manual downsampling via application code, and doesn't provide PITR or automated backups.
- InfluxDB 2.x: Best native time-series features but 1-2 GB RAM minimum for self-hosted. No managed option on UpCloud.
- QuestDB: High-performance but 2-8 GB RAM. No managed option on UpCloud.
- Self-hosted PostgreSQL+TimescaleDB in Docker: Would save the managed DB cost but adds ~512 MB RAM to the already constrained 1 GB server and requires manual backup management.

## R3: MQTT-to-Browser Communication

**Decision**: Server-side MQTT→WebSocket bridge. The Node.js server subscribes to MQTT and forwards messages to browser clients over WebSocket.

**Rationale**:
1. **Auth consistency**: WebAuthn session cookies validate WebSocket upgrades via existing middleware. Direct browser-to-Mosquitto would require separate auth.
2. **Network topology**: Mosquitto runs in the Docker Compose stack. Exposing its WebSocket port through Caddy adds attack surface. The Node.js server already has local access.
3. **GitHub Pages compatibility**: Browser code uses only native `WebSocket` API — no MQTT dependency. On GitHub Pages (no server), WebSocket simply isn't available and the app gracefully falls back to simulation-only.
4. **Single connection**: One server MQTT subscription serves all browser clients vs. each browser tab opening its own connection.
5. **Zero browser dependencies**: No need to vendor mqtt.js for the browser. Native `WebSocket` API only.

**Server dependencies**: `mqtt` (MQTT client) + `ws` (WebSocket server, attaches to existing `http.Server`)

**Alternatives considered**:
- Direct browser-to-Mosquitto via WebSocket: Mosquitto supports WebSocket listeners natively. Rejected because it bypasses WebAuthn auth, requires exposing broker to internet, and adds MQTT dependency to browser code.
- Server-Sent Events (SSE): Simpler than WebSocket (one-way). Could work for this use case (data flows server→browser only). However, WebSocket is more standard for real-time apps, supports future bidirectional needs (e.g., manual overrides), and `ws` library is lightweight.

## R4: Playground Data Source Abstraction

**Decision**: Extract a `DataSource` interface at the `updateDisplay(state, result)` boundary in the playground app.

**Rationale**: The current playground has a clean data flow: `simLoop → model.step() → controller.evaluate() → updateDisplay(state, result)`. The `updateDisplay()` function and all downstream UI (gauges, schematic, components, graph) consume a fixed data shape:

```javascript
{
  state: { t_tank_top, t_tank_bottom, t_collector, t_greenhouse, t_outdoor, simTime },
  result: { mode, actuators: { pump, fan, space_heater }, valves: {...}, transition }
}
```

Two data source implementations:
1. **SimulationSource**: Current browser-side `ThermalModel` + `ControlStateMachine` (requestAnimationFrame loop)
2. **LiveSource**: WebSocket client receiving the same data shape from the server

The time-series store (`store.addPoint()`) accepts the same structure from either source. The Controls view (sliders, presets, play/pause) only applies to SimulationSource.

**Key finding**: The server does NOT need to run `evaluate()` — the Shelly control script already computes mode, valves, and actuators. The MQTT message from the device contains the complete computed state. The server just forwards it.

## R5: MQTT Broker Infrastructure

**Decision**: Mosquitto as a Docker container in the existing Docker Compose stack.

**Rationale**: Mosquitto (Eclipse) is the standard lightweight MQTT broker. Alpine-based Docker image is ~12 MB. Idle RAM usage is ~2-5 MB. Supports retained messages (needed for latest-state-on-connect per FR-005 acceptance scenario 4). The Shelly devices connect to it over the VPN tunnel. The Node.js server connects locally.

**Docker Compose integration**: Add a `mosquitto` service. The Node.js app (which shares the OpenVPN network namespace via `network_mode: "service:openvpn"`) can reach Mosquitto at `mosquitto:1883` via the Docker network. The Shelly devices reach it at the VPN tunnel endpoint IP.

**Configuration**: Minimal — allow anonymous connections (the broker is only reachable from within Docker network + VPN tunnel, not exposed to internet). Persistence enabled for retained messages.

## R6: Unified App Architecture

**Decision**: The playground SPA replaces the monitor app. The server serves the playground static files and provides API endpoints (auth, RPC proxy, WebSocket, history).

**Findings from monitor/server.js**:
- Existing endpoints: `/health`, `/auth/*`, `/api/rpc/*`, `/api/push/*`, static file serving
- Auth middleware (WebAuthn passkeys, HMAC session cookies)
- Push notification API (VAPID keys, subscription management)
- Valve state poller (polls controller via HTTP RPC, sends push on changes)

**Migration path**: The server continues to serve static files but points to `playground/` instead of (or in addition to) `monitor/`. The valve poller can be replaced by MQTT subscription. Push notifications trigger from MQTT state changes instead of HTTP RPC polling. All existing auth and API endpoints remain.

## R7: Remote Shelly Deployment via VPN

**Decision**: Extend `shelly/deploy.sh` to work with VPN-routable IPs. Integrate into the deployer as an optional CD step.

**Rationale**: The existing `deploy.sh` uses HTTP RPC to upload scripts — the same protocol works over the VPN tunnel since Shelly devices are reachable at their LAN IPs from the cloud server's VPN namespace. No protocol changes needed; only the target IP must be VPN-routable.

**Implementation**:
- `shelly/devices.conf` gains VPN IP entries (e.g., `PRO4PM_VPN=10.x.x.x` or reuses LAN IPs if the VPN routes the full LAN subnet)
- `deploy.sh` accepts a `--vpn` flag or `DEPLOY_VIA_VPN=true` env var to select VPN IPs
- The deployer's `deploy.sh` calls `shelly/deploy.sh` after `docker compose up -d`, running inside the openvpn network namespace (via `docker exec` into the openvpn container, or using the app container which shares the VPN namespace)
- Script deployment is idempotent — re-deploying the same script is a no-op from the device's perspective

**Constraints**: Shelly HTTP RPC has no authentication — anyone on the network can deploy scripts. This is acceptable because the VPN tunnel is the access control boundary (same as existing RPC proxy in the monitor).

## R8: Device Runtime Configuration (Feature Flags)

**Decision**: Cloud-fetched, KVS-persisted device configuration. All actuator control disabled by default.

**Rationale**: The system must be safe to deploy without accidentally commanding hardware. A fresh device should monitor only (read sensors, publish MQTT) until an operator explicitly enables actuator control. Configuration must survive reboots (KVS) and internet outages (offline start with last known config).

**Configuration shape** (stored in KVS as JSON string under key `config`):
```json
{
  "controls_enabled": false,
  "enabled_actuators": {
    "valves": false,
    "pump": false,
    "fan": false,
    "space_heater": false,
    "immersion_heater": false
  },
  "version": 1
}
```

**Config delivery — dual channel**:
- **Bootstrap (HTTP)**: On boot, before MQTT is connected, the Shelly fetches config via HTTP GET from the cloud endpoint. This handles the cold-start case.
- **Live updates (MQTT push)**: The server publishes config to `greenhouse/config` (retained, QoS 1) whenever an operator updates it via the API. The Shelly subscribes to this topic and applies changes immediately. Retained messages mean the Shelly also gets the latest config on MQTT connect/reconnect — no polling needed.
- **KVS persistence**: Every config update (from either channel) is persisted to KVS. This is the offline fallback — if the device reboots without internet and before MQTT connects, it uses the KVS copy.

**Shelly-side flow**:
1. On boot: read `config` from KVS. If not found, use default (all disabled).
2. Attempt HTTP GET to cloud config endpoint (e.g., `http://<cloud-vpn-ip>:3000/api/device-config`). If response has different `version`, update KVS and apply.
3. Subscribe to `greenhouse/config` MQTT topic. On message: compare `version`, update KVS if different, apply immediately.
4. On each poll cycle (~30s): if config has `controls_enabled: false`, skip all actuator commands but still read sensors and publish MQTT.
5. If controls are disabled while a mode is active: the next control loop iteration triggers a safe shutdown (stop pump → close valves → transition to idle).

**Server-side**:
- `monitor/lib/device-config.js`: stores config in S3/local (same adapter as credentials). Provides `GET /api/device-config` (no auth — Shelly can't do WebAuthn) and `PUT /api/device-config` (auth required — operator only).
- On PUT: persist to S3/local, then publish to `greenhouse/config` MQTT topic (retained). The Shelly receives it immediately via its MQTT subscription.
- The GET endpoint is unauthenticated because Shelly devices can't perform WebAuthn. Access control relies on the VPN tunnel — only devices on the VPN can reach the server's internal port. The Caddy reverse proxy does NOT expose `/api/device-config` publicly.
- Config changes could also trigger a push notification to inform the operator.

**Why MQTT push for config updates**: Disabling a heating circuit while the system is active is a safety-critical operation — the pump must stop and valves must close immediately, not after a 5-minute polling interval. MQTT retained messages also eliminate polling entirely: the Shelly gets the latest config on every connect/reconnect automatically.

**Pure logic integration**: The `evaluate()` function in `control-logic.js` receives config as a parameter: `evaluate(state, config)`. When `controls_enabled` is false or specific actuators are disabled, `evaluate()` returns the decision as usual but the I/O layer in `control.js` skips the actual hardware commands. This keeps the pure logic testable and the safety guard in the I/O boundary.

**Alternative considered**: Polling-only config (HTTP GET every 5 minutes). Rejected — unacceptable latency for safety-critical config changes like disabling an active circuit. MQTT push provides near-instant delivery.

**Alternative considered**: Config in `control-logic.js` constants (deploy new code to change config). Rejected — violates the requirement that enabling controls should not require a new deployment.
