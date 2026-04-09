# Research: Limit Concurrent Valve Operations

**Feature**: 023-limit-valve-operations
**Date**: 2026-04-09

## R1: Where does the valve-timing state live?

**Decision**: Timing state lives in `control.js` (the I/O shell) as three in-memory structures: `valveOpenSince` (map of valve name → epoch ms of last open), `valveOpening` (map of valve name → epoch ms when the opening window ends), and `valvePendingOpen` / `valvePendingClose` (arrays of valve names queued for future action). The pure decision logic in `control-logic.js` exposes a new `planValveTransition(target, current, valveOpenSince, valveOpening, now, cfg)` helper that, given those inputs, returns a plan of what to actuate right now. The shell realizes the plan and updates its own timing state.

**Rationale**: The Pure Logic / IO Separation principle (Constitution II) requires pure decisions to be side-effect-free and platform-API-free. Time passes, so a pure function cannot be the owner of "current time" — it must receive `now` as an argument. Making the scheduler a pure function with explicit time inputs lets every scheduling decision be deterministically unit-tested in Node.js without mocking clocks or timers. The shell stays responsible for the real clock (`Date.now()`), the real timers (`Timer.set`), and the real HTTP calls.

**Alternatives considered**:
- **Put the scheduler inside `evaluate()`**: Would conflate mode-selection decisions with low-level hardware pacing. `evaluate()` decides what mode to be in; the scheduler decides how to get the hardware there. Mixing them would make both harder to test. Rejected.
- **Keep all timing logic in `control.js` with no pure helper**: Would mean the complex scheduling logic (batch sizing, deferred closes, safety-override interaction) is unit-testable only via integration tests. Rejected — the scheduler has enough decision branches (initial batch, queue drain, deferred close waking, reboot recovery, etc.) that unit tests are necessary to cover it.
- **A full new module**: Adds a concatenation step and a new file to deploy. `control-logic.js` is already concatenated into the deployed script, and already hosts the other pure helpers. Rejected as unnecessary.

## R2: How are staged opens driven across time?

**Decision**: A dedicated short-lived Shelly `Timer.set(remainingMs, false, resumeTransition)` is scheduled by the shell during a transition. `remainingMs` is computed as `min(openingWindowEnd, deferredCloseReady)` — whichever comes first. When the timer fires, the shell recomputes the current plan (by calling `planValveTransition` with the fresh `now`) and issues any newly unblocked opens or closes. If more work remains, it schedules the next timer; otherwise it marks the transition complete and starts the pump.

**Rationale**: Waiting for the next 30 s control-loop tick would stretch a 4-valve transition from ~45 s to well over a minute and would make the wall-clock duration unpredictable. A transition-scoped timer keeps wall-clock duration tight (SC-004) without consuming a permanent timer slot. Shelly's 5-timer budget is already allocated to: control loop (1), drain monitor (1), valve-settle one-shots (short-lived), pump-prime one-shot (short-lived), and boot retry (short-lived). The transition-scoped timer is always short-lived (cleared before the transition ends) so it competes for the same "short-lived" bucket as valve-settle and pump-prime. The existing transition sequence only uses one of those at a time, so budget remains safe.

**Alternatives considered**:
- **Reuse the 30 s control-loop tick to drive the queue**: Simplest, but SC-004 fails — a 4-valve transition would take up to 75 s instead of 45 s. Rejected.
- **One persistent timer running at 1 s**: Wastes a permanent timer slot and most ticks would have nothing to do. Rejected.
- **Recursive `Timer.set` chain with a fixed small period**: Same waste as above. Rejected.

## R3: How is the 60 s minimum-open hold tracked and enforced?

**Decision**: The shell records `valveOpenSince[name] = Date.now()` at the moment the opening window ends successfully (i.e., when the 20 s window expires for a valve that was commanded open). When the scheduler is asked to close a valve, it consults the valve's `openSince` — if `now - openSince < 60 000 ms`, it emits a `deferCloseUntil[name] = openSince + 60 000` field in the plan. The shell converts those deferrals into the `remainingMs` used for the transition timer (R2).

