# Feature Specification: Remove V_ret Valve from Collector Top

**Feature Branch**: `024-remove-vret-valve`
**Created**: 2026-04-10
**Status**: Draft
**Input**: User description: "there is a mistake in system.yaml: There are two valves at the top of the collector, when there should only be one valve: V_air. remove the V_ret valve from there and update all implementation accordingly. There should be just a T joint there where we can either let air in by the V_air valve when we are draining the panels and in all other operating modes it should just connect to the reservoir air separator (below the water line)."

## Overview

The authoritative system specification (`system.yaml`) currently describes **two** motorized valves at the top of the solar collector array: `V_ret` (return path to reservoir) and `V_air` (air intake for drain). The physical hardware design that the user actually intends to build has only **one** motorized valve there — `V_air` — and a passive **T joint** instead of `V_ret`. The T joint permanently connects the collector-top pipe to the reservoir (with the reservoir-side pipe entering the reservoir **below** the water line so the siphon cannot ingest air), and branches to `V_air` which opens only during drain modes to admit atmospheric air into the collector loop.

This specification captures the correction to `system.yaml` and every downstream artifact that currently references `V_ret`.

**Relationship to 023-limit-valve-operations**: Feature 023 (merged to main before this spec was written) introduced a staged-opening scheduler with pure helpers `planValveTransition`, `VALVE_TIMING`, `toSchedulerView`/`fromSchedulerView`, `buildSnapshotFromState`, and `runBoundedPool` in `shelly/control-logic.js`, a SCHEDULE-loop state machine (`transitionTo` / `scheduleStep` / `resumeTransition`) plus per-valve book-keeping in `shelly/control.js` (`RELAY_MAP`, `closeAllValves`, `seedValveOpenSinceOnBoot`, `currentSchedulerView`), new staged-valve UI surfaced via three snapshot fields (`opening`, `queued_opens`, `pending_closes`) in `playground/js/main.js`, `playground/index.html`, `playground/css/style.css`, `playground/js/data-source.js`, and ~738 lines of new unit tests in `tests/control-logic.test.js` plus `tests/e2e/staged-valves.spec.js`. A subsequent fix (commit `4240904`, "Fix Shelly crash: replace Array.sort() with pre-sorted iteration") added the compile-time constant `VALVE_NAMES_SORTED` near the top of `shelly/control-logic.js` (currently `["v_air", "v_ret", "vi_btm", "vi_coll", "vi_top", "vo_coll", "vo_rad", "vo_tank"]`) because the Shelly Espruino runtime lacks `Array.prototype.sort()`. Every valve-name list inside that new code — including `VALVE_NAMES_SORTED` — enumerates all motorized valves and therefore still contains `v_ret`. This feature must drop `v_ret` from every such enumeration (a mechanical 8 → 7 rename in each list) **without changing the scheduler's semantics** — the PSU slot budget (max 2 concurrent opens), the 60 s minimum-open hold, the transition timer, the bounded HTTP pool, and the staged-valve snapshot fields all remain exactly as 023 defined them. The `VALVE_NAMES_SORTED` constant MUST remain alphabetically sorted (so `planValveTransition`'s determinism invariant INV8 still holds) and MUST remain in sync with the `MODE_VALVES` keys.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Source of truth and control logic reflect the real hardware (Priority: P1)

As the system designer building the greenhouse heating system, I need `system.yaml` plus the runtime control logic (Shelly scripts, playground simulator, device-config pipeline, tests) to describe the physical system that will actually be installed — seven motorized valves with only `V_air` at the collector top, a passive T-joint return path to the reservoir — so I can commission the hardware without the software fighting the topology.

**Why this priority**: The Shelly controller, the playground simulator, the integration tests and the device-config/relay mapping all drive (or simulate driving) a non-existent relay today. Until this is corrected, solar charging cannot be safely enabled in either live or simulated mode, and anything else built on the current model (reports, screenshots, schematics) reinforces a design that will never be built.

