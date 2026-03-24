# Data Model: New Relic Observability

## Entities

### NewRelicConfig (S3 persisted)

S3 object key: `newrelic-config.json`

```json
{
  "licenseKey": "NRAK-XXXXXXXXXXXXXXXXXXXXXXXXXXXX"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| licenseKey | string | yes | New Relic ingest license key (NRAK-...) |

**Lifecycle**: Created by Terraform `null_resource` when `new_relic_license_key` variable is set. Read by deployer on each deploy cycle. Persists in S3 across server recreation.

**Deletion**: Removing the key from Terraform vars and running `terraform apply` does NOT delete the S3 object (Terraform doesn't manage S3 object lifecycle directly). To disable, set the variable to empty string — the helper stores it, deployer reads empty, and tracing remains disabled.

### Environment Variables (runtime)

| Variable | Source | Default | Description |
|----------|--------|---------|-------------|
| `NEW_RELIC_LICENSE_KEY` | Deployer (from S3) | empty | New Relic ingest key. If empty/absent, all telemetry disabled |
| `OTEL_SERVICE_NAME` | config.env | `greenhouse-monitor` | Service name in New Relic |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | config.env | `https://otlp.nr-data.net` | New Relic OTLP endpoint (EU: `https://otlp.eu01.nr-data.net`) |
| `NRIA_LICENSE_KEY` | Deployer (same as above) | empty | Infra agent license key (same key) |

### Docker Compose Profiles

| Profile | Containers | Activated when |
|---------|-----------|----------------|
| (default) | app, mosquitto, caddy, openvpn | Always |
| monitoring | newrelic-infra, nri-postgresql | `NEW_RELIC_LICENSE_KEY` present in `.env` |

## Configuration Flow

```
Terraform apply (with new_relic_license_key)
  → null_resource runs: node monitor/lib/nr-config.js store "NRAK-..."
    → S3: PUT newrelic-config.json {"licenseKey": "NRAK-..."}

Deployer runs (every 5 min)
  → docker run ... node monitor/lib/nr-config.js load
    → S3: GET newrelic-config.json
    → stdout: "NRAK-..."
  → Adds NEW_RELIC_LICENSE_KEY=NRAK-... to .env
  → Adds NRIA_LICENSE_KEY=NRAK-... to .env
  → docker compose up -d --profile monitoring (if key present)
    OR docker compose up -d (if key absent — no monitoring containers)

App starts
  → node --require ./monitor/lib/tracing.js monitor/server.js
  → tracing.js checks NEW_RELIC_LICENSE_KEY
    → If set: init OTel SDK, register providers, start exporters
    → If empty: exit immediately, no-op
```

## State Transitions

```
No key configured → terraform apply -var="new_relic_license_key=NRAK-..."
  → Key stored in S3
  → Within 5 min: deployer picks up key, restarts containers with monitoring profile
  → Telemetry flows to New Relic

Key configured → terraform apply -var="new_relic_license_key="
  → Empty key stored in S3
  → Within 5 min: deployer reads empty, omits from .env, restarts without monitoring profile
  → Telemetry stops, app operates normally
```
