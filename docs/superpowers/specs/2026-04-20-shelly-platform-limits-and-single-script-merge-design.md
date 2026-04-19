# Shelly platform-limit test harness + single-script merge

**Status:** approved 2026-04-20. Motivated by repeated OOM crashes of `telemetry.js` on the Pro 4PM, culminating in the 2026-04-20 sensor-rotation incident (a 256 B KVS cap violation combined with control.js peaking at 22 KB of a ~25 KB shared JS heap left telemetry with ~3 KB and it died during an MQTT publish).

## Problem

Script-crash incidents on the Pro 4PM have shifted over the life of the project — first excess `Timer.set` handles, then MQTT subscription overflow, most recently shared-heap OOMs. The root pattern is the same in each case: a Shelly platform limit is exceeded, no local test catches it before deploy, failure shows up only in production behaviour (typically silent — state stops updating without an obvious signal).

Two compounding causes:

1. **No platform-limit tests.** The existing Node test harness (`tests/shelly-transition.test.js`, `tests/shelly-telemetry.test.js`) exercises control-flow correctness but does not track simultaneous timers, active MQTT subscriptions, in-flight RPCs, or memory proxies.
2. **Architecture grew organically.** `shelly/control.js` and `shelly/telemetry.js` communicate via `Shelly.emitEvent`/`addEventHandler` for five separate event types, duplicate config-version bookkeeping, and together saturate the shared JS heap. Cleaner partitions were considered during brainstorming and rejected — the simpler win is collapsing the IPC and removing the duplication entirely.

## Non-goals

- Espruino-level bytecode introspection. Runtime memory is measured via a byte-sum proxy that correlates with actual heap; it is not a 1:1 match.
- A full state-machine/FSM refactor of control logic. The existing `control-logic.js` `evaluate()` is pure and adequate; leave it alone.
- Adding a callback to every silent `Shelly.call` in the codebase. Worth doing, tracked as a separate follow-up.
- Protocol-level MQTT 5 session takeover as a fix for the subscribe-orphan bug. We use a boot-time `MQTT.unsubscribe` dance instead.
- A rewrite from scratch. Brainstormed as option 4; explicitly deferred unless Sections 1–3 fail to bring `mem_peak` under budget on device.

## Design

### Section 1 — Platform-limit test harness

**Approach:** extend the existing Node mock of the Shelly runtime with counters. Each mock operation (`Timer.set`, `Timer.clear`, `MQTT.subscribe`, `MQTT.unsubscribe`, `Shelly.call`, `KVS.Set`) bumps or decrements a ledger. A 24-hour simulation exercises normal mode transitions, sensor updates, config changes, and valve storms; counters are sampled at every tick and checked against caps.

**Caps:**

| Counter | Cap | Notes |
|---|---|---|
| Deployed slot-1 source after minify | ≤ 65 535 B | Shelly `Script.PutCode` hard limit, error −103. Already tested in `tests/deploy.test.js` per commit `cc09779`; keep as-is. |
| Peak runtime-memory proxy (Node test, byte-sum as defined below) | ≤ (baseline × 0.7) B at introduction | Proxy is measured in Node and includes minified bytecode size, so its absolute value (~40 KB today) is NOT the same scale as Shelly's reported `mem_peak` (~22 KB today). Both are tracked; this one is the CI enforcement. Cap is recalibrated in commit 4 of the migration. |
| Peak `JSON.stringify(state).length` | ≤ 600 B | Catches state-object bloat. |
| Live `Timer.set` handles (simultaneous) | ≤ 3 | Reserves 2 of the Shelly 5-timer budget. |
| Active `MQTT.subscribe` topics | ≤ 3 | Asserted at baseline; not tightened. |
| In-flight `Shelly.call` | ≤ 3 | Reserves 2 of the Shelly 5-RPC budget. |
| KVS value bytes per key | ≤ 256 | Empirical cap verified on Pro 4PM fw 1.7.5: 215 B accepted, 271 B rejected with code −1. Already enforced in `tests/sensor-config.test.js` after the 2026-04-20 fix. |

**Runtime memory proxy definition:**

