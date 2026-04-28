# CLAUDE.md

Guidance for Claude Code working in this repository. Keep this file short — anything derivable from the code belongs in the code, not here.

## Project

Solar thermal greenhouse heating system for Southwest Finland. Shelly-controlled, unpressurized drainback design. The repo contains `system.yaml` (hardware spec), Shelly device scripts, a monitoring/control web app (playground), a Node.js server, and deployment infrastructure.

## Source of Truth

`system.yaml` is the **single authoritative source** for all hardware specs: component dimensions, heights, valve states, operating modes, sensor assignments, Shelly relay mappings. All other docs and diagrams are derived views. **Update `system.yaml` first**, then propagate to affected diagrams/docs.

## Keep This File Current

**Before finishing any work, review this file and update it if your changes affect project structure, conventions, commands, or workflows described here.** Stale guidance is worse than none. Add new rules here; don't re-describe files that are self-explanatory from their path and content.

## Communicating with the user

This codebase is dense with short codes — `wb`, `mo`, `ce`, `ea`, `we`, `wz` (deviceConfig fields), `I` / `SC` / `GH` / `AD` / `EH` (mode short codes), `sng` / `scs` / `ggr` (watchdog ids). The compact form exists because Shelly KVS values are capped at 256 bytes, so on-device JSON has to fit. **In user-facing prose, always lead with the full name** (e.g. "Solar Charging mode", "manual override", "watchdog auto-shutdown ban") and parenthesise the short code only when it adds wiring-level insight (e.g. "the Greenhouse Heating ban (`wb["GH"]`) is set until 12:32"). Bare `wb`, `mo`, `EH`, `ggr`, etc. with no expansion will lose the user — assume the user is reading the *operational* layer, not the on-device JSON. The mapping table is in `server/lib/device-config.js` (top of file) and `shelly/watchdogs-meta.js`; in code (comments, tests, identifiers) the short codes stay.

## Repository Layout

- `system.yaml` — authoritative hardware spec
- `shelly/` — device scripts (`control.js`, `control-logic.js`, `telemetry.js`, `deploy.sh`)
- `shelly/lint/` — Shelly platform conformance linter (standalone Node.js CLI, Acorn-based)
- `playground/` — SPA/PWA: 5 hash-routed views (`#status`, `#components`, `#controls`, `#device`, `#settings`). Passkey-protected in cloud mode. Legacy `#schematic` → `#components` and `#sensors` → `#device` aliases live in `js/actions/navigation.js`. Cross-cutting **data-sync framework** in `playground/js/sync/` — new full-stack features that fetch from the server should register a source there so they refresh automatically on Android resume / focus / network recovery (see `playground/js/sync/README.md`).
- `playground/public/` — assets served without auth (login page, shared CSS/font, libraries needed by unauthenticated views). The server whitelists `/public/*`, so anything placed here is reachable without a session — do not put sensitive data here.
- `playground/vendor/` — vendored third-party libraries for authed views (see Critical Rules)
- `server/` — Node.js API: HTTP + WebSocket + MQTT bridge + auth + device/sensor config + history + push notifications
- `server/auth/` — WebAuthn passkey auth (multi-user, role-based: `admin` / `readonly`)
- `server/lib/` — shared modules: `mqtt-bridge`, `device-config`, `sensor-config`, `db` (PostgreSQL/TimescaleDB), `s3-storage`, `notifications`, `push`, `tracing`, `logger`, config CLI helpers. Hand-rolled minimal protocol clients (replacing npm deps): `s3-client` (SigV4), `web-push` (VAPID + RFC 8291 aes128gcm), `ws-server` (RFC 6455). See Critical Rules: don't reintroduce `@aws-sdk/client-s3`, `web-push`, or `ws` as npm deps.
- `deploy/terraform/` — UpCloud K8s + PostgreSQL + Object Storage (Terraform)
- `deploy/k8s/` — K8s manifests (Deployment with openvpn + mosquitto sidecars, Ingress, RBAC)
- `deploy/docker/`, `deploy/openvpn/` — Dockerfiles
- `design/` — prose docs, hand-authored SVG diagrams, Mermaid control logic, construction notes
- `tests/` — unit + simulation + auth; `tests/frontend/` Playwright against static serve (frontend with mocked APIs); `tests/e2e/` Playwright against real `server/server.js` + pg-mem + aedes MQTT
- `scripts/` — generators: `generate-bootstrap-history.mjs`, `make-icons.mjs`, `generate-liquid-glass.mjs`. `scripts/lib/yaml-load.js` is the in-tree YAML loader used by Node-side build scripts (`design/diagrams/generate-topology.js`, `shelly/lint/bin/shelly-lint.js`). The browser still uses `playground/vendor/js-yaml.mjs` via importmap.
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

