/**
 * Shelly transition-ordering tests.
 *
 * Exercises shelly/control.js transitionTo() for the two orderings the
 * system uses:
 *   - Default: stop pump/fan/heaters → 1 s settle → actuate valves.
 *   - ACTIVE_DRAIN exit: actuate valves (pump still running) → 20 s →
 *     stop pump/fan/heaters.
 *
 * The runtime mock records every Shelly.call and HTTP valve command with
 * a synthetic-clock timestamp so tests can assert both ordering and
 * elapsed delay between events.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHELLY_DIR = path.join(__dirname, '..', 'shelly');

function createOrderingRuntime(opts) {
  opts = opts || {};
  var now = opts.startTime || 1700000000000; // arbitrary epoch ms
  var events = []; // { t, kind, detail }
  var timers = []; // { id, dueAt, cb, repeat, ms }
  var timerIdCounter = 0;
  var kvs = {};
  var eventHandlers = [];
  var httpResponder = opts.httpResponder || function(url) {
    return { ok: true, body: '' };
  };
  var componentStatus = opts.componentStatus || function() {
    return { apower: 50, output: true };
  };

  function record(kind, detail) {
    events.push({ t: now, kind: kind, detail: detail });
  }

  function shellyCall(method, params, cb) {
    params = params || {};
    if (method === 'Switch.Set') {
      record('switch_set', { id: params.id, on: params.on });
      setImmediate(function() { if (cb) cb({}, null); });
      return;
    }
    if (method === 'Switch.SetConfig') {
      setImmediate(function() { if (cb) cb({}, null); });
      return;
    }
    if (method === 'KVS.Get') {
      var val = kvs[params.key] || null;
      setImmediate(function() { if (cb) cb(val ? { value: val } : null, null); });
      return;
    }
    if (method === 'KVS.Set') {
      kvs[params.key] = params.value;
      setImmediate(function() { if (cb) cb({}, null); });
      return;
    }
    if (method === 'HTTP.GET') {
      var url = params.url || '';
      record('http_get', { url: url });
      var resp = httpResponder(url);
      setImmediate(function() {
        if (resp.ok) {
          if (cb) cb({ code: 200, body: resp.body || '' }, null);
        } else {
          if (cb) cb(null, resp.err || 'error');
        }
      });
      return;
    }
    setImmediate(function() { if (cb) cb({}, null); });
  }

  function timerSet(ms, repeat, cb) {
    var id = ++timerIdCounter;
    timers.push({ id: id, dueAt: now + ms, cb: cb, repeat: repeat, ms: ms });
    return id;
  }
  function timerClear(id) {
    timers = timers.filter(function(t) { return t.id !== id; });
  }

  function emitEvent(name, data) {
    for (var i = 0; i < eventHandlers.length; i++) {
      try { eventHandlers[i]({ info: { event: name, data: data } }); } catch(e) {}
    }
  }

  var globals = {
    Shelly: {
      call: shellyCall,
      getComponentStatus: function(type) {
        if (type === 'switch') return componentStatus();
        if (type === 'sys') return { unixtime: Math.floor(now / 1000) };
        return {};
      },
      emitEvent: emitEvent,
      addEventHandler: function(fn) { eventHandlers.push(fn); },
      addStatusHandler: function() {},
    },
    Timer: { set: timerSet, clear: timerClear },
    MQTT: {
      subscribe: function() {},
      publish: function() {},
      isConnected: function() { return false; },
      setConnectHandler: function() {},
    },
    JSON: JSON,
    Date: { now: function() { return now; } },
    Math: Math,
    parseInt: parseInt,
    print: function() {},
  };

  return {
    globals: globals,
    events: function() { return events.slice(); },
    setComponentStatus: function(fn) { componentStatus = fn; },
    setHttpResponder: function(fn) { httpResponder = fn; },
    advance: function(ms, done) {
      // Advance the synthetic clock in 1 ms hops and fire any timer whose
      // dueAt has passed. Uses setImmediate between hops so async Shelly.call
      // callbacks (which run via setImmediate in the mock) have a chance to
      // resolve before the next hop. done() is invoked on the next tick after
      // the advance completes.
      var endAt = now + ms;
      function hop() {
        if (now >= endAt) {
          setImmediate(done);
          return;
        }
        now += 1;
        var fired;
        do {
          fired = null;
          for (var i = 0; i < timers.length; i++) {
            if (timers[i].dueAt <= now) {
              fired = timers[i];
              if (fired.repeat) {
                fired.dueAt = now + fired.ms;
              } else {
                timers.splice(i, 1);
              }
              break;
            }
          }
          if (fired) {
            try { fired.cb(); } catch(e) {}
          }
        } while (fired);
        setImmediate(hop);
      }
      hop();
    },
    kvs: kvs,
    // Drive a control loop tick and wait for its async chain to settle.
    tick: function(done) {
      // Find the repeating controlLoop timer (30 s period).
      var controlLoop = timers.find(function(t) { return t.repeat && t.ms >= 10000; });
      if (controlLoop) controlLoop.cb();
      setImmediate(done);
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

describe('shelly/control.js :: transitionTo() ordering', function() {
  // Tests added in later tasks.
});
