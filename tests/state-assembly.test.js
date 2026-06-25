const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

// Byte-equivalence of the SERVER-ASSEMBLED greenhouse/state vs the historical
// full device payload. After Epic #254 the device emits only the decision
// state on greenhouse/state/min; the server reconstructs valves/actuators from
// native relay status + controls_enabled/manual_override from device config.
// The re-emitted greenhouse/state must be field-for-field identical to what
// the device used to publish, or every downstream consumer (WS clients,
// detectStateChanges, insertSensorReadings, anomaly ring buffer) drifts.
//
// Strategy (refined): do NOT hand-type the device-minimal payload. Instead
// drive the REAL device builder — buildMinPayload from shelly/control-logic.js,
// the exact function that ships and emits greenhouse/state/min — over a
// representative device-state object, then assemble the golden full payload by
// layering the server-owned fields (valves/actuators from the relay cache,
// controls_enabled/manual_override from device config) on top, in the shared
// exported KEY_ORDER. We then assert
//   JSON.stringify(assembleState(min, …).payload) === JSON.stringify(golden).
// Because both `min` and the golden flow from the real builder + the module's
// own KEY_ORDER / VALVE_KEYS / ACTUATOR_KEYS, a drift in either the device
// field set/order or the assembler key order fails this test instead of being
// masked by a hand-copied literal.

const { buildMinPayload } = require('../shelly/control-logic.js');

const TOPIC_MAP = {
  'p4pm': '192.168.30.50',
  'p51': '192.168.30.51',
  'p52': '192.168.30.52',
  'p53': '192.168.30.53',
  'p54': '192.168.30.54',
};

// (group,name) → status topic, mirroring relay-status RELAY_MAP.
const RELAY_TOPICS = {
  'actuators.pump': 'p4pm/status/switch:0',
  'actuators.fan': 'p4pm/status/switch:1',
  // NOTE the id↔key inversion: id 2 is the immersion heater, id 3 the space
  // heater (the historical wire key order still lists space BEFORE immersion).
  'actuators.immersion_heater': 'p4pm/status/switch:2',
  'actuators.space_heater': 'p4pm/status/switch:3',
  'valves.vi_btm': 'p51/status/switch:0',
  'valves.vi_top': 'p51/status/switch:1',
  'valves.vi_coll': 'p52/status/switch:0',
  'valves.vo_coll': 'p52/status/switch:1',
  'valves.vo_rad': 'p53/status/switch:0',
  'valves.vo_tank': 'p53/status/switch:1',
  'valves.v_air': 'p54/status/switch:0',
};

const NOW = 1717000000000;

// A representative device-state object as buildMinPayload consumes it. Only the
// fields buildMinPayload reads matter; everything is overridable per-scenario.
function deviceState(overrides) {
  const base = {
    mode: 'IDLE',
    transitioning: false,
    transition_step: null,
    temps: { collector: 14.2, tank_top: 22.1, tank_bottom: 19.8, greenhouse: 11.0, outdoor: 6.4 },
    collectors_drained: true,
    emergency_heating_active: false,
    greenhouse_fan_cooling_active: false,
    valveOpening: {},
    valveOpenSince: {},
    valvePendingOpen: [],
    valvePendingClose: [],
    lastTransitionCause: 'drain_complete',
    lastTransitionReason: null,
    last_eval_reason: 'idle',
    last_held: null,
  };
  return Object.assign(base, overrides);
}

const DC = { ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, tu: {}, mo: null, v: 1 };