Generally true, enforced by `transitionTo()` in `shelly/control.js` (stops pump/fan/heaters, then actuates valves). **The one named exception is exit from `ACTIVE_DRAIN`**, which reverses the order (close valves → wait 20 s via `DRAIN_EXIT_PUMP_RUN_MS` → stop pump) so the pump evacuates residual water from the manifold before the valves seal. Don't simplify the transition scheduler assuming pump-first is always safe.

### Only edit `shelly/control-logic.js` for control decisions

`shelly/control-logic.js` is pure ES5 decision logic (no side effects, no Shelly APIs). It runs on the device AND in the browser — the playground simulator loads it via `playground/js/control-logic-loader.js` with a CommonJS shim. When changing control logic, **edit this file only** — the playground picks it up automatically, and the bootstrap-history drift test ensures the pre-baked snapshot stays in sync.

### Shelly Espruino runtime constraints

Shelly runs a restricted Espruino runtime. The linter (`shelly/lint/`) enforces:

- **Errors**: `class`, `async`/`await`, `Promise`/`.then`/`.catch`, `fetch`/`XMLHttpRequest`/`WebSocket`/`Worker`/`localStorage`, `Array.{shift,unshift,splice,sort,flat,flatMap,findLast,findLastIndex}`, script > 16 KB, resource limits (5 timers, 5 event handlers, 5 concurrent RPC calls)
- **Warnings**: template literals, destructuring, spread/rest, arrow functions with implicit return

Convention (not linter-enforced): use `var`, not `const`/`let`. The `SH-014` array-method list is **empirical** — each banned method has a device-crash incident comment. Add to the list if you hit another missing method on-device and document the incident.

### Device communication flows through MQTT (two exceptions: sensor discovery and sensor apply)

No direct HTTP RPC to Shelly from the server for state, config pushes, or relay commands. The `mqtt-bridge` routes all of those through `greenhouse/*` topics. Adding a new mutating or stateful device operation = new MQTT topic, not a new HTTP endpoint.

**Exceptions**:

- `/api/sensor-discovery` → `server/lib/sensor-discovery.js`. Calls `SensorAddon.OneWireScan` directly. The MQTT-routed flow (server → Pro 4PM → HTTP to hub → MQTT result) was slow and produced opaque "controller did not respond" errors on any single-hub failure. Discovery is read-only, parallelizable per host, and matches what the Shelly mobile app does.

- `/api/sensor-config/apply` → `server/lib/sensor-apply.js`. Drives the `remove-all → Shelly.Reboot → wait → add-all → Shelly.Reboot` sequence required by the Add-on (it keeps a "reserved address" cache after RemovePeripheral that only a reboot clears, and newly-added Temperature.GetStatus handlers only register after a reboot). That async orchestration is hard on the Shelly's ES5 runtime (5-timer limit, no promises), trivial in Node. The sensor routing config (role → cid map) is still published via MQTT (`greenhouse/sensor-config`) so the controller's polling loop picks up assignment changes.

If you add more operations that need multi-step async waits or cross-hub orchestration, prefer direct HTTP for the same reasons.

### Vendored dependencies must stay vendored

`playground/vendor/` contains `js-yaml.mjs` (authed-only). `playground/public/` contains `simplewebauthn-browser.mjs`, `qrcode-generator.mjs`, `material-symbols.css`, `material-symbols-outlined.woff2`, plus the shared `style.css`. Importmaps in each HTML file point at `./vendor/...` or `./public/...`. **Do not replace with CDN URLs.** To upgrade: `npm pack <package>`, extract, copy dist files.

### In-tree protocol clients replace npm deps — don't re-add

We removed four npm deps in favour of small hand-written protocol clients in this repo. Don't re-add the packages without strong justification; the in-tree code is intentionally minimal (covers only the calls we make) and audited by the tests next to it.

