# Quickstart: MQTT-Only Shelly Communication API

**Feature**: 019-mqtt-only-shelly-api | **Date**: 2026-04-06

## What This Feature Changes

Removes all direct HTTP RPC calls from the cloud server to Shelly devices. After this change, the server communicates with the Shelly controller exclusively through MQTT topics. The controller handles all local-network operations (sensor polling, valve control, sensor discovery, sensor config apply) autonomously.

## Architecture Before → After

### Before
```
Server ──HTTP RPC──→ Shelly Controller (Script.Eval polling)
Server ──HTTP RPC──→ Sensor Hosts (SensorAddon.* for discovery/apply)
Server ←──MQTT────── Shelly Controller (state snapshots)
Server ──MQTT──────→ Shelly Controller (device config, sensor config)
```

### After
```
Server ←──MQTT────── Shelly Controller (state snapshots)
Server ──MQTT──────→ Shelly Controller (device config, sensor config)
Server ──MQTT──────→ Shelly Controller (discovery requests, config-apply requests)
Server ←──MQTT────── Shelly Controller (discovery results, config-apply results)
         Controller ──HTTP RPC──→ Sensor Hosts (local network only)
```

## MQTT Topics

| Topic | Direction | Purpose | QoS | Retain |
|-------|-----------|---------|-----|--------|
| `greenhouse/state` | Controller → Server | State snapshots | 1 | Yes |
| `greenhouse/config` | Server → Controller | Device config | 1 | Yes |
| `greenhouse/sensor-config` | Server → Controller | Sensor assignments | 1 | Yes |
| `greenhouse/sensor-config-apply` | Server → Controller | Apply sensor config to hosts | 1 | No |
| `greenhouse/sensor-config-result` | Controller → Server | Apply results | 1 | No |
| `greenhouse/discover-sensors` | Server → Controller | Discovery request | 1 | No |
| `greenhouse/discover-sensors-result` | Controller → Server | Discovery results | 1 | No |

## Key Files to Modify

| File | Change |
|------|--------|
| `shelly/control.js` | Add handlers for discovery and config-apply requests |
| `shelly/telemetry.js` | Subscribe to new MQTT topics, forward to control script |
| `server/server.js` | Remove valve poller, remove RPC proxy, add discovery endpoint |
| `server/lib/mqtt-bridge.js` | Publish discovery/apply requests, subscribe to results |
| `server/lib/sensor-config.js` | Replace direct RPC with MQTT-based apply |
| `server/lib/valve-poller.js` | DELETE this file |
| `playground/js/sensors.js` | Update discovery to use new server API |

## Development Setup

```bash
# Run existing tests (should pass before starting)
npm run test:unit

# After making changes, run full suite
npm test

# Deploy to Shelly device (local network)
cd shelly && bash deploy.sh

# Deploy via VPN
DEPLOY_VIA_VPN=true bash shelly/deploy.sh
```

## Testing Strategy

1. **Unit tests**: New MQTT message handlers in control.js (discovery scan, config apply), updated sensor-config.js tests (MQTT flow instead of direct RPC), remove valve-poller tests
2. **Integration tests**: End-to-end MQTT message flow from server API → MQTT → controller → MQTT → server response
3. **E2E tests**: Sensor discovery UI triggers via new API path
4. **Manual verification**: Deploy to real hardware, verify 24h stability with no Script.Eval crashes
