const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// The relay-status module reads RELAY_TOPIC_MAP at load + on reset(). We set
// a deterministic prefix→IP map so tests don't depend on MAC-derived
// defaults. Prefixes here mimic Shelly's default `shellyproXpm-<mac>` shape.
const TOPIC_MAP = {
  'shellypro4pm-aabbccddee50': '192.168.30.50',
  'shellypro2pm-aabbccddee51': '192.168.30.51',
  'shellypro2pm-aabbccddee52': '192.168.30.52',
  'shellypro2pm-aabbccddee53': '192.168.30.53',
  'shellypro2pm-aabbccddee54': '192.168.30.54',
  'shellypro2pm-aabbccddee55': '192.168.30.55', // spare controller — never mapped to a relay
};

describe('relay-status', () => {
  let relay;
  let prevEnv;

  beforeEach(() => {
    prevEnv = process.env.RELAY_TOPIC_MAP;
    process.env.RELAY_TOPIC_MAP = JSON.stringify(TOPIC_MAP);
    delete require.cache[require.resolve('../server/lib/relay-status.js')];
    relay = require('../server/lib/relay-status.js');
    relay.reset();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.RELAY_TOPIC_MAP;
    else process.env.RELAY_TOPIC_MAP = prevEnv;
  });

  describe('parseStatusTopic', () => {
    it('parses a native Shelly per-switch status topic', () => {
      assert.deepStrictEqual(
        relay.parseStatusTopic('shellypro4pm-aabbccddee50/status/switch:0'),
        { prefix: 'shellypro4pm-aabbccddee50', id: 0 });
    });

    it('rejects non-status topics', () => {
      assert.strictEqual(relay.parseStatusTopic('greenhouse/state/min'), null);
      assert.strictEqual(relay.parseStatusTopic('shellypro4pm-x/status/input:0'), null);
      assert.strictEqual(relay.parseStatusTopic('shellypro4pm-x/status/switch:'), null);
      assert.strictEqual(relay.parseStatusTopic('shellypro4pm-x/status/switch:abc'), null);
    });
  });

  describe('resolvePrefix', () => {
    it('resolves a mapped prefix to its device IP', () => {
      assert.strictEqual(relay.resolvePrefix('shellypro4pm-aabbccddee50'), '192.168.30.50');
    });
    it('resolves a prefix that is already a known device IP', () => {
      assert.strictEqual(relay.resolvePrefix('192.168.30.51'), '192.168.30.51');
    });
    it('returns null for an unknown prefix', () => {
      assert.strictEqual(relay.resolvePrefix('shellyplug-unknown'), null);
    });
  });

  describe('ingestStatus + assembleState', () => {
    it('reflects an ingested relay output in the assembled payload', () => {
      const now = 1000000;
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:0', { id: 0, output: true }, now);
      relay.ingestStatus('shellypro2pm-aabbccddee51/status/switch:0', { id: 0, output: true }, now);

      const min = { ts: now, mode: 'solar_charging', temps: {}, flags: {} };
      const { payload: out } = relay.assembleState(min, { now });
      assert.strictEqual(out.actuators.pump, true);
      assert.strictEqual(out.valves.vi_btm, true);
      assert.strictEqual(out.valves.vi_top, false); // never seen → false
    });

    it('maps 4PM ids to the correct actuator names (id2=immersion, id3=space)', () => {
      const now = 5000;
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:2', { output: true }, now);
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:3', { output: false }, now);
      const { payload: out } = relay.assembleState({ temps: {}, flags: {} }, { now });
      assert.strictEqual(out.actuators.immersion_heater, true);
      assert.strictEqual(out.actuators.space_heater, false);
    });

    it('ignores the reserved spare switch (.54 id 1) and the spare controller (.55)', () => {
      const now = 5000;
      const a = relay.ingestStatus('shellypro2pm-aabbccddee54/status/switch:1', { output: true }, now);
      const b = relay.ingestStatus('shellypro2pm-aabbccddee55/status/switch:0', { output: true }, now);
      assert.strictEqual(a, false, '.54 id1 is reserved — not ingested');
      assert.strictEqual(b, false, '.55 is the spare controller — not ingested');
    });

    it('emits valves/actuators in the fixed byte-compatible key order', () => {
      const { payload: out } = relay.assembleState({ temps: {}, flags: {} }, {});
      assert.deepStrictEqual(Object.keys(out.valves),
        ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air']);
      assert.deepStrictEqual(Object.keys(out.actuators),
        ['pump', 'fan', 'space_heater', 'immersion_heater']);
    });
  });

  describe('staleness fallback chain', () => {
    it('uses cached output when fresh', () => {
      const t0 = 1000000;
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:0', { output: true }, t0);
      const { payload: out } = relay.assembleState({ temps: {}, flags: {} }, { now: t0 + 1000 });
      assert.strictEqual(out.actuators.pump, true);
    });

    it('falls back to previousState when the cached entry is stale', () => {
      const t0 = 1000000;
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:0', { output: true }, t0);
      // now is RELAY_STALE_MS + 1 past lastSeen → stale
      const now = t0 + relay.RELAY_STALE_MS + 1;
      const previousState = { actuators: { pump: false }, valves: {} };
      const { payload: out } = relay.assembleState({ temps: {}, flags: {} }, { previousState, now });
      assert.strictEqual(out.actuators.pump, false, 'stale cache → previousState wins');
    });

    it('falls back to false when never seen and no previousState', () => {
      const { payload: out } = relay.assembleState({ temps: {}, flags: {} }, { now: 1 });
      assert.strictEqual(out.actuators.pump, false);
      assert.strictEqual(out.valves.v_air, false);
    });

    it('prefers fresh cache over previousState (cache wins when fresh)', () => {
      const t0 = 1000000;
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:1', { output: true }, t0);
      const previousState = { actuators: { fan: false }, valves: {} };
      const { payload: out } = relay.assembleState({ temps: {}, flags: {} }, { previousState, now: t0 + 10 });
      assert.strictEqual(out.actuators.fan, true);
    });
  });

  describe('byte-compatible assembled payload', () => {
    it('assembled payload field order + shape matches the device buildSnapshotJson', () => {
      const now = 1717000000000;
      // Populate relays so valves/actuators carry real values.
      relay.ingestStatus('shellypro2pm-aabbccddee51/status/switch:0', { output: true }, now);
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:0', { output: true }, now);

      const min = {
        ts: now,
        mode: 'solar_charging',
        transitioning: false,
        transition_step: null,
        temps: { collector: 62.3, tank_top: 41, tank_bottom: 29, greenhouse: 12, outdoor: 8 },
        flags: { collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: false },
        opening: [],
        queued_opens: [],
        pending_closes: [],
        cause: 'automation',
        reason: 'solar_enter',
        eval_reason: 'solar_active',
        held: null,
      };
      const { payload: out } = relay.assembleState(min, { controlsEnabled: true, manualOverride: null, now });

      assert.deepStrictEqual(Object.keys(out), [
        'ts', 'mode', 'transitioning', 'transition_step', 'temps', 'valves', 'actuators',
        'flags', 'controls_enabled', 'manual_override', 'opening', 'queued_opens',
        'pending_closes', 'cause', 'reason', 'eval_reason', 'held',
      ]);
      // KEY_ORDER is the exported single source of truth for the field order.
      assert.deepStrictEqual(Object.keys(out), relay.KEY_ORDER);
      assert.deepStrictEqual(Object.keys(out.temps),
        ['collector', 'tank_top', 'tank_bottom', 'greenhouse', 'outdoor']);
      assert.strictEqual(out.controls_enabled, true);
      assert.strictEqual(out.valves.vi_btm, true);
      assert.strictEqual(out.actuators.pump, true);
      assert.strictEqual(out.cause, 'automation');
      assert.strictEqual(out.reason, 'solar_enter');
    });
  });

  describe('canonical exports (single source of truth)', () => {
    it('exports RELAY_MAP, VALVE_KEYS, ACTUATOR_KEYS, KEY_ORDER', () => {
      assert.ok(relay.RELAY_MAP && typeof relay.RELAY_MAP === 'object');
      assert.ok(Array.isArray(relay.VALVE_KEYS));
      assert.ok(Array.isArray(relay.ACTUATOR_KEYS));
      assert.ok(Array.isArray(relay.KEY_ORDER));
    });

    it('RELAY_MAP covers all 5 wired controllers and skips the spare', () => {
      assert.deepStrictEqual(Object.keys(relay.RELAY_MAP).sort(), [
        '192.168.30.50', '192.168.30.51', '192.168.30.52', '192.168.30.53', '192.168.30.54',
      ]);
      // .54 only has switch 0 (id 1 reserved); .55 spare not present.
      assert.deepStrictEqual(Object.keys(relay.RELAY_MAP['192.168.30.54']), ['0']);
    });

    it('RELAY_MAP valve entries match VALVE_KEYS exactly', () => {
      const valveNames = [];
      Object.keys(relay.RELAY_MAP).forEach((ip) => {
        const dm = relay.RELAY_MAP[ip];
        Object.keys(dm).forEach((id) => {
          if (dm[id].group === 'valves') valveNames.push(dm[id].name);
        });
      });
      assert.deepStrictEqual(valveNames.sort(), relay.VALVE_KEYS.slice().sort());
    });

    it('encodes the 4PM id↔key inversion in ONE place (id2=immersion, id3=space)', () => {
      assert.strictEqual(relay.ACTUATOR_4PM_BY_ID[2], 'immersion_heater');
      assert.strictEqual(relay.ACTUATOR_4PM_BY_ID[3], 'space_heater');
      // RELAY_MAP derives its 4PM names from ACTUATOR_4PM_BY_ID.
      assert.strictEqual(relay.RELAY_MAP[relay.ACTUATOR_4PM_IP][2].name, relay.ACTUATOR_4PM_BY_ID[2]);
      assert.strictEqual(relay.RELAY_MAP[relay.ACTUATOR_4PM_IP][3].name, relay.ACTUATOR_4PM_BY_ID[3]);
      // but the wire key order lists space BEFORE immersion.
      assert.ok(relay.ACTUATOR_KEYS.indexOf('space_heater') < relay.ACTUATOR_KEYS.indexOf('immersion_heater'));
    });
  });

  describe('freshness map (sidecar)', () => {
    it('classifies a freshly-ingested relay as fresh with a small ageMs', () => {
      const now = 1000000;
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:0', { output: true }, now);
      const { freshness } = relay.assembleState({ temps: {}, flags: {} }, { now: now + 500 });
      assert.strictEqual(freshness.pump.status, relay.FRESH);
      assert.strictEqual(freshness.pump.ageMs, 500);
    });

    it('classifies a cached-but-old relay as stale with its age', () => {
      const t0 = 1000000;
      relay.ingestStatus('shellypro4pm-aabbccddee50/status/switch:0', { output: true }, t0);
      const now = t0 + relay.RELAY_STALE_MS + 7;
      const { freshness } = relay.assembleState({ temps: {}, flags: {} }, { now });
      assert.strictEqual(freshness.pump.status, relay.STALE);
      assert.strictEqual(freshness.pump.ageMs, relay.RELAY_STALE_MS + 7);
    });

    it('classifies a never-seen relay as missing with null ageMs', () => {
      const { freshness } = relay.assembleState({ temps: {}, flags: {} }, { now: 1 });
      assert.strictEqual(freshness.v_air.status, relay.MISSING);
      assert.strictEqual(freshness.v_air.ageMs, null);
    });

    it('reports freshness for every valve and actuator', () => {
      const { freshness } = relay.assembleState({ temps: {}, flags: {} }, { now: 1 });
      relay.VALVE_KEYS.concat(relay.ACTUATOR_KEYS).forEach((name) => {
        assert.ok(freshness[name], 'missing freshness for ' + name);
        assert.ok(['fresh', 'stale', 'missing'].indexOf(freshness[name].status) >= 0);
      });
    });

    it('freshness is NOT folded into the byte-compatible payload', () => {
      const { payload } = relay.assembleState({ temps: {}, flags: {} }, { now: 1 });
      assert.strictEqual(typeof payload.freshness, 'undefined');
      assert.deepStrictEqual(Object.keys(payload), relay.KEY_ORDER);
    });
  });

  describe('checkTopicMapCoverage (#2a)', () => {
    it('reports ok when every RELAY_MAP IP is resolvable', () => {
      // TOPIC_MAP in this file maps prefixes for .50–.55. All .50–.54 IPs are
      // RELAY_MAP values, so coverage is complete.
      const cov = relay.checkTopicMapCoverage();
      assert.strictEqual(cov.ok, true);
      assert.deepStrictEqual(cov.missing, []);
    });

    it('reports the missing IPs when the map is incomplete', () => {
      process.env.RELAY_TOPIC_MAP = JSON.stringify({
        'shellypro4pm-aabbccddee50': '192.168.30.50',
        // .51–.54 deliberately omitted
      });
      relay.reset();
      const cov = relay.checkTopicMapCoverage();
      assert.strictEqual(cov.ok, false);
      assert.deepStrictEqual(cov.missing.sort(), [
        '192.168.30.51', '192.168.30.52', '192.168.30.53', '192.168.30.54',
      ]);
    });

    it('reports all IPs missing when the map is unset', () => {
      delete process.env.RELAY_TOPIC_MAP;
      relay.reset();
      const cov = relay.checkTopicMapCoverage();
      assert.strictEqual(cov.ok, false);
      assert.strictEqual(cov.missing.length, 5);
    });

    it('accepts topic_prefix==IP entries as coverage', () => {
      process.env.RELAY_TOPIC_MAP = JSON.stringify({
        '192.168.30.50': '192.168.30.50',
        '192.168.30.51': '192.168.30.51',
        '192.168.30.52': '192.168.30.52',
        '192.168.30.53': '192.168.30.53',
        '192.168.30.54': '192.168.30.54',
      });
      relay.reset();
      assert.strictEqual(relay.checkTopicMapCoverage().ok, true);
    });
  });
});
