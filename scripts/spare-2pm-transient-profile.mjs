#!/usr/bin/env node
// spare-2pm-transient-profile.mjs — per-stage JsVar profile on the spare Pro 2PM.
//
// Companion to spare-2pm-memcheck.mjs. That script answers "does this shape
// OOM?"; this one answers "WHERE do the bytes go?" by measuring one stage at a
// time. Findings from the 2026-08-12 run are recorded in shelly/script-budget.json
// and CLAUDE.md — most importantly that resident cost is ~85 B per top-level
// declaration (so splitting a hot function into helpers makes the pool worse),
// while bulk bytes inside an existing function are ~0.08 B/byte.
//
// Usage:  node scripts/spare-2pm-transient-profile.mjs [key-substring]
//         PAD=<n> to change the resident-baseline pad (default 58).
//
// Same safety envelope as scripts/spare-2pm-memcheck.mjs: target is .55 only,
// MAC-pinned, refuses to run if MQTT is connected, Script.* RPCs only, the
// uploaded harness is PURE (no Shelly.call, no MQTT, no HTTP), and every
// variant is deleted after measurement.
//
// mem_peak resets when a script starts, so each variant is a fresh
// upload → start → settle → GetStatus → delete cycle. Absolute numbers are
// NOT the 4PM's (no control.js shell resident here); the DELTAS between
// variants are the output.

import { readFileSync } from 'node:fs';
import http from 'node:http';

const HOST = '192.168.30.55';
const MAC = 'EC6260A00240';
const SLOT = 1;
const POOL = 25186;
const CHUNK = 1024;
const SETTLE_MS = 3000;
const PAD = Number(process.env.PAD || 58);
const LOGIC_PATH = new URL('../shelly/control-logic.js', import.meta.url);

function minify(src) {
  const out = [];
  for (const line of src.split('\n')) {
    const s = line.replace(/^\s+/, '');
    if (!s || s.startsWith('//')) continue;
    out.push(s);
  }
  return out.join('\n') + '\n';
}

function rpc(path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: HOST, port: 80, path, method: body ? 'POST' : 'GET', timeout: 10000,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({ _raw: d }); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + path)); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertSafe() {
  const info = await rpc('/rpc/Shelly.GetDeviceInfo');
  if (info.app !== 'Pro2PM' || info.mac !== MAC) {
    throw new Error('refusing: not the spare Pro 2PM: ' + JSON.stringify({ app: info.app, mac: info.mac }));
  }
  const mqtt = await rpc('/rpc/Mqtt.GetStatus');
  if (mqtt.connected) throw new Error('refusing: spare MQTT is CONNECTED');
  const st = await rpc('/rpc/Shelly.GetStatus');
  const temps = Object.keys(st).filter((k) => k.startsWith('temperature'));
  if (temps.length) throw new Error('refusing: .55 now serves sensors (' + temps.join(',') + ') — it is live');
}

const PRELUDE = `
var PAD=[];var pi;for(pi=0;pi<${PAD};pi++){PAD.push({a:pi,b:pi*3,c:""+pi+"_pad",d:[pi,pi+1,pi+2]});}
var ST={mode:"SOLAR_CHARGING",transitioning:true,transition_step:"valves_opening",
  temps:{collector:78.5,tank_top:62,tank_bottom:55,greenhouse:24,outdoor:10},
  valve_states:{vi_btm:true,vo_coll:true},pump_on:true,fan_on:false,space_heater_on:false,immersion_heater_on:false,
  collectors_drained:false,emergency_heating_active:false,greenhouse_fan_cooling_active:true,
  valveOpenSince:{vo_rad:940000},valveOpening:{vi_btm:1010000},valvePendingOpen:["vi_top"],valvePendingClose:["vo_rad"],
  lastTransitionCause:"automation",lastTransitionReason:"solar_enter",last_eval_reason:"collector still climbing",last_held:null};
var DC={ce:true,ea:31,fm:null,we:{},wz:{},wb:{},tu:{},mo:null,v:1};
var ES={temps:ST.temps,currentMode:ST.mode,modeEnteredAt:0.9,now:1,collectorsDrained:false,lastRefillAttempt:0,
  emergencyHeatingActive:false,greenhouseFanCoolingActive:false,solarChargePeakTankAvg:60,solarChargePeakTankAvgAt:0.95,
  sensorAge:{collector:1,tank_top:1,tank_bottom:1,greenhouse:1,outdoor:1}};
var SINK=null;
var BODY='{"id":0,"tC":78.5,"tF":173.3,"errors":[]}';
`;

const EPILOGUE = `
var n=0;function loop(){n++;tick();if(n<8){Timer.set(60,false,loop);}}
Timer.set(80,false,loop);
Timer.set(3600000,false,function(){});
`;

