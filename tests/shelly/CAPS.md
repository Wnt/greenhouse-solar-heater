# Shelly platform-limit caps

Single source of truth for the numbers enforced by `tests/shelly-platform-limits.test.js`.
Updated whenever a commit in the migration sequence moves the peak — see the
spec (`docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md`)
Section 3 for which commit touches which cap.

| Counter | Cap | Current peak | Notes |
|---|---|---|---|
| Deployed slot-1 source (minified) | ≤ 65 535 B | ~25 000 B | Shelly Script.PutCode limit, also enforced by `tests/deploy.test.js` |
| Runtime proxy peak (Node byte-sum) | ≤ 30 646 B | 43 781 B | Calibrated 2026-04-20 at 0.7× baseline. Currently FAILING by design — passes after Commit 3. |
| `JSON.stringify(state).length` | ≤ 600 B | under cap | Snapshot captured via `greenhouse/state` publish |
| Live `Timer.set` handles (simultaneous) | ≤ 3 | under cap | 2-handle reserve against Shelly's 5-handle limit |
| Active MQTT.subscribe topics | ≤ 3 | under cap | Post-merge: config, sensor-config, relay-command |
| In-flight `Shelly.call` | ≤ 3 | under cap | 2-call reserve against Shelly's 5-RPC limit |
| KVS value bytes per key | ≤ 256 | under cap | Empirical Pro 4PM fw 1.7.5 cap (215 B ok / 271 B rejected, 2026-04-20) |
