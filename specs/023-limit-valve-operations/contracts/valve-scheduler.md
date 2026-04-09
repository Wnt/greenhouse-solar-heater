# Contract: Valve Transition Scheduler

**Feature**: 023-limit-valve-operations
**Module**: `shelly/control-logic.js`
**Export**: `planValveTransition`

This contract defines the pure scheduler function exported from `control-logic.js`. The function is the sole decision-maker for staged opens, deferred closes, and resume scheduling. It has no side effects and is unit-tested in Node.js.

## Signature

```javascript
/**
 * planValveTransition
 *
 * @param {Object}  target       Desired valve state map. Keys: valve names. Values: boolean (true = logical open).
 * @param {Object}  current      Current valve state map. Keys: valve names. Values: boolean (true = logical open).
 * @param {Object}  openSince    Map of valve name → epoch-ms timestamp of last open window end. `0` means "no hold" (boot recovery).
 * @param {Object}  opening      Map of valve name → epoch-ms timestamp at which the current opening window ends. Missing key means "not currently opening".
 * @param {number}  now          Current epoch-ms timestamp (supplied by caller, not read from Date.now()).
 * @param {Object}  cfg          Timing config. Defaults to VALVE_TIMING. Shape: {maxConcurrentOpens, openWindowMs, minOpenMs}.
 * @returns {Object}             Transition plan (see below).
 */
function planValveTransition(target, current, openSince, opening, now, cfg)
```

## Return Shape

```javascript
{
  startOpening: string[],          // valves to open right now (respects slot limit)
  closeNow: string[],              // valves to close right now (hold satisfied)
  queuedOpens: string[],           // valves that still need to open but no slot available
  deferredCloses: {                // valves that need to close but hold not yet satisfied
    [valveName]: number            //   value = earliest epoch-ms at which close is allowed
  },
  nextResumeAt: number | null,     // earliest epoch-ms the caller should schedule a resume timer for
  targetReached: boolean           // true iff no more work remains
}
```

## Semantics

1. **Compute desired changes**. For each valve in the union of `target` and `current` keys:
   - If `target[v] === current[v]`, the valve is satisfied. Skip. Do **not** add to any list. Do **not** consume a slot.
   - If `target[v] === true && current[v] === false`, the valve needs to open.
   - If `target[v] === false && current[v] === true`, the valve needs to close.

