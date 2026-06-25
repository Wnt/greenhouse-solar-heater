#!/usr/bin/env node
 
// spare-wifi-testbed.mjs — MARGINAL-WiFi resilience testbed for issue #262 (WS1).
//
// Proves on the SPARE Pro 2PM (.55) that the CURRENT per-tick local-HTTP shape
// (no timeout, overlap-capable, 5 calls/tick) destabilizes / OOMs under a
// degraded WiFi link, while the HARDENED shape (short timeout + in-flight guard
// + batched reads + bounded verified valve retries + staleness) survives with
// ≥3 KB JsVar headroom. It is the hardware acceptance gate for #262.
//
// This is a promotion of scratchpad/spare-wifi-oom.mjs: that prototype only
// pointed HTTP.GET at a DEAD in-subnet IP (clean connect-timeout, no leak). A
// dead IP is NOT a marginal link. This harness instead stands up a CONTROLLABLE
// "bad endpoint" HTTP server that the spare reaches over the network and that
// can DELAY, return PARTIAL/truncated bodies, and INTERMITTENTLY DROP — the
// firmware-buffer churn that actually shrinks the pool on a flaky link.
//
// ─────────────────────────────────────────────────────────────────────────────
// ⚠️  SPARE-2PM TEST SAFETY — MANDATORY (issue #255 / #262). Read before editing.
//
//   • TARGET IS .55 ONLY (the spare Pro 2PM, "GH Valves 5 (spare)",
//     SPSW-202PE16EU, mac EC6260A00240). NEVER the 4PM (.50) or the real valve
//     controllers (.51–.54). The host is hard-coded below; there is no override.
//   • This runner issues ONLY Script.* RPCs (List / Create / PutCode / Start /
//     Stop / Delete / GetStatus) + read-only Shelly.GetDeviceInfo / Mqtt.* to
//     .55. It NEVER calls Switch.Set on the spare.
//   • The UPLOADED on-device script issues ONLY Shelly.call("HTTP.GET", …) to
//     the harness's own bad-endpoint server (a non-device IP:port we control).
//     It mimics the SHAPE of pollSensor (Temperature.GetStatus URL) and setValve
//     (Switch.Set URL) but the host is the harness, NOT a real valve/sensor
//     device — so there is no path to actuate any relay, and no MQTT.publish so
//     no path to the broker → server → DB. The "valve" leg is a benign HTTP.GET
//     to OUR server; .55's own relays are never touched.
//   • The spare stays isolated: its MQTT is disabled and it is not in the VALVES
//     map / sensor-config / mqtt-bridge subscriptions. Do NOT enable MQTT on it.
//   • Pre/post hygiene: Script.List is wiped to [] before; the runner
//     Stop+Delete's its script after and re-confirms []. A hard RUN_MS cap and a
//     fail-safe on-device auto-stop timer bound the run even if the harness dies.
//
// ─────────────────────────────────────────────────────────────────────────────
// REACHABILITY: .55 lives on the greenhouse IoT VLAN, reachable only via the
// OpenVPN tunnel inside the k8s `app` pod. The bad-endpoint server this harness
// starts must ALSO be reachable from .55, so it binds the pod's VPN-facing
// address. Run it from inside the cluster:
//
//   kubectl exec -i deploy/app -c app -- \
//     node - --mode=old --behavior=marginal < scripts/spare-wifi-testbed.mjs
//
// or, where .55 is directly routable AND can reach this host back (on-LAN / over
// VPN with a return route), run it directly:
//
//   node scripts/spare-wifi-testbed.mjs --mode=new --behavior=marginal
//
// The harness auto-detects the source IP it uses to reach .55 (the address .55
// will see) and tells the on-device script to call back to it. Override with
// --self-ip=<addr> if detection picks the wrong interface.
//
// ─────────────────────────────────────────────────────────────────────────────
// HARNESS API (flags; env in parens):
//
//   --mode=old | new            (MODE)       which control shape to exercise:
//       old  = CURRENT fragile control.js: pollSensor/setValve with NO timeout,
//              5 sensor HTTP.GET/tick, overlap-capable controlLoop (a fresh tick
//              can start while the previous poll cycle is still in flight), valve
//              retry without verify. Expect: destabilizes / OOM under marginal.
//       new  = HARDENED (issue #262): timeout:HTTP_TIMEOUT_S on every HTTP.GET,
//              an in-flight guard so controlLoop never overlaps, ONE
//              Shelly.GetStatus-shaped read per hub (2 calls/tick) instead of 5,
//              a per-role staleness cache (last-good tC + ts, max-age
//              SENSOR_MAX_AGE_S → null past it), and bounded (≤2) verified valve
//              retries with backoff. Expect: survives with ≥HEADROOM_TARGET free.
//
//   --behavior=marginal | delay | partial | drop | dead   (BEHAVIOR)
//       marginal (default) = a mix: random delay + occasional truncated body +
//                            intermittent drop (no response). The realistic link.
//       delay    = every response delayed BAD_DELAY_MS (slow link).
//       partial  = every response a truncated/garbage body (corrupt frames).
//       drop     = a fraction (BAD_DROP_PCT) of requests get no response.
//       dead     = the bad server refuses/never answers (parity w/ the old
//                  dead-IP prototype; clean timeouts, useful as a control).
//
//   --duration=<sec>           (DURATION)   bounded run length (default 180).
//   --ballast=<n>              (BALLAST_N)  inert JsVars to push the spare's
//       baseline up to the real 4PM control-script footprint so the HTTP churn
//       runs in the real ~6 KB headroom. Calibrated default BALLAST_N_DEFAULT
//       (≈207 on the spare pool 23590 → ~6 KB free); recalibrate via
//       --mode=calib (uploads ballast only, prints resulting mem_free).
//   --self-ip=<addr>           (SELF_IP)    override the callback address.
//   --bad-port=<n>             (BAD_PORT)   bad-endpoint listen port (default 8599).
//
// EXIT CODE: 0 if the observed result matches the expected verdict for the mode
// (old→destabilized/OOM, new→survived with ≥HEADROOM_TARGET headroom), 1 if not,
// 2 on a safety/usage abort.
// ─────────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import net from 'node:net';

