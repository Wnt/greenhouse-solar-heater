# Shelly Control Software Design

Design spec for the Shelly scripting layer that controls the solar thermal greenhouse heating system. All control runs locally without cloud dependency.

## Hardware & Network

| Device | Qty | Connection | Role |
|--------|-----|------------|------|
| Shelly Pro 4PM | 1 | Ethernet | Brain — runs control script, drives pump (O1), fan (O2), immersion heater (O3), space heater (O4) |
| Shelly Pro 2PM | 4 | Ethernet | Valve relays — no custom scripts, commanded via HTTP RPC |
| Shelly 1 Gen3 + Plus Add-on | 1 | WiFi | Sensor hub — up to 5x DS18B20 temperature sensors on 1-Wire bus |

All Pro devices connect via wired Ethernet to a Zyxel GS-108BV5 8-port switch. The 1 Gen3 sensor hub connects via WiFi. No cloud connection required — all communication is local HTTP RPC.

### Relay Mapping

**Pro 4PM (brain):**
- O1: Pump (Wilo Star Z20/4, 71W max)
- O2: Radiator fan (230V)
- O3: Immersion heater contactor (optional)
- O4: Space heater (2kW)

**Pro 2PM #1 — Input Manifold:**
- O1: VI-btm (tank bottom to pump)
- O2: VI-top (reservoir bottom to pump)

**Pro 2PM #2 — Mixed Manifold:**
- O1: VI-coll (collector bottom to pump, drain mode)
- O2: VO-coll (pump to collector bottom, charging mode)

**Pro 2PM #3 — Output Manifold:**
- O1: VO-rad (pump to radiator)
- O2: VO-tank (pump to tank, drain mode)

**Pro 2PM #4 — Collector Top:**
- O1: V_ret (collector top to reservoir, normal return)
- O2: V_air (collector top to open air, drain air intake) — wired as normally-open spring-return valve; relay ON = closed, relay OFF / power loss = open (fail-safe drain)

### Sensors (1 Gen3 + Add-on)

- T_collector — collector outlet (~280cm)
- T_tank_top — tank upper region (~185cm)
- T_tank_bottom — tank lower region (~10cm)
- T_greenhouse — greenhouse air
- T_outdoor — outside, shaded

### Flow Sensor Elimination

No physical flow sensor. Pump dry-run during drain is detected via the Pro 4PM's built-in power metering on the pump channel (O1). When the pump runs dry, power draw drops measurably. This keeps drain safety logic entirely local on the brain device with no network dependency.

## Scripting Platform

Shelly Gen2+ devices run **Shelly Script** — a subset of JavaScript on an Espruino interpreter. Key characteristics:

- Callback-based (no Promises, no async/await, no ES6 classes)
- Resource limits per script: 5 timers, 5 event subscriptions, 5 concurrent RPC/HTTP calls
- Local RPC via `Shelly.call()`
- Remote device control via `Shelly.call("HTTP.GET", {url: "..."})`
- Event handling via `Shelly.addStatusHandler()` / `Shelly.addEventHandler()`
- Custom HTTP endpoints via `HTTPServer.registerEndpoint()`
- Small per-script storage: 12 keys, max 1KB per value

## Control Script Architecture

Single monolithic script on Pro 4PM. One state machine, one polling loop.

### State Machine

Modes (in priority order — higher priority modes preempt lower):
1. `ACTIVE_DRAIN` — drains collectors for freeze protection (highest priority, safety-critical)
2. `EMERGENCY_HEATING` — space heater on when tank is insufficient
3. `GREENHOUSE_HEATING` — draws hot water from reservoir, pushes through radiator
4. `SOLAR_CHARGING` — draws cool water from tank bottom, pushes through collectors, hot return via reservoir
5. `IDLE` — pump off, all valves closed, evaluating sensors (default)

The minimum mode duration (5 minutes) does NOT apply to safety modes — `ACTIVE_DRAIN` can always preempt immediately regardless of how long the current mode has been active.

### Main Control Loop

30-second repeating timer:
1. Poll 1 Gen3 for all temperatures (sequential HTTP calls, one per sensor)
2. Store readings in local variables with timestamps
3. Evaluate mode transition rules (hysteresis + minimum mode duration)
4. If transition needed, execute transition sequence (sensor polling must complete before any valve commands are issued — never interleave)
5. Update status endpoint data

