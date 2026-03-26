# Research: Remove Monitor App, Promote Playground

**Feature**: 013-remove-monitor-app
**Date**: 2026-03-26

## R1: Monitor App File Inventory — What to Delete

**Decision**: Delete monitor UI and push notification files; preserve and relocate auth code and server-side libraries.

**Files to DELETE**:
- `monitor/index.html` — monitor web UI (gauges, charts)
- `monitor/offline.html` — PWA offline fallback
- `monitor/sw.js` — service worker (push notifications, offline caching)
- `monitor/manifest.json` — PWA manifest
- `monitor/css/style.css` — monitor-specific styles
- `monitor/js/app.js` — monitor app orchestration
- `monitor/js/chart.js` — Canvas time-series chart
- `monitor/js/gauge.js` — SVG gauge component
- `monitor/js/push.js` — push subscription management
- `monitor/js/shelly-api.js` — HTTP RPC client (monitor-specific)
- `monitor/icons/icon-192.png` — PWA icon
- `monitor/icons/icon-512.png` — PWA icon
- `monitor/shelly/sensor-display.js` — PoC Shelly script
- `monitor/shelly/deploy-poc.sh` — PoC deploy script
- `monitor/lib/push-storage.js` — push subscription storage

**Files to MOVE** (from `monitor/` to `server/`):
- `monitor/server.js` → `server/server.js` (with modifications)
- `monitor/auth/credentials.js` → `server/auth/credentials.js`
- `monitor/auth/invitations.js` → `server/auth/invitations.js`
- `monitor/auth/session.js` → `server/auth/session.js`
- `monitor/auth/webauthn.js` → `server/auth/webauthn.js`
- `monitor/lib/logger.js` → `server/lib/logger.js`
- `monitor/lib/s3-storage.js` → `server/lib/s3-storage.js`
- `monitor/lib/db.js` → `server/lib/db.js`
- `monitor/lib/db-config.js` → `server/lib/db-config.js`
- `monitor/lib/mqtt-bridge.js` → `server/lib/mqtt-bridge.js`
- `monitor/lib/device-config.js` → `server/lib/device-config.js`
- `monitor/lib/tracing.js` → `server/lib/tracing.js`
- `monitor/lib/nr-config.js` → `server/lib/nr-config.js`
- `monitor/lib/vpn-config.js` → `server/lib/vpn-config.js`
- `monitor/lib/valve-poller.js` → `server/lib/valve-poller.js`

**Files to MOVE** (from `monitor/` to `playground/`):
- `monitor/login.html` → `playground/login.html`
- `monitor/js/login.js` → `playground/js/login.js`
- `monitor/vendor/simplewebauthn-browser.mjs` → `playground/vendor/simplewebauthn-browser.mjs`
- `monitor/vendor/qrcode-generator.mjs` → `playground/vendor/qrcode-generator.mjs`

**Rationale**: Clean separation — `monitor/` is fully removed. Auth code is essential for protecting the control system and moves to `server/auth/`. Login page and client-side auth JS move to `playground/` since that's where the frontend lives. Server code retains all functionality needed for live mode (WebSocket, MQTT bridge, RPC proxy, device config, history, valve polling, authentication).

**Alternatives considered**:
- Keep files in `monitor/` → confusing name for a project that no longer has a "monitor" app
- Remove auth entirely → unacceptable, the system controls real hardware and must be protected
- Move everything to root → too flat, loses server/frontend distinction

## R2: Server.js Simplification — What to Remove

**Decision**: Strip push notification routes and monitor-specific static file serving. Keep auth middleware, WebSocket, RPC proxy, device-config, history, and health routes.

**Routes to REMOVE from server.js**:
- `/api/push/*` routes (subscribe, unsubscribe, vapid key)
- Push notification logic (valve change → push notification)
- Monitor static file serving (serving `monitor/` at `/`)

