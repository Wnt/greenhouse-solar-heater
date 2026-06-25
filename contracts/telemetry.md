# Telemetry Contract — Epic #254 (issue #256)

**Status:** FINAL. W2 (server, issue #257) and W3 (device, issue #258) build in parallel against this document. Any field/type/topic/order change after this point must come back through W1.

## Problem this contract solves

The device emits a full ~40-field snapshot on `greenhouse/state` on every tick (the pre-#254 hand-serializer in `shelly/control-logic.js` L976–1062, slimmed and renamed to `buildMinPayload` by this change). On a memory-constrained Pro 4PM the per-emit transient (the growing JSON result string) is proportional to payload length; during peak-solar transitions this pushed the Espruino JsVar pool over its ceiling and produced `out_of_memory` (the 2026-06 episode). W0 reproduced the FAIL on the spare Pro 2PM (`192.168.30.55`, pool 25186 B, identical to the 4PM) and proved that a **slimmed device payload** restores ≥3 KB headroom (PASS variant: `mem_free 4270 B`).

**Design decision (W0 (c), confirmed here):** the device drops the *physically observable* state (`valves`, `actuators`) — the server reassembles those natively from Shelly relay status — and keeps the *decision/transient* state it uniquely knows. Raw `temps` stay on the device payload (the device already polls them; they are cheap and are the canonical source the server persists). The byte-shape that WebSocket clients and `mqtt-bridge` consume on `greenhouse/state` is **unchanged** — reassembly happens server-side before broadcast/persist.

Two wire shapes exist after this change:

| Shape | Topic | Producer | Consumer |
|---|---|---|---|
| **Minimal device payload** (§1) | `greenhouse/state/min` (NEW) | device (`emitStateUpdate`) | server `mqtt-bridge` only |
| **Full assembled payload** (§2) | `greenhouse/state` (UNCHANGED shape) | server `mqtt-bridge` (re-emit) | WS clients, DB persistence, notifications, anomaly ring buffer |

### Topic decision — new `greenhouse/state/min`, NOT reusing `greenhouse/state`

W0 left the topic choice to W1. **Use a new topic `greenhouse/state/min` for the device → server minimal payload, and keep `greenhouse/state` as the server-assembled full payload.** Rationale:

1. **`greenhouse/state` is retained (`retain: true`).** Many consumers attach to it directly: `mqtt-bridge` for the live feed, and the broker hands the retained message to any late subscriber (preview pods, the device's own reconnect probes, ad-hoc `mosquitto_sub` debugging). If the device started publishing the *minimal* shape onto `greenhouse/state`, every one of those consumers would receive a payload missing `valves`/`actuators`/`controls_enabled`/`manual_override` and break. Keeping the full shape on `greenhouse/state` means **no consumer other than `mqtt-bridge` changes**.
2. **The server is now the authoritative producer of the retained full state.** It re-publishes the assembled payload to `greenhouse/state` (retain: true) so the retained message always reflects the complete picture (relay status merged in). The device no longer writes `greenhouse/state` at all.
3. **Clean separation of concerns.** `greenhouse/state/min` is an internal device→server channel; `greenhouse/state` is the public contract. A debugger can `mosquitto_sub -t 'greenhouse/state/min'` to see exactly what the device knows vs. what the server adds.

---

## 1. DEVICE → SERVER: minimal payload

### Topic / QoS / retain

| Property | Value | Note |
|---|---|---|
| Topic | `greenhouse/state/min` | NEW. Device-internal → server only. |
| QoS | `1` | Same as today's `greenhouse/state`. |
| retain | `true` | A reconnecting server must immediately see the last device decision state; matches today's behaviour. |
| Publisher | device `emitStateUpdate()` in `shelly/control.js` | Replaces the pre-#254 `MQTT.publish(STATE_TOPIC, buildMinPayload(...), 1, true)` (the builder was a full-snapshot serializer before this change; same call site). |

### Field schema

The device emits **exactly** these top-level keys, in **exactly this order** (order is not semantically required by JSON, but W3 must emit them in this order so the hand-serialized string stays diff-stable against tests):

| # | Field | JSON type | Shape / values | Source on device |
|---|---|---|---|---|
| 1 | `ts` | number | epoch **milliseconds** (`Date.now()`) | device clock |
| 2 | `mode` | string | lowercased mode: `idle` \| `solar_charging` \| `greenhouse_heating` \| `active_drain` \| `emergency_heating` | `st.mode.toLowerCase()` |
| 3 | `transitioning` | boolean | true while a valve/actuator transition is in progress | `st.transitioning` |
| 4 | `transition_step` | string \| null | current scheduler step label, or `null` | `st.transition_step \|\| null` |
| 5 | `temps` | object (5 keys) | `{ collector, tank_top, tank_bottom, greenhouse, outdoor }`, each `number \| null` | `st.temps.*` (device polls `Temperature.GetStatus`) |
| 6 | `flags` | object (3 keys) | `{ collectors_drained: bool, emergency_heating_active: bool, greenhouse_fan_cooling_active: bool }` | `st.collectors_drained`, `st.emergency_heating_active`, `!!st.greenhouse_fan_cooling_active` |
| 7 | `opening` | string[] | valve names currently inside their 20 s opening window, ordered by `VALVE_NAMES_SORTED` | `buildMinPayload` `opening` loop |
| 8 | `queued_opens` | string[] | FIFO of valves waiting for an opening slot | `st.valvePendingOpen.slice(0)` |
| 9 | `pending_closes` | object[] | `[{ valve: string, readyAt: number /* unix SECONDS */ }]` | `buildMinPayload` `pendingCloses` loop |
| 10 | `cause` | string | transition cause: `boot` \| `automation` \| `forced` \| `safety_override` \| `watchdog_auto` \| `user_shutdown` \| `drain_complete` \| `failed` | `st.lastTransitionCause \|\| "boot"` |
| 11 | `reason` | string \| null | evaluator decision code (`solar_enter`, `freeze_drain`, `ggr_shutdown`, …), `null` for non-evaluator paths | `st.lastTransitionReason \|\| null` |
| 12 | `eval_reason` | string \| null | live per-tick evaluator reason (distinct from `reason`) | `st.last_eval_reason \|\| null` |
| 13 | `held` | string \| null | live guard diagnostic; `null` when nothing is suppressing a wanted action | `st.last_held \|\| null` |

**Fields intentionally REMOVED from the device payload** (server reassembles — see §2): `valves`, `actuators`, `controls_enabled`, `manual_override`.

### Exact serialization the device must emit

W3 keeps the hand-serialized, append-per-field style of the pre-#254 serializer (no full-object materialization — that is the whole point of the memory fix). Concretely, the slimmed builder, named `buildMinPayload`, returns:

```js
return "{\"ts\":" + JSON.stringify(now) +
  ",\"mode\":" + JSON.stringify(st.mode.toLowerCase()) +
  ",\"transitioning\":" + JSON.stringify(st.transitioning) +
  ",\"transition_step\":" + JSON.stringify(st.transition_step || null) +
  ",\"temps\":" + JSON.stringify({
    collector: st.temps.collector,
    tank_top: st.temps.tank_top,
    tank_bottom: st.temps.tank_bottom,
    greenhouse: st.temps.greenhouse,
    outdoor: st.temps.outdoor
  }) +
  ",\"flags\":" + JSON.stringify({
    collectors_drained: st.collectors_drained,
    emergency_heating_active: st.emergency_heating_active,
    greenhouse_fan_cooling_active: !!st.greenhouse_fan_cooling_active
  }) +
  ",\"opening\":" + JSON.stringify(opening) +
  ",\"queued_opens\":" + JSON.stringify(queuedOpens) +
  ",\"pending_closes\":" + JSON.stringify(pendingCloses) +
  ",\"cause\":" + JSON.stringify(st.lastTransitionCause || "boot") +
  ",\"reason\":" + JSON.stringify(st.lastTransitionReason || null) +
  ",\"eval_reason\":" + JSON.stringify(st.last_eval_reason || null) +
  ",\"held\":" + JSON.stringify(st.last_held || null) +
  "}";
```

W3 must **remove** the `valves`, `actuators`, `controls_enabled`, `manual_override` lines and the `mo` local. The `dc` (deviceConfig) argument may become unused for serialization — keep the signature `(st, dc, now)` to avoid churn at the call site unless W3 also updates `emitStateUpdate`; either is fine as long as `buildSnapshotFromState` (the playground/test wrapper) and the bootstrap-history snapshot are regenerated to match (`npm run bootstrap-history`).

Espruino constraints unchanged: ES5 only, `var`, no banned `Array.*`. `pending_closes` and `queued_opens` use `.push` / `.slice(0)` exactly as today (both allowed).

### Size budget

| Variant | Approx serialized size |
|---|---|
| Today's full `greenhouse/state` | ~700–900 B (W0 measured ~880 B/emit transient on hardware) |
| **Minimal `greenhouse/state/min`** | **~150–300 B** typical; worst case (all valve arrays populated, long reason codes) < ~400 B |

The removed `valves`+`actuators` objects are the bulk of the fixed cost; the kept decision fields are booleans, short enums, and small valve-name arrays. The minimal payload comfortably clears W0's ≥3 KB headroom target on the spare 2PM. **W3 must re-run W0's PASS harness (`scripts/spare-2pm-memcheck.mjs`) with the FINAL field set above and confirm `mem_free ≥ 3072 B`** before the contract is considered honoured on-device.

---

## 2. SERVER → CONSUMERS: assembled `greenhouse/state` (BYTE-COMPATIBLE)

`mqtt-bridge` builds the full payload from (a) the minimal device payload, (b) native Shelly relay status (§3), and (c) device config. It then:

1. **Re-publishes** it to `greenhouse/state` with `{ qos: 1, retain: true }` so the retained public state is always complete. *(NEW publish — gated by `PREVIEW_MODE`: preview pods must NOT publish. See `isPreviewMode()`.)*
2. Feeds it into the **existing** `handleStateMessage(payload)` path unchanged — `insertSensorReadings(temps)`, `detectStateChanges` (mode/valve/actuator/overlay), `enrichState` (`manual_override` merge), WS broadcast, notifications, anomaly ring buffer.

> **Critical:** the object handed to `handleStateMessage` / `broadcastState` / `insertStateEvent` must be **field-for-field identical** to today's payload. `detectStateChanges` reads `payload.mode`, `payload.valves[v]`, `payload.actuators[a]`, `payload.flags.greenhouse_fan_cooling_active`, `payload.temps`, `payload.cause`, `payload.reason`. `enrichState` overwrites `manual_override`. All must be present with the exact names/shapes below.

### Full payload field shape (UNCHANGED from today)

Top-level key order as emitted by the pre-#254 full serializer (L1010–1061). The server SHOULD emit in this order for diff-stability, but consumers do not depend on order:

```
ts, mode, transitioning, transition_step, temps, valves, actuators,
flags, controls_enabled, manual_override, opening, queued_opens,
pending_closes, cause, reason, eval_reason, held
```

### Per-field source map

| Field | Type / shape | Source | Notes |
|---|---|---|---|
| `ts` | number (epoch ms) | **device-minimal** `ts` | `handleStateMessage` falls back to `new Date()` if absent. |
| `mode` | string (lowercased) | **device-minimal** `mode` | drives `insertStateEvent('mode', …)`. |
| `transitioning` | boolean | **device-minimal** | |
| `transition_step` | string \| null | **device-minimal** | |
| `temps` | `{collector,tank_top,tank_bottom,greenhouse,outdoor}` number\|null | **device-minimal** `temps` | persisted by `insertSensorReadings`; canonical sensor source. |
| `valves` | `{vi_btm,vi_top,vi_coll,vo_coll,vo_rad,vo_tank,v_air}` boolean | **native Shelly relay status** (§3) | `true` = open. Order/keys exactly as listed. |
| `actuators` | `{pump,fan,space_heater,immersion_heater}` boolean | **native Shelly relay status** (§3) | key order: `pump, fan, space_heater, immersion_heater` (matches today's wire order). |
| `flags` | `{collectors_drained,emergency_heating_active,greenhouse_fan_cooling_active}` boolean | **device-minimal** `flags` | `greenhouse_fan_cooling_active` drives the `overlay` event. |
| `controls_enabled` | boolean | **device config** `deviceConfigRef.getConfig().ce` | the server already owns this (`device-config.js`). |
| `manual_override` | `{active:true,expiresAt,forcedMode}` \| null | **device config** via `enrichState` | `enrichState` already computes this from `cfg.mo`; it OVERWRITES whatever is on the payload. Server may set `null` initially; `enrichState` is the source of truth at broadcast time. |
| `opening` | string[] | **device-minimal** | |
| `queued_opens` | string[] | **device-minimal** | |
| `pending_closes` | `[{valve,readyAt}]` (readyAt = unix seconds) | **device-minimal** | |
| `cause` | string | **device-minimal** | `insertStateEvent` mode opts. |
| `reason` | string \| null | **device-minimal** | `insertStateEvent` mode opts. |
| `eval_reason` | string \| null | **device-minimal** | |
| `held` | string \| null | **device-minimal** | |

**Summary:** 13 fields come straight from the device-minimal payload (§1); `valves` + `actuators` (2) come from native relay status (§3); `controls_enabled` + `manual_override` (2) come from device config (already wired in `device-config.js` / `enrichState`).

---

## 3. Server-side source for `valves` / `actuators`: native Shelly Gen2 relay status (MQTT)

### Mechanism — subscribe to native Shelly status MQTT topics (NOT HTTP polling)

The server **subscribes** to the native Shelly Gen2 per-switch status topics that each device already publishes, and keeps an in-memory relay cache. It does **not** add HTTP `Switch.GetStatus` polling.

Rationale:
- **No HTTP RPC for state** is a hard CLAUDE.md rule ("Device communication flows through MQTT … No direct HTTP RPC to Shelly from the server for state"). Native MQTT status is the MQTT-native way to read relay state; HTTP polling would violate the rule and add per-tick latency.
- Shelly Gen2 devices with MQTT enabled publish each switch's status under their device topic. Subscribing is push-based and always-current — no polling cadence to tune.
- The relay cache is updated asynchronously as the broker delivers status messages; assembly reads the latest cached value at the moment a device-minimal payload arrives.

### Native topics to subscribe

Each Shelly Gen2 device publishes its switch status to `<device-topic>/status/switch:<id>` (RPC-status notification, JSON body `{ "id": <n>, "output": <bool>, ... }`). The `<device-topic>` is the MQTT topic prefix configured on each device. The server subscribes to the wildcard `+/status/+` at QoS 1 and filters to switch-status topics.

> **Provisioning (implemented in `shelly/deploy.sh`).** Native per-switch status is published **only** when a device has MQTT enabled with `status_ntf:true`. `deploy.sh`'s provisioning step (`provision_mqtt`) sets, on the 4PM + the four valve 2PMs, `Mqtt.SetConfig {enable:true, status_ntf:true, topic_prefix:<device-ip>}` and reboots each device to apply (MQTT config changes require a reboot). Setting **`topic_prefix` to the device's own IP** is deliberate: it lets the server resolve a status topic back to a device IP via its `topic_prefix == IP` path, so no out-of-band MAC→IP map is needed. The relay→logical-name map below is keyed by **(device IP, switch id)**, independent of the topic-prefix string. Provisioning runs **before** the control script is updated, so a device that cannot be provisioned aborts the deploy with the previous control script still in place.

### Relay → logical-name map

**Actuators — Shelly Pro 4PM `192.168.30.50`** (from `shelly/control.js` L196–200):

| switch id | logical actuator | `actuators` key |
|---|---|---|
| 0 | pump | `pump` |
| 1 | fan | `fan` |
| 2 | immersion heater | `immersion_heater` |
| 3 | space heater | `space_heater` |

> Note the key-order vs. id-order mismatch: on the wire `actuators` is `{pump, fan, space_heater, immersion_heater}` (space before immersion), but relay **id 2 = immersion_heater** and **id 3 = space_heater**. Map by id, then place into the fixed key order.

**Valves — four Shelly Pro 2PM** (from `VALVES` in `shelly/control.js` L55–64 and `system.yaml` `modes.*.valve_states`):

| device IP | switch id | valve name | `valves` key |
|---|---|---|---|
| 192.168.30.51 | 0 | VI-btm | `vi_btm` |
| 192.168.30.51 | 1 | VI-top | `vi_top` |
| 192.168.30.52 | 0 | VI-coll | `vi_coll` |
| 192.168.30.52 | 1 | VO-coll | `vo_coll` |
| 192.168.30.53 | 0 | VO-rad | `vo_rad` |
| 192.168.30.53 | 1 | VO-tank | `vo_tank` |
| 192.168.30.54 | 0 | V-air | `v_air` |

`192.168.30.54` id 1 is a reserved spare (passive T joint; spec 024) — **not** part of the payload. `192.168.30.55` is the spare controller — never read it.

`valves[key] = !!output` (true = open). `actuators[key] = !!output` (true = on).

### Freshness / ordering guarantees and stale/missing fallback

Assembly is triggered by a **device-minimal payload** arriving on `greenhouse/state/min`. At that instant the server reads its relay cache.

**Ordering note:** the device already commands relays BEFORE it emits its (now minimal) state update on most paths, and relay status notifications and the minimal payload travel the same broker. There is no hard cross-topic ordering guarantee, but in practice a relay flip and the device's subsequent `emitStateUpdate` are milliseconds apart and the cache converges within one tick. The contract therefore treats relay status as **eventually-consistent, last-write-wins per (device,id)**.

**Freshness rule:** each cached relay entry carries a `lastSeen` timestamp. When assembling, for each relay:

1. **Fresh** (`lastSeen` within the staleness window, default **120 s** — comfortably longer than a Shelly's periodic status republish and a single state tick): use the cached `output`.
2. **Stale or never-seen:** fall back, in order:
   - **(a) last assembled `greenhouse/state`** value for that valve/actuator (`previousState.valves[k]` / `previousState.actuators[k]`), if present — preserves the last known-good observation rather than fabricating a flip;
   - **(b)** if there is no previous state either, default to **`false`** (closed / off) — the safe default matching IDLE, and matching the device's own boot baseline.

The fallback MUST NOT block assembly: a missing relay never drops the whole payload. W2 logs (at `warn`, rate-limited) when any relay is served from fallback, so a silently-offline valve controller is observable. The staleness window is a single named constant in `mqtt-bridge` (e.g. `RELAY_STALE_MS = 120000`) so it is tunable without code archaeology.

**PREVIEW_MODE:** preview pods subscribe to the same native status topics (read-only) and assemble for their own WS clients, but MUST NOT re-publish to `greenhouse/state` and MUST NOT persist — identical gating to the existing `isPreviewMode()` checks.

#### Per-relay freshness classification (as shipped)

`assembleState(min, opts)` returns `{ payload, freshness }` (the `payload` is the byte-identical full state of §2; **`freshness` is never folded into `payload`** — asserted by test). `freshness` is `{ [logicalName]: { status, ageMs } }` for every valve + actuator, with `status ∈ { 'fresh', 'stale', 'missing' }` (the `FRESH` / `STALE` / `MISSING` string constants exported from `relay-status.js`):

- **`fresh`** — cached `lastSeen` within the staleness window; `ageMs` = cache age. Cached `output` is used.
- **`stale`** — cached but older than the window; `ageMs` = cache age. Served from the §3 fallback chain (previous-state, else `false`).
- **`missing`** — never seen for that `(ip,id)`; `ageMs` = `null`. Served from fallback.

#### RELAY_TOPIC_MAP fail-loud startup assertion

Relay status arrives on `<topic_prefix>/status/switch:<id>`; the server must resolve each prefix back to the device IP keyed in the §3 wiring map (`RELAY_MAP` in `relay-status.js`) before any relay value can be placed. That resolution needs `RELAY_TOPIC_MAP` in prod config (or each device's `topic_prefix` set equal to its IP). To stop a silently-misconfigured deployment from serving an entire device from fallback unnoticed:

- `mqtt-bridge.start()` calls `assertRelayTopicCoverage()` **first, before `mqtt.connect`**. It evaluates `checkTopicMapCoverage()` → `{ ok, missing }` (the set of `RELAY_MAP` IPs not resolvable via `prefixToIp` or `topic_prefix == IP`).
- **Non-preview:** if `ok === false`, `start()` **throws** `Error('RELAY_TOPIC_MAP does not resolve every device IP in RELAY_MAP … Missing: <ips>')` and aborts boot. Fail-loud — a prod pod will not come up partially blind.
- **Preview:** logs at `error` level and continues (a passive observer may legitimately lack the prod map).
- `mqttBridge.getRelayTopicCoverage()` exposes the same `{ ok, missing }` for health probes.

**Prod coverage is supplied by config, not left to chance.** Because the server cannot observe a device's `topic_prefix` at boot, the gate keys off `RELAY_TOPIC_MAP`. The prod app-config (`deploy/terraform/main.tf`) therefore sets `RELAY_TOPIC_MAP` to an **identity map over the RELAY_MAP IPs** (`.50`–`.54`) — which both satisfies the gate and (redundantly with the `topic_prefix == IP` provisioning) resolves status at runtime. Whenever `RELAY_MAP` gains a device, add its IP here.

**Deploy ordering (fail-loud without an outage).** Under the `Recreate` rollout strategy (forced by the openvpn `hostPort`), an in-pod `throw` would crash-loop the new pod with no serving fallback. So the deploy workflow (`.github/workflows/deploy.yml`) **preflights the same `checkTopicMapCoverage()`** — on the new image, fed the **live** app-config, in a throwaway `Job` that never binds the hostPort — **before** `kubectl set image`. A coverage gap fails the preflight and aborts the deploy, leaving the previous deployment **and** the Shelly control scripts untouched. The in-pod gate remains as the last line of defense.

#### Stale-relay event suppression (state_events)

Per-relay freshness gates whether a valve/actuator change is written to `state_events`. `detectStateChanges(ts, prev, curr, _db, prevFreshness, currFreshness)` takes the freshness maps of the prior and current assembled ticks; `handleStateMessage` threads them through and `mqtt-bridge` keeps `previousFreshness` alongside `previousState`. A valve/actuator row is written **only when the relay was `fresh` on BOTH sides** (`bothFresh(prev, curr, name)`):

- **cold-cache restart burst** (`missing` → `fresh`): suppressed — prev not fresh. Prevents a flood of synthetic "valve opened" events when the relay cache repopulates after a server restart.
- **stale-window flip** (curr `stale` or `missing`): suppressed — curr not fresh. A relay served from fallback never authors an event.
- **genuine `fresh` → `fresh` transition:** logged as before.
- **legacy callers passing neither freshness map** (device-authored full-state callers, e.g. a direct `handleStateMessage` in a test): fall back to diff-everything — unchanged behaviour.

`mode` and `overlay` events are **device-authored** and are never gated by relay freshness — they are detected exactly as before.

---

## 4. Relay-health sidecar (ADDITIVE — `greenhouse/state` stays byte-identical)

The per-relay freshness map (§3) is surfaced to clients and operators through a **fully additive sidecar**: a new WS frame type and a new MQTT topic. **No freshness/health signal is ever folded into `greenhouse/state` or its WS `state` frame — both remain byte-identical to today** (asserted by test). A client that ignores the new frame type / topic is completely unaffected.

### WS frame

```
{ type: 'relay_health', data: { ts, relays } }
```

- `relays` = the §3 freshness map: `{ [logicalName]: { status: 'fresh'|'stale'|'missing', ageMs: number|null } }` for every valve + actuator.
- Broadcast on every WS-broadcasting tick, **immediately AFTER the `{ type:'state', data }` frame** (frame ordering is asserted). Additive type — existing consumers that switch on `type` and don't handle `relay_health` skip it.
- **Not PREVIEW_MODE-gated** — preview pods still feed their own dashboards, the same policy as the WS `state` frame.

### MQTT topic

| Property | Value |
|---|---|
| Topic | `greenhouse/relay-health` (NEW) |
| Payload | `{ ts, relays }` (same `relays` shape as the WS frame) |
| QoS / retain | `{ qos: 1, retain: true }` |
| Publisher | server `publishRelayHealth` |

**PREVIEW_MODE:** the MQTT publish is gated **exactly like the `greenhouse/state` republish** — `publishRelayHealth` early-returns in preview mode / when disconnected, so preview pods never publish. (The WS broadcast above is the un-gated half; the split mirrors the existing state-frame vs. state-republish policy.)

---

## Test obligations (for W2 / W3, enforced per repo test-first policy)

- **W3 (device):** unit test that the slimmed `buildMinPayload` emits exactly the §1 keys and omits `valves`/`actuators`/`controls_enabled`/`manual_override`; regenerate `playground/assets/bootstrap-history.json` (`npm run bootstrap-history`) so the drift test passes; re-run the spare-2PM PASS harness and record `mem_free ≥ 3072 B` (label hardware-measured, date-stamped).
- **W2 (server):** unit test that, given a §1 minimal payload + a populated relay cache, the assembled payload is byte-identical (per-field) to a reference full payload; test the staleness fallback chain (fresh → previous-state → false); test that `detectStateChanges` still fires mode/valve/actuator/overlay events off the assembled payload; test PREVIEW_MODE does not re-publish. Existing `mqtt-bridge` tests that feed a full `greenhouse/state` payload should be repointed to feed `greenhouse/state/min` + relay cache.

---

## Implementation notes (post-contract, W4)

The wire shapes, topics, field order, QoS/retain, and source maps above shipped **exactly as specified**. One implementation detail differs from the original W1 prose (an implementation choice, not a contract change):

- **Device builder name.** The slimmed device serializer ships as **`buildMinPayload`** in `shelly/control-logic.js` (with `buildSnapshotFromState` retained as the playground/test wrapper) — §1/§2 are written against that name. The pre-#254 builder was a full-snapshot serializer at the same call site; the emitted bytes of the §1 minimal payload are exactly as specified above. The full-payload key order in §2 is the shape the server reassembles to; `server/lib/relay-status.js` comments anchor to that historical full-snapshot shape, not to a separate device function.
- **Server assembler location.** §2/§3 describe assembly "in `mqtt-bridge`". The assembler itself lives in **`server/lib/relay-status.js`** (`assembleState` + the relay cache + topic parsing + the canonical wiring constants — `RELAY_MAP`, `VALVE_KEYS`, `ACTUATOR_KEYS`, `KEY_ORDER`, `ACTUATOR_4PM_BY_ID` — that encode the §3 relay→logical-name maps and the §2 full-payload key order as the single source of truth, with `ACTUATOR_4PM_BY_ID` the one place encoding the id↔key inversion noted in §3); `mqtt-bridge.js` `handleStateMin` orchestrates it. The relay-status wildcard subscription is `+/status/+` (the narrower `+/status/switch:+` is an invalid MQTT filter — `+` matches a whole level — so it cannot match the partial `switch:<id>` segment); `parseStatusTopic` then matches only `*/status/switch:<digits>` so it never collides with `greenhouse/*` topics.

**Consumer verification (W4).** The playground consumes the server-assembled WS `{type:'state', data}` frame in `playground/js/data-source.js` `_handleState`, which reads `data.valves`/`data.actuators`/`data.controls_enabled`/`data.manual_override` plus the device pass-through fields — all present on the assembled frame. No playground source change was required (verified no-op). The System Logs export (`playground/js/main/logs-clipboard.js`) reads only pass-through/assembled fields. Full-chain coverage: `tests/e2e/state-assembly.spec.js` (device-min publish + relay status → assembled 17-key WS frame), `tests/state-assembly.test.js` (byte-golden of the assembled payload vs. the historical shape), and the frontend `tests/frontend/copy-logs.spec.js` + `live-display.spec.js` (assembled WS frame → render + System Logs export). The e2e harness does not serve the SPA, so "real server → browser render" is covered by the byte-golden guaranteeing the assembled frame is identical to the shape the frontend suite feeds.
