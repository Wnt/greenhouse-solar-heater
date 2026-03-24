# Quickstart: Connect Playground to Live System

**Feature**: 010-live-system-playground

## Prerequisites

- Node.js 20 LTS
- Docker + Docker Compose v2 (for Mosquitto broker in dev)
- Shelly Pro 4PM with MQTT enabled in device settings
- VPN tunnel to Shelly LAN (for cloud deployment)

## Local Development

### 1. Start MQTT broker

```bash
docker run -d --name mosquitto -p 1883:1883 eclipse-mosquitto:2-openssl \
  mosquitto -c /dev/null -p 1883 -v
```

### 2. Install dependencies

```bash
npm install
```

New dependencies: `better-sqlite3`, `mqtt`, `ws`

### 3. Start the server

```bash
MQTT_HOST=127.0.0.1 node monitor/server.js
```

The server subscribes to MQTT on `greenhouse/state` and serves the playground at `http://localhost:3000/`.

### 4. Simulate MQTT messages (for testing without hardware)

```bash
# Publish a test state snapshot
mosquitto_pub -h 127.0.0.1 -t greenhouse/state -r -m '{
  "ts": 1711296000000,
  "mode": "idle",
  "transitioning": false,
  "transition_step": null,
  "temps": {"collector": 25, "tank_top": 40, "tank_bottom": 35, "greenhouse": 18, "outdoor": 12},
  "valves": {"vi_btm": false, "vi_top": false, "vi_coll": false, "vo_coll": false, "vo_rad": false, "vo_tank": false, "v_ret": false, "v_air": false},
  "actuators": {"pump": false, "fan": false, "space_heater": false, "immersion_heater": false},
  "flags": {"collectors_drained": false, "emergency_heating_active": false}
}'
```

### 5. Open the app

- `http://localhost:3000/` — playground with live mode toggle
- The app auto-detects local development (not GitHub Pages) and shows the live/simulation toggle

## Running Tests

```bash
npm run test:unit     # Unit tests (control logic, auth, storage, MQTT bridge)
npm run test:e2e      # E2E tests (playground simulation + live mode)
npm test              # All tests
```

## Deployment

The Mosquitto broker, SQLite database, and server changes deploy via the existing CD pipeline:

1. Mosquitto container added to `deploy/deployer/docker-compose.yml`
2. SQLite database file stored in a named volume + periodic S3 backup
3. Shelly Pro 4PM MQTT enabled and control script updated via `shelly/deploy.sh`

## Key Files (new/modified)

| File | Change |
|------|--------|
| `shelly/control.js` | Add MQTT publishing after each poll cycle and on transitions |
| `monitor/server.js` | Add MQTT subscriber, WebSocket server, history API, SQLite integration |
| `monitor/lib/db.js` | SQLite database module (schema, insert, query, downsampling) |
| `playground/js/data-source.js` | DataSource abstraction (SimulationSource, LiveSource) |
| `playground/index.html` | Data source toggle, deployment detection, WebSocket client |
| `deploy/deployer/docker-compose.yml` | Add Mosquitto service |
