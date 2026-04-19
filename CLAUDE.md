# CLAUDE.md

Guidance for Claude Code working in this repository. Keep this file short — anything derivable from the code belongs in the code, not here.

## Project

Solar thermal greenhouse heating system for Southwest Finland. Shelly-controlled, unpressurized drainback design. The repo contains `system.yaml` (hardware spec), Shelly device scripts, a monitoring/control web app (playground), a Node.js server, and deployment infrastructure.

## Source of Truth

`system.yaml` is the **single authoritative source** for all hardware specs: component dimensions, heights, valve states, operating modes, sensor assignments, Shelly relay mappings. All other docs and diagrams are derived views. **Update `system.yaml` first**, then propagate to affected diagrams/docs.

## Keep This File Current

**Before finishing any work, review this file and update it if your changes affect project structure, conventions, commands, or workflows described here.** Stale guidance is worse than none. Add new rules here; don't re-describe files that are self-explanatory from their path and content.

## Repository Layout

- `system.yaml` — authoritative hardware spec
- `shelly/` — device scripts (`control.js`, `control-logic.js`, `telemetry.js`, `deploy.sh`)
- `shelly/lint/` — Shelly platform conformance linter (standalone Node.js CLI, Acorn-based)
- `playground/` — SPA/PWA: 5 hash-routed views (`#status`, `#components`, `#controls`, `#device`, `#settings`). Passkey-protected in cloud mode. Legacy `#schematic` → `#components` and `#sensors` → `#device` aliases live in `js/actions/navigation.js`.
- `playground/public/` — assets served without auth (login page, shared CSS/font, libraries needed by unauthenticated views). The server whitelists `/public/*`, so anything placed here is reachable without a session — do not put sensitive data here.
- `playground/vendor/` — vendored third-party libraries for authed views (see Critical Rules)
- `server/` — Node.js API: HTTP + WebSocket + MQTT bridge + auth + device/sensor config + history + push notifications
- `server/auth/` — WebAuthn passkey auth (multi-user, role-based: `admin` / `readonly`)
- `server/lib/` — shared modules: `mqtt-bridge`, `device-config`, `sensor-config`, `db` (PostgreSQL/TimescaleDB), `s3-storage`, `notifications`, `push`, `tracing`, `logger`, config CLI helpers
- `deploy/terraform/` — UpCloud K8s + PostgreSQL + Object Storage (Terraform)
- `deploy/k8s/` — K8s manifests (Deployment with openvpn + mosquitto sidecars, Ingress, RBAC)
- `deploy/docker/`, `deploy/openvpn/` — Dockerfiles
- `design/` — prose docs, hand-authored SVG diagrams, Mermaid control logic, construction notes
- `tests/` — unit + simulation + auth + e2e (Playwright)
- `scripts/` — generators: `generate-bootstrap-history.mjs`, `make-icons.mjs`, `generate-liquid-glass.mjs`
- `.github/workflows/` — CI (test), CD (deploy to K8s + Shelly), GitHub Pages, Shelly lint

File-level details are discoverable by reading the file. Don't re-document here.

## Key Architecture Concepts

Physical facts about the hardware that are NOT discoverable from code:

- **Unpressurized system.** The Jäspi tank is sealed but vented via an open reservoir connected to the dip tube port. The reservoir acts as an air separator — gas vents to atmosphere through its open top.
- **Communicating vessels.** Water level in the reservoir equals water level at the dip tube opening inside the tank (~197 cm). Gas is trapped above this level in the sealed tank.
- **Valve manifold.** 7 motorized on/off DN15 valves around a single pump: 3 input (VI-btm, VI-top, VI-coll), 3 output (VO-coll, VO-rad, VO-tank), plus V_air at the collector top with a passive T joint permanently connecting the collector-top pipe to the reservoir (terminated below the water line so the siphon cannot ingest air).
- **Operating modes** (plus `idle`): `solar_charging`, `greenhouse_heating`, `active_drain`. Each opens a specific subset of valves — see the `modes` section in `system.yaml`.
- **Hardware**: Shelly Pro 4PM main controller, 3× Pro 2PM for valves, Plus 1 with Add-on for sensors.

## Critical Rules

### Safety: stop pump BEFORE switching valves

Generally true, enforced by `transitionTo()` in `shelly/control.js` (stops pump/fan/heaters, then actuates valves). A few specific sequences intentionally deviate — don't simplify the transition scheduler assuming pump-first is always safe.

