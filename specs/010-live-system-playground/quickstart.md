# Quickstart: Connect Playground to Live System

**Feature**: 010-live-system-playground

## Prerequisites

- Node.js 20 LTS
- Docker + Docker Compose v2 (for Mosquitto broker and PostgreSQL in dev)
- Shelly Pro 4PM with MQTT enabled in device settings
- VPN tunnel to Shelly LAN (for cloud deployment)
- Terraform >= 1.5 (for infrastructure provisioning)

## Local Development

### 1. Start MQTT broker and PostgreSQL with TimescaleDB

```bash
docker compose -f deploy/deployer/docker-compose.dev.yml up -d mosquitto postgres
```

Or manually:

```bash
# Mosquitto
docker run -d --name mosquitto -p 1883:1883 eclipse-mosquitto:2-openssl \
  mosquitto -c /dev/null -p 1883 -v

# PostgreSQL with TimescaleDB
docker run -d --name timescaledb -p 5432:5432 \
  -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=greenhouse \
  timescale/timescaledb:latest-pg16
```

### 2. Install dependencies

```bash
npm install
```

New dependencies: `pg`, `mqtt`, `ws`

### 3. Initialize the database schema

```bash
DATABASE_URL=postgres://postgres:dev@localhost:5432/greenhouse node monitor/lib/db.js --init
```

This creates the hypertables, continuous aggregates, and retention policies.

### 4. Start the server

```bash
DATABASE_URL=postgres://postgres:dev@localhost:5432/greenhouse \
MQTT_HOST=127.0.0.1 \
node monitor/server.js
```

The server subscribes to MQTT on `greenhouse/state`, persists to PostgreSQL, and serves the playground at `http://localhost:3000/`.

### 5. Simulate MQTT messages (for testing without hardware)

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

### 6. Open the app

- `http://localhost:3000/` — playground with live mode toggle
- The app auto-detects local development (not GitHub Pages) and shows the live/simulation toggle

## Running Tests

```bash
npm run test:unit     # Unit tests (control logic, auth, storage, DB, MQTT bridge)
npm run test:e2e      # E2E tests (playground simulation + live mode)
npm test              # All tests
```

Unit tests for the DB module use a local PostgreSQL instance (same Docker container as dev).

## Infrastructure Provisioning

### Terraform (production)

The managed PostgreSQL database is provisioned alongside existing infrastructure:

```bash
cd deploy/terraform
terraform plan   # Review changes (new: managed database)
terraform apply  # Provision database + update cloud-init
```

New Terraform resources:
- `upcloud_managed_database_postgresql.timeseries` — PostgreSQL with TimescaleDB
- Database credentials output → injected into cloud-init `.env.secrets` as `DATABASE_URL`

### Deployment

The Mosquitto broker and server changes deploy via the existing CD pipeline:

1. Mosquitto container added to `deploy/deployer/docker-compose.yml`
2. Database connection via `DATABASE_URL` from `.env.secrets` (set during `terraform apply` → cloud-init)
3. Shelly Pro 4PM control script deployed remotely via VPN: deployer runs `shelly/deploy.sh --vpn` inside the VPN network namespace

### Remote Shelly Deployment

Shelly scripts are deployed via the VPN tunnel — no LAN/physical access required:

```bash
# From the cloud server (or deployer container in the VPN namespace):
DEPLOY_VIA_VPN=true bash shelly/deploy.sh

# Or manually with a VPN-routable IP:
bash shelly/deploy.sh 10.x.x.174
```

### Device Configuration

All actuator control is disabled by default. To enable controls after deployment:

```bash
# Enable all controls via the API:
curl -X PUT http://localhost:3000/api/device-config \
  -H "Content-Type: application/json" \
  -H "Cookie: session=<your-session>" \
  -d '{"controls_enabled": true, "enabled_actuators": {"valves": true, "pump": true, "fan": true, "space_heater": true, "immersion_heater": true}}'

# Check current config:
curl http://localhost:3000/api/device-config
```

The Shelly device fetches config on startup and every ~5 minutes. Config is persisted in KVS so the device can start without internet.

## Key Files (new/modified)

| File | Change |
|------|--------|
| `shelly/control.js` | Add MQTT.publish() calls, config fetch + KVS persistence, actuator enable guards |
| `shelly/control-logic.js` | evaluate() respects config.enabled flags |
| `shelly/deploy.sh` | Support VPN IPs, configure MQTT on device |
| `shelly/devices.conf` | Add VPN-reachable IPs |
| `monitor/server.js` | Add MQTT subscriber, WebSocket server, history API, device config API, serve playground |
| `monitor/lib/db.js` | NEW: PostgreSQL/TimescaleDB module (schema, insert, query) |
| `monitor/lib/mqtt-bridge.js` | NEW: MQTT subscription + WebSocket broadcast |
| `monitor/lib/device-config.js` | NEW: Device configuration store (S3/local persistence) |
| `playground/js/data-source.js` | NEW: DataSource abstraction (SimulationSource, LiveSource) |
| `playground/index.html` | Data source toggle, deployment detection, WebSocket client |
| `deploy/terraform/main.tf` | Add managed PostgreSQL resource |
| `deploy/terraform/variables.tf` | Add db_plan variable |
| `deploy/terraform/outputs.tf` | Add database connection outputs |
| `deploy/terraform/cloud-init.yaml` | Add DATABASE_URL to .env.secrets |
| `deploy/deployer/docker-compose.yml` | Add Mosquitto service |
| `deploy/deployer/deploy.sh` | Add Shelly script deployment step (via VPN) |