// ── Hard-coded SPARE target — NEVER parameterise. ──
const SPARE = '192.168.30.55';
const EXPECT_MAC = 'EC6260A00240';
const EXPECT_APP = 'Pro2PM';

// ── Pool / headroom model (issue #262). Spare JsVar pool ≈ 23590 B; the 4PM run
// has ~6 KB free at the transition peak, so we ballast the spare to the same
// headroom and call survival ≥ HEADROOM_TARGET free. ──
const SPARE_POOL = 23590;
const HEADROOM_TARGET = 3000; // ≥3 KB free → matches #262 acceptance margin.
const BALLAST_N_DEFAULT = 207; // calibrated: spare pool 23590 → ~6 KB free.

// ── On-device hardened-shape constants (mirrored into the uploaded script). The
// NEW shape uses these EXACT names so the testbed exercises the real #262 knobs:
// HTTP_TIMEOUT_S (~3 s) and SENSOR_MAX_AGE_S (~180 s). ──
const HTTP_TIMEOUT_S = 3;
const SENSOR_MAX_AGE_S = 180;
const VALVE_MAX_RETRIES = 2;
const VALVE_BACKOFF_MS = 300;

// ── Bad-endpoint behavior tunables (server side, in this Node process). ──
const BAD_DELAY_MS = 6000; // > HTTP_TIMEOUT_S so NEW times out fast, OLD hangs.
const BAD_DROP_PCT = 40; // % of requests dropped under marginal/drop.
const BAD_PARTIAL_PCT = 35; // % of requests truncated under marginal.

const RUN_HARD_CAP_MS = 6 * 60 * 1000; // absolute ceiling regardless of --duration.
const POLL_EVERY_MS = 10000; // external Script.GetStatus sampling cadence.
const SETTLE_MS = 2500;
const CHUNK = 1024;
const SLOT_ID = 1;

// ── CLI / env parsing ──
function argOf(name) {
  const pre = '--' + name + '=';
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].indexOf(pre) === 0) return process.argv[i].slice(pre.length);
  }
  return null;
}
const MODE = (argOf('mode') || process.env.MODE || 'old').toLowerCase();
const BEHAVIOR = (argOf('behavior') || process.env.BEHAVIOR || 'marginal').toLowerCase();
const DURATION_S = Number(argOf('duration') || process.env.DURATION || 180);
const BALLAST_N = Number(argOf('ballast') != null ? argOf('ballast')
  : (process.env.BALLAST_N != null ? process.env.BALLAST_N : BALLAST_N_DEFAULT));
