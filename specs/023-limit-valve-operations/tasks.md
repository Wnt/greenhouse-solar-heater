---

description: "Task list for 023-limit-valve-operations"
---

# Tasks: Limit Concurrent Valve Operations

**Input**: Design documents from `/specs/023-limit-valve-operations/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/valve-scheduler.md, quickstart.md

**Tests**: Included. The feature spec mandates test coverage (SC-008) and the project testing policy (CLAUDE.md) requires test-first for behavior changes. Tests are written before the corresponding implementation within each story.

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and validated independently. The P1 stories (US1, US2, US3) share the pure scheduler (`planValveTransition`) but each adds a distinct decision branch plus its own shell wiring — they layer cleanly.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: Story label (US1 / US2 / US3 / US4 / US5) — omitted for Setup, Foundational, and Polish
- Paths are absolute within the repository root

---

## Phase 1: Setup

**Purpose**: Confirm the dev environment and baseline state for the 023 branch

- [X] T001 Verify `npm install` is current and baseline `npm test` passes before touching any files (establishes a known-good reference for regression checks throughout the feature)
- [X] T002 Run `node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js` to confirm the baseline Shelly files lint cleanly before modification

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Introduce the shared scheduler plumbing that every P1 story depends on. This includes the `VALVE_TIMING` constant block, the exported skeleton of `planValveTransition` (handles the trivial no-op / target-reached case), v_air polarity translation helpers used by the shell, and the new timing-state fields on the shell's `state` object. After Phase 2 the scheduler exists, returns valid shapes, and is callable from the shell — but it does not yet enforce the open-slot budget or the close hold (those come in US1–US3).

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T003 Add `VALVE_TIMING` plain object literal (`maxConcurrentOpens: 2`, `openWindowMs: 20000`, `minOpenMs: 60000`) next to `DEFAULT_CONFIG` in `shelly/control-logic.js`, and extend the `module.exports` block at the bottom of the file to export `VALVE_TIMING` and `planValveTransition` (see contracts/valve-scheduler.md §Signature and research.md R8)
- [X] T004 Add the skeleton `function planValveTransition(target, current, openSince, opening, now, cfg)` to `shelly/control-logic.js`: classify valves into "needs open" / "needs close" / "satisfied", return an object with the full shape `{startOpening, closeNow, queuedOpens, deferredCloses, nextResumeAt, targetReached}` but with all branches empty/null and `targetReached` computed solely from "every target[v] === current[v] and no live opening window". No slot budget and no hold logic yet (those are added in US1/US3).
- [X] T005 [P] Add the `describe('planValveTransition', ...)` block to `tests/control-logic.test.js` with the two foundational-level cases from the contract checklist: case 9 ("target reached → targetReached=true, nextResumeAt=null") and the pure-function / determinism smoke test (INV8). Confirm both pass against the T004 skeleton.
- [X] T006 [P] Add `toSchedulerView(valves)` and `fromSchedulerView(valves)` helpers to `shelly/control.js` that swap the `v_air` entry (logical ↔ energized semantics) and pass all other valve keys through unchanged. These are used at every scheduler boundary so the pure logic sees uniform "energize/de-energize" semantics (research.md R4).
- [X] T007 [P] Add a unit-test block to `tests/control-logic.test.js` (or a new polarity test file, if cleaner) that exercises the v_air round-trip: `fromSchedulerView(toSchedulerView(x)) === x` for every combination, and that a logical `v_air: true` maps to scheduler `v_air: false` and vice versa. (These helpers live in `control.js` but are pure and testable.)
- [X] T008 Extend the `state` object initialization in `shelly/control.js` with the new timing-state fields: `valveOpenSince = {}`, `valveOpening = {}`, `valvePendingOpen = []`, `valvePendingClose = []`, `targetValves = null`, `transitionTimer = null`. Ensure they are reset on boot and that existing references to `state` are not broken.
- [X] T009 Add the boot-recovery rule to `shelly/control.js`: on the first control-loop iteration (or at the end of the existing boot `closeAllValves()` sequence), seed `state.valveOpenSince[v] = 0` for every valve name in `MODE_VALVES`, so that any valve subsequently observed open satisfies the hold trivially per FR-015 and research.md R7.

**Checkpoint**: Foundation ready. `planValveTransition` exists, is callable, returns the full shape, and the shell has placeholders for timing state. The scheduler does not yet enforce the slot budget or the close hold — user stories now add those.

---

## Phase 3: User Story 1 - Protect the 24V PSU During Mode Transitions (Priority: P1) 🎯 MVP

**Story goal**: The scheduler enforces "at most two valves energizing from closed to open at the same time". The shell calls the scheduler during `transitionTo()` and actuates only the `startOpening` set, queueing the rest.

**Independent test**: Call `planValveTransition` directly with a `target` that opens 4 valves from an all-closed `current`, `openSince = {all: 0}`, `opening = {}`, fresh `now`: expect `startOpening.length === 2`, `queuedOpens.length === 2`, `closeNow === []`, `deferredCloses === {}`, `targetReached === false`, `nextResumeAt === now + 20000`. Additionally, a single-valve-open call returns `startOpening === [v]` with no queue. These checks verify only the PSU slot budget without depending on the inter-tick driver (US2) or the close-hold (US3).

### Tests for User Story 1 ⚠️

> Write these tests FIRST against the T004 skeleton. They MUST fail before implementing T012–T015.

- [X] T010 [P] [US1] Add contract test case 1 (single valve needs to open, no constraints → `startOpening = [v]`, `nextResumeAt = now + openWindowMs`, `targetReached = false`) to the `planValveTransition` describe block in `tests/control-logic.test.js`
- [X] T011 [P] [US1] Add contract test case 2 (four closed valves all need to open, all slots free → exactly two in `startOpening`, exactly two in `queuedOpens`, stable alphabetical ordering) and the deterministic-ordering case (checklist 15) to `tests/control-logic.test.js`
- [X] T012 [P] [US1] Add contract test case 11 (mix: two valves need to close and three need to open → two opens in `startOpening`, one in `queuedOpens`, two in `closeNow`; asserts the slot budget counts only opens) to `tests/control-logic.test.js`. Assume `openSince` values make the closes immediately eligible — hold behavior is exercised in US3.
- [X] T013 [P] [US1] Add an invariant assertion helper + INV1 (`|opening live| + startOpening.length <= cfg.maxConcurrentOpens`), INV2 (no valve in both `startOpening` and `closeNow`), INV4 (no valve in `startOpening` with `current[v] === true`), and INV5 (no valve in `closeNow` with `current[v] === false`) to `tests/control-logic.test.js`

### Implementation for User Story 1

- [X] T014 [US1] Implement the slot-budget logic in `planValveTransition` in `shelly/control-logic.js`: count live opening windows (`opening[v] > now`), compute free slots, iterate "needs open" valves in stable alphabetical order, filling `startOpening` until slots are exhausted and then spilling into `queuedOpens`. Also add the basic `closeNow` population (unconditional — hold logic comes in US3) so that T012 passes.
- [X] T015 [US1] Wire `planValveTransition` into `shelly/control.js`'s existing `transitionTo(result)` path: after the current pump-stop + VALVE_SETTLE_MS wait, call the scheduler (via `toSchedulerView(current)` and `toSchedulerView(result.valves)`), and issue `setValve(v, true)` for each entry in `plan.startOpening` (translating back with `fromSchedulerView` semantics where applicable). For this story, the legacy "fire all closes, wait, fire all opens" fallback is replaced by "fire plan.closeNow in parallel and plan.startOpening in parallel" only — pending opens and deferred closes are not yet honored in the shell (that's US2 and US3). Record `state.valveOpening[v] = now + VALVE_TIMING.openWindowMs` for each started open so the slot budget is visible to subsequent calls.

**Checkpoint**: A single-tick transition that commands ≤2 opens completes normally. A transition that commands >2 opens fires the first two and leaves the rest in the plan's `queuedOpens` — the shell does not yet act on the queue (US2). Run the scheduler unit tests and confirm T010–T013 pass. `npm run test:unit` must stay green for all previously-passing tests.

---

## Phase 4: User Story 2 - Queue Pending Opens Across Control Cycles (Priority: P1)

**Story goal**: Pending opens and partially-complete transitions survive across control ticks. The scheduler returns `nextResumeAt`, and the shell drives the state machine forward with a transition-scoped Shelly timer that resumes the SCHEDULE step when the earliest opening window ends.

**Independent test**: Using the simulation harness (`tests/simulation/scenarios.js`), begin a transition whose target requires four previously-closed valves to open. Advance simulated time. Assert: at t=0 the first batch of two starts; at t=20000 the second batch starts; at t≈40000–45000 the transition completes and the target state is fully reached with no residual `valvePendingOpen`. Confirm `state.transitioning` stays true across the whole window.

### Tests for User Story 2 ⚠️

- [X] T016 [P] [US2] Add contract test case 3 (two valves already mid-flight in `opening`, two more in `target` → `startOpening === []`, both newcomers in `queuedOpens`, `nextResumeAt === min(opening[v] for live windows)`) to `tests/control-logic.test.js`
- [X] T017 [P] [US2] Add contract test case 4 (re-plan after the first batch's window ends → `opening` now empty, two queued valves move into `startOpening`, `nextResumeAt` is the new window end) to `tests/control-logic.test.js`
- [X] T018 [P] [US2] Add contract test case 10 (mid-transition target change: valve X is currently in `opening` but the new `target` says close X → X is NOT added to any action list, `nextResumeAt` still includes `opening[X]` so the shell will re-plan after the window ends; see contract §3 implementation-note option (b)) to `tests/control-logic.test.js`
- [X] T019 [P] [US2] Add contract test case 14 (`nextResumeAt` picks the earliest candidate across a mix of live opening windows and deferred closes) to `tests/control-logic.test.js`
- [X] T020 [US2] Add a multi-batch transition scenario to `tests/simulation/scenarios.js` named `"Open four valves in two batches within 45 s"`: initial state has four valves closed, target opens all four, advances simulated clock, asserts the two-batch cadence and the final valve map. Wire it into `tests/simulation/simulation.test.js` if it has an explicit scenario list.

### Implementation for User Story 2

- [X] T021 [US2] Extend `planValveTransition` in `shelly/control-logic.js` with the `nextResumeAt` computation: minimum of all live `opening[v]` timestamps and all values in `deferredCloses` (deferredCloses is still empty at this point but include it so the field is future-proof for US3). Also finalize the `targetReached` computation per contract §5 (empty action lists AND no live opening windows).
- [X] T022 [US2] Rewrite the `transitionTo(result)` state machine in `shelly/control.js` into the SCHEDULE loop described in data-model.md §"Transition state machine": set `state.targetValves = result.valves`, call the scheduler, execute `closeNow` and `startOpening`, store `queuedOpens` in `state.valvePendingOpen`, and if `plan.targetReached === false` schedule a `Timer.set(plan.nextResumeAt - now, false, resumeTransition)` into `state.transitionTimer`; if `plan.targetReached === true` proceed to PUMP_PRIME → RUNNING.
- [X] T023 [US2] Add the `resumeTransition()` helper in `shelly/control.js`: clear `state.transitionTimer`, walk `state.valveOpening` to delete entries where `opening[v] <= now` (and for each deleted entry write `state.valveOpenSince[v] = now` — the US3 tracking hook), then re-invoke the SCHEDULE step with the fresh `now` and the current physical valve state. Handle the `plan.targetReached` exit by clearing `state.targetValves` and `state.valvePendingOpen` before proceeding to pump prime.
- [X] T024 [US2] Ensure `state.transitioning` remains `true` across the full SCHEDULE loop (from PUMP_STOP through PUMP_PRIME) so the 30 s control loop continues to skip `evaluate()`'s mode decisions while valves are being marshalled. Audit the existing `transitioning` flag assignments and add any missing guards.
- [X] T025 [US2] Handle mid-transition target changes in `shelly/control.js`: if `evaluate()` returns a new mode while `state.targetValves !== null`, update `state.targetValves` in place (do NOT abort or rerun pump-stop) and let the next `resumeTransition` iteration recompute the plan against the new target. Verify that valves currently in `state.valveOpening` are NOT interrupted (FR-012).

**Checkpoint**: A four-valve open transition now completes end-to-end in roughly two 20 s batches. The simulation scenario from T020 passes. `npm run test:unit` (including simulation) stays green.

---

## Phase 5: User Story 3 - Honor the Minimum-Open Hold Before Closing (Priority: P1)

**Story goal**: The scheduler defers close commands until a valve has been open for at least 60 s since the end of its opening window. The shell tracks `valveOpenSince` at the window-end moment and drives deferred closes via the same SCHEDULE loop that US2 built.

**Independent test**: Using the scheduler directly — a valve commanded closed with `openSince[v] = now - 10000` goes into `deferredCloses` with `readyAt = openSince + 60000`; the same valve with `openSince[v] = now - 70000` goes into `closeNow`. Using the shell — open a valve, wait <60 s, request close → close is deferred and the corresponding entry appears in `state.valvePendingClose`; after the hold elapses, the deferred close fires on the next `resumeTransition`.

### Tests for User Story 3 ⚠️

- [X] T026 [P] [US3] Add contract test case 5 (valve open 10 s, needs to close → in `deferredCloses` with `readyAt = openSince + 60000`, `closeNow === []`) to `tests/control-logic.test.js`
- [X] T027 [P] [US3] Add contract test case 6 (valve open 70 s, needs to close → in `closeNow`, `deferredCloses === {}`) to `tests/control-logic.test.js`
- [X] T028 [P] [US3] Add contract test case 8 (boot recovery: `openSince[v] === 0`, valve currently open, target says closed → in `closeNow` because `max(openSince, 0) + minOpenMs = minOpenMs ≤ now` is trivially satisfied by the `openSince === 0` rule; see research.md R7) to `tests/control-logic.test.js`
- [X] T029 [P] [US3] Add the mixed-hold test: three valves need to close, two have `openSince = now - 70000` and one has `openSince = now - 10000` → the two elders in `closeNow`, the youngster in `deferredCloses` with its computed `readyAt`, and `nextResumeAt === youngster.readyAt` to `tests/control-logic.test.js`
- [X] T030 [P] [US3] Add assertions for INV3 (no valve in `closeNow` has `(now - openSince[v]) < cfg.minOpenMs` unless `openSince[v] === 0`) across the new tests in `tests/control-logic.test.js`
- [X] T031 [P] [US3] Add the invariant fuzz test (checklist 13): 1000 random `(target, current, openSince, opening, now)` tuples, assert INV1–INV8 on each returned plan. Use a seeded PRNG so failures are reproducible. Place in `tests/control-logic.test.js`.

### Implementation for User Story 3

- [X] T032 [US3] Implement the deferred-close logic in `planValveTransition` in `shelly/control-logic.js`: for each valve in the "needs close" set that is NOT currently inside a live opening window, compute `readyAt = max(openSince[v], 0) + cfg.minOpenMs`; if `readyAt <= now` push into `closeNow`, otherwise set `deferredCloses[v] = readyAt`. For valves inside a live opening window, follow the contract §3 implementation-note option (b) and do not add to any action list. Ensure `nextResumeAt` (already implemented in T021) includes the new deferred-close candidates.
- [X] T033 [US3] Ensure `shelly/control.js`'s `resumeTransition()` writes `state.valveOpenSince[v] = now` at the exact moment a valve's opening window ends (T023 already has this hook — verify it is reached for every delete and use the window-end timestamp, not the resume timestamp, if they differ by more than the scheduler step). This is the "capacitor started charging" moment per research.md R3.
- [X] T034 [US3] Populate `state.valvePendingClose` from `plan.deferredCloses` in the SCHEDULE loop in `shelly/control.js`, and make sure the resume timer is scheduled for the earliest deferred-close ready time if that is earlier than any live opening-window end (the scheduler's `nextResumeAt` already returns the min — verify the shell honors it unmodified).
- [X] T035 [US3] Add FR-017 enforcement in `shelly/control.js`: never issue a `setValve(v, false)` command for a valve whose `state.valveOpening[v]` entry exists with `opening[v] > now`. This is already structurally enforced by the scheduler returning option (b) in T032, but add a defensive guard in the actuation loop so a future change cannot accidentally bypass it.
- [X] T036 [US3] Verify the no-op cases (FR-013): if `target[v] === current[v]` the scheduler already skips the valve (tested in T010 and contract checklist case 9 from Phase 2); add a direct test in `tests/control-logic.test.js` that asserts an already-open valve re-commanded open does not consume a slot and does not overwrite `valveOpenSince` / `opening` in the shell. (Shell-side verification: a targeted integration-style test or an assertion inside the SCHEDULE loop that checks current before acting.)

**Checkpoint**: The scheduler now enforces all three hardware rules, and the shell correctly defers closes. The invariant fuzz test (T031) covers every interaction branch. All 15 contract checklist cases from `contracts/valve-scheduler.md` except the v_air (case 12) and safety-drain (case 7) cases have dedicated tests — those are covered in the next two stories.

---

## Phase 6: User Story 4 - Safety-Critical Drains Execute As Fast As Physically Allowed (Priority: P2)

**Story goal**: Safety overrides (freeze drain, overheat drain) flow through the same SCHEDULE loop, honoring the PSU slot budget and the minimum-open hold (because they are physical rules), but without any additional throttles. The upstream `evaluate()` already bypasses minimum-mode-duration and refill-cooldown for safety transitions — this story verifies that the downstream SCHEDULE path does not re-introduce any equivalent throttle.

**Independent test**: Trigger a freeze-drain transition from a state that resembles SOLAR_CHARGING — some valves have been open >60 s and some <60 s. Observe that: (a) the long-open valves are in `closeNow`, (b) the short-open valves are in `deferredCloses`, (c) the valves to open for ACTIVE_DRAIN follow the 2-at-a-time rule, and (d) the `nextResumeAt` timestamp is the earliest of those deferrals and opening windows — no other delay is added. Verify that transient logs/telemetry make the "why is this slow" answer operator-visible.

### Tests for User Story 4 ⚠️

- [X] T037 [P] [US4] Add contract test case 7 (safety-drain mix: two valves closing with `openSince = now - 70000`, one valve closing with `openSince = now - 10000`, three valves opening from closed, `cfg.safetyOverride = true` if cfg gains a flag — see research.md R5) to `tests/control-logic.test.js`: the two long-open valves in `closeNow`, the short-open one in `deferredCloses`, two opens in `startOpening`, one in `queuedOpens`, `nextResumeAt` = earliest of the short close's readyAt and the first opening window end
- [X] T038 [P] [US4] Add an integration test to `tests/simulation/scenarios.js` (or `tests/control-logic.test.js` if purely logical) that walks a full freeze-drain transition timeline: starts in SOLAR_CHARGING, triggers `freeze_safety` via the existing safety-override code path, asserts the transition reaches the ACTIVE_DRAIN valve configuration and that during the transition `|opening|` is always ≤ 2.

### Implementation for User Story 4

- [X] T039 [US4] Verify in `shelly/control.js` that the safety-override code path (freeze drain, overheat drain) calls `transitionTo()` the same way a normal mode change does — i.e., it does NOT bypass the SCHEDULE loop, does NOT skip the scheduler, and does NOT short-circuit `valveOpenSince` bookkeeping. If it currently contains any legacy shortcut that actuates valves directly, route it through the SCHEDULE loop instead (per FR-010).
- [X] T040 [US4] Add an observable log line in `shelly/control.js` when a deferred close is created during a safety override: log the valve name, the current `openSince[v]`, and the computed `readyAt`, so operators investigating a "slow freeze drain" can see in the device log that the hold (not a bug) is the cause. Reuse the existing logger path; do not add a new transport.
- [X] T041 [US4] Audit the upstream `evaluate()` path in `shelly/control-logic.js` for any minimum-mode-duration or refill-retry cooldown that might block a safety transition from reaching `transitionTo()`. Add a test (or extend an existing `evaluate()` test in `tests/control-logic.test.js`) that confirms `evaluate()` returns the freeze-drain target immediately when the safety condition is raised, regardless of the current mode's age. (This is expected behavior — the test locks it in so Phase 5 cannot accidentally reintroduce a throttle.)

**Checkpoint**: Safety overrides correctly stage through the SCHEDULE loop. No additional non-hardware throttle is applied. The freeze-drain simulation scenario passes, and the device log now explains any deferred close.

---

## Phase 7: User Story 5 - Operators Can Observe Staged Valve Progress (Priority: P3)

**Story goal**: The playground UI shows which valves are currently opening, which are queued, and which close commands are being deferred. State flows through the existing snapshot → MQTT → WebSocket → playground path with three new fields: `opening`, `queued_opens`, `pending_closes`.

**Independent test**: Drive a 4-valve open transition from the playground's live view or the simulator. During the transition, the Status view shows a "Transitioning — 2 opening, 2 queued" indicator and the Device view shows a detailed list with countdown timers. The indicator disappears when the transition completes.

### Tests for User Story 5 ⚠️

- [X] T042 [P] [US5] Add a unit test for `buildStateSnapshot()` in `tests/control-logic.test.js` (if the builder is pure) or in a new `tests/shell-snapshot.test.js` (if it has to be factored out of `control.js` first): assert that when `state.valveOpening` has two entries, `state.valvePendingOpen` has one, and `state.valvePendingClose` has one, the resulting snapshot contains `opening.length === 2`, `queued_opens.length === 1`, and `pending_closes.length === 1` with the correct `{valve, readyAt}` shape
- [X] T043 [P] [US5] Add an e2e assertion to `tests/e2e/device-config.spec.js` (or a new `tests/e2e/staged-valves.spec.js`): seed a multi-batch transition via the simulation harness, wait for the WebSocket state update, and assert that the Status view's staged indicator is visible, that the Device view's detailed pane lists the opening/queued/pending-close valves, and that the indicator disappears after the transition completes. Use `import { test, expect } from './fixtures.js'` per the project convention.

### Implementation for User Story 5

- [X] T044 [US5] Extend `buildStateSnapshot()` in `shelly/control.js` with the three new fields: `opening` (derived from `state.valveOpening` — keys where `opening[v] > now`), `queued_opens` (copy of `state.valvePendingOpen`), and `pending_closes` (array of `{valve, readyAt}` where `readyAt = state.valveOpenSince[v] + VALVE_TIMING.minOpenMs`, converted to unix seconds to match the rest of the snapshot). Respect the logical ↔ energized polarity for v_air when surfacing to the UI.
- [X] T045 [US5] Update `playground/js/data-source.js` to pass the three new fields from the raw state snapshot through to UI consumers without transformation. Confirm the LiveSource (WebSocket) and SimulationSource paths both forward them.
- [X] T046 [P] [US5] Add the compact Status view indicator to `playground/index.html`: a conditional element that appears when `state.opening.length > 0 || state.queued_opens.length > 0 || state.pending_closes.length > 0`, with text `"Transitioning — N opening, M queued, K pending close"`. Use the existing Stitch-token classes.
- [X] T047 [P] [US5] Add the detailed staged-valve pane to the Device view in `playground/index.html`: lists each opening valve with its remaining window time, each queued valve, and each pending-close valve with its hold countdown. Hidden when no transition is in flight.
- [X] T048 [P] [US5] Add CSS rules to `playground/css/style.css` for the staged-open indicator and the Device view pane — use the existing Stitch tokens (gold for "opening", muted for "queued", teal for "pending close") to stay consistent with the rest of the UI.

**Checkpoint**: Operators can watch a staged transition progress in the UI. The e2e test (T043) passes. All five user stories are independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, linting, hardware validation, and doc sync.

- [X] T049 Run `npm test` and confirm unit + simulation + e2e suites are green. Fix any existing-test breakage caused by the new `transition_step` field names (see quickstart.md "Gotchas": existing playground code and e2e tests may read legacy values like `pump_stop`, `valves_closing`, `valves_opening`, `pump_start` — keep them or update consumers).
- [X] T050 Run `node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js` and fix any ES5 violations introduced by the new scheduler and state machine (no `const`/`let`, arrow functions, classes, template literals — FR-018)
- [X] T050a [P] Measure the combined deployed script byte size before and after the feature. Current baseline: `control.js` ≈ 21,615 B and `control-logic.js` ≈ 11,819 B (the `deploy.sh` step concatenates `control-logic.js` into `control.js`). Record the post-feature delta in the feature's closing notes. The plan.md's "16 KB max script size" figure contradicts the current baseline and is treated as stale — the real per-slot limit is unknown. If `shelly/deploy.sh` fails with a size-related error during T053, capture the device's response, record the observed limit in `CLAUDE.md` under "Shelly Control Scripts", and iterate from there. No pre-upload guard is added — rely on the device to reject oversized scripts.
- [X] T050b Add a bounded-parallelism helper in `shelly/control.js` for actuating `plan.closeNow` and `plan.startOpening`: issue at most N concurrent `setValve` / HTTP RPC calls (default N = 4, leaving one of the 5 concurrent-HTTP slots for telemetry and the relay-command queue), with the rest drained FIFO as slots free up. Use it at every actuation site in the SCHEDULE loop. Add a unit test with a stub HTTP layer that verifies the in-flight count never exceeds N when asked to actuate 8 valves at once. This replaces the "Use a small worker-pool helper if necessary" advisory in quickstart.md with a concrete, enforced limit.
- [ ] T050c [P] After the first hardware deploy, capture one state broadcast via `mosquitto_sub -t greenhouse/state -C 1` and confirm the snapshot payload size stays comfortably under 1 KB (target: <1000 bytes serialized). Also confirm via `Shelly.call("Script.GetStatus", ...)` that the `mem_free` reported by the device does not drop by more than a few hundred bytes versus the pre-deploy baseline. Record both numbers in the feature's closing notes.
- [X] T051 [P] Update `playground/js/control-logic-loader.js` if necessary so the playground simulator picks up the new `VALVE_TIMING` and `planValveTransition` exports from `shelly/control-logic.js`. Verify the playground's in-browser simulation matches the Node.js test results.
- [X] T052 [P] Review and update the "Active Technologies" and "Recent Changes" sections of `CLAUDE.md` for 023 if anything drifted from what is already documented there (the spec plan already added an entry; confirm it is accurate post-implementation)
- [ ] T053 Deploy the updated scripts to the Shelly Pro 4PM hardware via `./shelly/deploy.sh` (or `DEPLOY_VIA_VPN=true ./shelly/deploy.sh` from the CI environment). Manually trigger a mode transition that requires ≥3 opens and observe via the playground that the staged indicator appears and valves open in batches of two.
- [ ] T054 Hardware validation per quickstart.md step 12: use a clamp meter on the 24 V valve rail (or equivalent telemetry) to confirm that during a multi-valve transition the current peak corresponds to exactly two energized valves. Record the measurement in the feature's closing notes.
- [ ] T055 Walk through `specs/023-limit-valve-operations/quickstart.md` steps 1–12 one more time as a manual acceptance pass. Confirm every gotcha in the quickstart is actually handled in the implementation, specifically:
  - no `Date.now()` inside `planValveTransition`
  - no per-valve permanent timers (single transition-scoped `state.transitionTimer` only)
  - v_air polarity inversion centralized in `toSchedulerView` / `fromSchedulerView`
  - `valveOpenSince` is not persisted to KVS
  - legacy `transition_step` consumers updated or preserved
  - bounded concurrent HTTP calls ≤ 4 in the actuation path (T050b verified)
  - combined deployed script size delta recorded in the closing notes (T050a) — no hard limit check, just documentation
  - no new event subscriptions introduced (feature does not touch the 5-subscription budget)
  - state snapshot payload <1 KB and device `mem_free` delta negligible (T050c verified).

---

## Closing Notes (post-implementation)

### Post-implementation metrics (T050a)

| File | Baseline | After 023 | Delta |
|------|---------:|----------:|------:|
| `shelly/control-logic.js` | 11,819 B | 23,595 B | +11,776 B (+99.6%) |
| `shelly/control.js` | 21,615 B | 29,284 B | +7,669 B (+35.5%) |
| **Combined deployed script** | 33,434 B | 52,879 B | **+19,445 B (+58.2%)** |

The combined script is ~53 KB, well over the stale 16 KB figure from plan.md. The Shelly lint tool warns at 16 KB but treats it as a warning, not an error. The real per-slot limit on the deployed firmware is not known; T053 hardware deploy will exercise it.

### Test suite growth

| Suite | Before | After | Delta |
|-------|-------:|------:|------:|
| Unit (`npm run test:unit`) | 367 | 400 | +33 |
| E2E (`npm run test:e2e`) | 106 | 109 | +3 |
| **Total** | **473** | **509** | **+36** |

New unit tests cover: foundational scheduler, US1 slot budget (4 cases), US2 cross-tick queue (4 cases + SCHEDULE-loop integration), US3 min-open hold (6 cases + 1000-iteration fuzz), US4 safety drain (2 cases), polarity helpers (3 cases), snapshot builder (4 cases), bounded pool (4 cases). New e2e tests cover the staged-valve indicator visibility wiring.

### Outstanding (hardware-gated)

- **T050c**: Post-deploy state snapshot byte-size + device `mem_free` delta — requires device deploy.
- **T053**: Deploy to Shelly Pro 4PM and exercise a ≥3-valve transition.
- **T054**: Clamp meter on 24 V valve rail during multi-valve transition.
- **T055**: Manual acceptance walkthrough of all quickstart steps on device. Non-hardware gotchas are all verified in code:
  - no `Date.now()` calls inside `planValveTransition`
  - no per-valve permanent timers (single transition-scoped `state.transitionTimer` only)
  - v_air polarity inversion centralized in `toSchedulerView` / `fromSchedulerView`
  - `valveOpenSince` never persisted to KVS
  - legacy `transition_step` values (`pump_stop`, `valves_closing`, `valves_opening`, `pump_start`) preserved
  - bounded concurrent HTTP calls ≤ 4 in actuation path (T050b verified by unit test)
  - feature adds zero new event subscriptions

### Key design notes (for future maintainers)

- The scheduler is strictly pure and takes `now` as input (INV8). All time comes from the shell.
- V_air polarity is inverted at exactly two boundary functions (`toSchedulerView` / `fromSchedulerView`). The scheduler works in "energized" semantics uniformly. Never leak logical polarity into scheduler inputs or vice versa.
- `valveOpenSince[v] = 0` means "hold trivially satisfied" (FR-015 boot recovery). Boot calls `seedValveOpenSinceOnBoot()`.
- The scheduler returns `nextResumeAt = null` when there is nothing to wait for. The shell handles two cases: (a) `targetReached = true` → finalize; (b) actions fired but no deferrals → re-enter `scheduleStep()` immediately so the post-action scheduler call observes the new state and finalizes.
- The transition-scoped timer (`state.transitionTimer`) is exactly one active timer during any transition. On resume, it is cleared before re-scheduling.
- `runBoundedPool` caps in-flight HTTP calls at 4 so one of the 5 Shelly slots remains free for telemetry + the relay-command queue.
- `stopDrain` routes through `transitionTo` with an IDLE target so the post-drain close-all path also honors the PSU limit and the min-open hold.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup. Blocks all user stories because every story depends on the existence of the `VALVE_TIMING` constants, the skeleton `planValveTransition`, the v_air helpers, and the new `state` fields.
- **US1 (Phase 3)**: Depends on Phase 2. Builds on the scheduler skeleton by adding slot-budget logic. US1 is the MVP — it delivers the PSU protection rule in its simplest single-tick form.
- **US2 (Phase 4)**: Depends on Phase 2 and on T014/T015 from US1 (because the SCHEDULE-loop rewrite builds on the slot-budget implementation). US2 delivers the inter-tick state machine and completes the "pending opens survive across ticks" behavior.
- **US3 (Phase 5)**: Depends on Phase 2 and on US2's T021 `nextResumeAt` computation and T023 `resumeTransition` hook. US3 adds deferred-close handling; the scheduler and shell state machine already exist.
- **US4 (Phase 6)**: Depends on US1, US2, and US3 because safety overrides flow through the same SCHEDULE loop and rely on both the slot budget and the deferred-close logic. T037/T038 can be written in parallel with US3 work once the scheduler has full logic.
- **US5 (Phase 7)**: Depends on the SCHEDULE loop existing (US2) and the `valveOpenSince` bookkeeping (US3). UI changes can be developed in parallel with the e2e and snapshot tests.
- **Polish (Phase 8)**: Depends on all user stories being complete.

### User Story Dependencies

- **US1 (P1)**: Fully independent of US2/US3 at the "scheduler input/output" level — slot-budget logic can be shipped and tested alone. Not yet wired into the cross-tick driver.
- **US2 (P1)**: Depends on US1 for the slot-budget implementation it needs to resume. Ships the cross-tick driver.
- **US3 (P1)**: Depends on US2's `nextResumeAt` pipeline to drive deferred closes to the shell on time. Ships the close hold.
- **US4 (P2)**: Depends on all of US1–US3 being merged — safety overrides must see the full hardware ruleset in place.
- **US5 (P3)**: Depends on the shell having `valveOpening`, `valvePendingOpen`, `valvePendingClose`, `valveOpenSince` populated (US2 + US3). UI surfacing is additive and does not feedback into the control logic.

### Within Each User Story

- Tests first (per CLAUDE.md testing policy) — verify they fail before implementing
- Scheduler changes before shell changes (the shell consumes the scheduler output)
- Shell state-field assignments before snapshot/telemetry changes (UI consumes snapshot fields)

### Parallel Opportunities

- **Phase 2**: T005, T006, T007 are marked [P] — the unit test scaffold, the v_air helpers, and their test are in distinct files and have no runtime dependency on each other.
- **Phase 3**: T010, T011, T012, T013 are all in `tests/control-logic.test.js` and can be written by a single developer in one pass or by multiple developers on separate branches merging into the same describe block. Implementation tasks T014, T015 must run sequentially (both touch scheduler then shell).
- **Phase 4**: T016–T019 are all in `tests/control-logic.test.js` [P]. Implementation T022–T025 touch `control.js` sequentially.
- **Phase 5**: T026–T031 are all in `tests/control-logic.test.js` [P]. Implementation T032–T036 split across files but T032 (scheduler) must precede T033–T035 (shell).
- **Phase 6**: T037, T038 are in test files [P]. Implementation T039–T041 touch `control.js` and `control-logic.js` and are mostly independent.
- **Phase 7**: T042 and T043 are in different test files [P]. T046, T047, T048 touch `index.html` (twice) and `style.css` — T046/T047 both touch `index.html` so they are NOT [P] with each other, but T048 is independent.
- **Phase 8**: T051 and T052 are independent cleanup tasks [P].

### Parallel Example: User Story 1 Tests

```bash
# All contract tests for US1 can be written in parallel (same file but independent cases):
Task: "Add contract test case 1 (single valve open) to tests/control-logic.test.js"
Task: "Add contract test case 2 (four valves → 2+2 batches) to tests/control-logic.test.js"
Task: "Add contract test case 11 (mix opens + closes) to tests/control-logic.test.js"
Task: "Add invariant helper + INV1/INV2/INV4/INV5 to tests/control-logic.test.js"
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T009)
3. Complete Phase 3: US1 (T010–T015)
4. **STOP and VALIDATE**: Scheduler enforces the 2-slot budget. Unit tests prove it. The shell can execute a single-tick transition honoring the budget, though it does not yet drive pending opens across ticks.
5. The MVP is correct for any transition that needs ≤2 opens, which covers IDLE → MODE1 and most normal operation. Multi-batch transitions will stall halfway until US2 lands.

