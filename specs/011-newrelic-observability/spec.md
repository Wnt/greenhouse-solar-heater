# Feature Specification: New Relic Observability

**Feature Branch**: `011-newrelic-observability`
**Created**: 2026-03-24
**Status**: Draft
**Input**: User description: "add New Relic tracing to the app and upcloud docker host with log ingestion, APM traces, metrics"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Application Traces and Performance (Priority: P1)

As a system operator, I want to see distributed traces of every request flowing through the monitoring app so that I can identify slow requests, failed operations, and understand the timing breakdown of HTTP handling, database queries, and external calls (Shelly RPC proxying, S3 storage).

**Why this priority**: Traces are the core value proposition — they reveal what the app is doing, where time is spent, and where errors occur. Without traces, the other telemetry types lack context.

**Independent Test**: Can be verified by making requests to the monitor app and confirming that traces appear in New Relic with correct span hierarchy (HTTP → PostgreSQL query, HTTP → Shelly proxy call, etc.)

**Acceptance Scenarios**:

1. **Given** the monitor app is running with tracing enabled, **When** a user loads the dashboard, **Then** a trace appears in New Relic showing the HTTP request and any downstream database queries or device calls with timing for each span.
2. **Given** a request to the Shelly RPC proxy endpoint, **When** the request completes, **Then** the trace shows the outbound HTTP call to the Shelly device as a child span with its own duration.
3. **Given** a database query fails, **When** the error occurs, **Then** the trace captures the error status, error message, and marks the span as failed.

---

### User Story 2 - View Application Logs Correlated with Traces (Priority: P2)

As a system operator, I want application logs forwarded to New Relic and automatically linked to the traces that generated them, so that I can click from a slow trace directly into the relevant log entries without manually searching timestamps.

**Why this priority**: Logs add the "why" context to traces. Trace-log correlation is what makes debugging fast — you see a slow span and immediately read the associated log output.

**Independent Test**: Can be verified by triggering a request, finding the trace in New Relic, and confirming that correlated log entries appear alongside the trace with matching trace IDs.

**Acceptance Scenarios**:

1. **Given** the app emits structured JSON logs, **When** a request is processed, **Then** the log entries include the active trace ID and span ID and appear in New Relic linked to the corresponding trace.
2. **Given** an error occurs during request handling, **When** the operator views the error trace, **Then** the associated error log entries are accessible directly from the trace view.
3. **Given** the app is running normally, **When** the operator searches logs in New Relic, **Then** all application log output is available and searchable with structured fields (level, message, component).

---

### User Story 3 - Monitor Host and Container Health (Priority: P2)

As a system operator, I want to see the health of the UpCloud Docker host — CPU, memory, disk, network, and per-container resource usage — so that I can detect resource exhaustion, container restarts, or infrastructure problems before they affect the service.

**Why this priority**: Infrastructure metrics complement application traces. A slow trace might be caused by host-level resource contention, which is only visible through infrastructure monitoring.

**Independent Test**: Can be verified by checking New Relic for host metrics (CPU, memory, disk) and Docker container metrics (per-container CPU/memory for app, caddy, openvpn containers).

**Acceptance Scenarios**:

1. **Given** the infrastructure agent is running on the UpCloud host, **When** the operator opens the infrastructure view in New Relic, **Then** CPU utilization, memory usage, disk I/O, and network throughput are displayed with historical data.
2. **Given** Docker containers are running, **When** the operator views container metrics, **Then** per-container CPU and memory usage is visible for each service (app, caddy, openvpn).
3. **Given** the host disk usage exceeds 80%, **When** the threshold is crossed, **Then** the condition is visible in New Relic metrics for alerting purposes.

---

### User Story 4 - Monitor Application Runtime Metrics (Priority: P3)

As a system operator, I want Node.js runtime metrics (event loop lag, garbage collection, heap usage, active handles) reported to New Relic so that I can detect memory leaks, event loop blocking, or degraded application performance over time.

**Why this priority**: Runtime metrics catch slow-burn issues (memory leaks, GC pressure) that individual traces don't reveal. Lower priority because these issues are less common than request-level problems.

**Independent Test**: Can be verified by checking New Relic for Node.js runtime metric charts showing heap size, GC duration, and event loop lag over time.

**Acceptance Scenarios**:

1. **Given** the app is running with metrics export enabled, **When** the operator views the service in New Relic, **Then** Node.js heap usage, event loop lag, and GC pause duration are charted over time.
2. **Given** the app processes a burst of requests, **When** event loop lag increases, **Then** the metric is reflected in New Relic within the standard reporting interval.

---

### User Story 5 - Monitor PostgreSQL Database Health (Priority: P3)

As a system operator, I want to see PostgreSQL connection counts, query throughput, cache hit ratios, and table statistics from the UpCloud Managed PostgreSQL instance so that I can detect database performance issues and capacity problems.

**Why this priority**: Database health completes the observability picture. Individual query traces (from P1) show per-request timing, but aggregate database metrics reveal systemic issues like connection exhaustion or degraded cache performance.

**Independent Test**: Can be verified by checking New Relic for a PostgreSQL dashboard showing active connections, rows read/written, and buffer cache hit ratio.

**Acceptance Scenarios**:

1. **Given** the PostgreSQL integration is configured with a monitoring user, **When** the operator views the database dashboard in New Relic, **Then** connection count, query throughput, and cache hit ratio are displayed.
2. **Given** the database has active tables, **When** the operator views table statistics, **Then** table sizes, row counts, and index usage are visible.
3. **Given** the managed PostgreSQL instance is accessible only via connection string, **When** the integration runs, **Then** it connects remotely and collects metrics without requiring agent installation on the database server.

---

### Edge Cases

- What happens when the New Relic ingest endpoint is unreachable? Telemetry export must fail silently without affecting the application's normal operation (no crashes, no request delays).
- What happens when the New Relic free tier ingest limit is approached? The system should continue operating normally; data may be dropped by New Relic but the app must not be affected.
- What happens when the infrastructure agent cannot reach Docker's API? Container-level metrics are unavailable but host metrics and application telemetry continue independently.
- What happens when the PostgreSQL monitoring user lacks required permissions? The integration reports connection errors in its own logs without affecting the application's database connections.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST export distributed traces for all incoming HTTP requests, outgoing HTTP calls (Shelly proxy, S3), and PostgreSQL queries via auto-instrumentation.
- **FR-002**: System MUST forward application logs to New Relic with trace context (trace ID, span ID) embedded for correlation.
- **FR-003**: System MUST report Node.js runtime metrics (heap usage, event loop lag, GC statistics) to New Relic.
- **FR-004**: System MUST collect and report host-level infrastructure metrics (CPU, memory, disk, network) from the UpCloud server.
- **FR-005**: System MUST collect and report per-container resource metrics for all Docker Compose services.
- **FR-006**: System MUST collect PostgreSQL health metrics (connections, query throughput, cache hit ratio, table statistics) from the UpCloud Managed PostgreSQL instance via remote connection.
- **FR-007**: System MUST NOT degrade application performance or availability when telemetry export fails (network errors, service outages, rate limiting).
- **FR-008**: System MUST allow disabling telemetry collection entirely via configuration (for local development and environments without New Relic access).
- **FR-009**: The New Relic license key MUST be stored as a secret and MUST NOT appear in source code, configuration files committed to the repository, or container image layers.

### Key Entities

- **Trace**: A distributed trace representing a single request's journey through the application, composed of spans (HTTP handler, database query, external call).
- **Span**: A single unit of work within a trace, with timing, attributes (URL, query text, status code), and parent-child relationships.
- **Log Entry**: A structured log record (JSON) with severity, message, component name, and trace context for correlation.
- **Host Metric**: A time-series measurement of server resource utilization (CPU percentage, memory bytes, disk I/O, network bytes).
- **Container Metric**: A time-series measurement of Docker container resource usage (CPU, memory) identified by container/service name.
- **Database Metric**: A time-series measurement of PostgreSQL health (active connections, rows read/written, cache hit ratio).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All HTTP requests to the monitor app produce visible traces in New Relic within 60 seconds of the request completing.
- **SC-002**: Application logs appear in New Relic and are navigable from their associated trace within 2 minutes of being emitted.
- **SC-003**: Host CPU, memory, and disk metrics are visible in New Relic with data points at least every 60 seconds.
- **SC-004**: Per-container resource usage is visible for all running Docker Compose services.
- **SC-005**: PostgreSQL connection count and query throughput metrics are visible in New Relic for the managed database instance.
- **SC-006**: Application response times show no measurable degradation (less than 10ms added latency per request) with telemetry enabled versus disabled.
- **SC-007**: The application starts and operates normally when the New Relic ingest endpoint is unreachable.
- **SC-008**: All telemetry collection can be disabled with a single configuration change, with no telemetry-related errors in application logs when disabled.

## Assumptions

- The project uses the New Relic free tier (100GB/month ingest), which is sufficient for a single-service greenhouse monitoring app.
- The New Relic license key will be added to the secrets configuration (same pattern as existing S3 credentials) and passed to containers via environment variables.
- OpenTelemetry is used as the instrumentation layer, sending data to New Relic's OTLP-compatible endpoints. This avoids vendor lock-in — the same instrumentation works with any OTLP-compatible backend.
- The infrastructure agent runs as an additional container in the deployment stack, with access to the host's system information and container runtime for metric collection.
- The PostgreSQL integration connects remotely to the UpCloud Managed PostgreSQL instance using a dedicated read-only monitoring user with appropriate permissions.
- MQTT instrumentation is out of scope for auto-instrumentation (no official auto-instrumentation exists for the `mqtt` library). MQTT spans can be added manually in a future iteration if needed.

## Scope Boundaries

### In Scope
- Auto-instrumentation for the Node.js monitor app (traces, metrics, logs)
- Log forwarding with trace correlation
- Node.js runtime metrics export
- Infrastructure agent on the Docker host
- PostgreSQL integration for the managed database
- Configuration and secrets management for the New Relic license key
- Deployment configuration updates

### Out of Scope
- Custom MQTT span instrumentation (future enhancement)
- New Relic Synthetics / ping monitoring (can be configured in New Relic UI without code changes)
- Alerting policies and notification channels (configured in New Relic UI, not in code)
- Shelly device monitoring (devices run ES5 scripts with no telemetry capability)
- Playground app instrumentation (static SPA, no server-side component to trace)
