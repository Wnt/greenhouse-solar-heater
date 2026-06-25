#!/usr/bin/env node
// spare-2pm-memcheck.mjs — JsVar OOM reproduction harness for Epic #254 / W0 (#255).
//
// Loads `shelly/control-logic.js` + a PURE busy-tick harness onto the SPARE
// Pro 2PM and reads Script.GetStatus to measure the per-tick JsVar transient.
// Reproduces the live 4PM `out_of_memory` crash (full device snapshot) and
// demonstrates it clears with the minimal decision payload (W3 target).
//
// ─────────────────────────────────────────────────────────────────────────
// ⚠️  SPARE-2PM TEST SAFETY — MANDATORY (issue #255). Read before editing.
//
//   • TARGET IS .55 ONLY (the spare Pro 2PM, "GH Valves 5 (spare)",
//     SPSW-202PE16EU). NEVER the 4PM (.50) or the real valve controllers
//     (.51–.54). The host is hard-coded below and there is no override flag.
//   • This runner issues ONLY Script.* RPCs (List / PutCode / Start / Stop /
//     Delete / GetStatus) to .55. It NEVER calls Switch.Set, never HTTP.GETs
//     a valve/sensor device, never touches MQTT.
//   • The uploaded harness is PURE: it calls only the side-effect-free
//     control-logic.js functions (evaluate / planValveTransition /
//     runBoundedPool) + plain in-memory allocation. The snapshot builders
//     (buildFullPayload FAIL / buildMinPayload PASS) are inlined PURE helpers.
//     It contains NO Shelly.call, NO MQTT.publish, NO MQTT.subscribe — there
//     is therefore no path to a relay (no Shelly.call) and no path to the
//     broker → server → DB (no MQTT.publish). The snapshot is built into a
//     throwaway var (SINK) and NEVER published.
//   • The spare stays isolated: its MQTT is disabled (enable:false,
//     connected:false) and it is not in the VALVES map, not in sensor-config,
//     and not subscribed by mqtt-bridge. Do NOT enable MQTT on it.
//   • Pre/post hygiene: Script.List must be [] before; the runner
//     Stop+Delete's its script after and re-confirms [].
//
// ─────────────────────────────────────────────────────────────────────────
// REACHABILITY: .55 lives on the greenhouse IoT VLAN, reachable only via the
// OpenVPN tunnel inside the k8s `app` pod. From a plain sandbox it is NOT
// routable. Two ways to run:
//
//   1. Inside the cluster (recommended) — copy this file into the app pod, or
//      pipe it to node there:
//        kubectl exec -i deploy/app -c app -- node - < scripts/spare-2pm-memcheck.mjs
//      (the app container ships node + curl; the VPN gives it 192.168.30.0/24)
//
//   2. Anywhere the device IP is directly routable (on-LAN / over VPN):
//        node scripts/spare-2pm-memcheck.mjs
//
// Override the variant with the first CLI arg: `fail` (default) or `pass`.
// Override the pad with PAD=<n> env (default 58 — the live-headroom calibration).
//
// EXIT CODE: 0 if the observed result matches the expected verdict for the
// chosen variant (fail→OOM, pass→survives with ≥3 KB headroom), 1 otherwise.
// ─────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SPARE_HOST = '192.168.30.55'; // SPARE ONLY — do not parameterise.
const SLOT_ID = 1;
const POOL_BYTES = 25186; // fixed per-script JsVar pool on Gen2 (used+free).
const HEADROOM_TARGET = 3000; // ≥3 KB free → mem_peak ≤ ~22 KB.
const CHUNK = 1024;
const SETTLE_MS = 3000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGIC_PATH = join(__dirname, '..', 'shelly', 'control-logic.js');

const variant = (process.argv[2] || 'fail').toLowerCase();
if (variant !== 'fail' && variant !== 'pass') {
  console.error('usage: spare-2pm-memcheck.mjs [fail|pass]  (default fail)');
  process.exit(2);
}
const PAD = Number(process.env.PAD || 58);

// ── Minify control-logic.js the same way shelly/deploy.sh does: drop blank
// lines + full-line // comments + leading indentation. Keeps wire size and
// JsVar parse cost identical to what actually ships to the device.
function minify(src) {
  const out = [];
  for (const line of src.split('\n')) {
    const s = line.replace(/^\s+/, '');
    if (!s || s.startsWith('//')) continue;
    out.push(s);
  }
  return out.join('\n') + '\n';
}

