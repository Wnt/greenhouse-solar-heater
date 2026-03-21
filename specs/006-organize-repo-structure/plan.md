# Implementation Plan: Organize Repository Structure

**Branch**: `006-organize-repo-structure` | **Date**: 2026-03-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-organize-repo-structure/spec.md`

## Summary

Reorganize the repository from 10 scattered top-level directories into 5 clear logical units plus centralized tests. The main moves are: `scripts/` + `tools/shelly-lint/` → `shelly/`, `poc/` → `monitor/`, `docs/` + `diagrams/` + `construction/` + `existing-hardware/` → `design/`. `playground/` and `deploy/` stay as-is. All cross-references (test imports, CI workflows, Dockerfiles, .dockerignore) are updated. `system.yaml` stays at root.

## Technical Context

**Language/Version**: JavaScript ES5 (Shelly), ES6+ (browser modules), Node.js 20 LTS (server, CommonJS)
**Primary Dependencies**: @simplewebauthn/server, @aws-sdk/client-s3, web-push, Playwright, Acorn (linter)
**Storage**: S3-compatible object storage (UpCloud), local filesystem fallback
**Testing**: node:test (unit), Playwright (e2e), custom simulation harness
**Target Platform**: Shelly devices (ES5), Linux server (Node.js), browsers (ES6+), GitHub Pages
**Project Type**: Multi-component IoT system (device scripts + web app + simulators + infrastructure)
**Performance Goals**: N/A for restructuring
**Constraints**: Zero functional regressions — all tests, CI, deployment, and GH Pages must continue working
**Scale/Scope**: ~80 source files across 5 logical units, ~20 cross-reference updates

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Hardware Spec as Single Source of Truth | PASS | `system.yaml` stays at root, accessible to all units |
| II. Pure Logic / IO Separation | PASS | No changes to logic/IO boundary, files just move |
| III. Safe by Default (NON-NEGOTIABLE) | PASS | No control logic changes, structural move only |
| IV. Proportional Test Coverage | PASS | All tests preserved, paths updated, test suite must pass |
| V. Token-Based Cloud Auth | PASS | No auth changes |
| VI. Durable Data Persistence | PASS | No persistence changes |

**Platform Constraints**:
- Shelly ES5 constraint: unaffected (scripts move but content unchanged)
- Browser vendored deps: preserved in `playground/vendor/` and `monitor/vendor/`
- Shelly linter: moves to `shelly/lint/`, CI path references updated

**Post-Phase 1 Re-check**: Same — this is a structural change with no logic modifications.

## Project Structure

### Documentation (this feature)

```text
specs/006-organize-repo-structure/
├── plan.md              # This file
├── research.md          # Phase 0 output — 8 decisions documented
├── data-model.md        # Phase 1 output — N/A (structural task)
├── quickstart.md        # Phase 1 output — verification guide
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code — Current → Target Structure

```text
# CURRENT (10 top-level source/doc directories)
scripts/                    # Shelly device scripts
tools/shelly-lint/          # Shelly platform linter
playground/                 # Browser simulators (GH Pages)
poc/                        # Monitoring web app
deploy/                     # Infrastructure (Terraform, Docker, deployer)
docs/                       # Design docs, BOM, ideas
diagrams/                   # SVG + Mermaid diagrams
construction/               # Build instructions
existing-hardware/          # Reference photos
tests/                      # All tests (unit, simulation, e2e)

# TARGET (6 top-level directories)
shelly/                     # ← scripts/ + tools/shelly-lint/
  control.js                #   Shelly shell/IO script
  control-logic.js          #   Pure decision logic
  deploy.sh                 #   Device deployment script
  devices.conf              #   Device IP addresses
  lint/                     #   ← tools/shelly-lint/
    bin/
    package.json
    package-lock.json

playground/                 # (unchanged) Browser simulators
  index.html
  thermal.html
  hydraulic.html
  js/
  css/
  vendor/

monitor/                    # ← poc/ (renamed)
  server.js                 #   Node.js HTTP server
  index.html                #   Web UI
  login.html                #   Auth page
  manifest.json             #   PWA manifest
  sw.js                     #   Service worker
  js/                       #   Client modules
  css/                      #   Styles
  auth/                     #   Server auth modules
  lib/                      #   Shared server libs
  icons/                    #   PWA icons
  vendor/                   #   Vendored deps
  shelly/                   #   PoC Shelly scripts

deploy/                     # (unchanged) Infrastructure
  terraform/
  docker/
  deployer/
  wireguard/

design/                     # ← docs/ + diagrams/ + construction/ + existing-hardware/
  docs/                     #   ← docs/ (design.md, bom.md, ideas/, superpowers/)
  diagrams/                 #   ← diagrams/ (SVGs + Mermaid)
  construction/             #   ← construction/
  photos/                   #   ← existing-hardware/ (renamed)

tests/                      # (unchanged location, paths updated)
  control-logic.test.js
  auth.test.js
  deploy.test.js
  s3-storage.test.js
  vpn-config.test.js
  push-storage.test.js
  valve-poller.test.js
  simulation/
  e2e/

# Root files (unchanged)
system.yaml                 # Single source of truth
package.json                # Project config
CLAUDE.md                   # AI assistant guide
README.md                   # Project readme
IDEAS.md                    # Idea backlog
playwright.config.js        # E2e test config
.gitignore
.dockerignore
```

