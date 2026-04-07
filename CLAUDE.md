# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Solar thermal greenhouse heating system for Southwest Finland. The repo contains system specifications, Shelly control scripts, interactive browser-based simulators (playground), a Shelly platform linter, and documentation/diagrams.

## Mandatory: Keep CLAUDE.md Up to Date

**Before finishing any work in this repo, review this file and update it if your changes affect the project structure, file relationships, conventions, commands, or workflows described here.** This ensures CLAUDE.md remains an accurate guide for future sessions. If you added new directories, scripts, tools, tests, CI workflows, or conventions — document them here.

## Source of Truth

For the hardware system `system.yaml` is the **single authoritative source** for all specifications: component dimensions, heights, valve states, operating modes, sensor assignments, and Shelly relay mappings. All other documentation and diagrams are derived views of this file.

When making changes, **update system.yaml first**, then propagate to affected docs and diagrams.

## File Relationships

- `system.yaml` → authoritative specs (heights, valve states, modes, components)
- `shelly/` → Shelly device scripts and deployment tooling
- `shelly/lint/` → Shelly platform conformance linter (CLI, standalone package)
- `playground/` → main web app SPA (single-page app with 5 views: Status, Components, Schematic, Controls, Device). Deep-linkable via URL hash fragments (`#status`, `#schematic`, etc.). Protected by passkey auth in cloud mode.
- `playground/login.html` → passkey login page (WebAuthn registration + authentication)
- `playground/js/login.js` → passkey auth client-side logic
- `playground/vendor/simplewebauthn-browser.mjs` → vendored @simplewebauthn/browser 13.3.0
- `playground/vendor/qrcode-generator.mjs` → vendored qrcode-generator 2.0.4 (invitation QR codes)
- `server/` → Node.js API server (serves playground, WebSocket, MQTT bridge, auth, device config, sensor config, history). All device communication flows through MQTT — no direct HTTP RPC to Shelly devices.
- `server/auth/` → WebAuthn passkey authentication (credential store, session management, WebAuthn handlers, invitation-based registration)
- `server/lib/logger.js` → structured JSON logger (used by server and auth modules)
- `server/lib/s3-storage.js` → S3/local filesystem storage adapter (credentials persistence)
- `server/lib/vpn-config.js` → VPN config S3 persistence CLI (download/upload openvpn.conf)
- `server/lib/db.js` → PostgreSQL/TimescaleDB module (schema init, sensor readings, state events, history queries). Resolves DATABASE_URL from env or S3 (`database-url.json`)
- `server/lib/db-config.js` → Database URL S3 persistence CLI (store/load DATABASE_URL in object storage)
- `server/lib/nr-config.js` → New Relic license key S3 persistence CLI (store/load license key in object storage)
- `server/lib/tracing.js` → OpenTelemetry SDK initialization (loaded via `--require`, no-op when `NEW_RELIC_LICENSE_KEY` not set)
- `server/lib/mqtt-bridge.js` → MQTT-to-WebSocket bridge (subscribes greenhouse/state, broadcasts to WS clients, persists to DB, publishes config/discovery/apply requests, correlates MQTT responses)
- `server/lib/device-config.js` → Device configuration store (S3/local persistence, GET/PUT API, MQTT config push)
- `server/lib/sensor-config.js` → Sensor configuration store (S3/local persistence, sensor-to-role assignments, MQTT-based apply via controller, MQTT sensor config push)
- `deploy/` → cloud deployment infrastructure
- `deploy/terraform/` → UpCloud Managed Kubernetes cluster, Managed Object Storage, Managed PostgreSQL, K8s Secrets/ConfigMaps, Helm releases, CI/CD deployer RBAC (Terraform)
- `deploy/k8s/` → Kubernetes manifests: app Deployment (app + openvpn + mosquitto sidecar), Service, Ingress, deployer RBAC, kustomization.yaml
- `deploy/docker/` → App Dockerfile only
- `deploy/openvpn/` → OpenVPN sidecar: Dockerfile (Alpine + openvpn)
- `design/docs/` → prose docs: design.md, bom.md, commissioning-guide.md, ideas/, superpowers/
- `design/docs/pdf/` → PDF generation for commissioning guide (`node design/docs/pdf/generate-pdf.js` or `./generate-pdf.sh`). Uses Playwright to render styled HTML to A4 PDF with Stitch dark theme.
- `design/diagrams/` → hand-authored SVG with `data-` attributes + Mermaid control logic
- `design/construction/` → physical build instructions
- `design/photos/` → reference photos of owned components
- `tests/` → unit, simulation, auth, and e2e tests
- `.github/workflows/` → CI (test suite, GitHub Pages deploy, Shelly lint, CD deploy)
- `IDEAS.md` → raw ideas / wishlist