// ── The PURE busy-tick harness (verbatim shape from issue #255). The ONLY
// line that differs between FAIL and PASS is which snapshot builder feeds
// SINK.
//
// PASS uses the REAL buildMinPayload — the function declaration is already in
// scope from the minified shelly/control-logic.js blob prepended ahead of this
// harness (it ships to the device and emits greenhouse/state/min). We do NOT
// re-inline it: an inlined copy could silently diverge from the shipped builder
// and skew the hardware PASS measurement away from what actually runs. The
// unit test scripts/../tests/spare-harness-drift.test.js asserts this harness's
// PASS-builder source IS the real one (no local `function buildMinPayload`) so
// a field drift fails CI instead of a hand-run measurement. Its field set is
// the FINAL shipped W3 payload (contracts/telemetry.md §1):
//   {ts, mode, transitioning, transition_step, temps, flags, opening,
//    queued_opens, pending_closes, cause, reason, eval_reason, held}
// The server reassembles valves/actuators/controls_enabled/manual_override
// from native relay status + device config, so they are absent.
//
// FAIL keeps an INLINED buildFullPayload below — the pre-#254 full snapshot was
// genuinely removed from control-logic.js, so the OOM repro must carry its own
// copy to stay self-contained.
function buildHarness(snapLine) {
  return `
// ── OOM reproduction harness (PURE: no Shelly.call, no MQTT). pad=${PAD} → baseline ~19.5–20 KB ──
var PAD=[];var pi;for(pi=0;pi<${PAD};pi++){PAD.push({a:pi,b:pi*3,c:""+pi+"_pad",d:[pi,pi+1,pi+2]});}
var ST={mode:"SOLAR_CHARGING",transitioning:true,transition_step:"valves_opening",
  temps:{collector:78.5,tank_top:62,tank_bottom:55,greenhouse:24,outdoor:10},
  valve_states:{vi_btm:true,vo_coll:true},pump_on:true,fan_on:false,space_heater_on:false,immersion_heater_on:false,
  collectors_drained:false,emergency_heating_active:false,greenhouse_fan_cooling_active:true,
  valveOpenSince:{vo_rad:940000},valveOpening:{vi_btm:1010000},valvePendingOpen:["vi_top"],valvePendingClose:["vo_rad"],
  lastTransitionCause:"automation",lastTransitionReason:"solar_enter",last_eval_reason:"collector still climbing",last_held:null};
var DC={ce:true,ea:31,fm:null,we:{},wz:{},wb:{},tu:{},mo:null,v:1};
// PASS variant (W3): the real buildMinPayload from the control-logic.js blob
// above feeds SINK — see the function-level comment. NOT re-inlined here.
// FAIL variant: the PRE-#254 full device snapshot (the shape control-logic.js
// shipped before Epic #254 slimmed it). Inlined here so the OOM repro stays
// self-contained even though shelly/control-logic.js no longer builds it.
// Adds valves/actuators/controls_enabled/manual_override back — the bulk that
// pushed the per-emit transient over the JsVar ceiling.
function buildFullPayload(st,dc,now){
  var opening=[];var oi;for(oi=0;oi<VALVE_NAMES_SORTED.length;oi++){var oname=VALVE_NAMES_SORTED[oi];
    if(st.valveOpening[oname]!==undefined&&st.valveOpening[oname]>now){opening.push(oname);}}
  var pendingCloses=[];var pj;var pending=st.valvePendingClose||[];
  for(pj=0;pj<pending.length;pj++){var pv=pending[pj];var since=(st.valveOpenSince&&st.valveOpenSince[pv])||0;
    var readyAt=since>0?Math.floor((since+VALVE_TIMING.minOpenMs)/1000):0;pendingCloses.push({valve:pv,readyAt:readyAt});}
  var queuedOpens=st.valvePendingOpen?st.valvePendingOpen.slice(0):[];
  var mo=(dc.mo&&dc.mo.a)?{active:true,expiresAt:dc.mo.ex,forcedMode:dc.mo.fm||null}:null;
  return "{\\"ts\\":"+JSON.stringify(now)+
    ",\\"mode\\":"+JSON.stringify(st.mode.toLowerCase())+
    ",\\"transitioning\\":"+(st.transitioning?"true":"false")+
    ",\\"transition_step\\":"+JSON.stringify(st.transition_step||null)+
    ",\\"temps\\":"+JSON.stringify({collector:st.temps.collector,tank_top:st.temps.tank_top,
      tank_bottom:st.temps.tank_bottom,greenhouse:st.temps.greenhouse,outdoor:st.temps.outdoor})+
    ",\\"valves\\":"+JSON.stringify({vi_btm:!!st.valve_states.vi_btm,vi_top:!!st.valve_states.vi_top,
      vi_coll:!!st.valve_states.vi_coll,vo_coll:!!st.valve_states.vo_coll,vo_rad:!!st.valve_states.vo_rad,
      vo_tank:!!st.valve_states.vo_tank,v_air:!!st.valve_states.v_air})+
    ",\\"actuators\\":"+JSON.stringify({pump:st.pump_on,fan:st.fan_on,
      space_heater:st.space_heater_on,immersion_heater:st.immersion_heater_on})+
    ",\\"flags\\":"+JSON.stringify({collectors_drained:st.collectors_drained,
      emergency_heating_active:st.emergency_heating_active,greenhouse_fan_cooling_active:!!st.greenhouse_fan_cooling_active})+
    ",\\"controls_enabled\\":"+JSON.stringify(dc.ce)+
    ",\\"manual_override\\":"+JSON.stringify(mo)+
    ",\\"opening\\":"+JSON.stringify(opening)+
    ",\\"queued_opens\\":"+JSON.stringify(queuedOpens)+
    ",\\"pending_closes\\":"+JSON.stringify(pendingCloses)+
    ",\\"cause\\":"+JSON.stringify(st.lastTransitionCause||"boot")+
    ",\\"reason\\":"+JSON.stringify(st.lastTransitionReason||null)+
    ",\\"eval_reason\\":"+JSON.stringify(st.last_eval_reason||null)+
    ",\\"held\\":"+JSON.stringify(st.last_held||null)+"}";
}
var SINK=null;
function tick(){
  var es={temps:ST.temps,currentMode:ST.mode,modeEnteredAt:0.9,now:1,collectorsDrained:false,lastRefillAttempt:0,
          emergencyHeatingActive:false,greenhouseFanCoolingActive:false,solarChargePeakTankAvg:60,solarChargePeakTankAvgAt:0.95,
          sensorAge:{collector:1,tank_top:1,tank_bottom:1,greenhouse:1,outdoor:1}};
  var res=evaluate(es,null,DC);
  var plan=planValveTransition(res.valves,ST.valve_states,ST.valveOpenSince,ST.valveOpening,1000000,VALVE_TIMING);
  ${snapLine}
  var sp=[];var k;for(k=0;k<5;k++){sp.push(JSON.parse('{"id":'+k+',"tC":78.5,"tF":173.3,"errors":[]}'));}
  SINK=[res,plan,snap,sp,es];   // hold transients co-resident (the confluence) — never published
  SINK=null;
}
var n=0;function loop(){n++;tick();if(n<8){Timer.set(60,false,loop);}}
Timer.set(80,false,loop);
Timer.set(3600000,false,function(){});
`;
}