**Independent Test**: Load `system.yaml`, walk through every operating mode, and confirm that no mode references `V_ret`, that the total motorized valve count is 7, and that the Shelly control logic (`shelly/control-logic.js`), the playground control wrapper, and the integration tests compute identical valve states for each mode without referring to `V_ret`. Existing unit tests must pass unchanged in behavior (they will be updated to assert the new valve set).

**Acceptance Scenarios**:

1. **Given** the updated `system.yaml`, **When** it is parsed by the diagram generator and the Shelly linter harness, **Then** the document validates and the total motorized valve count equals 7.
2. **Given** solar charging mode, **When** the control logic evaluates valve states, **Then** the output set contains exactly `{VI-btm: OPEN, VO-coll: OPEN}` plus all other motorized valves CLOSED — with `V_ret` no longer present in either the input key set or the expected output.
3. **Given** active drain mode, **When** the control logic evaluates valve states, **Then** `V_air` is OPEN, `VI-coll` is OPEN, `VO-tank` is OPEN, all other motorized valves are CLOSED, and `V_ret` is not part of the state at all.
4. **Given** the existing control-logic unit tests and playground control tests, **When** they are re-run against the corrected logic and expected state, **Then** they pass with assertions that cover the 7-valve topology.
5. **Given** the device-config integration tests (relay mapping, manual-override path, MQTT relay-command flow), **When** they are re-run, **Then** every assertion that previously referenced `v_ret` now references only the remaining seven motorized valves and all tests pass.
6. **Given** the Shelly deploy configuration (`shelly/control.js` relay map, `shelly_components` section of `system.yaml`), **When** inspected, **Then** the Shelly Pro 2PM unit at the collector top drives only `V_air`; the former `V_ret` relay slot is either removed or explicitly marked unused.

---

### User Story 2 - Diagrams and the 2D schematic accurately depict the T-joint topology (Priority: P2)

As anyone reviewing the design (builder, future maintainer, code reviewer, me in six months), I need every diagram — the generated drawio topology, the hand-authored SVGs, the playground schematic view, and the control-state Mermaid diagrams — to show the collector top as a single motorized valve `V_air` plus a passive T connection to the reservoir, so the visual design matches reality.

**Why this priority**: Diagrams drive understanding. Even if the YAML and code are correct, a diagram showing `V_ret` will confuse every future reader and will re-introduce the bug the next time a diagram-driven refactor happens. But the diagrams can be updated after the source-of-truth + logic layer is corrected, so this is P2 rather than P1.

**Independent Test**: Regenerate `system-topology.drawio` via `npm run diagram`, open every SVG in `design/diagrams/`, and confirm each shows only a T joint and `V_air` at the collector top. The drift-check test (`tests/topology-diagram.test.js`) must pass — meaning the committed drawio matches what the generator produces from the corrected `system.yaml` + `topology-layout.yaml`. The playground schematic view (SVG inside `playground/index.html`) must show the same thing and the live-display e2e tests must still render without errors.

**Acceptance Scenarios**:

1. **Given** the updated `topology-layout.yaml`, **When** `node design/diagrams/generate-topology.js` is run, **Then** the emitted drawio file matches the committed `system-topology.drawio` byte-for-byte and `tests/topology-diagram.test.js` passes.
2. **Given** the updated hand-authored SVGs (`system-topology.svg`, `system-height-layout.svg`, `solar-charging-flow.svg`, `active-drain-flow.svg`, `idle-state.svg`), **When** opened in a browser, **Then** each shows exactly one motorized valve (`V_air`) at the collector top plus a T joint to the reservoir pipe — and no `V_ret` element anywhere.
3. **Given** the playground SPA schematic view, **When** loaded in Chromium during `npm run test:e2e`, **Then** the schematic renders without console errors, does not contain a `V_ret` label or element, and the `live-display.spec.js`/`live-logs.spec.js` suites pass against both simulated and mocked-live data sources.
4. **Given** the Mermaid control-state diagrams (`design/diagrams/control-states.mmd`), **When** rendered on GitHub, **Then** any transition labels that previously mentioned `V_ret` reference only the remaining valves.