describe('greenhouse/state assembly byte-equivalence', () => {
  let relay;
  let prevEnv;
  // Shared key-order constants — imported, never re-typed, so a reorder in the
  // assembler is caught here too.
  let KEY_ORDER;
  let VALVE_KEYS;
  let ACTUATOR_KEYS;

  beforeEach(() => {
    prevEnv = process.env.RELAY_TOPIC_MAP;
    process.env.RELAY_TOPIC_MAP = JSON.stringify(TOPIC_MAP);
    delete require.cache[require.resolve('../server/lib/relay-status.js')];
    relay = require('../server/lib/relay-status.js');
    relay.reset();
    KEY_ORDER = relay.KEY_ORDER;
    VALVE_KEYS = relay.VALVE_KEYS;
    ACTUATOR_KEYS = relay.ACTUATOR_KEYS;
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.RELAY_TOPIC_MAP;
    else process.env.RELAY_TOPIC_MAP = prevEnv;
  });

  // Build the full GOLDEN payload from the REAL device-minimal payload plus the
  // server-owned fields, in the module's exported KEY_ORDER. valves/actuators
  // are laid out in VALVE_KEYS / ACTUATOR_KEYS order.
  function goldenFor(min, valves, actuators, controlsEnabled, manualOverride) {
    const orderedValves = {};
    VALVE_KEYS.forEach((k) => { orderedValves[k] = !!valves[k]; });
    const orderedActuators = {};
    ACTUATOR_KEYS.forEach((k) => { orderedActuators[k] = !!actuators[k]; });

    const source = Object.assign({}, min, {
      valves: orderedValves,
      actuators: orderedActuators,
      controls_enabled: !!controlsEnabled,
      manual_override: typeof manualOverride === 'undefined' ? null : manualOverride,
    });
    const out = {};
    KEY_ORDER.forEach((k) => { out[k] = source[k]; });
    return out;
  }

  // Push a scenario's valve/actuator booleans into the relay cache (all fresh).
  function primeCache(valves, actuators) {
    Object.keys(valves).forEach((name) => {
      relay.ingestStatus(RELAY_TOPICS['valves.' + name], { output: valves[name] }, NOW);
    });
    Object.keys(actuators).forEach((name) => {
      relay.ingestStatus(RELAY_TOPICS['actuators.' + name], { output: actuators[name] }, NOW);
    });
  }

  // Representative scenarios. Each carries the device-state the REAL builder
  // serializes plus the relay/config the server layers on.
  const scenarios = {
    idle: {
      st: deviceState({}),
      valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
      actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
      controlsEnabled: true, manualOverride: null,
    },
    solar_charging: {
      st: deviceState({
        mode: 'SOLAR_CHARGING',
        temps: { collector: 62.3, tank_top: 41.0, tank_bottom: 29.0, greenhouse: 12.0, outdoor: 8.0 },
        collectors_drained: false,
        lastTransitionCause: 'automation', lastTransitionReason: 'solar_enter', last_eval_reason: 'solar_active',
      }),
      valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: true, v_air: false },
      actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
      controlsEnabled: true, manualOverride: null,
    },
    mid_transition: {
      st: deviceState({
        mode: 'GREENHOUSE_HEATING',
        transitioning: true, transition_step: 'opening_valves',
        temps: { collector: 30.0, tank_top: 55.0, tank_bottom: 48.0, greenhouse: 9.0, outdoor: 2.0 },
        collectors_drained: false,
        // Exercise the opening / queued_opens / pending_closes builder paths.
        valveOpening: { vo_rad: NOW + 5000 },
        valveOpenSince: { vi_btm: 1716999000000 },
        valvePendingOpen: ['vi_top'],
        valvePendingClose: ['vi_btm'],
        lastTransitionCause: 'automation', lastTransitionReason: 'greenhouse_enter', last_eval_reason: 'greenhouse_cold',
      }),
      valves: { vi_btm: false, vi_top: true, vi_coll: false, vo_coll: false, vo_rad: true, vo_tank: false, v_air: false },
      actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
      controlsEnabled: true, manualOverride: null,
    },
    manual_override: {
      st: deviceState({
        mode: 'SOLAR_CHARGING',
        temps: { collector: 70.0, tank_top: 60.0, tank_bottom: 50.0, greenhouse: 15.0, outdoor: 10.0 },
        collectors_drained: false,
        lastTransitionCause: 'forced', lastTransitionReason: null, last_eval_reason: null,
      }),
      valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: true, v_air: false },
      actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
      controlsEnabled: true,
      manualOverride: { active: true, expiresAt: 1717003600, forcedMode: 'SC' },
    },
    fan_cool_overlay: {
      st: deviceState({
        mode: 'IDLE',
        temps: { collector: 20.0, tank_top: 30.0, tank_bottom: 25.0, greenhouse: 35.0, outdoor: 28.0 },
        greenhouse_fan_cooling_active: true,
        lastTransitionCause: 'automation', lastTransitionReason: null, last_eval_reason: 'fan_cooling',
      }),
      valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
      actuators: { pump: false, fan: true, space_heater: false, immersion_heater: false },
      controlsEnabled: true, manualOverride: null,
    },
    emergency_heat: {
      st: deviceState({
        mode: 'GREENHOUSE_HEATING',
        temps: { collector: 5.0, tank_top: 18.0, tank_bottom: 16.0, greenhouse: 2.0, outdoor: -8.0 },
        emergency_heating_active: true,
        lastTransitionCause: 'safety_override', lastTransitionReason: 'emergency_heat', last_eval_reason: 'greenhouse_freezing',
      }),
      valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
      // id2=immersion / id3=space — assert both heaters render the right keys.
      actuators: { pump: false, fan: false, space_heater: true, immersion_heater: true },
      controlsEnabled: true, manualOverride: null,
    },
  };

  Object.keys(scenarios).forEach(function (name) {
    it('assembled greenhouse/state is byte-identical to golden — ' + name, () => {
      const sc = scenarios[name];
      // The REAL device builder produces the minimal payload.
      const min = JSON.parse(buildMinPayload(sc.st, DC, NOW));
      primeCache(sc.valves, sc.actuators);
      const golden = goldenFor(min, sc.valves, sc.actuators, sc.controlsEnabled, sc.manualOverride);

      const out = relay.assembleState(min, {
        controlsEnabled: sc.controlsEnabled,
        manualOverride: sc.manualOverride,
        now: NOW,
      });
      // assembleState now returns { payload, freshness }; greenhouse/state is
      // the payload.
      assert.strictEqual(JSON.stringify(out.payload), JSON.stringify(golden),
        'assembled payload must serialize byte-identically to the real-builder-derived golden');
      // Key order is exactly KEY_ORDER (no hand-copied literal).
      assert.deepStrictEqual(Object.keys(out.payload), KEY_ORDER);
    });
  });

  it('greenhouse/state stays byte-identical regardless of relay freshness (sidecar is separate)', () => {
    const sc = scenarios.solar_charging;
    const min = JSON.parse(buildMinPayload(sc.st, DC, NOW));

    // 1) All relays fresh.
    primeCache(sc.valves, sc.actuators);
    const fresh = relay.assembleState(min, {
      controlsEnabled: sc.controlsEnabled, manualOverride: sc.manualOverride, now: NOW,
    });
    assert.ok(Object.values(fresh.freshness).every((f) => f.status === relay.FRESH),
      'precondition: every relay fresh');

    // 2) Same cache, but assemble far in the future so every relay is STALE and
    // served from previousState (which carries the identical booleans). The
    // greenhouse/state payload must be byte-identical — freshness never leaks
    // into it; only the sidecar `freshness` map changes.
    const previousState = { valves: fresh.payload.valves, actuators: fresh.payload.actuators };
    const stale = relay.assembleState(min, {
      controlsEnabled: sc.controlsEnabled, manualOverride: sc.manualOverride,
      previousState, now: NOW + relay.RELAY_STALE_MS + 5000,
    });

    assert.strictEqual(JSON.stringify(stale.payload), JSON.stringify(fresh.payload),
      'greenhouse/state payload is identical whether relays are fresh or stale');
    assert.ok(Object.values(stale.freshness).every((f) => f.status === relay.STALE),
      'the sidecar freshness map DOES change (all stale now)');
    // And freshness is never folded into the payload.
    assert.strictEqual(typeof stale.payload.freshness, 'undefined');
  });

  describe('fallback paths still yield a complete (non-half-assembled) payload', () => {
    it('stale relay → previousState value preserved, full key set intact', () => {
      const sc = scenarios.solar_charging;
      const min = JSON.parse(buildMinPayload(sc.st, DC, NOW));
      // Prime pump fresh, then assemble far in the future so it goes stale and
      // falls back to previousState.
      relay.ingestStatus('p4pm/status/switch:0', { output: true }, NOW);
      const previousState = {
        valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: true, v_air: false },
        actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
      };
      const out = relay.assembleState(min, {
        controlsEnabled: true, manualOverride: null,
        previousState,
        now: NOW + relay.RELAY_STALE_MS + 5000,
      });
      // All 17 top-level keys present — never a partial payload.
      assert.deepStrictEqual(Object.keys(out.payload), KEY_ORDER);
      assert.strictEqual(out.payload.actuators.pump, true, 'stale → previousState.pump');
      assert.strictEqual(out.payload.valves.vi_btm, true, 'stale valve → previousState.vi_btm');
      assert.strictEqual(out.freshness.pump.status, relay.STALE);
      assert.strictEqual(out.freshness.vi_btm.status, relay.MISSING, 'never-seen valve is missing');
    });

    it('never-seen relay + no previousState → false everywhere, payload still complete', () => {
      const min = JSON.parse(buildMinPayload(deviceState({}), DC, NOW));
      const out = relay.assembleState(min, {
        controlsEnabled: false, manualOverride: null, now: NOW,
      });
      assert.deepStrictEqual(Object.keys(out.payload), KEY_ORDER);
      Object.keys(out.payload.valves).forEach(function (k) { assert.strictEqual(out.payload.valves[k], false); });
      Object.keys(out.payload.actuators).forEach(function (k) { assert.strictEqual(out.payload.actuators[k], false); });
      assert.ok(Object.values(out.freshness).every((f) => f.status === relay.MISSING),
        'no cache, no previousState → every relay missing');
    });
  });
});
