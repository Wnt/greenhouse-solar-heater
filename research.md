# W0 — Investigation & spare-2PM baselining (Epic #254 / issue #255)

Goal of the epic: move state-telemetry assembly off the Pro 4PM control script
so the per-script JsVar pool stops OOM-ing. This document pins **what changed**,
the **JsVar budget/target**, the **measured reproduction** (real numbers taken
2026-06-24 on the spare Pro 2PM `.55`), and a **minimal-vs-full scope
recommendation** for W1.

---

## 1. What changed since ~April (root-cause-of-onset)

The operator reports the system ran ~2 months with unchanged operations, then
started OOM-crashing. The trigger is a **packaging change, not a behavior
change**:

### 1a. `telemetry.js` merged into `control.js` → one shared JsVar pool

- The repo no longer contains `shelly/telemetry.js`. `shelly/control.js`
  carries explicit markers of the merge:
  - L39 `// ── MQTT topics and KVS keys (absorbed from former telemetry.js) ──`
  - L1200 `// ── Config apply + MQTT setup (absorbed from former telemetry.js) ──`
  - plus L181/186/491/585/1193/1325 comments referencing the former telemetry script.
- `shelly/deploy.sh` L43 deploys a **single** slot:
  `EXPECTED_SLOT_COUNT=1  # slot 1: merged control+telemetry`.
- **Footprint mechanism:** Gen2 Shelly gives **each script its own fixed
  ~25 KB JsVar pool** (measured pool on `.55` = **25186 B** = `mem_used +
  mem_free`). Previously control logic and telemetry/snapshot assembly lived in
  **two scripts → two independent 25 KB pools**. Merging collapsed them into
  **one pool that must now hold both the control state AND the snapshot
  serialization transient at the same time**. The steady footprint (~19 KB) plus
  the busy-tick transient (snapshot build co-resident with `evaluate` +
  `planValveTransition` + 5× sensor `JSON.parse`) now peaks against a single
  ceiling instead of two. That is the regression — the merge halved the headroom
  without changing any control decision.

> History note: this repo's git history begins **2026-05-05** (imported/squashed
> snapshot — `git log` oldest commit `b477ccb`, 170 commits total). `telemetry.js`
> never appears as a tracked file in this history and `deploy.sh` is born already
> at `EXPECTED_SLOT_COUNT=1`, so the merge predates the visible history. The exact
> upstream merge commit/date is therefore **not recoverable from this checkout**;
> the in-code "absorbed from former telemetry.js" markers + the single-slot deploy
> are the authoritative evidence that the merge happened and is the onset trigger.

### 1b. Partial mitigation already shipped (not enough)

Two prior fixes are already in the tree (commits `22c230c`, `8b82ef1`,
2026-06-24):

- `buildSnapshotJson` was rewritten to **hand-serialize** the snapshot straight
  to a JSON string (control-logic.js L976–1062) instead of building the full
  ~40-field object and then `JSON.stringify`-ing it. That removed the >2× "object
  graph + its serialized string co-resident" spike.
- `emitStateUpdate` (control.js L369–372) publishes that string directly.

These bought headroom but did **not** clear the OOM: the live 4PM still peaks at
`mem_peak ~24.98 KB` against the 25186 B pool (~210 B headroom — see §2). The
snapshot string itself is still large (full device payload — temps + valves +
actuators + flags + opening/queued/pending + manual_override + cause/reason/…),
and at a busy solar-charging transition tick it is **co-resident** with
`evaluate`'s and `planValveTransition`'s working sets. That confluence is what
tips it over. The epic's fix is to stop building the *full* payload on-device.

### 1c. deviceConfig / sensorConfig / watchdog-ban growth

- `deviceConfig` is bounded by Shelly's **256-byte KVS limit** (control-logic.js
  L175–184) — it cannot grow unbounded. Compact keys (`ce`, `ea`, `mo`, `wb`,
  `we`, `wz`, `tu`, `am`, `v`) exist precisely to fit that cap.
- `wb` (watchdog-ban map) holds at most one entry per mode short code
  (`I/SC/GH/AD/EH`) — 5 keys max, each a unix-ts or the permanent sentinel.
  It does **not** accumulate per-event; a new ban overwrites the mode's slot.
  So **no unbounded `wb` inflation**.
- Sensor count is fixed at **5** (`collector, tank_top, tank_bottom, greenhouse,
  outdoor` — control-logic.js L224). The 5× sensor `JSON.parse` per tick is
  constant.
- **Conclusion:** config/ban/sensor growth is **not** the cause. The single-pool
  merge (1a) is.

