# Quickstart: Enabling New Relic Observability

## Prerequisites

- A [New Relic account](https://newrelic.com/signup) (free tier: 100GB/month)
- Your New Relic **Ingest License Key** (found in New Relic → API Keys → INGEST - LICENSE)
- Terraform configured for this project (`cd deploy/terraform`)

## Enable Tracing

One command:

```bash
cd deploy/terraform
terraform apply -var="new_relic_license_key=NRAK-XXXXXXXXXXXXXXXXXXXX"
```

This stores the license key in S3 object storage. The deployer (runs every 5 minutes) will automatically:
1. Fetch the key from S3
2. Add it to the app environment
3. Start the monitoring containers (infrastructure agent + PostgreSQL integration)
4. Restart the app with OpenTelemetry tracing enabled

**What gets instrumented automatically:**
- All HTTP requests (incoming and outgoing Shelly proxy calls)
- PostgreSQL queries (via `pg` driver)
- S3 operations (via AWS SDK)
- MQTT operations (connect, subscribe, publish, message receive)
- Node.js runtime metrics (heap, GC, event loop)
- Host metrics (CPU, memory, disk, network)
- Docker container metrics (per-container CPU/memory)
- PostgreSQL database health (connections, throughput, cache ratio)

## Disable Tracing

```bash
cd deploy/terraform
terraform apply -var="new_relic_license_key="
```

The app continues to operate normally without tracing. No errors, no performance impact.

## EU Data Center

If your New Relic account is in the EU data center, update `OTEL_EXPORTER_OTLP_ENDPOINT` in `deploy/deployer/config.env`:

```
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.eu01.nr-data.net
```

## Local Development

No configuration needed. When `NEW_RELIC_LICENSE_KEY` is not set, all telemetry is disabled with zero overhead. The app runs identically to before this feature was added.

## Verify It Works

1. Wait ~5 minutes after `terraform apply` for the deployer to pick up the key
2. Open your New Relic account → **APM & Services**
3. Look for the `greenhouse-monitor` service
4. Click into it to see traces, logs, and metrics

## Architecture

```
terraform apply (license key)
     ↓
S3 Object Storage (newrelic-config.json)
     ↓ (deployer fetches every 5 min)
.env (NEW_RELIC_LICENSE_KEY=...)
     ↓
┌─────────────────────────────────────────────┐
│ Docker Compose                              │
│                                             │
│  app (Node.js + OTel SDK)                   │
│    → traces, logs, metrics → New Relic OTLP │
│                                             │
│  newrelic-infra (monitoring profile)        │
│    → host + container metrics → New Relic   │
│                                             │
│  nri-postgresql (monitoring profile)        │
│    → DB health metrics → New Relic          │
└─────────────────────────────────────────────┘
```