---

### User Story 3 - Prose documentation, BOM, CLAUDE.md and commissioning guide reflect the correction (Priority: P3)

As a reader of the design docs (myself, AI agents loading CLAUDE.md for future sessions, anyone ordering hardware or following the commissioning steps), I need the prose documents to describe seven motorized valves and the T joint, so the narrative matches the YAML and diagrams.

**Why this priority**: Docs are important but downstream of the source of truth and diagrams. Once the YAML, the code, and the visuals are correct, the narrative can be updated in a single pass without blocking the system from being built.

**Independent Test**: Grep every document in `design/docs/`, every spec under `specs/`, and `CLAUDE.md` for any mention of `V_ret`, `v_ret`, `vret`, `VRET`, or `V-ret` (case-insensitive). The only acceptable matches are either historical notes explicitly marked as pre-correction context (e.g., superseded earlier specs under `specs/01x-*` or `design/docs/superpowers/specs/`) or text that deliberately documents the removal.

**Acceptance Scenarios**:

1. **Given** the updated `design/docs/design.md` and `design/docs/bom.md`, **When** they are read, **Then** the motorized valve count, the per-mode valve states, and the bill-of-materials total all reflect 7 motorized valves (down from 8), and the removed valve's cost (~65€) is subtracted from the control-system subtotal and the total estimate.
2. **Given** the updated `design/docs/commissioning-guide.md`, **When** read end to end, **Then** the installation steps describe a single valve at the collector top plus the T joint, and the commissioning checklist never asks the installer to wire, test, or label `V_ret`.
3. **Given** the updated `CLAUDE.md`, **When** reloaded at the start of a new Claude Code session, **Then** the architecture concepts section describes seven motorized valves and explicitly mentions the T joint + `V_air` topology at the collector top.
4. **Given** the updated `IDEAS.md` or other wishlist docs, **When** read, **Then** they are not contradicted by the new topology (or contradictions are resolved).

---

### Edge Cases

