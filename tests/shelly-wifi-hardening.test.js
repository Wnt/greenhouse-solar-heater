/**
 * Degraded-WiFi local-HTTP hardening for the Pro 4PM control script (#262).
 *
 * The control loop polls 5 sensors and actuates 7 valves over LAN HTTP RPC.
 * On a flaky link those connections become slow / partial / dropped, which
 * (a) holds firmware connection buffers open on the long default HTTP
 * timeout, and (b) lets a valve cycle overlap a sensor poll cycle and pile up
 * toward the 5-concurrent-HTTP-call limit — the connection churn that
 * ratcheted the JsVar pool until the transition peak OOM'd.
 *
 * These tests pin the resilience behaviors WITHOUT a broker dependency (pure
 * LAN HTTP) and WITHOUT the resident-baseline regression that reverted the
 * first attempt (PR #263):
 *
 *   1. Every sensor + valve HTTP.GET carries an explicit short timeout (HTO=3s)
 *      so a lost packet fails fast instead of pinning a firmware buffer.
 *   2. In-flight guard: controlLoop never starts a poll cycle that overlaps a
 *      prior poll or a valve cycle.
 *   3. Last-good staleness cache: a transient failed poll leaves the prior
 *      temp + timestamp in place (no thrash); a sustained loss ages sensorAge
 *      past control-logic's threshold and degrades to IDLE.
 *   4. Valve actuation: short timeout + bounded retry (VSA=2 attempts), and on
 *      exhausted attempts the EXISTING fail-safe is preserved (setValves bails:
 *      pump off, IDLE, lastTransitionCause="failed").
 *
 * control-logic.js stays pure; all of this lives in control.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');
const FILES = ['control-logic.js', 'control.js'];

const CID_TO_SENSOR = { 100: 'collector', 101: 'tank_top', 102: 'tank_bottom', 103: 'greenhouse', 104: 'outdoor' };
// Drives evaluate() into SOLAR_CHARGING (collector hotter than tank_bottom).
const SOLAR_TEMPS = { collector: 60, tank_top: 40, tank_bottom: 30, greenhouse: 18, outdoor: 15 };

function urlSwitchId(url) { const m = url.match(/[?&]id=(\d+)/); return m ? parseInt(m[1], 10) : null; }
function urlHost(url) { const m = url.match(/^http:\/\/([0-9.]+)\//); return m ? m[1] : null; }

function createRuntime(opts) {
  opts = opts || {};
  let now = 1700000000000;
  let timers = [];
  let timerIdCounter = 0;
  const kvs = Object.assign({}, opts.kvs || {});
  const publishes = [];

  let httpInFlight = 0;
  let peakHttpInFlight = 0;
  const httpCalls = []; // { url, timeout, kind }
  const relayOutput = {};
  function relayKey(ip, id) { return ip + ':' + id; }

  // valveResponder(kind, url, id, host) → { drop } | { code, body, applied } | null
  const valveResponder = opts.valveResponder || null;
  // sensorResponder(sensor) → { drop } | { ok:false } | { ok:true, body }
  const sensorResponder = opts.sensorResponder || function (sensor) {
    return { ok: true, body: JSON.stringify({ tC: SOLAR_TEMPS[sensor] }) };
  };

  function shellyCall(method, params, cb) {
    params = params || {};
    if (method === 'HTTP.GET') {
      const url = params.url || '';
      httpInFlight++;
      if (httpInFlight > peakHttpInFlight) peakHttpInFlight = httpInFlight;
      const isSensor = url.indexOf('Temperature.GetStatus') >= 0;
      const isSet = url.indexOf('Switch.Set') >= 0;
      const isGet = url.indexOf('Switch.GetStatus') >= 0;
      const kind = isSensor ? 'sensor' : (isSet ? 'set' : (isGet ? 'get' : 'other'));
      httpCalls.push({ url, timeout: params.timeout, kind });
      function settle(res, err) { httpInFlight--; if (cb) cb(res, err); }

      if (isSensor) {
        let sensor = 'collector';
        const m = url.match(/id=(\d+)/);
        if (m) sensor = CID_TO_SENSOR[parseInt(m[1], 10)] || 'collector';
        const r = sensorResponder(sensor) || { ok: true, body: '{}' };
        if (r.drop) {
          const t = (params.timeout || 0) * 1000;
          if (t > 0) timers.push({ id: ++timerIdCounter, dueAt: now + t, oneshot: true, cb: function () { settle(null, 'timeout'); } });
          return;
        }
        timers.push({ id: ++timerIdCounter, dueAt: now + (r.delayMs || 0), oneshot: true, cb: function () {
          if (r.ok === false) { settle(null, r.err || 'error'); return; }
          settle({ code: 200, body: r.body || '' }, null);
        } });
        return;
      }

      // Valve path: Switch.Set on a .51–.54 host.
      const host = urlHost(url);
      const id = urlSwitchId(url);
      const key = relayKey(host, id);
      const onMatch = /[?&]on=true/.test(url);
      const r = valveResponder ? valveResponder(kind, url, id, host) : null;
      if (!r) {
        if (isSet) { relayOutput[key] = onMatch; settle({ code: 200, body: '{}' }, null); return; }
        if (isGet) { settle({ code: 200, body: JSON.stringify({ id, output: !!relayOutput[key] }) }, null); return; }
        settle({ code: 200, body: '{}' }, null);
        return;
      }
      if (r.drop) {
        const t = (params.timeout || 0) * 1000;
        if (t > 0) timers.push({ id: ++timerIdCounter, dueAt: now + t, oneshot: true, cb: function () { settle(null, 'timeout'); } });
        return;
      }
      timers.push({ id: ++timerIdCounter, dueAt: now + (r.delayMs || 0), oneshot: true, cb: function () {
        if (isSet) {
          const applied = r.applied !== false;
          if (applied && r.code === 200) relayOutput[key] = onMatch;
          settle({ code: r.code, body: r.body || '{}' }, r.code === 200 ? null : (r.err || null));
          return;
        }
        settle({ code: r.code || 200, body: r.body || '{}' }, null);
      } });
      return;
    }
    if (method === 'KVS.Get') { const v = kvs[params.key] || null; setImmediate(function () { if (cb) cb(v ? { value: v } : null, null); }); return; }
    if (method === 'KVS.Set') { kvs[params.key] = params.value; setImmediate(function () { if (cb) cb({}, null); }); return; }
    setImmediate(function () { if (cb) cb({}, null); });
  }

  function timerSet(ms, repeat, cb) { const id = ++timerIdCounter; timers.push({ id, repeat: !!repeat, oneshot: !repeat, cb, dueAt: now + (ms || 0), ms: ms || 0 }); return id; }
  function timerClear(id) { timers = timers.filter(function (t) { return t.id !== id; }); }

  const globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus: function (type) {
        if (type === 'sys') return { unixtime: Math.floor(now / 1000), uptime: 100 };
        if (type === 'switch') return { apower: 0, output: false };
        return {};
      },
      emitEvent: function () {}, addEventHandler: function () {}, addStatusHandler: function () {},
    },
    Timer: { set: timerSet, clear: timerClear },
    MQTT: {
      subscribe: function () {}, unsubscribe: function () {},
      publish: function (topic, payload) { publishes.push({ topic, payload }); },
      isConnected: function () { return true; }, setConnectHandler: function () {},
    },
    JSON, Date: { now: function () { return now; } }, Math, parseInt, print: function () {},
  };

  function fireDueTimers() {
    let fired = true;
    let guard = 0;
    while (fired && guard++ < 10000) {
      fired = false;
      timers.sort(function (a, b) { return a.dueAt - b.dueAt; });
      for (let i = 0; i < timers.length; i++) {
        if (timers[i].dueAt <= now) {
          const t = timers[i];
          if (t.oneshot) timers.splice(i, 1); else t.dueAt = now + (t.ms || 0);
          try { t.cb(); } catch (_e) {}
          fired = true;
          break;
        }
      }
    }
  }

  return {
    globals,
    advance: function (ms) { now += ms; fireDueTimers(); },
    async drain(rounds) {
      rounds = rounds || 40;
      for (let i = 0; i < rounds; i++) {
        await new Promise(function (r) { setImmediate(r); });
        fireDueTimers();
      }
    },
    setNow: function (n) { now = n; },
    nowMs: function () { return now; },
    stats: function () { return { peakHttpInFlight, httpCalls }; },
    publishes,
    lastState: function () {
      for (let i = publishes.length - 1; i >= 0; i--) {
        if (publishes[i].topic === 'greenhouse/state/min') { try { return JSON.parse(publishes[i].payload); } catch (_e) { return null; } }
      }
      return null;
    },
  };
}

function loadScripts(runtime) {
  const src = FILES.map(function (f) { return fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8'); }).join('\n');
  const fn = new Function('Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print', '__TEST_HARNESS', src);
  const g = runtime.globals;
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

const SENSOR_CONFIG = JSON.stringify({
  s: {
    collector: { h: 0, i: 100 }, tank_top: { h: 0, i: 101 }, tank_bottom: { h: 0, i: 102 },
    greenhouse: { h: 0, i: 103 }, outdoor: { h: 0, i: 104 },
  },
  h: ['192.168.30.20'], v: 1,
});
const DEVICE_CONFIG = JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, tu: {}, v: 1 });

async function boot(rt) {
  loadScripts(rt);
  for (let i = 0; i < 50; i++) { await rt.drain(1); rt.advance(1); }
  rt.advance(15000);
  for (let i = 0; i < 60; i++) { await rt.drain(1); rt.advance(1); }
}

describe('Shelly WiFi hardening (#262): sensor + valve HTTP timeout', () => {
  it('every sensor poll HTTP.GET carries an explicit timeout', async () => {
    const rt = createRuntime({ kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG } });
    await boot(rt);
    const sensorCalls = rt.stats().httpCalls.filter(function (c) { return c.kind === 'sensor'; });
    assert.ok(sensorCalls.length >= 5, 'expected >=5 sensor polls during boot+first tick, got ' + sensorCalls.length);
    sensorCalls.forEach(function (c) {
      assert.strictEqual(typeof c.timeout, 'number', 'sensor HTTP.GET missing explicit timeout: ' + c.url);
      assert.ok(c.timeout > 0 && c.timeout <= 5, 'sensor timeout out of range (expected ~3s): ' + c.timeout);
    });
  });

  it('every valve Switch.Set HTTP.GET carries an explicit timeout', async () => {
    const rt = createRuntime({ kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG } });
    await boot(rt);
    const setCalls = rt.stats().httpCalls.filter(function (c) { return c.kind === 'set'; });
    assert.ok(setCalls.length >= 7, 'expected >=7 valve Set calls (boot closes all 7), got ' + setCalls.length);
    setCalls.forEach(function (c) {
      assert.strictEqual(typeof c.timeout, 'number', 'valve Set HTTP.GET missing explicit timeout: ' + c.url);
      assert.ok(c.timeout > 0 && c.timeout <= 5, 'valve timeout out of range: ' + c.timeout);
    });
  });
});

describe('Shelly WiFi hardening (#262): in-flight guard', () => {
  it('controlLoop does not start a poll cycle while a prior poll is still in flight', async () => {
    // Sensor host never responds within the tick window: the poll cycle hangs
    // on the first sensor (resolved only by the HTO timeout). Firing several
    // controlLoop ticks in that window must NOT launch overlapping cycles, so
    // peak concurrent HTTP stays at 1.
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorResponder: function () { return { drop: true }; },
    });
    loadScripts(rt);
    // Boot with a dropping sensor link: boot valve closes still succeed
    // (default valve responder), then the boot poll hangs.
    for (let i = 0; i < 50; i++) { await rt.drain(1); rt.advance(1); }
    rt.advance(15000);
    for (let i = 0; i < 30; i++) { await rt.drain(1); rt.advance(1); }

    // Manually fire several extra control ticks while the boot poll is hung.
    for (let i = 0; i < 5; i++) {
      rt.globals.Shelly.__test_controlTick();
      await rt.drain(2);
    }
    // A single in-flight sensor HTTP at a time — no overlap.
    assert.ok(rt.stats().peakHttpInFlight <= 1,
      'peak concurrent HTTP should be 1 (no overlapping poll cycles), got ' + rt.stats().peakHttpInFlight);
  });
});

describe('Shelly WiFi hardening (#262): staleness cache', () => {
  it('a transient single failed poll rides on last-good (no IDLE thrash)', async () => {
    // Boot healthy → SOLAR_CHARGING, then one tick where collector poll fails
    // once. last-good collector temp + timestamp persist, so sensorAge stays
    // small and the mode does not thrash to IDLE.
    let failCollectorOnce = false;
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorResponder: function (sensor) {
        if (sensor === 'collector' && failCollectorOnce) { failCollectorOnce = false; return { ok: false }; }
        return { ok: true, body: JSON.stringify({ tC: SOLAR_TEMPS[sensor] }) };
      },
    });
    await boot(rt);
    // Advance a couple of clean ticks to settle into SOLAR_CHARGING.
    for (let k = 0; k < 3; k++) { rt.advance(30000); await rt.drain(); }
    const before = rt.lastState();
    assert.strictEqual(before.mode, 'solar_charging', 'precondition: should be in SOLAR_CHARGING');

    failCollectorOnce = true;
    rt.advance(30000); await rt.drain();
    const after = rt.lastState();
    assert.strictEqual(after.mode, 'solar_charging',
      'a single failed collector poll must ride on last-good, not thrash to IDLE');
    assert.ok(after.temps.collector !== null, 'collector should retain its last-good value');
  });

  it('a sustained sensor loss degrades cleanly to IDLE', async () => {
    let dropAll = false;
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorResponder: function (sensor) {
        if (dropAll) return { ok: false };
        return { ok: true, body: JSON.stringify({ tC: SOLAR_TEMPS[sensor] }) };
      },
    });
    await boot(rt);
    for (let k = 0; k < 3; k++) { rt.advance(30000); await rt.drain(); }
    assert.strictEqual(rt.lastState().mode, 'solar_charging', 'precondition: SOLAR_CHARGING');

    // Now lose every sensor for well over the staleness threshold (150 s).
    dropAll = true;
    for (let k = 0; k < 10; k++) {
      rt.advance(30000);
      await rt.drain(60);
      rt.advance(5000); // let any short transition/settle timers fire
      await rt.drain(60);
      if (process.env.DBG) console.log('tick', k, 'mode', rt.lastState() && rt.lastState().mode);
    }
    assert.strictEqual(rt.lastState().mode, 'idle',
      'sustained sensor loss past sensorStaleThreshold must degrade to IDLE');
  });
});

describe('Shelly WiFi hardening (#262): valve retry + fail-safe', () => {
  it('a single transient valve Set drop is ridden out by the retry', async () => {
    // First Set on a given relay drops; the retry succeeds. Boot should still
    // complete (all valves close) — i.e. closeAllValves does not bail.
    const dropped = {};
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      valveResponder: function (kind, url, id, host) {
        if (kind !== 'set') return null;
        const key = host + ':' + id;
        if (!dropped[key]) { dropped[key] = true; return { drop: true }; }
        return { code: 200, body: '{}' };
      },
    });
    await boot(rt);
    // Boot closes all 7 valves sequentially; on this link the FIRST Set to
    // each relay drops and only the retry succeeds, so each close costs one
    // HTO (3 s) timeout before the retry. 7 valves × 3 s is past the standard
    // boot() advance window, so pump extra interleaved advance + drain cycles
    // to let every dropped-then-retried close resolve.
    for (let k = 0; k < 20; k++) { await rt.drain(20); rt.advance(3500); }
    // Boot completed → the first control tick polled sensors and entered a
    // mode (not stuck mid-boot). At least one retry Set must have happened.
    const setCalls = rt.stats().httpCalls.filter(function (c) { return c.kind === 'set'; });
    assert.ok(setCalls.length > 7, 'expected retries beyond the 7 initial closes, got ' + setCalls.length);
    const st = rt.lastState();
    assert.ok(st !== null, 'control loop should have published a state after a successful boot');
  });

  it('exhausted valve attempts bail the transition to IDLE (fail-safe preserved)', async () => {
    // Boot closes succeed, device settles in IDLE, then a clean IDLE→SOLAR
    // transition is attempted whose valve opens ALWAYS fail. setValves must
    // bail: pump off, mode IDLE, cause=failed.
    let phase = 'boot';
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      // Start in IDLE: collector cooler than tank so no SC on boot.
      sensorResponder: function (sensor) {
        const idle = { collector: 20, tank_top: 45, tank_bottom: 40, greenhouse: 20, outdoor: 12 };
        const solar = SOLAR_TEMPS;
        const t = phase === 'solar' ? solar : idle;
        return { ok: true, body: JSON.stringify({ tC: t[sensor] }) };
      },
      valveResponder: function (kind) {
        // During the SOLAR transition, every OPEN Set fails permanently.
        if (phase === 'solar' && kind === 'set') return { code: 500, body: '{}', err: 'fail' };
        return null;
      },
    });
    await boot(rt);
    for (let k = 0; k < 2; k++) { rt.advance(30000); await rt.drain(); }
    assert.strictEqual(rt.lastState().mode, 'idle', 'precondition: parked in IDLE');

    // Flip the world to SOLAR; the next tick attempts IDLE→SC and the opens
    // fail. The staged transition defers each step (setActuators stop → 1 s
    // VALVE_SETTLE timer → scheduleStep → bounded valve opens → retry) onto a
    // fresh timer/setImmediate frame, so we must interleave advance + drain
    // repeatedly to let the whole chain resolve, not a single advance.
    phase = 'solar';
    rt.advance(30000);
    for (let k = 0; k < 20; k++) { await rt.drain(20); rt.advance(2000); }
    const st = rt.lastState();
    assert.strictEqual(st.mode, 'idle', 'failed valve opens must leave mode IDLE (fail-safe)');
    assert.strictEqual(st.cause, 'failed', 'lastTransitionCause must be "failed" after a valve bail');
    assert.strictEqual(st.transitioning, false, 'transitioning must be cleared after the bail');
  });
});