**RPC call serialization:** Sensor polling and valve commands are never concurrent. The control loop completes all sensor reads first, then evaluates, then issues valve commands if needed. This ensures the 5 concurrent HTTP transaction limit is never exceeded.

**Local relay control:** All Pro 4PM relay operations (pump, fan, heaters) use local `Shelly.call("Switch.Set", ...)` which does not count against the HTTP transaction limit. Only remote Pro 2PM and 1 Gen3 communication uses HTTP.

### Timer Budget

Maximum simultaneous timers (worst case during drain):
1. Main control loop (30s repeating)
2. Drain power monitor (200ms repeating)
3. Reserved for transition delays (one-shot)

Maximum: 3 of 5 available. Transition delays (valve settle, pump prime) are implemented as one-shot timers within the transition callback chain, never overlapping.

### Mode Transition Rules

**Solar Charging:**
- Enter: T_collector > T_tank_bottom + 7 C
- Exit: T_collector < T_tank_bottom + 3 C

**Greenhouse Heating:**
- Enter: T_greenhouse < 10 C AND T_tank_top > 25 C (no point running radiator if tank is cold)
- Exit: T_greenhouse > 12 C

**Active Drain:**
- Enter: T_outdoor < 2 C AND collectors not already drained
- Exit: power monitoring detects pump dry-run (or safety timeout)

**Emergency Heating:**
- Enter: T_greenhouse < 5 C AND T_tank_top < 25 C
- Exit: T_greenhouse > 8 C
- Valve states: all closed, pump off
- Actuators: space heater ON (O4), optionally immersion heater ON (O3)

**Minimum mode duration: 5 minutes** before any transition is allowed. Exception: `ACTIVE_DRAIN` always preempts immediately (safety override).

### Mode Transition Sequence

Every mode change follows this procedure:
1. Stop pump
2. Wait ~1 second (valve settle time)
3. Close all valves (sequential HTTP RPC to each Pro 2PM)
4. Open valves for new mode
5. Wait 5-10 seconds (valve travel + gravity primes pump)
6. Start pump

Safety rule: pump is ALWAYS stopped before any valve changes.

### Drain Sub-Loop

When `ACTIVE_DRAIN` is active, a separate fast timer (~200ms) monitors pump power:
- Reads `Shelly.getComponentStatus("switch", 0).apower` locally (no HTTP calls)
- When power drops below calibrated threshold: stop pump, close all valves, enter `IDLE`
- Safety timeout: 3 minutes — if drain hasn't completed, stop pump anyway
- After drain completes, set a `collectors_drained` flag to prevent re-entry until refill
- The `collectors_drained` flag is persisted in KVS (`Shelly.call("KVS.Set", ...)`) so it survives reboots
- Entering `SOLAR_CHARGING` clears the `collectors_drained` flag (collectors are being refilled)

### Boot Sequence

1. Set all local relays off (pump, heaters, fan)
2. Send "all valves closed" to all Pro 2PMs via HTTP RPC
3. Wait 5 seconds for valves to settle
4. Read sensors from 1 Gen3
5. Enter normal control loop (evaluate conditions, pick appropriate mode)

**Open question:** On boot, if freezing conditions exist, the system should verify collectors are empty before resuming normal operation. V_air (normally-open fail-safe) should have opened during power loss, potentially allowing gravity drain. However, collectors are below the reservoir and may not fully gravity-drain. Resolution needed before commissioning — options include a dedicated "verify drain" procedure on boot or a manual confirmation step.

## Device Communication

### Valve Commands (Pro 4PM to Pro 2PM)

HTTP RPC calls:
```
http://<pro2pm-ip>/rpc/Switch.Set?id=<0|1>&on=<true|false>
```

Device-to-valve mapping stored as a configuration object in the script:
```javascript
let VALVES = {
  vi_btm:  {ip: "192.168.1.11", id: 0},
  vi_top:  {ip: "192.168.1.11", id: 1},
  vi_coll: {ip: "192.168.1.12", id: 0},
  vo_coll: {ip: "192.168.1.12", id: 1},
  vo_rad:  {ip: "192.168.1.13", id: 0},
  vo_tank: {ip: "192.168.1.13", id: 1},
  v_ret:   {ip: "192.168.1.14", id: 0},
  v_air:   {ip: "192.168.1.14", id: 1},
};
```