const SELF_IP_OVERRIDE = argOf('self-ip') || process.env.SELF_IP || null;
const BAD_PORT = Number(argOf('bad-port') || process.env.BAD_PORT || 8599);
const RUN_MS = Math.min(Math.max(DURATION_S, 10) * 1000, RUN_HARD_CAP_MS);

const VALID_MODES = ['old', 'new', 'calib'];
const VALID_BEHAVIORS = ['marginal', 'delay', 'partial', 'drop', 'dead'];
if (VALID_MODES.indexOf(MODE) < 0) {
  console.error('usage: --mode=old|new|calib (got "' + MODE + '")');
  process.exit(2);
}
if (VALID_BEHAVIORS.indexOf(BEHAVIOR) < 0) {
  console.error('usage: --behavior=marginal|delay|partial|drop|dead (got "' + BEHAVIOR + '")');
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Bad-endpoint server: a controllable, marginal HTTP responder the spare polls.
// Responds to BOTH the sensor URL shape (/rpc/Temperature.GetStatus?id=…) and
// the valve URL shape (/rpc/Switch.Set?id=…&on=…). It NEVER touches hardware —
// it's just a misbehaving HTTP server.
// ─────────────────────────────────────────────────────────────────────────────
const GOOD_SENSOR_BODY = JSON.stringify({ id: 100, tC: 78.5, tF: 173.3, errors: [] });
const GOOD_VALVE_BODY = JSON.stringify({ was_on: false }); // Switch.Set shape.

function badServer() {
  return http.createServer(function (req, res) {
    const isValve = req.url.indexOf('Switch.Set') >= 0;
    const good = isValve ? GOOD_VALVE_BODY : GOOD_SENSOR_BODY;

    function sendGood() {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(good);
    }
    function sendPartial() {
      // Truncated body: declare full length, send half, then hang the socket so
      // the client must time out (mirrors a corrupted/cut frame on a bad link).
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(good.length) });
      res.write(good.slice(0, Math.max(1, Math.floor(good.length / 2))));
      // deliberately no res.end() — socket left open.
    }
    function drop() {
      // Accept then never respond: destroy the socket without a reply so the
      // client sees a reset / silent loss mid-flight (the marginal-link signature
      // the dead-IP prototype could not produce).
      try { req.socket.destroy(); } catch (_) { /* noop */ }
    }

    if (BEHAVIOR === 'dead') { drop(); return; }
    if (BEHAVIOR === 'delay') { setTimeout(sendGood, BAD_DELAY_MS); return; }
    if (BEHAVIOR === 'partial') { sendPartial(); return; }
    if (BEHAVIOR === 'drop') {
      if (Math.random() * 100 < BAD_DROP_PCT) { drop(); return; }
      sendGood();
      return;
    }
    // marginal: stochastic mix of all three + the occasional clean-but-slow OK.
    const roll = Math.random() * 100;
    if (roll < BAD_DROP_PCT) { drop(); return; }
    if (roll < BAD_DROP_PCT + BAD_PARTIAL_PCT) { sendPartial(); return; }
    setTimeout(sendGood, Math.floor(Math.random() * BAD_DELAY_MS));
  });
}