const SNAP_FAIL = 'var snap=buildFullPayload(ST,DC,1000000);      // FAIL: pre-#254 full device snapshot';
const SNAP_PASS = 'var snap=buildMinPayload(ST,DC,1000000);       // PASS: REAL buildMinPayload from the control-logic blob (target, W3)';

function rpc(path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: SPARE_HOST,
        port: 80,
        path,
        method: body ? 'POST' : 'GET',
        timeout: 10000,
        headers: body ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(d ? JSON.parse(d) : {}); }
          catch { resolve({ _raw: d }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + path)); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Guardrail: refuse to run unless the spare is genuinely isolated. This is
// belt-and-suspenders on top of the pure harness — if .55 ever gets MQTT
// turned on or a relay wired, abort rather than risk a side effect.
async function assertSpareIsolated() {
  const info = await rpc('/rpc/Shelly.GetDeviceInfo');
  if (info.app !== 'Pro2PM' || info.mac !== 'EC6260A00240') {
    throw new Error('refusing to run: .55 is not the expected spare Pro 2PM (got ' +
      JSON.stringify({ app: info.app, mac: info.mac }) + ')');
  }
  const mqtt = await rpc('/rpc/Mqtt.GetStatus');
  if (mqtt.connected) {
    throw new Error('refusing to run: spare MQTT is CONNECTED — must be disabled');
  }
  console.log('[safety] spare confirmed: app=Pro2PM mac=EC6260A00240 mqtt.connected=false');
}

