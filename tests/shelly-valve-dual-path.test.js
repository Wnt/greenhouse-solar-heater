/**
 * Dual-path valve actuation: Ethernet first, WiFi fallback.
 *
 * The Pro devices share an isolated Ethernet switch (no upstream, no DHCP)
 * with static IPs on a dedicated subnet (192.168.31.0/24 — see system.yaml
 * shelly_components.networking). Valve commands from the Pro 4PM try the
 * wired address first; if that attempt fails (cable fault, unprovisioned
 * device) the retry goes to the WiFi address, so the wired path can never
 * make things worse than WiFi-only operation.
 *
 * Uses the same local runtime pattern as shelly-valve-retry-window.test.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');
const FILES = ['control-logic.js', 'control.js'];

const CID_TO_SENSOR = { 100: 'collector', 101: 'tank_top', 102: 'tank_bottom', 103: 'greenhouse', 104: 'outdoor' };
const SOLAR_TEMPS = { collector: 60, tank_top: 40, tank_bottom: 30, greenhouse: 18, outdoor: 15 };
const IDLE_TEMPS = { collector: 20, tank_top: 45, tank_bottom: 40, greenhouse: 20, outdoor: 12 };

function urlHost(url) { const m = url.match(/^http:\/\/([0-9.]+)\//); return m ? m[1] : null; }
const isEth = (host) => /^192\.168\.31\./.test(host || '');
const isWifi = (host) => /^192\.168\.30\.5/.test(host || '');

function createRuntime(opts) {
  opts = opts || {};
  let now = 1700000000000;
  let timers = [];
  let timerIdCounter = 0;
  const kvs = Object.assign({}, opts.kvs || {});
  const publishes = [];
  const httpCalls = []; // { url, host, atMs, kind }

  // valveResponder(url, host, atMs) → { code } | null (null = 200 OK)
  const valveResponder = opts.valveResponder || null;
  const sensorTemps = opts.sensorTemps || (() => SOLAR_TEMPS);
  // sensorHostOk(host) → false to fail sensor polls on that host (dual-path
  // sensor-hub tests). Default: every host answers.
  const sensorHostOk = opts.sensorHostOk || (() => true);

  function shellyCall(method, params, cb) {
    params = params || {};
    if (method === 'HTTP.GET') {
      const url = params.url || '';
      const isSensor = url.indexOf('Temperature.GetStatus') >= 0;
      const kind = isSensor ? 'sensor' : (url.indexOf('Switch.Set') >= 0 ? 'set' : 'other');
      httpCalls.push({ url, host: urlHost(url), atMs: now, kind });
      if (isSensor) {
        if (!sensorHostOk(urlHost(url))) {
          setImmediate(() => { if (cb) cb({ code: 500, body: '{}' }, 'fail'); });
          return;
        }
        let sensor = 'collector';
        const m = url.match(/id=(\d+)/);
        if (m) sensor = CID_TO_SENSOR[parseInt(m[1], 10)] || 'collector';
        const body = JSON.stringify({ tC: sensorTemps()[sensor] });
        setImmediate(() => { if (cb) cb({ code: 200, body }, null); });
        return;
      }
      const r = valveResponder ? valveResponder(url, urlHost(url), now) : null;
      setImmediate(() => {
        if (!r) { if (cb) cb({ code: 200, body: '{}' }, null); return; }
        if (cb) cb({ code: r.code, body: '{}' }, r.code === 200 ? null : 'fail');
      });
      return;
    }
    if (method === 'KVS.Get') { const v = kvs[params.key] || null; setImmediate(() => { if (cb) cb(v ? { value: v } : null, null); }); return; }
    if (method === 'KVS.Set') { kvs[params.key] = params.value; setImmediate(() => { if (cb) cb({}, null); }); return; }
    setImmediate(() => { if (cb) cb({}, null); });
  }

  function timerSet(ms, repeat, cb) { const id = ++timerIdCounter; timers.push({ id, repeat: !!repeat, oneshot: !repeat, cb, dueAt: now + (ms || 0), ms: ms || 0 }); return id; }
  function timerClear(id) { timers = timers.filter(t => t.id !== id); }

  function fireDueTimers() {
    let fired = true;
    let guard = 0;
    while (fired && guard++ < 10000) {
      fired = false;
      timers.sort((a, b) => a.dueAt - b.dueAt);
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
      publish: function (topic, payload) { publishes.push({ topic, payload, atMs: now }); },
      isConnected: function () { return true; }, setConnectHandler: function () {},
    },
    JSON, Date: { now: () => now }, Math, parseInt, print: function () {},
  };

  return {
    globals,
    advance(ms) { now += ms; fireDueTimers(); },
    async drain(rounds) {
      rounds = rounds || 40;
      for (let i = 0; i < rounds; i++) {
        await new Promise(r => setImmediate(r));
        fireDueTimers();
      }
    },
    async run(ms, stepMs) {
      const step = stepMs || 1000;
      for (let t = 0; t < ms; t += step) {
        now += Math.min(step, ms - t);
        fireDueTimers();
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setImmediate(r));
          fireDueTimers();
        }
      }
    },
    httpCalls,
    states() {
      return publishes
        .filter(p => p.topic === 'greenhouse/state/min')
        .map(p => { try { return JSON.parse(p.payload); } catch (_e) { return null; } })
        .filter(Boolean);
    },
    lastState() { const s = this.states(); return s.length ? s[s.length - 1] : null; },
  };
}

function loadScripts(runtime) {
  const src = FILES.map(f => fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8')).join('\n');
  const fn = new Function('Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print', '__TEST_HARNESS', src);
  const g = runtime.globals;
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

const SENSOR_CONFIG = JSON.stringify({
  s: {
    collector: { h: 0, i: 100 }, tank_top: { h: 0, i: 101 }, tank_bottom: { h: 0, i: 102 },
    greenhouse: { h: 0, i: 103 }, outdoor: { h: 0, i: 104 },
  },
  h: ['192.168.30.55'], v: 1,
});
const DEVICE_CONFIG = JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, tu: {}, v: 1 });

async function boot(rt) {
  loadScripts(rt);
  for (let i = 0; i < 50; i++) { await rt.drain(1); rt.advance(1); }
  rt.advance(15000);
  for (let i = 0; i < 60; i++) { await rt.drain(1); rt.advance(1); }
}

describe('dual-path valve actuation: Ethernet primary', () => {
  it('commands valves over the wired subnet when it works — WiFi never needed', async () => {
    let phase = 'boot';
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorTemps: () => (phase === 'solar' ? SOLAR_TEMPS : IDLE_TEMPS),
      // WiFi valve hosts hard-fail after boot (radio down entirely);
      // Ethernet responds normally.
      valveResponder: (url, host) => {
        if (phase === 'solar' && isWifi(host)) return { code: 500 };
        return null;
      },
    });
    await boot(rt);
    await rt.run(60000);
    assert.strictEqual(rt.lastState().mode, 'idle', 'precondition: parked in IDLE');

    phase = 'solar';
    await rt.run(120000);

    assert.strictEqual(rt.lastState().mode, 'solar_charging',
      'transition must complete over the wired path with WiFi valve hosts dead');
    const solarSets = rt.httpCalls.filter(c => c.kind === 'set' && isEth(c.host));
    assert.ok(solarSets.length > 0, 'valve Sets must go to the 192.168.31.x wired subnet');
  });

  it('falls back to WiFi when the wired path is down', async () => {
    let phase = 'boot';
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorTemps: () => (phase === 'solar' ? SOLAR_TEMPS : IDLE_TEMPS),
      // Ethernet never answers (unplugged cable / unprovisioned device);
      // WiFi works.
      valveResponder: (url, host) => (isEth(host) ? { code: 500 } : null),
    });
    await boot(rt);
    await rt.run(60000);
    assert.strictEqual(rt.lastState().mode, 'idle', 'precondition: parked in IDLE');

    phase = 'solar';
    await rt.run(120000);

    assert.strictEqual(rt.lastState().mode, 'solar_charging',
      'transition must complete via the WiFi fallback when the wire is down');
    const ethTried = rt.httpCalls.filter(c => c.kind === 'set' && isEth(c.host));
    const wifiUsed = rt.httpCalls.filter(c => c.kind === 'set' && isWifi(c.host));
    assert.ok(ethTried.length > 0, 'the wired address must be attempted first');
    assert.ok(wifiUsed.length > 0, 'the WiFi address must be used as fallback');
  });
});

// ── Sensor polling stays WiFi-only (firmware-crash regression pin) ──
// A wired-first sensor poll (eth island first, WiFi fallback) was deployed
// 2026-07-29 and hard-reboot-looped the Pro 4PM: HTTP.GET to an eth-island
// address with no live host (ARP never resolves) crashes fw 1.7.x within
// one poll cycle. These tests PIN the revert: sensor polls must go only to
// the configured (WiFi) host. Do not resurrect eth-first polling without
// first understanding that firmware behavior on the spare hub — see
// design/docs/sensor-hub-pro-migration.md.
describe('sensor polling is single-path (firmware-crash regression pin)', () => {
  it('polls only the configured host — never a derived eth-island address', async () => {
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorTemps: () => SOLAR_TEMPS,
    });
    await boot(rt);
    await rt.run(90000);

    const sensorPolls = rt.httpCalls.filter(c => c.kind === 'sensor');
    assert.ok(sensorPolls.length >= 5, 'expected sensor polls, got ' + sensorPolls.length);
    const ethPolls = sensorPolls.filter(c => isEth(c.host));
    assert.strictEqual(ethPolls.length, 0,
      'sensor polls must NEVER dial the eth island (fw hard-reboot, 2026-07-29): ' +
      ethPolls.map(c => c.url).join(', '));
    assert.ok(sensorPolls.every(c => c.host === '192.168.30.55'),
      'every sensor poll goes to the configured WiFi host');
    assert.strictEqual(rt.lastState().mode, 'solar_charging', 'control runs normally');
  });
});