// Each variant's tick body. Everything produced is held co-resident in SINK
// (the "confluence") exactly as the shipped tick does, then released.
// Extra probes:
//  *_stale / *_idle short-circuit inside evaluate() to separate "cost of
//  calling it at all" from "cost of executing the long body".
//  dead4k appends 4 KB of never-called minified source to measure the MARGINAL
//  resident cost per source byte (the average is not the margin).
function deadSrc(bytes) {
  let s = '';
  let i = 0;
  while (s.length < bytes) {
    s += `function dead${i}(a,b){var q=a+b;var r=q*2;var t=[q,r,q-r];return t.length>0?q:r;}\n`;
    i += 1;
  }
  return s;
}

const VARIANTS = [
  { key: 'floor', logic: false, desc: 'pad + runtime only (no control-logic loaded)',
    tick: 'SINK=null;' },
  { key: 'logic_resident', logic: true, desc: 'control-logic.js resident, tick does nothing',
    tick: 'SINK=null;' },
  { key: 'evaluate', logic: true, desc: '+ evaluate()',
    tick: 'var res=evaluate(ES,null,DC);SINK=[res];SINK=null;' },
  { key: 'eval_plan', logic: true, desc: '+ planValveTransition()',
    tick: 'var res=evaluate(ES,null,DC);'
      + 'var plan=planValveTransition(res.valves,ST.valve_states,ST.valveOpenSince,ST.valveOpening,1000000,VALVE_TIMING);'
      + 'SINK=[res,plan];SINK=null;' },
  { key: 'eval_plan_payload', logic: true, desc: '+ buildMinPayload()  [= shipped tick minus sensor parsing]',
    tick: 'var res=evaluate(ES,null,DC);'
      + 'var plan=planValveTransition(res.valves,ST.valve_states,ST.valveOpenSince,ST.valveOpening,1000000,VALVE_TIMING);'
      + 'var snap=buildMinPayload(ST,DC,1000000);'
      + 'SINK=[res,plan,snap];SINK=null;' },
  { key: 'shipped_jsonparse', logic: true, desc: '+ 5x JSON.parse(sensor body)  [TODAY on main]',
    tick: 'var res=evaluate(ES,null,DC);'
      + 'var plan=planValveTransition(res.valves,ST.valve_states,ST.valveOpenSince,ST.valveOpening,1000000,VALVE_TIMING);'
      + 'var snap=buildMinPayload(ST,DC,1000000);'
      + 'var sp=[];var k;for(k=0;k<5;k++){sp.push(JSON.parse(BODY));}'
      + 'SINK=[res,plan,snap,sp];SINK=null;' },
  { key: 'evaluate_stale', logic: true, desc: 'evaluate() returning at the sensor-stale gate (short path)',
    tick: 'var e2={temps:ST.temps,currentMode:ST.mode,modeEnteredAt:0.9,now:1,collectorsDrained:false,'
      + 'lastRefillAttempt:0,emergencyHeatingActive:false,greenhouseFanCoolingActive:false,'
      + 'solarChargePeakTankAvg:60,solarChargePeakTankAvgAt:0.95,'
      + 'sensorAge:{collector:999,tank_top:999,tank_bottom:999,greenhouse:999,outdoor:999}};'
      + 'var res=evaluate(e2,null,DC);SINK=[res];SINK=null;' },
  // Same ~1 KB of never-called source, shaped two ways: ONE function with a
  // long body vs MANY tiny functions. Separates per-declaration overhead
  // (name entry + function object + scope) from raw per-byte cost.
  { key: 'stripped_display', logic: true, strip: true,
    desc: 'evaluate() with device-dead display helpers removed from the blob',
    tick: 'var res=evaluate(ES,null,DC);SINK=[res];SINK=null;' },
  { key: 'shape_onefunc', logic: true, desc: '+1 KB as ONE never-called function',
    extra: () => {
      let body = '';
      let i = 0;
      while (body.length < 1024) { body += `var v${i}=${i}+1;`; i += 1; }
      return 'function deadOne(a){' + body + 'return a;}\n';
    },
    tick: 'var res=evaluate(ES,null,DC);SINK=[res];SINK=null;' },
  { key: 'shape_manyfunc', logic: true, desc: '+1 KB as ~14 never-called small functions',
    extra: () => deadSrc(1024),
    tick: 'var res=evaluate(ES,null,DC);SINK=[res];SINK=null;' },
  ...[512, 1024, 2048, 3072, 4096].map((b) => ({
    key: 'dead' + b, logic: true,
    desc: `evaluate() + ${b} B of never-called extra source (marginal resident cost)`,
    extra: () => deadSrc(b),
    tick: 'var res=evaluate(ES,null,DC);SINK=[res];SINK=null;',
  })),
  { key: 'pr265_scrape', logic: true, desc: '+ 5x indexOf/parseFloat scrape  [PR #265]',
    tick: 'var res=evaluate(ES,null,DC);'
      + 'var plan=planValveTransition(res.valves,ST.valve_states,ST.valveOpenSince,ST.valveOpening,1000000,VALVE_TIMING);'
      + 'var snap=buildMinPayload(ST,DC,1000000);'
      + 'var sp=[];var k;var kk;var tc;for(k=0;k<5;k++){kk=BODY.indexOf("\\"tC\\":");'
      + 'tc=kk<0?NaN:parseFloat(BODY.substring(kk+5));sp.push(isNaN(tc)?null:tc);}'
      + 'SINK=[res,plan,snap,sp];SINK=null;' },
];

