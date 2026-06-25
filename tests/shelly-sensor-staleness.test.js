/**
 * Sensor-read hardening for degraded WiFi (issue #262, WS2).
 *
 * The Pro 4PM control script polls the sensor hubs over LAN HTTP RPC every
 * 30 s. On a flaky WiFi link those per-tick connections become a churn of
 * slow / partial / dropped responses that (a) pile up overlapping in-flight
 * HTTP.GET calls until the 5-concurrent-call limit crashes the script and
 * (b) ratchet firmware RAM pressure until the JsVar pool no longer fits the
 * transition peak (OOM). These tests pin the hardening that keeps the LOCAL
 * control path resilient — WITHOUT introducing any broker dependency:
 *
 *   1. Short explicit timeout (~3 s) on every sensor HTTP.GET so a lost
 *      packet fails fast instead of holding firmware buffers.
 *   2. In-flight guard: controlLoop never starts a new poll cycle while a
 *      previous one is still pending (no overlap → no 5-call pile-up).
 *   3. Staleness cache: last-good tC + timestamp per role, used while
 *      younger than a single named max-age constant (~180 s). A role older
 *      than max-age is presented to evaluate() as null, so the existing
 *      logic degrades cleanly to IDLE. A single failed poll never thrashes
 *      the mode — the cached value carries the device through transient
 *      gaps.
 *   4. The decision step uses cached temps only — no blocking I/O between
 *      the poll completing and evaluate() running.
 *
 * control-logic.js stays pure; all of this lives in control.js. The mock
 * runtime below drives the REAL pollAllSensors / controlLoop shapes with a
 * scriptable HTTP responder (delay / partial / drop) and a virtual clock.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

// Five sensors on a single hub, mirroring sensor_config below. Component
// ids are arbitrary but must match CID_TO_SENSOR.
const CID_TO_SENSOR = { 100: 'collector', 101: 'tank_top', 102: 'tank_bottom', 103: 'greenhouse', 104: 'outdoor' };

// A temperature set that, when fresh, drives the evaluator into
// SOLAR_CHARGING (collector clearly hotter than tank_bottom, nothing
// freezing or overheating). Used as the steady-state baseline so we can
// observe a fall-back to IDLE when staleness kicks in.
const SOLAR_TEMPS = { collector: 60, tank_top: 40, tank_bottom: 30, greenhouse: 18, outdoor: 15 };

function createRuntime(opts) {
  opts = opts || {};
  let now = opts.startTime || 1700000000000;
  let sysUptime = 100;
  let timers = [];
  let timerIdCounter = 0;
  const kvs = {};
  const publishes = [];

  // In-flight HTTP.GET accounting so a test can assert the in-flight guard
  // prevents overlapping poll cycles.
  let httpInFlight = 0;
  let peakHttpInFlight = 0;
  const httpCalls = []; // { url, timeout }

  // Scriptable responder. Returns one of:
  //   { delayMs, ok, body }      — succeeds after delayMs virtual ms
  //   { delayMs, drop:true }     — never resolves (simulated lost packet);
  //                                relies on the script's own timeout
  //   { ok:false, err }          — immediate failure
  // Default: immediate success with the current temp for the sensor.
  let responder = opts.responder || function (sensor) {
    return { ok: true, body: JSON.stringify({ tC: SOLAR_TEMPS[sensor] }) };
  };
  // Honors the `timeout` (seconds) param the hardened code passes: a dropped
  // response auto-fails the callback at now + timeout*1000.
  function shellyCall(method, params, cb) {
    params = params || {};
    if (method === 'HTTP.GET') {
      const url = params.url || '';
      httpInFlight++;
      if (httpInFlight > peakHttpInFlight) peakHttpInFlight = httpInFlight;
      httpCalls.push({ url, timeout: params.timeout });
      function settle(res, err) {
        httpInFlight--;
        if (cb) cb(res, err);
      }
      // Valve commands (Switch.Set HTTP.GET to a .51–.54 controller) are NOT
      // governed by the sensor responder — valve hardening is WS3's scope.
      // They always succeed here so a degraded-sensor scenario can still close
      // valves and reach IDLE. This test only manipulates the SENSOR path.
      const isSensor = url.indexOf('Temperature.GetStatus') >= 0 || url.indexOf('Shelly.GetStatus') >= 0;
      if (!isSensor) {
        setImmediate(function () { settle({ code: 200, body: '{}' }, null); });
        return;
      }
      let sensor = 'collector';
      const m = url.match(/id=(\d+)/);
      if (m) sensor = CID_TO_SENSOR[parseInt(m[1], 10)] || 'collector';
      // Shelly.GetStatus per-hub batch path returns all temps at once.
      const isBatch = url.indexOf('Shelly.GetStatus') >= 0;
      const r = responder(sensor, url, isBatch) || { ok: true, body: '{}' };
      if (r.drop) {
        // Simulated lost packet: only the script's own timeout can free it.
        const t = (params.timeout || 0) * 1000;
        if (t > 0) {
          timers.push({ id: ++timerIdCounter, dueAt: now + t, oneshot: true,
            cb: function () { settle(null, 'timeout'); } });
        }
        return;
      }
      const delay = r.delayMs || 0;
      timers.push({ id: ++timerIdCounter, dueAt: now + delay, oneshot: true,
        cb: function () {
          if (r.ok === false) { settle(null, r.err || 'error'); return; }
          settle({ code: 200, body: r.body || '' }, null);
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
      // Earliest-due first.
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
    setResponder: function (fn) { responder = fn; },
    setUptime: function (s) { sysUptime = s; },
    now: function () { return now; },
    peakHttpInFlight: function () { return peakHttpInFlight; },
    httpCalls: function () { return httpCalls.slice(); },
    clearHttpCalls: function () { httpCalls.length = 0; },
    states: function () {
      return publishes
        .filter(function (p) { return p.topic === 'greenhouse/state/min'; })
        .map(function (p) { try { return JSON.parse(p.payload); } catch (e) { return {}; } });
    },
    lastState: function () { const s = this.states(); return s.length ? s[s.length - 1] : null; },
    // Advance the virtual clock by ms. Between clock jumps it drains several
    // setImmediate rounds so async Shelly.call callbacks (which resolve on
    // setImmediate) and their chained follow-ups land before time moves. Only
    // when a quiet stretch passes with nothing due does the clock jump to the
    // next pending timer (or endAt). done() once the window has elapsed AND
    // the async chain has quiesced.
    advance: function (ms, done) {
      const endAt = now + ms;
      let totalRounds = 0;
      let idle = 0;
      function step() {
        if (totalRounds++ > 500000) { done(); return; }
        fireDueTimers();
        // Anything still due right now (a timer scheduled at the current
        // clock value by a callback that just ran)?
        let dueNow = false;
        let nextDue = null;
        for (let i = 0; i < timers.length; i++) {
          if (timers[i].dueAt <= now) { dueNow = true; break; }
          if (nextDue === null || timers[i].dueAt < nextDue) nextDue = timers[i].dueAt;
        }
        if (dueNow) { idle = 0; setImmediate(step); return; }
        // Give chained setImmediate callbacks ample rounds to register their
        // next timer before deciding the system is quiet at this instant.
        // Boot's post-valve chain (5 s timer → 3 nested KVS.Get →
        // pollAllSensors) needs many rounds; too small a budget quiesces
        // before the sensor poll fires.
        if (idle++ < 60) { setImmediate(step); return; }
        idle = 0;
        if (now >= endAt) { done(); return; }
        // Jump the clock to the next pending timer within the window.
        now = (nextDue !== null && nextDue < endAt) ? nextDue : endAt;
        setImmediate(step);
      }
      setImmediate(step);
    },
    // Fire the repeating controlLoop timer once and settle the async chain
    // WITHOUT advancing the virtual clock (so in-flight delayed responses
    // stay pending — needed to exercise the in-flight guard).
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

// Boot + settle. The first automated IDLE→SOLAR_CHARGING transition includes
// a 20 s valve open-window plus pump-prime, so allow a generous window for
// the device to reach steady state before a test starts poking it.
function boot(rt, cfg, done) { loadScript(rt, cfg); rt.advance(90000, done); }

// ── 1. Explicit short timeout on every sensor HTTP.GET ──

describe('sensor HTTP.GET carries a short explicit timeout (#262)', function () {
  it('every Temperature/Shelly status poll passes a timeout ≤ 5 s', function (t, done) {
    const rt = createRuntime();
    boot(rt, null, function () {
      const sensorPolls = rt.httpCalls().filter(function (c) {
        return c.url.indexOf('Temperature.GetStatus') >= 0 || c.url.indexOf('Shelly.GetStatus') >= 0;
      });
      assert.ok(sensorPolls.length >= 1, 'expected at least one sensor poll during boot');
      for (let i = 0; i < sensorPolls.length; i++) {
        assert.ok(typeof sensorPolls[i].timeout === 'number' && sensorPolls[i].timeout > 0 && sensorPolls[i].timeout <= 5,
          'sensor poll must carry an explicit short timeout (got ' + sensorPolls[i].timeout + ') for url ' + sensorPolls[i].url);
      }
      done();
    });
  });
});

// ── 2. In-flight guard — no overlapping poll cycles ──

describe('controlLoop in-flight guard prevents overlapping poll cycles (#262)', function () {
  it('a slow poll cycle does not let the next tick start a second cycle', function (t, done) {
    // Boot with FAST sensor responses so the script reaches steady state and
    // the repeating controlLoop timer is registered. THEN flip the responder
    // to a slow (25 s) mode so the next poll cycle stays in flight while a
    // second tick fires. With the guard, the second tick must NOT issue a
    // fresh batch of HTTP.GETs.
    const rt = createRuntime();
    boot(rt, null, function () {
      rt.setResponder(function (sensor) {
        return { delayMs: 25000, ok: true, body: JSON.stringify({ tC: SOLAR_TEMPS[sensor] }) };
      });
      rt.clearHttpCalls();
      // First tick: starts a slow poll cycle that stays in flight.
      rt.tick(function () {
        const afterFirst = rt.httpCalls().length;
        assert.ok(afterFirst >= 1, 'first tick should start a poll cycle');
        // Fire a SECOND tick immediately — the first cycle's responses are
        // still pending (25 s). The guard must suppress this poll.
        rt.tick(function () {
          const afterSecond = rt.httpCalls().length;
          assert.strictEqual(afterSecond, afterFirst,
            'second tick must not start a new poll cycle while the first is in flight ' +
            '(in-flight guard) — got ' + afterSecond + ' calls vs ' + afterFirst);
          done();
        });
      });
    });
  });

  it('the guard clears after a cycle completes so later ticks poll again', function (t, done) {
    const rt = createRuntime();
    boot(rt, null, function () {
      rt.clearHttpCalls();
      rt.tick(function () {
        const first = rt.httpCalls().length;
        assert.ok(first >= 1);
        // Let the (fast) cycle fully resolve, then tick again.
        rt.advance(5000, function () {
          rt.clearHttpCalls();
          rt.tick(function () {
            assert.ok(rt.httpCalls().length >= 1,
              'after a cycle completes the guard must release and the next tick must poll');
            done();
          });
        });
      });
    });
  });
});

// ── 3. Staleness cache: fresh cached temps used; stale → null → IDLE ──

describe('sensor staleness cache (#262)', function () {
  it('a single failed poll keeps the last-good temps (no mode thrash)', function (t, done) {
    const rt = createRuntime();
    boot(rt, null, function () {
      // Settle into SOLAR_CHARGING with good temps.
      rt.advance(120000, function () {
        const before = rt.lastState();
        assert.ok(before && before.mode === 'solar_charging',
          'expected the device to be solar_charging on fresh good temps, got ' + (before && before.mode));
        // One bad poll cycle (all sensors drop). With the staleness cache the
        // device must hold last-good temps and stay in SOLAR_CHARGING — a
        // single failed poll must NOT thrash to IDLE.
        rt.setResponder(function () { return { drop: true }; });
        rt.tick(function () {
          rt.advance(10000, function () {
            const after = rt.lastState();
            assert.ok(after && after.mode === 'solar_charging',
              'one failed poll must not thrash the mode — expected solar_charging held via cache, got ' + (after && after.mode));
            done();
          });
        });
      });
    });
  });

  it('sustained sensor loss degrades to IDLE and the cache expires to null', function (t, done) {
    const rt = createRuntime();
    boot(rt, null, function () {
      rt.advance(120000, function () {
        assert.strictEqual(rt.lastState().mode, 'solar_charging');
        // Now WiFi stays down: every poll drops. Run ticks well past the
        // staleness max-age (~180 s). Two observable degradations, in order:
        //   1. The device leaves SOLAR_CHARGING for IDLE — a clean offline
        //      fallback rather than a crash or a thrash.
        //   2. Past SENSOR_MAX_AGE_MS the cached per-role values themselves
        //      expire to null, so the published telemetry (and the eval view)
        //      no longer act on stale data.
        rt.setResponder(function () { return { drop: true }; });
        let ticks = 0;
        let reachedIdle = false;
        function loop() {
          if (ticks++ > 25) {
            assert.fail('cache never expired to null after sustained sensor loss past max-age' +
              (reachedIdle ? ' (IDLE was reached, but temps stayed non-null)' : ' (never reached IDLE either)'));
            return;
          }
          rt.tick(function () {
            rt.advance(30000, function () {
              const s = rt.lastState();
              if (s && s.mode === 'idle') reachedIdle = true;
              if (s && reachedIdle &&
                  (s.temps.collector === null || s.temps.collector === undefined)) {
                // Cache fully expired: a sustained-loss device acts on null,
                // not stale data, and stays in IDLE.
                assert.strictEqual(s.mode, 'idle',
                  'once the cache has expired the device must be in IDLE');
                done();
                return;
              }
              loop();
            });
          });
        }
        loop();
      });
    });
  });

  it('staleness clears when WiFi recovers — temps repopulate and mode resumes', function (t, done) {
    const rt = createRuntime();
    boot(rt, null, function () {
      rt.advance(120000, function () {
        assert.strictEqual(rt.lastState().mode, 'solar_charging');
        // Drop the link long enough to expire the cache → IDLE.
        rt.setResponder(function () { return { drop: true }; });
        let ticks = 0;
        (function degrade() {
          rt.tick(function () {
            rt.advance(30000, function () {
              if (rt.lastState().mode === 'idle') { recover(); return; }
              if (ticks++ > 20) { assert.fail('did not reach IDLE'); return; }
              degrade();
            });
          });
        })();
        function recover() {
          // WiFi back: fresh good temps. Within a couple of ticks the cache
          // repopulates and the device re-enters solar_charging.
          rt.setResponder(function (sensor) { return { ok: true, body: JSON.stringify({ tC: SOLAR_TEMPS[sensor] }) }; });
          let rt2 = 0;
          (function resume() {
            rt.tick(function () {
              rt.advance(30000, function () {
                const s = rt.lastState();
                if (s.temps.collector !== null && s.temps.collector !== undefined) {
                  assert.ok(s.mode === 'solar_charging' || s.mode === 'idle',
                    'after recovery temps must repopulate; got mode ' + s.mode);
                  // Specifically the collector temp must be fresh again.
                  assert.strictEqual(s.temps.collector, SOLAR_TEMPS.collector,
                    'recovered poll must overwrite the cache with the fresh value');
                  done();
                  return;
                }
                if (rt2++ > 10) { assert.fail('temps never repopulated after recovery'); return; }
                resume();
              });
            });
          })();
        }
      });
    });
  });
});

// ── 4. Decision step uses cached temps only (no blocking I/O) ──

describe('decision step is non-blocking (#262)', function () {
  it('controlLoop evaluates against cached temps without issuing extra polls mid-decision', function (t, done) {
    // After a poll cycle resolves, evaluate() + transitionTo must run off the
    // cached state. We assert that within a single tick the only HTTP.GETs are
    // the sensor poll batch itself (and any valve actuation), never a
    // synchronous re-poll inside the decision path.
    const rt = createRuntime();
    boot(rt, null, function () {
      rt.advance(120000, function () {
        rt.clearHttpCalls();
        rt.tick(function () {
          rt.advance(2000, function () {
            const polls = rt.httpCalls().filter(function (c) {
              return c.url.indexOf('Temperature.GetStatus') >= 0 || c.url.indexOf('Shelly.GetStatus') >= 0;
            });
            // One cycle = at most 5 per-sensor polls OR ≤ 2 batch polls. The
            // decision step must not add more sensor polls.
            assert.ok(polls.length <= 5,
              'decision step must not issue extra sensor polls; saw ' + polls.length + ' in one tick');
            done();
          });
        });
      });
    });
  });
});