**Rationale**: The capacitor hold is a physical property of the valve hardware (manufacturer behavior) and cannot be short-circuited. Tracking the timestamp at the moment the opening window ends (not when the open HTTP command was sent) aligns with the physical reality: the capacitor only begins charging when the motor actually reaches the open position and the valve is holding under power. Using ms (not seconds) keeps the math simple in JavaScript and consistent with `Date.now()`.

**Alternatives considered**:
- **Track timestamp at command send time**: Slightly simpler bookkeeping but inaccurate — a valve commanded open at T=0 with a 20 s opening phase has only been physically holding for ~0 s at T=1. Under this alternative, a close at T=61 would be allowed even though the capacitor has only been charging for ~41 s. Rejected.
- **Store `openSince` in Shelly KVS for reboot persistence**: Would add KVS writes on every valve state change, raising wear and adding latency. The spec explicitly permits the reboot-recovery simplification (FR-015). Rejected.
- **Use a per-valve `Timer.set` for each deferred close**: Would blow the 5-timer budget on a multi-valve close. Rejected in favor of the consolidated transition timer in R2.

## R4: How does the scheduler interact with `v_air` (normally-open / fail-safe)?

**Decision**: The scheduler operates on **logical** valve states (true = open-to-flow, false = closed-to-flow). The shell's existing `setValve()` function already handles the v_air polarity inversion when translating logical commands to physical HTTP commands. Because the PSU current draw and the capacitor charging both happen when the motor is **energized**, and for v_air "energized" means physically commanded closed (i.e., logical `v_air = false`), the scheduler tracks timing on v_air with inverted semantics:

- `valveOpenSince["v_air"]` records the moment v_air last transitioned to the **closed** state (because that is when its capacitor started charging for the subsequent open motion).
- When the scheduler is asked to **open** v_air (logical true → de-energize), it checks `openSince` for the 60 s hold before issuing the de-energize command.
- When the scheduler is asked to **close** v_air (logical false → energize), it counts against the "concurrent opening slots" budget because that is when PSU current flows for this valve.

**Rationale**: The user's rule is rooted in physical behavior: PSU current flows when motors are energized, and the closing-motion capacitor charges during the same energized window. For 7 of the 8 valves, "logical open" = "energized". For v_air, "logical closed" = "energized". Modeling the scheduler at the "energized / de-energized" level while presenting a logical API to `evaluate()` lets the pure logic stay oblivious to the normally-open quirk while the PSU and capacitor rules remain correct for all 8 valves.

**Alternatives considered**:
- **Ignore v_air for the scheduler**: Simplest, but leaves v_air unprotected — a transition that energizes v_air along with two other valves would exceed the PSU limit. Rejected.
- **Encode the inversion in `evaluate()`**: Would pollute the pure logic with hardware polarity details. Rejected.
- **Expose "physical" valve states from the scheduler API**: Would force every caller to understand polarity. Rejected in favor of a single translation point inside the scheduler.

## R5: How does the scheduler behave during safety-override transitions?

**Decision**: Safety-override transitions (freeze drain, overheat drain) call the same `planValveTransition` helper. The scheduler receives a `safetyOverride: true` flag in `cfg` which only affects one thing: logging. No rule is relaxed. The PSU concurrency cap and the capacitor hold still apply because they are physical constraints. The "no other throttles" rule from spec FR-010 is enforced upstream in `control.js`: safety transitions bypass the minimum-mode-duration check and the refill-retry cooldown (which already happens in `evaluate()`) but are otherwise funneled through the same transition state machine.

**Rationale**: Relaxing either rule during a safety override would risk hardware damage precisely when the operator least wants it: a blown PSU during a freeze event leaves the whole system unresponsive, and a capacitor-short closing command during an overheat event leaves the collector loop open when it should be drained. The rules are physical, so they cannot be waived. Observability, however, matters: operators need to know that a "slow" safety drain is slow because of the capacitor hold, not because of a bug.

