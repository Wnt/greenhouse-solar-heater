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
- `playground/` → thermal simulation SPA (single-page app with 4 views)
- `monitor/` → temperature monitor web app (server, UI, auth, push notifications)
- `monitor/auth/` → WebAuthn passkey authentication (credential store, session management, WebAuthn handlers, invitation-based registration)
- `monitor/lib/logger.js` → structured JSON logger (used by server and auth modules)
- `monitor/lib/s3-storage.js` → S3/local filesystem storage adapter (credentials persistence)
- `monitor/lib/vpn-config.js` → VPN config S3 persistence CLI (download/upload openvpn.conf)
- `deploy/` → cloud deployment infrastructure
- `deploy/terraform/` → UpCloud server, firewall rules, Managed Object Storage (Terraform)
- `deploy/docker/` → App Dockerfile only
- `deploy/deployer/` → Deployer image: Dockerfile, deploy.sh, docker-compose.yml, Caddyfile, config.env
- `deploy/openvpn/` → OpenVPN server: Dockerfile, config template, setup script
- `design/docs/` → prose docs: design.md, bom.md, ideas/, superpowers/
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

- `shelly/control-logic.js` — Pure decision logic (ES5-compatible). Exports an `evaluate(state, config)` function with no side effects and no Shelly API calls. This is the testable core.
- `shelly/control.js` — Shelly shell script that handles timers, RPC, relays, KVS, sensors. Imports `control-logic.js` (concatenated at deploy time).
- `shelly/deploy.sh` — Deploys scripts to the Shelly Pro 4PM via HTTP RPC. Reads device IPs from `devices.conf`.
- `shelly/devices.conf` — DHCP-reserved IP addresses for all Shelly devices.

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