**Structure Decision**: Multi-unit repository with 6 top-level directories, each representing a distinct concern. Tests stay centralized because simulation tests cross unit boundaries. `system.yaml` stays at root as the project-wide source of truth.

## Cross-Reference Update Matrix

All file path references that must be updated, grouped by move operation:

### Move 1: scripts/ → shelly/

| File to Edit | Current Path | New Path |
|-------------|-------------|----------|
| `tests/control-logic.test.js` | `../scripts/control-logic.js` | `../shelly/control-logic.js` |
| `tests/simulation/simulator.js` | `../../scripts/control-logic.js` | `../../shelly/control-logic.js` |
| `tests/simulation/scenarios.js` | `../../scripts/control-logic.js` | `../../shelly/control-logic.js` |
| `tests/deploy.test.js` | `../scripts/deploy.sh` | `../shelly/deploy.sh` |
| `tests/deploy.test.js` | `../scripts/devices.conf` | `../shelly/devices.conf` |

### Move 2: tools/shelly-lint/ → shelly/lint/

| File to Edit | Current Path | New Path |
|-------------|-------------|----------|
| `.github/workflows/lint-shelly.yml` | `scripts/**` (paths filter) | `shelly/**` |
| `.github/workflows/lint-shelly.yml` | `tools/shelly-lint/**` (paths filter) | `shelly/lint/**` |
| `.github/workflows/lint-shelly.yml` | `tools/shelly-lint` (working-directory) | `shelly/lint` |
| `.github/workflows/lint-shelly.yml` | `node tools/shelly-lint/bin/shelly-lint.js` | `node shelly/lint/bin/shelly-lint.js` |
| `.github/workflows/lint-shelly.yml` | `scripts/control-logic.js` | `shelly/control-logic.js` |
| `.github/workflows/lint-shelly.yml` | `scripts/control.js` | `shelly/control.js` |

### Move 3: poc/ → monitor/

| File to Edit | Current Path | New Path |
|-------------|-------------|----------|
| `deploy/docker/Dockerfile` | `COPY poc/ ./poc/` | `COPY monitor/ ./monitor/` |
| `deploy/docker/Dockerfile` | `CMD ["node", "poc/server.js"]` | `CMD ["node", "monitor/server.js"]` |
| `deploy/deployer/deploy.sh` | `node poc/lib/vpn-config.js` (×2) | `node monitor/lib/vpn-config.js` |
| `tests/auth.test.js` | `../poc/auth/session` | `../monitor/auth/session` |
| `tests/s3-storage.test.js` | `../poc/lib/s3-storage` | `../monitor/lib/s3-storage` |
| `tests/vpn-config.test.js` | `../poc/lib/vpn-config` | `../monitor/lib/vpn-config` |
| `tests/push-storage.test.js` | `../poc/lib/push-storage` | `../monitor/lib/push-storage` |
| `tests/valve-poller.test.js` | `../poc/lib/valve-poller` | `../monitor/lib/valve-poller` |
| `tests/e2e/poc-login.spec.js` | `/poc/login.html` | `/monitor/login.html` |
| `tests/e2e/logout.spec.js` | `/poc/` | `/monitor/` |
| `playground/index.html` | `../poc/index.html` | `../monitor/index.html` |
| `.dockerignore` | `!poc/**/*.md` | `!monitor/**/*.md` |

### Move 4: docs/, diagrams/, construction/, existing-hardware/ → design/

| File to Edit | Current Path | New Path |
|-------------|-------------|----------|
| `.dockerignore` | `docs/` | `design/` |
| `.dockerignore` | `diagrams/` | (remove — covered by `design/`) |
| `.dockerignore` | `construction/` | (remove — covered by `design/`) |
| `.dockerignore` | `existing-hardware/` | (remove — covered by `design/`) |

### Other updates

| File to Edit | Change |
|-------------|--------|
| `.dockerignore` | `scripts/` → `shelly/`, remove `tools/` |
| `CLAUDE.md` | Rewrite file relationships and all path references |
| `README.md` | Update any structure/path references |

## Complexity Tracking

No constitution violations. This is a structural reorganization with no logic changes.
