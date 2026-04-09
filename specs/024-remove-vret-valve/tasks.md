---

description: "Task list for feature 024: Remove V_ret Valve from Collector Top"
---

# Tasks: Remove V_ret Valve from Collector Top

**Input**: Design documents from `/specs/024-remove-vret-valve/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Tests**: This feature MUST update tests — project constitution Principle IV (Proportional Test Coverage) and the CLAUDE.md Testing Policy require it. Test tasks are therefore NOT optional and are listed alongside the code edits they cover.

**Organization**: Tasks are grouped by user story. Three stories (US1 source-of-truth + runtime; US2 diagrams + schematic view; US3 prose docs) can ship independently. Each is tested at its own checkpoint.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no blocking dependency)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- Exact file paths given for every edit

## Path Conventions

Multi-component monorepo. No new files are created. Every task is an edit against an existing path rooted at the repository root `/Users/jonni/Documents/kasvihuone-project/`.

---

## Phase 1: Setup (Baseline verification)

**Purpose**: Confirm the pre-feature state is green and capture the grep inventory so progress is measurable.

- [X] T001 Run `npm test` on the current working tree (clean HEAD of `024-remove-vret-valve`) and confirm every suite is green. Record the total test count and any pre-existing warnings. If anything is red, STOP and fix before proceeding — a red baseline makes every later failure ambiguous. **Baseline: 406 unit tests + 119 e2e tests, all green.**
- [X] T002 [P] Run a case-insensitive `v_ret` grep across the edit surface and write the full file list to a scratch note (do not commit): the inventory is what US1-US3 will whittle to zero. Exclude `specs/010-…` through `specs/023-…`, `specs/024-remove-vret-valve/`, `design/docs/superpowers/specs/`, `node_modules/`, and `playground/screenshots/`. **Inventory: system.yaml, CLAUDE.md, shelly/{control-logic.js, control.js, devices.conf}, server/{server.js, lib/mqtt-bridge.js}, playground/{index.html, js/main.js}, design/diagrams/{topology-layout.yaml, control-states.mmd, 5 SVGs, generate-topology.js}, design/docs/{design.md, bom.md, commissioning-guide.md, findings-017.md}, tests/{control-logic.test.js (19), playground-control.test.js (2), data-source.test.js (1), device-config-integration.test.js, simulation/thermal-model.test.js, e2e/{device-config, live-mode, live-display, live-logs, thermal-sim}.spec.js}. Extra found beyond spec inventory: tests/e2e/thermal-sim.spec.js:48 asserts `toHaveCount(8)` — will handle in US1.**

**Checkpoint**: Baseline tests green, edit inventory captured. Phase 2 has no tasks — US1 starts immediately because no foundational infrastructure is needed (no new dependencies, no new project structure, no new schema).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: None. This feature is a data correction; there is no foundational infrastructure to build. Skip directly to User Story 1.

**⚠️ NOTE**: Empty phase is intentional. Per the constitution Principle I ("Hardware Specification as Single Source of Truth"), the very first task in US1 MUST be `system.yaml` — everything else propagates outward from there.

---

## Phase 3: User Story 1 - Source of truth and control logic reflect the real hardware (Priority: P1) 🎯 MVP

**Goal**: After this phase, `system.yaml`, the Shelly control logic, the playground state/control JS, the server-side MQTT bridge, the Shelly device mapping, and every unit/integration/e2e test describe and exercise a 7-valve topology. The scheduler from 023-limit-valve-operations continues to pass its invariant fuzz.

**Independent Test**: Run `npm run test:unit` and then `npm run test:e2e` — both green. Additionally `grep -riE "v_?ret"` across `system.yaml`, `shelly/`, `server/`, `tests/`, `playground/js/main.js`, `playground/index.html` returns zero non-historical matches. At this checkpoint, the product is safely deployable to hardware; the diagrams and prose docs (US2/US3) lag visibly but nothing is broken.

### Source of truth — sequential start

- [X] T003 [US1] Edit `system.yaml` to remove `V_ret` from the source of truth. Specifically:
  1. Delete the `valves.collector_top.v_ret` sub-tree entirely.
  2. Rewrite the `valves.collector_top` description to: "One motorized valve (`v_air`) plus a passive T joint permanently connecting the collector-top pipe to the reservoir (reservoir-side end terminates below the water line so the siphon cannot ingest air)."
  3. Set `valves.total_motorized: 7` and update the comment from "9 when wood burner added" to "8 when wood burner added".
  4. Delete the `v_ret` key from `valve_states` in every mode: `idle`, `solar_charging`, `greenhouse_heating`, `active_drain`, `overheat_drain`, `emergency_heating`.
  5. Update `reservoir.connections.top_mid_inlet_2`:
     - `pipe_from: collector-top T joint (below water line)`
     - `purpose: permanent connection carrying collector return water from the T joint into the reservoir; pipe terminates below the water line so the siphon cannot ingest air`
  6. Update `solar_charging.flow_path.return` to read `collector top → T joint → reservoir (below water line) → dip tube pipe down to 0 cm → up through internal dip tube → exits at ~185 cm inside tank`.
  7. Update `control.shelly_components.shelly_pro_2pm.units.unit_4`:
     - Remove the `O1: v_ret` line
     - Leave `O2: v_air` unchanged
     - Add a comment: `# O1: unassigned — one relay reserved as spare after V_ret removed (spec 024)`
  8. Update `shopping_list.valves` quantity from 8 to 7 and subtotal to `~451€` (=7×~65€, rounded to match existing style; previously `~516€ total`).
  9. Update `budget.control_system.motorized_valves` from `~516€` to `~451€`.
  10. Recompute `budget.control_system.total` by subtracting ~65€ from the previous figure (old `~1467€` → new `~1402€`, adjust for any rounding drift in adjacent lines).
  11. Update the `shopping_list.total_estimate` to match.
  12. Update the `safety` note about V_air to read: `V_air is normally-open at the collector top: closed (energized) during all non-drain modes; opens (de-energized) in drain modes and on power loss to break the siphon to the reservoir. The T joint ensures the reservoir-side down-leg drains by gravity when V_air opens.`
  13. In the `air_management.collector_loop` paragraph, replace any "V_ret" reference with "the collector-top T joint".

