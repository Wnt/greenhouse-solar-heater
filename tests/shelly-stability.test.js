/**
 * Shelly control script stability test.
 *
 * Simulates the Shelly runtime environment and runs the concatenated
 * control-logic.js + control.js through multiple control loop cycles.
 * Tracks concurrent Shelly.call invocations to detect violations of
 * the 5-concurrent-call platform limit.
 *
 * This catches bugs like parallel Switch.SetConfig calls in updateDisplay()
 * that exceeded the concurrent call limit and crashed the script.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');
const MAX_CONCURRENT_CALLS = 5;

function createShellyRuntime() {
  var concurrentCalls = 0;
  var peakConcurrent = 0;
  var totalCalls = 0;
  var violations = [];
  var timers = [];
  var eventHandlers = [];
  var kvs = {};

  // Track all Shelly.call invocations
  function shellyCall(method, params, cb) {
    totalCalls++;
    concurrentCalls++;
    if (concurrentCalls > peakConcurrent) peakConcurrent = concurrentCalls;
    if (concurrentCalls > MAX_CONCURRENT_CALLS) {
      violations.push({
        method: method,
        concurrent: concurrentCalls,
        total: totalCalls,
      });
    }

    // Simulate async completion
    var response = null;
    if (method === 'Switch.Set' || method === 'Switch.SetConfig') {
      response = {};
    } else if (method === 'KVS.Get') {
      var val = kvs[params.key] || null;
      response = val ? { value: val } : null;
    } else if (method === 'KVS.Set') {
      kvs[params.key] = params.value;
      response = {};
    } else if (method === 'HTTP.GET') {
      // Sensor poll — simulate timeout/unreachable (no sensors connected)
      concurrentCalls--;
      if (cb) cb(null, { code: 0, body: '' });
      return;
    } else if (method === 'HTTP.POST') {
      // MQTT command RPC — simulate failure
      concurrentCalls--;
      if (cb) cb(null, { code: 0, body: '' });
      return;
    }

    // Simulate async callback (next microtask)
    setImmediate(function() {
      concurrentCalls--;
      if (cb) cb(response, null);
    });
  }

  // Timer simulation
  var timerIdCounter = 0;
  function timerSet(ms, repeat, cb) {
    var id = ++timerIdCounter;
    timers.push({ id: id, ms: ms, repeat: repeat, cb: cb });
    return id;
  }

  function timerClear(id) {
    timers = timers.filter(function(t) { return t.id !== id; });
  }

  function getComponentStatus(type, id) {
    if (type === 'switch') return { apower: 0, output: false };
    return {};
  }

  function emitEvent() {}

  function addEventHandler(fn) {
    eventHandlers.push(fn);
  }

  function addStatusHandler() {}

  // Build the global scope for the Shelly script
  var globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus: getComponentStatus,
      emitEvent: emitEvent,
      addEventHandler: addEventHandler,
      addStatusHandler: addStatusHandler,
    },
    Timer: {
      set: timerSet,
      clear: timerClear,
    },
    MQTT: {
      subscribe: function() {},
      publish: function() {},
      isConnected: function() { return false; },
    },
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
        violations: violations,
        timerCount: timers.length,
      };
    },
    triggerTimers: function() {
      // Fire all repeating timers once
      var fired = [];
      timers.forEach(function(t) {
        if (t.repeat) fired.push(t);
      });
      return fired;
    },
    reset: function() {
      concurrentCalls = 0;
      peakConcurrent = 0;
      totalCalls = 0;
      violations = [];
    },
  };
}

function loadControlScript(runtime) {
  var logicSrc = fs.readFileSync(path.join(SHELLY_DIR, 'control-logic.js'), 'utf8');
  var controlSrc = fs.readFileSync(path.join(SHELLY_DIR, 'control.js'), 'utf8');
  var combined = logicSrc + '\n' + controlSrc;

  // Build a sandboxed scope with Shelly globals
  var g = runtime.globals;
  var fn = new Function(
    'Shelly', 'Timer', 'MQTT', 'JSON', 'Date', 'Math', 'parseInt', 'print',
    combined
  );
  fn(g.Shelly, g.Timer, g.MQTT, g.JSON, g.Date, g.Math, g.parseInt, g.print);
}

describe('Shelly control script stability', function() {
  var runtime;

  before(function() {
    runtime = createShellyRuntime();
    loadControlScript(runtime);
  });

  it('boots without exceeding concurrent call limit', function() {
    var stats = runtime.stats();
    assert.deepStrictEqual(stats.violations, [],
      'Boot should not exceed ' + MAX_CONCURRENT_CALLS + ' concurrent calls. ' +
      'Peak: ' + stats.peakConcurrent);
  });

  it('stays within concurrent call limit after boot completes', function(t, done) {
    // Wait for boot sequence timers to fire (boot uses Timer.set(5000, false, ...))
    // In our simulation, we process all pending async callbacks
    setTimeout(function() {
      var stats = runtime.stats();
      assert.deepStrictEqual(stats.violations, [],
        'Post-boot should not exceed ' + MAX_CONCURRENT_CALLS + ' concurrent calls. ' +
        'Peak: ' + stats.peakConcurrent);
      done();
    }, 100);
  });

  it('control loop cycle stays within concurrent call limit', function(t, done) {
    runtime.reset();
    // Fire the repeating timer (control loop)
    var repeating = runtime.triggerTimers();
    var controlLoopTimer = repeating.find(function(t) { return t.ms >= 10000; });
    if (controlLoopTimer) {
      controlLoopTimer.cb();
    }
    // Wait for all async callbacks to settle
    setTimeout(function() {
      var stats = runtime.stats();
      assert.deepStrictEqual(stats.violations, [],
        'Control loop should not exceed ' + MAX_CONCURRENT_CALLS + ' concurrent calls. ' +
        'Peak: ' + stats.peakConcurrent + ', violations: ' +
        JSON.stringify(stats.violations));
      done();
    }, 200);
  });

  it('multiple consecutive control loops stay within limit', function(t, done) {
    runtime.reset();
    var repeating = runtime.triggerTimers();
    var controlLoopTimer = repeating.find(function(t) { return t.ms >= 10000; });
    var loopsRun = 0;
    var targetLoops = 3;

    function runLoop() {
      if (loopsRun >= targetLoops) {
        var stats = runtime.stats();
        assert.deepStrictEqual(stats.violations, [],
          targetLoops + ' consecutive loops should not exceed ' + MAX_CONCURRENT_CALLS +
          ' concurrent calls. Peak: ' + stats.peakConcurrent);
        done();
        return;
      }
      if (controlLoopTimer) {
        controlLoopTimer.cb();
      }
      loopsRun++;
      setTimeout(runLoop, 200);
    }
    runLoop();
  });

  it('peak concurrent calls is reported', function() {
    var stats = runtime.stats();
    // Just informational — log the peak for visibility
    assert.ok(stats.peakConcurrent <= MAX_CONCURRENT_CALLS,
      'Peak concurrent calls (' + stats.peakConcurrent + ') should be <= ' + MAX_CONCURRENT_CALLS);
  });
});
