# Quickstart: Limit Concurrent Valve Operations

**Feature**: 023-limit-valve-operations

## Prerequisites

- Node.js 20 LTS
- Existing dev environment (`npm install` completed)
- Familiarity with: Shelly ES5 scripting constraints, the pure/IO split in `control-logic.js` ↔ `control.js`, the existing `transitionTo` state machine in `control.js`, the `buildStateSnapshot` → MQTT → WebSocket → playground data flow
- Read: [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/valve-scheduler.md](./contracts/valve-scheduler.md)

## Key Files to Modify

### Pure control logic (ES5 only — concatenated into the deployed Shelly script)

- `shelly/control-logic.js`
  - Add `VALVE_TIMING` constant block (see data-model.md).
  - Add `planValveTransition(target, current, openSince, opening, now, cfg)` pure function (see contracts/valve-scheduler.md).
  - Export both from the `module.exports` block at the end of the file (guarded by `typeof module !== "undefined"`).

### Shelly device shell (ES5 only)

- `shelly/control.js`
  - Add new timing-state fields to the `state` object: `valveOpenSince`, `valveOpening`, `valvePendingOpen`, `valvePendingClose`, `targetValves`, `transitionTimer`.
  - Initialize `valveOpenSince[v] = 0` and clear opening/pending maps on boot.
  - Rewrite `transitionTo(result)` so that, after the initial pump-stop + VALVE_SETTLE_MS wait, it enters a SCHEDULE step that:
    1. Sets `state.targetValves = result.valves`.
    2. Calls `planValveTransition(target, currentValves, openSince, opening, now, VALVE_TIMING)`.
    3. Executes `plan.closeNow` via parallel `setValve(v, false)` calls.
    4. Executes `plan.startOpening` via parallel `setValve(v, true)` calls and writes `valveOpening[v] = now + openWindowMs` for each.
    5. Writes `plan.queuedOpens` into `valvePendingOpen`.
    6. Writes `plan.deferredCloses` into `valvePendingClose`.
    7. If `plan.targetReached === true`, proceed to PUMP_PRIME → RUNNING.
    8. Else `Timer.set(plan.nextResumeAt - now, false, resumeTransition)` into `state.transitionTimer`.
  - Add `resumeTransition()`:
    - Clears the transition timer.
    - Walks `valveOpening`, deletes entries where `opening[v] <= now`, and for each deleted entry writes `valveOpenSince[v] = now` (the window-end moment).
    - Re-invokes SCHEDULE step with the fresh state.
  - Handle the v_air polarity at the scheduler boundary:
    - Translate logical `target.v_air` to the energized form before calling `planValveTransition` **OR** apply the inversion when reading `current` and writing `opening` / `openSince`. Chosen form: add a small helper `toSchedulerView(valves)` / `fromSchedulerView(valves)` that swaps v_air, so `planValveTransition` sees "energize/de-energize" semantics uniformly.
  - Extend `buildStateSnapshot()` with the three new fields: `opening`, `queued_opens`, `pending_closes`.
  - Ensure `state.transitioning` remains `true` across the staged transition (from PUMP_STOP through PUMP_PRIME) so the control loop continues to skip while valves are being marshalled.

### Playground UI

- `playground/index.html`
  - In the Status view: add a compact indicator that appears when `state.opening.length > 0 || state.queued_opens.length > 0 || state.pending_closes.length > 0`. Format: "Transitioning — N opening, M queued, K pending close".
  - In the Device view: add a detailed pane listing each opening valve, each queued valve, and each pending-close valve with its countdown. Hidden when no transition is in flight.
- `playground/js/data-source.js`
  - Pass the new `opening`, `queued_opens`, `pending_closes` fields through from the raw state snapshot to the UI without transformation (they are already in the right shape).
- `playground/css/style.css`
  - Style the staged-open indicator using Stitch design tokens already in use (gold for "opening", muted for "queued", teal for "pending close").

### Tests

- `tests/control-logic.test.js`
  - Add a new `describe('planValveTransition', ...)` block covering all 15 cases listed in [contracts/valve-scheduler.md](./contracts/valve-scheduler.md) "Test coverage checklist".
  - Add assertions for invariants INV1–INV8.