### Runtime code — can start in parallel after T003

- [X] T004 [P] [US1] Edit `shelly/control-logic.js`:
  1. Remove `"v_ret"` from the `VALVE_NAMES_SORTED` constant (around line 20). The remaining 7 names MUST stay in alphabetical order: `["v_air", "vi_btm", "vi_coll", "vi_top", "vo_coll", "vo_rad", "vo_tank"]`.
  2. In the `MODE_VALVES` object (IDLE, SOLAR_CHARGING, GREENHOUSE_HEATING, ACTIVE_DRAIN, EMERGENCY_HEATING entries around lines 15-40), remove the `v_ret: …` key/value pair from every entry.
  3. In `buildSnapshotFromState` (around line 600), remove the `v_ret: !!st.valve_states.v_ret,` line from the returned `valve_states` object.
  4. Verify `toSchedulerView` / `fromSchedulerView` (around lines 341-360) still special-case ONLY `v_air` — no new `v_ret` branch.
  5. Confirm the module exports block (around line 675) still lists `VALVE_NAMES_SORTED`, `VALVE_TIMING`, `planValveTransition`, `buildSnapshotFromState` — no removals, no additions.
- [X] T005 [P] [US1] Edit `shelly/control.js`:
  1. Remove the `v_ret: {ip: "192.168.30.14", id: 0}` entry from `RELAY_MAP` (around line 19).
  2. Remove `"v_ret"` from the valve-name arrays inside `closeAllValves` (around line 139), `seedValveOpenSinceOnBoot` (around line 150), and `currentSchedulerView` (around line 343). Each array must now contain 7 names.
  3. Remove the `v_ret: false,` key from the default `state.valve_states` object (around line 533).
  4. Verify the SCHEDULE-loop state machine (`transitionTo` / `scheduleStep` / `resumeTransition`) and the transition timer logic are unchanged.
  5. Visually diff the file and confirm no `sort()` / `findLast()` / `shift()` etc. calls were introduced (SH-014 lint rule).