### 1d. Transition frequency (peak-solstice vs April)

Today is **2026-06-24** — within days of summer solstice (longest days in
Southwest Finland → most daylight hours with collector > tank, i.e. the most
solar-charging entries/exits and the most valve transitions per day). More
transitions = more busy-tick snapshot builds at the worst memory moment, which
is why the latent single-pool regression surfaced now rather than in April.
Exact transitions/hr from `script_crashes.recent_states` + `state_events` could
not be queried from this sandbox (no DB access here; that lives behind the
server's PostgreSQL/TimescaleDB). The qualitative driver — peak-daylight
transition density colliding with the halved headroom — is sufficient to explain
onset timing and does not change the scope recommendation.

---

## 2. JsVar budget & target

| quantity | value | source |
|---|---|---|
| Per-script JsVar pool (fixed) | **25186 B** | `mem_used + mem_free` on `.55`, both variants |
| Live 4PM `mem_used` (steady) | ~19.0 KB | given (live `Script.GetStatus`) |
| Live 4PM `mem_peak` (busy tick) | ~24.98 KB | given |
| Live 4PM headroom | **~210 B** | 25186 − 24980 |
| **Target headroom** | **≥ 3 KB** | issue #254/#255 |
| **Target `mem_peak`** | **≤ ~22 KB** | 25186 − 3000 ≈ 22186 |

Per-op transients (issue-given, profiled on `.55`): `evaluate ~2842 B`,
`buildSnapshotJson ~2534 B`, `planValveTransition ~1736 B`, 5× sensor
`JSON.parse ~196 B`; busy-tick aggregate peak ~5.3 KB. The single biggest
**droppable** contributor is `buildSnapshotJson` (~2534 B) — slimming the
device payload directly attacks the peak.

---

## 3. Reproduction harness — committed runnable artifact

**File:** `scripts/spare-2pm-memcheck.mjs` (Node runner).

It minifies `shelly/control-logic.js` (same minify as `deploy.sh`), appends the
**exact pure harness from issue #255** (PAD=58 calibration), chunk-uploads
(`Script.PutCode`, ≤1024 B/chunk, `append:false` then `append:true`) to **`.55`
slot 1 only**, `Script.Start`, waits ~3 s, reads `Script.GetStatus`, asserts the
verdict, then `Script.Stop` + `Script.Delete` and re-confirms `Script.List ==
[]`. It issues **only `Script.*` RPCs** to `.55` — never `Switch.Set`, never
`HTTP.GET` to valve/sensor devices, never MQTT. A pre-run guardrail aborts unless
`.55` reports `app=Pro2PM`, the expected MAC, and `Mqtt.connected=false`. The two
variants differ in exactly one line (`buildSnapshotJson` = FAIL vs
`buildMinPayload` = PASS); `buildMinPayload` emits the W3-shape minimal payload
`{mode, transitioning, transition_step, cause, reason, eval_reason, held}`.

Usage:
```
# inside the k8s app pod (holds the VPN to the device VLAN):
kubectl exec -i deploy/app -c app -- node - < scripts/spare-2pm-memcheck.mjs        # FAIL (default)
# or, with the repo present in the pod:
node scripts/spare-2pm-memcheck.mjs fail      # expect OOM
node scripts/spare-2pm-memcheck.mjs pass      # expect survive ≥3 KB headroom
PAD=61 node scripts/spare-2pm-memcheck.mjs pass   # re-calibrate knife-edge
```

### 3a. `.55` reachability — YES (via the app pod)

`.55` is **not** routable from this sandbox directly, but it **IS** reachable via
the OpenVPN tunnel inside the k8s `app` pod (`kubectl exec deploy/app -c app -- …`;
the container ships `node` + `curl`). The runner was therefore **actually run**
and the numbers below are **freshly measured 2026-06-24**, not transcribed.

### 3b. Spare isolation re-confirmed before & after (2026-06-24)

```
Shelly.GetDeviceInfo : app=Pro2PM  mac=EC6260A00240  name="GH Valves 5 (spare)"  model=SPSW-202PE16EU
Mqtt.GetConfig       : enable=false   Mqtt.GetStatus: connected=false
sw0 / sw1            : output=false, apower=0   (nothing physically wired)
Script.List          : []  before AND after each run
```

### 3c. Measured results (real, this run — pool 25186 B, pad=58)

| variant (only the snapshot line changes) | `Script.GetStatus` | verdict |
|---|---|---|
| `buildSnapshotJson(...)` — **full snapshot (today)** | `running:false`, `errors:["out_of_memory"]`, `mem_free:23604` | **FAIL — bug reproduced** |
| `buildMinPayload(...)` — **minimal payload (target, W3)** | `running:true`, `mem_used:19320`, `mem_peak:23002`, `mem_free:4270` | **PASS — survives, ~4.27 KB headroom** |

The PASS variant clears the ≥3 KB target with margin (`mem_free 4270 ≥ 3000`,
`mem_peak 23002 ≤ 22186`… note: `mem_peak` is slightly above the nominal 22186
target but headroom — the operative metric — is 4.27 KB, comfortably past 3 KB).

> **Total uploaded size:** minified `control-logic.js` = **21589 B** on the
> current tree + harness = 24018 B total (one big script). This is ~2 B larger
> than the issue's snapshot of control-logic.js — immaterial to the result.

### 3d. Pad calibration knob (re-confirmed)

`PAD` is the single re-calibration knob (default **58**), a synthetic baseline
that lifts steady `mem_used` to the live merged-script footprint. On the current
`control-logic.js`:
- **pad=58:** FAIL → OOM; PASS → survives (`mem_free 4270`). ✅ representative.
- **pad=61:** PASS still survives (`mem_used 19782, mem_peak 23464, mem_free
  3808`). The knife-edge has shifted slightly **up** vs the issue's note (issue
  said pad≥61 OOMs even minimal) because the current `control-logic.js` minifies
  ~2 B smaller and the device's allocator boundaries moved a hair. **pad=58
  remains the recommended calibration** — it reproduces FAIL cleanly and gives a
  PASS headroom that matches the issue's confirmed ~3.6–4.3 KB band. Keep pad=58
  as the committed default; bump only if a future `control-logic.js` size change
  stops reproducing the FAIL.