async function ensureSlot() {
  const list = await rpc('/rpc/Script.List');
  for (const s of list.scripts || []) {
    await rpc('/rpc/Script.Stop', { id: s.id });
    await rpc('/rpc/Script.Delete', { id: s.id });
  }
  const created = await rpc('/rpc/Script.Create', { name: 'memprofile' });
  if (created.id !== SLOT) {
    await rpc('/rpc/Script.Stop', { id: created.id });
    await rpc('/rpc/Script.Delete', { id: created.id });
    const again = await rpc('/rpc/Script.Create', { name: 'memprofile' });
    if (again.id !== SLOT) throw new Error('no slot 1 (got ' + again.id + ')');
  }
}

async function putCode(code) {
  const buf = Buffer.from(code, 'utf8');
  for (let off = 0; off < buf.length; off += CHUNK) {
    const r = await rpc('/rpc/Script.PutCode', {
      id: SLOT, code: buf.slice(off, off + CHUNK).toString('utf8'), append: off > 0,
    });
    if (r && r.code) throw new Error('PutCode: ' + JSON.stringify(r));
  }
  return buf.length;
}

// Remove the device-dead display helpers (control.js references none of them:
// formatDuration / formatTemp / buildDisplayLabels / MODE_SHORT) plus their
// export entries, to measure what they cost the device.
function stripDisplay(src) {
  let out = src;
  for (const fn of ['formatDuration', 'formatTemp', 'buildDisplayLabels']) {
    const re = new RegExp('^function ' + fn + '\\([^]*?\\n\\}\\n', 'm');
    out = out.replace(re, '');
  }
  out = out.replace(/^var MODE_SHORT = \{[^]*?\n\};\n/m, '');
  out = out.replace(/^ *(formatDuration|formatTemp|buildDisplayLabels|MODE_SHORT): [^,]+,\n/gm, '');
  return out;
}

async function runVariant(v, logicSrc) {
  const code = (v.logic ? (v.strip ? stripDisplay(logicSrc) : logicSrc) : '') + (v.extra ? v.extra() : '')
    + PRELUDE + 'function tick(){' + v.tick + '}' + EPILOGUE;
  await ensureSlot();
  const bytes = await putCode(code);
  await rpc('/rpc/Script.Start', { id: SLOT });
  await sleep(SETTLE_MS);
  const s = await rpc(`/rpc/Script.GetStatus?id=${SLOT}`);
  await rpc('/rpc/Script.Stop', { id: SLOT }).catch(() => {});
  await rpc('/rpc/Script.Delete', { id: SLOT }).catch(() => {});
  return {
    key: v.key, desc: v.desc, bytes,
    running: !!s.running, used: s.mem_used, peak: s.mem_peak, free: s.mem_free,
    errors: s.errors || [],
  };
}

async function main() {
  await assertSafe();
  console.log(`spare=${HOST} pool=${POOL}B pad=${PAD}`);
  const logicSrc = minify(readFileSync(LOGIC_PATH, 'utf8'));
  console.log(`control-logic.js(min)=${Buffer.byteLength(logicSrc)}B\n`);

  const only = process.argv[2];
  const rows = [];
  for (const v of VARIANTS) {
    if (only && !v.key.includes(only)) continue;
    const r = await runVariant(v, logicSrc);
    rows.push(r);
    const pct = r.peak ? ((r.peak / POOL) * 100).toFixed(1) : '?';
    console.log(
      `${r.key.padEnd(20)} peak=${String(r.peak).padStart(6)} (${pct.padStart(5)}%)`
      + ` used=${String(r.used).padStart(6)} free=${String(r.free).padStart(5)}`
      + ` code=${String(r.bytes).padStart(6)}B run=${r.running}`
      + (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ''),
    );
  }

  console.log('\nstage deltas (peak):');
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i].peak - rows[i - 1].peak;
    console.log(`  ${rows[i - 1].key} -> ${rows[i].key}: ${d >= 0 ? '+' : ''}${d} B   (${rows[i].desc})`);
  }
  const list = await rpc('/rpc/Script.List');
  console.log('\n[post] Script.List =', JSON.stringify((list.scripts || []).map((s) => s.id)));
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