- **Passive siphon sanity during solar charging**: With `V_ret` gone, the collector-top-to-reservoir pipe is a permanently open siphon. The reservoir-side end must terminate **below** the reservoir water line so that air cannot be drawn into the loop when the pump creates sub-atmospheric pressure at the collector top (the existing 80 cm head difference still applies). The spec must make this constraint explicit and the reservoir `top_mid_inlet_2` connection description must state "pipe enters below water line" so it cannot be accidentally re-plumbed above the water line.
- **Drain behaviour without V_ret to block the return**: During active drain, when `V_air` opens and the pump draws from `VI-coll`, the previously closed `V_ret` no longer blocks the reservoir side. As soon as `V_air` admits air, the siphon from the T joint down to the reservoir is broken and the small volume in that down-leg drains by gravity into the reservoir. The spec must note that this is the expected behaviour, that the volume is small (pipe only, not collectors), and that the reservoir is sized to absorb it.
- **Power-loss fail-safe claim**: The current `system.yaml` describes `V_air` as normally-open so power loss "enables gravity-assisted collector drain". With the T joint in place, power loss still opens `V_air` and breaks the siphon to the reservoir, but the collectors themselves do not gravity-drain because `VI-coll` is auto-close and the collector body sits above the drainable path. The spec must either (a) restate the fail-safe more accurately (power loss drains the collector-top return pipe; collectors drain only when the pump actively runs), or (b) explicitly document that the fail-safe claim is unchanged because the drain path was already pump-driven.
- **Shelly Pro 2PM unit_4 utilization**: The collector-top Shelly currently drives two relays (`V_ret` + `V_air`). After removal, only one relay is in use. The spec must decide whether to (a) keep the Pro 2PM with one unused relay reserved as a spare, (b) swap to a cheaper single-relay Shelly (e.g. Shelly 1 Gen3) at the collector top, or (c) note the decision as deferred. See FR-012.
- **Existing screenshots in the repo**: The `playground/screenshots/` directory (produced by `npm run screenshots`) contains captured images of the old schematic with `V_ret` visible. The spec must require regenerating screenshots as part of completion so documentation imagery is consistent.
- **Historical spec directories**: Earlier specs under `specs/010-…`, `specs/017-…`, `specs/019-…`, `specs/022-…` and the superpowers design notes reference `V_ret` as historical context. Those should be left as-is (they document the state at the time they were written), but the grep check in US3 must tolerate them.
- **Strict YAML parsing**: `system.yaml` parses strictly in js-yaml 4.x except the `shopping_list.electronics` section. Removing the `v_ret` sub-tree must not introduce any new parser fragility, and the generator's validation output must not produce new warnings.
- **Scheduler regression risk**: The staged-opening scheduler added by 023-limit-valve-operations was designed around a PSU slot budget of 2 concurrent opens. Removing one valve reduces the worst-case slot demand (fewer valves can ever need to open at once) but does NOT change the slot budget itself. The change must not accidentally adjust `VALVE_TIMING.maxConcurrentOpens` or the 60 s hold, and the 1000-iteration invariant fuzz test in `tests/control-logic.test.js` must still pass against the 7-valve set.
- **Snapshot wire format**: `buildSnapshotFromState` in `shelly/control-logic.js` builds the telemetry snapshot that is published on `greenhouse/state` and fed into the MQTT bridge, WebSocket, and the playground's staged-valve UI. Removing `v_ret` from the snapshot builder is a wire-format change — every consumer (`server/lib/mqtt-bridge.js`, `playground/js/data-source.js`, the history DB schema if it keys on `valve_states.v_ret`) must be checked for implicit assumptions that the key is present. The preferred resolution is that every consumer already iterates keys generically and does not hard-code `v_ret`; the spec's FR-010 covers the server-side check and FR-009 covers the client-side check.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `system.yaml` MUST remove the `valves.collector_top.v_ret` entry entirely.
- **FR-002**: `system.yaml` MUST describe `valves.collector_top` as containing exactly one motorized valve (`v_air`) plus a passive T joint that permanently connects the collector-top pipe to the reservoir.
- **FR-003**: `system.yaml` MUST update `valves.total_motorized` from 8 to 7 (and from "9 when wood burner added" to "8 when wood burner added").
- **FR-004**: `system.yaml` MUST remove `v_ret` from the `valve_states` of every operating mode (`idle`, `solar_charging`, `greenhouse_heating`, `active_drain`, `overheat_drain`, `emergency_heating`, plus any others).
- **FR-005**: `system.yaml` MUST update the `reservoir.connections.top_mid_inlet_2` description to state that the pipe comes from the collector-top T joint (not from the removed `V_ret` valve) and that it enters the reservoir below the water line so the siphon cannot ingest air.
- **FR-006**: `system.yaml` MUST update the `solar_charging.flow_path.return` narrative to read "collector top → T joint → reservoir (below water line) → dip tube pipe down to 0 cm → up through internal dip tube → exits at ~185 cm inside tank" (removing the `V_ret` reference).
- **FR-007**: `system.yaml` MUST update `control.shelly_components.shelly_pro_2pm.units.unit_4` so that it no longer maps a relay to `v_ret`. The spec MUST resolve this per FR-012 below.
- **FR-008**: `shelly/control-logic.js`, `shelly/control.js`, `shelly/devices.conf`, and any Shelly deploy scripts MUST remove references to the `v_ret` relay, stop reading/writing its state, and stop including it in published state snapshots over MQTT. Specifically:
  - `shelly/control-logic.js`: the `VALVE_NAMES_SORTED` compile-time constant (added by commit `4240904` to replace Espruino's missing `Array.sort()`) MUST drop `"v_ret"` while staying alphabetically sorted and in sync with `MODE_VALVES`; the `valve_states` for every mode in the module-level mode table (IDLE, SOLAR_CHARGING, GREENHOUSE_HEATING, ACTIVE_DRAIN, EMERGENCY_HEATING — roughly lines 15-40) MUST drop the `v_ret` key; `buildSnapshotFromState` MUST stop copying `v_ret` into its returned `valve_states`; `toSchedulerView` / `fromSchedulerView` already only special-case `v_air`, so they need no edit beyond confirming no new `v_ret` branch creeps in; `VALVE_TIMING` and `planValveTransition` are valve-name-agnostic and require no change beyond being exercised against the 7-valve set.
  - `shelly/control.js`: the `RELAY_MAP` (IP + channel for every motorized valve) MUST drop the `v_ret: {ip: …, id: 0}` entry; the valve-name arrays inside `closeAllValves`, `seedValveOpenSinceOnBoot`, and `currentSchedulerView` MUST drop `v_ret`; the default `state.valve_states` object (the one that seeds the initial in-memory snapshot) MUST drop `v_ret`; nothing inside the SCHEDULE-loop state machine (`transitionTo` / `scheduleStep` / `resumeTransition`) or the transition timer requires behavioural change.
  - `shelly/lint/rules/`: the SH-014 rule (added in commit `4240904` to flag `Array.sort()`/`Array.findLastIndex()` calls) MUST continue to pass on the edited `control-logic.js` — the whole point of removing `v_ret` is a data edit, not a code edit that reintroduces `sort()`.
- **FR-009**: `playground/js/control.js` and every other playground module that mirrors valve state — at minimum `playground/js/main.js` (the fallback modes object around lines 657-663, the `valveNameLabels` map, and the `valveNames` array around lines 1341-1345), `playground/js/data-source.js`, and `playground/index.html` (the relay-control button with `data-relay="v_ret"` around line 493 plus any schematic SVG element for `v_ret`) — MUST no longer reference `V_ret`. The playground schematic view and the staged-valve UI (`opening` / `queued_opens` / `pending_closes` list rendering) MUST visually depict a T joint at the collector top with only `V_air` as the motorized valve and MUST never render `v_ret` in any staged-valve row, relay button, or valve grid.
- **FR-010**: `server/lib/mqtt-bridge.js`, `server/lib/device-config.js`, `server/lib/sensor-config.js`, and `server/server.js` MUST no longer include `v_ret` in any relay map, device-config default, MQTT topic handler, or WebSocket state broadcast.
- **FR-011**: All unit, integration, and e2e tests that reference `v_ret` (at minimum: `tests/control-logic.test.js` (19 current occurrences across scheduler, slot-budget, cross-tick queue, min-open hold, safety-drain, snapshot-builder, and polarity-helper suites added by 023-limit-valve-operations), `tests/playground-control.test.js`, `tests/device-config-integration.test.js`, `tests/data-source.test.js`, `tests/e2e/device-config.spec.js`, `tests/e2e/live-mode.spec.js`, `tests/e2e/live-display.spec.js`, `tests/e2e/live-logs.spec.js`, `tests/simulation/thermal-model.test.js`) MUST be updated so that they exercise the 7-valve topology and MUST continue to pass under `npm test`. `tests/e2e/staged-valves.spec.js` contains no explicit `v_ret` string but depends on the staged-valve snapshot shape and MUST continue to pass unchanged (or with only mechanical fixture updates) after the rename.
- **FR-012**: The spec MUST record a decision on whether to keep Shelly Pro 2PM `unit_4` with one relay used (and one unused reserved as a spare) or to swap in a single-relay Shelly. The default recommendation is to **keep Pro 2PM `unit_4`** (wiring, enclosure, and DIN-rail layout already assume it; the unused second relay becomes a convenient spare). The BOM MUST remain consistent with whichever decision is recorded.
- **FR-013**: `design/diagrams/topology-layout.yaml` MUST remove `v_ret` from its valve list and its pipe list, and MUST introduce a T joint at the collector top with one branch going to the reservoir (terminating below water line) and one branch going to `V_air`.
- **FR-014**: `design/diagrams/generate-topology.js` MUST regenerate `system-topology.drawio` from the updated layout, and `tests/topology-diagram.test.js` MUST pass (drawio bytes match generator output).
- **FR-015**: The hand-authored SVGs in `design/diagrams/` (`system-topology.svg`, `system-height-layout.svg`, `solar-charging-flow.svg`, `active-drain-flow.svg`, `idle-state.svg`, and any others that show the collector top) MUST be updated to depict the new topology. `data-component` attributes for `v_ret` MUST be removed or updated.
- **FR-016**: `design/diagrams/control-states.mmd` and any other Mermaid diagrams MUST be updated to remove references to `V_ret`.
- **FR-017**: `design/docs/design.md`, `design/docs/bom.md`, `design/docs/commissioning-guide.md`, and `CLAUDE.md` MUST be updated so the narrative matches the corrected YAML: 7 motorized valves, T joint at collector top, updated per-mode valve tables, updated valve count in the Key Architecture Concepts section. In `CLAUDE.md` specifically, the `shelly/control-logic.js` and `shelly/control.js` description lines (around lines 73-74, added by 023-limit-valve-operations) that enumerate scheduler helpers MUST be re-read to confirm they stay accurate — they mention the PSU concurrent-open limit of 2 and the 60 s min-open hold, both of which stand unchanged under the 7-valve topology.
- **FR-018**: `design/docs/bom.md` and `system.yaml`'s `budget` / `shopping_list` MUST subtract the one removed valve (~65 €) from the motorized-valves subtotal and from the total estimate, and MUST update the per-item quantity from 8 to 7.
- **FR-019**: `playground/screenshots/` (the on-disk assets produced by `npm run screenshots`) MUST be regenerated after the other changes land, so imagery in the repo shows the corrected topology.
- **FR-020**: After all updates, `npm test` (unit + simulation + e2e) MUST pass on a clean checkout, with no residual references to `v_ret` in any file touched by the change except explicitly historical sections (earlier specs and superpowers notes).

### Key Entities

- **Collector-top junction**: Was: two motorized valves (`V_ret` + `V_air`) on separate outlets from the collector top pipe. Now: a passive three-way T joint. One branch is the collector-top pipe itself (permanently connected, water-filled during all modes except drain). One branch runs down to the reservoir and terminates below the reservoir water line. One branch runs to `V_air`, which is the only motorized valve still present at ~280 cm.
- **`V_air` (unchanged)**: Normally-open motorized valve on the atmospheric-air branch of the T joint. Closed during all operating modes except `active_drain`, `overheat_drain`, and any other drain-like mode. Relay logic remains inverted (relay ON closes valve, relay OFF opens valve) so power loss admits air.
- **Collector-top-to-reservoir pipe**: Passive water column. During solar charging, water flows through it from collector top to reservoir; during idle/greenhouse-heating, it is static; during drain, the siphon breaks as soon as `V_air` opens and the pipe contents drain harmlessly into the reservoir.
- **Shelly Pro 2PM unit_4**: Remains at the collector-top mounting location. Only one relay is wired to a motorized valve (`V_air`). The other relay is unused and reserved as a spare (per FR-012 default).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A full-text case-insensitive search for `v_ret`, `V_ret`, `vret`, `VRET`, or `V-ret` across `system.yaml`, `shelly/`, `server/`, `playground/`, `tests/`, `design/diagrams/`, `design/docs/` (excluding historical subdirectories under `specs/` and `design/docs/superpowers/specs/`), and `CLAUDE.md` returns **zero** matches.
- **SC-002**: `npm test` passes on a clean checkout with every updated and existing test green — no skipped tests, no xfail, no new warnings.
- **SC-003**: `tests/topology-diagram.test.js` passes, meaning the committed `system-topology.drawio` byte-matches the regenerated output of `generate-topology.js` against the corrected `system.yaml` + `topology-layout.yaml`.
- **SC-004**: The number of motorized valves reported by `system.yaml` (`valves.total_motorized`) equals 7, and every operating mode's `valve_states` block contains exactly the same seven valve keys (no stragglers, no typos).
- **SC-005**: The budget total in `system.yaml` and `design/docs/bom.md` both decrease by ~65 € relative to the previous figure, and the numbers in the two files agree.
- **SC-006**: A human reader opening the playground in a browser and switching through Status → Schematic → Components → Controls → Device sees a collector-top depiction with one motorized valve (`V_air`) and a T joint to the reservoir, with no element labelled `V_ret` anywhere on screen.
- **SC-007**: In live mode, when a simulated Shelly status message is fed through the MQTT bridge to the WebSocket, the broadcast payload contains exactly seven motorized valve fields and does not include `v_ret`; the playground processes it without console errors.
- **SC-008**: On power loss (simulated in a thermal-model test or reasoned about in the spec), the system comes to rest with `V_air` open (air admitted to T joint), all seven motorized valves in their de-energized state, the collector-top-to-reservoir down-leg drained into the reservoir, and the collector bodies unchanged — matching the updated fail-safe description.
- **SC-009**: The staged-opening scheduler (`planValveTransition`, `VALVE_TIMING`, SCHEDULE-loop state machine) retains identical behaviour after the 7-valve rename: the PSU concurrent-open limit is still 2, the opening-window is still 20 000 ms, the minimum-open hold is still 60 000 ms, the 1000-iteration invariant fuzz test in `tests/control-logic.test.js` still passes, and the three staged-valve snapshot fields (`opening`, `queued_opens`, `pending_closes`) still exist and never contain the string `v_ret`.

## Assumptions

- **A1**: The user's intent is to correct the system design, not to change its operational behaviour. Every mode that previously required `V_ret: OPEN` to carry water from the collector top to the reservoir now relies on the permanent T-joint connection, which is functionally identical during those modes.
- **A2**: The reservoir entry point for the new permanent pipe sits **below** the reservoir water line (as the user explicitly stated). This is treated as a hard constraint because the siphon physics require it.
- **A3**: During drain modes, the small volume of water in the collector-top-to-reservoir down-leg that releases when `V_air` opens is absorbed by the reservoir without overflowing (the reservoir's 20-50 L capacity is far larger than that pipe's volume of roughly 0.5-1 L).
- **A4**: Shelly Pro 2PM `unit_4` is kept at the collector-top location with one relay wired and one reserved (FR-012 default). Re-evaluating the hardware choice (swapping to a single-relay Shelly) is **out of scope** for this spec and may be handled by a separate hardware-optimisation feature.
- **A5**: Historical specs under `specs/010-…` through `specs/022-…` and `design/docs/superpowers/specs/**` are time-frozen snapshots. They will **not** be edited — their references to `V_ret` stand as historical record.
- **A6**: `playground/screenshots/` regeneration is a non-blocking finishing step — it can happen after all other changes are merged, as long as it happens before the feature is claimed complete.
- **A7**: The previously documented "power-loss gravity-assisted drain" fail-safe claim in `system.yaml` is preserved in spirit: on power loss, `V_air` still opens automatically (normally-open wiring), the siphon breaks, and the system comes safely to rest. The exact wording of that claim in `system.yaml` may be tightened during implementation to accurately describe what actually drains and what does not.

## Out of Scope

- Any hardware optimisation beyond removing the `V_ret` relay — e.g. swapping Pro 2PM `unit_4` for a single-relay Shelly, re-laying out the DIN rail, or re-assigning relay channels across units.
- Changes to operating mode triggers, exit conditions, minimum run times, or any other control-logic behaviour.
- Changes to other valves (input manifold, output manifold, service valves).
- Changes to the reservoir, tank, collectors, or pump.
- Changes to sensor assignments or the sensor-config pipeline.
- Re-running the auth, VPN, Kubernetes, or observability test suites beyond what is already triggered by `npm test`.
- Editing historical spec directories (`specs/010-…` through `specs/022-…`) or `design/docs/superpowers/specs/`.
