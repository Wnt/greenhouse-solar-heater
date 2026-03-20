# Tasks: Deploy PoC Web UI to Cloud

**Input**: Design documents from `/specs/001-deploy-web-ui-cloud/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/api.md

**Tests**: Included per Constitution Principle IV (Proportional Test Coverage) — new auth logic requires unit tests, and the login flow requires e2e tests.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, dependencies, and directory structure

- [ ] T001 Create deployment directory structure: `deploy/terraform/`, `deploy/docker/`, `deploy/wireguard/`, `poc/auth/`
- [ ] T002 Add @simplewebauthn/server dependency to `package.json`
- [ ] T003 [P] Vendor @simplewebauthn/browser as ESM to `poc/vendor/simplewebauthn-browser.mjs`
- [ ] T004 [P] Add `poc/vendor/simplewebauthn-browser.mjs` to importmap in `poc/index.html` and new `poc/login.html`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T005 Create structured logging module in `poc/lib/logger.js` — JSON format with timestamp, level, component fields; wraps console.log/error for machine-parseable output (FR-013)
- [ ] T006 [P] Add `/health` endpoint to `poc/server.js` — returns `{ status, vpn, timestamp }` per contracts/api.md; no auth required; checks if VPN tunnel peer IPs are reachable
- [ ] T007 [P] Create WireGuard config template in `deploy/wireguard/wg0.conf.example` with placeholder keys and documented fields per research.md

**Checkpoint**: Foundation ready — structured logging, health endpoint, and VPN template in place

---

## Phase 3: User Story 2 - Passkey Authentication (Priority: P1)

**Goal**: Protect all UI and API endpoints with WebAuthn passkey authentication, including a time-limited initial registration flow

**Independent Test**: Attempt to access any page without credentials → redirected to login. Authenticate with passkey → full access granted. Access `/auth/status` → returns auth state.

### Tests for User Story 2

- [ ] T008 [P] [US2] Write unit tests for session module in `tests/auth.test.js` — cover createSession, validateSession, expireSession, HMAC signing/verification, 30-day expiry
- [ ] T009 [P] [US2] Write unit tests for WebAuthn handlers in `tests/auth.test.js` — cover registration options, registration verify, login options, login verify, setup window timer (30 min), credential store read/write

### Implementation for User Story 2

- [ ] T010 [P] [US2] Implement JSON credential store in `poc/auth/credentials.js` — read/write `credentials.json`, create user, add credential, add/validate/expire sessions, manage setup state per data-model.md
- [ ] T011 [P] [US2] Implement session middleware in `poc/auth/session.js` — HMAC-signed cookies using `crypto.createHmac`, 30-day expiry, `HttpOnly`/`Secure`/`SameSite=Strict` flags per contracts/api.md
- [ ] T012 [US2] Implement WebAuthn handlers in `poc/auth/webauthn.js` — registration options/verify, login options/verify using @simplewebauthn/server; enforce 30-minute setup window for registration per FR-005; all endpoints per contracts/api.md
- [ ] T013 [US2] Integrate auth middleware into `poc/server.js` — route `/auth/*` to webauthn handlers; protect all other routes with session validation; redirect unauthenticated requests to `/login.html`; exempt `/health`, `/login.html`, `/auth/*` from auth; add structured logging
- [ ] T014 [P] [US2] Create login page `poc/login.html` — passkey login button, registration form (shown only during setup window), uses @simplewebauthn/browser via importmap, calls `/auth/status` to detect mode
- [ ] T015 [P] [US2] Create browser-side auth module `poc/js/login.js` — ES module using @simplewebauthn/browser `startRegistration()`/`startAuthentication()`, fetch calls to `/auth/*` endpoints, redirect to `/` on success

**Checkpoint**: Auth fully functional — unauthenticated users blocked, passkey login works, sessions persist 30 days

---

## Phase 4: User Story 4 - Infrastructure Reproducibility (Priority: P2)

**Goal**: Define all cloud infrastructure as Terraform code so the deployment can be created, updated, or torn down with a single command

**Independent Test**: Run `terraform init && terraform plan` — produces a valid execution plan with server, firewall, and DNS resources. Run `terraform apply` — creates a working UpCloud server with Docker and WireGuard installed.

### Implementation for User Story 4

- [ ] T016 [P] [US4] Create Terraform provider config and server resource in `deploy/terraform/main.tf` — UpCloud provider (`UpCloudLtd/upcloud ~> 5.0`), Cloudflare provider for DNS; `upcloud_server` resource with `1xCPU-2GB` plan in `fi-hel1`, Ubuntu 24.04 LTS template, SSH key login, `user_data` pointing to cloud-init
- [ ] T017 [P] [US4] Create Terraform variables in `deploy/terraform/variables.tf` — `ssh_public_key`, `domain`, `cloudflare_zone_id`, `upcloud_zone` (default `fi-hel1`), `server_plan` (default `1xCPU-2GB`)
- [ ] T018 [P] [US4] Create Terraform outputs in `deploy/terraform/outputs.tf` — `server_ip`, `domain`
- [ ] T019 [US4] Create firewall rules in `deploy/terraform/main.tf` — `upcloud_firewall_rules` allowing TCP 22 (SSH), TCP 443 (HTTPS), UDP 51820 (WireGuard); drop all other inbound
- [ ] T020 [US4] Create Cloudflare DNS A record in `deploy/terraform/main.tf` — points domain to `upcloud_server` public IP
- [ ] T021 [US4] Create cloud-init config in `deploy/terraform/cloud-init.yaml` — install Docker (official repo), Docker Compose plugin, WireGuard; enable IP forwarding; generate WireGuard keypair; create systemd unit for `wg-quick@wg0`; create deploy user with Docker group
- [ ] T022 [P] [US4] Create `deploy/terraform/terraform.tfvars.example` with placeholder values and comments explaining each variable

**Checkpoint**: `terraform apply` creates a fully provisioned UpCloud server with Docker + WireGuard ready

---

## Phase 5: User Story 1 - Remote Temperature Monitoring (Priority: P1)

**Goal**: Serve the PoC UI from a Docker container on UpCloud, proxying Shelly RPC calls over the WireGuard VPN tunnel

**Independent Test**: Navigate to the public URL, authenticate with passkey, see live temperature readings from Shelly sensors on-site.

**Dependencies**: Requires US2 (auth) and US4 (infrastructure) to be complete

### Implementation for User Story 1

- [ ] T023 [P] [US1] Create Dockerfile in `deploy/docker/Dockerfile` — Node.js 20 LTS Alpine base, copy `poc/` and `package.json`, `npm ci --omit=dev`, expose port 3000, healthcheck `curl -f http://localhost:3000/health`, structured log output
- [ ] T024 [P] [US1] Create Caddyfile in `deploy/docker/Caddyfile` — reverse proxy `localhost:3000`, automatic HTTPS via Let's Encrypt, domain from env var `DOMAIN`
- [ ] T025 [US1] Create Docker Compose config in `deploy/docker/docker-compose.yml` — two services: `app` (Node.js from Dockerfile, env vars for RPID/ORIGIN/SESSION_SECRET, restart: unless-stopped, healthcheck, volume for credentials.json persistence) and `caddy` (official Caddy image, Caddyfile mount, ports 80/443, volume for cert data, restart: unless-stopped, depends_on app)
- [ ] T026 [US1] Update `poc/server.js` proxy error handling — return structured JSON errors when Shelly device is unreachable over VPN (FR-009); include timeout handling with meaningful messages; use structured logger from T005
- [ ] T027 [US1] Add VPN connectivity check to `/health` endpoint in `poc/server.js` — attempt TCP connection to a known Shelly IP (from env or config) to determine `vpn: "connected"` vs `"disconnected"` status

**Checkpoint**: Docker Compose runs the full stack locally; deployed to UpCloud with VPN, users see live sensor data after passkey auth

---

## Phase 6: User Story 3 - Remote Valve Control (Priority: P2)

**Goal**: Ensure valve commands work reliably over VPN with proper error handling when connectivity is lost

**Independent Test**: Toggle a valve from the remote UI, verify state change on-site. Disconnect VPN, attempt valve control, verify error message.

**Dependencies**: Requires US1 (remote monitoring) to be complete — valve control uses the same RPC proxy

### Implementation for User Story 3

- [ ] T028 [US3] Add VPN-aware error handling to RPC proxy in `poc/server.js` — detect VPN-down state before forwarding valve commands; return `{ error: "VPN disconnected — cannot reach controller" }` with HTTP 503; prevent partial command sends (FR-009)
- [ ] T029 [US3] Update `poc/js/app.js` valve control error display — show user-friendly error banner when valve command fails due to VPN; distinguish between device-level errors and connectivity errors; clear error on recovery

**Checkpoint**: Valve commands work over VPN; clear error messages when VPN is down; no partial commands sent

---

## Phase 7: User Story 5 - Continuous Deployment via GitHub Actions (Priority: P2)

**Goal**: Automatically deploy the updated application when changes are merged to main and all tests pass

**Independent Test**: Merge a visible change (e.g., page title) to main; verify the change appears on the production instance after the pipeline completes.

**Dependencies**: Requires US4 (infrastructure) — server must exist for deployment target

### Implementation for User Story 5

- [ ] T030 [US5] Create GitHub Actions deploy workflow in `.github/workflows/deploy.yml` — triggers on push to main; three jobs chained with `needs`: `test` (npm test + Playwright), `build-and-push` (build Docker image, push to GHCR with SHA + latest tags, GHA layer cache), `deploy` (SSH to UpCloud, docker compose pull + up -d --wait, image prune); uses `GITHUB_TOKEN` for GHCR auth
- [ ] T031 [US5] Add `.dockerignore` at repo root — exclude `.git/`, `node_modules/`, `tests/`, `specs/`, `deploy/terraform/`, `docs/`, `diagrams/`, `playground/`, `.github/`
- [ ] T032 [US5] Document required GitHub secrets in `deploy/README.md` — `DEPLOY_SSH_KEY` (Ed25519), `DEPLOY_HOST`, `DEPLOY_USER`; include setup instructions for the deploy user on UpCloud server

**Checkpoint**: Merging to main with passing tests triggers automatic deployment to production

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, documentation, and cleanup

- [ ] T033 [P] Update `CLAUDE.md` with new deployment structure, auth module, Docker workflow, and CD pipeline
- [ ] T034 [P] Write e2e test for login flow in `tests/e2e/auth.spec.js` — Playwright test: navigate to root → redirected to login → complete registration (mock WebAuthn) → redirected to main UI → session persists on reload
- [ ] T035 Run full test suite (`npm test`) and fix any failures
- [ ] T036 Validate quickstart.md — follow local development steps end-to-end, verify Docker build and compose up work locally

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US2 Auth (Phase 3)**: Depends on Foundational — can proceed independently
- **US4 Infrastructure (Phase 4)**: Depends on Foundational — can proceed in parallel with US2
- **US1 Remote Monitoring (Phase 5)**: Depends on US2 (auth) + US4 (infrastructure)
- **US3 Valve Control (Phase 6)**: Depends on US1 (uses same proxy)
- **US5 CD (Phase 7)**: Depends on US4 (needs deploy target) + US1 (needs Docker image)
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

```
Phase 1: Setup
  │
Phase 2: Foundational
  ├──────────────────────┐
  │                      │
Phase 3: US2 Auth    Phase 4: US4 Infra
  │                      │
  └──────────┬───────────┘
             │
Phase 5: US1 Remote Monitoring
  │          │
  │     Phase 7: US5 CD
  │
Phase 6: US3 Valve Control
  │
Phase 8: Polish
```

### Within Each User Story

- Tests written FIRST, ensure they FAIL before implementation
- Data layer (credential store) before business logic (WebAuthn handlers)
- Server-side before client-side
- Core implementation before integration
- Story complete before moving to dependent stories

### Parallel Opportunities

- **Phase 1**: T003 and T004 can run in parallel
- **Phase 2**: T006 and T007 can run in parallel
- **Phase 3 (US2)**: T008+T009 (tests) in parallel; T010+T011 (data+session) in parallel; T014+T015 (login page + JS) in parallel
- **Phase 4 (US4)**: T016+T017+T018+T022 can all run in parallel
- **Phase 5 (US1)**: T023+T024 (Dockerfile+Caddy) in parallel
- **Phase 8**: T033+T034 in parallel

---

## Parallel Example: User Story 2 (Auth)

```
# Launch tests first (parallel):
T008: Unit tests for session module in tests/auth.test.js
T009: Unit tests for WebAuthn handlers in tests/auth.test.js

# Launch data layer (parallel, after tests):
T010: JSON credential store in poc/auth/credentials.js
T011: Session middleware in poc/auth/session.js

# Sequential (depends on T010, T011):
T012: WebAuthn handlers in poc/auth/webauthn.js
T013: Auth integration into poc/server.js

# Launch UI (parallel, after T012):
T014: Login page poc/login.html
T015: Browser auth module poc/js/login.js
```

## Parallel Example: User Story 4 (Infrastructure)

```
# All Terraform files can be created in parallel:
T016: main.tf (provider + server)
T017: variables.tf
T018: outputs.tf
T022: terraform.tfvars.example

# Sequential (depends on T016):
T019: Firewall rules in main.tf
T020: DNS record in main.tf
T021: cloud-init.yaml
```

---

## Implementation Strategy

### MVP First (User Stories 2 + 1)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational
3. Complete Phase 3: US2 Auth — test locally with `AUTH_ENABLED=true`
4. Complete Phase 4: US4 Infra — provision UpCloud server
5. Complete Phase 5: US1 Remote Monitoring — deploy Docker stack, configure VPN
6. **STOP and VALIDATE**: Access from external device, authenticate, see live data

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. US2 Auth → Login works locally (testable without VPN/server)
3. US4 Infra → Server provisioned and ready
4. US1 Remote Monitoring → **MVP deployed and accessible from internet**
5. US3 Valve Control → Better VPN error handling for valve commands
6. US5 CD → Automated deployments on merge to main
7. Polish → Documentation, tests, validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US2 (Auth) and US4 (Infra) can be developed in parallel — auth is testable locally without infrastructure
- US3 (Valve Control) is lightweight — the existing proxy already handles valve commands; only VPN error handling is new
- Constitution compliance: no changes to control-logic.js, safety rules unaffected, structured logging throughout
- Commit after each task or logical group