// Detect the local source address the spare will see by opening a throwaway TCP
// socket toward .55:80 and reading socket.localAddress. Override via --self-ip.
function detectSelfIp() {
  return new Promise(function (resolve) {
    if (SELF_IP_OVERRIDE) { resolve(SELF_IP_OVERRIDE); return; }
    const s = net.connect({ host: SPARE, port: 80 }, function () {
      const addr = s.localAddress;
      s.destroy();
      resolve(addr);
    });
    s.on('error', function () { s.destroy(); resolve(null); });
    s.setTimeout(4000, function () { s.destroy(); resolve(null); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Shelly RPC (host side) — POST /rpc, mirrors scripts/spare-2pm-memcheck.mjs.
// ─────────────────────────────────────────────────────────────────────────────
function rpc(host, method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ id: 1, method, params: params || {} });
    const req = http.request({
      host, port: 80, path: '/rpc', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs || 8000,
    }, function (res) {
      let d = '';
      res.on('data', function (c) { d += c; });
      res.on('end', function () {
        try {
          const j = JSON.parse(d);
          if (j.error) reject(new Error(JSON.stringify(j.error)));
          else resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function () { req.destroy(new Error('rpc timeout ' + method)); });
    req.write(body);
    req.end();
  });
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// ─────────────────────────────────────────────────────────────────────────────
// On-device Espruino test script (ES5, Shelly runtime). Built from `self` (the
// callback IP:port), `mode`, and ballast count. Two control shapes:
//
//   OLD: faithful to current control.js —
//     - pollSensor:  Shelly.call("HTTP.GET", {url}, cb)  ← NO timeout
//     - pollAllSensors: sequential next() over 5 sensor URLs (5 calls/tick)
//     - setValve:    HTTP.GET, on failure ONE blind retry (no verify)
//     - controlLoop: OVERLAP-CAPABLE — a repeating Timer fires the next cycle on
//                    a fixed cadence even if the previous poll is still in flight
//                    (the 5-concurrent-call pileup the issue blames).
//
//   NEW (hardened, #262):
//     - every HTTP.GET carries {timeout: HTTP_TIMEOUT_S}
//     - IN-FLIGHT GUARD: controlLoop bails if a cycle is already running
//     - BATCHED reads: 2 hub calls/tick (Shelly.GetStatus shape) not 5
//     - STALENESS CACHE: last-good tC + ts per role; serve cached < max-age,
//       null past SENSOR_MAX_AGE_S (→ caller would degrade to IDLE); no thrash
//     - setValve: ≤VALVE_MAX_RETRIES retries w/ backoff + a Switch.GetStatus-
//       shaped VERIFY read before declaring success
// ─────────────────────────────────────────────────────────────────────────────
function ballastPrefix(n) {
  if (!n) return '';
  return [
    'var BALLAST = [];',
    '(function(){ var s = "0123456789012345678901234567890123456789"; var k;',
    '  for (k = 0; k < ' + n + '; k++) { BALLAST.push(s + "_" + k); } })();',
    '',
  ].join('\n');
}

// Common header: the bad URLs (point at the harness's own server) + a hard
// fail-safe auto-stop so the script can never run unbounded if the harness dies.
function commonHeader(self) {
  const base = 'http://' + self + '/rpc/';
  return [
    'var SENS = "' + base + 'Temperature.GetStatus?id=";',
    'var VLV  = "' + base + 'Switch.Set?id=";',
    'var VGET = "' + base + 'Switch.GetStatus?id=";',
    // 5 sensor component ids (mirrors the 5 real roles on the two hubs).
    'var SIDS = [100,101,102,103,104];',
    'var ticks = 0;',
    // Fail-safe: stop ourselves after the host run window + slack even if the
    // external runner vanishes (belt-and-suspenders on top of host cleanup).
    'Timer.set(' + (RUN_MS + 60000) + ', false, function(){ Shelly.call("Script.Stop", {id: ' + SLOT_ID + '}); });',
    '',
  ].join('\n');
}

function buildOld(self) {
  return ballastPrefix(BALLAST_N) + commonHeader(self) + [
    // pollSensor — NO timeout, faithful to current control.js.
    'function pollSensor(id, cb) {',
    '  Shelly.call("HTTP.GET", {url: SENS + id}, function(res, err) {',
    '    var v = null;',
    '    if (!err && res && res.code === 200 && res.body && res.body.indexOf("tC") >= 0) {',
    '      try { v = JSON.parse(res.body).tC; } catch (e) { v = null; }',
    '    }',
    '    if (cb) cb(v);',
    '  });',
    '}',
    // pollAllSensors — sequential, 5 calls/cycle.
    'function pollAll(cb) {',
    '  var i = 0;',
    '  function next() { if (i >= SIDS.length) { if (cb) cb(); return; } var id = SIDS[i]; i++; pollSensor(id, function(){ next(); }); }',
    '  next();',
    '}',
    // setValve — one blind retry, NO verify (current shape).
    'function setValve(open, cb) {',
    '  var url = VLV + "0&on=" + (open ? "true" : "false");',
    '  Shelly.call("HTTP.GET", {url: url}, function(res, err) {',
    '    if (err || !res || res.code !== 200) {',
    '      Shelly.call("HTTP.GET", {url: url}, function(res2, err2) { if (cb) cb(!(err2 || !res2 || res2.code !== 200)); });',
    '      return;',
    '    }',
    '    if (cb) cb(true);',
    '  });',
    '}',
    // controlLoop — OVERLAP-CAPABLE: the repeating timer below fires regardless
    // of whether the previous cycle finished, so cycles pile up on a slow link.
    'function controlLoop() {',
    '  ticks++;',
    '  pollAll(function() { setValve((ticks % 2) === 0, function(){}); });',
    '}',
    'Timer.set(2000, true, controlLoop);',
    'print("wifi-testbed OLD started (overlap, no timeout, 5 calls/tick) self=' + self + '");',
  ].join('\n');
}

function buildNew(self) {
  return ballastPrefix(BALLAST_N) + commonHeader(self) + [
    'var HTTP_TIMEOUT_S = ' + HTTP_TIMEOUT_S + ';',
    'var SENSOR_MAX_AGE_S = ' + SENSOR_MAX_AGE_S + ';',
    'var VALVE_MAX_RETRIES = ' + VALVE_MAX_RETRIES + ';',
    'var VALVE_BACKOFF_MS = ' + VALVE_BACKOFF_MS + ';',
    'var inFlight = false;',
    // Staleness cache: last-good tC + ts per hub.
    'var cache = { a: null, aTs: 0, b: null, bTs: 0 };',
    'function fresh(ts) { return ts > 0 && (Date.now() - ts) < (SENSOR_MAX_AGE_S * 1000); }',
    // hubRead — ONE Shelly.GetStatus-shaped call per hub (the batched read). On a
    // good reply, refresh cache; on failure/timeout, keep last-good if fresh else
    // null. timeout:HTTP_TIMEOUT_S fails fast instead of holding firmware buffers.
    'function hubRead(which, cb) {',
    '  var url = SENS + (which === "a" ? 100 : 101);',
    '  Shelly.call("HTTP.GET", {url: url, timeout: HTTP_TIMEOUT_S}, function(res, err) {',
    '    var v = null;',
    '    if (!err && res && res.code === 200 && res.body && res.body.indexOf("tC") >= 0) {',
    '      try { v = JSON.parse(res.body).tC; } catch (e) { v = null; }',
    '    }',
    '    if (v !== null) { if (which === "a") { cache.a = v; cache.aTs = Date.now(); } else { cache.b = v; cache.bTs = Date.now(); } }',
    '    if (cb) cb();',
    '  });',
    '}',
    // readAll — 2 calls/tick. After both, resolve effective values from cache
    // (cached-if-fresh, else null → caller degrades to IDLE). Pure: no thrash.
    'function readAll(cb) {',
    '  hubRead("a", function() { hubRead("b", function() {',
    '    var ta = fresh(cache.aTs) ? cache.a : null;',
    '    var tb = fresh(cache.bTs) ? cache.b : null;',
    '    if (cb) cb(ta, tb);',
    '  }); });',
    '}',
    // setValve — bounded verified retries with backoff. Verify reads Switch.Get
    // shape before declaring success (a flaky link can ACK without acting).
    'function verify(cb) {',
    '  Shelly.call("HTTP.GET", {url: VGET + "0", timeout: HTTP_TIMEOUT_S}, function(res, err) {',
    '    if (cb) cb(!err && res && res.code === 200);',
    '  });',
    '}',
    'function setValve(open, cb) {',
    '  var url = VLV + "0&on=" + (open ? "true" : "false");',
    '  var attempt = 0;',
    '  function tryOnce() {',
    '    attempt++;',
    '    Shelly.call("HTTP.GET", {url: url, timeout: HTTP_TIMEOUT_S}, function(res, err) {',
    '      if (!err && res && res.code === 200) { verify(function(ok) {',
    '        if (ok) { if (cb) cb(true); return; }',
    '        if (attempt > VALVE_MAX_RETRIES) { if (cb) cb(false); return; }',
    '        Timer.set(VALVE_BACKOFF_MS, false, tryOnce);',
    '      }); return; }',
    '      if (attempt > VALVE_MAX_RETRIES) { if (cb) cb(false); return; }',
    '      Timer.set(VALVE_BACKOFF_MS, false, tryOnce);',
    '    });',
    '  }',
    '  tryOnce();',
    '}',
    // controlLoop — IN-FLIGHT GUARD: never overlap. Cached temps drive the
    // (here simulated) decision; valve only actuated when a cycle completes.
    'function controlLoop() {',
    '  if (inFlight) { return; }',
    '  inFlight = true;',
    '  ticks++;',
    '  readAll(function(ta, tb) {',
    '    setValve((ticks % 2) === 0, function() { inFlight = false; });',
    '  });',
    '}',
    'Timer.set(2000, true, controlLoop);',
    'print("wifi-testbed NEW started (guarded, timeout=" + HTTP_TIMEOUT_S + "s, 2 calls/tick, verified retries) self=' + self + '");',
  ].join('\n');
}

function buildCalib() {
  return ballastPrefix(BALLAST_N) + 'print("calib ballast=' + BALLAST_N + '");\n';
}

function buildScript(self) {
  if (MODE === 'calib') return buildCalib();
  if (MODE === 'new') return buildNew(self);
  return buildOld(self);
}

// ─────────────────────────────────────────────────────────────────────────────
// Script lifecycle on the spare (hygiene-first).
// ─────────────────────────────────────────────────────────────────────────────
async function wipeScripts() {
  const list = await rpc(SPARE, 'Script.List', {});
  const scripts = list.scripts || [];
  for (let i = 0; i < scripts.length; i++) {
    const id = scripts[i].id;
    try { await rpc(SPARE, 'Script.Stop', { id }); } catch (_) { /* noop */ }
    try { await rpc(SPARE, 'Script.Delete', { id }); } catch (_) { /* noop */ }
  }
  const after = await rpc(SPARE, 'Script.List', {});
  return (after.scripts || []).length;
}

async function uploadAndStart(code) {
  const created = await rpc(SPARE, 'Script.Create', { name: 'wifi-testbed' });
  const id = created.id;
  for (let off = 0; off < code.length; off += CHUNK) {
    await rpc(SPARE, 'Script.PutCode', { id, code: code.slice(off, off + CHUNK), append: off > 0 });
  }
  await rpc(SPARE, 'Script.Start', { id });
  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main.
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== spare-wifi-testbed: mode=' + MODE + ' behavior=' + BEHAVIOR +
    ' duration=' + (RUN_MS / 1000) + 's ballast=' + BALLAST_N + ' host=' + SPARE + ' pool=' + SPARE_POOL + 'B ===');

  // ── Safety gate: confirm .55 identity + MQTT off BEFORE anything. ──
  const info = await rpc(SPARE, 'Shelly.GetDeviceInfo', {});
  if (info.mac !== EXPECT_MAC || info.app !== EXPECT_APP) {
    console.error('SAFETY ABORT: ' + SPARE + ' is mac=' + info.mac + ' app=' + info.app +
      ' (expected ' + EXPECT_MAC + '/' + EXPECT_APP + ')');
    process.exit(2);
  }
  const mq = await rpc(SPARE, 'Mqtt.GetStatus', {}).catch(function () { return { connected: false }; });
  if (mq.connected) {
    console.error('SAFETY ABORT: spare MQTT is CONNECTED — must be disabled');
    process.exit(2);
  }
  console.log('[safety] target OK: .55 mac=' + info.mac + ' app=' + info.app +
    ' ver=' + info.ver + ' mqtt.connected=' + !!mq.connected);

  // ── Detect callback IP + stand up the bad-endpoint server (skipped for calib,
  // which is ballast-only and makes no HTTP.GET). ──
  let self = null;
  let server = null;
  if (MODE !== 'calib') {
    const ip = await detectSelfIp();
    if (!ip) {
      console.error('SAFETY ABORT: could not detect a source IP reachable from .55 ' +
        '(pass --self-ip=<addr>). Refusing to upload a script with no valid callback.');
      process.exit(2);
    }
    self = ip + ':' + BAD_PORT;
    server = badServer();
    await new Promise(function (resolve, reject) {
      server.on('error', reject);
      server.listen(BAD_PORT, '0.0.0.0', resolve);
    });
    console.log('[bad-endpoint] listening on 0.0.0.0:' + BAD_PORT +
      ' — spare will call back to ' + self + ' (' + BEHAVIOR + ')');
  }

  // ── Pre-clean. ──
  const pre = await wipeScripts();
  console.log('[pre] Script.List length = ' + pre + (pre === 0 ? ' (clean)' : ' (wiped)'));

  let id;
  let crashed = false;
  let lastStatus = null;
  try {
    id = await uploadAndStart(buildScript(self));
    const built = buildScript(self);
    console.log('[upload] script id=' + id + ' size=' + Buffer.byteLength(built) + 'B mode=' + MODE);
    await sleep(SETTLE_MS);

    if (MODE === 'calib') {
      const st = await rpc(SPARE, 'Script.GetStatus', { id });
      console.log('[calib] mem_used=' + st.mem_used + ' mem_peak=' + st.mem_peak +
        ' mem_free=' + st.mem_free + ' (ballast=' + BALLAST_N + ', pool=' + SPARE_POOL + ')');
      console.log('[calib] => set --ballast so mem_free lands near 6000 for the ~6 KB-headroom model');
      lastStatus = st;
    } else {
      console.log('t(s)  running  mem_used  mem_peak  mem_free  errors');
      const t0 = Date.now();
      while (Date.now() - t0 < RUN_MS) {
        await sleep(POLL_EVERY_MS);
        let st;
        try { st = await rpc(SPARE, 'Script.GetStatus', { id }); }
        catch (e) { console.log('  GetStatus err: ' + e.message); continue; }
        lastStatus = st;
        const t = ((Date.now() - t0) / 1000).toFixed(0).padStart(4);
        console.log('  ' + t + '   ' + String(st.running).padEnd(7) + '  ' +
          String(st.mem_used).padEnd(8) + '  ' + String(st.mem_peak).padEnd(8) + '  ' +
          String(st.mem_free).padEnd(8) + '  ' + JSON.stringify(st.errors || []));
        if (st.running === false) {
          crashed = true;
          console.log('  >>> SCRIPT STOPPED — errors: ' + JSON.stringify(st.errors || []) +
            '  (peak ' + st.mem_peak + '/' + SPARE_POOL + ')');
          break;
        }
      }
    }
  } finally {
    const post = await wipeScripts().catch(function (e) { return 'cleanup-err:' + e.message; });
    console.log('[post] Script.List length = ' + post + (post === 0 ? ' (clean)' : ' (WARNING)'));
    if (server) { try { server.close(); } catch (_) { /* noop */ } }
  }

  // ── Verdict. ──
  if (MODE === 'calib') {
    console.log('RESULT calib: mem_free=' + (lastStatus ? lastStatus.mem_free : 'n/a'));
    process.exitCode = 0;
    return;
  }

  const errs = (lastStatus && lastStatus.errors) || [];
  const oom = errs.indexOf('out_of_memory') >= 0;
  const memFree = lastStatus ? lastStatus.mem_free : undefined;
  const destabilized = crashed || oom;

  console.log('─────────────────────────────────────────────');
  if (MODE === 'old') {
    const ok = destabilized;
    console.log('mode=old behavior=' + BEHAVIOR + ' => ' +
      (ok ? '✅ EXPECTED: destabilized under marginal WiFi (crashed=' + crashed +
            ' oom=' + oom + ', peak=' + (lastStatus ? lastStatus.mem_peak : '?') + '/' + SPARE_POOL + ')'
          : '❌ did NOT destabilize — old shape survived ' + (RUN_MS / 1000) +
            's (ballast too low? raise --ballast; or behavior too gentle)'));
    process.exitCode = ok ? 0 : 1;
  } else {
    const ok = !destabilized && typeof memFree === 'number' && memFree >= HEADROOM_TARGET;
    console.log('mode=new behavior=' + BEHAVIOR + ' => ' +
      (ok ? '✅ EXPECTED: hardened shape survived with mem_free=' + memFree +
            ' ≥ ' + HEADROOM_TARGET + ' (peak=' + (lastStatus ? lastStatus.mem_peak : '?') + '/' + SPARE_POOL + ')'
          : '❌ hardened shape did NOT clear target (crashed=' + crashed + ' oom=' + oom +
            ' mem_free=' + memFree + ' need ≥' + HEADROOM_TARGET + ')'));
    process.exitCode = ok ? 0 : 1;
  }
}

main().catch(function (e) {
  console.error('[fatal] ' + e.message);
  // Best-effort cleanup so we never leave a script on the spare.
  wipeScripts().catch(function () {}).finally(function () { process.exit(2); });
});
