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
// Strategy: hand-build a GOLDEN full payload per scenario (literal, in the
// historical key order), derive (a) the device-minimal subset and (b) the
// relay cache that would have produced it, then assert
// JSON.stringify(assembleState(min, …)) === JSON.stringify(golden).

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

// Build a full golden payload in the EXACT historical key order.
function golden(o) {
  return {
    ts: o.ts,
    mode: o.mode,
    transitioning: o.transitioning,
    transition_step: o.transition_step,
    temps: o.temps,
    valves: o.valves,
    actuators: o.actuators,
    flags: o.flags,
    controls_enabled: o.controls_enabled,
    manual_override: o.manual_override,
    opening: o.opening,
    queued_opens: o.queued_opens,
    pending_closes: o.pending_closes,
    cause: o.cause,
    reason: o.reason,
    eval_reason: o.eval_reason,
    held: o.held,
  };
}

describe('greenhouse/state assembly byte-equivalence', () => {
  let relay;
  let prevEnv;
  const NOW = 1717000000000;

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

  // Push a golden's valves/actuators into the relay cache (all fresh @ NOW).
  function primeCacheFromGolden(g) {
    const groups = { valves: g.valves, actuators: g.actuators };
    Object.keys(groups).forEach(function (group) {
      Object.keys(groups[group]).forEach(function (name) {
        const topic = RELAY_TOPICS[group + '.' + name];
        relay.ingestStatus(topic, { output: groups[group][name] }, NOW);
      });
    });
  }

  // Derive the device-minimal payload from a golden (drop the 4 server-owned
  // fields).
  function minFromGolden(g) {
    return {
      ts: g.ts, mode: g.mode, transitioning: g.transitioning,
      transition_step: g.transition_step, temps: g.temps, flags: g.flags,
      opening: g.opening, queued_opens: g.queued_opens,
      pending_closes: g.pending_closes, cause: g.cause, reason: g.reason,
      eval_reason: g.eval_reason, held: g.held,
    };
  }

  function roundTrip(g) {
    primeCacheFromGolden(g);
    const out = relay.assembleState(minFromGolden(g), {
      controlsEnabled: g.controls_enabled,
      manualOverride: g.manual_override,
      now: NOW,
    });
    return out;
  }

  const idle = golden({
    ts: NOW, mode: 'idle', transitioning: false, transition_step: null,
    temps: { collector: 14.2, tank_top: 22.1, tank_bottom: 19.8, greenhouse: 11.0, outdoor: 6.4 },
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
    flags: { collectors_drained: true, emergency_heating_active: false, greenhouse_fan_cooling_active: false },
    controls_enabled: true, manual_override: null,
    opening: [], queued_opens: [], pending_closes: [],
    cause: 'drain_complete', reason: null, eval_reason: 'idle', held: null,
  });

  const solarCharging = golden({
    ts: NOW, mode: 'solar_charging', transitioning: false, transition_step: null,
    temps: { collector: 62.3, tank_top: 41.0, tank_bottom: 29.0, greenhouse: 12.0, outdoor: 8.0 },
    valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: true, v_air: false },
    actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
    flags: { collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: false },
    controls_enabled: true, manual_override: null,
    opening: [], queued_opens: [], pending_closes: [],
    cause: 'automation', reason: 'solar_enter', eval_reason: 'solar_active', held: null,
  });

  const midTransition = golden({
    ts: NOW, mode: 'greenhouse_heating', transitioning: true, transition_step: 'opening_valves',
    temps: { collector: 30.0, tank_top: 55.0, tank_bottom: 48.0, greenhouse: 9.0, outdoor: 2.0 },
    valves: { vi_btm: false, vi_top: true, vi_coll: false, vo_coll: false, vo_rad: true, vo_tank: false, v_air: false },
    actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
    flags: { collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: false },
    controls_enabled: true, manual_override: null,
    opening: ['vo_rad'], queued_opens: ['vi_top'],
    pending_closes: [{ valve: 'vi_btm', readyAt: 1717000020 }],
    cause: 'automation', reason: 'greenhouse_enter', eval_reason: 'greenhouse_cold', held: null,
  });

  const manualOverride = golden({
    ts: NOW, mode: 'solar_charging', transitioning: false, transition_step: null,
    temps: { collector: 70.0, tank_top: 60.0, tank_bottom: 50.0, greenhouse: 15.0, outdoor: 10.0 },
    valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: true, v_air: false },
    actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
    flags: { collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: false },
    controls_enabled: true,
    manual_override: { active: true, expiresAt: 1717003600, forcedMode: 'SC' },
    opening: [], queued_opens: [], pending_closes: [],
    cause: 'forced', reason: null, eval_reason: null, held: null,
  });

  const fanCoolOverlay = golden({
    ts: NOW, mode: 'idle', transitioning: false, transition_step: null,
    temps: { collector: 20.0, tank_top: 30.0, tank_bottom: 25.0, greenhouse: 35.0, outdoor: 28.0 },
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    actuators: { pump: false, fan: true, space_heater: false, immersion_heater: false },
    flags: { collectors_drained: true, emergency_heating_active: false, greenhouse_fan_cooling_active: true },
    controls_enabled: true, manual_override: null,
    opening: [], queued_opens: [], pending_closes: [],
    cause: 'automation', reason: null, eval_reason: 'fan_cooling', held: null,
  });

  const emergencyHeat = golden({
    ts: NOW, mode: 'greenhouse_heating', transitioning: false, transition_step: null,
    temps: { collector: 5.0, tank_top: 18.0, tank_bottom: 16.0, greenhouse: 2.0, outdoor: -8.0 },
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    actuators: { pump: false, fan: false, space_heater: true, immersion_heater: true },
    flags: { collectors_drained: true, emergency_heating_active: true, greenhouse_fan_cooling_active: false },
    controls_enabled: true, manual_override: null,
    opening: [], queued_opens: [], pending_closes: [],
    cause: 'safety_override', reason: 'emergency_heat', eval_reason: 'greenhouse_freezing', held: null,
  });

  const scenarios = {
    idle, solar_charging: solarCharging, mid_transition: midTransition,
    manual_override: manualOverride, fan_cool_overlay: fanCoolOverlay,
    emergency_heat: emergencyHeat,
  };

  Object.keys(scenarios).forEach(function (name) {
    it('assembled greenhouse/state is byte-identical to golden — ' + name, () => {
      const g = scenarios[name];
      const out = roundTrip(g);
      assert.strictEqual(JSON.stringify(out), JSON.stringify(g),
        'assembled payload must serialize byte-identically to the historical full payload');
    });
  });

  describe('fallback paths still yield a complete (non-half-assembled) payload', () => {
    it('stale relay → previousState value preserved, full key set intact', () => {
      // Prime pump fresh, then assemble far in the future so it goes stale and
      // falls back to previousState.
      relay.ingestStatus('p4pm/status/switch:0', { output: true }, NOW);
      const previousState = {
        valves: solarCharging.valves,
        actuators: { pump: true, fan: false, space_heater: false, immersion_heater: false },
      };
      const out = relay.assembleState(minFromGolden(solarCharging), {
        controlsEnabled: true, manualOverride: null,
        previousState,
        now: NOW + relay.RELAY_STALE_MS + 5000,
      });
      // All 17 top-level keys present — never a partial payload.
      assert.deepStrictEqual(Object.keys(out), Object.keys(solarCharging));
      assert.strictEqual(out.actuators.pump, true, 'stale → previousState.pump');
      assert.strictEqual(out.valves.vi_btm, true, 'stale valve → previousState.vi_btm');
    });

    it('never-seen relay + no previousState → false everywhere, payload still complete', () => {
      const out = relay.assembleState(minFromGolden(idle), {
        controlsEnabled: false, manualOverride: null, now: NOW,
      });
      assert.deepStrictEqual(Object.keys(out), Object.keys(idle));
      Object.keys(out.valves).forEach(function (k) { assert.strictEqual(out.valves[k], false); });
      Object.keys(out.actuators).forEach(function (k) { assert.strictEqual(out.actuators[k], false); });
    });
  });
});