```
runtimeProxy(tick) =
    minifiedBytecodeSize                                             // static, known constant per build
  + JSON.stringify(state).length                                     // long-lived control state
  + JSON.stringify(deviceConfig).length
  + JSON.stringify(sensorConfig).length
  + sum(JSON.stringify(captured).length for each live Timer closure) // pending continuations
  + sum(JSON.stringify(captured).length for each live Shelly.call cb)
```

This is deterministic and reproducible in Node, but is not a 1:1 match to Espruino's actual JS heap — the device's real heap includes bytecode compression, JsVar overhead, and string interning, none of which are modeled here. The proxy moves in the same direction as the real heap, so regressions are visible. We calibrate by running it on `main` at the start of the work, recording the number, and asserting peak ≤ 0.7 × that baseline. Current code fails by design; the refactor aims at the 30 % reduction.

**Live-device ground-truth.** There is only one Pro 4PM (no spare). The escape hatch of a device-integration test (querying `Script.GetStatus.mem_peak` after a synthetic workload) is not added as a CI step. Instead, the design calls for a manual post-deploy verification against the one live device (see Section 3). Development-time probing via HTTP RPC is allowed throughout (read operations and safe write operations, subject to the hardware-safety constraints in Section 3).

**Static checks (free lunch).** Extend `shelly/lint/` with rules for the obvious callback-leak patterns: `Timer.set` / `MQTT.subscribe` / `Shelly.call` inside an unbounded loop, or inside a callback without an accompanying decrement in all exit paths. Lint-level catch for the class of bug where a cleanup path was forgotten.

**Deliverables:**

1. `tests/shelly/platform-limits.js` — mock-instrumentation module exposing the counters and CAP constants. Consumed by the existing test harness.
2. `tests/shelly-platform-limits.test.js` — 24-hour simulation with counter assertions. Prints baseline measurements in test output so diffs show regressions. Deliberately fails against current code at introduction.
3. Linter rules in `shelly/lint/` for the static callback-leak patterns.
4. A `CAPS.md`-style table committed into `tests/shelly/` showing the current observed numbers versus the caps, updated as part of the calibration commit.

### Section 2 — Single-script architecture

**The merge.** Three source files → two after merge, one deployed slot:

- `shelly/control-logic.js` (32 KB, pure) remains a standalone file. It is consumed by `playground/js/control-logic-loader.js` and by multiple Node tests (`tests/control-logic.test.js` etc.). Keep it.
- `shelly/control.js` + `shelly/telemetry.js` collapse into **one file**, deployed as a single Shelly script slot. `shelly/deploy.sh` changes `EXPECTED_SLOT_COUNT` from 2 to 1, concatenates all three (`control-logic.js` first, then the merged control/telemetry) at upload, and removes slot-2 handling.

**What the merge removes:**

| Removed | Replaced by |
|---|---|
| `Shelly.emitEvent("state_updated")` → `addEventHandler` → `MQTT.publish(STATE_TOPIC, …)` | inline `MQTT.publish(STATE_TOPIC, JSON.stringify(buildSnapshotFromState(state, deviceConfig, Date.now())), 1, true)` at the point of state change |
| `Shelly.emitEvent("config_changed")` bridge (device-config apply) | direct call to `applyConfig(newCfg)` that updates `deviceConfig` in place and, if safety-critical, calls `controlLoop()` synchronously |
| `Shelly.emitEvent("sensor_config_changed")` bridge (sensor routing) | direct assignment `sensorConfig = newCfg` inside the MQTT callback |
| `Shelly.emitEvent("relay_command")` bridge (manual-override relay toggle) | direct call to `handleRelayCommand(cmd.relay, cmd.on)` inside the MQTT callback |
| `Shelly.emitEvent("watchdog_event")` bridge | inline `MQTT.publish(WATCHDOG_EVENT_TOPIC, …)` at the point of detection |
| `var currentVersion` (telemetry-owned) + `deviceConfig.v` (control-owned) — same quantity tracked in two places | single `deviceConfig` object with a `v` field |
| `mqttSubscribed` guard + `safeSubscribe` try/catch workaround | explicit `try { MQTT.unsubscribe(topic); } catch(e) {}` followed by a clean `MQTT.subscribe(topic, cb)` at boot — see subscribe-orphan fix below |
| `loadConfig` + `loadSensorConfig` (parallel code paths) | single `loadPersistedState()` that reads both KVS keys once at boot |