- `tests/simulation/scenarios.js`
  - Add a new scenario "Transition that opens 4 valves takes ~45 s" that asserts wall-clock behavior of a staged transition.
- `tests/e2e/device-config.spec.js`
  - Add a test that seeds a mode transition via simulation, captures the state broadcast, and asserts the playground Status view shows the staged-open indicator.

## Development Flow

Following the project's test-first policy (see `CLAUDE.md` Testing Policy):

1. **Write the scheduler contract tests first**. Add `describe('planValveTransition', ...)` to `tests/control-logic.test.js` with the 15 cases from the contract. Run `npm run test:unit` — they must fail (the function does not exist yet).
2. **Implement `VALVE_TIMING` and `planValveTransition` in `control-logic.js`**. Add the exports. Re-run `npm run test:unit` — all scheduler tests should pass.
3. **Add the invariant fuzz test**. 1000 random input configurations, assert INV1–INV8. This catches any edge case the enumerated tests missed.
4. **Rewrite `transitionTo` in `control.js`**. Start from the current linear sequence and split it into PUMP_STOP → SCHEDULE → SCHEDULE (repeat) → PUMP_PRIME → RUNNING. Add the `resumeTransition` helper.
5. **Add the v_air polarity translation helpers**. Write a pair of small test cases that round-trip a valve map through `toSchedulerView` / `fromSchedulerView` and verify v_air is inverted but all others are identity.
6. **Extend `buildStateSnapshot`** with the three new fields and confirm via a unit test on the (pure) snapshot-builder portion.
7. **Add the simulation scenario**. Assert that a 4-valve transition reaches the target in the expected wall-clock envelope.
8. **Add the e2e test** for the playground indicator.
9. **Run the full test suite**: `npm test`. Ensure no existing tests break (the current e2e `transition_step` assertions may need to be relaxed or updated to accept the new state-machine step names).
10. **Lint the Shelly code**: `node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js`. Fix any ES5 violations.
11. **Deploy to device** for real-hardware validation: `./shelly/deploy.sh`. Manually trigger a mode transition that requires ≥3 opens and observe via the playground that the staged indicator appears and valves open in batches.
12. **Measure on hardware**. Use a multimeter on the 24 V PSU output or a clamp meter on the valve rail to confirm the current peak corresponds to exactly 2 energized valves during a multi-valve transition.

## Key Commands

```bash
# Fast feedback loop
npm run test:unit

# Scheduler tests only
node --test tests/control-logic.test.js

# Full suite (unit + simulation + e2e)
npm test

# Shelly ES5 lint
node shelly/lint/bin/shelly-lint.js shelly/control-logic.js shelly/control.js

# Deploy to Shelly hardware
./shelly/deploy.sh
```

## Gotchas

- **Do not call `Date.now()` inside `planValveTransition`**. The function must be pure. The shell passes in `now`.
- **Do not hold a permanent Timer for deferred closes**. The 5-timer budget is tight. Use the transition-scoped `state.transitionTimer` that is rescheduled on each resume.
- **Do not forget the v_air inversion**. Every read of `current[v_air]` from physical state and every write of `opening[v_air]` / `openSince[v_air]` must reflect "energized" semantics, not "logical open" semantics. Put the inversion in one place.
- **Do not persist `valveOpenSince` to KVS**. FR-015 explicitly permits the reboot simplification. Writing on every state change would increase KVS wear for no real benefit.
- **Do not break the existing `transition_step` field**. Existing playground code and possibly e2e tests may read this. Keep the legacy values (`pump_stop`, `valves_closing`, `valves_opening`, `pump_start`) or migrate the consumers.
- **Shelly HTTP RPC parallelism**: The "close in parallel" step must respect the Shelly limit of 5 concurrent HTTP calls per script. Closing 8 valves in parallel is safe (8 distinct hosts, one call each) but the caller code path must not accidentally spawn more than 5 truly-concurrent in-flight requests from the Pro 4PM script. Use a small worker-pool helper if necessary.
