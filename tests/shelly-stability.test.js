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
  // MQTT.subscribe is not constrained by SH-002 (which only counts
  // Shelly.addEventHandler / Shelly.addStatusHandler). The limit here
  // is a test-imposed conservative budget. Bumped to 6 when the
  // watchdog feature added greenhouse/watchdog/cmd.
  MAX_MQTT_SUBSCRIPTIONS: 6,
};

function createShellyRuntime(opts) {
  opts = opts || {};
  var concurrentCalls = 0;
  var peakConcurrent = 0;
  var totalCalls = 0;
  var callViolations = [];
  var timers = [];
  var eventHandlers = [];
  var statusHandlers = [];
  var mqttSubscriptions = [];
  var mqttConnectHandler = null;
  var kvs = {};

  function shellyCall(method, params, cb) {
    totalCalls++;
    concurrentCalls++;
    if (concurrentCalls > peakConcurrent) peakConcurrent = concurrentCalls;
    if (concurrentCalls > LIMITS.MAX_CONCURRENT_CALLS) {
      callViolations.push({ method: method, concurrent: concurrentCalls });
    }

    var response = null;
    if (method === 'Switch.Set' || method === 'Switch.SetConfig') {
      response = {};
    } else if (method === 'KVS.Get') {
      var val = kvs[(params || {}).key] || null;
      response = val ? { value: val } : null;
    } else if (method === 'KVS.Set') {
      kvs[(params || {}).key] = (params || {}).value;
      response = {};
    } else if (method === 'HTTP.GET' || method === 'HTTP.POST') {
      concurrentCalls--;
      if (cb) cb(null, { code: 0, body: '' });
      return;
    }

    setImmediate(function() {
      concurrentCalls--;
      if (cb) cb(response, null);
    });
  }

  var timerIdCounter = 0;
  function timerSet(ms, repeat, cb) {
    var id = ++timerIdCounter;
    timers.push({ id: id, ms: ms, repeat: repeat, cb: cb });
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
    for (var i = 0; i < eventHandlers.length; i++) {
      try { eventHandlers[i]({ info: { event: name, data: data } }); } catch(e) {}
    }
  }

  function addEventHandler(fn) { eventHandlers.push(fn); }
  function addStatusHandler(fn) { statusHandlers.push(fn); }

  var mqttConnected = opts.mqttConnected || false;

  var mqtt = {
    subscribe: function(topic, cb) {
      // Match real Shelly behavior: subscribing to an already-subscribed
      // topic throws "Invalid topic" and crashes the script. The real
      // device exhibited this with telemetry.js after a connectHandler
      // reset re-ran setupMqttSubscription.
      for (var i = 0; i < mqttSubscriptions.length; i++) {
        if (mqttSubscriptions[i].topic === topic) {
          throw new Error('Invalid topic');
        }
      }
      mqttSubscriptions.push({ topic: topic, cb: cb });
    },
    publish: function() {},
    isConnected: function() { return mqttConnected; },
    setConnectHandler: function(cb) { mqttConnectHandler = cb; },
  };

  var globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus: getComponentStatus,
      emitEvent: emitEvent,
      addEventHandler: addEventHandler,
      addStatusHandler: addStatusHandler,
    },
    Timer: { set: timerSet, clear: timerClear },
    MQTT: mqtt,
    JSON: JSON,
    Date: Date,
    Math: Math,
    parseInt: parseInt,
    print: function() {},
  };

  return {
    globals: globals,
    stats: function() {
      return {
        peakConcurrent: peakConcurrent,
        totalCalls: totalCalls,
        callViolations: callViolations,
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
    reset: function() {
      concurrentCalls = 0;
      peakConcurrent = 0;
      totalCalls = 0;
      callViolations = [];
    },
  };
}

function loadScript(runtime, files) {
  var src = files.map(function(f) {
    return fs.readFileSync(path.join(SHELLY_DIR, f), 'utf8');
  }).join('\n');

  var g = runtime.globals;
  var fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    src
  );
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print);
}

// ── Control script tests ──

