# Drain exit — close valves first, then stop pump

**Date:** 2026-04-19
**Status:** Design approved, pending user review
**Author:** Brainstormed with Claude Code

## 1. Overview

Reverse the exit sequence for `ACTIVE_DRAIN` mode. Every other mode keeps the default "stop pump first, then actuate valves" safety ordering. On exit from `ACTIVE_DRAIN`, close the valves while the pump keeps running, wait 20 s, then stop the pump.

`ACTIVE_DRAIN` is entered for two reasons, both covered by this change:
- **Freeze protection** — `t_outdoor < freezeDrainTemp` drains the collectors to prevent freeze damage.
- **Overheat drain** — `t_collector > overheatDrainTemp` while solar charging can't keep up; drain prevents boiling in the open system.

Both enter the same `MODES.ACTIVE_DRAIN` state in the controller, so the fix is a single branch in `transitionTo()`.

## 2. Motivation

During `ACTIVE_DRAIN` the pump draws water from the collector bottom (`vi_coll` open), pushes it to the tank (`vo_tank` open), while air replaces the draining water through the collector-top vent (`v_air` open). When the collectors are empty, the pump starts drawing air and the drain monitor detects the drop in power (`< 20 W` for 3 × 200 ms) and exits the mode.

Currently the exit is: stop pump → 1 s settle → close valves. This leaves a small volume of water in the piping between `vi_coll`, the pump, and `vo_tank`. When those valves close around it, the water is trapped in the manifold and can freeze.

The new sequence lets the pump continue pushing residual water toward the tank while the valves close. The 20 s post-close wait gives the pump time to evacuate the piping before it stops.

## 3. Scope

### In scope

- Every exit from `MODES.ACTIVE_DRAIN`:
  - Normal drain end — `stopDrain("dry_run")` (pump power drop detected).
  - Safety timeout — `stopDrain("timeout")` (180 s elapsed without dry-run detection).
  - Watchdog auto-shutdown while draining.
  - User-initiated shutdown (config-driven `wb` update) while draining.
  - Safety override in `evaluate()` while draining (e.g. sensor goes stale).
- Update `system.yaml` `active_drain.sequence` step 8 and the `CLAUDE.md` safety-rule paragraph that describes the pump-first convention.

### Out of scope

- No change to the drain-entry sequence. Entry keeps the default "stop pump → actuate valves → start pump" path, which is already correct (pump must not run while collectors are empty or valves are transitioning).
- No change to `DRAIN_POWER_THRESHOLD` (20 W), `DRAIN_MONITOR_INTERVAL` (200 ms), or `drainTimeout` (180 s).
- No playground simulator changes. The simulator tracks decision-level state, not intra-transition timing.

## 4. Design

### 4.1 Control-flow change

`shelly/control.js` today:

```
transitionTo(result):
  setActuators({pump:false, fan:false, heaters:false})
    → wait VALVE_SETTLE_MS (1 s)
    → scheduleStep()  // close/open valves in staged plan
    → finalizeTransitionOK:
       wait PUMP_PRIME_MS (5 s)
       → setActuators(result.actuators)
       → done
```

New behavior, only when `state.mode === MODES.ACTIVE_DRAIN`:

```
transitionTo(result):
  // skip the initial setActuators — pump keeps running
  → scheduleStep()  // close valves while pump still runs
  → finalizeTransitionOK:
     wait DRAIN_EXIT_PUMP_RUN_MS (20 s, pump still running)
     → setActuators(result.actuators)  // this is where the pump finally stops
     → done
```

### 4.2 Implementation

**`shelly/control.js`**

1. Add `SHELL_CFG.DRAIN_EXIT_PUMP_RUN_MS = 20000`.

2. Add `state.transitionFromMode` (new field, captured at `transitionTo` entry, cleared in both finalize paths alongside the other transition fields). Needed because `state.mode` gets overwritten to the target mode inside `finalizeTransitionOK` before the wait timer fires, so the finalize step can't read it back.

3. In `transitionTo(result)` entry:
   - Before setting `state.transitioning = true`, capture `state.transitionFromMode = state.mode`.
   - If `state.transitionFromMode === MODES.ACTIVE_DRAIN`, skip the `setActuators({...false})` + `VALVE_SETTLE_MS` timer and call `scheduleStep()` directly (after the existing `drain_timer` clear).
   - Emit a state update before calling `scheduleStep()` so the UI sees the new `transition_step` immediately.
   - Otherwise keep the current path.

4. In `finalizeTransitionOK(result)`:
   - Replace the hard-coded `SHELL_CFG.PUMP_PRIME_MS` with:
     ```js
     var postValveWaitMs = (state.transitionFromMode === MODES.ACTIVE_DRAIN)
       ? SHELL_CFG.DRAIN_EXIT_PUMP_RUN_MS
       : SHELL_CFG.PUMP_PRIME_MS;
     ```
   - Clear `state.transitionFromMode = null` alongside the other transition state resets.

5. In `finalizeTransitionFail()`:
   - Clear `state.transitionFromMode = null`.
   - Hardware-failure path remains immediate: `setPump(false)`, set IDLE, clear state. No 20 s wait.

6. `transition_step` labels:
   - Keep `"pump_stop"` / `"valves_opening"` / `"pump_start"` unchanged for UI compatibility. The playground reads these values in a few places and renaming would require coordinated changes. The underlying semantics during `"pump_start"` are "post-valve wait", which is already slightly abused for normal transitions.