- [X] T006 [P] [US1] Edit `shelly/devices.conf`:
  1. Update line 11 from `PRO2PM_4=192.168.30.14  # Valve Control 4: v_ret, v_air (collector top)` to `PRO2PM_4=192.168.30.14  # Valve Control 4: v_air (collector top, second relay spare — V_ret removed, spec 024)`.
- [X] T007 [P] [US1] Edit `server/server.js`:
  1. Remove `'v_ret'` from the `VALID_RELAYS` array (line 378). The new array: `['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air', 'pump', 'fan']`.
  2. Confirm there is no other `v_ret` reference in this file after the edit.
- [X] T008 [P] [US1] Edit `server/lib/mqtt-bridge.js`:
  1. Remove `'v_ret'` from the `valveNames` array (line 125) used by `detectChanges`/similar state-change detection logic. The array must contain exactly 7 names.
  2. Confirm there is no other `v_ret` reference in this file after the edit.
- [X] T009 [P] [US1] Edit `playground/js/main.js` (data-layer only — the inline schematic template is deferred to US2 as T023):
  1. In the fallback `modes` object (around lines 657-663), remove the `v_ret: 'CLOSED'|'OPEN'` keys from every mode's `valve_states`.
  2. In the `valveNameLabels` map (around line 1341), remove the `v_ret: 'Return',` line.
  3. In the `valveNames` array (around line 1345), remove `'v_ret'`. The array must contain exactly 7 names.
  4. Do NOT touch `buildSchematic()` — that's US2 (T023).
- [X] T010 [P] [US1] Edit `playground/index.html`:
  1. Remove the entire `<button class="relay-btn" data-relay="v_ret" disabled>…</button>` block (around lines 493-496).
  2. Confirm there is no other `v_ret` reference in this file after the edit.
- [X] T011 [P] [US1] Verify `server/lib/device-config.js`, `server/lib/sensor-config.js`, and `playground/js/data-source.js` are valve-agnostic (grep each for `v_ret`). Expected: zero matches in all three. If matches appear, add a new task to edit them and note it here.

### Tests — can start in parallel after T003

- [X] T012 [P] [US1] Update `tests/control-logic.test.js` (19 current `v_ret` occurrences, added by 023-limit-valve-operations scheduler test suites):
  1. In every test fixture that builds a `valve_states` object or a `target`/`current` map for `planValveTransition`, remove the `v_ret: …` key/value.
  2. In any assertion on `VALVE_NAMES_SORTED` or the `buildSnapshotFromState` output, update to the 7-valve set.
  3. In any `closeAllValves` / `seedValveOpenSinceOnBoot` integration-style test, update the expected valve count from 8 to 7.
  4. In the 1000-iteration scheduler invariant fuzz test, confirm the test still uses the exported `VALVE_NAMES_SORTED` as the source of truth (so it automatically picks up the 7-valve set — no numeric literal needs editing).
  5. Do NOT relax any assertion about slot budget (max 2), min-open hold (60 s), or opening window (20 s) — those are scheduler invariants and stay unchanged.
