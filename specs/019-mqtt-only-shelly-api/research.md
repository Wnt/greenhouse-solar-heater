# Research: MQTT-Only Shelly Communication API

**Feature**: 019-mqtt-only-shelly-api | **Date**: 2026-04-06

## Research Tasks

### R1: How to route sensor config apply through the controller via MQTT

**Context**: Currently `server/lib/sensor-config.js` makes direct HTTP RPC calls (`SensorAddon.GetPeripherals`, `SensorAddon.RemovePeripheral`, `SensorAddon.AddPeripheral`) to sensor hosts. The spec requires these go through MQTT→controller→local RPC instead.

**Decision**: Add a new MQTT topic `greenhouse/sensor-config-apply` for the server to publish apply requests. The telemetry script on the controller subscribes to this topic and forwards to the control script via inter-script events. The control script executes the RPC calls to sensor hosts on the local network (it already has HTTP RPC infrastructure for valve control and sensor polling). Results are published back via `greenhouse/sensor-config-result`.

**Rationale**: The controller already makes HTTP calls to sensor host IPs for temperature polling (`pollSensor()` in control.js). Adding sensor addon RPC calls reuses the same network path. This keeps sensor host communication entirely on the local network, routed through the device that already has LAN access.

**Alternatives considered**:
1. *Telemetry script executes RPC directly*: Rejected — telemetry script doesn't have HTTP call infrastructure and adding it would increase script size and complexity. Control script already manages HTTP calls and concurrency.
2. *New dedicated Shelly script for sensor management*: Rejected — adds a third script slot, increases complexity, and the 5-concurrent-call limit is per-script so it wouldn't help. The controller already has the HTTP RPC pattern.
3. *Keep direct server→sensor RPC for apply only*: Rejected — contradicts FR-010 requirement for zero direct HTTP RPC from cloud during normal operation.

### R2: How to implement sensor discovery via MQTT request/response

**Context**: Sensor discovery requires scanning 1-Wire buses on sensor hosts (listing DS18B20 addresses). Currently the server calls `SensorAddon.GetPeripherals` directly. The spec requires the controller to perform this locally.

**Decision**: Add MQTT topic `greenhouse/discover-sensors` (server→controller request) and `greenhouse/discover-sensors-result` (controller→server response). The controller receives the discovery request, iterates through known sensor host IPs, calls `SensorAddon.GetPeripherals` on each, collects results, and publishes back. The server correlates request/response using a request ID.

**Rationale**: Request/response over MQTT requires correlation IDs since MQTT is inherently pub/sub. A simple incrementing ID or timestamp-based ID suffices for this low-frequency operation (discovery is rare, operator-initiated).

**Alternatives considered**:
1. *Use MQTT request-response pattern (MQTT 5.0 response topic)*: Rejected — Shelly's built-in MQTT client is MQTT 3.1.1, not 5.0. Must implement correlation manually.
2. *Fire-and-forget discovery (no result topic)*: Rejected — the UI needs to display discovered sensors. A response path is required.
3. *Use retained messages for discovery results*: Rejected — discovery results are transient and stale-sensitive. Using retained messages would show outdated results on reconnect.

### R3: Removing valve-poller.js — impact analysis

**Context**: `server/lib/valve-poller.js` polls the controller via `Script.Eval?code=getStatus()` every 10 seconds. The MQTT bridge already receives the same state data via `greenhouse/state`. The valve poller is redundant.

**Decision**: Remove `valve-poller.js` entirely. The MQTT bridge (`mqtt-bridge.js`) already handles state reception, database persistence, and WebSocket broadcasting. The valve poller's `Script.Eval` call is the primary source of the 5-concurrent-call limit violations that crash the control script.

**Rationale**: The MQTT bridge was added in feature 010 as the intended replacement for direct polling. The valve poller was kept as a fallback but is now the source of reliability problems. State arrives via MQTT within the 30-second control loop interval, meeting SC-002.

**Alternatives considered**:
1. *Keep poller as fallback when MQTT is down*: Rejected — if MQTT is down between server and broker (they're in the same pod), the entire monitoring stack is degraded anyway. The poller wouldn't help since it also requires network access to the controller.
2. *Reduce poller frequency instead of removing*: Rejected — even infrequent `Script.Eval` calls can collide with sensor polling and cause crashes. Zero is the only safe frequency.

### R4: Concurrent call budget on Shelly controller

**Context**: The Shelly platform allows 5 concurrent HTTP calls per script. The control script already uses HTTP calls for valve control (up to 8 valves) and sensor polling (up to 5 sensors). Adding sensor discovery and sensor config apply adds more HTTP calls.

**Decision**: Serialize all HTTP operations using the existing sequential polling pattern. Sensor discovery and config apply are rare, operator-initiated operations — they can wait for the current control cycle to complete. Use a simple queue/flag mechanism: if discovery or config-apply is requested, defer it to the next control cycle gap (after sensor polling completes but before the next cycle).

**Rationale**: The control loop runs every 30 seconds. Sensor polling takes ~2-5 seconds (sequential calls). Valve commands are issued only on mode transitions. There's ample time within each 30-second window for a discovery scan or config apply, as long as operations don't overlap.

**Alternatives considered**:
1. *Parallel HTTP calls with semaphore*: Rejected — Shelly ES5 runtime has no Promise/async support. A counting semaphore in callback-based ES5 code would be complex and error-prone.
2. *Move discovery to telemetry script to use separate call budget*: Rejected — each script has its own 5-call limit, but the telemetry script doesn't have HTTP call infrastructure. Adding it would duplicate code and increase script size toward the 16KB limit.

### R5: RPC proxy endpoint security after removing direct device RPC

**Context**: `server/server.js` has an RPC proxy at `/api/rpc/*` that forwards requests to Shelly devices. With FR-010 (no direct cloud-to-device RPC), this proxy should be restricted.

**Decision**: Remove the RPC proxy endpoint entirely from the server. All device communication flows through MQTT. The playground UI already receives state via WebSocket (from MQTT bridge). Config changes go through the device-config and sensor-config APIs (which publish to MQTT). Discovery goes through a new `/api/sensor-discovery` endpoint that publishes to MQTT and waits for a response.

**Rationale**: The RPC proxy was the mechanism for the playground to reach Shelly devices via the server. With MQTT-only communication, no code path needs direct HTTP access to devices from the cloud. Removing the proxy eliminates the attack surface and enforces the MQTT-only architecture at the API level.

**Alternatives considered**:
1. *Keep proxy but restrict to read-only methods*: Rejected — even read-only RPC (like `Shelly.GetStatus`) uses `Script.Eval` or similar calls that consume concurrent call budget. The MQTT path provides all needed read data.
2. *Keep proxy behind a feature flag*: Rejected — adds maintenance burden for a path that should never be used. Clean removal is simpler.

### R6: Shelly MQTT reconnect behavior

**Context**: The spec assumes Shelly's built-in MQTT client reconnects reliably. Need to verify this is sufficient.

**Decision**: Rely on Shelly's built-in MQTT reconnect. The telemetry script already re-subscribes to config topics on MQTT status change events (telemetry.js lines 145-147). The built-in client handles reconnection with backoff automatically. State messages use QoS 1 with retain, so the broker stores the latest state for new subscribers.

**Rationale**: Shelly's MQTT implementation is a core platform feature, tested across millions of devices. Custom reconnection logic would add complexity without clear benefit. The existing `Mqtt.subscribe` on reconnect pattern in telemetry.js handles re-subscription correctly.

**Alternatives considered**:
1. *Custom reconnection timer in telemetry script*: Rejected — would consume one of the 5 available timers. The platform handles this natively.
