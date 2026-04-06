# Research: Configure Sensor Connectors

**Date**: 2026-04-06  
**Feature**: 018-configure-sensor-connectors

## Research Questions & Findings

### R1: Shelly RPC API for 1-Wire Sensor Discovery

**Decision**: Use `SensorAddon.OneWireScan` for discovery and `SensorAddon.*Peripheral` methods for configuration.

**Rationale**: The Shelly Gen2/Gen3 Plus Add-on provides a complete RPC API for 1-Wire sensor management:

- **`SensorAddon.OneWireScan`** — Scans the 1-Wire bus, returns all connected DS18B20 sensors with their hardware addresses and current component binding (if any).
- **`SensorAddon.GetPeripherals`** — Lists all configured peripheral-to-component mappings.
- **`SensorAddon.AddPeripheral`** — Binds a 1-Wire address to a temperature component ID (100+). Accepts `type: "ds18b20"`, `attrs.addr` (required), and `attrs.cid` (optional, auto-assigned if omitted).
- **`SensorAddon.UpdatePeripheral`** — Changes the 1-Wire address bound to an existing component.
- **`SensorAddon.RemovePeripheral`** — Unbinds a sensor from a component, removing the temperature component.

**Key detail**: Add-on peripheral component IDs use the **100-199 range** (100, 101, 102...). The current `control.js` uses IDs 0-4, which are placeholder values that don't match the actual Add-on component numbering. This feature must update the control system to use the correct IDs from the applied configuration.

**1-Wire address format**: Colon-separated hex bytes, e.g., `"40:255:100:6:199:204:149:177"` (8 bytes).

**Alternatives considered**:
- Manual RPC calls by operator — rejected: error-prone, requires Shelly API knowledge
- Direct `Temperature.SetConfig` — rejected: addr is not configurable via this method; must use `SensorAddon.*` methods

### R2: Sensor Configuration Persistence Strategy

**Decision**: Create a dedicated `sensor-config` store (separate from `device-config`) using the same S3/local persistence pattern.

**Rationale**: The sensor mapping configuration has different characteristics from the device config:
- It's larger (7 sensors with addresses, host IPs, component IDs) — likely exceeds the 256-byte KVS limit if embedded in device config.
- It changes infrequently (only during commissioning or sensor replacement).
- It needs to be readable by the control script to determine polling targets.

The sensor config will be persisted server-side (S3/local, same as device-config) and delivered to the Shelly control device via MQTT (`greenhouse/sensor-config` topic, retained). The telemetry script stores it in a separate KVS key (`sensor_config`), and the control script loads it at boot and on config change events.

**Alternatives considered**:
- Embed in device-config — rejected: exceeds KVS 256-byte target, mixes concerns
- Store only on sensor hosts — rejected: control system also needs the mapping for polling
- Store in system.yaml — rejected: system.yaml is for hardware specs, not runtime config

### R3: Control Script Sensor Routing Architecture

**Decision**: Replace hardcoded `SENSOR_IP` and `SENSOR_IDS` with a dynamic sensor config loaded from KVS, supporting multiple sensor hosts.

**Rationale**: The current control script polls all sensors from one IP (`192.168.30.20`) using sequential IDs (0-4). With sensors across two hosts and Add-on component IDs in the 100+ range, the polling logic must be dynamic.

New sensor config format for KVS (compact, ES5-compatible):
```javascript
// sensor_config KVS value
{
  "s": {                          // sensors map
    "collector": {"h": 0, "i": 100},    // host index 0, component id 100
    "tank_top": {"h": 0, "i": 101},
    "tank_bottom": {"h": 0, "i": 102},
    "greenhouse": {"h": 0, "i": 103},
    "outdoor": {"h": 0, "i": 104},
    "radiator_in": {"h": 1, "i": 100},  // host index 1
    "radiator_out": {"h": 1, "i": 101}
  },
  "h": ["192.168.30.20", "192.168.30.21"],  // host IPs by index
  "v": 1                                     // version
}
```

This keeps the KVS payload compact (~250 bytes for 7 sensors) while supporting multi-host routing.

**Changes to control.js**:
1. Remove hardcoded `SENSOR_IP` and `SENSOR_IDS`
2. Load sensor config from KVS at boot (alongside device config)
3. Build polling list from config: for each sensor, resolve host IP + component ID
4. `pollSensor()` URL becomes: `http://{hosts[sensor.h]}/rpc/Temperature.GetStatus?id={sensor.i}`
5. Listen for `sensor_config_changed` events from telemetry script
6. Fallback: if no sensor config in KVS, skip polling (safe — all temps null → IDLE mode)

**Alternatives considered**:
- Hardcode two sensor IPs — rejected: inflexible, doesn't support future changes
- Query all hosts and auto-discover — rejected: adds latency to every poll cycle

### R4: Server RPC Proxy Extension for Sensor Hosts

**Decision**: Extend the existing RPC proxy to accept a `_host` parameter for targeting sensor hosts, with an allowlist of valid IPs.

**Rationale**: The current proxy hardcodes `CONTROLLER_IP` for all RPC calls. The sensor configuration UI needs to call `SensorAddon.OneWireScan` and `SensorAddon.*Peripheral` on sensor host devices. Rather than creating separate endpoints, extending the existing proxy with a `_host` override (already filtered from params at line 151 of server.js) keeps the architecture simple.

The allowlist includes `CONTROLLER_IP` plus sensor host IPs from a new `SENSOR_HOST_IPS` environment variable (comma-separated). This prevents the proxy from being used to reach arbitrary hosts.

**Alternatives considered**:
- Dedicated `/api/sensor-hosts/:ip/rpc/*` endpoint — rejected: duplicates proxy logic
- Client-side direct calls to sensor hosts — rejected: only works on LAN, not through VPN/cloud

### R5: Sensor Host Configuration Ownership Model

**Decision**: The system fully owns sensor host configuration. On apply, all existing peripherals are removed and re-added from the assignment map.

**Rationale**: Per the clarification, the system has total ownership. The simplest approach to ensure consistency is:
1. Call `SensorAddon.GetPeripherals` to discover existing bindings
2. Call `SensorAddon.RemovePeripheral` for each existing binding
3. Call `SensorAddon.AddPeripheral` for each sensor assigned to this host
4. This ensures no stale addresses remain and no duplicates across hosts

The apply operation targets each host independently (best-effort), reports per-host success/failure, and allows retry.

**Alternatives considered**:
- Incremental update (only change what's different) — rejected: more complex, harder to ensure consistency, doesn't handle the "move sensor between hosts" case cleanly
- Use `UpdatePeripheral` for existing + Add for new — rejected: more API calls, same net result

### R6: UI Integration Approach

**Decision**: Add a new "Sensors" view to the playground SPA (hash route `#sensors`), available only in live mode.

**Rationale**: The sensor configuration workflow is distinct from the Device config view (which manages control logic parameters). It deserves its own view because:
- It has its own discovery/scan interaction pattern (poll sensor hosts)
- It requires a drag-and-drop or assignment UI that doesn't fit the toggle/dropdown pattern of Device view
- It's a commissioning-time tool, not a daily operations view

The view follows the existing playground architecture: hash-routed, Stitch dark theme, responsive layout, live-mode only.

**Alternatives considered**:
- Embed in Device view — rejected: too different in interaction pattern and purpose
- Separate HTML page — rejected: breaks SPA pattern, duplicates navigation/auth