| Removed npm dep | In-tree replacement | Tests |
|---|---|---|
| `@aws-sdk/client-s3` | `server/lib/s3-client.js` (SigV4 + HTTPS Get/Put/Head, path-style only) | `tests/s3-client.test.js` (incl. AWS reference vector) |
| `web-push` | `server/lib/web-push.js` (VAPID JWT ES256 + RFC 8291 aes128gcm) | `tests/web-push.test.js` (incl. self-decrypt round-trip) |
| `ws` | `server/lib/ws-server.js` (RFC 6455, `noServer: true` only, no extensions) | `tests/ws-server.test.js` |
| `js-yaml` | `scripts/lib/yaml-load.js` (Node-side; browser still uses vendored `playground/vendor/js-yaml.mjs`) | `tests/yaml-load.test.js` |

If a feature needs an API that the in-tree client doesn't cover, extend the client (and add a test) rather than re-adding the npm package.

### Readonly role blocks every mutating endpoint

Users with role `readonly` can browse but the following must reject with 403. Server uses `isAdminOrReject()` in `server.js`; WebSocket uses the `ws._role` check in `handleWsCommand()`.

- PUT `/api/device-config`
- PUT `/api/sensor-config`
- POST `/api/sensor-config/apply` and `/api/sensor-config/apply/:id`
- POST `/api/sensor-discovery`
- WebSocket `override-enter` / `override-exit` / `override-update` / `relay-command`

When adding a new mutating endpoint, add the same guard.

### History aggregate must persist beyond raw retention

`sensor_readings_30s` is a real (hyper)table, not a materialized view. Raw `sensor_readings` is pruned at 48 h, but the 30-second aggregate must accumulate forever — the 7d/30d/1y graph views draw from it and fill in over time.

**Never** add a cleanup / retention policy / TRUNCATE / `DELETE FROM sensor_readings_30s` anywhere. `runMaintenance` in `server/lib/db-maintenance.js` only ever does `INSERT … ON CONFLICT DO UPDATE` on the aggregate, and the retention `DELETE` targets raw `sensor_readings` only. Guard tests in `tests/history-retention.test.js` enforce both halves — if you need to change the maintenance flow, keep those guards passing.

