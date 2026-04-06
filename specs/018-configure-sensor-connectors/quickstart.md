# Quickstart: Configure Sensor Connectors

**Date**: 2026-04-06  
**Feature**: 018-configure-sensor-connectors

## Prerequisites

- Node.js 20 LTS
- Shelly 1 Gen3 devices with Plus Add-on (or mock/test setup)
- Existing playground and server running (`node server/server.js`)

## Development Setup

1. **Set sensor host IPs** in your environment:
   ```bash
   export SENSOR_HOST_IPS=192.168.30.20,192.168.30.21
   ```

2. **Start the server** (local mode, no auth):
   ```bash
   node server/server.js
   ```

3. **Open playground** at `http://localhost:3000/#sensors`

## Key Files to Modify

| Area | File | Change |
|------|------|--------|
| Server: sensor config store | `server/lib/sensor-config.js` | New file — S3/local persistence, API handlers |
| Server: RPC proxy extension | `server/server.js` | Add `_host` allowlist, register sensor-config routes |
| Server: MQTT publishing | `server/lib/mqtt-bridge.js` | Add `publishSensorConfig()` method |
| Shelly: telemetry | `shelly/telemetry.js` | Subscribe to `greenhouse/sensor-config`, persist to KVS |
| Shelly: control | `shelly/control.js` | Replace hardcoded SENSOR_IP/SENSOR_IDS with dynamic config from KVS |
| UI: sensors view | `playground/index.html` | New `#sensors` hash-routed view |
| UI: sensors logic | `playground/js/sensors.js` | New ES module — scan, assign, apply logic |
| Tests: sensor config | `tests/sensor-config.test.js` | Unit tests for config store |
| Tests: control script | `tests/control-logic.test.js` | Update for dynamic sensor routing |
| Tests: e2e | `tests/e2e/sensor-config.spec.js` | E2E tests for sensors view |
| Config: K8s | `deploy/terraform/main.tf` | Add `SENSOR_HOST_IPS` to ConfigMap |

## Testing

```bash
npm run test:unit     # Unit tests including new sensor-config tests
npm run test:e2e      # E2E tests including new sensor-config view tests
npm test              # Full suite
```

## Commissioning Workflow (User Flow)

1. Open `#sensors` view in playground (live mode)
2. System scans both sensor hosts and displays detected sensors
3. Plug in one sensor at a time
4. Identify each sensor by warming it (temperature rises in UI)
5. Assign detected sensor to the correct role (e.g., "Collector Outlet")
6. Repeat for all sensors
7. Click "Apply" to push configuration to sensor hosts and control system
8. Verify all roles show correct temperatures