**V_air inverted logic:** V_air is wired as normally-open (relay OFF = valve open). In the script, when a mode requires V_air OPEN, send `on=false`; when it should be CLOSED, send `on=true`. All other valves use normal logic (`on=true` = open).

IPs are DHCP reservations configured on the router.

### Sensor Reads (Pro 4PM to 1 Gen3)

HTTP RPC calls:
```
http://<plus1-ip>/rpc/Temperature.GetStatus?id=<0-4>
```

One call per sensor, sequentially. 5 sensors per control loop iteration.

### Error Handling

- **Valve command failure**: retry once, then stop pump and enter `IDLE`. Log error.
- **Sensor read failure**: use last known value. If sensors unreachable for >5 consecutive cycles (~2.5 minutes), stop pump, enter `IDLE`.
- **Pump power anomaly** (outside expected range during operation): stop pump, enter `IDLE`.
- **Recovery from IDLE**: on the next control loop iteration, the system re-evaluates sensor conditions normally and may re-enter any mode if conditions are met. Persistent failures are logged via the status endpoint.

## Status Endpoint

Custom HTTP endpoint on Pro 4PM:
- URL: `http://<pro4pm-ip>/script/1/status`
- Method: GET
- Returns JSON:

```json
{
  "mode": "SOLAR_CHARGING",
  "mode_duration_s": 342,
  "temperatures": {
    "collector": 58.2,
    "tank_top": 45.1,
    "tank_bottom": 32.0,
    "greenhouse": 14.5,
    "outdoor": 8.3
  },
  "temp_updated_s_ago": 12,
  "valves": {
    "vi_btm": true,
    "vi_top": false,
    "vi_coll": false,
    "vo_coll": true,
    "vo_rad": false,
    "vo_tank": false,
    "v_ret": true,
    "v_air": false
  },
  "pump": {
    "on": true,
    "power_w": 51.3
  },
  "collectors_drained": false,
  "last_error": null,
  "uptime_s": 86400
}
```

## Deployment

### Script Deployment via HTTP RPC

A `deploy.sh` shell script in this repo:
1. Reads the control script source file
2. Pushes to the Pro 4PM via RPC: `Script.PutCode`, `Script.SetConfig` (enable on boot), `Script.Start`
3. Device IPs read from `devices.conf`
4. Can target a single device or all devices
5. Pro 2PMs and 1 Gen3 run stock firmware — no scripts to deploy

### Configuration

All tunable parameters are constants at the top of the control script:
- Temperature thresholds and hysteresis bands
- Minimum mode duration (5 minutes)
- Polling interval (30 seconds)
- Drain timeout (3 minutes)
- Drain power threshold (calibrated during commissioning)
- Valve settle time, pump prime delay
- Device IPs

Change constants, re-deploy. No runtime configuration interface.

## File Structure (new files in this repo)

```
scripts/
  control.js          -- main control script for Pro 4PM
  deploy.sh           -- deployment script
  devices.conf        -- device IP addresses
```

## Changes from system.yaml

This spec makes the following design decisions that diverge from the current system.yaml. If accepted, system.yaml should be updated to reflect these:

1. **Flow sensor eliminated** — replaced by pump power monitoring on Pro 4PM O1 channel. Remove `flow_sensor` component, update safety rules and drain sequence references.
2. **V_air wiring decided** — system.yaml says "consider fail-safe: V_air normally-open on power loss." This spec promotes it to a firm design decision.
3. **Exit thresholds added** — system.yaml only specifies entry triggers. This spec adds hysteresis exit thresholds for all modes.
4. **Sensor hub on WiFi** — Shelly 1 Gen3 with Plus Add-on (replaces discontinued Plus 1). Add-on is not compatible with Pro devices. Sensor hub stays on WiFi; all other devices on Ethernet.

## Open Questions

1. **Boot-time freeze verification**: How to confirm collectors are empty when booting during freezing conditions. V_air fail-safe opens on power loss, but collectors may not fully gravity-drain since they sit below the reservoir. The `collectors_drained` flag is persisted in KVS across reboots, but could be stale if power was lost mid-operation.
2. **Drain power threshold calibration**: Exact wattage threshold for detecting pump dry-run must be determined empirically during commissioning. Expected range: pump draws 34-71W under load, significantly less when dry.
3. Items carried from system.yaml open questions: reservoir sizing, collector seasonal angle, wind anchoring, Jäspi internal heater usage.