async function putCodeChunked(code) {
  const buf = Buffer.from(code, 'utf8');
  let offset = 0;
  let n = 0;
  while (offset < buf.length) {
    const chunk = buf.slice(offset, offset + CHUNK).toString('utf8');
    const append = offset > 0;
    const r = await rpc('/rpc/Script.PutCode', { id: SLOT_ID, code: chunk, append });
    if (r && r.code) throw new Error('PutCode error: ' + JSON.stringify(r));
    n += 1;
    offset += CHUNK;
  }
  console.log(`[upload] ${buf.length} bytes in ${n} chunks`);
}

async function ensureSlot() {
  const list = await rpc('/rpc/Script.List');
  const ids = (list.scripts || []).map((s) => s.id);
  if (ids.length !== 0) {
    console.log('[pre] Script.List not empty:', JSON.stringify(ids), '— cleaning up');
    for (const id of ids) {
      await rpc('/rpc/Script.Stop', { id });
      await rpc('/rpc/Script.Delete', { id });
    }
  }
  const created = await rpc('/rpc/Script.Create', { name: 'memcheck' });
  if (created.id !== SLOT_ID) {
    // Created id isn't 1 — wipe and retry once so we always land on slot 1.
    await rpc('/rpc/Script.Stop', { id: created.id });
    await rpc('/rpc/Script.Delete', { id: created.id });
    const again = await rpc('/rpc/Script.Create', { name: 'memcheck' });
    if (again.id !== SLOT_ID) throw new Error('could not create script in slot 1 (got ' + again.id + ')');
  }
}

async function cleanup() {
  await rpc('/rpc/Script.Stop', { id: SLOT_ID }).catch(() => {});
  await rpc('/rpc/Script.Delete', { id: SLOT_ID }).catch(() => {});
  const list = await rpc('/rpc/Script.List');
  const ids = (list.scripts || []).map((s) => s.id);
  if (ids.length === 0) console.log('[post] Script.List == [] — clean');
  else console.log('[post] WARNING Script.List still has', JSON.stringify(ids));
}

async function main() {
  console.log(`=== spare-2pm-memcheck: variant=${variant} pad=${PAD} host=${SPARE_HOST} pool=${POOL_BYTES}B ===`);
  await assertSpareIsolated();

  const logic = minify(readFileSync(LOGIC_PATH, 'utf8'));
  const snapLine = variant === 'fail' ? SNAP_FAIL : SNAP_PASS;
  const full = logic + buildHarness(snapLine);
  console.log(`[build] control-logic.js(min)=${Buffer.byteLength(logic)}B + harness => total ${Buffer.byteLength(full)}B`);

  await ensureSlot();
  try {
    await putCodeChunked(full);
    const start = await rpc('/rpc/Script.Start', { id: SLOT_ID });
    console.log('[start]', JSON.stringify(start));
    await sleep(SETTLE_MS);
    const st = await rpc('/rpc/Script.GetStatus', null);
    // GetStatus needs the id as a query param.
    const status = st.id !== undefined ? st : await rpc(`/rpc/Script.GetStatus?id=${SLOT_ID}`, null);
    console.log('[status]', JSON.stringify(status));

    const running = !!status.running;
    const memUsed = status.mem_used;
    const memPeak = status.mem_peak;
    const memFree = status.mem_free;
    const errors = status.errors || [];
    const oom = errors.indexOf('out_of_memory') !== -1 || (!running && errors.length > 0);

    console.log('─────────────────────────────────────────────');
    console.log(`running=${running} mem_used=${memUsed} mem_peak=${memPeak} mem_free=${memFree} errors=${JSON.stringify(errors)}`);

    let ok;
    if (variant === 'fail') {
      // Expectation: full snapshot OOMs the pool — bug reproduced.
      ok = oom && !running;
      console.log(ok
        ? '✅ EXPECTED FAIL reproduced: full snapshot → out_of_memory (running:false)'
        : '❌ did NOT reproduce OOM — full snapshot survived (pad too low? control-logic shrank?)');
    } else {
      // Expectation: minimal payload survives with ≥3 KB headroom.
      ok = running && !oom && typeof memFree === 'number' && memFree >= HEADROOM_TARGET;
      console.log(ok
        ? `✅ EXPECTED PASS: minimal payload survives, mem_free=${memFree} ≥ ${HEADROOM_TARGET} (mem_peak=${memPeak})`
        : `❌ minimal payload did NOT clear target (running=${running} mem_free=${memFree} need ≥${HEADROOM_TARGET})`);
    }
    process.exitCode = ok ? 0 : 1;
  } finally {
    await cleanup();
  }
}

main().catch((e) => {
  console.error('[fatal]', e.message);
  // Best-effort cleanup on crash so we never leave a script on the spare.
  cleanup().catch(() => {}).finally(() => process.exit(2));
});
