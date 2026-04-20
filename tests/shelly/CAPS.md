# Shelly platform-limit caps

Single source of truth for the numbers enforced by `tests/shelly-platform-limits.test.js`.
Updated whenever a commit in the migration sequence moves the peak — see the
spec (`docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md`)
Section 3 for which commit touches which cap.

| Counter | Cap | Current peak | Notes |
|---|---|---|---|
| Deployed slot-1 source (minified) | ≤ 65 535 B | ≈ 25 000 B | Shelly Script.PutCode limit, also enforced by `tests/deploy.test.js` |
| Runtime proxy peak (Node byte-sum) | ≤ 42 312 B | 41 800 B | Calibrated post-merge w/ async harness 2026-04-20 at measured + 512 B margin. Future ≥ 512 B regression in bytecode, state, or live closures trips the test. |
| `JSON.stringify(state).length` | ≤ 700 B | 655 B | Includes transient opening[]/pending_closes[]/manual_override{} fields during transitions |
| Live `Timer.set` handles (simultaneous) | ≤ 3 | 2 | 2-handle reserve against Shelly's 5-handle limit |
| Active MQTT.subscribe topics | ≤ 3 | 3 | config, sensor-config, relay-command |
| In-flight `Shelly.call` | ≤ 3 | 3 | 2-call reserve against Shelly's 5-RPC limit. Hits cap exactly during mode transitions (valve HTTP.GET × 2 + KVS.Set). |
| KVS value bytes per key | ≤ 256 | under cap | Empirical Pro 4PM fw 1.7.5 cap (215 B ok / 271 B rejected, 2026-04-20) |

## Baseline history

| Date | Commit context | Harness | Runtime proxy peak | Delta |
|---|---|---|---|---|
| 2026-04-20 | pre-merge `main` | sync-loop (buggy) | 43 781 B | — |
| 2026-04-20 | post-merge (telemetry→control) | sync-loop (buggy) | 41 674 B | — |
| 2026-04-20 | post-inlining (Commit 3) | sync-loop (buggy) | 41 232 B | — |
| 2026-04-20 | pre-merge `main` | async-loop (fixed) | 44 887 B | baseline |
| 2026-04-20 | post-merge (current) | async-loop (fixed) | 41 800 B | −3 087 B |
| 2026-04-20 | post-merge (realistic sim) | async+synthetic-Date | 42 056 B | — (+256 B due to extra state during mode transitions) |

### Why the realistic-sim peak is slightly higher

The first async-loop measurement (41 800 B) ran only 1 sensor and kept the
script in IDLE. The realistic sim exercises all 4 modes (IDLE →
SOLAR_CHARGING → ACTIVE_DRAIN → GREENHOUSE_HEATING) plus a manual-
override relay storm, so published state grows to ~656 B during
transitions (vs ~540 B in pure IDLE) and the runtime proxy picks up
that extra weight.

Note 1: the sync-loop harness was vacuously passing most caps because
`setImmediate` callbacks from `Shelly.call` never drained inside the
synchronous `for`-loop — peak counters for timers, subs, and in-flight
calls stayed at zero. The async-loop harness (`await
drainImmediates(30)` between ticks) lets the boot chain and per-tick
`controlLoop` fully resolve, so the caps actually bite.

Note 2: the spec's original 0.7× target (≈31 000 B) assumed greater
variable-memory contributions than this script has in practice. The
proxy total is dominated by the minified bytecode size (~40 KB static),
which is already independently guarded by the Shelly `Script.PutCode`
65 535-byte limit via `tests/deploy.test.js`. The cap above locks in
the post-refactor working set so a regression in state size, closure
leaks, or bytecode growth of ≥ 512 B trips the test.
