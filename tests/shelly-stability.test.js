/**
 * Shelly script stability tests.
 *
 * Simulates the Shelly runtime environment and runs control + telemetry
 * scripts to enforce platform limits BEFORE deploying to hardware.
 *
 * Enforced limits (Shelly Pro 4PM):
 *   - Max 5 concurrent Shelly.call / HTTP calls per script
 *   - Max 5 timers per script
 *   - Max 5 event subscriptions (Shelly.addEventHandler + addStatusHandler)
 *   - Max 5 MQTT subscriptions per script
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

const LIMITS = {
  MAX_CONCURRENT_CALLS: 5,
  MAX_TIMERS: 5,
  MAX_EVENT_HANDLERS: 5,
  // MQTT.subscribe is not strictly constrained by SH-002 (which only
  // counts Shelly.addEventHandler / Shelly.addStatusHandler), but the
  // test holds the line at 5 to keep the device's subscription budget
  // disciplined. The watchdog feature deliberately avoids adding a
  // 6th subscription by routing user ack/shutdownnow through the
  // existing greenhouse/config retained topic.
  MAX_MQTT_SUBSCRIPTIONS: 5,
};

function createShellyRuntime(opts) {
  opts = opts || {};
  let concurrentCalls = 0;
  let peakConcurrent = 0;
  let totalCalls = 0;
  let callViolations = [];
  let timers = [];
  const eventHandlers = [];
  const statusHandlers = [];
  let mqttSubscriptions = [];
  let mqttConnectHandler = null;
  const kvs = {};

  function shellyCall(method, params, cb) {
    totalCalls++;
    concurrentCalls++;
    if (concurrentCalls > peakConcurrent) peakConcurrent = concurrentCalls;
    if (concurrentCalls > LIMITS.MAX_CONCURRENT_CALLS) {
      callViolations.push({ method, concurrent: concurrentCalls });
    }

    let response = null;
    if (method === 'Switch.Set' || method === 'Switch.SetConfig') {
      response = {};
    } else if (method === 'KVS.Get') {
      const val = kvs[(params || {}).key] || null;
      response = val ? { value: val } : null;
    } else if (method === 'KVS.Set') {
      kvs[(params || {}).key] = (params || {}).value;
      response = {};
    } else if (method === 'HTTP.GET' || method === 'HTTP.POST') {
      concurrentCalls--;
      // Return success so valve/sensor HTTP calls don't trigger retries
      // that infinite-loop the boot chain when tests need subscribe/publish.
      if (cb) cb({ code: 200, body: '{"tC":20}' }, null);
      return;
    }

    setImmediate(function() {
      concurrentCalls--;
      if (cb) cb(response, null);
    });
  }

  let timerIdCounter = 0;
  function timerSet(ms, repeat, cb) {
    const id = ++timerIdCounter;
    timers.push({ id, ms, repeat, cb });
    return id;
  }

  function timerClear(id) {
    timers = timers.filter(function(t) { return t.id !== id; });
  }

  function getComponentStatus(type) {
    if (type === 'switch') return { apower: 0, output: false };
    return {};
  }

  function emitEvent(name, data) {
    // Deliver to registered handlers
    for (let i = 0; i < eventHandlers.length; i++) {
      try { eventHandlers[i]({ info: { event: name, data } }); } catch(e) {}
    }
  }

  function addEventHandler(fn) { eventHandlers.push(fn); }
  function addStatusHandler(fn) { statusHandlers.push(fn); }

  let mqttConnected = opts.mqttConnected || false;

  const mqtt = {
    subscribe: function(topic, cb) {
      // Match real Shelly behavior: subscribing to an already-subscribed
      // topic throws "Invalid topic". The merged control script's boot
      // dance calls unsubscribe first to avoid this.
      for (let i = 0; i < mqttSubscriptions.length; i++) {
        if (mqttSubscriptions[i].topic === topic) {
          throw new Error('Invalid topic');
        }
      }
      mqttSubscriptions.push({ topic, cb });
    },
    unsubscribe: function(topic) {
      mqttSubscriptions = mqttSubscriptions.filter(function(s) { return s.topic !== topic; });
    },
    publish: function() {},
    isConnected: function() { return mqttConnected; },
    setConnectHandler: function(cb) { mqttConnectHandler = cb; },
  };

  const globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus,
      emitEvent,
      addEventHandler,
      addStatusHandler,
    },
    Timer: { set: timerSet, clear: timerClear },
    MQTT: mqtt,
    JSON,
    Date,
    Math,
    parseInt,
    print: function() {},
  };

  return {
    globals,
    stats: function() {
      return {
        peakConcurrent,
        totalCalls,
        callViolations,
        timerCount: timers.length,
        eventHandlerCount: eventHandlers.length + statusHandlers.length,
        mqttSubscriptionCount: mqttSubscriptions.length,
        mqttTopics: mqttSubscriptions.map(function(s) { return s.topic; }),
      };
    },
    triggerTimers: function() {
      return timers.filter(function(t) { return t.repeat; });
    },
    triggerMqttConnect: function() {
      mqttConnected = true;
      if (mqttConnectHandler) mqttConnectHandler();
    },
    deliverMqtt: function(topic, message) {
      for (let i = 0; i < mqttSubscriptions.length; i++) {
        if (mqttSubscriptions[i].topic === topic) {
          mqttSubscriptions[i].cb(topic, message);
        }
      }
    },
    // Fire all pending one-shot timers repeatedly until none left. Helps
    // tests push the boot chain (Timer.set(5000) gates) to completion.
    flushTimers: function() {
      for (let round = 0; round < 10; round++) {
        const oneshot = timers.filter(function(t) { return !t.repeat; });
        if (oneshot.length === 0) return;
        for (let i = 0; i < oneshot.length; i++) {
          timers = timers.filter(function(t) { return t.id !== oneshot[i].id; });
          try { oneshot[i].cb(); } catch (_e) {}
        }
      }
    },
    reset: function() {
      concurrentCalls = 0;
      peakConcurrent = 0;
      totalCalls = 0;
      callViolations = [];
    },
  };
}

function loadScript(runtime, files) {
  const src = files.map(function(f) {
    return fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8');
  }).join('\n');

  const g = runtime.globals;
  const fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    src
  );
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print);
}

// ── Control script tests ──

describe('Shelly control script stability', function() {
  let runtime;

  before(function() {
    runtime = createShellyRuntime();
    loadScript(runtime, ['control-logic.js', 'control.js']);
  });

  it('boots without exceeding concurrent call limit', function() {
    const stats = runtime.stats();
    assert.deepStrictEqual(stats.callViolations, [],
      'Peak: ' + stats.peakConcurrent);
  });

  it('stays within timer limit', function() {
    const stats = runtime.stats();
    assert.ok(stats.timerCount <= LIMITS.MAX_TIMERS,
      'Timers: ' + stats.timerCount + ' (max ' + LIMITS.MAX_TIMERS + ')');
  });

  it('stays within event handler limit', function() {
    const stats = runtime.stats();
    assert.ok(stats.eventHandlerCount <= LIMITS.MAX_EVENT_HANDLERS,
      'Event handlers: ' + stats.eventHandlerCount + ' (max ' + LIMITS.MAX_EVENT_HANDLERS + ')');
  });

  it('control loop stays within concurrent call limit', function(t, done) {
    runtime.reset();
    const repeating = runtime.triggerTimers();
    const controlLoop = repeating.find(function(t) { return t.ms >= 10000; });
    if (controlLoop) controlLoop.cb();
    setTimeout(function() {
      const stats = runtime.stats();
      assert.deepStrictEqual(stats.callViolations, [],
        'Peak: ' + stats.peakConcurrent);
      done();
    }, 200);
  });

  it('multiple consecutive loops stay within limit', function(t, done) {
    runtime.reset();
    const repeating = runtime.triggerTimers();
    const controlLoop = repeating.find(function(t) { return t.ms >= 10000; });
    let loopsRun = 0;
    function runLoop() {
      if (loopsRun >= 3) {
        const stats = runtime.stats();
        assert.deepStrictEqual(stats.callViolations, [],
          '3 loops, peak: ' + stats.peakConcurrent);
        done();
        return;
      }
      if (controlLoop) controlLoop.cb();
      loopsRun++;
      setTimeout(runLoop, 200);
    }
    runLoop();
  });

  it('serializes rapid manual-override relay commands (no concurrent burst)', function(t, done) {
    // Real-device crash repro: with manual override active, the user toggled
    // pump on, fan on, fan off, pump off in quick succession and the entire
    // Shelly Pro 4PM rebooted (reset_reason 3 = software watchdog). The fix
    // serializes relay commands so at most one Switch.Set is in flight at
    // any moment from the manual-override path.
    const rt = createShellyRuntime({ mqttConnected: true });
    loadScript(rt, ['control-logic.js', 'control.js']);

    // Activate manual override via the CONFIG_TOPIC MQTT path — that's how
    // config updates reach the merged script now.
    const future = Math.floor(Date.now() / 1000) + 600;
    rt.deliverMqtt('greenhouse/config', JSON.stringify({
      ce: true, ea: 31, fm: null, am: null, v: 99,
      mo: { a: true, ex: future, fm: 'I' }
    }));

    rt.reset();
    // Fire 4 relay commands in the same synchronous tick (worst case).
    rt.deliverMqtt('greenhouse/relay-command', JSON.stringify({ relay: 'pump', on: true }));
    rt.deliverMqtt('greenhouse/relay-command', JSON.stringify({ relay: 'fan',  on: true }));
    rt.deliverMqtt('greenhouse/relay-command', JSON.stringify({ relay: 'fan',  on: false }));
    rt.deliverMqtt('greenhouse/relay-command', JSON.stringify({ relay: 'pump', on: false }));

    setTimeout(function() {
      const stats = rt.stats();
      assert.deepStrictEqual(stats.callViolations, [],
        'No violations expected — peak: ' + stats.peakConcurrent);
      assert.ok(stats.peakConcurrent <= 1,
        'Manual-override relay path must serialize Shelly.call to ≤1 in flight, ' +
        'observed peak: ' + stats.peakConcurrent);
      done();
    }, 300);
  });
});

// ── Merged-script MQTT tests (formerly shelly/telemetry.js) ──

describe('Shelly merged-control MQTT stability', function() {
  // Helper: boot the script and drain the boot chain (setImmediate
  // callbacks + deferred 5 s timers) so MQTT subscribe + publish happen.
  // loadPersistedState chains 3 KVS.Get setImmediate callbacks → alternate
  // setImmediate / flushTimers for several rounds.
  function bootAndSettle(rt, done) {
    loadScript(rt, ['control-logic.js', 'control.js']);
    let rounds = 0;
    function loop() {
      rt.flushTimers();
      if (++rounds >= 20) { done(); return; }
      setImmediate(loop);
    }
    setImmediate(loop);
  }

  it('subscribes to exactly 3 MQTT topics (config, sensor-config, relay-command)', function(t, done) {
    const rt = createShellyRuntime({ mqttConnected: true });
    bootAndSettle(rt, function() {
      const topics = rt.stats().mqttTopics.slice().sort();
      assert.deepStrictEqual(topics,
        ['greenhouse/config', 'greenhouse/relay-command', 'greenhouse/sensor-config'],
        'Unexpected topics: ' + topics.join(', '));
      done();
    });
  });

  it('stays within MQTT subscription limit', function(t, done) {
    const rt = createShellyRuntime({ mqttConnected: true });
    bootAndSettle(rt, function() {
      const stats = rt.stats();
      assert.ok(stats.mqttSubscriptionCount <= LIMITS.MAX_MQTT_SUBSCRIPTIONS,
        'MQTT subscriptions: ' + stats.mqttSubscriptionCount);
      done();
    });
  });

  it('survives connectHandler firing after boot already subscribed (orphan-fix via unsubscribe)', function(t, done) {
    const rt = createShellyRuntime({ mqttConnected: true });
    bootAndSettle(rt, function() {
      assert.doesNotThrow(function() {
        rt.triggerMqttConnect();
        rt.triggerMqttConnect();
      }, 'merged control script must not crash on repeated connectHandler');
      const stats = rt.stats();
      const uniq = {};
      stats.mqttTopics.forEach(function(t) { uniq[t] = true; });
      assert.strictEqual(Object.keys(uniq).length, 3,
        'expected 3 unique subscriptions after repeated connectHandler, got: ' + stats.mqttTopics.join(', '));
      done();
    });
  });

  it('survives firmware where MQTT.unsubscribe is ineffective (subscribe throws Invalid topic)', function(t, done) {
    // 2026-04-20 production incident: after Script.Stop then Script.Start,
    // the Pro 4PM retained its 3 device-side MQTT subscriptions. The new
    // JS session's MQTT.unsubscribe() call did not clear them in time
    // (firmware quirk), so the subsequent MQTT.subscribe() threw
    // "Invalid topic" and the whole script crashed with:
    //
    //   Uncaught Error: Invalid topic
    //    at });
    //    ^
    //   in function "setupMqttSubscriptions" called from setupMqttSubscriptions();
    //
    // Simulate the firmware behaviour by pre-seeding the mock's
    // subscription table as if a prior session left them there, and
    // neutering unsubscribe() so it refuses to clear them. The script
    // MUST NOT crash; it should gracefully leave the subscriptions in
    // their pre-existing state and keep the control loop running.
    const rt = createShellyRuntime({ mqttConnected: true });
    // Pre-populate 3 subscriptions as though from a prior script.
    rt.globals.MQTT.subscribe('greenhouse/config', function() {});
    rt.globals.MQTT.subscribe('greenhouse/sensor-config', function() {});
    rt.globals.MQTT.subscribe('greenhouse/relay-command', function() {});
    // Disable unsubscribe — model the firmware bug.
    rt.globals.MQTT.unsubscribe = function() {};

    assert.doesNotThrow(function() {
      loadScript(rt, ['control-logic.js', 'control.js']);
    }, 'script must not propagate Invalid topic to the runtime');

    // After the boot settle, the mqtt subscription table still has 3
    // entries — the pre-seeded ones. No duplicates were added.
    let rounds = 0;
    function loop() {
      rt.flushTimers();
      if (++rounds >= 20) {
        const stats = rt.stats();
        assert.strictEqual(stats.mqttSubscriptionCount, 3,
          'stale pre-seeded subscriptions should remain; no duplicates. got: ' + stats.mqttSubscriptionCount);
        done();
        return;
      }
      setImmediate(loop);
    }
    setImmediate(loop);
  });

  it('publishes greenhouse/state directly via MQTT.publish (no emitEvent IPC bridge)', function(t, done) {
    const rt = createShellyRuntime({ mqttConnected: true });
    const publishes = [];
    const realPublish = rt.globals.MQTT.publish;
    rt.globals.MQTT.publish = function(topic, _payload, _qos, _retain) {
      publishes.push({ topic });
      return realPublish.apply(null, arguments);
    };
    bootAndSettle(rt, function() {
      const stateTopics = publishes.filter(function(p) { return p.topic === 'greenhouse/state'; });
      assert.ok(stateTopics.length >= 1,
        'merged control must publish greenhouse/state directly — topics seen: ' +
        publishes.map(function(p) { return p.topic; }).join(', '));
      done();
    });
  });
});
