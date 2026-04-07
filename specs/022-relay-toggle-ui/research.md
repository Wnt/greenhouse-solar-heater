# Research: Manual Relay Toggle UI

**Feature**: 022-relay-toggle-ui  
**Date**: 2026-04-07

## R1: MQTT Command Path for Low-Latency Relay Toggling

**Decision**: Introduce a new MQTT topic `greenhouse/relay-command` for direct relay actuation commands, and add a WebSocket command handler on the server to bridge client commands to MQTT.

**Rationale**: The existing system has no client→device command path. Current flows are: config push (HTTP PUT → MQTT `greenhouse/config`, retained) and state broadcast (MQTT `greenhouse/state` → WebSocket). For low-latency relay toggling, we need a non-retained, fire-and-forget command topic. Using MQTT rather than direct HTTP RPC to Shelly devices aligns with the architecture decision in 019-mqtt-only-shelly-api (all device communication flows through MQTT). WebSocket is the fastest browser→server path (already established, no HTTP overhead per command).

**Alternatives considered**:
- **Direct HTTP RPC to Shelly via server proxy**: Lower latency (~50ms saved) but violates the MQTT-only architecture. Rejected.
- **Reuse `greenhouse/config` with a special flag**: Would pollute the retained config topic with transient commands. Rejected.
- **HTTP POST endpoint per command**: Adds HTTP overhead per toggle vs. reusing the existing WebSocket connection. Rejected.

## R2: Manual Override State Management — Where to Enforce TTL

**Decision**: Override session state (active flag, TTL expiry timestamp, safety suppression flag) is managed on the Shelly device via the existing device config mechanism. A new field `mo` (manual override) is added to the compact device config. TTL expiry is enforced **on the device** by checking `mo.ex` against the current time on every control loop iteration (runs every 30 seconds). When the override expires, the device clears `mo` from its config, saves to KVS, emits a state update, and resumes normal automation. The server also tracks the TTL as a secondary measure and can push a config update to end the override, but the device is the primary authority.

**Rationale**: The TTL must survive browser disconnection AND server/internet outage — the device must be able to revert to automation autonomously. The existing control loop already runs every 30 seconds, so checking the expiry timestamp there adds no new timers and no resource cost. Worst-case auto-revert latency is 30 seconds after TTL expiry, which is acceptable for a 5-minute default TTL. The server acts as a secondary safety net (e.g., cleaning up its own state and notifying connected clients) but is not required for TTL enforcement.

**Alternatives considered**:
- **Server-only TTL**: Device depends on server being reachable. If internet or server is down, override never expires — relays stay in manual state indefinitely. Unacceptable safety risk. Rejected.
- **Dedicated Shelly timer**: Shelly has only 5 timers, most already allocated (control loop, drain monitor, valve settle, pump prime, boot retry). Adding another risks exceeding the limit. Rejected.
- **Browser-only TTL**: Doesn't survive tab close. Violates spec requirement. Rejected.
- **Separate override state in S3/DB**: Overengineered for a transient session. Rejected.

## R3: Control Logic Integration — Bypassing evaluate() During Manual Override

**Decision**: When manual override is active (`deviceConfig.mo` is set and not expired), the control loop in `control.js` skips the `evaluate()` call entirely. Relay commands from MQTT are processed directly by the Shelly device, calling `setPump()`, `setFan()`, and `setValve()` functions without going through mode transitions. The `safetyOverride` behavior depends on the `mo.ss` (suppress safety) flag in device config.

**Rationale**: The existing `evaluate()` function makes mode-level decisions (Solar Charging, Greenhouse Heating, etc.) and sets valve/actuator states as a package. Manual override needs granular per-relay control, which is fundamentally different from mode-based automation. Skipping `evaluate()` when `mo` is active is cleaner than adding manual-override awareness to the pure control logic. The safety suppression flag (`mo.ss`) maps directly to the existing `safetyOverride` mechanism — when `ss=false` (default), freeze/overheat conditions still trigger `evaluate()` with `safetyOverride=true`, interrupting the manual session.

**Alternatives considered**:
- **Add a "MANUAL" mode to control-logic.js**: Would violate the pure logic separation principle — manual override is an I/O concern, not a decision logic concern. Rejected.
- **Use forced mode (fm) with individual relay HTTP commands**: Forced mode sets entire mode valve patterns, not individual relays. Doesn't support granular control. Rejected.