**Alternatives considered**:
- **Allow all 8 valves to energize simultaneously during safety overrides**: Would likely brown-out or damage the PSU at exactly the moment the system needs to be reliable. Rejected.
- **Skip the 60 s hold during safety overrides**: Leaves the capacitor under-charged and the close fails — so the drain path never actually establishes, defeating the purpose of the override. Rejected.
- **Add a `--force` flag to the scheduler for safety use**: Would violate Constitution III (Safe by Default). Rejected.

## R6: How does the feature surface in the playground UI?

**Decision**: The existing state-broadcast path already forwards the Shelly `state_updated` event to MQTT → server → WebSocket → playground. The shell's `buildStateSnapshot()` is extended with three new fields:

```javascript
opening: ["vi_btm", "vo_coll"],           // currently energizing, still within 20 s window
queued_opens: ["vi_top"],                 // waiting for a slot
pending_closes: [                         // deferred due to minimum-open hold
  { valve: "v_ret", readyAt: 1712508300 }
]
```

The playground's Status view gains a compact indicator (e.g. "Transitioning 2/4 valves opening, 1 queued") under the current mode label during active transitions. The Device view gains a detailed list of pending opens/closes with countdown timers during transitions, hidden when no transition is in flight.

**Rationale**: Staged transitions last up to ~45 s during normal operation and potentially longer during safety overrides with deferred closes. Without visible progress, operators will interpret a 40-second wait as a bug. Reusing the existing state-broadcast path (no new MQTT topic, no new WebSocket endpoint) keeps the plumbing simple and piggybacks on the atomic state snapshot design.

**Alternatives considered**:
- **No UI surfacing**: Fails spec Story 5 and SC-002 (operator can verify concurrency counter). Rejected.
- **New MQTT topic `greenhouse/transition-progress`**: Adds broker traffic and a second update cadence that can drift from the state snapshot. Rejected.
- **Detailed timeline logged only to device console**: Not operator-visible without SSH/serial access. Rejected.

## R7: How is reboot recovery handled?

**Decision**: On boot, `control.js` runs `closeAllValves()` as it currently does (existing behavior), then on the first control loop iteration sets `valveOpenSince[name] = 0` for every valve. Because `0` is far in the past (unix epoch start), any valve subsequently observed to be open satisfies the 60 s hold immediately. New opens during normal operation get a real timestamp written at the moment their 20 s opening window ends.

**Rationale**: FR-015 permits this simplification, and the first boot action (`closeAllValves`) already zeroes out valve state in practice. This rule also handles the edge case where the device reboots mid-transition — the closing sequence runs cleanly on first boot, and any subsequent open gets a real timestamp.

**Alternatives considered**:
- **Persist `valveOpenSince` to KVS**: Adds write wear and doesn't really help — a clean boot always tries to close all valves first, and even if that fails we prefer to fail open (allow the close) over fail closed (refuse to close a valve that's been physically open for hours). Rejected.
- **Conservative default (`now - 60 000`)**: Would also work, but storing `0` is simpler and equivalent in effect. Chosen for clarity.

## R8: What are the timing constants and where do they live?

**Decision**: Add a `VALVE_TIMING` block to `control-logic.js` as a plain object literal next to `DEFAULT_CONFIG`:

```javascript
var VALVE_TIMING = {
  maxConcurrentOpens: 2,   // PSU current budget
  openWindowMs: 20000,     // time for motor to physically reach open
  minOpenMs: 60000         // capacitor charging time before close allowed
};
```

These are exported alongside the existing exports. The shell reads them via `VALVE_TIMING.openWindowMs` etc. Tests can pass overrides when calling `planValveTransition` by including a `cfg` argument that shadows `VALVE_TIMING`.

**Rationale**: Named constants in one place satisfy FR-016 and keep the default values discoverable. Passing overrides via `cfg` is consistent with how `DEFAULT_CONFIG` already works for the rest of the control logic.

**Alternatives considered**:
- **Put the constants in `deviceConfig` (compact KVS format)**: Would eat bytes from the 256 B KVS limit and invite runtime tuning of values that should not be tuned without hardware validation. Rejected.
- **Hard-code inside the shell**: Would not be unit-testable with overrides. Rejected.
