/**
 * Valve-command retry window (flaky-WiFi valve hosts).
 *
 * Field incident 2026-07-28: Valve Control 1 (192.168.30.51, vi_btm/vi_top)
 * sat at -75…-77 dBm and flapped WiFi — connected for 2–20 s windows every
 * ~30–60 s. The old behaviour (VSA=2 back-to-back attempts × 3 s timeout,
 * then finalizeTransitionFail) gave up within ~6 s, so every
 * greenhouse_heating entry died with cause="failed" even though the valve
 * host was reachable half a minute later.
 *
 * New behaviour under test:
 *   1. A failed valve batch does NOT bail the transition immediately — the
 *      shell re-plans and retries every VALVE_RETRY.delayMs while the
 *      transition deadline (VALVE_RETRY.windowMs, 5 min) has not passed.
 *      No cause="failed" state is published inside the window.
 *   2. If the valve host recovers inside the window, the transition
 *      completes normally.
 *   3. Continuous failure past the window falls back to the existing
 *      fail-safe: pump off, IDLE, cause="failed", transitioning=false.
 *   4. Exit-from-ACTIVE_DRAIN retries stop the pump before waiting (the
 *      drain-exit branch intentionally keeps the pump running while valves
 *      close — see CLAUDE.md — but a retry wait must not extend that into
 *      minutes of dry-running).
 *
 * Uses the same local runtime pattern as shelly-wifi-hardening.test.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');
const FILES = ['control-logic.js', 'control.js'];
const VALVE_RETRY = require('../shelly/control-logic.js').VALVE_RETRY;

const CID_TO_SENSOR = { 100: 'collector', 101: 'tank_top', 102: 'tank_bottom', 103: 'greenhouse', 104: 'outdoor' };
// Drives evaluate() into SOLAR_CHARGING (collector hotter than tank_bottom).
const SOLAR_TEMPS = { collector: 60, tank_top: 40, tank_bottom: 30, greenhouse: 18, outdoor: 15 };
const IDLE_TEMPS = { collector: 20, tank_top: 45, tank_bottom: 40, greenhouse: 20, outdoor: 12 };

function urlHost(url) { const m = url.match(/^http:\/\/([0-9.]+)\//); return m ? m[1] : null; }

function createRuntime(opts) {
  opts = opts || {};
  let now = 1700000000000;
  let timers = [];
  let timerIdCounter = 0;
  const kvs = Object.assign({}, opts.kvs || {});
  const publishes = [];
  const httpCalls = []; // { url, atMs, kind }
  const switchSets = []; // local Switch.Set calls: { id, on, atMs }

  // valveResponder(url, host, atMs) → { code, body } | null (null = 200 OK)
  const valveResponder = opts.valveResponder || null;
  const sensorTemps = opts.sensorTemps || (() => SOLAR_TEMPS);

  function shellyCall(method, params, cb) {
    params = params || {};
    if (method === 'HTTP.GET') {
      const url = params.url || '';
      const isSensor = url.indexOf('Temperature.GetStatus') >= 0;
      const kind = isSensor ? 'sensor' : (url.indexOf('Switch.Set') >= 0 ? 'set' : 'other');
      httpCalls.push({ url, atMs: now, kind });
      if (isSensor) {
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
        if (cb) cb({ code: r.code, body: r.body || '{}' }, r.code === 200 ? null : 'fail');
      });
      return;
    }
    if (method === 'Switch.Set') {
      switchSets.push({ id: params.id, on: params.on, atMs: now });
      setImmediate(() => { if (cb) cb({}, null); });
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
    // Advance sim time in small steps, draining the microtask queue between
    // steps so retry timers, HTTP callbacks and staged-transition timers all
    // interleave the way they would on-device.
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
    nowMs: () => now,
    httpCalls,
    switchSets,
    publishes,
    states() {
      return publishes
        .filter(p => p.topic === 'greenhouse/state/min')
        .map(p => { try { return Object.assign(JSON.parse(p.payload), { atMs: p.atMs }); } catch (_e) { return null; } })
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
  h: ['192.168.30.20'], v: 1,
});
const DEVICE_CONFIG = JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, tu: {}, v: 1 });

async function boot(rt) {
  loadScripts(rt);
  for (let i = 0; i < 50; i++) { await rt.drain(1); rt.advance(1); }
  rt.advance(15000);
  for (let i = 0; i < 60; i++) { await rt.drain(1); rt.advance(1); }
}

describe('valve retry window: recovery inside the window', () => {
  it('holds the transition through a WiFi flap and completes on recovery', async () => {
    let phase = 'boot';
    let recoverAtMs = Infinity;
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorTemps: () => (phase === 'solar' ? SOLAR_TEMPS : IDLE_TEMPS),
      valveResponder: (url, host, atMs) => {
        // Post-boot, .5x valve hosts are unreachable until recoverAtMs.
        if (phase === 'solar' && atMs < recoverAtMs) return { code: 500 };
        return null;
      },
    });
    await boot(rt);
    await rt.run(60000);
    assert.strictEqual(rt.lastState().mode, 'idle', 'precondition: parked in IDLE');

    // Flip to solar; the transition's valve opens fail for 90 s, then the
    // host "reconnects" (well inside the 5 min retry window).
    phase = 'solar';
    const startMs = rt.nowMs();
    recoverAtMs = startMs + 90000;
    await rt.run(240000);

    // 1. No failed bail was published inside the flap.
    const failed = rt.states().filter(s => s.atMs > startMs && s.cause === 'failed');
    assert.strictEqual(failed.length, 0,
      'no cause=failed may be published while the retry window rides out the flap');

    // 2. The transition completed once the host recovered.
    const last = rt.lastState();
    assert.strictEqual(last.mode, 'solar_charging',
      'transition must complete after the valve host recovers inside the window');
    assert.strictEqual(last.transitioning, false);

    // 3. Retries actually spanned the outage (initial cycle + spaced retries).
    const failWindowSets = rt.httpCalls.filter(c =>
      c.kind === 'set' && c.atMs > startMs && c.atMs < recoverAtMs);
    assert.ok(failWindowSets.length >= 6,
      'expected spaced retry attempts during the 90 s outage, got ' + failWindowSets.length);
    const span = Math.max(...failWindowSets.map(c => c.atMs)) - Math.min(...failWindowSets.map(c => c.atMs));
    assert.ok(span >= 30000,
      'retry attempts should be spread across the outage, span was ' + span + ' ms');
  });
});

describe('valve retry window: exhaustion falls back to fail-safe', () => {
  it('gives up with cause=failed only after the full retry window', async () => {
    let phase = 'boot';
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorTemps: () => (phase === 'solar' ? SOLAR_TEMPS : IDLE_TEMPS),
      valveResponder: () => (phase === 'solar' ? { code: 500 } : null),
    });
    await boot(rt);
    await rt.run(60000);
    assert.strictEqual(rt.lastState().mode, 'idle', 'precondition: parked in IDLE');

    phase = 'solar';
    const startMs = rt.nowMs();
    await rt.run(VALVE_RETRY.windowMs + 90000, 2000);

    const failedStates = rt.states().filter(s => s.atMs > startMs && s.cause === 'failed');
    assert.ok(failedStates.length > 0, 'the exhausted window must publish cause=failed');
    const firstFail = failedStates[0];
    assert.ok(firstFail.atMs - startMs >= VALVE_RETRY.windowMs - 30000,
      'fail-safe must not fire before the retry window elapses (fired after ' +
      Math.round((firstFail.atMs - startMs) / 1000) + ' s)');
    // The terminal failed state is the fail-safe: parked in IDLE, not
    // transitioning. (The very NEXT 30 s tick may legitimately start a fresh
    // transition attempt with a fresh window, so lastState() is not asserted.)
    assert.strictEqual(firstFail.mode, 'idle');
    assert.strictEqual(firstFail.transitioning, false);
  });
});

describe('valve retry window: ACTIVE_DRAIN exit stops the pump before waiting', () => {
  it('turns the pump off when a drain-exit close batch fails', async () => {
    let failCloses = false;
    const rt = createRuntime({
      kvs: { config: DEVICE_CONFIG, sensor_config: SENSOR_CONFIG },
      sensorTemps: () => IDLE_TEMPS,
      valveResponder: () => (failCloses ? { code: 500 } : null),
    });
    await boot(rt);
    await rt.run(60000);

    // Drive an ACTIVE_DRAIN → IDLE exit whose valve closes fail. The
    // drain-exit branch keeps the pump running while valves close; the
    // retry wait must stop it instead of dry-running for minutes.
    failCloses = true;
    rt.globals.Shelly.__test_driveTransition('ACTIVE_DRAIN', {
      nextMode: 'IDLE',
      valves: {
        vi_btm: false, vi_top: false, vi_coll: false,
        vo_coll: false, vo_rad: false, vo_tank: false, v_air: false,
      },
      actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
      flags: {
        collectorsDrained: true, lastRefillAttempt: 0,
        emergencyHeatingActive: false,
        solarChargePeakTankAvg: null, solarChargePeakTankAvgAt: 0,
      },
      suppressed: false, safetyOverride: false,
    });
    const startMs = rt.nowMs();
    await rt.run(30000);

    const pumpOff = rt.switchSets.filter(s => s.id === 0 && s.on === false && s.atMs >= startMs);
    assert.ok(pumpOff.length > 0,
      'pump must be switched off shortly after a failed drain-exit close batch (no minutes-long dry run)');
    assert.ok(Math.min(...pumpOff.map(s => s.atMs)) - startMs <= 15000,
      'pump-off must happen within the first retry cycle');
  });
});
