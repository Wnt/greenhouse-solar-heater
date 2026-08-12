# 025 — Implementation plan

Test-first per CLAUDE.md testing policy: each task writes the failing test
before the implementation.

## Files touched

| File | Change |
|---|---|
| `server/lib/telemetry-health.js` | **new** — corrupt-telemetry tracker (pure, injectable clock + push) |
| `server/lib/mqtt-bridge.js` | wire the tracker into the `state/min` parse failure path; reset on success; expose `getTelemetryHealth()` |
| `server/lib/script-monitor.js` | capture `mem_used/mem_peak/mem_free` from the existing poll; 5-min memory evaluation; reboot guard + counters; `memory` block in `getStatus()`; `manual_override` in the state snapshot |
| `server/server.js` | pass `push` into the bridge's tracker (already passed) and the memory-guard enable flag into `createScriptMonitor` |
| `tests/telemetry-health.test.js` | **new** — escalation thresholds, reset, re-escalation, preview gate |
| `tests/script-monitor-memory.test.js` | **new** — ratio math, 5-min cadence, every reboot gate, cooldown, daily cap |
| `specs/025-controller-health-guard/*` | this spec + plan |

No frontend files, no new npm deps, no Shelly script change, no Terraform
change. `contracts/telemetry.md` is untouched — the on-wire `greenhouse/state`
shape does not change; `script-status` gains an additive `memory` field.

## Task order

1. **T1 — spec + plan committed, branch pushed, PR opened.** (this commit)
2. **T2 — `telemetry-health.js` + tests.**
   `createTelemetryHealth({ threshold = 3, push, log, now })` →
   `{ recordInvalid(errMsg), recordValid(), getStatus() }`.
   Escalation is edge-triggered per episode (`escalated` latch cleared by
   `recordValid`). `push` may be `null` (preview) → log only.
3. **T3 — wire into `mqtt-bridge.js`.** `recordInvalid` in the existing
   `catch` on `STATE_MIN_TOPIC`; `recordValid` right after a successful parse;
   construct with `push` when not in preview mode; export `getTelemetryHealth`
   for `/api/script-status` reuse if needed later (keep the surface minimal —
   no new endpoint in this change).
4. **T4 — `script-monitor.js` memory watch + tests.** New options:
   `memGuard` (bool), `memCheckIntervalMs = 300000`,
   `memPeakRebootRatio = 0.97`, `memConsecutiveHigh = 2`,
   `memRebootCooldownMs = 2 h`, `maxMemRebootsPerDay = 4`, `push`.
   Evaluation runs inside `pollOnce`'s success branch when
   `now() - lastMemCheckAt >= memCheckIntervalMs`; all gates from FR-3 apply;
   `rebootsToday` is a trailing-24 h timestamp list.
5. **T5 — wire into `server.js`:** `memGuard: !PREVIEW_MODE && NODE_ENV !==
   'test'`, `push: PREVIEW_MODE ? null : push`.
6. **T6 — full local CI gate**, fix anything red, push.
7. **T7 — PR to green, merge to `main`** → CD builds, `kubectl set image`,
   Shelly deploy step (unchanged script, so a no-op-ish redeploy).
8. **T8 — verify in production**: pod healthy, `/api/script-status` shows the
   `memory` block, watch the first memory evaluation in the app log, confirm a
   reboot (if it fires) is followed by `mem_peak` well under the cap and the
   controller resuming automation.

## Risk register

- **Reboot storm.** Bounded by cooldown + daily cap + drain/override gates.
  Worst case 4 × ~30 s control gaps per day.
- **Rebooting mid-solar.** Accepted: costs ≤1 tick; boot lands all-closed and
  re-evaluates. Never permitted during `active_drain`.
- **Fighting crash recovery.** The memory guard requires `running === true`, so
  the crash loop (which owns reboots while the script is down) and the memory
  guard are mutually exclusive by construction.
- **Push spam.** Both alerts are edge-triggered per episode; the memory reboot
  push is once per reboot, at most 4/day.
- **`mem_peak` semantics.** High-water mark, resets only at
  restart/reboot — documented in the spec's trade-off section; the guard's
  `consecutiveHigh` + cooldown keep it from reacting to a stale watermark more
  than once per cooldown window.