## Documentation Formats

- **YAML** for machine-readable specs — validate changes against this
- **Mermaid** for control logic (state machines, sequences) — renderable by GitHub
- **SVG** for physical layout — hand-crafted with height coordinates and `data-component`/`data-height` attributes; these are NOT generated, they are authored directly

## Key Architecture Concepts

- **Unpressurized system**: Jäspi tank is sealed but vented via an open reservoir connected to the dip tube port. The reservoir acts as an air separator — gas from the tank vents to atmosphere through the open reservoir top.
- **Communicating vessels**: Water level in reservoir equals water level at the dip tube opening inside the tank (~197cm). Gas is trapped above this level in the sealed tank.
- **Valve manifold**: 8 motorized on/off DN15 valves in input/output manifolds around a single pump. Three input valves (VI-btm, VI-top, VI-coll) and three output valves (VO-coll, VO-rad, VO-tank) plus two at collector top (V_ret, V_air).
- **Three operating modes**: Solar Charging (Mode 1), Greenhouse Heating (Mode 2), Active Drain (Mode 3). Each mode opens a specific subset of valves — see the `modes` section in system.yaml.
- **Safety rule**: Always stop pump BEFORE switching valves.

## Shelly Control Scripts

The `shelly/` directory contains the actual device scripts deployed to Shelly hardware:

- `shelly/control-logic.js` — Pure decision logic (ES5-compatible). Exports an `evaluate(state, config, deviceConfig)` function with no side effects and no Shelly API calls. This is the testable core. The `deviceConfig` parameter enables actuator suppression when controls are disabled.
- `shelly/control.js` — Shelly shell script that handles timers, RPC, relays, KVS, sensors, config guards, state event emission, and MQTT command execution (sensor config apply, sensor discovery). Imports `control-logic.js` (concatenated at deploy time). Reads device config from KVS. Processes pending MQTT commands (discovery, config apply) after each control cycle, executing SensorAddon RPC on the local network.
- `shelly/telemetry.js` — Separate Shelly script for MQTT publish/subscribe, config bootstrap (HTTP GET on boot), KVS config persistence, and inter-script events. Publishes state snapshots to `greenhouse/state`, subscribes to `greenhouse/config`, `greenhouse/sensor-config`, `greenhouse/sensor-config-apply`, and `greenhouse/discover-sensors`. Forwards MQTT commands to the control script and publishes results back.
- `shelly/deploy.sh` — Deploys scripts to the Shelly Pro 4PM via HTTP RPC. Deploys both control script (slot 1) and telemetry script (slot 3). Supports `DEPLOY_VIA_VPN=true` for VPN deployment. Can configure MQTT on the device via `MQTT_BROKER_HOST`.
- `shelly/devices.conf` — DHCP-reserved IP addresses for all Shelly devices. Includes `PRO4PM_VPN` for VPN-routable access.

**Shelly scripting constraints**: Scripts must use ES5-compatible JavaScript — no `const`/`let`, no arrow functions, no destructuring, no template literals, no ES6 classes. The linter enforces these rules.

## Shelly Linter

- **CLI tool**: `shelly/lint/` — standalone Node.js CLI (`node shelly/lint/bin/shelly-lint.js`). Uses Acorn for AST parsing. Has its own `package.json` with acorn and js-yaml dependencies.
- **CI**: `.github/workflows/lint-shelly.yml` runs the CLI linter on push/PR when `shelly/` files change.

## SVG Diagram Conventions