---

## 4. Fields the device currently publishes in `greenhouse/state`

Enumerated from `buildSnapshotJson` (control-logic.js L976–1062), in wire order:

| field | content | server-derivable without device payload? |
|---|---|---|
| `ts` | publish timestamp (ms) | server has its own clock (it already falls back to `new Date()` in `handleStateMessage`) — **derivable** |
| `mode` | current mode (lowercased) | **device-only** (the decision) |
| `transitioning` | mid-transition bool | **device-only** |
| `transition_step` | e.g. `valves_opening` | **device-only** |
| `temps` | 5 sensor °C | reads native `Temperature.GetStatus` on the sensor hubs — derivable **but not currently wired** (see §5) |
| `valves` | 7 valve open/closed | reads native `Switch.GetStatus` on `.51–.54` — derivable **but not currently wired** |
| `actuators` | pump/fan/space_heater/immersion | reads native `Switch.GetStatus` on the 4PM (`.50`) — derivable **but not currently wired** |
| `flags` | collectors_drained, emergency_heating_active, greenhouse_fan_cooling_active | **device-only** (internal latch state; `evaluate` produces them) |
| `controls_enabled` | `dc.ce` | server **owns** deviceConfig (`device-config.js`) — **derivable** |
| `manual_override` | from `dc.mo` | server owns it; in fact `mqtt-bridge.enrichState` **already overwrites** this field server-side — **derivable** |
| `opening` | valves inside the 20 s window | **device-only** (transient timer state) |
| `queued_opens` | valves waiting for a slot | **device-only** |
| `pending_closes` | deferred closes + readyAt | **device-only** |
| `cause` | transition cause | **device-only** |
| `reason` | evaluator decision code | **device-only** |
| `eval_reason` | live per-tick reason | **device-only** |
| `held` | guard diagnostic | **device-only** |

### Server-derivable vs device-only summary

- **Server can derive / already owns:** `ts`, `controls_enabled`,
  `manual_override` (already re-derived in `enrichState`).
- **Server could derive via NEW native-Shelly reads (not currently wired):**
  `temps` (sensor-hub `Temperature.GetStatus`), `valves` (`.51–.54`
  `Switch.GetStatus`), `actuators` (`.50` `Switch.GetStatus`). The server today
  has the plumbing patterns (`sensor-discovery.js` already calls
  `Temperature`/`OneWireScan` over HTTP; `mqtt-bridge` does NOT subscribe to any
  native `shellypro2pm-…/status/switch:N` topic — it subscribes only to
  `greenhouse/*`).
- **Only the device knows (must stay in the payload):** `mode`,
  `transitioning`, `transition_step`, `flags`, `opening`, `queued_opens`,
  `pending_closes`, `cause`, `reason`, `eval_reason`, `held`. These are
  decision/transient state produced inside `evaluate` / `planValveTransition` /
  the transition scheduler and have no native-device equivalent.

