# Research: Organize Repository Structure

**Feature**: 006-organize-repo-structure
**Date**: 2026-03-21

## R1: system.yaml Placement — Root vs. Design Directory

**Decision**: Keep `system.yaml` at the repository root.

**Rationale**: `system.yaml` is the single source of truth for the entire project (constitution principle I). It is referenced by `playground/js/yaml-loader.js` via `../system.yaml` and by the Shelly linter via `system.yaml` (root-relative). Keeping it at root avoids updating these paths and reinforces its cross-cutting role. It parallels how `package.json` stays at root.

**Alternatives considered**:
- Move to `design/system.yaml` — rejected because it adds a path segment to every consumer and obscures its project-wide authority.

## R2: Test Organization — Centralized vs. Co-located

**Decision**: Keep tests centralized in `tests/` at the root.

**Rationale**: Multiple test files cross unit boundaries. The simulation tests require both `control-logic.js` (Shelly) and the thermal model. The `package.json` test scripts list each test file explicitly. Co-locating tests per unit would require splitting the test configuration and potentially multiple test commands. The current structure works well with clear naming conventions (`control-logic.test.js` → Shelly, `auth.test.js` → monitor, etc.).

**Alternatives considered**:
- Co-locate tests inside each unit (e.g., `shelly/tests/`, `monitor/tests/`) — rejected because simulation tests depend on both Shelly and playground code, and it would complicate the npm test scripts.

## R3: Monitoring App Naming — poc vs. monitor vs. app

**Decision**: Rename `poc/` to `monitor/`.

**Rationale**: The app has grown well beyond proof-of-concept stage — it has auth, push notifications, PWA support, S3 persistence, and a deployment pipeline. "monitor" accurately describes its purpose (temperature monitoring and valve state display). "app" is too generic.

**Alternatives considered**:
- Keep `poc/` — rejected because the name is misleading; contributors may think it's throwaway code.
- Rename to `app/` — rejected; too generic for a repo that may grow additional apps.

## R4: Shelly Directory — Naming and Linter Placement

**Decision**: Rename `scripts/` to `shelly/` and move `tools/shelly-lint/` into `shelly/lint/`.

**Rationale**: The `scripts/` name is generic and doesn't convey that these are Shelly device scripts. `shelly/` is self-descriptive. The linter exclusively validates Shelly code, so co-locating it removes the now-empty `tools/` directory and satisfies FR-004.

**Alternatives considered**:
- Keep `scripts/` and `tools/` separate — rejected because it leaves two directories for a single concern.
- Name it `shelly-scripts/` — rejected; redundant once it's a directory.

## R5: Hardware Design Consolidation — Directory Structure

**Decision**: Create `design/` to consolidate `docs/`, `diagrams/`, `construction/`, and `existing-hardware/`.

**Rationale**: These four directories all document the physical system design. Consolidating them under `design/` reduces 4 top-level directories to 1 and groups related content. Subdirectory names are preserved inside `design/` to maintain familiarity.

**Structure**:
```
design/
  docs/              ← docs/ (design.md, bom.md, ideas/, superpowers/)
  diagrams/          ← diagrams/ (SVGs + Mermaid)
  construction/      ← construction/
  photos/            ← existing-hardware/ (clearer name)
```

**Alternatives considered**:
- Name it `hardware/` — rejected; the directory also contains design rationale, ideas, and BOM which aren't strictly hardware.
- Flatten all files directly into `design/` — rejected; the subdirectories provide useful sub-grouping.

## R6: Playground Directory — Rename or Keep

**Decision**: Keep `playground/` as-is.

**Rationale**: The name is already descriptive and well-established. The GitHub Pages workflow references `playground/` as the artifact path. No benefit to renaming.

## R7: Deploy Directory — Rename or Keep

**Decision**: Keep `deploy/` as-is.

**Rationale**: Already well-named and self-contained. No changes needed to internal structure.

## R8: Cross-Reference Update Impact Analysis

**Affected files by each move**:

### scripts/ → shelly/ (4 files need path updates)
| File | Current Reference | New Reference |
|------|-------------------|---------------|
| `tests/control-logic.test.js` | `../scripts/control-logic.js` | `../shelly/control-logic.js` |
| `tests/simulation/simulator.js` | `../../scripts/control-logic.js` | `../../shelly/control-logic.js` |
| `tests/simulation/scenarios.js` | `../../scripts/control-logic.js` | `../../shelly/control-logic.js` |
| `tests/deploy.test.js` | `../scripts/deploy.sh`, `../scripts/devices.conf` | `../shelly/deploy.sh`, `../shelly/devices.conf` |

### tools/shelly-lint/ → shelly/lint/ (1 workflow file)
| File | Current Reference | New Reference |
|------|-------------------|---------------|
| `.github/workflows/lint-shelly.yml` | `tools/shelly-lint/**`, `tools/shelly-lint` (working-dir), `tools/shelly-lint/bin/shelly-lint.js` | `shelly/lint/**`, `shelly/lint`, `shelly/lint/bin/shelly-lint.js` |
| `.github/workflows/lint-shelly.yml` | `scripts/**`, `scripts/control-logic.js`, `scripts/control.js` | `shelly/**`, `shelly/control-logic.js`, `shelly/control.js` |

### poc/ → monitor/ (12+ files need path updates)
| File | Current Reference | New Reference |
|------|-------------------|---------------|
| `deploy/docker/Dockerfile` | `COPY poc/ ./poc/`, `CMD ["node", "poc/server.js"]` | `COPY monitor/ ./monitor/`, `CMD ["node", "monitor/server.js"]` |
| `deploy/deployer/deploy.sh` | `node poc/lib/vpn-config.js` | `node monitor/lib/vpn-config.js` |
| `.dockerignore` | `!poc/**/*.md` | `!monitor/**/*.md` |
| `tests/auth.test.js` | `../poc/auth/session` | `../monitor/auth/session` |
| `tests/s3-storage.test.js` | `../poc/lib/s3-storage` | `../monitor/lib/s3-storage` |
| `tests/vpn-config.test.js` | `../poc/lib/vpn-config` | `../monitor/lib/vpn-config` |
| `tests/push-storage.test.js` | `../poc/lib/push-storage` | `../monitor/lib/push-storage` |
| `tests/valve-poller.test.js` | `../poc/lib/valve-poller` | `../monitor/lib/valve-poller` |
| `tests/e2e/poc-login.spec.js` | `/poc/login.html` | `/monitor/login.html` |
| `tests/e2e/logout.spec.js` | `/poc/` | `/monitor/` |
| `playground/index.html` | `../poc/index.html` | `../monitor/index.html` |

### docs/, diagrams/, construction/, existing-hardware/ → design/
| File | Current Reference | New Reference |
|------|-------------------|---------------|
| `CLAUDE.md` | Multiple path references | Updated to `design/` prefix |
| `README.md` | Any path references | Updated to `design/` prefix |
| `.dockerignore` | `docs/`, `diagrams/`, `construction/`, `existing-hardware/` | `design/` |

### .dockerignore updates
| Current Entry | New Entry |
|---------------|-----------|
| `scripts/` | `shelly/` |
| `tools/` | (removed — tools/ no longer exists) |
| `docs/` | `design/` |
| `diagrams/` | (removed — inside design/) |
| `construction/` | (removed — inside design/) |
| `existing-hardware/` | (removed — inside design/) |
| `!poc/**/*.md` | `!monitor/**/*.md` |