The `playground/` directory contains a single-page thermal simulation app. Dark editorial theme based on the Stitch "Digital Sanctuary" design system (`design/Stitch/`): dark backgrounds (#0c0e12), gold primary (#e9c349), teal secondary (#43aea4), Newsreader serif headings, Manrope sans-serif body, tonal layering (no border lines for structure). Responsive: desktop sidebar nav (256px), mobile (<768px) glassmorphic bottom nav. Single HTML file with 4 JS-switched views, `<script type="importmap">` for ES modules.

- `playground/index.html` — single-page app: Status (default, bento grid dashboard), Components (sensors/valves/actuators), Schematic (SVG system visualization), Controls (sliders, reset). Floating play/pause FAB.
- `playground/js/` — ES modules: physics, control, hydraulics, UI, yaml-loader
- `playground/css/style.css` — shared styles
- `design/Stitch/` — Stitch UI design mockups (desktop + mobile) with DESIGN.md spec and code.html references

### Vendored Dependencies

All third-party libraries are vendored locally in `playground/vendor/` to avoid CDN/CORS issues in restricted environments (e.g. Claude Code web runtime, CI, offline):

- `playground/vendor/js-yaml.mjs` — js-yaml 4.1.0 (ESM), used by all playground pages

**Do NOT replace these with CDN URLs.** The importmaps in each HTML file point to `./vendor/...` paths. If upgrading a dependency, download via `npm pack`, extract the dist files, and copy to `playground/vendor/`.

## Temperature Monitor

The `monitor/` directory contains the temperature monitoring web app that reads live DS18B20 temperatures from a Shelly 1 sensor add-on and displays them in a browser-based UI. It can run locally (direct LAN access) or deployed to the cloud (via VPN).

- `monitor/server.js` — Node.js HTTP server: serves static files, proxies RPC to Shelly devices, health endpoint, auth middleware (when `AUTH_ENABLED=true`), push notification API, valve state poller
- `monitor/index.html` — Web UI: SVG gauges + Canvas time-series chart (last 6h), notification toggle, Apple PWA meta tags
- `monitor/manifest.json` — PWA manifest (standalone display, app name, icons, maskable 512px icon, stable `id`)
- `monitor/sw.js` — Service worker: push notifications + fetch handler (network-first with offline fallback)
- `monitor/offline.html` — Branded offline fallback page (auto-retry on connectivity)
- `monitor/icons/` — PWA icons (icon-192.png, icon-512.png)
- `monitor/login.html` — Passkey authentication page (registration + login)
- `monitor/js/` — ES modules: `shelly-api.js` (HTTP RPC client), `gauge.js` (SVG gauge), `chart.js` (Canvas chart), `app.js` (orchestration), `login.js` (passkey auth), `push.js` (push subscription management)
- `monitor/auth/` — Server-side auth: `credentials.js` (credential store via S3 adapter), `session.js` (HMAC cookies), `webauthn.js` (WebAuthn handlers)
- `monitor/lib/logger.js` — Structured JSON logger
- `monitor/lib/s3-storage.js` — S3/local storage adapter (reads/writes credentials to UpCloud Object Storage or local filesystem)
- `monitor/lib/push-storage.js` — S3/local storage adapter for push subscriptions (`push-subscriptions.json`) and VAPID keys (`push-config.json`)
- `monitor/lib/valve-poller.js` — Server-side valve state polling and change detection (polls Shelly controller via HTTP RPC)
- `monitor/vendor/simplewebauthn-browser.mjs` — Vendored @simplewebauthn/browser 13.3.0 (ESM)
- `monitor/vendor/qrcode-generator.mjs` — Vendored qrcode-generator 2.0.4 (ESM, for invitation QR codes)
- `monitor/css/style.css` — Standalone styles (not shared with playground)
- `monitor/shelly/sensor-display.js` — ES5 Shelly script for Pro 4PM
- `monitor/shelly/deploy-poc.sh` — Deploys the script to Pro 4PM via HTTP RPC

**Local mode**: `node monitor/server.js` — no auth, direct LAN access to Shelly devices.
**Cloud mode**: `AUTH_ENABLED=true RPID=domain ORIGIN=https://domain node monitor/server.js` — passkey auth required, VPN tunnel to reach devices.

**Do NOT replace vendored libs with CDN URLs.** The importmap in `login.html` points to `./vendor/...` paths.

## Running Tests

```bash
npm test              # all tests: unit + simulation + e2e
npm run test:unit     # unit + simulation tests only (fast, no browser)
npm run test:e2e      # Playwright e2e tests only (requires Chromium)
```

### Test Structure

- `tests/control-logic.test.js` — unit tests for the pure control logic (`shelly/control-logic.js`)
- `tests/auth.test.js` — unit tests for auth modules (session signing, credential store)
- `tests/s3-storage.test.js` — unit tests for S3 storage adapter (local fallback mode, S3 detection)
- `tests/vpn-config.test.js` — unit tests for VPN config S3 persistence helper
- `tests/push-storage.test.js` — unit tests for push storage adapter (VAPID keys, subscriptions, deduplication)
- `tests/valve-poller.test.js` — unit tests for valve state change detection (pure functions, poller behavior)
- `tests/sw.test.js` — unit tests for service worker fetch handler, offline caching, and push handler preservation
- `tests/simulation/` — thermal model and simulation scenario tests (`simulation.test.js`, `thermal-model.test.js`, `scenarios.js`, `simulator.js`, `thermal-model.js`)
- `tests/e2e/thermal-sim.spec.js` — Playwright e2e tests for the playground thermal simulation
- `tests/e2e/pwa.spec.js` — Playwright e2e tests for PWA installability (manifest, Apple meta tags, offline page)

### Test Setup Notes

- **Playwright version**: Must match the cached Chromium browser revision. Currently `@playwright/test@1.56.0` matches `chromium-1194`. If you see "browser not found" errors, check `~/.cache/ms-playwright/` for available revisions and install the matching Playwright version.
- **Static server**: Tests use `npx serve` on port 3210 to serve the playground. The Playwright config auto-starts this server.
- **No `-s` flag on serve**: Do NOT use `serve -s` (SPA mode) — it breaks direct HTML file access by redirecting all routes.
- Individual test timeouts are 30s. E2e tests verify the 2D SVG schematic and simulation behavior.

## CI / GitHub Actions

- `.github/workflows/ci.yml` — runs the full test suite (unit, simulation, auth, e2e) on every push. Triggers on `push` only (not `pull_request`) so tests run exactly once — opening a PR from an already-pushed branch does not re-trigger.
- `.github/workflows/deploy.yml` — CD pipeline: test → build app + deployer images → push to GHCR. Systemd timer on the server pulls deployer, which applies config and updates services. Triggers on push to main/master.
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

## Cloud Deployment Architecture

```
Internet → Caddy (:443, TLS) → OpenVPN (shared network) → Node.js app (:3000) → S3 Object Storage (credentials)
                                         ↕ VPN tunnel
                                    Shelly devices (LAN)
```

- **Infrastructure**: UpCloud DEV-1xCPU-1GB-10GB server (fi-hel1) + Managed Object Storage (europe-1), provisioned via Terraform
- **Deployer**: Config lives in a deployer container image (`deploy/deployer/`), not cloud-init. Systemd timer pulls and runs the deployer every 5 minutes.
- **Containers**: Docker Compose with `app` (Node.js, shares openvpn network via `network_mode: "service:openvpn"`) + `caddy` (reverse proxy, auto TLS) + `openvpn` (VPN). Caddy connects to `openvpn:3000` since the app shares the openvpn network namespace.
- **Container hardening**: App and Caddy containers run with read-only root filesystems and as non-root users. OpenVPN needs NET_ADMIN capability and /dev/net/tun access.
- **Persistence**: UpCloud Managed Object Storage (S3-compatible, €5/month) — no Docker volumes for app data. Stores WebAuthn credentials (`credentials.json`) and VPN config (`openvpn.conf`).
- **VPN config persistence**: The deployer downloads `openvpn.conf` from S3 before starting containers (survives server recreation). On first setup, it uploads a locally-placed config to S3 for future rebuilds. Uses the app image as a one-shot S3 helper (`monitor/lib/vpn-config.js`).
- **VPN networking**: The app container uses `network_mode: "service:openvpn"` to share the OpenVPN container's network namespace. This gives the app direct access to the VPN tunnel, allowing it to proxy RPC requests to Shelly devices on the home LAN. Firewall rule controlled via `enable_vpn` Terraform variable. OpenVPN uses static key (PSK) mode for compatibility with UniFi site-to-site VPN.
- **Auth**: WebAuthn passkeys via @simplewebauthn, HMAC-signed session cookies (30-day expiry)
- **CD**: GitHub Actions → GHCR (app + deployer images) → systemd timer pulls deployer → deployer runs `docker compose up -d`
- **No SSH exposed**: Firewall blocks port 22. Emergency access via UpCloud web console.

### Environment Variable Split

Server environment is split into two sources, merged by the deployer:

- **`.env.secrets`** (cloud-init, immutable) — secrets that require server recreation to change: `SESSION_SECRET`, `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`
- **`config.env`** (deployer image, mutable) — service config that deploys via CD without server recreation: `PORT`, `AUTH_ENABLED`, `RPID`, `ORIGIN`, `DOMAIN`, `GITHUB_REPO`, `VPN_CHECK_HOST`, `VPN_CONFIG_KEY`, `SETUP_WINDOW_MINUTES`, `NODE_ENV`, `CONTROLLER_IP`, `CONTROLLER_SCRIPT_ID`, `VAPID_SUBJECT`
- **`.env`** (deployer merge output) — merged file consumed by Docker Compose. Secrets win on duplicate keys.

VPN is always-on (the app uses `network_mode: "service:openvpn"`). Firewall rule controlled via `enable_vpn=true` in Terraform.

## Recent Changes
- 009-add-home-screen-support: Added JavaScript ES6+ (browser modules), Node.js 20 LTS (server, CommonJS) + None new — extends existing service worker and manifest
- 008-add-passkey-registration: Added Node.js 20 LTS (CommonJS server-side), ES6+ browser modules + `@simplewebauthn/server` (existing), `@simplewebauthn/browser` (vendored, existing), `qrcode` (new, vendored browser bundle for QR generation)
- 007-switch-to-openvpn: Added POSIX shell (setup script, deployer), HCL (Terraform >= 1.5), Node.js 20 LTS (vpn-config.js), YAML (docker-compose) + OpenVPN (Alpine package), Docker Compose v2, @aws-sdk/client-s3 (existing)
