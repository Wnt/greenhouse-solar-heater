# Implementation Plan: Remove V_ret Valve from Collector Top

**Branch**: `024-remove-vret-valve` | **Date**: 2026-04-10 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/024-remove-vret-valve/spec.md`

## Summary

Correct `system.yaml` (source of truth) and every downstream artifact so the collector top has exactly one motorized valve (`V_air`) plus a passive T joint to the reservoir, instead of two motorized valves (`V_ret` + `V_air`). The change is mechanical: drop `v_ret` from every valve-name enumeration, remove one relay from the Shelly Pro 2PM `unit_4`, reshape one topology pipe, update six hand-authored SVGs, the inline playground schematic template, the Mermaid control-states diagram, the prose docs (`design/docs/design.md`, `bom.md`, `commissioning-guide.md`, `CLAUDE.md`), and every unit/integration/e2e test that enumerates the full valve set. Operational behaviour must not change — the scheduler added by 023-limit-valve-operations keeps its 2-slot PSU budget and 60 s min-open hold; per-mode flow is functionally identical because the permanent T-joint connection to the reservoir carries the same water path that `V_ret: OPEN` used to carry.

Technical approach (from Phase 0 research):

- **Device-config persistence is valve-agnostic**, so no migration is required — the persisted `device-config.json` (S3 / local / Shelly KVS) uses compact keys (`ce`, `ea`, `fm`, `am`, `v`) with no valve enumeration.
- **Topology layout** treats the collector top as an implicit Y: two pipes already originate at `{component: collectors, port: top}` (one to `v_ret`, one to `v_air`). Removing `v_ret` means removing the valve entry, removing one pipe, and re-pointing the former `pipe_vret_reservoir` directly from the collectors' `top` port to the reservoir at a new `left_submerged` port (below water line). The drift-check test (`tests/topology-diagram.test.js`) will catch any mistake.
- **Playground schematic** is inlined as a JS template string inside `buildSchematic()` at `playground/js/main.js:1675-1738`. The `V-ret → reservoir` label + path (lines ≈1714-1715) is removed; the `V-air (open)` path stays. A new path draws the permanent T-joint-to-reservoir connection.
- **Test rewrite scope** is contained: 19 `v_ret` occurrences in `tests/control-logic.test.js` (added by 023-limit-valve-operations), 2 in `tests/playground-control.test.js`, 1 in `tests/data-source.test.js`, plus grep hits in device-config / live-mode / live-display / live-logs / thermal-model / staged-valves e2e specs. Every one reduces to a mechanical list edit — no behavioural assertions change.
- **Shelly linter SH-014** (`Array.sort()` / `findLastIndex()` ban) must continue to pass; the change is data-only, so no lint risk.
- **Screenshot regeneration** is the final step (`npm run screenshots`), so the `playground/screenshots/` directory reflects the 7-valve layout.

## Technical Context

**Language/Version**: JavaScript ES5 (Shelly device scripts, constrained by Espruino runtime — no `const`/`let`, no arrow functions, no `Array.sort`/`.shift`/`.findLast`, enforced by `shelly/lint/`), ES6+ browser modules (playground), Node.js 20 LTS (server + tests, CommonJS), POSIX shell (deploy scripts), YAML (`system.yaml`, `topology-layout.yaml`), Mermaid (`control-states.mmd`), SVG (hand-authored).
**Primary Dependencies**: `mqtt`, `ws`, `pg`, `@aws-sdk/client-s3`, `@simplewebauthn/server` (all existing, unchanged); `acorn` + `js-yaml` (linter + topology generator); `node:test` (unit tests); Playwright 1.56.0 + `npx serve` (e2e tests). No new dependencies.
**Storage**: `system.yaml` + `topology-layout.yaml` (authored files, checked into git); `design/diagrams/system-topology.drawio` (generated, drift-checked); Shelly KVS (device-config JSON with compact keys, valve-agnostic — no migration); PostgreSQL/TimescaleDB (sensor history, valve-agnostic rows); S3 `device-config.json` (valve-agnostic). No schema changes.
**Testing**: `node:test` unit + simulation (`npm run test:unit`), Playwright e2e (`npm run test:e2e`), `npm test` for the full suite. `tests/topology-diagram.test.js` provides drift detection between `system.yaml`/`topology-layout.yaml` and the committed `.drawio` file. `tests/control-logic.test.js` runs the 1000-iteration scheduler invariant fuzz that must still pass after the 8→7 rename.
**Target Platform**: Shelly Pro 4PM (Espruino ES5 runtime, 16 KB script limit, 5 timers / 5 HTTP concurrent) — device code; modern browsers — playground SPA; Node.js 20 on UpCloud Managed Kubernetes — server.
**Project Type**: Multi-component monorepo — embedded firmware (`shelly/`) + browser SPA (`playground/`) + Node.js monitoring/bridging server (`server/`) + authoring artifacts (`system.yaml`, `design/`). No new projects.
**Performance Goals**: Scheduler behaviour is held constant — max 2 concurrent opens, 60 s min-open hold, 20 s opening window, 4 concurrent HTTP calls. Spec's SC-009 asserts the invariant fuzz and staged-valve snapshot fields are unchanged after the rename. No performance regression budget beyond "existing tests still pass".
**Constraints**: Shelly script size ≤16 KB combined (control.js + control-logic.js is currently ~19 KB per commit `6c4aac2`'s Closing Notes — the removal should shrink it slightly); Espruino lacks `Array.sort`/`.shift`/`.findLast`/`.findLastIndex` (SH-014 lint rule); reservoir entry pipe MUST terminate below water line (siphon physics, hard constraint per A2); scheduler determinism invariant INV8 requires `VALVE_NAMES_SORTED` to stay alphabetically sorted and in sync with `MODE_VALVES`.
**Scale/Scope**: ~46 files reference `v_ret` today. Excluding historical spec directories (`specs/010-…` through `specs/023-…`, `design/docs/superpowers/specs/**`) and this spec's own files, the edit surface is roughly: 1 YAML (`system.yaml`), 1 topology layout (`topology-layout.yaml`), 1 generated drawio (regenerated), 6 hand-authored SVGs, 1 Mermaid diagram, 2 Shelly scripts (`control.js`, `control-logic.js`), 1 devices.conf, 1 inline playground schematic (`main.js`), 1 HTML relay button (`index.html`), 4 server-side modules (checked, most are valve-agnostic), ~9 test files, 4 prose docs (`design.md`, `bom.md`, `commissioning-guide.md`, `CLAUDE.md`), and a final screenshot regeneration pass.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Evaluated against `.specify/memory/constitution.md` v1.3.0.

- **I. Hardware Specification as Single Source of Truth** — ✅ **Directly honoured.** This feature is the archetypal `system.yaml`-first change: the user explicitly described the correction as "a mistake in `system.yaml`". The plan edits `system.yaml` first, then propagates outward in the exact order the principle prescribes (docs → diagrams → derived test scenarios → generated drawio via the drift-check test).
- **II. Pure Logic / IO Separation** — ✅ **Preserved.** Edits to `shelly/control-logic.js` are data-only (the `VALVE_NAMES_SORTED` constant, `MODE_VALVES` mode table, `buildSnapshotFromState` snapshot shape) — no new I/O introduced. Edits to `shelly/control.js` are also data-only (`RELAY_MAP` entry, valve-name arrays inside `closeAllValves`, `seedValveOpenSinceOnBoot`, `currentSchedulerView`, default `state.valve_states`). The pure/IO boundary is untouched.
- **III. Safe by Default, Explicit to Override** — ✅ **Preserved.** No change to mode-transition ordering, no change to pump-before-valve safety rule, no change to `active_drain` / `overheat_drain` sequences, no change to `V_air`'s normally-open fail-safe polarity. The `stopDrain` → `transitionTo` SCHEDULE-loop path stays the same. SC-008 in the spec explicitly verifies the power-loss fail-safe is unchanged. The scheduler determinism invariants (INV1–INV8) from 023-limit-valve-operations stay green because the 1000-iteration fuzz runs against the updated 7-valve set as a regression check (SC-009).
- **IV. Proportional Test Coverage** — ✅ **Honoured.** The spec's FR-011 enumerates every test file that references `v_ret` (unit, simulation, integration, e2e) and FR-020 requires the full `npm test` suite to pass. Drift-check test (`tests/topology-diagram.test.js`) covers the generated drawio. The screenshot regeneration is a final step to keep visual assets current. No tests are skipped.
- **V. Token-Based Cloud Authentication** — N/A. Not touching UpCloud auth.
- **VI. Durable Data Persistence** — ✅ **N/A by construction.** Phase 0 research confirmed the persisted `device-config.json` (S3 / local / Shelly KVS) uses compact keys (`ce`, `ea`, `fm`, `am`, `v`) and does NOT enumerate valve names, so removing `v_ret` from code does not create a stale persisted field. The history DB (`server/lib/db.js`) stores sensor readings and state events, not per-valve flags — also unaffected.
- **VII. No Secrets in Cloud-Init** — N/A. Not touching infrastructure.

**Gate result**: PASS. No violations, no complexity tracking required.

## Project Structure

### Documentation (this feature)

```text
specs/024-remove-vret-valve/
├── plan.md              # This file
├── research.md          # Phase 0 output (device-config, topology, playground schematic, linter, screenshots)
├── data-model.md        # Phase 1 output (entities: collector-top junction, V_air, reservoir pipe; no new persistent data)
├── quickstart.md        # Phase 1 output (step-by-step verification workflow)
├── contracts/
│   ├── mqtt-snapshot.md # Wire-format change: greenhouse/state no longer carries v_ret
│   └── websocket-state.md # Bridge broadcast format mirrors the snapshot change
├── checklists/
│   └── requirements.md  # Spec quality checklist (already green)
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created by /speckit.plan)
```

### Source Code (repository root)

No new files. Edit surface only:

```text
system.yaml                                    # Source of truth — edited first
design/diagrams/topology-layout.yaml           # Valves + pipes + labels; regenerate drawio via `npm run diagram`
design/diagrams/system-topology.drawio         # Generated (regenerated, drift-checked by tests/topology-diagram.test.js)
design/diagrams/system-topology.svg            # Hand-authored, manual edit
design/diagrams/system-height-layout.svg       # Hand-authored, manual edit
design/diagrams/solar-charging-flow.svg        # Hand-authored, manual edit
design/diagrams/active-drain-flow.svg          # Hand-authored, manual edit
design/diagrams/idle-state.svg                 # Hand-authored, manual edit
design/diagrams/control-states.mmd             # Mermaid, manual edit
design/docs/design.md                          # Prose — valve count, per-mode tables, architecture summary
design/docs/bom.md                             # Prose — valve qty 8→7, subtotal/total -65€
design/docs/commissioning-guide.md             # Prose — install steps mention one valve at top
CLAUDE.md                                      # Key Architecture Concepts section + scheduler description (lines 73-74)

shelly/control-logic.js                        # VALVE_NAMES_SORTED, MODE_VALVES, buildSnapshotFromState (data-only)
shelly/control.js                              # RELAY_MAP, closeAllValves, seedValveOpenSinceOnBoot, currentSchedulerView, default state (data-only)
shelly/devices.conf                            # Remove v_ret relay comment/mapping

playground/js/main.js                          # Inline schematic template (1675-1738), valveNames array (1345), valveNameLabels map (1341), fallback modes object (657-663)
playground/index.html                          # Remove data-relay="v_ret" button (line 493)

server/lib/mqtt-bridge.js                      # Verify no hard-coded v_ret iteration (expected: valve-agnostic)
server/lib/device-config.js                    # Verify no hard-coded v_ret (expected: compact keys, unaffected)
server/lib/sensor-config.js                    # Verify no hard-coded v_ret
server/server.js                               # Verify no hard-coded v_ret

tests/control-logic.test.js                    # 19 occurrences from 023 scheduler tests (mechanical 8→7 edits)
tests/playground-control.test.js               # 2 occurrences
tests/data-source.test.js                      # 1 occurrence
tests/device-config-integration.test.js        # Valve-state scenarios
tests/simulation/thermal-model.test.js         # Valve set in simulated modes
tests/e2e/device-config.spec.js                # UI config → valve state mapping
tests/e2e/live-mode.spec.js                    # Mocked WS state payloads
tests/e2e/live-display.spec.js                 # Schematic assertions
tests/e2e/live-logs.spec.js                    # State-event feed assertions
tests/e2e/staged-valves.spec.js                # No direct v_ret reference, but depends on snapshot shape — verify pass

playground/screenshots/*                       # Regenerated via `npm run screenshots` at the end
```

**Structure Decision**: The repo's existing multi-component layout (`system.yaml` at root, `shelly/`, `playground/`, `server/`, `design/`, `tests/`) is unchanged. No new directories, no new modules, no new dependencies. This feature is a mechanical data correction across the existing edit surface.

## Phase 0: Outline & Research

See [`research.md`](research.md). Five research items were explored:

1. Device-config persistence — valve-agnostic, no migration needed.
2. Topology layout representation of the T joint — implicit Y via shared source port.
3. Playground schematic location — inline JS template literal in `main.js`, not an SVG file.
4. Shelly linter SH-014 — data-only edit, no risk.
5. Screenshot regeneration — `npm run screenshots` as final step, non-blocking.

Each item resolved before Phase 1. Zero [NEEDS CLARIFICATION] markers remain.

## Phase 1: Design & Contracts

See [`data-model.md`](data-model.md), [`contracts/`](contracts/), and [`quickstart.md`](quickstart.md).

- **data-model.md** — describes the collector-top junction as the only entity affected. One entity removed (`V_ret` motorized valve with its relay mapping). One entity reshaped (the collector-top junction — now a T joint with one motorized branch `V_air` and one passive branch to the reservoir). One constraint strengthened (`reservoir.connections.top_mid_inlet_2` must enter below water line). No new persistent data.
- **contracts/mqtt-snapshot.md** — documents the wire-format change to the `greenhouse/state` MQTT topic: the `valve_states` object shrinks from 8 keys to 7. Lists every consumer and confirms each one iterates keys generically.
- **contracts/websocket-state.md** — documents the mirrored WebSocket broadcast shape for the playground's live data source.
- **quickstart.md** — end-to-end verification workflow: regenerate drawio, run tests, visually inspect playground, regenerate screenshots, grep-check.

**Agent context update**: After design docs land, run `.specify/scripts/bash/update-agent-context.sh claude` to update `CLAUDE.md`'s "Active Technologies" and "Recent Changes" sections for this feature. The manual sections of `CLAUDE.md` (Key Architecture Concepts, File Relationships, etc.) will be updated as part of the feature implementation, not by the script.

## Re-evaluated Constitution Check (post-design)

All design artifacts reviewed against the constitution. No new violations introduced:

- Principle I (`system.yaml` first) — design artifacts reinforce this ordering; data-model.md names `system.yaml` as the first edit.
- Principle II (pure logic / IO separation) — contracts/mqtt-snapshot.md documents that only the snapshot's *shape* changes, not the boundary.
- Principle III (safe by default) — quickstart.md includes an explicit power-loss fail-safe walkthrough step.
- Principle IV (proportional test coverage) — quickstart.md runs `npm test` before and after, includes the topology drift test and the scheduler invariant fuzz as explicit gates.
- Principles V, VI, VII — N/A, confirmed during Phase 0.

**Post-design gate result**: PASS. Ready for `/speckit.tasks`.

## Complexity Tracking

None. No constitution violations to justify.