The original bug (PR #64): aggregate was a MATERIALIZED VIEW refreshed from raw, so each refresh silently discarded everything older than 48 h and long-range graphs only ever showed ~2 days.

## Testing Policy

**Bug fixes and behavior changes follow test-first:**

1. Write a failing test that reproduces the bug or asserts the new behavior.
2. Run it — confirm it fails.
3. Implement the fix.
4. Run it — confirm it passes.
5. Commit test + fix together.

Missing tests = incomplete fix. Applies to behavior changes too (e.g. removing auto-polling, changing error messages).

## Frontend Coverage Gate

Every file under `playground/js/**` must have ≥50% statement coverage from the `tests/frontend` Playwright suite, or be listed in `coverage-exclusions.json` with a written reason. CI enforces both directions: below-threshold unexcluded files fail, **and** excluded files that climb ≥50% fail too (drop the stale entry). Adding an exclusion is acceptable; stacking many exclusions is a smell. See `scripts/coverage-check.mjs`.

## Commands

```bash
npm test                           # unit + frontend + e2e
npm run test:unit                  # fast, no browser
npm run test:frontend              # Playwright against static serve — frontend with mocked APIs
npm run test:e2e                   # Playwright against real server + pg-mem + aedes MQTT
npm run coverage:frontend          # V8 JS coverage for playground/js/** driven by the frontend suite — HTML + lcov in coverage/ (CI runs the same report + gate, see "Frontend Coverage Gate")
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

## Pre-Push Checklist

**Before pushing any non-trivial change, run the full local CI gate suite.** These are the exact checks `.github/workflows/ci.yml` runs; running them locally is a ~80 s feedback loop (~5 s static + ~75 s unit+Playwright in parallel) vs. a 3–5 min round-trip through GitHub Actions, so always do it locally first:

```bash
npm run lint                             # ESLint — 0 errors
npm run knip                             # dead-code / unresolved imports — exit 0
npm run check:file-size -- --strict      # file-size budget — 0 over hard cap
npm run check:assets -- --strict         # unused playground assets — exit 0
timeout 30 npm run test:unit             # full unit suite in ~5–10 s
timeout 180 npx playwright test          # frontend + e2e — ~55 s warm cache
```

**Read each step's exit code, not its prose.** `check:file-size --strict` in particular prints both `~` (soft-cap warning, OK) and `✗` (hard-cap error, must fix) and ends with a single summary line — the count of `over hard cap` is the only number that matters for `--strict`. Past mistake (PR #86): the agent saw `~` warnings on unrelated files, dismissed the strict failure as pre-existing, and shipped red CI. **If a step exits non-zero, fix it before pushing — don't reinterpret.**

The `.claude/hooks/pre-push-gate.sh` hook (wired via `.claude/settings.json` as a `PreToolUse` hook on `Bash`) runs this same suite automatically before any `git push` issued from a Claude Code session, blocking the push on failure. Unit and Playwright run in parallel (mirroring CI). The hook only fires for Claude (gated by `CLAUDECODE=1`), so human contributors are unaffected. On Playwright "Executable doesn't exist" errors the hook auto-detects the cached Chromium revision under `$PLAYWRIGHT_BROWSERS_PATH` and prints the version-probe + `npm install --no-save` recipe (see "Test Setup Gotchas" below). Escape hatch: `SKIP_PUSH_GATE=1 git push …` (use sparingly; the hook is the safety net).

If any of these fail on the PR but passed locally, that's a signal something is environment-dependent — investigate rather than re-pushing.

## Test Setup Gotchas

- **Run `npm ci` first if `node_modules/` is missing.** With deps installed, the full unit suite (`npm run test:unit`, 788 tests) completes in **~20 s** locally; individual files are sub-second to a few seconds. If a run is taking materially longer, something is wrong — don't "wait it out." Common causes: missing deps (several tests hang indefinitely on missing transitive requires rather than erroring; `sensor-apply` and `sensor-discovery` are the usual offenders because they build local HTTP servers that wait on a peer module that never loads), or stale `node` processes from a previous killed run (check `ps -C node` and `pkill -9 node`).
- **Use tight Bash timeouts for tests.** Full suite: `timeout 30` (20 s baseline + headroom). Single file: `timeout 10`. A test that times out is a signal to investigate, not to retry with a bigger budget. 5-minute timeouts burn minutes of wall clock and hide real issues.
- **`import { test, expect } from './fixtures.js'`** for all Playwright specs (both `tests/frontend/` and `tests/e2e/`) — NOT from `@playwright/test`. The fixture blocks Google Fonts so page loads don't hang in offline environments.
- **Playwright version ↔ cached Chromium revision is a Claude sandbox concern only.** The Claude cloud sandbox ships a pre-cached Chromium under `$PLAYWRIGHT_BROWSERS_PATH` (typically `/opt/pw-browsers/`, e.g. `chromium-1194`), so agents running there must run against a `@playwright/test` version whose bundled Chromium matches that cache. On "browser not found" / "Executable doesn't exist at …" errors in that environment, downgrade the installed package — **do NOT edit `package.json`**; the repo must stay on the latest production-ready release. Concrete recipe:

  ```bash
  # 1. find the cached chromium revision
  ls "$PLAYWRIGHT_BROWSERS_PATH" | grep chromium-        # e.g. chromium-1194
  # 2. probe npm for the matching @playwright/test version
  for v in 1.55.0 1.56.0 1.56.1 1.57.0 1.58.0 1.59.0 1.59.1; do
    npm pack --silent "playwright-core@$v" >/dev/null 2>&1
    rev=$(tar -xOf "playwright-core-$v.tgz" package/browsers.json \
      | node -e "const b=JSON.parse(require('fs').readFileSync(0,'utf8'));
                 console.log(b.browsers.find(x=>x.name==='chromium').revision)")
    echo "$v -> chromium $rev"; rm -f "playwright-core-$v.tgz"
  done
  # 3. install the match *without* touching package.json / package-lock.json
  npm install --no-save @playwright/test@<version> playwright@<version>
  # 4. run tests
  npm test
  ```

  Revert by re-running `npm ci` before committing. **In-repo, always track the latest production-ready `@playwright/test` release** — CI installs the matching Chromium via `npx playwright install --with-deps chromium`, with `~/.cache/ms-playwright` cached by `actions/cache` keyed on the package version, so a bump invalidates the cache automatically and pulls a fresh browser on the next run.
- **Use plain `serve`, NOT `serve -s`.** SPA mode rewrites `/flow-tester.html` → `/flow-tester` → `index.html`, so standalone pages (flow-tester, liquid-glass-test) become unreachable. Playwright config auto-starts plain `serve` on port 3210.

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