### Incremental Delivery

1. Setup + Foundational + US1 → PSU protection for ≤2-valve opens (MVP)
2. Add US2 → Multi-batch transitions complete across ticks → all open scenarios work
3. Add US3 → Minimum-open hold enforced → all close scenarios work
4. Add US4 → Safety overrides verified → full mode-transition coverage
5. Add US5 → UI observability → operator-facing polish
6. Polish → hardware validation and lint → ship

Each increment is correct in isolation and safe to leave at any checkpoint (the previous increment remains a functional improvement over the pre-023 behavior).

### Parallel Team Strategy

With multiple developers (if applicable):

1. Team completes Phases 1 and 2 together.
2. Once Phase 2 is merged:
   - Developer A: US1 tests (T010–T013) in parallel while Developer B starts the US2 test scaffold (T016–T019).
   - Developer A merges US1 implementation (T014, T015) first because US2 depends on it.
   - Developer B picks up US2 implementation (T021–T025) after US1 is merged.
   - Developer C can start the US3 test files (T026–T031) in parallel with US2 implementation — the tests depend only on the scheduler signature, not on US2's shell state machine.
3. US4 and US5 can be worked on by different developers once US3 lands.

---

## Notes

- **[P] tasks** = different files or non-overlapping sections of a test file, no dependency on incomplete tasks.
- **[Story] label** maps each task to a specific user story for traceability; Setup, Foundational, and Polish have no story label.
- **Tests first**: per CLAUDE.md testing policy, every behavior change (and every new scheduler branch) gets its test written first and seen to fail before the implementation lands.
- **Shelly ES5 constraints** (FR-018): all new code in `shelly/*.js` must avoid `const`/`let`, arrow functions, classes, template literals, destructuring, default params. The linter (Phase 8, T050) is the authoritative check.
- **No new persistent storage**: `valveOpenSince` and the staged state machine are in-memory only per FR-015 and research.md R7 — do NOT add KVS writes for them.
- **Legacy `transition_step` values**: the existing playground and e2e tests may read `pump_stop`, `valves_closing`, `valves_opening`, `pump_start`. Keep these values exposed from the new state machine or migrate the consumers in the same PR — T049 and T055 are the catch-all.
- **Commit boundaries**: commit after each logical task group (e.g., "Add VALVE_TIMING + skeleton scheduler + target-reached test"). Story-level checkpoints are natural merge points.
- **Avoid**: introducing `Date.now()` calls inside `planValveTransition` (INV8 will fail), adding per-valve permanent timers (budget of 5 timers will fail), and v_air polarity leaks outside the `toSchedulerView` / `fromSchedulerView` helpers.