## R4: Device Config Extension — Compact Format for Manual Override

**Decision**: Extend the device config with a `mo` (manual override) field: `{mo: {a: true, ex: 1712505600, ss: false}}` where `a` = active, `ex` = expiry unix timestamp (seconds), `ss` = suppress safety overrides. When `mo` is null or `mo.a` is false, the system operates normally. The server sets `ex` based on current time + TTL when entering override. The device checks `ex` against its own clock on every control loop iteration and autonomously clears `mo` when expired.

**Rationale**: Reuses the existing device config MQTT channel (`greenhouse/config`, QoS 1, retained) for override state. The compact key format (`mo`, `a`, `ex`, `ss`) fits within the Shelly KVS 256-byte limit. Device-side expiry check in the existing control loop uses zero additional timers. The device's clock (synced via NTP) provides reliable timestamps for expiry comparison.

**Alternatives considered**:
- **Separate MQTT topic for override state**: Adds complexity — device would need to subscribe to another topic and merge state. Rejected.
- **Store override in a separate KVS key**: Adds KVS read complexity on device boot. Config is already loaded from KVS in a single read. Rejected.

## R5: WebSocket Bidirectional Communication

**Decision**: Add a `ws.on('message', handler)` in `server/server.js` to receive commands from the playground client. Command messages use the format `{type: 'relay-command', relay: string, on: boolean}` and `{type: 'override-enter', ttl: number, suppressSafety: boolean}` / `{type: 'override-exit'}`. The server validates commands, checks override state, and publishes to MQTT.

**Rationale**: WebSocket is already established for state broadcasts. Adding bidirectional messaging avoids extra HTTP round-trips. The server acts as a validation gateway — it checks that manual override is active before forwarding relay commands, preventing stale or unauthorized commands from reaching the device.

**Alternatives considered**:
- **HTTP REST endpoints for each command**: Higher latency per toggle. Rejected for the relay commands (acceptable for entering/exiting override).
- **Direct MQTT from browser**: Would require exposing MQTT broker to the internet. Security risk. Rejected.

## R6: Relay Command Processing on Shelly Device

**Decision**: Add a new MQTT subscription in `telemetry.js` for `greenhouse/relay-command`. The message is forwarded to `control.js` via `Shelly.emitEvent("relay_command", ...)`. In `control.js`, a new event handler processes relay commands by directly calling `setPump()`, `setFan()`, or `setValve()` — bypassing mode transitions. After actuation, `emitStateUpdate()` broadcasts the new state.

**Rationale**: Follows the existing pattern for MQTT command processing (sensor-config-apply, discover-sensors). The event-based architecture keeps telemetry.js focused on MQTT I/O and control.js focused on actuation logic. Direct relay function calls avoid the transition sequence (stop pump → close valves → open new valves → start pump) which would be inappropriate for individual relay testing.

**Alternatives considered**:
- **Queue commands like sensor-config-apply**: Adds latency — commands would wait until next control loop iteration (up to 30 seconds). Rejected for relay commands; immediate processing is required.
- **Process in telemetry.js directly**: Violates the separation between MQTT I/O (telemetry) and relay control (control.js). Rejected.

## R7: UI Design — Soundboard Layout in Stitch Design System

**Decision**: The relay toggle board is implemented as a CSS grid within the Device view (`#view-device`), positioned below the existing device config form. Each button is a large touch-friendly tile (minimum 64x64px) with the actuator label, current state indicator (color), and technical ID. The grid uses 2 columns on mobile, 4-5 columns on desktop. Buttons use the Stitch design system: gold (#e9c349) for ON state, muted gray for OFF, teal (#43aea4) for the override controls, error red for failure flash.

**Rationale**: Placing the toggle board in the existing Device view keeps all hardware control in one location. The soundboard metaphor maps naturally to a grid of same-sized buttons. The Stitch dark theme colors are already established and provide clear visual contrast between ON/OFF states.

**Alternatives considered**:
- **Separate view/tab for manual override**: Adds navigation complexity. The Device view already handles hardware config. Rejected.
- **Modal overlay**: Obscures the device config state. Rejected.