### Only edit `shelly/control-logic.js` for control decisions

`shelly/control-logic.js` is pure ES5 decision logic (no side effects, no Shelly APIs). It runs on the device AND in the browser — the playground simulator loads it via `playground/js/control-logic-loader.js` with a CommonJS shim. When changing control logic, **edit this file only** — the playground picks it up automatically, and the bootstrap-history drift test ensures the pre-baked snapshot stays in sync.

### Shelly Espruino runtime constraints

Shelly runs a restricted Espruino runtime. The linter (`shelly/lint/`) enforces:

- **Errors**: `class`, `async`/`await`, `Promise`/`.then`/`.catch`, `fetch`/`XMLHttpRequest`/`WebSocket`/`Worker`/`localStorage`, `Array.{shift,unshift,splice,sort,flat,flatMap,findLast,findLastIndex}`, script > 16 KB, resource limits (5 timers, 5 event handlers, 5 concurrent RPC calls)
- **Warnings**: template literals, destructuring, spread/rest, arrow functions with implicit return

Convention (not linter-enforced): use `var`, not `const`/`let`. The `SH-014` array-method list is **empirical** — each banned method has a device-crash incident comment. Add to the list if you hit another missing method on-device and document the incident.

### Device communication flows through MQTT (one exception: sensor discovery)

No direct HTTP RPC to Shelly from the server for state, config pushes, sensor-config apply, or relay commands. The `mqtt-bridge` routes all of those through `greenhouse/*` topics. Adding a new mutating or stateful device operation = new MQTT topic, not a new HTTP endpoint.

**Exception**: `/api/sensor-discovery` calls `SensorAddon.OneWireScan` directly over HTTP to each sensor hub (see `server/lib/sensor-discovery.js`). The MQTT-routed flow (server → Pro 4PM → HTTP to hub → MQTT result) was slow (~30s) and produced opaque "controller did not respond" errors when any single hub failed. Discovery is read-only, parallelizable per host, and matches what the Shelly mobile app does. If you add more read-only diagnostic endpoints, prefer direct HTTP for the same reasons.

### Vendored dependencies must stay vendored

`playground/vendor/` contains `js-yaml.mjs` (authed-only). `playground/public/` contains `simplewebauthn-browser.mjs`, `qrcode-generator.mjs`, `material-symbols.css`, `material-symbols-outlined.woff2`, plus the shared `style.css`. Importmaps in each HTML file point at `./vendor/...` or `./public/...`. **Do not replace with CDN URLs.** To upgrade: `npm pack <package>`, extract, copy dist files.

### Readonly role blocks every mutating endpoint

Users with role `readonly` can browse but the following must reject with 403. Server uses `isAdminOrReject()` in `server.js`; WebSocket uses the `ws._role` check in `handleWsCommand()`.

- PUT `/api/device-config`
- PUT `/api/sensor-config`
- POST `/api/sensor-config/apply` and `/api/sensor-config/apply/:id`
- POST `/api/sensor-discovery`
- WebSocket `override-enter` / `override-exit` / `override-update` / `relay-command`

When adding a new mutating endpoint, add the same guard.

## Testing Policy

**Bug fixes and behavior changes follow test-first:**

1. Write a failing test that reproduces the bug or asserts the new behavior.
2. Run it — confirm it fails.
3. Implement the fix.
4. Run it — confirm it passes.
5. Commit test + fix together.

Missing tests = incomplete fix. Applies to behavior changes too (e.g. removing auto-polling, changing error messages).

## Commands

```bash
npm test                           # unit + simulation + e2e
npm run test:unit                  # fast, no browser
npm run test:e2e                   # Playwright (Chromium)
npm run screenshots                # regenerate screenshots (runs 24 h sim, ~1–2 min)
npm run diagram                    # regenerate system-topology.drawio (dark theme)
npm run topology-pdf               # printable light-theme PDF of the topology
npm run topology-svg               # light-theme SVG
npm run topology-drawio-playground # playground-theme drawio
npm run topology-svg-playground    # playground-theme SVG (dashboard)
npm run topology-contrast          # WCAG audit of topology drawio
npm run bootstrap-history          # regenerate pre-baked 12 h sim snapshot
node scripts/make-icons.mjs        # regenerate PWA + notification icons
node scripts/generate-liquid-glass.mjs  # regenerate bottom-nav glass PNGs
```

## Generated Files & Drift Checks

These files are **generated, not hand-edited**. Regenerate and commit in the **same change** as the source edit — CI will fail otherwise.

