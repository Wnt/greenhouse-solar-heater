# Feature Specification: Organize Repository Structure

**Feature Branch**: `006-organize-repo-structure`
**Created**: 2026-03-21
**Status**: Draft
**Input**: User description: "Organize files and directories in the repository. I think there are at least these separate units in the repo: Shelly code, Simulation (deployed to GH pages), PoC Shelly code and Shelly monitor PoC app + it's infra code and the hardware design. Maybe more? Make the repo structure more clean"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Navigate to a Logical Unit Quickly (Priority: P1)

A developer or maintainer opens the repository and wants to find files related to a specific concern — e.g., the Shelly control scripts, the monitoring app, or the deployment infrastructure. The top-level directory structure clearly communicates what each directory contains, and related files are co-located.

**Why this priority**: The primary goal of this reorganization is discoverability. If contributors can't quickly find where things live, all other benefits are moot.

**Independent Test**: A new contributor can identify where to find Shelly device scripts, the monitoring web app, simulation playground files, deployment config, and hardware design docs by reading the top-level directory listing alone.

**Acceptance Scenarios**:

1. **Given** the repository root listing, **When** a contributor looks for Shelly control scripts, **Then** there is one clearly named directory that contains all Shelly device scripts, their deployment tooling, and the platform linter
2. **Given** the repository root listing, **When** a contributor looks for the monitoring web app, **Then** there is one clearly named directory containing the server, client, auth, and related modules
3. **Given** the repository root listing, **When** a contributor looks for simulation/playground code, **Then** there is one clearly named directory for the interactive browser-based simulators
4. **Given** the repository root listing, **When** a contributor looks for deployment infrastructure, **Then** there is one clearly named directory containing Terraform, Docker, deployer, and WireGuard config
5. **Given** the repository root listing, **When** a contributor looks for hardware design, **Then** there is one clearly named directory containing system specs, diagrams, construction docs, BOM, and reference photos

---

### User Story 2 - All Existing Functionality Keeps Working (Priority: P1)

After the reorganization, all tests pass, CI workflows function correctly, deployment pipelines work, GitHub Pages deployment serves the playground, and internal cross-references (imports, paths, configs) are updated.

**Why this priority**: Equal to P1 because a reorganization that breaks the project is worse than no reorganization at all.

**Independent Test**: Run the full test suite (`npm test`), verify CI workflows reference correct paths, verify import paths in playground code, and confirm deployment Dockerfiles and scripts reference correct locations.

**Acceptance Scenarios**:

1. **Given** the reorganized repo, **When** the test suite is run, **Then** all unit, simulation, and e2e tests pass
2. **Given** the reorganized repo, **When** CI workflows trigger, **Then** they find and execute the correct files at their new locations
3. **Given** the reorganized repo, **When** the GitHub Pages workflow runs, **Then** the playground is deployed correctly
4. **Given** the reorganized repo, **When** the Docker build runs, **Then** the app image builds successfully with correct file paths

---

### User Story 3 - Documentation Reflects New Structure (Priority: P2)

CLAUDE.md, README.md, and any other documentation that references file paths or directory structure are updated to reflect the new organization.

**Why this priority**: Stale documentation after a reorg causes confusion, but the code working correctly is more critical.

**Independent Test**: Review CLAUDE.md and README.md for any file path references; all referenced paths exist in the new structure.

**Acceptance Scenarios**:

1. **Given** the reorganized repo, **When** a contributor reads CLAUDE.md, **Then** all file paths and directory descriptions match the actual structure
2. **Given** the reorganized repo, **When** a contributor reads README.md, **Then** any referenced paths point to correct locations

---

### Edge Cases