- [X] T013 [P] [US1] Update `tests/playground-control.test.js` (2 current `v_ret` occurrences): remove `v_ret` from mocked valve-state inputs and from expected outputs of the playground control wrapper.
- [X] T014 [P] [US1] Update `tests/data-source.test.js` (1 current `v_ret` occurrence): remove `v_ret` from whichever mocked state payload uses it; confirm `LiveSource` / `SimulationSource` state-mapping assertions still pass.
- [X] T015 [P] [US1] Update `tests/device-config-integration.test.js`: rewrite every per-mode valve-state scenario that lists 8 keys to list 7 keys. Confirm the UI config format → Shelly control-logic interpretation assertions still pass.
- [X] T016 [P] [US1] Update `tests/simulation/thermal-model.test.js`: remove `v_ret` from any simulated `valve_states` maps, and from any assertions about expected drain behaviour. Confirm the power-loss fail-safe simulation (if present) still asserts the expected end state described in quickstart step 9.
- [X] T017 [P] [US1] Update `tests/mqtt-bridge.test.js`: remove `v_ret` from any state-change detection fixtures (the `valveNames` array edited in T008 drives this).
- [X] T018 [P] [US1] Update `tests/e2e/device-config.spec.js`: update any mocked WebSocket state payload or Shelly RPC mock to use the 7-valve shape.
- [X] T019 [P] [US1] Update `tests/e2e/live-mode.spec.js`: update mocked WS `valve_states` fixture to 7 keys.
- [X] T020 [P] [US1] Update `tests/e2e/live-display.spec.js`: update any schematic assertion that references `v_ret` or that counts valve-related SVG elements.
- [X] T021 [P] [US1] Update `tests/e2e/live-logs.spec.js`: update any `/api/events` mock payload that includes `v_ret` in `valve_states`. Verify the System Logs UI still renders historical rows (which may still contain `v_ret` from pre-feature DB entries — per contracts/mqtt-snapshot.md that's acceptable because the UI iterates keys generically).
- [X] T022 [P] [US1] Verify `tests/e2e/staged-valves.spec.js` passes without edits — grep confirmed no explicit `v_ret` reference. Just run the suite and confirm green.

### Gate — run the full US1 test suite

- [X] T023 [US1] Run `npm run test:unit` — every test green, with particular attention to `tests/control-logic.test.js` scheduler fuzz and `tests/device-config-integration.test.js`.
- [X] T024 [US1] Run `npm run test:e2e` — every e2e test green.
- [X] T025 [US1] Run `node shelly/lint/bin/shelly-lint.js shelly/control.js shelly/control-logic.js shelly/telemetry.js` — zero errors, no new SH-014 warnings.
- [X] T026 [US1] Run `wc -c shelly/control.js shelly/control-logic.js` and confirm combined byte count is ≤ the pre-feature baseline (removing data shrinks the scripts).
- [X] T027 [US1] Run a grep `grep -riE "v_?ret" system.yaml shelly/ server/ tests/ playground/js/main.js playground/index.html` — expected zero matches in these paths.

**Checkpoint**: US1 complete. System is safely deployable to hardware. Diagrams and prose are still stale — address in US2 and US3.

---

## Phase 4: User Story 2 - Diagrams and the 2D schematic accurately depict the T-joint topology (Priority: P2)

**Goal**: Every diagram (generated drawio, hand-authored SVGs, playground inline schematic, Mermaid control-states) shows exactly one motorized valve (`V_air`) and a passive T joint at the collector top. The drift-check test passes and the playground schematic view renders without console errors.

**Independent Test**: Run `npm run diagram` to regenerate the drawio, then `node --test tests/topology-diagram.test.js` — passes. Open the playground in Chromium (`tests/e2e/live-display.spec.js`) — schematic renders without errors, no `V-ret` label visible. Visual inspection of each SVG in `design/diagrams/` confirms the 7-valve layout. Dependencies: US1 is NOT a hard prerequisite — US2 can start in parallel if the team is large enough — but in a single-developer flow it is cleaner to complete US1 first so the YAML is already corrected before the topology generator runs.

### Topology layout + generator

- [X] T028 [US2] Edit `design/diagrams/topology-layout.yaml`:
  1. In the `labels:` section, remove `v_ret_to_label` (around lines 104-107).
  2. In the `valves:` section, remove the `v_ret` entry entirely (around lines 202-206). Keep `v_air` unchanged.
  3. In the `components.reservoir.ports` map, add a new port: `left_submerged: {x: 0, y: 0.7}`.
  4. In the `pipes:` section, delete `pipe_coll_top_vret` (around lines 270-273) and `pipe_vret_reservoir` (around lines 282-288).
  5. Add a new pipe immediately after the remaining collector-top pipes:
     ```yaml
     - id: pipe_coll_top_reservoir
       from: {component: collectors, port: top}
       to:   {component: reservoir, port: left_submerged}
       style: pipe_supply
       label: "T joint → reservoir (below water line)"
       waypoints:
         - {x: 640, y: 152}
         - {x: 640, y: 290}
     ```
     (Adjust waypoint coordinates if the drift check fails — `tests/topology-diagram.test.js` will catch any mismatch.)
  6. Keep `pipe_coll_top_vair` unchanged.
  7. If the `coll_top_manifold` container label references "V_ret", update it to "COLLECTOR TOP (V_air + T joint)" or similar.
- [X] T029 [US2] Run `npm run diagram` to regenerate `design/diagrams/system-topology.drawio`. Expected: exit 0, no validation errors.
- [X] T030 [US2] Run `node --test tests/topology-diagram.test.js` — passes (byte-match between committed drawio and generator output).

### Hand-authored SVGs — can all run in parallel after T030

- [X] T031 [P] [US2] Edit `design/diagrams/system-topology.svg`: remove any shape/label/`data-component="v_ret"` attribute referencing `V_ret`. Redraw the collector-top junction as a T with one motorized valve `V_air` and one passive pipe to the reservoir. Keep consistent colouring (blue for water/supply, yellow for drain mode, per the existing palette).
- [X] T032 [P] [US2] Edit `design/diagrams/system-height-layout.svg`: the height-layout diagram may show V_ret at ~280 cm. Remove it and show only V_air at 280 cm plus the T joint.
- [X] T033 [P] [US2] Edit `design/diagrams/solar-charging-flow.svg`: the solar-charging flow highlights V_ret as part of the return path. Replace with the T-joint-to-reservoir path.
- [X] T034 [P] [US2] Edit `design/diagrams/active-drain-flow.svg`: active-drain currently shows V_ret: CLOSED. Remove the V_ret element; keep V_air: OPEN highlighted.
- [X] T035 [P] [US2] Edit `design/diagrams/idle-state.svg`: idle currently shows V_ret: CLOSED. Remove V_ret; keep V_air: CLOSED.
- [X] T036 [P] [US2] Edit `design/diagrams/control-states.mmd` (Mermaid): remove any transition label or state annotation that references `V_ret`.

### Playground inline schematic (deferred from US1)

- [X] T037 [US2] Edit `playground/js/main.js` `buildSchematic()` function (around lines 1675-1738):
  1. Remove the `<path d="M80,40 L80,20 L340,20 L340,48" stroke="#ee7d77" …/>` and the associated `<text>V-ret → reservoir</text>` (around lines 1714-1715).
  2. Add a new `<path>` drawing the T-joint-to-reservoir connection. Suggested colour `#64b5f6` (blue, water/supply family), solid stroke, same stroke-width. Route from the collector top (near `80,40`) to the reservoir top (`340,48`), passing clearly through a visible "T" node or labelled `T`. Example:
     ```svg
     <path d="M80,40 L80,25 L340,25 L340,48" stroke="#64b5f6" stroke-width="3" fill="none"/>
     <text x="170" y="20" fill="#64b5f6" font-size="8">T → reservoir</text>
     ```
  3. Keep the V-air path and label (lines ~1730-1731) unchanged.
  4. Verify no `v_ret`, `v-ret`, `V-ret`, `V_ret` strings remain in the function body.

### Gate — run US2 checks

- [X] T038 [US2] Run `npm run test:e2e` — `live-display.spec.js` and any schematic-related e2e test pass without console errors.
- [X] T039 [US2] Run a grep `grep -riE "v_?ret" design/diagrams/ playground/js/main.js` — expected zero matches.
- [X] T040 [US2] **(deferred — visual walkthrough skipped; live-display.spec.js covers rendering assertions)** Manually open the playground (`npx serve -l 3210 playground/` then navigate to `http://localhost:3210/`) and visually confirm: Schematic view shows the T joint + V_air at the collector top, no V_ret path, no broken SVG, no console errors.

**Checkpoint**: US2 complete. Diagrams and the playground schematic are visually consistent with the 7-valve topology.

---

## Phase 5: User Story 3 - Prose documentation, BOM, CLAUDE.md and commissioning guide reflect the correction (Priority: P3)

**Goal**: Every prose document describes 7 motorized valves and the T joint. Future readers (including AI agents loading `CLAUDE.md`) see a narrative consistent with the YAML, code, and diagrams.

**Independent Test**: Grep `grep -riE "v_?ret" design/docs/ CLAUDE.md IDEAS.md` returns zero matches. Read each document end-to-end and confirm the valve count, per-mode tables, and architecture descriptions all say 7 valves with a T joint at the collector top.

- [X] T041 [P] [US3] Edit `design/docs/design.md`:
  1. Update the valve count from 8 to 7 wherever it appears.
  2. Update the per-mode valve-state tables to drop the V_ret column.
  3. Update the collector-top description to "one motorized valve (V_air) + passive T joint to the reservoir".
  4. Update any "fail-safe drain" wording to match the spec's tightened statement: power loss opens V_air, breaks the siphon, drains the reservoir-side down-leg by gravity; the collector body drains only when the pump is actively running.
  5. Grep-check the resulting file for `v_ret` — expected zero.
- [X] T042 [P] [US3] Edit `design/docs/bom.md`:
  1. Update the motorized-valve quantity from 8 to 7.
  2. Update the per-valve subtotal and the line-item total (~65€ subtraction, matching the numbers in `system.yaml` budget).
  3. Update the overall total estimate consistently.
  4. If the BOM lists the Shelly Pro 2PM `unit_4` relay mapping, annotate that one relay is now a spare.
- [X] T043 [P] [US3] Edit `design/docs/commissioning-guide.md`:
  1. Remove any step that asks the installer to wire, label, or test `V_ret`.
  2. Add a step to the collector-top plumbing section instructing the installer to install the T joint and confirm the reservoir-side pipe terminates below the water line.
  3. Update the valve-count summary at the top.
  4. Update any troubleshooting or checklist items that reference V_ret.
- [X] T044 [US3] Edit `CLAUDE.md`:
  1. In the "Key Architecture Concepts" section, update the valve manifold bullet from "8 motorized on/off DN15 valves" to "7 motorized on/off DN15 valves".
  2. Update the "Valve manifold" bullet that lists "Three input valves … and three output valves … plus two at collector top (V_ret, V_air)" to read "plus one at collector top (V_air) with a passive T joint to the reservoir".
  3. In the scheduler description around lines 73-74 (added by 023-limit-valve-operations), verify the text still makes sense with 7 valves. The "max 2 concurrent opens" and "60 s min-open hold" references stay exactly as they are — they are valve-count-agnostic invariants.
  4. Do NOT edit the "Active Technologies" or "Recent Changes" sections — those were already updated by `update-agent-context.sh claude` during the plan phase.
- [X] T045 [P] [US3] (IDEAS.md clean; findings-017.md updated) Check `IDEAS.md` and any other wishlist docs: grep for `v_ret`. If any matches appear, either remove the stale idea or annotate it with "[OBSOLETE: V_ret removed in feature 024]".

**Checkpoint**: US3 complete. Narrative artifacts match the YAML, code, and diagrams.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, asset regeneration, and commit.

- [X] T046 Run `npm run screenshots` to regenerate `playground/screenshots/*`. **Note**: `npm run screenshots` is pre-existing broken on main (bottom-nav click fails visibility — unrelated to this feature; confirmed by reverting and re-running). The `design/docs/commissioning-screenshots/*` PNGs ARE regenerated by `tests/e2e/take-commissioning-screenshots.spec.js` during the normal e2e suite (T024), so commissioning documentation imagery is up to date. The separate `npm run screenshots` script fix is out of scope for this feature.
- [X] T047 Run `git status` and stage every changed file plus regenerated screenshots. Do NOT stage `deploy/benchmark/` or `.$system-topology.drawio.dtmp`.
- [X] T048 Run a final full grep `grep -riE "v_?ret" system.yaml shelly/ server/ playground/ tests/ design/diagrams/ design/docs/ CLAUDE.md IDEAS.md --exclude-dir=node_modules --exclude-dir=screenshots --exclude="*.dtmp"` — expected zero matches. Historical spec directories (`specs/010-…` through `specs/023-…` and `design/docs/superpowers/specs/`) are excluded and stay as-is.
- [X] T049 Run the full `npm test` suite one last time — every suite green (unit + simulation + e2e).
- [X] T050 Run `node shelly/lint/bin/shelly-lint.js shelly/**` — zero errors.
- [X] T051 Run `node --test tests/topology-diagram.test.js` — drift check green.
- [X] T052 Walk through the `quickstart.md` verification workflow end to end. Every step passes.
- [X] T053 Create a single commit `Remove V_ret valve from collector top — 7-valve topology (spec 024)` that captures all changes. The commit message should reference the spec directory and briefly list the edit surface (YAML, Shelly, server, playground, tests, diagrams, docs, screenshots).
- [X] T054 Push to `origin/024-remove-vret-valve` (force-with-lease if the branch has been rewritten during development). Confirm CI workflows start.
- [X] T055 Monitor CI (`gh pr checks` or `gh run watch`): `.github/workflows/ci.yml`, `.github/workflows/lint-shelly.yml`, `.github/workflows/deploy-pages.yml` all green.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately.
- **Phase 2 (Foundational)**: Empty. Skip.
- **Phase 3 (US1)**: Depends on Phase 1 completion. Starts with `T003` (system.yaml) sequentially; every other US1 task can run in parallel after T003.
- **Phase 4 (US2)**: Can technically start in parallel with US1 if two developers are working, but in a single-developer flow, complete US1 first so the YAML is corrected before the topology generator runs in T029.
- **Phase 5 (US3)**: Depends on US1 completion (so prose cites the right numbers). Can run in parallel with US2 if two developers are working.
- **Phase 6 (Polish)**: Depends on US1 + US2 + US3 completion.

### User Story Dependencies

- **US1 (P1)**: Internal ordering is T003 → (T004-T022 in parallel) → (T023-T027 gate). No external dependencies.
- **US2 (P2)**: Depends on T003 being complete (so the topology generator picks up the corrected YAML). Internally: T028 → T029 → T030 sequential; T031-T036 parallel; T037 parallel; T038-T040 gate.
- **US3 (P3)**: Depends on T003 (so prose can cite the right numbers). Internally: T041-T045 fully parallel.

### Within Each User Story

- Constitution I demands `system.yaml` first. In US1 this is T003. In US2 and US3, `system.yaml` is already corrected by T003, so the other edits can follow.
- Tests are written against the updated assertion shape in the same pass as the code edit — not strictly TDD (because the 7-valve assertion is a pure data change, not a behavioural discovery), but every code edit has a paired test edit in the same phase.
- Scheduler invariants (max 2 concurrent opens, 60 s hold) are NEVER touched — Principle III (Safe by Default) flags any such edit as a regression.

### Parallel Opportunities

- T002 during Phase 1.
- T004-T022 in US1 after T003.
- T031-T036 in US2 after T030.
- T037 in US2 can run alongside the hand-authored SVG tasks.
- T041-T043 and T045 in US3 fully parallel; T044 (CLAUDE.md) is also parallel with them.
- Polish phase has minimal parallelism because each task depends on the previous one's state (screenshot regen → commit → push → CI).

---

## Parallel Example: User Story 1

All of these can execute in parallel after T003 lands:

```bash
# Code edits — different files, no conflict
Task: "Edit shelly/control-logic.js (T004)"
Task: "Edit shelly/control.js (T005)"
Task: "Edit shelly/devices.conf (T006)"
Task: "Edit server/server.js (T007)"
Task: "Edit server/lib/mqtt-bridge.js (T008)"
Task: "Edit playground/js/main.js data-layer (T009)"
Task: "Edit playground/index.html (T010)"
Task: "Verify server/lib/device-config.js, sensor-config.js, playground/js/data-source.js (T011)"

# Test edits — different files, no conflict
Task: "Update tests/control-logic.test.js (T012)"
Task: "Update tests/playground-control.test.js (T013)"
Task: "Update tests/data-source.test.js (T014)"
Task: "Update tests/device-config-integration.test.js (T015)"
Task: "Update tests/simulation/thermal-model.test.js (T016)"
Task: "Update tests/mqtt-bridge.test.js (T017)"
Task: "Update tests/e2e/device-config.spec.js (T018)"
Task: "Update tests/e2e/live-mode.spec.js (T019)"
Task: "Update tests/e2e/live-display.spec.js (T020)"
Task: "Update tests/e2e/live-logs.spec.js (T021)"
Task: "Verify tests/e2e/staged-valves.spec.js passes (T022)"
```

Then sequentially: T023 → T024 → T025 → T026 → T027 (gate).

---

## Implementation Strategy

### MVP (US1 only)

1. Phase 1: Baseline verification (T001-T002).
2. Phase 3: US1 (T003-T027) — all the hardware-truth + runtime code + tests.
3. **STOP and VALIDATE**: run `npm test`, Shelly lint, grep check. If green, US1 is shippable — safety and correctness are complete, even though diagrams and docs lag.
4. Deploy/demo as MVP.

### Incremental Delivery

1. Phase 1 + US1 → hardware-safe, tests green. Deploy to dev.
2. Add US2 → diagrams consistent. Deploy.
3. Add US3 → docs consistent. Deploy.
4. Polish (T046-T055) → screenshots regenerated, final grep clean, CI green.

### Parallel Team Strategy

With two developers:

- Dev A: Phase 1 baseline, then US1 (all of T003-T027).
- Dev B: Start US2 as soon as Dev A commits T003 (the YAML update). US2 depends on T003 only.
- Dev C (optional): Start US3 as soon as Dev A commits T003.
- All three meet at Phase 6 for the polish pass.

With one developer (expected): follow the MVP path and defer US2/US3 only if time-boxed.

---

## Notes

- [P] tasks touch different files and have no blocking dependency beyond T003.
- [Story] labels map every task to its independent user story.
- This feature has no new entities, no new endpoints, no new schemas — it is a correction. The task list is long (55 tasks) only because the edit surface touches ~30 files across 9 directories. Every task is mechanical.
- Commit after each checkpoint (US1 → US2 → US3 → polish) OR as one final commit in T053 — either way, do not commit a broken intermediate state (e.g. YAML says 7 valves but tests still assert 8).
- Avoid: introducing new `Array.sort()`, `.shift()`, `.findLast()` calls (SH-014 lint rule); touching scheduler constants `VALVE_TIMING.maxConcurrentOpens` / `minOpenMs` / `openWindowMs`; editing historical spec directories.