**Routes to KEEP**:
- Auth middleware (protects playground and API routes)
- `/auth/*` routes (registration, login, challenge, verify)
- `/api/rpc/*` — RPC proxy to Shelly devices (used by playground for live data)
- `/api/device-config` — GET/PUT device configuration (used by playground Device view)
- `/api/history` — sensor history (used by playground)
- `/ws` — WebSocket upgrade (MQTT bridge to playground)
- `/health` — health endpoint
- Static file serving for `playground/` (at `/` instead of `/playground/`)
- Static file serving for `shelly/control-logic.js` and `system.yaml`
- Login page asset allowlist (updated for new paths: `login.html`, `js/login.js`, `vendor/simplewebauthn-browser.mjs`, `vendor/qrcode-generator.mjs`)

**Dependencies to REMOVE from package.json**:
- `web-push` — only used for push notifications

**Dependencies to KEEP**:
- `@simplewebauthn/server` — used for WebAuthn passkey auth (retained)

**Rationale**: The system controls real hardware (valves, pump, heaters) and must be protected by authentication. Passkey auth via WebAuthn provides strong, phishing-resistant authentication. Push notifications are removed as they were a monitor-specific feature.

## R3: Deep Linking Implementation Approach

**Decision**: URL hash fragments (`#view-name`) with `hashchange` event listener. No router library needed.

**Implementation**:
1. On nav click: set `window.location.hash = viewId` instead of (or in addition to) toggling classes
2. On page load: read `window.location.hash`, activate matching view
3. On `hashchange` event: activate matching view (handles back/forward)
4. Invalid/empty hash: default to `#status`
5. Extract view switching into a reusable `navigateToView(viewId)` function

**Rationale**: Hash-based routing is the simplest approach for a single-page app with no dynamic content loading. No library needed — just native browser APIs. The existing view switching logic (classList toggle) is preserved, just triggered from hash changes instead of click events alone.

**Alternatives considered**:
- History API (`pushState`) — more complex, requires server-side fallback for direct URL access. Not needed since this is a true SPA with a single HTML file.
- Router library — overkill for 5 static views.

## R4: Device Configuration Descriptions

**Decision**: Add inline description text below each configuration option in the Device view HTML.

**Descriptions to add**:

- **Controls Enabled** (master toggle): "Master switch for all hardware control. When disabled, the controller monitors sensors but does not actuate any relays — valves stay closed, pump stays off. Use this to safely disable all automation while keeping monitoring active."

- **Enabled Actuators** (section intro): "Selectively enable or disable individual actuators. Disabled actuators will not be activated by any operating mode, even if the mode would normally use them."
  - **Valves**: "Motorized ball valves that direct water flow between tank, collectors, and radiators. Disabling prevents all valve movement."
  - **Pump**: "Circulation pump that moves water through the system. Disabling prevents water circulation in all modes."
  - **Fan**: "Greenhouse ventilation fan. Disabling prevents forced air circulation."
  - **Space Heater**: "Electric space heater for greenhouse backup heating. Disabling prevents the heater from activating."
  - **Immersion Heater**: "Electric immersion heater in the water tank. Disabling prevents direct electric water heating."

- **Forced Mode** (dropdown): "Override automatic mode selection. When set, the controller will stay in the selected mode regardless of sensor readings. Set to 'Automatic' to restore normal operation."
  - **Idle**: "System monitors but takes no action. All actuators off."
  - **Solar Charging**: "Circulates water through collectors to capture solar heat into the tank."
  - **Greenhouse Heating**: "Circulates hot water from the tank through radiators to heat the greenhouse."
  - **Active Drain**: "Drains water from collectors to prevent freezing. Safety mode."
  - **Emergency Heating**: "Activates backup electric heating when temperatures are critically low."

- **Allowed Modes** (section): "Restrict which modes the automation can select. Unchecked modes will never be activated automatically. The forced mode override is not affected by this setting."

**Rationale**: Descriptions are embedded as HTML `<p>` elements with a muted style, consistent with the existing "Uncheck modes to prevent..." description already present in the Allowed Modes section.

## R5: Shelly Deploy Integration in Deployer

**Decision**: The deploy step already exists in `deploy/deployer/deploy.sh` (lines 189-201). It runs conditionally when `CONTROLLER_VPN_IP` is set. No new mechanism needed — just ensure `CONTROLLER_VPN_IP` is configured.

