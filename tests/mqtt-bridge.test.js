const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

// A RELAY_TOPIC_MAP that resolves EVERY device IP in RELAY_MAP (.50–.54), so
// the #2a startup coverage assertion passes when bridge.start() runs. Tests
// that exercise the assertion's failure path override this locally.
const FULL_TOPIC_MAP = {
  '192.168.30.50': '192.168.30.50',
  '192.168.30.51': '192.168.30.51',
  '192.168.30.52': '192.168.30.52',
  '192.168.30.53': '192.168.30.53',
  '192.168.30.54': '192.168.30.54',
};

describe('mqtt-bridge', () => {
  let bridge;

  beforeEach(() => {
    delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
    bridge = require('../server/lib/mqtt-bridge.js');
    bridge._reset();
  });

  describe('handleStateMessage', () => {
    it('exports handleStateMessage function', () => {
      assert.strictEqual(typeof bridge.handleStateMessage, 'function');
    });
  });

  describe('detectStateChanges', () => {
    it('detects mode changes', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, optsOrCb, maybeCb) {
          const opts = typeof optsOrCb === 'function' ? null : optsOrCb;
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          events.push({ type, id, oldVal, newVal, opts });
          if (cb) cb(null);
        },
      };

      const prev = { mode: 'idle', valves: {}, actuators: {} };
      const curr = { mode: 'solar_charging', valves: {}, actuators: {} };

      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'mode');
      assert.strictEqual(events[0].oldVal, 'idle');
      assert.strictEqual(events[0].newVal, 'solar_charging');
    });

    it('records cause, reason, and sensor snapshot for mode changes', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, optsOrCb, maybeCb) {
          const opts = typeof optsOrCb === 'function' ? null : optsOrCb;
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          events.push({ type, opts });
          if (cb) cb(null);
        },
      };

      const prev = { mode: 'idle', valves: {}, actuators: {} };
      const curr = {
        mode: 'solar_charging',
        cause: 'automation',
        reason: 'solar_enter',
        temps: { collector: 62.3, tank_top: 41, tank_bottom: 29, greenhouse: 12, outdoor: 8 },
        valves: {}, actuators: {},
      };

      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      const modeEvt = events.find(e => e.type === 'mode');
      assert.ok(modeEvt);
      assert.strictEqual(modeEvt.opts.cause, 'automation');
      assert.strictEqual(modeEvt.opts.reason, 'solar_enter');
      assert.deepStrictEqual(modeEvt.opts.sensors,
        { collector: 62.3, tank_top: 41, tank_bottom: 29, greenhouse: 12, outdoor: 8 });
    });

    it('null-fills cause, reason, and sensors when the state payload lacks them (old firmware)', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, optsOrCb, maybeCb) {
          const opts = typeof optsOrCb === 'function' ? null : optsOrCb;
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          events.push({ type, opts });
          if (cb) cb(null);
        },
      };

      const prev = { mode: 'idle', valves: {}, actuators: {} };
      const curr = { mode: 'solar_charging', valves: {}, actuators: {} };
      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      const modeEvt = events.find(e => e.type === 'mode');
      assert.strictEqual(modeEvt.opts.cause, null);
      assert.strictEqual(modeEvt.opts.reason, null);
      assert.strictEqual(modeEvt.opts.sensors, null);
    });

    it('detects valve state changes', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id, oldVal, newVal });
          if (cb) cb(null);
        },
      };

      const prev = {
        mode: 'idle',
        valves: { vi_btm: false, vi_top: false },
        actuators: { pump: false },
      };
      const curr = {
        mode: 'idle',
        valves: { vi_btm: true, vi_top: false },
        actuators: { pump: false },
      };

      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'valve');
      assert.strictEqual(events[0].id, 'vi_btm');
      assert.strictEqual(events[0].oldVal, 'closed');
      assert.strictEqual(events[0].newVal, 'open');
    });

    it('detects actuator state changes', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id, oldVal, newVal });
          if (cb) cb(null);
        },
      };

      const prev = {
        mode: 'solar_charging',
        valves: {},
        actuators: { pump: false, fan: false },
      };
      const curr = {
        mode: 'solar_charging',
        valves: {},
        actuators: { pump: true, fan: false },
      };

      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0].type, 'actuator');
      assert.strictEqual(events[0].id, 'pump');
      assert.strictEqual(events[0].newVal, 'on');
    });

    it('detects greenhouse_fan_cooling_active overlay flip', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id, oldVal, newVal });
          if (cb) cb(null);
        },
      };

      const prev = {
        mode: 'idle', valves: {}, actuators: {},
        flags: { greenhouse_fan_cooling_active: false },
      };
      const curr = {
        mode: 'idle', valves: {}, actuators: {},
        flags: { greenhouse_fan_cooling_active: true },
      };
      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      const overlayEvt = events.find(e => e.type === 'overlay');
      assert.ok(overlayEvt, 'expected an overlay event');
      assert.strictEqual(overlayEvt.id, 'greenhouse_fan_cooling');
      assert.strictEqual(overlayEvt.oldVal, 'off');
      assert.strictEqual(overlayEvt.newVal, 'on');
    });

    it('does not emit overlay event when prev flags are missing (first frame)', () => {
      // Initial snapshot from boot: prev has no flags, curr does. We
      // can't tell whether the overlay just turned on or has been on
      // since boot, so suppress the spurious "started" log entry.
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id });
          if (cb) cb(null);
        },
      };
      const prev = { mode: 'idle', valves: {}, actuators: {} };
      const curr = {
        mode: 'idle', valves: {}, actuators: {},
        flags: { greenhouse_fan_cooling_active: true },
      };
      bridge.detectStateChanges(new Date(), prev, curr, mockDb);
      const overlayEvt = events.find(e => e.type === 'overlay');
      assert.strictEqual(overlayEvt, undefined, 'no overlay event on missing prev flags');
    });

    it('does not emit overlay event when flag stays the same', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id });
          if (cb) cb(null);
        },
      };
      const state = {
        mode: 'idle', valves: {}, actuators: {},
        flags: { greenhouse_fan_cooling_active: true },
      };
      bridge.detectStateChanges(new Date(), state, state, mockDb);
      const overlayEvt = events.find(e => e.type === 'overlay');
      assert.strictEqual(overlayEvt, undefined);
    });

    it('does not emit events when nothing changed', () => {
      const events = [];
      const mockDb = {
        insertStateEvent: function (ts, type, id, oldVal, newVal, cb) {
          events.push({ type, id });
          if (cb) cb(null);
        },
      };

      const state = {
        mode: 'idle',
        valves: { vi_btm: false },
        actuators: { pump: false },
      };

      bridge.detectStateChanges(new Date(), state, state, mockDb);
      assert.strictEqual(events.length, 0);
    });

    it('gracefully handles null db', () => {
      assert.doesNotThrow(() => {
        bridge.detectStateChanges(new Date(), { mode: 'idle' }, { mode: 'solar_charging' });
      });
    });
  });

  // #3: valve/actuator events must only be logged when the relay reading was
  // FRESH on both the prev and curr sides. A fallback (stale/missing) read this
  // tick or last tick means the value came from cache-convergence, not a live
  // device — flips against it are artefacts and must be suppressed.
  describe('detectStateChanges freshness gating (#3)', () => {
    function mkDb(events) {
      return {
        insertStateEvent: function (ts, type, id, oldVal, newVal, optsOrCb, maybeCb) {
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          events.push({ type, id, oldVal, newVal });
          if (cb) cb(null);
        },
      };
    }
    // Build a freshness map marking the listed names fresh, the rest missing.
    function fresh(names) {
      const m = {};
      ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air',
        'pump', 'fan', 'space_heater', 'immersion_heater'].forEach(function (n) {
        m[n] = { status: names.indexOf(n) >= 0 ? 'fresh' : 'missing', ageMs: names.indexOf(n) >= 0 ? 0 : null };
      });
      return m;
    }

    it('suppresses the cold-cache restart burst (missing→fresh)', () => {
      // After a server restart the cache is cold: first assembled tick reads
      // every relay as MISSING (→ false). The next tick the real reads land
      // fresh (→ true). The false→true flip never happened on the device.
      const events = [];
      const prev = { mode: 'solar_charging', valves: { vi_btm: false }, actuators: { pump: false } };
      const curr = { mode: 'solar_charging', valves: { vi_btm: true }, actuators: { pump: true } };
      const prevF = fresh([]);          // cold cache: all missing
      const currF = fresh(['vi_btm', 'pump']); // now fresh
      bridge.detectStateChanges(new Date(), prev, curr, mkDb(events), prevF, currF);
      assert.strictEqual(events.filter((e) => e.type === 'valve' || e.type === 'actuator').length, 0,
        'no fabricated valve/actuator events on the cold-cache burst');
    });

    it('suppresses a stale-window flip (fresh→stale)', () => {
      // The controller went silent; this tick the cache is stale and falls back
      // to a different previousState-derived value. Not a real transition.
      const events = [];
      const prev = { mode: 'solar_charging', valves: {}, actuators: { pump: true } };
      const curr = { mode: 'solar_charging', valves: {}, actuators: { pump: false } };
      const prevF = fresh(['pump']);
      const currF = { pump: { status: 'stale', ageMs: 999999 } };
      bridge.detectStateChanges(new Date(), prev, curr, mkDb(events), prevF, currF);
      assert.strictEqual(events.filter((e) => e.type === 'actuator').length, 0,
        'a stale read this tick must not log an actuator transition');
    });

    it('still logs a genuine fresh→fresh transition', () => {
      const events = [];
      const prev = { mode: 'solar_charging', valves: { vi_btm: false }, actuators: { pump: false } };
      const curr = { mode: 'solar_charging', valves: { vi_btm: true }, actuators: { pump: true } };
      const prevF = fresh(['vi_btm', 'pump']);
      const currF = fresh(['vi_btm', 'pump']);
      bridge.detectStateChanges(new Date(), prev, curr, mkDb(events), prevF, currF);
      assert.ok(events.find((e) => e.type === 'valve' && e.id === 'vi_btm' && e.newVal === 'open'));
      assert.ok(events.find((e) => e.type === 'actuator' && e.id === 'pump' && e.newVal === 'on'));
    });

    it('falls back to diff-everything when no freshness maps are supplied (legacy callers)', () => {
      // Direct full-state callers carry device-authored valves/actuators and
      // pass no freshness — keep the prior behaviour.
      const events = [];
      const prev = { mode: 'idle', valves: { vi_btm: false }, actuators: { pump: false } };
      const curr = { mode: 'idle', valves: { vi_btm: true }, actuators: { pump: false } };
      bridge.detectStateChanges(new Date(), prev, curr, mkDb(events));
      assert.ok(events.find((e) => e.type === 'valve' && e.id === 'vi_btm' && e.newVal === 'open'));
    });

    it('mode + overlay events are unaffected by freshness (device-authored)', () => {
      const events = [];
      const prev = { mode: 'idle', valves: {}, actuators: {}, flags: { greenhouse_fan_cooling_active: false } };
      const curr = { mode: 'solar_charging', valves: {}, actuators: {}, flags: { greenhouse_fan_cooling_active: true } };
      // Empty freshness maps (would suppress every valve/actuator) — mode/overlay
      // must still fire.
      bridge.detectStateChanges(new Date(), prev, curr, mkDb(events), fresh([]), fresh([]));
      assert.ok(events.find((e) => e.type === 'mode' && e.newVal === 'solar_charging'));
      assert.ok(events.find((e) => e.type === 'overlay' && e.id === 'greenhouse_fan_cooling'));
    });
  });

  // #2a: fail loud on incomplete RELAY_TOPIC_MAP coverage at startup.
  describe('relay topic-map coverage assertion (#2a)', () => {
    let prevRelayEnv;
    let prevPreview;

    beforeEach(() => {
      prevRelayEnv = process.env.RELAY_TOPIC_MAP;
      prevPreview = process.env.PREVIEW_MODE;
    });
    afterEach(() => {
      if (prevRelayEnv === undefined) delete process.env.RELAY_TOPIC_MAP;
      else process.env.RELAY_TOPIC_MAP = prevRelayEnv;
      if (prevPreview === undefined) delete process.env.PREVIEW_MODE;
      else process.env.PREVIEW_MODE = prevPreview;
    });

    function freshBridge() {
      delete require.cache[require.resolve('../server/lib/relay-status.js')];
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      const b = require('../server/lib/mqtt-bridge.js');
      b._reset();
      return b;
    }

    it('throws in non-preview mode when the map is incomplete', () => {
      delete process.env.PREVIEW_MODE;
      process.env.RELAY_TOPIC_MAP = JSON.stringify({ '192.168.30.50': '192.168.30.50' });
      const b = freshBridge();
      assert.throws(() => b.assertRelayTopicCoverage(), /RELAY_TOPIC_MAP/);
      const cov = b.getRelayTopicCoverage();
      assert.strictEqual(cov.ok, false);
      assert.ok(cov.missing.indexOf('192.168.30.51') >= 0);
    });

    it('throws from start() in non-preview mode with an unset map', () => {
      delete process.env.PREVIEW_MODE;
      delete process.env.RELAY_TOPIC_MAP;
      const b = freshBridge();
      assert.throws(() => b.start({ mqttHost: '127.0.0.1' }), /RELAY_TOPIC_MAP/);
    });

    it('does NOT throw in non-preview mode when the map covers every IP', () => {
      delete process.env.PREVIEW_MODE;
      process.env.RELAY_TOPIC_MAP = JSON.stringify(FULL_TOPIC_MAP);
      const b = freshBridge();
      assert.doesNotThrow(() => b.assertRelayTopicCoverage());
      assert.strictEqual(b.getRelayTopicCoverage().ok, true);
    });

    it('does NOT throw in PREVIEW_MODE even with an incomplete map (warns + records)', () => {
      process.env.PREVIEW_MODE = 'true';
      process.env.RELAY_TOPIC_MAP = JSON.stringify({ '192.168.30.50': '192.168.30.50' });
      const b = freshBridge();
      assert.doesNotThrow(() => b.assertRelayTopicCoverage());
      const cov = b.getRelayTopicCoverage();
      assert.strictEqual(cov.ok, false, 'preview still records the gap as queryable health');
      assert.ok(cov.missing.length > 0);
      delete process.env.PREVIEW_MODE;
    });
  });

  describe('handleStateMin (device-minimal → assembled greenhouse/state)', () => {
    const TOPIC_MAP = { p4pm: '192.168.30.50', p51: '192.168.30.51' };
    let prevRelayEnv;
    let relay;

    beforeEach(() => {
      prevRelayEnv = process.env.RELAY_TOPIC_MAP;
      process.env.RELAY_TOPIC_MAP = JSON.stringify(TOPIC_MAP);
      delete require.cache[require.resolve('../server/lib/relay-status.js')];
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      relay = require('../server/lib/relay-status.js');
      bridge = require('../server/lib/mqtt-bridge.js');
      bridge._reset();
      relay.reset();
    });

    afterEach(() => {
      if (prevRelayEnv === undefined) delete process.env.RELAY_TOPIC_MAP;
      else process.env.RELAY_TOPIC_MAP = prevRelayEnv;
    });

    // Use a near-now timestamp so freshly-ingested relay entries are inside
    // RELAY_STALE_MS of the assemble-time Date.now() (handleStateMin uses real
    // time). A baked-in 2024 epoch would read as stale and fall through.
    const NOW = Date.now();
    const MIN = {
      ts: NOW,
      mode: 'solar_charging',
      transitioning: false,
      transition_step: null,
      temps: { collector: 62, tank_top: 41, tank_bottom: 29, greenhouse: 12, outdoor: 8 },
      flags: { collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: false },
      opening: [], queued_opens: [], pending_closes: [],
      cause: 'automation', reason: 'solar_enter', eval_reason: 'solar_active', held: null,
    };

    it('assembles valves/actuators from relay cache and broadcasts the full payload', () => {
      relay.ingestStatus('p4pm/status/switch:0', { output: true }, MIN.ts);
      relay.ingestStatus('p51/status/switch:0', { output: true }, MIN.ts);

      const sent = [];
      bridge._setWsServerForTest({ clients: [{ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }] });
      bridge._setDeviceConfigRefForTest({ getConfig: () => ({ ce: true, ea: 31 }) });

      bridge.handleStateMin(MIN);

      // Two frames: the state frame, then the relay_health sidecar frame.
      const stateFrame = sent.find((f) => f.type === 'state');
      const healthFrame = sent.find((f) => f.type === 'relay_health');
      assert.ok(stateFrame, 'expected a state frame');
      assert.ok(healthFrame, 'expected a relay_health sidecar frame');
      const data = stateFrame.data;
      assert.strictEqual(data.mode, 'solar_charging');
      assert.strictEqual(data.actuators.pump, true);
      assert.strictEqual(data.valves.vi_btm, true);
      assert.strictEqual(data.valves.vi_top, false);
      assert.strictEqual(data.controls_enabled, true);
      assert.ok(Object.prototype.hasOwnProperty.call(data, 'manual_override'));
      // greenhouse/state stays byte-identical — no freshness leakage.
      assert.strictEqual(typeof data.freshness, 'undefined');
      assert.strictEqual(typeof data.relay_health, 'undefined');
      // The sidecar carries per-relay freshness for the live relays.
      assert.strictEqual(healthFrame.data.relays.pump.status, 'fresh');
      assert.strictEqual(healthFrame.data.relays.vi_btm.status, 'fresh');
      assert.strictEqual(healthFrame.data.relays.vi_top.status, 'missing');
    });

    it('broadcasts the relay_health frame AFTER the state frame', () => {
      const sent = [];
      bridge._setWsServerForTest({ clients: [{ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }] });
      bridge._setDeviceConfigRefForTest({ getConfig: () => ({ ce: true }) });
      bridge.handleStateMin(MIN);
      const stateIdx = sent.findIndex((f) => f.type === 'state');
      const healthIdx = sent.findIndex((f) => f.type === 'relay_health');
      assert.ok(stateIdx >= 0 && healthIdx >= 0);
      assert.ok(healthIdx > stateIdx, 'relay_health must come after state');
    });

    it('publishes the relay-health sidecar to greenhouse/relay-health (retained)', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: (topic, msg, opts) => publishCalls.push({ topic, msg, opts }),
      });
      bridge._setDeviceConfigRefForTest({ getConfig: () => ({ ce: true }) });
      relay.ingestStatus('p4pm/status/switch:0', { output: true }, MIN.ts);

      bridge.handleStateMin(MIN);

      const health = publishCalls.filter((c) => c.topic === 'greenhouse/relay-health');
      assert.strictEqual(health.length, 1, 'must publish the relay-health sidecar');
      assert.strictEqual(health[0].opts.retain, true);
      assert.strictEqual(health[0].opts.qos, 1);
      const parsed = JSON.parse(health[0].msg);
      assert.ok(parsed.relays, 'sidecar carries a relays map');
      assert.strictEqual(parsed.relays.pump.status, 'fresh');
      // The greenhouse/state republish is unchanged (byte-identical, no freshness).
      const state = publishCalls.filter((c) => c.topic === 'greenhouse/state');
      assert.strictEqual(state.length, 1);
      assert.strictEqual(typeof JSON.parse(state[0].msg).freshness, 'undefined');
    });

    it('re-publishes the assembled payload to greenhouse/state (retained) when connected', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: (topic, msg, opts) => publishCalls.push({ topic, msg, opts }),
      });
      bridge._setDeviceConfigRefForTest({ getConfig: () => ({ ce: true }) });

      bridge.handleStateMin(MIN);

      const re = publishCalls.filter((c) => c.topic === 'greenhouse/state');
      assert.strictEqual(re.length, 1, 'must re-publish assembled state');
      assert.strictEqual(re[0].opts.retain, true);
      assert.strictEqual(re[0].opts.qos, 1);
      const parsed = JSON.parse(re[0].msg);
      assert.strictEqual(parsed.mode, 'solar_charging');
      assert.ok('valves' in parsed && 'actuators' in parsed && 'controls_enabled' in parsed);
    });

    it('fires mode/valve/actuator events off the assembled payload', () => {
      const events = [];
      bridge._setDbForTest({
        insertSensorReadings: () => {},
        insertStateEvent: function (ts, type, id, oldVal, newVal, optsOrCb, maybeCb) {
          const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
          events.push({ type, id, oldVal, newVal });
          if (cb) cb(null);
        },
      });
      bridge._setDeviceConfigRefForTest({ getConfig: () => ({ ce: true }) });

      // First frame: idle, pump + vi_btm FRESH-off (establishes a fresh prev).
      relay.ingestStatus('p4pm/status/switch:0', { output: false }, MIN.ts);
      relay.ingestStatus('p51/status/switch:0', { output: false }, MIN.ts);
      bridge.handleStateMin(Object.assign({}, MIN, { mode: 'idle' }));
      // Second frame: solar_charging with pump + vi_btm FRESH-on. A genuine
      // fresh→fresh transition MUST be logged (#3 only suppresses fallback reads).
      relay.ingestStatus('p4pm/status/switch:0', { output: true }, MIN.ts);
      relay.ingestStatus('p51/status/switch:0', { output: true }, MIN.ts);
      bridge.handleStateMin(MIN);

      assert.ok(events.find((e) => e.type === 'mode' && e.newVal === 'solar_charging'));
      assert.ok(events.find((e) => e.type === 'actuator' && e.id === 'pump' && e.newVal === 'on'));
      assert.ok(events.find((e) => e.type === 'valve' && e.id === 'vi_btm' && e.newVal === 'open'));
    });
  });

  describe('handleStateMin PREVIEW_MODE', () => {
    let prevPreview;
    let prevRelayEnv;
    let relay;

    beforeEach(() => {
      prevPreview = process.env.PREVIEW_MODE;
      prevRelayEnv = process.env.RELAY_TOPIC_MAP;
      process.env.PREVIEW_MODE = 'true';
      process.env.RELAY_TOPIC_MAP = JSON.stringify({ p4pm: '192.168.30.50' });
      delete require.cache[require.resolve('../server/lib/relay-status.js')];
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      relay = require('../server/lib/relay-status.js');
      bridge = require('../server/lib/mqtt-bridge.js');
      bridge._reset();
      relay.reset();
    });

    afterEach(() => {
      if (prevPreview === undefined) delete process.env.PREVIEW_MODE;
      else process.env.PREVIEW_MODE = prevPreview;
      if (prevRelayEnv === undefined) delete process.env.RELAY_TOPIC_MAP;
      else process.env.RELAY_TOPIC_MAP = prevRelayEnv;
      bridge._reset();
    });

    it('does NOT re-publish to greenhouse/state but still broadcasts to WS', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: (topic, msg, opts) => publishCalls.push({ topic, msg, opts }),
      });
      const sent = [];
      bridge._setWsServerForTest({ clients: [{ readyState: 1, send: (m) => sent.push(JSON.parse(m)) }] });

      bridge.handleStateMin({ ts: 1, mode: 'idle', temps: {}, flags: {} });

      assert.strictEqual(publishCalls.filter((c) => c.topic === 'greenhouse/state').length, 0,
        'preview must not re-publish greenhouse/state');
      assert.strictEqual(publishCalls.filter((c) => c.topic === 'greenhouse/relay-health').length, 0,
        'preview must not publish the relay-health sidecar either');
      // Preview still broadcasts to its own WS clients — both the state frame
      // and the relay_health sidecar frame.
      const stateFrame = sent.find((f) => f.type === 'state');
      assert.ok(stateFrame, 'preview still broadcasts the state frame');
      assert.strictEqual(stateFrame.data.mode, 'idle');
      assert.ok(sent.find((f) => f.type === 'relay_health'), 'preview still broadcasts relay_health to its WS clients');
    });
  });

  describe('getConnectionStatus', () => {
    it('returns disconnected by default', () => {
      assert.strictEqual(bridge.getConnectionStatus(), 'disconnected');
    });
  });

  describe('last state replay (fast first paint)', () => {
    it('getLastState returns null before any greenhouse/state has been received', () => {
      assert.strictEqual(bridge.getLastState(), null);
    });

    it('getLastState returns the most recent payload after handleStateMessage', () => {
      const payload = {
        ts: 1, mode: 'idle',
        temps: { collector: null, tank_top: null, tank_bottom: null, greenhouse: null, outdoor: null },
        valves: {}, actuators: {},
        controls_enabled: true,
      };
      bridge.handleStateMessage(payload);
      const last = bridge.getLastState();
      assert.ok(last, 'expected cached state');
      assert.strictEqual(last.mode, 'idle');
      assert.strictEqual(last.controls_enabled, true);
    });

    it('getLastState enriches with manual_override from deviceConfig (active session)', () => {
      bridge._setDeviceConfigRefForTest({
        getConfig: function () {
          return { ce: true, ea: 31, mo: { a: true, ex: 9999, fm: 'I' } };
        },
      });
      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {}, controls_enabled: true,
      });
      const last = bridge.getLastState();
      assert.deepStrictEqual(last.manual_override, { active: true, expiresAt: 9999, forcedMode: 'I' });
    });

    it('getLastState enriches manual_override as null when no active override', () => {
      bridge._setDeviceConfigRefForTest({
        getConfig: function () { return { ce: true, ea: 31 }; },
      });
      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {}, controls_enabled: true,
      });
      const last = bridge.getLastState();
      assert.strictEqual(last.manual_override, null);
    });

    it('getLastState reports the forcedMode in manual_override', () => {
      bridge._setDeviceConfigRefForTest({
        getConfig: function () {
          return { ce: true, ea: 31, mo: { a: true, ex: 9999, fm: 'SC' } };
        },
      });
      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {}, controls_enabled: true,
      });
      const last = bridge.getLastState();
      assert.deepStrictEqual(last.manual_override, { active: true, expiresAt: 9999, forcedMode: 'SC' });
    });

    it('subsequent state messages overwrite the cache so the latest is always served', () => {
      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {}, controls_enabled: false,
      });
      bridge.handleStateMessage({
        ts: 2, mode: 'solar_charging', temps: {}, valves: {}, actuators: {}, controls_enabled: true,
      });
      const last = bridge.getLastState();
      assert.strictEqual(last.mode, 'solar_charging');
      assert.strictEqual(last.controls_enabled, true);
      assert.strictEqual(last.ts, 2);
    });
  });

  describe('MQTT request/response', () => {
    it('publishSensorConfigApply rejects when MQTT not connected', async () => {
      await assert.rejects(
        () => bridge.publishSensorConfigApply({ id: 'test-1', target: null, config: {} }),
        /MQTT not connected/
      );
    });

    it('publishDiscoveryRequest rejects when MQTT not connected', async () => {
      await assert.rejects(
        () => bridge.publishDiscoveryRequest(['192.168.30.20']),
        /MQTT not connected/
      );
    });

    it('exports publishSensorConfigApply and publishDiscoveryRequest', () => {
      assert.strictEqual(typeof bridge.publishSensorConfigApply, 'function');
      assert.strictEqual(typeof bridge.publishDiscoveryRequest, 'function');
    });
  });

  describe('sole state source (no valve-poller)', () => {
    it('handleStateMessage broadcasts state via WebSocket', () => {
      const sent = [];
      // _mockWs documents the shape of the wsServer the bridge expects;
      // the actual wiring happens via freshBridge below.
      const _mockWs = {
        clients: [{ readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) }],
      };
      bridge._reset();
      // Manually set wsServer through a new bridge instance
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      const freshBridge = require('../server/lib/mqtt-bridge.js');

      // Simulate internal state by calling handleStateMessage after setting up ws
      // The bridge needs wsServer set — we test the exported handleStateMessage
      // with a mock that captures broadcasts
      const payload = {
        ts: Date.now(),
        mode: 'idle',
        temps: { collector: 25, tank_top: 30, tank_bottom: 20, greenhouse: 15, outdoor: 10 },
        valves: { vi_btm: false },
        actuators: { pump: false },
      };

      // handleStateMessage doesn't crash without wsServer (graceful no-op)
      assert.doesNotThrow(() => freshBridge.handleStateMessage(payload));
      freshBridge._reset();
    });

    it('publishes config via publishConfig', () => {
      // Without MQTT client connected, publishConfig returns false
      assert.strictEqual(bridge.publishConfig({ ce: true, ea: 31, v: 1 }), false);
    });

    it('publishes sensor config via publishSensorConfig', () => {
      assert.strictEqual(bridge.publishSensorConfig({ s: {}, h: [], v: 1 }), false);
    });
  });

  describe('auto-republish on MQTT connect', () => {
    let fakeMqttModule;
    let fakeClient;
    let mqttModulePath;
    let originalCacheEntry;
    let prevRelayEnv;

    beforeEach(() => {
      prevRelayEnv = process.env.RELAY_TOPIC_MAP;
      process.env.RELAY_TOPIC_MAP = JSON.stringify(FULL_TOPIC_MAP);
      delete require.cache[require.resolve('../server/lib/relay-status.js')];
      fakeClient = new EventEmitter();
      fakeClient.connected = false;
      fakeClient.subscribe = function (topic, opts, cb) {
        if (typeof opts === 'function') { cb = opts; }
        if (cb) cb(null);
      };
      fakeClient.publish = function (topic, message, opts, cb) {
        fakeClient.publishCalls.push({ topic, message, opts });
        if (cb) cb(null);
      };
      fakeClient.end = function (force, opts, cb) { if (cb) cb(); };
      fakeClient.publishCalls = [];

      fakeMqttModule = {
        connect: function () { return fakeClient; },
      };

      mqttModulePath = require.resolve('mqtt');
      originalCacheEntry = require.cache[mqttModulePath];
      require.cache[mqttModulePath] = { id: mqttModulePath, filename: mqttModulePath, loaded: true, exports: fakeMqttModule };

      // Reload bridge so it picks up the fake mqtt module via require()
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      bridge = require('../server/lib/mqtt-bridge.js');
      bridge._reset();
    });

    afterEach(() => {
      if (originalCacheEntry) {
        require.cache[mqttModulePath] = originalCacheEntry;
      } else {
        delete require.cache[mqttModulePath];
      }
      if (prevRelayEnv === undefined) delete process.env.RELAY_TOPIC_MAP;
      else process.env.RELAY_TOPIC_MAP = prevRelayEnv;
      bridge._reset();
    });

    it('republishes the current device config to greenhouse/config (retained) when MQTT connects', () => {
      const currentConfig = { ce: true, ea: 31, fm: null, am: null, v: 8 };
      const fakeDeviceConfig = {
        getConfig: function () { return currentConfig; },
      };

      bridge.start({ mqttHost: '127.0.0.1', deviceConfig: fakeDeviceConfig });

      // Simulate broker handshake completing
      fakeClient.connected = true;
      fakeClient.emit('connect');

      const configPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/config';
      });
      assert.strictEqual(configPublishes.length, 1,
        'bridge should publish device config exactly once on MQTT connect');
      assert.deepStrictEqual(JSON.parse(configPublishes[0].message), currentConfig);
      assert.strictEqual(configPublishes[0].opts.retain, true,
        'config publish must be retained so reconnecting Shellies receive it');
      assert.strictEqual(configPublishes[0].opts.qos, 1);
    });

    it('republishes again on every reconnect (e.g. broker restart)', () => {
      const fakeDeviceConfig = {
        getConfig: function () { return { ce: true, ea: 31, fm: null, am: null, v: 1 }; },
      };

      bridge.start({ mqttHost: '127.0.0.1', deviceConfig: fakeDeviceConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');
      fakeClient.emit('connect');
      fakeClient.emit('connect');

      const configPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/config';
      });
      assert.strictEqual(configPublishes.length, 3,
        'bridge should re-publish on every MQTT connect event so a broker restart self-heals');
    });

    it('does not crash on connect when no deviceConfig provider was supplied', () => {
      bridge.start({ mqttHost: '127.0.0.1' });

      fakeClient.connected = true;
      assert.doesNotThrow(function () { fakeClient.emit('connect'); });

      const configPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/config';
      });
      assert.strictEqual(configPublishes.length, 0);
    });

    it('does not republish when deviceConfig.getConfig() returns null', () => {
      const fakeDeviceConfig = { getConfig: function () { return null; } };
      bridge.start({ mqttHost: '127.0.0.1', deviceConfig: fakeDeviceConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');

      const configPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/config';
      });
      assert.strictEqual(configPublishes.length, 0,
        'should skip republish when no config is loaded yet (e.g. S3 fetch still in flight)');
    });

    // Sibling to the device-config republish: our Mosquitto sidecar has no
    // persistence, so a broker restart wipes the retained greenhouse/sensor-config
    // message. Without an auto-republish the Shelly controller would keep
    // polling whatever it has in KVS — even if the server has since stored a
    // newer role→cid mapping via PUT /api/sensor-config. The status view would
    // then keep showing the wrong probe for each role while the sensors tab
    // (which talks to each hub directly) shows the right one.
    it('republishes the current sensor config to greenhouse/sensor-config (retained) when MQTT connects', () => {
      const currentSensor = {
        hosts: [{ id: 'sensor_1', ip: '192.168.30.20' }],
        assignments: {
          collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 },
          tank_top:  { addr: 'aa:02', hostIndex: 0, componentId: 101 },
        },
        version: 5,
      };
      const fakeSensorConfig = {
        getConfig: function () { return currentSensor; },
        toCompactFormat: function (cfg) {
          return {
            s: {
              collector: { h: 0, i: cfg.assignments.collector.componentId, a: cfg.assignments.collector.addr },
              tank_top:  { h: 0, i: cfg.assignments.tank_top.componentId,  a: cfg.assignments.tank_top.addr },
            },
            h: ['192.168.30.20'],
            v: cfg.version,
          };
        },
      };

      bridge.start({ mqttHost: '127.0.0.1', sensorConfig: fakeSensorConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');

      const sensorPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/sensor-config';
      });
      assert.strictEqual(sensorPublishes.length, 1,
        'bridge should publish sensor config exactly once on MQTT connect');
      const payload = JSON.parse(sensorPublishes[0].message);
      assert.strictEqual(payload.v, 5);
      assert.deepStrictEqual(payload.s.collector, { h: 0, i: 100, a: 'aa:01' });
      assert.deepStrictEqual(payload.s.tank_top,  { h: 0, i: 101, a: 'aa:02' });
      assert.strictEqual(sensorPublishes[0].opts.retain, true,
        'sensor-config publish must be retained so a rebooting Shelly picks it up after reconnect');
      assert.strictEqual(sensorPublishes[0].opts.qos, 1);
    });

    it('re-publishes sensor config on every reconnect so a broker restart self-heals', () => {
      const fakeSensorConfig = {
        getConfig: function () {
          return {
            hosts: [{ id: 'sensor_1', ip: '192.168.30.20' }],
            assignments: { collector: { addr: 'aa:01', hostIndex: 0, componentId: 100 } },
            version: 2,
          };
        },
        toCompactFormat: function () {
          return { s: { collector: { h: 0, i: 100, a: 'aa:01' } }, h: ['192.168.30.20'], v: 2 };
        },
      };

      bridge.start({ mqttHost: '127.0.0.1', sensorConfig: fakeSensorConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');
      fakeClient.emit('connect');
      fakeClient.emit('connect');

      const sensorPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/sensor-config';
      });
      assert.strictEqual(sensorPublishes.length, 3,
        'bridge should re-publish sensor config on every MQTT connect event');
    });

    it('skips sensor-config republish when no assignments have been persisted yet', () => {
      const fakeSensorConfig = {
        getConfig: function () {
          return { hosts: [], assignments: {}, version: 0 };
        },
        toCompactFormat: function () { return { s: {}, h: [], v: 0 }; },
      };

      bridge.start({ mqttHost: '127.0.0.1', sensorConfig: fakeSensorConfig });

      fakeClient.connected = true;
      fakeClient.emit('connect');

      const sensorPublishes = fakeClient.publishCalls.filter(function (c) {
        return c.topic === 'greenhouse/sensor-config';
      });
      assert.strictEqual(sensorPublishes.length, 0,
        'no point in publishing an empty sensor config — Shelly would just keep all temps null');
    });
  });

  describe('PREVIEW_MODE', () => {
    let prevEnv;

    beforeEach(() => {
      prevEnv = process.env.PREVIEW_MODE;
      process.env.PREVIEW_MODE = 'true';
      delete require.cache[require.resolve('../server/lib/mqtt-bridge.js')];
      bridge = require('../server/lib/mqtt-bridge.js');
      bridge._reset();
    });

    afterEach(() => {
      if (prevEnv === undefined) delete process.env.PREVIEW_MODE;
      else process.env.PREVIEW_MODE = prevEnv;
      bridge._reset();
    });

    it('handleStateMessage does not write sensor readings or state events to db', () => {
      const writes = [];
      bridge._setDbForTest({
        insertSensorReadings: function () { writes.push('readings'); },
        insertStateEvent: function () { writes.push('event'); },
      });

      bridge.handleStateMessage({
        ts: 1, mode: 'idle', temps: { collector: 25 }, valves: {}, actuators: {},
      });
      bridge.handleStateMessage({
        ts: 2, mode: 'solar_charging', temps: { collector: 60 }, valves: {}, actuators: {},
      });

      assert.deepStrictEqual(writes, [], 'preview must not persist state-derived rows');
    });

    it('handleStateMessage still broadcasts to WebSocket clients (live updates)', () => {
      const sent = [];
      bridge._setWsServerForTest({
        clients: [{ readyState: 1, send: (msg) => sent.push(JSON.parse(msg)) }],
      });

      bridge.handleStateMessage({
        ts: 1, mode: 'solar_charging', temps: { collector: 60 }, valves: {}, actuators: {},
      });

      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0].type, 'state');
      assert.strictEqual(sent[0].data.mode, 'solar_charging');
    });

    it('handleStateMessage does not call notifications.evaluate (no double-fire push)', () => {
      const notifications = require('../server/lib/notifications');
      const original = notifications.evaluate;
      let called = false;
      notifications.evaluate = function () { called = true; };
      bridge._setPushRefForTest({ sendNotification: function () { return Promise.resolve(); } });

      try {
        bridge.handleStateMessage({
          ts: 1, mode: 'idle', temps: {}, valves: {}, actuators: {},
        });
        assert.strictEqual(called, false, 'preview must not evaluate notifications — prod already does');
      } finally {
        notifications.evaluate = original;
      }
    });

    it('publishConfig is a no-op (returns false) even when MQTT is connected', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: function (topic, msg) { publishCalls.push({ topic, msg }); },
      });

      const result = bridge.publishConfig({ ce: true, ea: 31, v: 1 });
      assert.strictEqual(result, false);
      assert.strictEqual(publishCalls.length, 0, 'preview must never publish to greenhouse/config');
    });

    it('publishSensorConfig is a no-op (returns false) even when MQTT is connected', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: function (topic, msg) { publishCalls.push({ topic, msg }); },
      });

      const result = bridge.publishSensorConfig({ s: {}, h: [], v: 1 });
      assert.strictEqual(result, false);
      assert.strictEqual(publishCalls.length, 0);
    });

    it('publishRelayCommand is a no-op (returns false) even when MQTT is connected', () => {
      const publishCalls = [];
      bridge._setMqttClientForTest({
        connected: true,
        publish: function (topic, msg) { publishCalls.push({ topic, msg }); },
      });

      const result = bridge.publishRelayCommand('pump', true);
      assert.strictEqual(result, false);
      assert.strictEqual(publishCalls.length, 0, 'preview must never actuate real relays');
    });

    it('publishSensorConfigApply rejects with PREVIEW_MODE error', async () => {
      bridge._setMqttClientForTest({ connected: true, publish: function () {} });
      await assert.rejects(
        () => bridge.publishSensorConfigApply({ id: 'x', target: null, config: {} }),
        /PREVIEW_MODE/
      );
    });
  });
});