Static SVGs in `design/diagrams/` use a dark background (#0d1117). Playground inline SVGs use the Stitch dark theme (see Playground Architecture). Color coding for static diagrams:
- Blue (#42a5f5, #1565c0) = supply/cool water, tank
- Red (#ef5350, #e53935) = hot water, dip tube path
- Yellow (#f9a825) = solar collectors
- Green (#76ff03) = sensors, active/ON states
- Purple (#e040fb) = motorized valves
- Orange (#ff9800) = drain mode, service valves

Height scales in SVGs are approximate — `system-height-layout.svg` is the most precise for physical positioning.

## Playground Architecture

The `playground/` directory is the main web application — a solar heating monitoring and control system. Dark editorial theme based on the Stitch "Digital Sanctuary" design system (`design/Stitch/`): dark backgrounds (#0c0e12), gold primary (#e9c349), teal secondary (#43aea4), Newsreader serif headings, Manrope sans-serif body, tonal layering (no border lines for structure). Responsive: desktop sidebar nav (256px), mobile (<768px) glassmorphic bottom nav. Single HTML file with 5 hash-routed views, `<script type="importmap">` for ES modules. Deep-linkable via URL fragments (`#status`, `#components`, `#schematic`, `#controls`, `#device`).

- `playground/index.html` — single-page app: Status (default, bento grid dashboard), Components (sensors/valves/actuators), Schematic (SVG system visualization), Controls (sliders, reset), Device (runtime Shelly config with explanations). Floating play/pause FAB.
- `playground/login.html` — passkey login page (moved from monitor/)
- `playground/js/` — ES modules: physics, control (wrapper), control-logic-loader (ESM adapter for Shelly logic), data-source (LiveSource/SimulationSource abstraction), UI, yaml-loader, login (passkey auth), version-check (polls /version endpoint, shows update toast), sensors (sensor discovery, assignment, apply configuration)
- `playground/css/style.css` — shared styles
- `design/Stitch/` — Stitch UI design mockups (desktop + mobile) with DESIGN.md spec and code.html references

### Shared Control Logic

The playground simulator uses the **real Shelly control logic** (`shelly/control-logic.js`) at runtime. The file `playground/js/control-logic-loader.js` fetches the ES5 Shelly script via HTTP, evaluates it with a CommonJS `module` shim, and exposes the exports as an ES module. The `ControlStateMachine` class in `playground/js/control.js` is a thin stateful wrapper that translates playground sensor names to the Shelly state format and maintains transition logs — all mode decisions are delegated to the shared `evaluate()` function. This ensures the simulator always runs the exact same logic as the deployed hardware. **When changing control logic, only edit `shelly/control-logic.js`** — the playground picks it up automatically.

### Vendored Dependencies

All third-party libraries are vendored locally in `playground/vendor/` to avoid CDN/CORS issues in restricted environments (e.g. Claude Code web runtime, CI, offline):

- `playground/vendor/js-yaml.mjs` — js-yaml 4.1.0 (ESM), used by all playground pages
- `playground/vendor/simplewebauthn-browser.mjs` — @simplewebauthn/browser 13.3.0 (ESM, for passkey auth)
- `playground/vendor/qrcode-generator.mjs` — qrcode-generator 2.0.4 (ESM, for invitation QR codes)

**Do NOT replace these with CDN URLs.** The importmaps in each HTML file point to `./vendor/...` paths. If upgrading a dependency, download via `npm pack`, extract the dist files, and copy to `playground/vendor/`.

## Server

The `server/` directory contains the Node.js API server that serves the playground app, bridges MQTT to WebSocket, and provides authentication, device config, sensor config, sensor discovery, and history APIs. All device communication flows through MQTT — no direct HTTP RPC to Shelly devices.

- `server/server.js` — HTTP server: serves playground at `/`, auth middleware (when `AUTH_ENABLED=true`), WebSocket, device-config API, sensor-config API, sensor-discovery API, history API, health endpoint
- `server/auth/` — WebAuthn passkey auth: `credentials.js` (S3-backed store), `session.js` (HMAC cookies), `webauthn.js` (handlers), `invitations.js` (registration invitations)
- `server/lib/` — Shared libraries: logger, S3 storage adapter, database module, MQTT bridge, device config, sensor config, tracing, config CLIs (vpn-config, db-config, nr-config)

**Local mode**: `node server/server.js` — no auth, direct LAN access to Shelly devices.
**Cloud mode**: `AUTH_ENABLED=true RPID=domain ORIGIN=https://domain node server/server.js` — passkey auth required, VPN tunnel to reach devices.

## Testing Policy

**Bug fixes follow test-first workflow:**

1. **Write a failing test first** — an e2e or integration test that reproduces the bug
2. **Run it to confirm it fails** — this verifies you understood the problem correctly
3. **Implement the fix**
4. **Run the test again to confirm it passes**
5. **Commit both the test and the fix**

This applies to behavior changes too (e.g. removing auto-polling, changing error messages) — write the test for the new expected behavior first. Do not commit fixes without accompanying test additions — treat missing tests as an incomplete fix.

## Running Tests

```bash
npm test              # all tests: unit + simulation + e2e
npm run test:unit     # unit + simulation tests only (fast, no browser)
npm run test:e2e      # Playwright e2e tests only (requires Chromium)
npm run screenshots   # regenerate all screenshots (runs 24h simulation, ~1-2 min)
```

### Test Structure

- `tests/control-logic.test.js` — unit tests for the pure control logic (`shelly/control-logic.js`)
- `tests/playground-control.test.js` — unit tests for the playground control state machine (`playground/js/control.js`)
- `tests/auth.test.js` — unit tests for auth modules (session signing, credential store)
- `tests/s3-storage.test.js` — unit tests for S3 storage adapter (local fallback mode, S3 detection)
- `tests/vpn-config.test.js` — unit tests for VPN config S3 persistence helper
- `tests/db.test.js` — unit tests for PostgreSQL/TimescaleDB module (schema init, inserts, queries)
- `tests/tracing.test.js` — unit tests for OpenTelemetry tracing initialization, graceful no-op, MQTT spans, log trace context injection, nr-config S3 helper
- `tests/mqtt-bridge.test.js` — unit tests for MQTT bridge (state change detection, connection status)
- `tests/device-config.test.js` — unit tests for device config store (default config, CRUD, persistence)
- `tests/sensor-config.test.js` — unit tests for sensor config store (validation, compact format, assignments, persistence)
- `tests/device-config-integration.test.js` — integration tests: UI config format → Shelly control-logic interpretation (staged deployment scenarios)
- `tests/data-source.test.js` — unit tests for data source abstraction (state mapping, connection transitions)
- `tests/version-check.test.js` — unit tests for /version endpoint hash computation (determinism, change detection)
- `tests/simulation/` — thermal model and simulation scenario tests (`simulation.test.js`, `thermal-model.test.js`, `scenarios.js`, `simulator.js`, `thermal-model.js`)
- `tests/e2e/fixtures.js` — shared Playwright fixture: blocks Google Fonts for offline environments. **All e2e tests must import from this file, not from `@playwright/test`.**
- `tests/e2e/thermal-sim.spec.js` — Playwright e2e tests for the playground thermal simulation
- `tests/e2e/device-config.spec.js` — Playwright e2e tests for the Device config UI (toggle switches, dropdowns, checkboxes → compact JSON format)
- `tests/e2e/sensor-config.spec.js` — Playwright e2e tests for the Sensors config UI (detection, assignment, apply with mocked RPC)
- `tests/e2e/live-mode.spec.js` — Playwright e2e tests for live mode toggle, WebSocket connection, simulation fallback
- `tests/e2e/version-check.spec.js` — Playwright e2e tests for JS version check toast (appearance, editorial copy, dismiss, silent failure)
- `tests/e2e/take-screenshots.spec.js` — Screenshot generator: runs 24h simulation, captures all views (excluded from normal test runs via `testIgnore` in `playwright.config.js`, uses separate `playwright.screenshots.config.js`)

### Test Setup Notes

- **Playwright version**: Must match the cached Chromium browser revision. Currently `@playwright/test@1.56.0` matches `chromium-1194`. If you see "browser not found" errors, check `~/.cache/ms-playwright/` for available revisions and install the matching Playwright version.
- **Static server**: Tests use `npx serve` on port 3210 to serve the playground. The Playwright config auto-starts this server.
- **No `-s` flag on serve**: Do NOT use `serve -s` (SPA mode) — it breaks direct HTML file access by redirecting all routes.
- **Shared fixtures**: All e2e tests import `{ test, expect }` from `./fixtures.js` (NOT from `@playwright/test`). The fixture blocks Google Fonts requests to prevent page load hanging in offline/restricted environments. Always use `import { test, expect } from './fixtures.js'` when adding new e2e test files.
- Individual test timeouts are 30s. E2e tests verify the 2D SVG schematic and simulation behavior.

## CI / GitHub Actions

- `.github/workflows/ci.yml` — runs the full test suite (unit, simulation, auth, e2e) on every push. Triggers on `push` only (not `pull_request`) so tests run exactly once — opening a PR from an already-pushed branch does not re-trigger.
- `.github/workflows/deploy.yml` — CD pipeline: test → build app + openvpn images → push to GHCR → `kubectl set image` rolling update on UKS cluster → deploy Shelly scripts via `kubectl exec`. Triggers on push to main/master. Requires `KUBE_CONFIG_DATA` GitHub secret (base64-encoded deployer kubeconfig from Terraform output). The deployer ServiceAccount RBAC: can patch the `app` Deployment and exec into pods (for Shelly script deployment). The Shelly deploy step is non-fatal — failures don't block the pipeline.
- `.github/workflows/deploy-pages.yml` — deploys playground to GitHub Pages on push to main/master
- `.github/workflows/lint-shelly.yml` — runs Shelly linter on push/PR when `shelly/` files change

## Active Technologies
- Node.js 20 LTS (existing `server.js` uses CommonJS `http` module) + @simplewebauthn/server, @simplewebauthn/browser (vendored), Caddy (reverse proxy) (001-deploy-web-ui-cloud)
- JSON file for passkey credentials and sessions (single-user, no database) (001-deploy-web-ui-cloud)
- Node.js 20 LTS (CommonJS), Terraform >= 1.5 (HCL), Docker Compose v2 + @aws-sdk/client-s3 (new, for S3 persistence), Caddy 2-alpine, OpenVPN (Alpine, optional) (002-containerize-upcloud-deploy)
- UpCloud Managed Object Storage (S3-compatible, €5/month, 250GB min) (002-containerize-upcloud-deploy)
- Shell (deploy script), HCL (Terraform), YAML (cloud-init, compose), Dockerfile + `docker:cli` base image (Alpine + Docker CLI), Docker Compose v2, systemd (003-deployer-container-config)
- UpCloud Managed Object Storage (existing, for app credentials) (003-deployer-container-config)
- Node.js 20 LTS (CommonJS), POSIX shell (deployer) + `@aws-sdk/client-s3` (already in app image) (004-vpn-key-persistence)
- UpCloud Managed Object Storage (S3-compatible, existing bucket) (004-vpn-key-persistence)
- JavaScript ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + None new — uses existing auth endpoints and vendored libs (004-add-logout-feature)
- N/A (sessions already managed by existing credential store) (004-add-logout-feature)
- Node.js 20 LTS (CommonJS) + ES6+ browser modules + `web-push` (new, v3.6.7) + existing `@aws-sdk/client-s3`, `@simplewebauthn/server` (004-pwa-push-notifications)
- S3-compatible object storage (UpCloud Managed Object Storage) — two new keys: `push-config.json`, `push-subscriptions.json` (004-pwa-push-notifications)
- HCL (Terraform >= 1.5), POSIX shell (deployer), YAML (cloud-init, docker-compose) + UpCloud Terraform provider ~> 5.0, Docker Compose v2, systemd (005-fix-vpn-immutable-config)
- UpCloud Managed Object Storage (S3-compatible) for VPN config and credentials (005-fix-vpn-immutable-config)
- JavaScript ES5 (Shelly), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + @simplewebauthn/server, @aws-sdk/client-s3, web-push, Playwright, Acorn (linter) (006-organize-repo-structure)
- S3-compatible object storage (UpCloud), local filesystem fallback (006-organize-repo-structure)
- POSIX shell (setup script, deployer), HCL (Terraform >= 1.5), Node.js 20 LTS (vpn-config.js), YAML (docker-compose) + OpenVPN (Alpine package), Docker Compose v2, @aws-sdk/client-s3 (existing) (007-switch-to-openvpn)
- UpCloud Managed Object Storage (S3-compatible) for VPN config persistence (007-switch-to-openvpn)
- Node.js 20 LTS (CommonJS server-side), ES6+ browser modules + `@simplewebauthn/server` (existing), `@simplewebauthn/browser` (vendored, existing), `qrcode` (new, vendored browser bundle for QR generation) (008-add-passkey-registration)
- S3-compatible object storage for credentials (existing, unchanged schema); in-memory for invitations and rate limits (008-add-passkey-registration)
- JavaScript ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + None new — extends existing service worker and manifest (009-add-home-screen-support)
- N/A — no new persistent data (009-add-home-screen-support)
- JavaScript ES5 (Shelly scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + `better-sqlite3` (SQLite), `mqtt` (MQTT client), `ws` (WebSocket server), Mosquitto 2.x (broker), existing: `@simplewebauthn/server`, `@aws-sdk/client-s3`, `web-push` (010-live-system-playground)
- SQLite via `better-sqlite3` (in-process, WAL mode) + S3 backup for durability (010-live-system-playground)
- JavaScript ES5 (Shelly scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + `pg` (node-postgres), `mqtt` (MQTT client), `ws` (WebSocket server), Mosquitto 2.x (broker), existing: `@simplewebauthn/server`, `@aws-sdk/client-s3`, `web-push` (010-live-system-playground)
- UpCloud Managed PostgreSQL with TimescaleDB extension (plan `1x1xCPU-2GB-25GB`, zone `fi-hel1`), provisioned via Terraform (010-live-system-playground)
- Node.js 20 LTS (CommonJS server, ES6+ browser modules) + `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/exporter-logs-otlp-http` (011-newrelic-observability)
- UpCloud S3-compatible Object Storage (license key persistence), UpCloud Managed PostgreSQL with TimescaleDB (011-newrelic-observability)
- JavaScript — Node.js 20 LTS (CommonJS server), ES6+ (browser modules) + Node.js `http` module (server), browser `fetch` API (client). No new dependencies. (012-secure-rpc-api)
- N/A — no data model changes (012-secure-rpc-api)
- JavaScript ES6+ (browser modules), Node.js 20 LTS (CommonJS server), ES5 (Shelly scripts), POSIX shell (deploy scripts) + `ws` (WebSocket), `mqtt` (MQTT client), `pg` (PostgreSQL), `@aws-sdk/client-s3`, `@opentelemetry/*`, `@simplewebauthn/server` — removed `web-push` (013-remove-monitor-app)
- PostgreSQL/TimescaleDB (sensor history), UpCloud S3-compatible Object Storage (config persistence) (013-remove-monitor-app)
- HCL (Terraform >= 1.5), YAML (Kubernetes manifests), POSIX shell (CI scripts), Node.js 20 LTS (app, unchanged) + UpCloud Terraform provider ~> 5.0, Kubernetes provider ~> 2.24, Helm provider ~> 2.12, kubectl, cert-manager, NGINX Ingress controller (014-migrate-upcloud-kubernetes)
- UpCloud Managed PostgreSQL with TimescaleDB (unchanged), UpCloud Managed Object Storage (unchanged) (014-migrate-upcloud-kubernetes)
- JavaScript ES6+ (browser modules), CSS3 + Playwright 1.56.0 (e2e tests), `npx serve` (static server for tests) (015-fix-padding-status-display)
- N/A (client-side only) (015-fix-padding-status-display)
- JavaScript ES6+ (browser modules), Node.js 20 LTS (CommonJS server) + None new — uses existing `server/server.js` HTTP handler and browser `fetch` API (016-js-reload-prompt)
- N/A — version hash is computed on-the-fly from file contents (016-js-reload-prompt)
- Node.js 20 LTS (CommonJS) + `pg` (PostgreSQL driver), `@simplewebauthn/server`, native `http`/`crypto` (017-architecture-code-review)
- PostgreSQL with TimescaleDB (sensor data), S3-compatible object storage (credentials) (017-architecture-code-review)
- JavaScript ES5 (Shelly scripts), Node.js 20 LTS (tests) + Shelly scripting runtime, node:test (testing) (017-review-hardware-architecture)
- Shelly KVS (device config), MQTT (telemetry) (017-review-hardware-architecture)
- YAML (GitHub Actions), HCL (Terraform), Bash + kubectl, GitHub Actions, Kubernetes RBAC (018-cd-shelly-deploy)
- JavaScript ES5 (Shelly scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + Existing — `ws`, `mqtt`, `pg`, `@aws-sdk/client-s3`, `@simplewebauthn/server`. No new dependencies. (018-configure-sensor-connectors)
- S3-compatible object storage (UpCloud) / local filesystem fallback (sensor-config.json). Shelly KVS for device-side config. (018-configure-sensor-connectors)
- JavaScript ES5 (Shelly device scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + `mqtt` (MQTT client), `ws` (WebSocket server), `pg` (PostgreSQL), `@aws-sdk/client-s3`, Mosquitto 2.x (sidecar broker) (019-mqtt-only-shelly-api)
- PostgreSQL/TimescaleDB (sensor history, state events), S3-compatible object storage (config persistence), Shelly KVS (device-side config, 256-byte limit per key) (019-mqtt-only-shelly-api)
- JavaScript ES6+ (browser modules), HTML5, CSS3 + None new — vanilla ES modules only. Existing vendored: js-yaml 4.1.0 (021-reactive-state-ui)
- N/A (client-side only; server APIs unchanged) (021-reactive-state-ui)

## Cloud Deployment Architecture

```
Internet → Worker Node :80/:443 (hostNetwork)
  → NGINX Ingress Controller (cert-manager TLS)
    → K8s Service → Pod: app + openvpn (sidecar) + mosquitto (sidecar)
                          ↕ VPN tunnel
                     Shelly devices (LAN)
```

- **Infrastructure**: UpCloud Managed Kubernetes (UKS) development plan (free control plane) + 1x DEV-1xCPU-1GB worker node (fi-hel1) + Managed Object Storage (europe-1) + Managed PostgreSQL (TimescaleDB), provisioned via Terraform
- **Pod architecture**: Single Deployment with 3 containers sharing the network namespace: app (Node.js :3000), openvpn (sidecar, VPN tunnel), mosquitto (sidecar, MQTT :1883). The app reaches Mosquitto on `localhost:1883` and has VPN access through the openvpn sidecar.
- **TLS termination**: NGINX Ingress controller (DaemonSet, `hostNetwork: true`) binds to ports 80/443 on the worker node's public IP. cert-manager with Let's Encrypt HTTP-01 challenge for automatic TLS certificates. No managed load balancer.
- **Container hardening**: App runs with read-only root filesystem, non-root user (1000). Mosquitto runs as non-root (1883). OpenVPN needs NET_ADMIN capability and /dev/net/tun hostPath access (not privileged mode).
- **Persistence**: UpCloud Managed Object Storage (S3-compatible) — stores WebAuthn credentials (`credentials.json`) and VPN config (`openvpn.conf`). UpCloud Managed PostgreSQL with TimescaleDB for sensor history.
- **VPN networking**: The openvpn sidecar container shares the pod's network namespace with the app. This gives the app direct access to the VPN tunnel, allowing it to proxy RPC requests to Shelly devices on the home LAN. OpenVPN uses static key (PSK) mode for compatibility with UniFi site-to-site VPN.
- **Auth**: WebAuthn passkeys via @simplewebauthn, HMAC-signed session cookies (30-day expiry)
- **CD**: GitHub Actions → GHCR (app + openvpn images) → `kubectl set image` rolling update on the K8s cluster. Uses a scoped deployer ServiceAccount (can only patch the `app` Deployment) — no UpCloud API token stored in GitHub. Kubeconfig generated by Terraform and stored as `KUBE_CONFIG_DATA` GitHub secret. Recreate strategy (brief downtime) required because the openvpn sidecar uses hostPort 1194.

### Configuration Management

Server environment is delivered via Kubernetes-native mechanisms, managed by Terraform:

- **`kubernetes_secret/app-secrets`** — sensitive values: `DATABASE_URL`, `SESSION_SECRET`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `NEW_RELIC_LICENSE_KEY`. Populated from Terraform resource outputs and variables.
- **`kubernetes_config_map/app-config`** — non-secret service config: `PORT`, `AUTH_ENABLED`, `RPID`, `ORIGIN`, `DOMAIN`, `GITHUB_REPO`, `VPN_CHECK_HOST`, `VPN_CONFIG_KEY`, `SETUP_WINDOW_MINUTES`, `NODE_ENV`, `MQTT_HOST`, `SENSOR_HOST_IPS`, `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`
- **`kubernetes_secret/openvpn-config`** — VPN configuration file
- **`kubernetes_config_map/mosquitto-config`** — Mosquitto listener configuration

## Observability (New Relic)

The app supports optional New Relic observability via OpenTelemetry. All telemetry is disabled by default (zero overhead) and activates only when a license key is configured.

### Enabling

```bash
cd deploy/terraform
terraform apply -var="new_relic_license_key=NRAK-..."
```

Terraform stores the key in the `app-secrets` Kubernetes Secret. Redeploy to activate.

### Architecture

- **`server/lib/tracing.js`** — OTel SDK init, loaded via `--require` before server.js. No-op when `NEW_RELIC_LICENSE_KEY` is unset.
- **`server/lib/nr-config.js`** — S3 persistence helper for the license key (same pattern as `db-config.js`). S3 key: `newrelic-config.json`.
- **`server/lib/logger.js`** — Injects `trace.id` and `span.id` into JSON log entries for trace-log correlation.
- **`server/lib/mqtt-bridge.js`** — Manual MQTT spans (`mqtt.message`, `mqtt.publish`) via `@opentelemetry/api`.
- **Monitoring agents** — New Relic Infrastructure and nri-postgresql can be deployed as separate K8s workloads when needed.

### Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `NEW_RELIC_LICENSE_KEY` | K8s Secret (via Terraform) | Ingest license key. Empty = telemetry disabled. |
| `NRIA_LICENSE_KEY` | K8s Secret (if infra agent deployed) | Same key, for infra agent. |
| `OTEL_SERVICE_NAME` | K8s ConfigMap (via Terraform) | Service name in New Relic (default: `greenhouse-monitor`). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | config.env | OTLP endpoint (auto-detected from license key region: EU `https://otlp.eu01.nr-data.net`, US `https://otlp.nr-data.net`). |

### What Gets Traced

- HTTP requests (incoming + outgoing Shelly proxy) — auto-instrumented
- PostgreSQL queries — auto-instrumented via `pg` driver
- S3 operations — auto-instrumented via AWS SDK
- MQTT operations (connect, subscribe, publish, message) — manual spans
- Node.js runtime metrics (heap, GC, event loop) — auto-instrumented
- Host/container metrics — via New Relic Infrastructure agent
- PostgreSQL health — via nri-postgresql integration

## Recent Changes
- 021-reactive-state-ui: Added JavaScript ES6+ (browser modules), HTML5, CSS3 + None new — vanilla ES modules only. Existing vendored: js-yaml 4.1.0
- 019-mqtt-only-shelly-api: Added JavaScript ES5 (Shelly device scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + `mqtt` (MQTT client), `ws` (WebSocket server), `pg` (PostgreSQL), `@aws-sdk/client-s3`, Mosquitto 2.x (sidecar broker)
- 018-configure-sensor-connectors: Added JavaScript ES5 (Shelly scripts), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + Existing — `ws`, `mqtt`, `pg`, `@aws-sdk/client-s3`, `@simplewebauthn/server`. No new dependencies.