describe('Shelly control script stability', function() {
  var runtime;

  before(function() {
    runtime = createShellyRuntime();
    loadScript(runtime, ['control-logic.js', 'control.js']);
  });

  it('boots without exceeding concurrent call limit', function() {
    var stats = runtime.stats();
    assert.deepStrictEqual(stats.callViolations, [],
      'Peak: ' + stats.peakConcurrent);
  });

  it('stays within timer limit', function() {
    var stats = runtime.stats();
    assert.ok(stats.timerCount <= LIMITS.MAX_TIMERS,
      'Timers: ' + stats.timerCount + ' (max ' + LIMITS.MAX_TIMERS + ')');
  });

  it('stays within event handler limit', function() {
    var stats = runtime.stats();
    assert.ok(stats.eventHandlerCount <= LIMITS.MAX_EVENT_HANDLERS,
      'Event handlers: ' + stats.eventHandlerCount + ' (max ' + LIMITS.MAX_EVENT_HANDLERS + ')');
  });

  it('control loop stays within concurrent call limit', function(t, done) {
    runtime.reset();
    var repeating = runtime.triggerTimers();
    var controlLoop = repeating.find(function(t) { return t.ms >= 10000; });
    if (controlLoop) controlLoop.cb();
    setTimeout(function() {
      var stats = runtime.stats();
      assert.deepStrictEqual(stats.callViolations, [],
        'Peak: ' + stats.peakConcurrent);
      done();
    }, 200);
  });

  it('multiple consecutive loops stay within limit', function(t, done) {
    runtime.reset();
    var repeating = runtime.triggerTimers();
    var controlLoop = repeating.find(function(t) { return t.ms >= 10000; });
    var loopsRun = 0;
    function runLoop() {
      if (loopsRun >= 3) {
        var stats = runtime.stats();
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
    var rt = createShellyRuntime();
    loadScript(rt, ['control-logic.js', 'control.js']);

    // Activate manual override via the script's existing config_changed event
    // path so deviceConfig.mo is properly set inside the script's closure.
    var future = Math.floor(Date.now() / 1000) + 600;
    rt.globals.Shelly.emitEvent('config_changed', {
      config: { ce: true, ea: 31, fm: null, am: null, v: 99, mo: { a: true, ex: future, ss: false } },
      safety_critical: false,
    });

    rt.reset();
    // Fire 4 relay commands in the same synchronous tick (worst case).
    rt.globals.Shelly.emitEvent('relay_command', { relay: 'pump', on: true });
    rt.globals.Shelly.emitEvent('relay_command', { relay: 'fan',  on: true });
    rt.globals.Shelly.emitEvent('relay_command', { relay: 'fan',  on: false });
    rt.globals.Shelly.emitEvent('relay_command', { relay: 'pump', on: false });

    setTimeout(function() {
      var stats = rt.stats();
      assert.deepStrictEqual(stats.callViolations, [],
        'No violations expected — peak: ' + stats.peakConcurrent);
      assert.ok(stats.peakConcurrent <= 1,
        'Manual-override relay path must serialize Shelly.call to ≤1 in flight, ' +
        'observed peak: ' + stats.peakConcurrent);
      done();
    }, 300);
  });
});

// ── Telemetry script tests ──

describe('Shelly telemetry script stability', function() {
  it('stays within MQTT subscription limit (MQTT connected on boot)', function() {
    var runtime = createShellyRuntime({ mqttConnected: true });
    loadScript(runtime, ['telemetry.js']);
    var stats = runtime.stats();
    assert.ok(stats.mqttSubscriptionCount <= LIMITS.MAX_MQTT_SUBSCRIPTIONS,
      'MQTT subscriptions: ' + stats.mqttSubscriptionCount +
      ' (max ' + LIMITS.MAX_MQTT_SUBSCRIPTIONS + ')' +
      ' topics: ' + stats.mqttTopics.join(', '));
  });

  it('stays within MQTT subscription limit after reconnect', function() {
    var runtime = createShellyRuntime({ mqttConnected: true });
    loadScript(runtime, ['telemetry.js']);
    // Simulate reconnect — connectHandler fires again
    runtime.triggerMqttConnect();
    var stats = runtime.stats();
    assert.ok(stats.mqttSubscriptionCount <= LIMITS.MAX_MQTT_SUBSCRIPTIONS,
      'After reconnect: ' + stats.mqttSubscriptionCount +
      ' subscriptions (max ' + LIMITS.MAX_MQTT_SUBSCRIPTIONS + ')' +
      ' topics: ' + stats.mqttTopics.join(', '));
  });

  it('no duplicate MQTT topics', function() {
    var runtime = createShellyRuntime({ mqttConnected: true });
    loadScript(runtime, ['telemetry.js']);
    var stats = runtime.stats();
    var seen = {};
    var dupes = [];
    stats.mqttTopics.forEach(function(t) {
      if (seen[t]) dupes.push(t);
      seen[t] = true;
    });
    assert.deepStrictEqual(dupes, [],
      'Duplicate MQTT subscriptions: ' + dupes.join(', '));
  });

  it('stays within event handler limit', function() {
    var runtime = createShellyRuntime({ mqttConnected: true });
    loadScript(runtime, ['telemetry.js']);
    var stats = runtime.stats();
    assert.ok(stats.eventHandlerCount <= LIMITS.MAX_EVENT_HANDLERS,
      'Event handlers: ' + stats.eventHandlerCount + ' (max ' + LIMITS.MAX_EVENT_HANDLERS + ')');
  });

  it('stays within timer limit', function() {
    var runtime = createShellyRuntime({ mqttConnected: true });
    loadScript(runtime, ['telemetry.js']);
    var stats = runtime.stats();
    assert.ok(stats.timerCount <= LIMITS.MAX_TIMERS,
      'Timers: ' + stats.timerCount + ' (max ' + LIMITS.MAX_TIMERS + ')');
  });

  it('survives connectHandler firing after bootTelemetry already subscribed', function() {
    // Real-device crash: bootTelemetry → setupMqttSubscription subscribes
    // 5 topics, then Shelly fires the connectHandler for the same active
    // connection, which used to reset the guard flag and re-subscribe →
    // "Invalid topic" → script crashed → relays stopped responding.
    var runtime = createShellyRuntime({ mqttConnected: true });
    assert.doesNotThrow(function () {
      loadScript(runtime, ['telemetry.js']);
      // Simulate Shelly firing the connectHandler for the same connection
      // (or a quick reconnect). Either way the script must not crash.
      runtime.triggerMqttConnect();
      runtime.triggerMqttConnect();
    }, 'telemetry must not crash on duplicate connectHandler invocations');
  });
});
