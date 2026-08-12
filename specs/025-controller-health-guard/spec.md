# 025 — Controller Health Guard: corrupt-telemetry alert + JsVar memory reboot

## Motivation

On 2026-08-12 the Pro 4PM controller sat idle for 48 minutes (12:46 → 13:34
Europe/Helsinki) while the collector stagnated from 22 °C to **71.7 °C** in
full sun. The solar-charging entry condition (`collector > tank_bottom + 3 K`)
was satisfied the whole time by a 14 K margin, and every legitimate blocker was
ruled out from history: no manual override (`config_events` clean), no watchdog
ban, no script crash row, no reboot (uptime 2.7 d), no stale sensor, collectors
not flagged drained.

What the data does show:

1. **Corrupt telemetry.** Between 12:54:43 and 12:59:13 the device published 10
   consecutive malformed `greenhouse/state/min` payloads. The server logged each
   as `warn`: `invalid JSON … "llector": ... ,"tank"…`. The literal `...` is
   Espruino's out-of-memory string truncation — `buildMinPayload` could not
   finish serializing.
2. **The JsVar pool is exhausted.** `Script.GetStatus` on the live device
   reports `mem_peak: 25186` — *exactly* the full pool size recorded in
   `shelly/script-budget.json`. There is zero headroom at the transition peak,
   which is the historical OOM point.

The 48-minute blind window is invisible in `state_events`: a tick that dies
before `transitionTo()` leaves no trace, and the 30 s poll/publish loop kept
running (sensor readings continued at :07/:37 throughout).

Both signals were already observable and both were silent to the operator: the
corrupt payloads were a `warn` line nobody reads, and nothing anywhere watches
`mem_peak`.

## Goals

- **G1** Detect sustained corruption of `greenhouse/state/min` and raise an
  operator-visible alert (log at `error` + forced web push). A controller that
  cannot serialize its own state has stopped deciding; that must not be a
  `warn`.
- **G2** Poll the control script's JsVar memory every 5 minutes and, when the
  peak is at/near the pool ceiling, reboot the Pro 4PM to reclaim the
  fragmented pool — the one recovery a script restart cannot perform.
- **G3** Both guards must be safe by construction: never reboot during a
  freeze/overheat drain, never fight the existing crash-recovery loop, never
  fire from a preview pod or a test run.

## Non-goals

- Shrinking the script's memory footprint (that is the separate budget
  re-calibration; this feature keeps the device alive until then).
- A stagnation watchdog for "wanted solar, never got it" (proposed separately).
- New playground UI. Both guards surface through existing channels
  (`script-status` WS frame + push), so no new frontend files and no new
  coverage-gate surface.

## Requirements

### FR-1 — Corrupt-telemetry detector

- The MQTT bridge tracks, for `greenhouse/state/min`: `consecutive` invalid
  parses, `total` invalid parses, `firstAt`, `lastAt`, `lastError`.
- A successful parse resets `consecutive` to 0 and closes the episode.
- When `consecutive` reaches **3** (≈90 s at the 30 s publish cadence), the
  episode escalates **once**:
  - `log.error('telemetry corrupt on greenhouse/state/min', …)`
  - one forced web push (`script_crash` category, `force: true`,
    `ignoreRateLimit: true`) titled "Controller telemetry corrupt".
- Re-escalation only after a recovery (a valid parse) followed by another 3
  consecutive failures — no push per bad message.
- `PREVIEW_MODE` pods log but never push (consistent with every other
  notification path).
- Threshold 3 rather than 1: a single truncated payload is a transient; three
  in a row means the device is starved, which is what happened on 2026-08-12
  (10 in a row).

### FR-2 — JsVar memory watch

- `script-monitor` already calls `Script.GetStatus` every 30 s and receives
  `mem_used`, `mem_peak`, `mem_free`. Total pool = `mem_used + mem_free`
  (25186 B on this device); `peakRatio = mem_peak / total`.
- Memory is **evaluated every 5 minutes** (not on every 30 s poll) using the
  freshest poll result — no second HTTP call, no second timer.
- The status snapshot gains a `memory` block:
  `{ used, peak, free, total, peakRatio, checkedAt, consecutiveHigh,
  lastRebootAt, rebootCount, rebootsToday }`, broadcast on the existing
  `script-status` WS frame and served by `GET /api/script-status`.

### FR-3 — Memory-triggered reboot

Fire `Shelly.Reboot` on the Pro 4PM when **all** of these hold:

1. `peakRatio >= 0.97` (default, configurable) on **2 consecutive** 5-minute
   checks — i.e. the condition has persisted ~10 minutes.
2. The script is observed `running` and reachable (a crashed script is the
   crash-recovery loop's business, and it already escalates to reboots).
3. The last observed mode is **not** `active_drain` and the device is **not**
   `transitioning`, and manual override is **not** active. A reboot mid-drain
   would abort a freeze/overheat drain — the one thing that must never be
   interrupted. Unknown mode (no snapshot yet) blocks the reboot.
4. At least `memRebootCooldownMs` (default **2 h**) since the last
   memory-triggered reboot.
5. Fewer than `maxMemRebootsPerDay` (default **4**) memory reboots in the
   trailing 24 h. On exceeding it, the guard stops rebooting and sends one
   forced push instead ("memory guard exhausted") — a device that needs more
   than 4 reboots a day needs a human and a smaller script, not a reboot loop.

After a successful reboot: `log.warn`, one forced push ("Controller rebooted —
script memory exhausted"), and the counters advance. `mem_peak` resets on the
device at boot, so `consecutiveHigh` naturally returns to 0 on the next check.

Disabled when `PREVIEW_MODE` is set or `NODE_ENV === 'test'` — same gate the
existing auto-restart uses. Enabled by default in production so no
Terraform/app-config change is needed to ship it; every threshold is
overridable through constructor options.

### FR-4 — Safety-order note

A boot re-closes every valve and turns all actuators off (`boot()` in
`shelly/control.js`), so a reboot from any non-drain mode is safe by
construction: it lands in the all-closed, everything-off state and re-evaluates
within one 30 s tick. This is the same reasoning the device's own
`maybeScheduledReboot()` uses; the difference is that the device gates on IDLE
only, while the server guard also permits solar/greenhouse modes (losing ≤1
tick of pumping is strictly better than a starved pool), but never a drain.

## Accepted trade-off

`mem_peak` is a high-water mark that only resets on script restart or device
reboot. On this device it currently sits at the ceiling, so the guard will fire
its first reboot shortly after deploy, and may fire again on days whose
transition peak touches the cap — bounded by the 2 h cooldown and the 4/day cap
(worst case 4 reboots/day, each a ~30 s control gap from IDLE). That is
deliberate: a reboot costs one tick, while a starved pool costs 48 minutes of
peak-sun capture. The permanent fix is the script-budget re-calibration; when
the peak drops below 97 % the guard goes quiet on its own.

## Success criteria

- A synthetic run of 3 malformed `state/min` payloads produces exactly one
  `error` log + one forced push; the 4th produces nothing new; a valid payload
  then 3 more malformed ones produce a second alert.
- A mocked `Script.GetStatus` reporting `peakRatio >= 0.97` for two 5-minute
  checks in IDLE issues exactly one `Shelly.Reboot`; the same conditions during
  `active_drain`, while transitioning, under manual override, within the
  cooldown, or over the daily cap issue none.
- `GET /api/script-status` includes the `memory` block.
- Full local CI gate green (lint, knip, file-size, assets, unit, Playwright).