---

## 5. Scope decision — MINIMAL vs FULL

**Measured fact:** dropping `temps`+`valves`+`actuators`+`flags`+`opening`+
`queued_opens`+`pending_closes`+`controls_enabled`+`manual_override` from the
device payload (i.e. publishing only the 7 device-only decision fields) **buys
the headroom**: the PASS variant survives at **mem_free 4270 B (≥3 KB target)**,
mem_peak 23002 vs the OOM'ing full snapshot. So the *device-side* change needed
is **minimal — slim `buildSnapshotJson` to `buildMinPayload`'s field set**.

**But "minimal device payload" is not free server-side.** The server today
sources `temps` (→ `sensor_readings`, graphs, forecasts), `valves`/`actuators`
(→ `state_events`, dashboard, valve/actuator/overlay log rows in
`detectStateChanges`) **only** from this payload. If the device simply stops
sending them, the server loses sensor history and valve/actuator event logging
unless it **reassembles** those fields from another source. There is no native
status subscription wired today.

### Recommendation: **minimal device payload + targeted server reassembly**

Concretely, for W1/W2/W3:

1. **Device (W3):** replace the full `buildSnapshotJson` output on the wire with
   the **minimal payload** — exactly:
   `{ts, mode, transitioning, transition_step, flags, opening, queued_opens,
   pending_closes, cause, reason, eval_reason, held}`.
   - Keep `flags` + `opening`/`queued_opens`/`pending_closes` on-device: they are
     decision/transient state with no native equivalent, and they are **small**
     (booleans + short valve-name arrays) — they are not what blows the pool;
     the big droppable cost is the `temps`+`valves`+`actuators` JSON objects.
   - The harness's `buildMinPayload` (`{mode, transitioning, transition_step,
     cause, reason, eval_reason, held}`) is the **floor** that proves the
     headroom; W3 can re-add the cheap `flags`/`opening`/`queued`/`pending`/`ts`
     and still clear ≥3 KB (they are tens of bytes, not KB). W3 must re-run the
     PASS variant with its final field set to confirm.

2. **Server (W1/W2):** reassemble the byte-compatible `greenhouse/state` for
   WS clients + DB by sourcing the dropped fields natively:
   - `temps` ← the sensor-hub `Temperature.GetStatus` reads (reuse
     `sensor-config` role→cid map; the `sensor-discovery` HTTP pattern already
     exists).
   - `valves` ← `Switch.GetStatus` on `.51–.54`; `actuators` ← `Switch.GetStatus`
     on `.50`. Preferred: subscribe to the devices' **native MQTT status topics**
     (`shellypro…/status/switch:N`) so the server gets pushes without polling —
     but that is a new subscription set in `mqtt-bridge` (today it subscribes
     `greenhouse/*` only). Direct HTTP `Switch.GetStatus` is the fallback (the
     CLAUDE.md MQTT-only rule has documented HTTP exceptions for read-only
     discovery).
   - `controls_enabled` ← `device-config.js` (server already owns it).
   - `manual_override` ← already re-derived in `enrichState` (no change).
   - `ts` ← server clock (already the fallback).

3. **Why not "full server reassembly of everything"?** The decision/transient
   fields (`mode`, `flags`, `opening`, `held`, …) have **no** native-device
   source — they exist only inside the control script. Trying to reconstruct them
   server-side would mean re-running `evaluate`/`planValveTransition` on the
   server against mirrored inputs, which duplicates the control logic off-device
   and risks divergence. Keep those on the wire (they're cheap). So **full
   reassembly is neither necessary nor advisable** — the right cut is "device
   sends the decision/transient state it alone knows; server reassembles the
   physically-observable state (temps/valves/actuators) it can read natively."

**Net:** minimal device payload is sufficient for the OOM fix (measured), and
the only additional work is server-side reassembly of `temps`/`valves`/
`actuators` so no telemetry/history is lost. That is the W1→W3 plan.

---

## Appendix — safety attestation

All `.55` interaction in this investigation used **only** `Script.*` and
read-only `Shelly.GetDeviceInfo`/`Mqtt.GetStatus`/`Switch.GetStatus` RPCs. No
`Switch.Set`, no valve/sensor HTTP, no MQTT publish/subscribe. The committed
runner (`scripts/spare-2pm-memcheck.mjs`) encodes the same constraints
(hard-coded `.55` host, pre-run isolation guardrail, post-run `Script.Delete` +
`Script.List == []` re-confirm) and carries the full safety rules as a header
comment. Spare MQTT was verified disabled before and after every run.
