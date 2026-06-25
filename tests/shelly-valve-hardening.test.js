/**
 * Valve-actuation hardening for degraded WiFi (issue #262, WS3).
 *
 * The Pro 4PM control script actuates the 7 motorized valves over LAN HTTP
 * RPC (Switch.Set on the .51–.54 Pro 2PM hosts) during every mode
 * transition. On a flaky WiFi link those per-valve connections become slow /
 * partial / dropped, which (a) holds firmware connection buffers open on the
 * long default HTTP timeout, (b) lets a valve cycle overlap a sensor poll
 * cycle and pile up toward the 5-concurrent-HTTP-call limit, and (c) can
 * leave a valve commanded-but-not-actually-moved with no detection. These
 * tests pin the hardening that keeps the LOCAL actuation path resilient —
 * WITHOUT introducing any broker dependency:
 *
 *   1. Short explicit timeout (~3 s) on every valve Switch.Set HTTP.GET so a
 *      lost packet fails fast instead of holding firmware buffers.
 *   2. Bounded retries (<= 2 attempts) with a short backoff between attempts
 *      — a transient drop is ridden out, but the script never spins forever.
 *   3. Post-actuation VERIFY: after a 200-looking Switch.Set response, the
 *      script reads Switch.GetStatus and only declares success if the relay
 *      output actually matches the commanded position. A "lying" 200 (relay
 *      did not move) is treated as a failure.
 *   4. On confirmed failure the EXISTING fail-safe is preserved: setValves
 *      bails — pump off, mode IDLE, lastTransitionCause="failed".
 *   5. In-flight guard: a valve cycle (transition) and a sensor poll cycle
 *      never overlap, so the two HTTP paths cannot stack toward the 5-call
 *      limit.
 *
 * control-logic.js stays pure; all of this lives in control.js. The mock
 * runtime drives the REAL setValve / setValves / transition shapes with a
 * scriptable HTTP responder (per-host outcome + relay-state model) and a
 * virtual clock.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

const CID_TO_SENSOR = { 100: 'collector', 101: 'tank_top', 102: 'tank_bottom', 103: 'greenhouse', 104: 'outdoor' };

// Temps that drive evaluate() into SOLAR_CHARGING (collector hotter than
// tank_bottom; nothing freezing/overheating). The SC transition opens
// vi_btm + vo_coll, so the valve path is exercised.
const SOLAR_TEMPS = { collector: 60, tank_top: 40, tank_bottom: 30, greenhouse: 18, outdoor: 15 };

// Temps that keep evaluate() in IDLE (collector cooler than tank; nothing
// freezing/overheating; greenhouse comfortable). Used so a test can boot the
// device parked in IDLE with all valves CLOSED, then drive a clean IDLE→SC
// transition whose valve opens genuinely fire (and can be made to fail).
const IDLE_TEMPS = { collector: 20, tank_top: 45, tank_bottom: 40, greenhouse: 20, outdoor: 12 };

// Parse the relay id from a Switch.Set / Switch.GetStatus HTTP.GET URL.
function urlSwitchId(url) {
  const m = url.match(/[?&]id=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
// Parse the host IP (the .51–.54 valve controllers) from a URL.
function urlHost(url) {
  const m = url.match(/^http:\/\/([0-9.]+)\//);
  return m ? m[1] : null;
}

function createRuntime(opts) {
  opts = opts || {};
  let now = opts.startTime || 1700000000000;
  let sysUptime = 100;
  let timers = [];
  let timerIdCounter = 0;
  const kvs = {};
  const publishes = [];

  let httpInFlight = 0;
  let peakHttpInFlight = 0;
  const httpCalls = []; // { url, timeout, kind }

  // Per-host model of the relay output for each valve controller. Keyed
  // "<ip>:<id>". Switch.GetStatus reflects this; Switch.Set updates it
  // (unless a fault makes the Set lie). Default false (closed).
  const relayOutput = {};
  function relayKey(ip, id) { return ip + ':' + id; }

  // valveResponder(kind, url, id, host) → outcome object:
  //   { drop:true }                          — never resolves (lost packet);
  //                                            only the script timeout frees it.
  //   { code, body, applied }                — HTTP result. For a Switch.Set,
  //                                            `applied` (default true) decides
  //                                            whether the relayOutput model is
  //                                            actually flipped. applied:false
  //                                            models a "lying 200" (relay did
  //                                            not move) so the verify step can
  //                                            catch it.
  // Default: every call succeeds and Switch.Set applies.
  let valveResponder = opts.valveResponder || null;

  let sensorResponder = opts.sensorResponder || function (sensor) {
    return { ok: true, body: JSON.stringify({ tC: SOLAR_TEMPS[sensor] }) };
  };

  function shellyCall(method, params, cb) {
    params = params || {};
    if (method === 'HTTP.GET') {
      const url = params.url || '';
      httpInFlight++;
      if (httpInFlight > peakHttpInFlight) peakHttpInFlight = httpInFlight;
      const isSensor = url.indexOf('Temperature.GetStatus') >= 0 || url.indexOf('Shelly.GetStatus') >= 0;
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
        const delay = r.delayMs || 0;
        timers.push({ id: ++timerIdCounter, dueAt: now + delay, oneshot: true, cb: function () {
          if (r.ok === false) { settle(null, r.err || 'error'); return; }
          settle({ code: 200, body: r.body || '' }, null);
        } });
        return;
      }

      // Valve path: Switch.Set or Switch.GetStatus on a .51–.54 host.
      const host = urlHost(url);
      const id = urlSwitchId(url);
      const key = relayKey(host, id);
      const onMatch = /[?&]on=true/.test(url);

      let r = null;
      if (valveResponder) r = valveResponder(kind, url, id, host);
      if (!r) {
        // Default: succeed. A Set applies to the relay model.
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
      const delay = r.delayMs || 0;
      timers.push({ id: ++timerIdCounter, dueAt: now + delay, oneshot: true, cb: function () {
        if (isSet) {
          const applied = r.applied !== false; // default: the Set actually moves the relay
          if (applied && r.code === 200) relayOutput[key] = onMatch;
          settle({ code: r.code, body: r.body || '{}' }, r.code === 200 ? null : (r.err || null));
          return;
        }
        if (isGet) {
          // A verify read may itself be scripted (drop/500); otherwise it
          // reports the current relay model.
          if (r.code && r.code !== 200) { settle({ code: r.code, body: r.body || '{}' }, r.err || null); return; }
          const body = r.body !== undefined ? r.body : JSON.stringify({ id, output: !!relayOutput[key] });
          settle({ code: 200, body }, null);
          return;
        }
        settle({ code: r.code || 200, body: r.body || '{}' }, r.code && r.code !== 200 ? (r.err || null) : null);
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
        if (type === 'sys') return { unixtime: Math.floor(now / 1000), uptime: sysUptime };
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
    while (fired && guard++ < 100000) {
      fired = false;
      let next = null;
      for (let i = 0; i < timers.length; i++) {
        if (timers[i].dueAt <= now && (next === null || timers[i].dueAt < next.dueAt)) next = timers[i];
      }
      if (next) {
        if (next.repeat) { next.dueAt = now + next.ms; } else { timers = timers.filter(function (t) { return t.id !== next.id; }); }
        try { next.cb(); } catch (e) {}
        fired = true;
      }
    }
  }

  return {
    globals, kvs,
    setValveResponder: function (fn) { valveResponder = fn; },
    setSensorResponder: function (fn) { sensorResponder = fn; },
    setUptime: function (s) { sysUptime = s; },
    now: function () { return now; },
    relayOutput: function () { return Object.assign({}, relayOutput); },
    peakHttpInFlight: function () { return peakHttpInFlight; },
    httpCalls: function () { return httpCalls.slice(); },
    clearHttpCalls: function () { httpCalls.length = 0; },
    states: function () {
      return publishes
        .filter(function (p) { return p.topic === 'greenhouse/state/min'; })
        .map(function (p) { try { return JSON.parse(p.payload); } catch (e) { return {}; } });
    },
    lastState: function () { const s = this.states(); return s.length ? s[s.length - 1] : null; },
    advance: function (ms, done) {
      const endAt = now + ms;
      let totalRounds = 0;
      let idle = 0;
      function step() {
        if (totalRounds++ > 500000) { done(); return; }
        fireDueTimers();
        let dueNow = false;
        let nextDue = null;
        for (let i = 0; i < timers.length; i++) {
          if (timers[i].dueAt <= now) { dueNow = true; break; }
          if (nextDue === null || timers[i].dueAt < nextDue) nextDue = timers[i].dueAt;
        }
        if (dueNow) { idle = 0; setImmediate(step); return; }
        if (idle++ < 60) { setImmediate(step); return; }
        idle = 0;
        if (now >= endAt) { done(); return; }
        now = (nextDue !== null && nextDue < endAt) ? nextDue : endAt;
        setImmediate(step);
      }
      setImmediate(step);
    },
    // Fire the repeating controlLoop timer once and settle the async chain
    // WITHOUT advancing the virtual clock (in-flight delayed responses stay
    // pending — needed to exercise the in-flight guard).
    tick: function (done) {
      const cl = timers.find(function (t) { return t.repeat && t.ms >= 10000; });
      if (cl) { try { cl.cb(); } catch (e) {} }
      let rounds = 0, idle = 0;
      function drain() {
        if (rounds++ > 800) { done(); return; }
        fireDueTimers();
        let dueNow = false;
        for (let i = 0; i < timers.length; i++) { if (timers[i].dueAt <= now) { dueNow = true; break; } }
        if (dueNow) { idle = 0; setImmediate(drain); return; }
        if (idle++ < 8) { setImmediate(drain); return; }
        done();
      }
      setImmediate(drain);
    },
  };
}

function loadScript(rt, cfg) {
  rt.kvs.config = JSON.stringify(Object.assign({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, tu: {}, v: 1 }, cfg || {}));
  rt.kvs.drained = '0';
  rt.kvs.sensor_config = JSON.stringify({
    s: {
      collector: { h: 0, i: 100 }, tank_top: { h: 0, i: 101 }, tank_bottom: { h: 0, i: 102 },
      greenhouse: { h: 0, i: 103 }, outdoor: { h: 0, i: 104 },
    },
    h: ['192.168.30.20'],
    v: 1,
  });
  const src = fs.readFileSync(path.join(SHELLY_DIR, 'control-logic.js'), 'utf8') + '\n' +
              fs.readFileSync(path.join(SHELLY_DIR, 'control.js'), 'utf8');
  const g = rt.globals;
  const fn = new Function('Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print', '__TEST_HARNESS', src);
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print, true);
}

function boot(rt, cfg, done) { loadScript(rt, cfg); rt.advance(90000, done); }

// A SOLAR_CHARGING transition-result shape for __test_driveTransition. SC
// opens vi_btm (.51 id0) + vo_coll (.52 id1) and runs the pump.
function scResult() {
  return {
    nextMode: 'SOLAR_CHARGING',
    valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
    actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
    flags: {},
  };
}

// Boot the device parked in IDLE with valves CLOSED (cold temps), so a
// subsequent IDLE→SC drive genuinely opens valves over HTTP.
function bootIdle(rt, cfg, done) {
  loadScript(rt, cfg);
  rt.setSensorResponder(function (sensor) { return { ok: true, body: JSON.stringify({ tC: IDLE_TEMPS[sensor] }) }; });
  rt.advance(90000, done);
}

// Drive a deterministic fresh IDLE→SOLAR_CHARGING transition with whatever
// valve responder is currently set, then settle. Used by the failure-path
// tests so the faulty responder is active DURING the valve actuation (rather
// than after the device already reached SC on the healthy boot responder).
function driveSCTransition(rt, done) {
  rt.globals.Shelly.__test_driveTransition('IDLE', scResult());
  rt.advance(60000, done);
}

// ── 1. Explicit short timeout on every valve Switch.Set HTTP.GET ──

describe('valve Switch.Set carries a short explicit timeout (#262)', function () {
  it('every valve Switch.Set HTTP.GET passes a timeout <= 5 s', function (t, done) {
    const rt = createRuntime();
    boot(rt, { fm: 'SC' }, function () {
      // A few ticks so the forced SC transition fires the valve opens.
      rt.advance(120000, function () {
        const setCalls = rt.httpCalls().filter(function (c) { return c.kind === 'set'; });
        assert.ok(setCalls.length >= 1, 'expected at least one valve Switch.Set during the SC transition');
        for (let i = 0; i < setCalls.length; i++) {
          assert.ok(typeof setCalls[i].timeout === 'number' && setCalls[i].timeout > 0 && setCalls[i].timeout <= 5,
            'valve Switch.Set must carry an explicit short timeout (got ' + setCalls[i].timeout + ') for url ' + setCalls[i].url);
        }
        done();
      });
    });
  });

  it('the post-actuation Switch.GetStatus verify also carries a short timeout', function (t, done) {
    const rt = createRuntime();
    boot(rt, { fm: 'SC' }, function () {
      rt.advance(120000, function () {
        const getCalls = rt.httpCalls().filter(function (c) { return c.kind === 'get'; });
        assert.ok(getCalls.length >= 1, 'expected at least one Switch.GetStatus verify read');
        for (let i = 0; i < getCalls.length; i++) {
          assert.ok(typeof getCalls[i].timeout === 'number' && getCalls[i].timeout > 0 && getCalls[i].timeout <= 5,
            'verify read must carry a short timeout (got ' + getCalls[i].timeout + ')');
        }
        done();
      });
    });
  });
});

// ── 2. Post-actuation verify via Switch.GetStatus ──

describe('valve actuation verifies the relay actually moved (#262)', function () {
  it('a 200 Switch.Set that did NOT move the relay is treated as a failure', function (t, done) {
    // Every Switch.Set returns 200 but applied:false (relay never moves). The
    // verify read therefore reports the relay still in its old position, so
    // setValve must NOT declare success — the transition bails to IDLE.
    const rt = createRuntime();
    bootIdle(rt, null, function () {
      rt.setValveResponder(function (kind) {
        if (kind === 'set') return { code: 200, applied: false };
        return null; // verify read reflects the (unchanged) relay model
      });
      rt.clearHttpCalls();
      driveSCTransition(rt, function () {
        const verifyReads = rt.httpCalls().filter(function (c) { return c.kind === 'get'; });
        assert.ok(verifyReads.length >= 1,
          'expected a Switch.GetStatus verify read after the 200 Switch.Set');
        const last = rt.lastState();
        assert.ok(last && last.mode !== 'solar_charging',
          'a lying 200 (relay never moved) must NOT count as success; expected fallback away from solar_charging, got ' + (last && last.mode));
        done();
      });
    });
  });

  it('a Switch.Set that genuinely moves the relay verifies and succeeds', function (t, done) {
    const rt = createRuntime();
    boot(rt, { fm: 'SC' }, function () {
      // Default responder: Set applies, verify confirms. Device should reach SC.
      rt.advance(150000, function () {
        const last = rt.lastState();
        assert.ok(last && last.mode === 'solar_charging',
          'a genuine valve move must verify and let the transition complete; got ' + (last && last.mode));
        // And the relay model must show the SC valves open.
        const ro = rt.relayOutput();
        assert.strictEqual(ro['192.168.30.51:0'], true, 'vi_btm should be open after SC entry');
        done();
      });
    });
  });
});

// ── 3. Bounded retries with backoff ──

describe('valve actuation retries are bounded (#262)', function () {
  it('a transient drop on the first Switch.Set is retried and then succeeds', function (t, done) {
    const rt = createRuntime();
    bootIdle(rt, null, function () {
      // First Set attempt per valve command drops (lost packet); the retry
      // succeeds and applies. The transition must complete into SC.
      const firstSeen = {};
      rt.setValveResponder(function (kind, url, id, host) {
        if (kind === 'set') {
          const key = host + ':' + id + ':' + (/on=true/.test(url) ? '1' : '0');
          if (!firstSeen[key]) { firstSeen[key] = true; return { drop: true }; }
          return { code: 200 }; // retry applies and moves the relay
        }
        return null;
      });
      // Keep evaluate() agreeing with SC so the periodic ticks after the
      // forced transition don't immediately re-evaluate back to IDLE.
      rt.setSensorResponder(function (sensor) { return { ok: true, body: JSON.stringify({ tC: SOLAR_TEMPS[sensor] }) }; });
      rt.clearHttpCalls();
      driveSCTransition(rt, function () {
        const last = rt.lastState();
        assert.ok(last && last.mode === 'solar_charging',
          'a single transient drop must be ridden out by the retry; got ' + (last && last.mode));
        // Proof the retry actually fired: at least one valve made >1 Set attempt.
        const sets = rt.httpCalls().filter(function (c) { return c.kind === 'set'; });
        assert.ok(sets.length >= 3,
          'expected the first-attempt drop to force a retry (>=3 Set calls across the 2 valves); saw ' + sets.length);
        // The SC valves must actually be open in the relay model.
        const ro = rt.relayOutput();
        assert.strictEqual(ro['192.168.30.51:0'], true, 'vi_btm should be open after a retried-but-successful SC entry');
        done();
      });
    });
  });

  it('a valve that NEVER responds bails the transition (no infinite spin)', function (t, done) {
    const rt = createRuntime();
    bootIdle(rt, null, function () {
      // Every Set attempt drops. Bounded retries exhaust → confirmed failure.
      rt.setValveResponder(function (kind) {
        if (kind === 'set') return { drop: true };
        return null;
      });
      rt.clearHttpCalls();
      driveSCTransition(rt, function () {
        const last = rt.lastState();
        assert.ok(last && last.mode === 'idle',
          'an unreachable valve must bail to IDLE, not spin forever; got ' + (last && last.mode));
        // Bounded: per valve, attempts capped at VALVE_SET_ATTEMPTS. We assert
        // the device did not issue an unbounded flood of Set calls. SC opens 2
        // valves; with <=2 attempts each that is <=4 Set calls for the bailing
        // transition. Modest finite ceiling.
        const setCalls = rt.httpCalls().filter(function (c) { return c.kind === 'set'; });
        assert.ok(setCalls.length <= 8,
          'retries must be bounded; saw ' + setCalls.length + ' Switch.Set calls (expected a small finite count)');
        done();
      });
    });
  });

  it('at most 2 Set attempts are made for a single valve command', function (t, done) {
    const rt = createRuntime();
    bootIdle(rt, null, function () {
      // Count Set attempts per (host,id,position) within a SINGLE transition.
      // All drops → the first valve attempted exhausts its retry budget and
      // bails, so the per-command attempt count is bounded by VALVE_SET_ATTEMPTS.
      const perCmd = {};
      rt.setValveResponder(function (kind, url, id, host) {
        if (kind === 'set') {
          const key = host + ':' + id + ':' + (/on=true/.test(url) ? '1' : '0');
          perCmd[key] = (perCmd[key] || 0) + 1;
          return { drop: true };
        }
        return null;
      });
      rt.clearHttpCalls();
      driveSCTransition(rt, function () {
        const counts = Object.keys(perCmd).map(function (k) { return perCmd[k]; });
        assert.ok(counts.length >= 1, 'expected at least one valve Set command attempted');
        for (let i = 0; i < counts.length; i++) {
          assert.ok(counts[i] <= 2,
            'a single valve command must make at most 2 Set attempts; saw ' + counts[i]);
        }
        done();
      });
    });
  });
});

// ── 4. Fail-safe preserved on confirmed failure ──

describe('confirmed valve failure preserves the IDLE fail-safe (#262)', function () {
  it('publishes mode=idle, transitioning=false after a confirmed valve failure', function (t, done) {
    const rt = createRuntime();
    bootIdle(rt, null, function () {
      rt.setValveResponder(function (kind) {
        if (kind === 'set') return { drop: true }; // never succeeds
        return null;
      });
      rt.clearHttpCalls();
      driveSCTransition(rt, function () {
        const last = rt.lastState();
        assert.ok(last, 'expected at least one published state');
        assert.strictEqual(last.mode, 'idle', 'fail-safe must land in IDLE; got ' + last.mode);
        assert.strictEqual(last.transitioning, false, 'fail-safe must clear transitioning; got ' + last.transitioning);
        // lastTransitionCause is server-side reassembled, not in the minimal
        // payload; the observable device proof is mode=idle + not transitioning,
        // and that the pump is not running. flags.pump is not in min payload
        // either, so mode=idle is the device-visible fail-safe signal.
        done();
      });
    });
  });
});

// ── 5. In-flight guard: valve cycle and sensor poll never overlap ──

describe('valve cycle and sensor poll do not overlap (#262)', function () {
  it('a controlLoop tick during an in-flight valve transition does not start a sensor poll', function (t, done) {
    // Make valve Set calls SLOW (25 s) so the SC transition stays mid-flight
    // while a controlLoop tick fires. The in-flight guard (state.transitioning
    // and/or the valve-cycle flag) must prevent that tick from launching a
    // fresh sensor poll batch — otherwise sensor + valve HTTP.GETs stack
    // toward the 5-concurrent-call limit.
    const rt = createRuntime();
    bootIdle(rt, null, function () {
      // Slow valve Sets; verify reads also slow so the valve cycle is
      // genuinely mid-flight when we tick.
      rt.setValveResponder(function (kind) {
        if (kind === 'set') return { delayMs: 25000, code: 200 };
        if (kind === 'get') return { delayMs: 25000 };
        return null;
      });
      // Drive a fresh IDLE→SC transition (valves need to OPEN) with the slow
      // responder, so it sticks mid-flight (state.transitioning === true AND
      // valveCycleInFlight === true).
      rt.clearHttpCalls();
      rt.globals.Shelly.__test_driveTransition('IDLE', scResult());
      // Let the transition begin and reach the (slow) valve Set stage.
      rt.tick(function () {
        const sensorsBefore = rt.httpCalls().filter(function (c) { return c.kind === 'sensor'; }).length;
        // Now fire a controlLoop tick WHILE the valve cycle is still in flight.
        rt.tick(function () {
          const sensorsAfter = rt.httpCalls().filter(function (c) { return c.kind === 'sensor'; }).length;
          assert.strictEqual(sensorsAfter, sensorsBefore,
            'a tick during an in-flight valve transition must NOT start a sensor poll cycle ' +
            '(got ' + sensorsAfter + ' sensor polls vs ' + sensorsBefore + ' before)');
          // And the peak concurrency must never have exceeded the safe budget.
          assert.ok(rt.peakHttpInFlight() <= 4,
            'overlapping HTTP must stay within the 4-call actuation budget; peak was ' + rt.peakHttpInFlight());
          done();
        });
      });
    });
  });
});
