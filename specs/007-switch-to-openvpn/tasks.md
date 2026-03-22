# Tasks: Switch to OpenVPN

**Input**: Design documents from `/specs/007-switch-to-openvpn/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, quickstart.md

**Tests**: Existing vpn-config.test.js tests must be updated to reflect new config defaults. No new test files requested.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the OpenVPN container image and config generation tooling

- [x] T001 Create OpenVPN Dockerfile in `deploy/openvpn/Dockerfile` — Alpine 3.21 + openvpn package, CMD runs `openvpn --config /etc/openvpn/server.conf`
- [x] T002 [P] Create OpenVPN server config example template in `deploy/openvpn/server.conf.example` — dev tun, proto udp, port 1194, ifconfig 10.10.10.1 10.10.10.2, route 192.168.1.0/24, ping/ping-restart/ping-timer-rem, persist-tun, persist-key, verb 3, inline `<secret>` placeholder. Include setup instructions in comments (replaces `deploy/wireguard/wg0.conf.example`)
- [x] T003 [P] Create setup script in `deploy/openvpn/setup.sh` — generates static key via `openvpn --genkey --secret` (using Docker if openvpn not installed locally), accepts parameters (--server-ip, --server-tunnel-ip, --client-tunnel-ip, --remote-network, --port, --output), embeds key inline via `<secret>` tag, outputs UniFi UI configuration values (Pre-Shared Key hex content, Remote IP, tunnel IPs, Remote Networks, port). Must be executable (chmod +x)

**Checkpoint**: OpenVPN container image and config generation tooling ready

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: No foundational tasks — all prerequisites are handled in Setup (Phase 1)

**Checkpoint**: Foundation ready — user story implementation can begin

---

## Phase 3: User Story 1 — Cloud Server Reaches Home IoT Devices via OpenVPN (Priority: P1) 🎯 MVP

**Goal**: Replace the WireGuard container with OpenVPN in the deployment stack so the monitoring app can reach home LAN Shelly devices through an OpenVPN tunnel

**Independent Test**: Deploy the OpenVPN container, connect UniFi as client, verify the monitoring app can make HTTP RPC calls to a Shelly device on 192.168.1.0/24

### Implementation for User Story 1

- [x] T004 [US1] Replace wireguard service with openvpn in `deploy/deployer/docker-compose.yml` — change service name to `openvpn`, use `build: ../openvpn`, cap_add NET_ADMIN only (remove SYS_MODULE), add `devices: [/dev/net/tun:/dev/net/tun]`, change port 51820/udp to 1194/udp, mount `./openvpn.conf:/etc/openvpn/server.conf:ro`, keep sysctls ip_forward=1, remove PUID/PGID env vars. Update app service: `network_mode: "service:openvpn"`, `depends_on: [openvpn]`. Keep profiles: ["vpn"] on the openvpn service
- [x] T005 [P] [US1] Update Caddyfile reverse proxy target in `deploy/deployer/Caddyfile` — change `reverse_proxy wireguard:3000` to `reverse_proxy openvpn:3000`
- [x] T006 [P] [US1] Update Terraform firewall rule in `deploy/terraform/main.tf` — change dynamic VPN firewall_rule: port 51820 → 1194, protocol stays UDP, comment "WireGuard VPN" → "OpenVPN"
- [x] T007 [P] [US1] Update Terraform variable description in `deploy/terraform/variables.tf` — change `enable_vpn` description from "Enable WireGuard VPN container and firewall rule" to "Enable OpenVPN container and firewall rule"

**Checkpoint**: OpenVPN server container replaces WireGuard. UniFi can connect and the app reaches home LAN devices via the tunnel

---

## Phase 4: User Story 2 — VPN Configuration Persists Across Server Recreation (Priority: P2)

**Goal**: OpenVPN config is persisted to S3 and automatically restored when the server is recreated

**Independent Test**: Upload an OpenVPN config to S3, simulate server recreation (delete local config, run deployer), verify config is restored and VPN starts

### Implementation for User Story 2

- [x] T008 [US2] Update VPN config persistence helper in `monitor/lib/vpn-config.js` — change default VPN_CONFIG_KEY from `wg0.conf` to `openvpn.conf`, update JSDoc comments and log messages to reference OpenVPN instead of WireGuard, update Usage comment paths
- [x] T009 [US2] Update deployer script in `deploy/deployer/deploy.sh` — change VPN_CONFIG variable from `$APP_DIR/wg0.conf` to `$APP_DIR/openvpn.conf`, update download/upload node commands to reference new config path, update log messages
- [x] T010 [P] [US2] Update config.env default in `deploy/deployer/config.env` — change `VPN_CONFIG_KEY=wg0.conf` to `VPN_CONFIG_KEY=openvpn.conf`
- [x] T011 [US2] Update vpn-config tests in `tests/vpn-config.test.js` — change sampleConfig to OpenVPN format (dev tun, ifconfig, inline secret), change test file references from `wg0.conf` to `openvpn.conf`, update VPN_CONFIG_KEY default assertion

**Checkpoint**: VPN config persists to S3 as `openvpn.conf` and is restored on server recreation

---

## Phase 5: User Story 3 — Health Monitoring Reports VPN Status (Priority: P3)

**Goal**: Verify the health endpoint continues to report VPN status correctly with OpenVPN (no code changes expected — the health check is VPN-technology-agnostic)

**Independent Test**: Query /health endpoint with tunnel up → "connected", with tunnel down → "disconnected"

### Implementation for User Story 3

- [x] T012 [US3] Verify health check in `monitor/server.js` requires no changes — the `checkVpn()` function uses a TCP probe to `VPN_CHECK_HOST` which is VPN-technology-agnostic. Confirm no WireGuard-specific references exist in server.js health logic. No code changes expected — document verification result

**Checkpoint**: Health endpoint reports VPN status correctly with OpenVPN tunnel

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Remove WireGuard artifacts, update documentation

- [x] T013 Delete WireGuard config directory `deploy/wireguard/` (contains only `wg0.conf.example`)
- [x] T014 [P] Update deployment documentation in `deploy/README.md` — replace all WireGuard references with OpenVPN: port 51820 → 1194, wg0.conf → openvpn.conf, WireGuard container → OpenVPN container, update setup steps to reference `deploy/openvpn/setup.sh`, update architecture description
- [x] T015 [P] Update CLAUDE.md — replace WireGuard references: `deploy/wireguard/` → `deploy/openvpn/`, wg0.conf → openvpn.conf, WireGuard → OpenVPN in deployment architecture section, update file relationships for `monitor/lib/vpn-config.js` description, update docker-compose description, update Active Technologies section with 007-switch-to-openvpn entry
- [x] T016 Run existing tests with `npm run test:unit` to verify vpn-config.test.js changes pass and no other tests are broken

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: N/A (empty)
- **User Story 1 (Phase 3)**: Depends on T001 (Dockerfile exists for docker-compose build reference)
- **User Story 2 (Phase 4)**: Independent of US1 — can run in parallel
- **User Story 3 (Phase 5)**: Independent — verification only, can run any time
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Depends on T001 (Dockerfile). T005, T006, T007 can run in parallel with T004
- **User Story 2 (P2)**: No dependencies on US1 — can run in parallel. T010 can run in parallel with T008/T009
- **User Story 3 (P3)**: No dependencies — verification task only

### Parallel Opportunities

- T002 and T003 can run in parallel with each other (and with T001 if desired)
- T005, T006, T007 can all run in parallel (different files, no dependencies on each other)
- T008/T009 and T010 can run in parallel (different files)
- T014 and T015 can run in parallel (different files)
- US1 and US2 phases can run in parallel since they touch different files

---

## Parallel Example: User Story 1

```bash
# After T001 (Dockerfile) and T004 (docker-compose) are done, these run in parallel:
Task: "Update Caddyfile in deploy/deployer/Caddyfile"              # T005
Task: "Update Terraform firewall in deploy/terraform/main.tf"       # T006
Task: "Update Terraform variable in deploy/terraform/variables.tf"  # T007
```

## Parallel Example: Setup Phase

```bash
# All three setup tasks can run in parallel:
Task: "Create OpenVPN Dockerfile in deploy/openvpn/Dockerfile"           # T001
Task: "Create config template in deploy/openvpn/server.conf.example"     # T002
Task: "Create setup script in deploy/openvpn/setup.sh"                   # T003
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. Complete Phase 3: User Story 1 (T004–T007)
3. **STOP and VALIDATE**: Deploy OpenVPN container, connect UniFi, test tunnel connectivity
4. The monitoring app should reach Shelly devices through the OpenVPN tunnel

### Incremental Delivery

1. Setup (T001–T003) → OpenVPN container and tooling ready
2. User Story 1 (T004–T007) → Tunnel works → Test connectivity (MVP!)
3. User Story 2 (T008–T011) → Config persists to S3 → Test server recreation
4. User Story 3 (T012) → Verify health endpoint → Confirm monitoring works
5. Polish (T013–T016) → Clean up WireGuard, update docs, run tests

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- T012 (US3) is verification-only — the health check is VPN-agnostic and should need no code changes
- The setup script (T003) uses Docker to run `openvpn --genkey` if openvpn is not installed locally
- T004 is the most complex task — it touches multiple sections of docker-compose.yml
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