2. **Handle the open set**.
   - Valves already in `opening` (their entry exists and `opening[v] > now`) are counted against the slot budget but are NOT added to `startOpening` (they're already in progress).
   - Free slots = `cfg.maxConcurrentOpens - (count of valves in opening where opening[v] > now)`.
   - For each valve that needs to open, in stable iteration order (alphabetical over valve names for determinism): if a slot is free, add to `startOpening` and consume a slot; otherwise add to `queuedOpens`.

3. **Handle the close set**.
   - For each valve that needs to close:
     - If `opening[v]` exists and `opening[v] > now` (the valve is still in its opening window): add to `queuedOpens` (we must wait for the open window to end before we can close, otherwise FR-017 is violated — and in practice the valve hasn't physically reached open yet, so the capacitor hasn't started charging). Note: it is added to `queuedOpens` with a sentinel meaning "wait"; the actual close deferral is re-evaluated on the next tick. *(See implementation note below.)*
     - Else compute `readyAt = max(openSince[v], 0) + cfg.minOpenMs`.
       - If `readyAt <= now`: add to `closeNow`.
       - Else: add to `deferredCloses[v] = readyAt`.

4. **Compute `nextResumeAt`**.
   - Candidates: every `opening[v]` where `opening[v] > now`; every value in `deferredCloses`.
   - Result: the minimum of all candidates, or `null` if there are none.

5. **Compute `targetReached`**.
   - True iff `startOpening.length === 0 && closeNow.length === 0 && queuedOpens.length === 0 && size(deferredCloses) === 0` AND no valve in `opening` has `opening[v] > now` (i.e., no windows are still live).

### Implementation note on rule 3 (valve-still-opening-but-now-needs-to-close)

This edge case arises if, mid-transition, the target flips so that a valve that started opening is now supposed to be closed. Two options:

- **(a)** Record it in a special list and defer the close decision until its opening window ends. On the next resume the scheduler will re-evaluate.
- **(b)** Treat it as "still opening" in the slot bookkeeping, do not add to `closeNow` yet, but also do not add to `startOpening` (it's already opening). Do not add to `deferredCloses` until the window ends (we don't know `openSince` yet).

The chosen behavior is **(b)**: the scheduler simply does not add the valve to any action list, and `nextResumeAt` will include `opening[v]` as a candidate. When the resume fires (window ended, `openSince[v]` written by the shell), the scheduler will see a normal "needs to close, hold not yet satisfied" case and defer it.

## Invariants (asserted by tests)

- **INV1**: At most `cfg.maxConcurrentOpens` valves can be simultaneously energized from closed. Formally: for any `now`, `|{v : opening[v] > now}| + startOpening.length <= cfg.maxConcurrentOpens`.
- **INV2**: No valve appears in both `startOpening` and `closeNow`.
- **INV3**: No valve in `closeNow` has `(now - openSince[v]) < cfg.minOpenMs` unless `openSince[v] === 0`.
- **INV4**: No valve in `startOpening` has `current[v] === true`.
- **INV5**: No valve in `closeNow` has `current[v] === false`.
- **INV6**: `targetReached === true` ⇒ `startOpening`, `closeNow`, `queuedOpens` are empty and `deferredCloses` has zero keys and no valve in `opening` has `opening[v] > now`.
- **INV7**: `nextResumeAt` (when non-null) is strictly greater than `now`.
- **INV8**: The function is pure: called twice with identical inputs it returns deep-equal outputs. The function reads no global state and calls no platform APIs.

## Test coverage checklist

These cases must each have at least one dedicated unit test in `tests/control-logic.test.js`:

1. Single valve open, no constraints → `startOpening = [v]`, `targetReached = false`, `nextResumeAt = now + openWindowMs`.
2. Four closed valves all need to open → two in `startOpening`, two in `queuedOpens`, `nextResumeAt = now + openWindowMs`.
3. Two valves opening mid-flight, two more queued in target → `startOpening = []`, `queuedOpens = [remaining two]`, `nextResumeAt = min of existing opening windows`.
4. First batch's window ends → re-plan starts the second batch.
5. Valve has been open 10 s, needs to close → in `deferredCloses` with `readyAt = openSince + 60000`.
6. Valve has been open 70 s, needs to close → in `closeNow`.
7. Safety drain from SOLAR_CHARGING (some valves open >60s, some <60s) → the >60s ones in `closeNow`, the <60s ones in `deferredCloses`, with `nextResumeAt = earliest readyAt`.
8. Boot recovery: valve observed open with `openSince = 0`, needs to close → in `closeNow` (hold trivially satisfied).
9. Re-plan with `target[v] === current[v]` for all valves → `targetReached = true`, `nextResumeAt = null`.
10. Mid-transition target change: valve is in `opening` but new target says close it → not in any action list, `nextResumeAt` includes its opening window end.
11. Mix: two valves closing, three valves opening (slot limit kicks in) → two opens start, one queued, two closes fire immediately (all assuming their holds are satisfied).
12. v_air inversion: target sets `v_air: false` (logical close = energize), scheduler counts the energize against the slot budget. (Encoded at the shell level; scheduler sees the polarity-translated target — test asserts the translation layer rather than the raw scheduler.)
13. Invariant fuzz: 1000 random input configurations, assert INV1–INV8 after each call.
14. `nextResumeAt` chooses the earliest candidate among mixed opening-window-end and deferred-close-ready timestamps.
15. Deterministic ordering: same input with keys in different insertion order produces the same output arrays.

## Non-goals of the scheduler

- The scheduler does **not** know about the pump, fan, or any non-valve actuator. Those are the shell's responsibility.
- The scheduler does **not** issue HTTP RPC calls, Shelly.call invocations, or Timer.set calls. It returns data; the shell acts.
- The scheduler does **not** decide which target to aim at. That decision is already `evaluate()`'s job.
- The scheduler does **not** enforce minimum-mode-duration or refill cooldowns. Those are enforced upstream in `evaluate()`.
- The scheduler does **not** persist state across reboots. The shell passes in fresh `openSince` / `opening` maps on every call.
