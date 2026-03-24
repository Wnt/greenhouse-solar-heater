# Implementation Plan: New Relic Observability

**Branch**: `011-newrelic-observability` | **Date**: 2026-03-24 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-newrelic-observability/spec.md`

## Summary

Add full-stack observability to the greenhouse monitoring system via New Relic's free tier. The app gets OpenTelemetry auto-instrumentation (HTTP, PostgreSQL, S3) plus manual MQTT spans, with log forwarding and runtime metrics. The UpCloud Docker host gets a New Relic Infrastructure agent container for host/container metrics. PostgreSQL monitoring uses the nri-postgresql integration connecting remotely to the managed instance. The New Relic license key follows the established S3 bootstrap pattern (Terraform stores to S3, deployer fetches to `.env`). The system operates normally when no license key is configured.

## Technical Context

**Language/Version**: Node.js 20 LTS (CommonJS server, ES6+ browser modules)
**Primary Dependencies**: `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/exporter-logs-otlp-http`
**Storage**: UpCloud S3-compatible Object Storage (license key persistence), UpCloud Managed PostgreSQL with TimescaleDB
**Testing**: `node:test` (unit), Playwright (e2e) — existing test infrastructure
**Target Platform**: Linux server (UpCloud DEV-1xCPU-1GB-10GB, Ubuntu 24.04, Docker)
**Project Type**: Web service (Node.js HTTP server + MQTT bridge + WebSocket)
**Performance Goals**: <10ms added latency per request from telemetry overhead
**Constraints**: 1 CPU, 1GB RAM server; New Relic free tier 100GB/month ingest; no app degradation when telemetry unavailable
**Scale/Scope**: Single-service app, ~5 concurrent users, ~1 req/sec average

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as SSOT | **N/A** | No hardware changes |
| II. Pure Logic / IO Separation | **PASS** | Tracing is I/O layer — wraps existing I/O, does not modify pure control logic |
| III. Safe by Default (NON-NEGOTIABLE) | **PASS** | Telemetry is optional; app operates normally without it; no actuation changes |
| IV. Proportional Test Coverage | **PASS** | Will add unit tests for tracing initialization, graceful degradation, and MQTT spans |
| V. Token-Based Cloud Auth | **N/A** | No UpCloud API auth changes |
| VI. Durable Data Persistence | **PASS** | New Relic license key stored in S3 (same pattern as DATABASE_URL) |
| VII. No Secrets in Cloud-Init | **PASS** | License key stored in S3 via Terraform null_resource, NOT in cloud-init. Deployer fetches from S3 and injects into .env |

## Project Structure

### Documentation (this feature)

```text
specs/011-newrelic-observability/
├── plan.md              # This file
├── research.md          # Phase 0: technology decisions
├── data-model.md        # Phase 1: data/config model
├── quickstart.md        # Phase 1: how to enable tracing
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
monitor/
├── lib/
│   ├── tracing.js           # NEW — OTel SDK init, conditional on NEW_RELIC_LICENSE_KEY
│   ├── nr-config.js         # NEW — New Relic license key S3 persistence helper (CLI)
│   ├── mqtt-bridge.js       # MODIFIED — add manual MQTT spans (~5 lines)
│   ├── logger.js            # MODIFIED — inject trace context into log output
│   └── ...                  # existing files unchanged
├── server.js                # MODIFIED — preload tracing via --require

deploy/
├── terraform/
│   ├── main.tf              # MODIFIED — add null_resource for NR license key → S3
│   └── variables.tf         # MODIFIED — add new_relic_license_key variable
├── deployer/
│   ├── deploy.sh            # MODIFIED — fetch NR license key from S3 (same pattern as DB_URL)
│   ├── docker-compose.yml   # MODIFIED — add newrelic-infra + nri-postgresql containers
│   └── config.env           # MODIFIED — add OTEL_* and NR config vars
└── docker/
    └── Dockerfile           # MODIFIED — change CMD to use --require tracing.js

tests/
├── tracing.test.js          # NEW — unit tests for tracing init / graceful degradation
└── ...
```

**Structure Decision**: Follows existing project layout. New files are minimal: one tracing init module, one S3 persistence helper (matching `db-config.js` pattern), and one test file. Infrastructure changes extend existing Terraform, deployer, and Docker Compose files.

## Complexity Tracking

No constitution violations. No complexity justifications needed.
