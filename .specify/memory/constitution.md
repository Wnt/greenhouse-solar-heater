<!--
Sync Impact Report
==================
- Version change: 1.1.0 → 1.2.0 (new principle added)
- Added principles:
  - VI. Durable Data Persistence
- Modified principles:
  - VI. Durable Data Persistence: broadened from PoC-specific to
    project-wide scope (v1.2.0 → v1.2.1)
- Removed principles: none
- Added sections: none
- Removed sections: none
- Templates reviewed:
  - .specify/templates/plan-template.md — Constitution Check section
    references constitution generically ✅ (no updates needed)
  - .specify/templates/spec-template.md — no constitution refs ✅
  - .specify/templates/tasks-template.md — no constitution refs ✅
  - .specify/templates/checklist-template.md — no constitution refs ✅
  - .specify/templates/commands/*.md — no files exist ✅
- Follow-up TODOs: none
-->

# Greenhouse Constitution

## Core Principles

### I. Hardware Specification as Single Source of Truth

`system.yaml` is the authoritative specification for the **physical
system**: component dimensions, heights, valve states, operating modes,
sensor mappings, and Shelly relay assignments. All hardware
documentation, diagrams, and mode definitions derive from this file.
Changes MUST flow outward: update `system.yaml` first, then propagate
to `docs/design.md`, `diagrams/`, and any test scenarios that depend
on hardware parameters.

This principle applies exclusively to the physical/hardware domain.
Software architecture, code conventions, deployment configuration,
and application logic are NOT governed by `system.yaml`.

### II. Pure Logic / IO Separation

Control decisions MUST be implemented as pure functions with no side
effects and no platform API calls. The `evaluate(state, config)`
pattern separates testable decision logic from platform-specific I/O
(timers, HTTP RPC, relay control, sensor polling).

This enables the dual-runtime strategy: the same control logic runs
in Node.js for comprehensive testing and on Shelly hardware for
production. The shell wrapper (`control.js`) handles all I/O; the
pure core (`control-logic.js`) handles all decisions.

New control features MUST follow this separation. If a function
reads sensors, writes relays, or calls platform APIs, it belongs in
the I/O layer, not in the decision logic.

### III. Safe by Default, Explicit to Override (NON-NEGOTIABLE)

All actuation and control actions MUST have priority ordering and
safety checks built into the default code path. The normal path is
always the safe one.

When a situation requires deviating from the normal safe sequence
(e.g., closing a valve before stopping the pump during freeze
protection to prevent gravity backflow into freeze-exposed pipes),
the code and API MUST make the override explicit and visible. No
silent unsafe behavior is permitted.

This means:
- Default function signatures and control flow follow the safe path
- Overrides require explicit parameters or distinct function calls
  that document the reason for deviation
- Safety-critical sequences (pump/valve ordering, drain timeouts,
  sensor staleness detection) are encoded in the pure logic and
  verified by unit tests
- Adding a new override MUST include a test that verifies both the
  override behavior and the default safe behavior

### IV. Proportional Test Coverage

Every significant change MUST be reflected in all applicable test
levels:
- **Unit tests**: Pure control logic assertions (`node:test`)
- **Simulation tests**: Scenario-driven thermal/control model
  validation
- **E2E tests**: Playwright browser tests for playground and PoC UI

Tests MUST pass locally before pushing to CI to maintain a short
feedback loop. The goal is not 100% coverage but proportional
coverage: if a change affects behavior, the tests that cover that
behavior MUST be updated. A change that modifies control logic
without updating the corresponding unit and simulation tests is
incomplete.

### V. Token-Based Cloud Authentication

All authentication towards UpCloud MUST use token-based auth via
the `UPCLOUD_TOKEN` environment variable. Username/password
authentication (`UPCLOUD_USERNAME`/`UPCLOUD_PASSWORD`) MUST NOT
be used in any configuration, documentation, CI/CD pipeline, or
code.

This applies to:
- Terraform provider configuration
- CI/CD workflows and GitHub Actions secrets
- CLI tools (`upctl`)
- Any scripts or documentation that reference UpCloud API access

API tokens are more secure than username/password credentials:
they can be scoped, rotated independently, and work with
two-factor authentication enabled on the account. New code or
documentation referencing UpCloud authentication MUST use
`UPCLOUD_TOKEN` exclusively.

### VI. Durable Data Persistence

All application data MUST survive server restarts and container
recreation. No data may be stored solely in container-local
filesystems, in-memory stores, or Docker volumes that are
destroyed on redeployment.

Data MUST be persisted to an external durable store such as:
- **Object storage** (UpCloud Managed Object Storage / S3-compatible)
- **External database** (if introduced in the future)

This applies to all services and infrastructure created in this
project, including but not limited to:
- Authentication credentials (passkeys, sessions)
- Sensor readings and time-series data
- Configuration and user preferences
- Any operational state an application accumulates over time

The rationale: the deployment architecture uses a stateless
deployer that recreates containers via `docker compose up -d`.
Any data written only to the container filesystem is lost on
every deploy cycle. Treating containers as ephemeral and storing
all state externally is mandatory for operational reliability.

New features that produce or consume persistent data MUST use
an external persistence mechanism (e.g., the S3 storage adapter
in `poc/lib/s3-storage.js`). Local filesystem fallback is
acceptable only for development/testing — production deployments
MUST use external storage.

## Platform Constraints

- **Shelly device scripts**: ES5-only JavaScript. No `const`/`let`,
  arrow functions, destructuring, template literals, classes, or
  `async`/`await`. The AST-based linter (`tools/shelly-lint/`)
  enforces this in CI automatically.
- **Shelly resource limits**: 16KB max script size, 5 timers,
  5 event subscriptions, 5 concurrent HTTP calls per script.
- **Browser code**: ES6+ modules with `<script type="importmap">`.
  All dependencies vendored in `playground/vendor/` — no CDN URLs.
- **Deployment**: Scripts deployed to Shelly devices via HTTP RPC.
  Device IPs managed in `scripts/devices.conf`.

## Development Workflow

- Run applicable tests locally (`npm run test:unit` at minimum)
  before pushing. CI runs the full suite on every push.
- CI triggers on `push` only (not `pull_request`) so tests run
  exactly once per push.
- The Shelly linter runs in CI as an automated gate for device code
  changes.
- `CLAUDE.md` MUST be kept up to date when changes affect project
  structure, conventions, or workflows.
- GitHub Pages deploys the playground automatically on push to main.

## Governance

This constitution defines the non-negotiable principles for the
greenhouse project. All feature specs, implementation plans, and
code reviews MUST verify compliance with these principles.

- **Amendments**: Changes to this constitution require explicit
  discussion and rationale. Version number MUST be incremented
  (MAJOR for principle removals/redefinitions, MINOR for additions,
  PATCH for clarifications).
- **Compliance**: Principle III (Safe by Default) is non-negotiable
  and cannot be waived. Principles I, II, and IV may have justified
  exceptions documented in the relevant spec or plan.
- **Runtime guidance**: `CLAUDE.md` provides operational development
  guidance and MUST remain consistent with this constitution.

**Version**: 1.2.1 | **Ratified**: 2025-07-20 | **Last Amended**: 2026-03-21
