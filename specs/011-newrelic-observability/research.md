# Research: New Relic Observability

## R1: OpenTelemetry SDK for Node.js — Package Selection

**Decision**: Use `@opentelemetry/sdk-node` with `@opentelemetry/auto-instrumentations-node` for automatic HTTP, `pg`, and AWS SDK tracing. Use OTLP HTTP exporters for traces, metrics, and logs.

**Rationale**: The `@opentelemetry/sdk-node` is the official all-in-one SDK that bundles resource detection, span processors, and provider registration. The auto-instrumentation meta-package covers all libraries used by the app (`http`, `pg`, `@aws-sdk/client-s3`, `dns`, `net`). OTLP/HTTP is the recommended export protocol for New Relic and works with any OTLP-compatible backend.

**Alternatives considered**:
- New Relic's proprietary Node.js agent (`newrelic` npm package) — vendor lock-in, heavier, not OTel-native
- Manual instrumentation only — too much work, miss automatic HTTP/PG spans
- `@opentelemetry/sdk-trace-node` alone — lower-level, requires manual provider setup

**Packages to add**:
```
@opentelemetry/sdk-node
@opentelemetry/auto-instrumentations-node
@opentelemetry/exporter-trace-otlp-http
@opentelemetry/exporter-metrics-otlp-http
@opentelemetry/exporter-logs-otlp-http
@opentelemetry/api
```

## R2: Tracing Init Pattern — `--require` Preload

**Decision**: Create `monitor/lib/tracing.js` and load it via `node --require ./monitor/lib/tracing.js monitor/server.js`. The tracing module must initialize before any other `require()` calls so auto-instrumentation can monkey-patch `http`, `pg`, etc.

**Rationale**: OpenTelemetry auto-instrumentation works by patching module exports at require-time. If `http` or `pg` is required before the SDK initializes, those modules won't be instrumented. The `--require` flag ensures tracing initializes first, before `server.js` runs any requires.

**Alternatives considered**:
- `require('./lib/tracing')` at top of server.js — works but fragile; any module loaded before it (even transitively) won't be instrumented
- `NODE_OPTIONS=--require` env var — equivalent to CLI flag but harder to debug

**Graceful degradation**: If `NEW_RELIC_LICENSE_KEY` is not set, `tracing.js` exits early with no SDK initialization. Zero overhead, no errors.

## R3: New Relic License Key Persistence — S3 Bootstrap Pattern

**Decision**: Follow the exact same pattern as DATABASE_URL persistence (Constitution principle VII):
1. Add `new_relic_license_key` Terraform variable (sensitive, default "")
2. Add `null_resource.store_nr_key` that runs `node monitor/lib/nr-config.js store <key>` to put it in S3 as `newrelic-config.json`
3. Deployer fetches from S3 via `node monitor/lib/nr-config.js load` and adds `NEW_RELIC_LICENSE_KEY` to `.env`
4. App reads `NEW_RELIC_LICENSE_KEY` from env; if absent, tracing disabled

**Rationale**: This is the established pattern for post-bootstrap secrets (see `db-config.js` and `null_resource.store_db_url`). It avoids changing cloud-init (which would force server recreation). The key persists in S3 and survives server recreation.

**Alternatives considered**:
- Add to cloud-init `.env.secrets` — violates Constitution VII, forces server recreation
- Manual upload to S3 — error-prone, not reproducible
- Terraform output + manual `.env` editing — doesn't survive redeployment

**Enablement flow**: `terraform apply -var="new_relic_license_key=NRAK-..."` → stored in S3 → deployer picks it up within 5 minutes → app restarts with tracing enabled.

## R4: Log Forwarding with Trace Correlation

**Decision**: Modify `monitor/lib/logger.js` to inject OpenTelemetry trace context (`trace.id`, `span.id`) into every log entry when tracing is active. Use `@opentelemetry/exporter-logs-otlp-http` to forward logs to New Relic.

**Rationale**: New Relic correlates logs with traces using the `trace.id` field. The existing logger outputs JSON to stdout/stderr. Adding trace context fields to each log entry enables click-through from traces to logs in New Relic's UI.

**Alternatives considered**:
- New Relic Infrastructure agent log forwarding (tail files) — doesn't inject trace context
- Replace logger with pino + OTel pino instrumentation — unnecessary refactor, existing logger works fine
- Log API direct push — adds another dependency, OTLP log exporter is standard

**Implementation**: Use `@opentelemetry/api` to get the active span context in the logger. If tracing is not initialized, the API returns a no-op context (zero overhead).

## R5: MQTT Manual Span Creation

**Decision**: Add ~5 lines to `monitor/lib/mqtt-bridge.js` wrapping `mqtt.connect()`, `client.subscribe()`, `client.publish()`, and the `message` event handler with manual spans using `@opentelemetry/api`.

**Rationale**: The `mqtt` npm library has no official OpenTelemetry auto-instrumentation. Manual spans make MQTT operations visible in traces. The OTel API is a no-op when no SDK is registered, so the spans add zero overhead when tracing is disabled.

**Span design**:
- `mqtt.connect` — span around connection attempt
- `mqtt.subscribe` — span for topic subscription
- `mqtt.publish` — span for config publish
- `mqtt.message` — span wrapping `handleStateMessage` per incoming message

## R6: New Relic Infrastructure Agent

**Decision**: Add `newrelic/infrastructure:latest` as a Docker Compose service with access to `/sys`, `/proc`, `/etc` (read-only), and the Docker socket for container metrics.

**Rationale**: The infra agent is the standard way to get host-level metrics (CPU, memory, disk, network) and Docker container metrics into New Relic. It runs as a privileged container (needs host PID namespace and volume mounts).

**Configuration**: Requires `NRIA_LICENSE_KEY` env var (same New Relic license key). Set `NRIA_DISPLAY_NAME` to the server hostname for identification.

## R7: PostgreSQL Integration (nri-postgresql)

**Decision**: Add `newrelic/infrastructure-bundle:latest` which includes nri-postgresql, configured to connect remotely to the UpCloud Managed PostgreSQL instance.

**Rationale**: The infrastructure bundle image includes all New Relic on-host integrations including PostgreSQL. It connects via the standard PostgreSQL connection string and queries `pg_stat_*` views for metrics. No agent needed on the managed DB server.

**Requirements**: A PostgreSQL user with `pg_monitor` role. This can be the existing app user (already has access) or a dedicated monitoring user for least-privilege. The managed PG instance already accepts connections from the UpCloud server's private network.

**Decision on user**: Use the existing database connection (same `DATABASE_URL`). Creating a separate monitoring user on UpCloud Managed PostgreSQL requires API access or console — unnecessary complexity for a single-user system. The app user already has read access to `pg_stat_*` views.

## R8: Graceful Degradation When No License Key

**Decision**: All telemetry components check for `NEW_RELIC_LICENSE_KEY` at startup. If absent:
- `tracing.js`: exits immediately, no SDK initialized, `@opentelemetry/api` returns no-op spans
- `logger.js`: trace context injection returns empty values (no-op)
- `mqtt-bridge.js`: manual spans are no-ops (OTel API behavior)
- Infrastructure agent container: not started (Docker Compose profiles or conditional in deployer)
- nri-postgresql container: not started

**Rationale**: The app must work identically with and without New Relic. Local development never has a license key. The OTel API is designed for this — when no provider is registered, all operations are no-ops.

**Implementation for infra containers**: Use Docker Compose `profiles` — the infra agent and PG integration containers only start when explicitly activated. The deployer checks for `NEW_RELIC_LICENSE_KEY` in `.env` and adds `--profile monitoring` to the `docker compose up` command if present.