**Subscribe-orphan fix.** Investigation on 2026-04-20 found that after `Script.Stop`/`Script.Start` (but not after a full `Shelly.Reboot`), the MQTT client retains topic subscriptions at the device level while the JS callback is garbage-collected — incoming messages have no handler and a subsequent `MQTT.subscribe(topic, newCb)` throws. The merged script's boot sequence explicitly calls `MQTT.unsubscribe(topic)` before each `MQTT.subscribe`, wrapped in try/catch for the first-boot case where there is nothing to unsubscribe. `MQTT.unsubscribe` must be verified to exist in Shelly's Gen-2 Script API during implementation; the confirmed-working fallback is a one-shot `Shelly.Reboot` in the boot sequence when a stale-subscription condition is detected.

**What remains untouched.** All safety-critical device behaviour: `transitionTo()` valve-before-pump ordering, the `ACTIVE_DRAIN` exit reversal using `DRAIN_EXIT_PUMP_RUN_MS`, the 200 ms `relay_command` inter-switch gap, the `setActuators` RPC-chaining pattern, and the valve scheduler (staged opens, deferred closes, `planValveTransition`). Each exists for a documented hardware constraint.

**What the tests guard.** Every existing test in `tests/shelly-transition.test.js`, `tests/shelly-telemetry.test.js`, `tests/shelly-stability.test.js`, `tests/control-logic.test.js` must continue to pass after the merge. Tests currently import `control.js` and `telemetry.js` separately with a `__TEST_HARNESS` gate; they fold into a single test boot while assertions are preserved. Tests that observed `Shelly.emitEvent` as their observation point switch to observing the direct function call or the `MQTT.publish` side-effect.

**Expected savings (to be validated against the Section 1 harness and against on-device `mem_peak`):**

| Source | Rough estimate |
|---|---|
| Event-dispatch plumbing (5 event types: emit allocation + handler lookup + per-event closure) | 300–500 B runtime |
| Duplicated config-version bookkeeping | 50–100 B |
| `safeSubscribe` + `mqttSubscribed` guard | 80 B |
| Separate `loadConfig`/`loadSensorConfig` | 200 B bytecode |
| Telemetry's separate module-scope allocation (deploy slot 2) | ~4 KB bytecode |

Ballpark: 5–6 KB runtime-heap reduction. Target: bring `mem_peak` from 22 KB on-device to ≤ 16 KB with ≥ 9 KB free.

### Section 3 — Migration

**Working branch.** Isolated git worktree so `main` stays clean and CI continues to pass there. The live Shelly is not rebooted during mid-refactor commits. Merge back as one PR when Section 1's tests are passing against Section 2's code. Rollback is `git revert <merge-commit>` — CD redeploys the previous build automatically.

**Commit sequence on the branch** (each commit individually bisectable):

1. `shelly: add platform-limit test harness (caps deliberately fail today)` — Section 1 deliverables. Counters module, 24-hour platform-limits simulation, new assertions, lint rules. CI fails on this branch by design. Do not merge yet.
2. `shelly: merge telemetry into control (single deployed slot)` — Section 2 structural change, no intended behaviour change. Removes the IPC bridge, deduplicates config-version bookkeeping, adds the explicit `MQTT.unsubscribe` boot step. Updates `shelly/deploy.sh` `EXPECTED_SLOT_COUNT` to 1 and fixes the upload loop. Updates `tests/deploy.test.js`. Existing behaviour tests (shelly-transition, shelly-telemetry, shelly-stability, control-logic) must still pass. Platform-limits test may still fail — acceptable at this step.
3. `shelly: collapse valve bookkeeping + dedupe constants` — trim work: four valve-keyed maps collapse to one map of structs; `MODE_VALVES`/`MODE_ACTUATORS` lookup overhead folded; vestigial helpers removed as surfaced by coverage. Target: bring platform-limits test to green.
4. `shelly: calibrate platform-limit caps to new baseline` — once step 3 brings the test to green, re-measure the runtime-proxy peak against the refactored code and commit a new cap of `measuredPeak + 512 B` (small margin, not another 0.7× tighten). This becomes the landmark value; a future regression that adds even ~512 B of state or bytecode trips the test. Step 3 already enforces the 0.7× drop from original baseline; step 4 locks in the achieved number.
5. `shelly/lint: add static rules for unbounded Timer/RPC/subscribe in callbacks` — belt-and-suspenders static check. Lands only if steps 1–4 are stable.