**Current behavior** (already implemented):
```bash
if [ -n "${CONTROLLER_VPN_IP:-}" ]; then
  timeout 60 docker compose exec -T app \
    env DEPLOY_VIA_VPN=true CONTROLLER_VPN_IP="$CONTROLLER_VPN_IP" \
    bash shelly/deploy.sh || echo "[WARN] Shelly script deploy failed"
fi
```

**What needs to change**:
- Ensure `CONTROLLER_VPN_IP` is set in the environment (it should come from `.env` or `config.env`)
- Update the `deploy.sh` path references from `monitor/lib/` to `server/lib/`
- The Shelly deploy script (`shelly/deploy.sh`) already uses `192.168.1.174` in `devices.conf` — no IP change needed
- Ensure the Docker image includes `shelly/deploy.sh`, `shelly/devices.conf`, and all script files (currently only `control-logic.js` is copied)

**Dockerfile changes needed**:
- Copy entire `shelly/` directory (not just `control-logic.js`) so deploy can run inside container
- Update paths from `monitor/` to `server/`

**Rationale**: The mechanism already exists and works. The main work is ensuring the container has the shelly scripts and the environment variable is configured.

## R6: Test Impact Analysis

**Tests to DELETE** (monitor-specific):
- `tests/push-storage.test.js` — tests push subscription storage (being removed)
- `tests/sw.test.js` — tests service worker (being removed)

**Tests to MODIFY** (import path updates from `monitor/` to `server/`):
- `tests/auth.test.js` — update import paths from `monitor/auth/` to `server/auth/`
- `tests/s3-storage.test.js` — update import paths from `monitor/lib/` to `server/lib/`
- `tests/db.test.js` — update import paths
- `tests/tracing.test.js` — update import paths
- `tests/mqtt-bridge.test.js` — update import paths
- `tests/device-config.test.js` — update import paths
- `tests/device-config-integration.test.js` — update import paths
- `tests/data-source.test.js` — update import paths (if any)
- `tests/rpc-proxy.test.js` — update import paths
- `tests/valve-poller.test.js` — update import paths
- `tests/vpn-config.test.js` — update import paths

**Tests to KEEP unchanged**:
- `tests/control-logic.test.js` — tests `shelly/control-logic.js` (unchanged)
- `tests/playground-control.test.js` — tests playground control wrapper (unchanged)
- `tests/simulation/` — thermal model tests (unchanged)
- `tests/e2e/thermal-sim.spec.js` — playground e2e (unchanged)
- `tests/e2e/device-config.spec.js` — device config e2e (unchanged)
- `tests/e2e/live-mode.spec.js` — live mode e2e (unchanged)
- `tests/e2e/take-screenshots.spec.js` — screenshot generator (unchanged)

**Tests to ADD**:
- E2e test for deep linking (hash navigation, back/forward, direct URL access)

**Tests to REVIEW**:
- `tests/e2e/pwa.spec.js` — depends on manifest.json and service worker. Since these are being removed, this test should be removed or simplified to only test what remains.

## R7: CI/CD Impact

**Workflows to MODIFY**:
- `.github/workflows/ci.yml` — test command unchanged (`npm test`), but may reference monitor paths
- `.github/workflows/deploy.yml` — Docker build context, image paths
- `.github/workflows/deploy-pages.yml` — playground path (should work as-is if playground stays at `playground/`)

**Dockerfile changes**:
- Replace `COPY monitor/ ./monitor/` with `COPY server/ ./server/`
- Add `COPY shelly/ ./shelly/` (full directory for deploy capability)
- Keep `COPY playground/ ./playground/` (now includes login.html, login.js, auth vendor libs)
- Update CMD from `node --require ./monitor/lib/tracing.js monitor/server.js` to `node --require ./server/lib/tracing.js server/server.js`

**deploy.sh changes**:
- Update all `monitor/lib/` references to `server/lib/`
- VPN config: `node server/lib/vpn-config.js download ...`
- DB config: `node server/lib/db-config.js load`
- NR config: `node server/lib/nr-config.js load`
