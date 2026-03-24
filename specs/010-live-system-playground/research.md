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

**Decision**: SQLite via `better-sqlite3` npm package, running in-process within the Node.js server.

**Rationale**: The server runs on a 1 CPU / 1 GB RAM / 10 GB disk UpCloud instance already hosting 3 Docker containers (Node.js, Caddy, OpenVPN). Dedicated time series databases (InfluxDB ≥1 GB RAM, TimescaleDB ≥512 MB, QuestDB ≥2 GB) are too heavy. SQLite adds zero RAM for a separate process — it runs inside the existing Node.js process with ~2-5 MB page cache. `better-sqlite3` provides synchronous C++ bindings, WAL mode for concurrent reads/writes, and can handle 50K+ inserts/second in batched transactions.

**Storage estimates**:
- Full resolution 48h (5s interval): ~590K rows/day × 2 days ≈ 30 MB
- Downsampled 30s long-term: ~1-2 GB/year
- State change events: sparse, negligible
- Total after 1 year: ~1-2 GB (well within 10 GB disk)

**Downsampling approach**: Application-level periodic job (hourly `setInterval`) that aggregates raw data older than 48h into 30s buckets, inserts aggregated rows, deletes raw rows.

**Persistence (Constitution VI)**: SQLite database file must be backed up to S3 periodically. The file persists in a Docker volume, but S3 backup ensures survival across server recreation. The existing `s3-storage.js` adapter can be extended for this.

**Alternatives considered**:
- InfluxDB 2.x: Best features (retention policies, continuous queries) but 1-2 GB RAM minimum. Non-starter on 1 GB server.
- TimescaleDB: Excellent downsampling (continuous aggregates) but PostgreSQL base needs 512 MB+ RAM and 800 MB+ Docker image.
- QuestDB: High-performance but needs 2-8 GB RAM. Completely oversized.
- In-memory with file persistence: Rejected in clarification — user explicitly wants a database.

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
