// tests/shelly/platform-limits.js
// Counter-instrumented Shelly runtime mock. Consumed by
// tests/shelly-platform-limits.test.js for the 24-hour simulation.
//
// See docs/superpowers/specs/2026-04-20-shelly-platform-limits-and-single-script-merge-design.md
// for the cap rationale and the runtime-proxy formula.

const CAPS = {
  DEPLOYED_BYTES: 65535,          // Shelly Script.PutCode hard limit, error -103
  RUNTIME_PROXY_PEAK: 30646,      // calibrated on main 2026-04-20 (0.7× measured baseline 43781)
  STATE_BYTES: 600,               // JSON.stringify(state).length peak
  LIVE_TIMERS: 3,                 // simultaneous Timer.set handles (5 - 2 reserve)
  MQTT_SUBS: 3,                   // active MQTT.subscribe topics
  INFLIGHT_CALLS: 3,              // in-flight Shelly.call (5 - 2 reserve)
  KVS_VALUE_BYTES: 256,           // empirical Pro 4PM fw 1.7.5 cap (2026-04-20)
};

function createInstrumentedRuntime(opts) {
  opts = opts || {};
  if (typeof opts.now !== 'function' || typeof opts.setNow !== 'function') {
    throw new Error('opts.now and opts.setNow are required');
  }

  let inflightCalls = 0, peakCalls = 0;
  let peakTimers = 0;
  let peakSubs = 0;
  let peakKvsBytes = 0;
  let kvsTooLarge = null;
  const liveTimers = new Map();
  const liveCalls = new Map();
  const mqttSubs = new Map();
  const kvs = Object.assign({}, opts.kvs || {});
  let mqttConnected = !!opts.mqttConnected;
  let mqttConnectHandler = null;
  const eventHandlers = [];

  let callIdSeq = 0;
  function shellyCall(method, params, cb) {
    const id = ++callIdSeq;
    inflightCalls++;
    if (inflightCalls > peakCalls) peakCalls = inflightCalls;
    liveCalls.set(id, { method, params });

    let response = null;
    if (method === 'KVS.Get') {
      const val = kvs[(params || {}).key];
      response = val ? { value: val } : null;
    } else if (method === 'KVS.Set') {
      const key = (params || {}).key;
      const value = String((params || {}).value || '');
      const bytes = Buffer.byteLength(value, 'utf8');
      if (bytes > peakKvsBytes) peakKvsBytes = bytes;
      if (bytes > CAPS.KVS_VALUE_BYTES && !kvsTooLarge) {
        kvsTooLarge = { key, bytes };
      }
      kvs[key] = value;
      response = {};
    } else if (method === 'Switch.Set' || method === 'Switch.SetConfig') {
      response = {};
    } else if (method === 'HTTP.GET' || method === 'HTTP.POST') {
      const responder = opts.httpResponder || (() => ({ code: 0, body: '' }));
      let httpRes;
      try { httpRes = responder((params || {}).url || ''); }
      catch (e) { httpRes = { code: 0, body: '' }; }
      setImmediate(() => {
        inflightCalls--;
        liveCalls.delete(id);
        if (cb) cb(httpRes, null);
      });
      return;
    }
    setImmediate(() => {
      inflightCalls--;
      liveCalls.delete(id);
      if (cb) cb(response, null);
    });
  }

  let timerIdSeq = 0;
  function timerSet(ms, repeat, cb) {
    const id = ++timerIdSeq;
    liveTimers.set(id, { ms, repeat, cb, dueAt: opts.now() + ms });
    if (liveTimers.size > peakTimers) peakTimers = liveTimers.size;
    return id;
  }

  function timerClear(id) {
    liveTimers.delete(id);
  }

  const mqtt = {
    subscribe(topic, cb) {
      if (mqttSubs.has(topic)) throw new Error('Invalid topic');
      mqttSubs.set(topic, cb);
      if (mqttSubs.size > peakSubs) peakSubs = mqttSubs.size;
    },
    unsubscribe(topic) {
      mqttSubs.delete(topic);
    },
    publish(topic, payload, qos, retain) {
      if (opts.onPublish) opts.onPublish(topic, payload, qos, retain);
    },
    isConnected() { return mqttConnected; },
    setConnectHandler(cb) { mqttConnectHandler = cb; },
  };

  function emitEvent(name, data) {
    for (const h of eventHandlers) {
      try { h({ info: { event: name, data } }); } catch (_e) {}
    }
  }

  function advance(ms) {
    const targetNow = opts.now() + ms;
    while (opts.now() < targetNow) {
      opts.setNow(opts.now() + 1);
      // Fire all due timers on this tick.
      let fired;
      do {
        fired = null;
        for (const [id, t] of liveTimers) {
          if (t.dueAt <= opts.now()) {
            if (t.repeat) t.dueAt = opts.now() + t.ms;
            else liveTimers.delete(id);
            fired = { id, cb: t.cb };
            break;
          }
        }
        if (fired) {
          try { fired.cb(); } catch (_e) {}
        }
      } while (fired);
    }
  }

  return {
    globals: {
      Shelly: {
        call: shellyCall,
        emitEvent,
        addEventHandler: fn => eventHandlers.push(fn),
        addStatusHandler: () => {},
        getComponentStatus(type) {
          if (type === 'switch') return { apower: 50, output: true };
          if (type === 'sys') return { unixtime: Math.floor(opts.now() / 1000) };
          return {};
        },
      },
      Timer: { set: timerSet, clear: timerClear },
      MQTT: mqtt,
      JSON, Date, Math, parseInt,
      print: () => {},
    },
    stats() {
      return {
        peakTimers, peakCalls, peakSubs, peakKvsBytes,
        kvsTooLarge,
        liveTimers: new Map(liveTimers),
        liveCalls: new Map(liveCalls),
        mqttSubs: new Map(mqttSubs),
      };
    },
    advance,
    triggerMqttConnect() {
      mqttConnected = true;
      if (mqttConnectHandler) mqttConnectHandler();
    },
    deliverMqtt(topic, message) {
      const cb = mqttSubs.get(topic);
      if (cb) cb(topic, message);
    },
    kvs,
  };
}

function runtimeProxy({ state, deviceConfig, sensorConfig, liveTimers, liveCalls, minifiedBytecodeSize }) {
  let bytes = minifiedBytecodeSize || 0;
  try { bytes += JSON.stringify(state || {}).length; } catch (_e) {}
  try { bytes += JSON.stringify(deviceConfig || {}).length; } catch (_e) {}
  try { bytes += JSON.stringify(sensorConfig || {}).length; } catch (_e) {}
  if (liveTimers) {
    for (const t of liveTimers.values()) {
      try { bytes += JSON.stringify({ ms: t.ms, repeat: t.repeat, dueAt: t.dueAt }).length; }
      catch (_e) { bytes += 32; }
    }
  }
  if (liveCalls) {
    for (const c of liveCalls.values()) {
      try { bytes += JSON.stringify({ method: c.method, params: c.params }).length; }
      catch (_e) { bytes += 64; }
    }
  }
  return bytes;
}

module.exports = { CAPS, createInstrumentedRuntime, runtimeProxy };