| Generated file | Source | Regenerate | Drift test |
|---|---|---|---|
| `design/diagrams/system-topology.drawio` | `system.yaml` + `design/diagrams/topology-layout.yaml` | `npm run diagram` | `tests/topology-diagram.test.js` |
| `playground/assets/system-topology.drawio` | same, playground theme | `npm run topology-drawio-playground` | `tests/topology-diagram.test.js` (drawio only; SVG not byte-compared) |
| `playground/assets/bootstrap-history.json` | `shelly/control-logic.js` thresholds + generator defaults | `npm run bootstrap-history` | `tests/bootstrap-history-drift.test.js` |

A threshold change in `control-logic.js` without a regenerated snapshot fails CI with a pointer to the first diverging line and the fix command. Topology palette overrides live in `topology-layout.yaml` under `themes.{light,playground}.{fill,font,stroke}`.

## Test Setup Gotchas

- **`import { test, expect } from './fixtures.js'`** for all e2e tests — NOT from `@playwright/test`. The fixture blocks Google Fonts so page loads don't hang in offline environments.
- **Playwright version must match the cached Chromium revision.** Currently `@playwright/test@1.56.0` ↔ `chromium-1194`. On "browser not found" errors, check `~/.cache/ms-playwright/` and pin Playwright to match.
- **Use plain `serve`, NOT `serve -s`.** SPA mode rewrites `/schematic-tester.html` → `/schematic-tester` → `index.html`, so standalone pages (schematic-tester, liquid-glass-test) become unreachable. Playwright config auto-starts plain `serve` on port 3210.

## Cloud Deployment

- **Infrastructure**: UpCloud Managed Kubernetes (free control plane) + 1× worker node + Managed Object Storage + Managed PostgreSQL/TimescaleDB. All via Terraform in `deploy/terraform/`.
- **Pod shape**: single Deployment, 3 containers sharing the network namespace — `app` (Node.js :3000), `openvpn` sidecar (VPN to home LAN), `mosquitto` sidecar (MQTT :1883). The app reaches Mosquitto on `localhost:1883` and Shelly devices through the VPN tunnel.
- **VPN/MQTT firewall**: an init container sets iptables rules restricting UDP 1194 to whitelisted CIDRs and TCP 1883 to localhost + `192.168.0.0/16`. Kernel-level because CiliumNetworkPolicy does not reliably filter `hostPort`. Details in `deploy/k8s/app-deployment.yaml`.
- **TLS**: NGINX Ingress (DaemonSet, `hostNetwork: true`) + cert-manager with Let's Encrypt HTTP-01. No managed load balancer.
- **Deployment strategy**: `Recreate` (brief downtime) because the openvpn sidecar uses `hostPort: 1194` — two pods can't bind the same hostPort on one node.
- **Config delivery**: `kubernetes_secret/app-secrets` (DATABASE_URL, SESSION_SECRET, S3 creds, NEW_RELIC_LICENSE_KEY) + `kubernetes_config_map/app-config` (PORT, AUTH_ENABLED, RPID, ORIGIN, DOMAIN, MQTT_HOST, OTEL_*). Managed by Terraform — read the .tf files for the full list.
- **CD**: push to main → GitHub Actions → GHCR (app + openvpn images) → `kubectl set image` rolling update → `kubectl exec` runs `shelly/deploy.sh`. The Shelly deploy step is non-fatal. Requires `KUBE_CONFIG_DATA` GitHub secret (scoped deployer ServiceAccount — can only patch the `app` Deployment and exec into pods).

## Observability (New Relic)

Optional OpenTelemetry → New Relic. Disabled by default (zero overhead). `server/lib/tracing.js` is loaded via `--require` before `server.js` and no-ops when `NEW_RELIC_LICENSE_KEY` is unset.

Enable:
```bash
cd deploy/terraform
terraform apply -var="new_relic_license_key=NRAK-..."
```

`server/lib/logger.js` injects `trace.id` / `span.id` into JSON log entries. MQTT operations have manual spans in `server/lib/mqtt-bridge.js`. HTTP, `pg`, and AWS SDK calls are auto-instrumented. The license-key region selects the OTLP endpoint (EU vs US) automatically.

## Run Modes

- **Local**: `node server/server.js` — no auth, direct LAN access to Shelly devices.
- **Cloud**: `AUTH_ENABLED=true RPID=<domain> ORIGIN=https://<domain> node server/server.js` — passkey auth, VPN tunnel to reach devices.