- What happens to files that don't clearly belong to one unit (e.g., root `package.json`, `system.yaml`, `IDEAS.md`)? They remain at the root if they serve the whole project, or move to the most relevant unit.
- What happens to the `tools/shelly-lint/` directory — does it move with Shelly scripts or stay separate as a standalone tool? It should move with Shelly scripts since it exclusively validates Shelly code.
- What about the flat `tests/` directory that contains tests for multiple units? Tests should either co-locate with their units or remain centralized with clear naming that maps to units.
- What happens to `.github/workflows/` CI files? They stay in `.github/workflows/` (GitHub requires this location) but are updated to reference new paths.
- What happens to the PoC Shelly script (`poc/shelly/`) — does it stay with the monitoring app or move to the Shelly scripts directory? It should stay with the monitoring app since it's specific to the PoC hardware setup.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Repository MUST have a clear top-level directory for each logical unit: Shelly control scripts, monitoring app, simulation playground, deployment infrastructure, and hardware design
- **FR-002**: All internal file references (imports, paths in scripts, CI workflows, Dockerfiles, HTML files, config files) MUST be updated to reflect new locations
- **FR-003**: The `system.yaml` file MUST remain accessible to all units that reference it (playground yaml-loader, design docs)
- **FR-004**: The Shelly linter tool MUST be co-located with the Shelly scripts it validates
- **FR-005**: Vendored dependencies MUST remain within their respective unit directories
- **FR-006**: File moves SHOULD preserve git history by using git move operations
- **FR-007**: All test files MUST be clearly associated with the unit they test, either by co-location or by naming convention
- **FR-008**: The GitHub Pages deployment MUST continue to serve the playground simulator
- **FR-009**: The Docker build context and Dockerfile paths MUST work with the new structure
- **FR-010**: Root-level project files (`package.json`, `.gitignore`, `.dockerignore`, `CLAUDE.md`, `README.md`) MUST remain at the repository root

### Identified Logical Units

- **Shelly Control Scripts**: Device scripts (`control.js`, `control-logic.js`), deployment script, device config, and the Shelly platform linter — everything needed to develop and deploy code to Shelly hardware
- **Simulation Playground**: Interactive browser-based thermal and hydraulic simulators (HTML, JS modules, CSS, vendored libs), deployed to GitHub Pages
- **Monitoring App**: Node.js server, web UI, auth modules, push notifications, service worker, PWA assets, Shelly sensor scripts, shared libraries (logger, S3 storage, VPN config, push storage, valve poller)
- **Deployment Infrastructure**: Terraform configs, Docker build files, deployer container (Dockerfile, deploy script, Caddyfile, compose, config.env), WireGuard VPN config
- **Hardware Design**: `system.yaml` (source of truth), design documentation, BOM, diagrams (SVG + Mermaid), construction instructions, existing hardware reference photos, idea specs

### Key Entities

- **Logical Unit**: A self-contained concern area in the repository with its own top-level directory, containing all related source code, configuration, and assets
- **Cross-Reference**: Any file path reference (import statement, script path, CI workflow path, Docker COPY instruction, HTML link) that must be updated when files move between directories

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new contributor can identify the correct directory for any file type by reading only the top-level directory listing — each unit's purpose is clear from its directory name
- **SC-002**: All existing tests pass after reorganization (full test suite exits successfully)
- **SC-003**: The number of top-level source/documentation directories is reduced from the current 10 (scripts, playground, poc, deploy, tools, docs, diagrams, construction, existing-hardware, tests) to 5-6 clearly named unit directories
- **SC-004**: Every file in the repository belongs to exactly one logical unit directory, or is a legitimate root-level project file
- **SC-005**: CLAUDE.md accurately describes the new structure with zero stale path references
- **SC-006**: All CI workflows (test, deploy, GitHub Pages, Shelly lint) execute successfully with updated paths

## Assumptions

- The reorganization is a one-time structural change, not an ongoing refactoring effort
- `system.yaml` placement (root vs. hardware design directory) will be determined during planning based on import complexity
- `.github/workflows/` stays at `.github/workflows/` as required by GitHub
- The `specs/` directory (speckit feature specs) stays at the root as a project-management concern
- Test organization approach (centralized vs. co-located) will be determined during planning
- The monitoring app name may change from "poc" to something more descriptive (e.g., "monitor" or "app") since it has grown beyond proof-of-concept stage
