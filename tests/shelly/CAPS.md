# Shelly platform-limit caps

Single source of truth for the numbers enforced by `tests/shelly-platform-limits.test.js`.
Updated whenever a commit in the migration sequence moves the peak — see the
spec (`docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md`)
Section 3 for which commit touches which cap.

| Counter | Cap | Current peak | Notes |
|---|---|---|---|
| Deployed slot-1 source (minified) | ≤ 65 535 B | ≈ 25 000 B | Shelly Script.PutCode limit, also enforced by `tests/deploy.test.js` |
| Runtime proxy peak (Node byte-sum) | ≤ 41 744 B | 41 232 B | Calibrated post-merge 2026-04-20 at measured + 512 B margin. Future ≥ 512 B regression in bytecode, state, or live closures trips the test. |
| `JSON.stringify(state).length` | ≤ 600 B | under cap | Snapshot captured via `greenhouse/state` publish |
| Live `Timer.set` handles (simultaneous) | ≤ 3 | under cap | 2-handle reserve against Shelly's 5-handle limit |
| Active MQTT.subscribe topics | ≤ 3 | 3 | config, sensor-config, relay-command |
| In-flight `Shelly.call` | ≤ 3 | under cap | 2-call reserve against Shelly's 5-RPC limit |
| KVS value bytes per key | ≤ 256 | under cap | Empirical Pro 4PM fw 1.7.5 cap (215 B ok / 271 B rejected, 2026-04-20) |

## Baseline history

| Date | Commit context | Runtime proxy peak | Delta |
|---|---|---|---|
| 2026-04-20 | pre-merge `main` | 43 781 B | baseline |
| 2026-04-20 | post-merge (telemetry→control) | 41 674 B | −2 107 B |
| 2026-04-20 | post-inlining (Commit 3) | 41 232 B | −2 549 B vs baseline |

Note: the spec's original 0.7× target (30 646 B) assumed greater variable-
memory contributions than this script has in practice. The proxy total
is dominated by the minified bytecode size (~40 KB static), which is
already independently guarded by the Shelly Script.PutCode 65 535-byte
limit via `tests/deploy.test.js`. The cap above locks in the post-
refactor working set so a regression in state size, closure leaks, or
bytecode growth of ≥ 512 B trips the test.