### 4.3 Valve-close failure handling

`setValve()` already retries once on HTTP failure (line 172-187 in `control.js`). When the retry also fails, `setValve` returns `cb(false)`, `setValves` triggers `finalizeTransitionFail()`, which calls `setPump(false)` immediately and transitions to IDLE. This is the correct behavior: on confirmed hardware failure during drain-exit, stop the pump without waiting.

No new retry logic is added — the existing one-retry behavior covers the user's requirement.

### 4.4 Edge cases

- **Pump already off when entering `transitionTo`.** Possible if the drain monitor detected dry-run and the pump stopped at the motor before `stopDrain` was called. The 20 s wait still runs, but `setActuators({pump:false, ...})` at the end is a no-op for the pump. Harmless.
- **Transition target changed mid-flight.** The existing in-flight guard at `transitionTo` line 691-700 allows `targetValves` / `targetResult` to be replaced. Does not change the already-captured `transitionFromMode` — so even if the target is updated, the exit-from-drain sequencing stays in effect, which is correct.
- **Manual override arrives during the 20 s wait.** Manual override works via the relay-command queue (`handleRelayCommand`), independent of the transition state machine. If a user pokes a relay during the wait, the transition continues as planned; the relay command applies on top. This matches existing behavior for normal transitions and is not a regression.
- **Watchdog fires during the 20 s wait.** Watchdog runs in `controlLoop`, which is skipped while `state.transitioning` is true. The wait-to-IDLE completes first, then the watchdog evaluates against the new IDLE mode, which has no watchdog baseline. No interaction to worry about.

## 5. Documentation updates

### 5.1 `system.yaml` — `active_drain.sequence`

Rewrite step 8 (currently `"Power drops below threshold → stop pump → close all valves"`) to:

```yaml
- step: 8
  action: >
    Power drops below threshold → close all valves → wait 20 s → stop pump.
    Exception to the stop-pump-first rule: keeps the pump pushing residual
    water out of the manifold piping while the valves seal, so water is not
    trapped between closed valves (where it could freeze in the freeze-drain
    case).
```

`overheat_drain` inherits via its existing `"sequence: same as active_drain"` reference — no text change needed there.

### 5.2 `CLAUDE.md` — "Safety: stop pump BEFORE switching valves"

Add a sentence to the existing paragraph naming the one real exception:

> Generally true, enforced by `transitionTo()` in `shelly/control.js` (stops pump/fan/heaters, then actuates valves). **The one named exception is exit from `ACTIVE_DRAIN`**, which reverses the order (close valves → wait 20 s → stop pump) so the pump evacuates residual water from the manifold before the valves seal. Don't simplify the transition scheduler assuming pump-first is always safe.

## 6. Testing

Per the project testing policy (test-first for behavior changes), add tests before implementing:

1. **Ordering: exit from `ACTIVE_DRAIN`.** Using the existing Shelly runtime mock (as in `tests/shelly-stability.test.js`), drive `transitionTo(idleResult)` with `state.mode = ACTIVE_DRAIN`. Assert that valve HTTP commands are issued before `Switch.Set` for pump id 0 with `on: false`, and that the pump-off `Switch.Set` is scheduled at least 20 s after the last valve-close HTTP command.

2. **Ordering: exit from other modes is unchanged.** Drive `transitionTo(idleResult)` with `state.mode = SOLAR_CHARGING`. Assert that `Switch.Set` for pump `on: false` is issued before any valve HTTP command.

3. **Failure path.** Make the mock reject valve HTTP commands (both primary and retry). Assert that the pump is stopped immediately via `setPump(false)` (no 20 s delay) and state transitions to IDLE.

4. **Simulation smoke.** Run the existing simulation harness through a freeze-drain cycle and confirm the end state matches expectations (pump off, all valves closed, mode IDLE). This already exists — just confirm the assertion holds after the change.

Shell-level tests for ordering are new to this project. Following existing testing principles means extending the `createShellyRuntime` helper in `tests/shelly-stability.test.js`, or placing the new tests in a sibling file using the same runtime-mock pattern.

## 7. Risks

- **Dry-running the pump longer.** After `dry_run` detection, the pump will continue running for up to `valve-close time` + 20 s (≈ 22-25 s total) instead of the current `~1 s`. Circulation pumps of this class tolerate brief dry-running, but the new window is longer than the current one. If real-world use surfaces pump-wear symptoms, `DRAIN_EXIT_PUMP_RUN_MS` can be shortened later. Worth re-checking the pump's datasheet dry-run tolerance before merging.
- **Regression of the pump-first safety convention.** Mitigated by the explicit branch keyed on `MODES.ACTIVE_DRAIN` and by the second test asserting non-drain exits still stop pump first.

## 8. Non-alternatives considered

- **Move the 20 s wait to `evaluate()` / decision layer.** Rejected: the decision layer is pure and has no concept of timers or actuators. Exit orchestration belongs in the shell.
- **Add a config knob for the 20 s duration.** Rejected for v1: matches how other drain timings are handled (shell constants, not device-config).
- **Split `ACTIVE_DRAIN` into separate `FREEZE_DRAIN` / `OVERHEAT_DRAIN` modes.** Rejected: they use identical valve states and the same exit sequence. Splitting would add code churn without behavior benefit.
