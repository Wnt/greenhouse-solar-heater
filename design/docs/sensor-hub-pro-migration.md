# Sensor-hub migration: 2× Shelly 1 Gen3 → the spare Pro 2PM + sensor Add-on

Replaces the two WiFi-only sensor hubs (`.20`/`.21`) with a single
Ethernet-capable hub: the former valve-spare Pro 2PM (**"GH Valves 5"**,
WiFi `192.168.30.55` / eth `192.168.31.55`) carrying the 1-Wire sensor
Add-on. The hub is dual-homed (WiFi + the wired island); polling is
WiFi-only for now (see "Sensor polling" below) — companion to the wired
valve-command path (PR #285).

## Decisions (confirmed 2026-07-29)

- **One hub**: all 5 required probes (collector, tank_top, tank_bottom,
  greenhouse, outdoor) on the single Add-on bus — exactly at its 5-sensor
  limit. The optional radiator pair cannot be connected without a second
  Add-on/hub later.
- **Device**: the spare `.55` is repurposed. **There is no valve-spare unit
  afterwards** (only the spare relay on Valve Control 4, output 2).
- **Identity**: `.55` keeps its addresses. Its eth static IP
  (`192.168.31.55`) is already provisioned. `SENSOR_HOST_IPS` in
  `deploy/terraform/main.tf` becomes `192.168.30.55` — applied at cutover.

## Sensor polling: WiFi for now (wired-first ON HOLD)

A wired-first `pollSensor` (eth island first, WiFi fallback) was deployed
2026-07-29 and **hard-reboot-looped the Pro 4PM**: an HTTP.GET to an
eth-island address with no live host behind it (the old hubs — ARP never
resolves) crashes firmware 1.7.x within one poll cycle. Reverted the same
night; regression-pinned in `tests/shelly-valve-dual-path.test.js`.

So after the swap the 4PM polls the hub over **WiFi** (`.30.55`). The hub
is still dual-homed (eth provisioned at `.31.55`) — once the firmware
behavior is understood (test on the hub itself: from the 4PM, HTTP.GET a
deliberately-dead island address, e.g. `192.168.31.99`, and see whether it
reboots), wired-first polling can be re-attempted. Until then a full WiFi
outage still stales sensors and parks control in Idle (safe, but not
autonomous) — valve commands stay wired regardless.

## Runbook

### 0. Before touching hardware
1. Merge the repo PR; let CD deploy the server + control script.
2. Playground → Settings → Sensors: **note the DS18B20 address → role
   mapping for both old hubs** (probe addresses don't change — this is the
   re-mapping cheat sheet).
3. Pick a calm moment (Idle). During the swap all temps go stale and the
   controller parks in Idle by design (150 s sensor-stale degrade). Safe —
   just avoid doing it mid-drain. Note: `.55`'s device name will change to
   "GH Sensors" on the next full deploy.

### 1. Terraform cutover (server side)
```bash
cd deploy/terraform && terraform apply     # SENSOR_HOST_IPS → 192.168.30.55
```
Then restart the app pod (or let the next CD deploy do it) so the server
rebuilds sensor-config hosts from the new list. Old assignments referencing
the removed hosts are dropped; roles will be re-assigned in step 3.

### 2. Physical swap
1. Mount the 1-Wire sensor Add-on on the `.55` Pro 2PM.
2. Power down both old Gen3 hubs; move **all 5 DS18B20 leads** onto the
   Add-on's bus terminals. Bus runs get longer (collector probe is at
   ~280 cm) — DS18B20 handles tens of meters on decent cable, but keep the
   star topology shallow if readings misbehave.
3. `.55` stays where it is: Ethernet to the island switch + power already
   in place. Nothing to change in UniFi (it keeps its `.30.55` reservation).
4. Decommission the old hubs; they and their Plus Add-ons become spares.

### 3. Discovery + role mapping
The probes keep their 1-Wire addresses, but the new Add-on assigns fresh
component ids, so discovery + apply must re-run:

1. Playground → Settings → Sensors → **Discover** (server → `.55` over
   WiFi). All 5 probes should appear with addresses + live temps.
2. Re-assign roles from the step 0.2 cheat sheet (match by address; verify
   by warming a probe with your hand).
3. **Apply** — drives the remove-all → reboot → add-all → reboot sequence
   and publishes the role→cid map to the controller.

### 4. Verify
1. Status view shows live temps within a minute; graphs resume.
2. NOTE: the WiFi-outage drill is on hold with wired-first polling
   reverted — a WiFi outage stales sensors and parks control in Idle
   (safe degrade). Verify instead that temps flow and heating re-enters
   normally after the swap.

## What still depends on WiFi after this migration
- Sensor polling (wired-first on hold — see above), so a full WiFi outage
  still parks control in Idle via the sensor-stale degrade.
- The 4PM's uplink: MQTT/VPN/telemetry/app/script deploys (the island has
  no upstream).
- Server→hub management (sensor discovery / config apply) via `.30.55`.
Valve actuation no longer does.