**Development-time testing on the live device.** Because there is no spare Shelly, the live Pro 4PM at `192.168.30.50` is used for probing during development. Allowed: any Shelly HTTP RPC call that is read-only (`Shelly.GetStatus`, `Script.GetStatus`, `KVS.Get`, `MQTT.GetStatus`, `Script.Eval` reading variables), or write operations that do not trigger valve actuation. `Script.Eval` that invokes functions with side-effects is permitted only if the effect is bounded and reversible.

**Hardware-safety constraints during live probing:**

- **Do not actuate more than 2 valves simultaneously in the energizing window.** The 24 V PSU current budget is the documented `VALVE_TIMING.maxConcurrentOpens = 2`. Bypassing the scheduler via direct `Script.Eval` or HTTP RPC calls that open >2 valves at once risks brownout / reset.
- **Do not close a valve within 60 s of opening it.** The `VALVE_TIMING.minOpenMs = 60000` gap is the closing-motion capacitor charging time. Violating it leaves the valve in an undefined physical state.
- **Do not trigger rapid `Shelly.Reboot` cycles when valves are actuated.** Boot sequence closes all valves on startup; successive reboots beat up the motors. Space reboots by ≥ 30 s and only reboot when the system is in `IDLE` or `ACTIVE_DRAIN` (both have the pump off on entry).
- **Use forced mode for controlled testing.** Set `deviceConfig.fm` via the UI or MQTT to a stable mode (`IDLE`, `ACTIVE_DRAIN`) before probing, so the control loop does not re-evaluate mid-test.

**Post-merge on-device verification.** CD runs `shelly/deploy.sh` via GitHub Actions on merge to `main`. After it completes, read `Script.GetStatus?id=1` directly:

- Record `mem_used`, `mem_peak`, `mem_free`. Target: `mem_peak ≤ 16 000` with `mem_free ≥ 9 000`.
- If `mem_peak ≥ 22 000` (no improvement), the proxy-based refactor did not translate to on-device gains. Open a follow-up: either revisit the trim (more aggressive Section 2 changes) or escalate to Section 4 (rewrite).

**Risk assumptions.** The merged deploy goes straight to the single production device. Safety properties this relies on:

- `shelly/deploy.sh` already wipes and recreates slots when slot-count changes (per existing behaviour documented in the script), so 2 → 1 transition is automatic.
- `boot()` in the merged script starts by stopping all actuators and closing all valves (preserved from `control.js:1045-1055`), so worst-case post-deploy state is "all closed, pump off" — safe.
- If the merged script fails to start for any reason, no valves actuate (`pollAllSensors` skips when sensor config missing — all temps stay null, which the state machine handles as `IDLE`). The previous KVS `config` and `sensor_config` stay intact for a rollback deploy.

## Out of scope (explicit deferrals)

- Espruino-level bytecode analysis beyond source-size measurement.
- A `saveSensorConfig`-style callback wrapper added to every silent `Shelly.call` in the codebase.
- Replacing the control-logic `evaluate()` with an explicit FSM.
- Rewriting the system from scratch (deferred brainstorming option 4).
- MQTT 5 session-takeover as a fix for the subscribe-orphan bug.

## Success criteria

1. `tests/shelly-platform-limits.test.js` passes against the merged implementation with caps committed in step 4 of the migration sequence.
2. On-device `Script.GetStatus?id=1.mem_peak` ≤ 16 000 B under normal operation (≥ 24 h of uptime with at least one mode transition, measured post-deploy).
3. All existing Node unit tests (`npm run test:unit`) pass: `shelly-transition`, `shelly-telemetry`, `shelly-stability`, `control-logic`, `sensor-config`, `device-config-integration`, `mqtt-bridge`, `deploy`.
4. The live Pro 4PM does not experience another silent telemetry crash for ≥ 7 days post-deploy (measured by `Script.GetStatus?id=1.errors` staying empty).
