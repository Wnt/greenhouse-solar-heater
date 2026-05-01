const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluate, MODES, DEFAULT_CONFIG, MODE_VALVES } = require('../shelly/control-logic.js');

function makeState(overrides) {
  const base = {
    temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    currentMode: MODES.IDLE,
    modeEnteredAt: 0,
    now: 2000,
    collectorsDrained: false,
    lastRefillAttempt: 0,
    emergencyHeatingActive: false,
    greenhouseFanCoolingActive: false,
    sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
  };
  return Object.assign({}, base, overrides);
}

describe('mode evaluation', () => {
  it('returns IDLE when no triggers are active', () => {
    const result = evaluate(makeState({}), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('enters SOLAR_CHARGING when collector > tank_bottom + solarEnterDelta', () => {
    // DEFAULT_CONFIG.solarEnterDelta = 3 K. collector 36 vs tank_bottom
    // 30 gives a 6 K delta — well above the entry bar.
    const result = evaluate(makeState({
      temps: { collector: 36, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.reason, 'solar_enter');
  });

  it('enters GREENHOUSE_HEATING when greenhouse < 10 and tank has delta > 5', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('enters ACTIVE_DRAIN when outdoor < freezeDrainTemp and collectors not drained', () => {
    // DEFAULT_CONFIG.freezeDrainTemp = 4 °C. outdoor 3 is below threshold.
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 3 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  // Radiative-cooling correction: on clear nights the sky-facing
  // collector runs several K below sheltered ambient. Freeze protection
  // must trip off the colder of the two sensors.
  it('enters ACTIVE_DRAIN when collector < freezeDrainTemp even though outdoor is well above', () => {
    const result = evaluate(makeState({
      temps: { collector: 1, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 8 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('stays IDLE when both outdoor and collector are above the freeze threshold', () => {
    // both >= 5 °C with freezeDrainTemp=4 → no drain
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 6 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('does NOT refill when collector has radiatively cooled below threshold (outdoor warm)', () => {
    // Drained collectors + warm outdoor + solar delta would normally
    // trigger a speculative refill. The new rule requires the collector
    // ALSO to be above the freeze threshold before refilling — otherwise
    // the refill would re-expose a near-freezing surface to water that
    // has to be drained again immediately.
    const result = evaluate(makeState({
      temps: { collector: 1, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 8 },
      collectorsDrained: true,
      lastRefillAttempt: 0,
      now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.collectorsDrained, true);
  });

  it('enters EMERGENCY_HEATING when greenhouse < 9 and tank lacks delta', () => {
    // tank_top 12°C is only 4°C above greenhouse 8°C (< 5°C delta)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('selects highest priority mode when multiple triggers active', () => {
    // Both freeze drain and emergency could trigger — drain wins
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 20, tank_bottom: 15, greenhouse: 8, outdoor: 1 },
      collectorsDrained: false
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});

describe('DEFAULT_CONFIG thresholds', () => {
  // Lock in the three values tuned from the 2026-04-22 diurnal sim
  // sweep. Changing a default is a user-visible behavior change —
  // these tests force a deliberate test edit alongside the config bump.
  it('solarEnterDelta default is 3 K', () => {
    assert.strictEqual(DEFAULT_CONFIG.solarEnterDelta, 3);
  });
  it('solarExitStallSeconds default is 300 s', () => {
    assert.strictEqual(DEFAULT_CONFIG.solarExitStallSeconds, 300);
  });
  it('freezeDrainTemp default is 4 °C', () => {
    assert.strictEqual(DEFAULT_CONFIG.freezeDrainTemp, 4);
  });

  // Boundary checks against the default config (no overrides) — these
  // verify the evaluator actually reads the new numbers, not just that
  // DEFAULT_CONFIG holds them.
  it('solar_enter fires at 3.1 K delta but not at 3.0 K', () => {
    const at = evaluate(makeState({
      temps: { collector: 33.1, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(at.nextMode, MODES.SOLAR_CHARGING);
    const below = evaluate(makeState({
      temps: { collector: 33, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(below.nextMode, MODES.IDLE);
  });

  it('solar_stall fires at 300 s elapsed but not at 299 s', () => {
    // Tank mean = (44 + 36) / 2 = 40, matches carried peak. No drop.
    // Collector at 45 keeps collector-tank_top delta (45-44=1) below the
    // solarStallBypassDelta of 10, so stall is not bypassed.
    const at = evaluate(makeState({
      temps: { collector: 45, tank_top: 44, tank_bottom: 36, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1700  // 300s ago
    }), null);
    assert.strictEqual(at.nextMode, MODES.IDLE);
    assert.strictEqual(at.reason, 'solar_stall');

    const below = evaluate(makeState({
      temps: { collector: 45, tank_top: 44, tank_bottom: 36, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1701  // 299s ago
    }), null);
    assert.strictEqual(below.nextMode, MODES.SOLAR_CHARGING);
  });

  it('freeze_drain fires at outdoor=3.9 °C but not at 4.0 °C', () => {
    const at = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 3.9 }
    }), null);
    assert.strictEqual(at.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(at.reason, 'freeze_drain');

    const below = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 4 }
    }), null);
    assert.strictEqual(below.nextMode, MODES.IDLE);
  });
});

describe('hysteresis', () => {
  it('enters solar charging at collector > tank_bottom + solarEnterDelta', () => {
    const result = evaluate(makeState({
      temps: { collector: 36, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.reason, 'solar_enter');
  });

  it('does not enter solar at collector = tank_bottom + solarEnterDelta (needs strictly greater)', () => {
    // delta exactly at threshold (3 K): 33 - 30 = 3. Must not enter.
    const result = evaluate(makeState({
      temps: { collector: 33, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('stays in solar even when collector falls below tank_bottom + 2 if tank still rising', () => {
    // Exit criteria: stay in solar until mean tank temp stops rising for
    // solarExitStallSeconds (300 s default) or drops 2°C from peak — NOT
    // based on collector/tank_bottom delta. Here the collector is barely
    // warmer than tank_bottom but the tank mean just rose (42+40)/2 = 41
    // vs. peak of 40, so peak updates to 41@now and we keep harvesting.
    const result = evaluate(makeState({
      temps: { collector: 31, tank_top: 42, tank_bottom: 40, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1500
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('exits solar when mean tank has not risen for solarExitStallSeconds', () => {
    // Peak was set 500 s ago (> 300 s stall threshold) and mean tank
    // temp has not exceeded it since. Collector only 5 K above tank_top
    // so the much-hotter-collector bypass (solarStallBypassDelta=10)
    // does not suppress the stall.
    const result = evaluate(makeState({
      temps: { collector: 45, tank_top: 40, tank_bottom: 40, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1500  // 500s ago
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.reason, 'solar_stall');
  });

  it('stays in solar past stall when collector is still much hotter than tank_top', () => {
    // Same stall conditions as the previous test, but collector is 40 K
    // above tank_top — huge thermodynamic head still available, so the
    // bypass suppresses the stall exit. Mimics the 09:43 morning peak
    // in the 2026-04-23 log (coll=85, top=33, tank rising slowly).
    const result = evaluate(makeState({
      temps: { collector: 80, tank_top: 40, tank_bottom: 40, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1500  // 500s ago — would stall without bypass
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.reason, 'solar_active');
  });

  it('still exits on drop-from-peak even when the collector bypass is active', () => {
    // Collector blazing hot (bypass would fire) but tank mean dropped
    // 4 °C from peak — tank is actively cooling, drop-from-peak wins.
    const result = evaluate(makeState({
      temps: { collector: 80, tank_top: 36, tank_bottom: 36, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1900
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.reason, 'solar_drop_from_peak');
  });

  it('exits solar when mean tank dropped 2°C from session peak', () => {
    // Mean = (38+38)/2 = 38, peak was 40. Dropped 2 — exits via drop-
    // from-peak. Peak 100 s old (< 300 s stall) so stall is not the
    // trigger; drop-from-peak is.
    const result = evaluate(makeState({
      temps: { collector: 50, tank_top: 38, tank_bottom: 38, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1900  // 100s ago — stall not yet triggered
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.reason, 'solar_drop_from_peak');
  });

  it('stays in solar when mean tank has not stalled and has not dropped 2°C', () => {
    // Mean = (39+39.5)/2 = 39.25, peak was 40. Dropped 0.75°C — under
    // threshold; peak 100 s old (< 300 s stall). Keep harvesting.
    const result = evaluate(makeState({
      temps: { collector: 45, tank_top: 39, tank_bottom: 39.5, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1900  // 100s ago
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('records peak mean-tank on solar entry', () => {
    // Mean = (40+30)/2 = 35 at entry.
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.IDLE,
      now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.flags.solarChargePeakTankAvg, 35);
    assert.strictEqual(result.flags.solarChargePeakTankAvgAt, 2000);
  });

  it('updates peak mean-tank during a session as tank rises', () => {
    // Mean = (42+40)/2 = 41, carried peak was 40 — new peak 41 at now.
    const result = evaluate(makeState({
      temps: { collector: 50, tank_top: 42, tank_bottom: 40, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1500
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.flags.solarChargePeakTankAvg, 41);
    assert.strictEqual(result.flags.solarChargePeakTankAvgAt, 2000);
  });

  it('keeps peak unchanged if mean-tank did not rise', () => {
    // Mean = (39.5+40)/2 = 39.75, carried peak 40 — keeps peak. Dropped
    // 0.25 °C, below solarExitTankDrop of 2. Peak 100 s old (< 300 s stall).
    const result = evaluate(makeState({
      temps: { collector: 45, tank_top: 39.5, tank_bottom: 40, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1900
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.flags.solarChargePeakTankAvg, 40);
    assert.strictEqual(result.flags.solarChargePeakTankAvgAt, 1900);
  });

  it('clears peak tracking when leaving solar charging', () => {
    // Mean = 38, peak 40 — drop-from-peak exits.
    const result = evaluate(makeState({
      temps: { collector: 50, tank_top: 38, tank_bottom: 38, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 1900
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.solarChargePeakTankAvg, null);
    assert.strictEqual(result.flags.solarChargePeakTankAvgAt, 0);
  });

  it('enters greenhouse heating at greenhouse < 10 with hot tank', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('does not enter greenhouse heating when tank lacks sufficient delta over greenhouse', () => {
    // tank_top 13°C is only 4°C above greenhouse 9°C (< 5°C delta)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 13, tank_bottom: 10, greenhouse: 9, outdoor: 10 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('enters greenhouse heating when tank has sufficient delta even at low absolute temp', () => {
    // tank_top 20°C has 11°C delta over greenhouse 9°C (> 5°C entry delta)
    // No minimum tank temp — any tank with enough delta is useful
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 20, tank_bottom: 18, greenhouse: 9, outdoor: -20 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Should heat: tank 20°C has 11°C delta over greenhouse 9°C');
  });

  it('stays in greenhouse heating at exact exit threshold (greenhouse = 12)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 12, outdoor: 10 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
  });

  it('exits greenhouse heating when greenhouse > 12', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 13, outdoor: 10 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('does not enter greenhouse heating at exact threshold (greenhouse = 10)', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 10, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('enters emergency at greenhouse < 9 and tank lacks delta', () => {
    // tank_top 12°C is only 4°C above greenhouse 8°C (< 5°C delta)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
  });

  it('stays in emergency at exact exit threshold (greenhouse = 12)', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 12, outdoor: -5 },
      currentMode: MODES.EMERGENCY_HEATING,
      emergencyHeatingActive: true,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
  });

  it('exits emergency when greenhouse > 12', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 14, tank_bottom: 12, greenhouse: 13, outdoor: -5 },
      currentMode: MODES.EMERGENCY_HEATING,
      emergencyHeatingActive: true,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    // greenhouse > 12 exits emergency; tank 14°C is only 1°C above greenhouse 13°C
    // so it falls through to IDLE (not enough delta for greenhouse heating)
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.emergencyHeatingActive, false);
  });

  it('does not enter emergency at exact threshold (greenhouse = 9)', () => {
    // tank_top 12°C is only 3°C above greenhouse 9°C (< 5°C delta)
    // but greenhouse = 9 is not < 9 (exact threshold), so no emergency
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 9, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });
});

describe('minimum duration', () => {
  it('holds mode for minimum time even if exit conditions met', () => {
    // Tank dropped 2°C from peak — would normally trigger exit, but min hold blocks it
    const result = evaluate(makeState({
      temps: { collector: 18, tank_top: 38, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 900, now: 1000,  // only 100s elapsed, min is 300
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 950
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('allows exit after minimum duration', () => {
    // Tank dropped 2°C from peak — exit allowed since min duration elapsed
    const result = evaluate(makeState({
      temps: { collector: 18, tank_top: 38, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000,  // 1000s elapsed > 300 min
      solarChargePeakTankAvg: 40,
      solarChargePeakTankAvgAt: 800
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('ACTIVE_DRAIN preempts immediately regardless of minimum duration', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 990, now: 1000  // only 10s elapsed
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('uses longer minimum after speculative refill', () => {
    const result = evaluate(makeState({
      temps: { collector: 32, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 500, now: 800,  // 300s elapsed > minModeDuration(300)
      lastRefillAttempt: 500,  // but < minRunTimeAfterRefill(600)
      collectorsDrained: false
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });
});

describe('valve and actuator mapping', () => {
  it('IDLE: all valves closed, all actuators off', () => {
    const r = evaluate(makeState({}), null);
    assert.deepStrictEqual(r.valves, {
      vi_btm: false, vi_top: false, vi_coll: false,
      vo_coll: false, vo_rad: false, vo_tank: false,
      v_air: false
    });
    assert.deepStrictEqual(r.actuators, {
      pump: false, fan: false, space_heater: false, immersion_heater: false
    });
  });

  it('SOLAR_CHARGING: vi_btm + vo_coll open, v_air closed, pump on', () => {
    const r = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(r.valves.vi_btm, true);
    assert.strictEqual(r.valves.vo_coll, true);
    assert.strictEqual(r.valves.v_air, false);
    assert.strictEqual(r.valves.vi_top, false);
    assert.strictEqual(r.valves.vo_rad, false);
    assert.strictEqual(r.actuators.pump, true);
    assert.strictEqual(r.actuators.fan, false);
  });

  it('GREENHOUSE_HEATING: vi_top + vo_rad open, pump + fan on', () => {
    const r = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    }), null);
    assert.strictEqual(r.valves.vi_top, true);
    assert.strictEqual(r.valves.vo_rad, true);
    assert.strictEqual(r.valves.vi_btm, false);
    assert.strictEqual(r.valves.vo_coll, false);
    assert.strictEqual(r.actuators.pump, true);
    assert.strictEqual(r.actuators.fan, true);
  });

  it('ACTIVE_DRAIN: vi_coll + vo_tank + v_air open, pump on', () => {
    const r = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 }
    }), null);
    assert.strictEqual(r.valves.vi_coll, true);
    assert.strictEqual(r.valves.vo_tank, true);
    assert.strictEqual(r.valves.v_air, true);
    assert.strictEqual(r.valves.vi_btm, false);
    assert.strictEqual(r.actuators.pump, true);
  });

  it('EMERGENCY_HEATING: all valves closed, space_heater + immersion on', () => {
    // tank_top 12°C is only 4°C above greenhouse 8°C (< 5°C delta) → emergency
    const r = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.deepStrictEqual(r.valves, {
      vi_btm: false, vi_top: false, vi_coll: false,
      vo_coll: false, vo_rad: false, vo_tank: false,
      v_air: false
    });
    assert.strictEqual(r.actuators.space_heater, true);
    assert.strictEqual(r.actuators.immersion_heater, true);
    assert.strictEqual(r.actuators.pump, false);
  });

  it('one-input-one-output invariant: at most 1 input and 1 output valve open', () => {
    const inputs = ['vi_btm', 'vi_top', 'vi_coll'];
    const outputs = ['vo_coll', 'vo_rad', 'vo_tank'];
    const allModes = [MODES.IDLE, MODES.SOLAR_CHARGING, MODES.GREENHOUSE_HEATING,
                      MODES.ACTIVE_DRAIN, MODES.EMERGENCY_HEATING];
    for (const mode of allModes) {
      const v = MODE_VALVES[mode];
      const openInputs = inputs.filter(k => v[k]).length;
      const openOutputs = outputs.filter(k => v[k]).length;
      assert.ok(openInputs <= 1, mode + ' has ' + openInputs + ' input valves open');
      assert.ok(openOutputs <= 1, mode + ' has ' + openOutputs + ' output valves open');
    }
  });
});

describe('priority and preemption', () => {
  it('ACTIVE_DRAIN preempts SOLAR_CHARGING when outdoor drops', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('EMERGENCY replaces GREENHOUSE_HEATING when tank depletes below exit delta', () => {
    // tank_top 9°C is only 1°C above greenhouse 8°C (< 2°C exit delta)
    // Pump shuts off (would cool greenhouse), emergency takes over
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 9, tank_bottom: 8, greenhouse: 8, outdoor: -5 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 1000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
  });

  it('concurrent solar + greenhouse triggers: solar wins (free energy priority)', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('overheat triggers ACTIVE_DRAIN when collector > 95 during solar charging', () => {
    const result = evaluate(makeState({
      temps: { collector: 96, tank_top: 86, tank_bottom: 70, greenhouse: 25, outdoor: 30 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('hot collector forces solar charging to circulate and cool', () => {
    const result = evaluate(makeState({
      temps: { collector: 96, tank_top: 86, tank_bottom: 70, greenhouse: 25, outdoor: 30 },
      currentMode: MODES.IDLE,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });
});

describe('speculative refill', () => {
  it('attempts refill when drained + solar delta met + warm outdoor', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      collectorsDrained: true,
      lastRefillAttempt: 0,
      now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.flags.collectorsDrained, false);
    assert.strictEqual(result.flags.lastRefillAttempt, 2000);
  });

  it('does not refill when outdoor too cold', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
      collectorsDrained: true,
      lastRefillAttempt: 0,
      now: 2000
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('respects retry cooldown', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      collectorsDrained: true,
      lastRefillAttempt: 500, now: 1000  // only 500s, cooldown is 1800
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('allows refill after cooldown expires', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      collectorsDrained: true,
      lastRefillAttempt: 500, now: 2500  // 2000s > 1800 cooldown
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });
});

describe('sensor failure', () => {
  it('transitions to IDLE when any sensor is stale', () => {
    const result = evaluate(makeState({
      currentMode: MODES.SOLAR_CHARGING,
      sensorAge: { collector: 200, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('transitions to IDLE when all sensors stale', () => {
    const result = evaluate(makeState({
      currentMode: MODES.SOLAR_CHARGING,
      sensorAge: { collector: 200, tank_top: 200, tank_bottom: 200, greenhouse: 200, outdoor: 200 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('stays in mode when sensors are fresh', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 2000,
      sensorAge: { collector: 10, tank_top: 10, tank_bottom: 10, greenhouse: 10, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('handles null temperature values gracefully', () => {
    const result = evaluate(makeState({
      temps: { collector: null, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });
});

describe('independent emergency heating overlay', () => {
  it('activates space_heater during GREENHOUSE_HEATING when greenhouse < 9', () => {
    // Tank at 20°C, greenhouse at 8°C — tank has 12°C delta (useful for pump)
    // But greenhouse is critical → space heater overlay activates too
    const result = evaluate(makeState({
      temps: { collector: -25, tank_top: 20, tank_bottom: 18, greenhouse: 8, outdoor: -30 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Pump should run: tank 20°C has 12°C delta over greenhouse 8°C');
    assert.strictEqual(result.actuators.space_heater, true,
      'Space heater should overlay: greenhouse 8°C < 9°C');
    assert.strictEqual(result.actuators.pump, true,
      'Pump should also run: tank is useful');
    assert.strictEqual(result.flags.emergencyHeatingActive, true);
  });

  it('enters pure EMERGENCY_HEATING when tank lacks entry delta and greenhouse < 9', () => {
    // tank_top 12°C is only 4°C above greenhouse 8°C (< 5°C entry delta)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 8, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING,
      'Pure emergency: tank has no useful delta for pump');
    assert.strictEqual(result.actuators.space_heater, true);
    assert.strictEqual(result.actuators.pump, false);
  });

  it('keeps space_heater on via hysteresis until greenhouse > 12', () => {
    // Emergency was active, greenhouse warmed to 11°C — still below exit (12)
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 30, tank_bottom: 28, greenhouse: 11, outdoor: -5 },
      emergencyHeatingActive: true,
      collectorsDrained: true
    }), null);
    // greenhouse 11 > 10 → no greenhouse heating entry, but emergency stays active
    assert.strictEqual(result.flags.emergencyHeatingActive, true,
      'Emergency stays active: greenhouse 11°C <= 12°C exit threshold');
  });

  it('turns off space_heater when greenhouse > 12 (emergency exit)', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 30, tank_bottom: 28, greenhouse: 13, outdoor: -5 },
      emergencyHeatingActive: true,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.flags.emergencyHeatingActive, false,
      'Emergency deactivates: greenhouse 13°C > 12°C');
    assert.strictEqual(result.actuators.space_heater, false);
  });

  it('enters GREENHOUSE_HEATING with any tank that has entry delta', () => {
    // Tank at 15°C, greenhouse at 9°C — 6°C delta > 5 entry threshold
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 15, tank_bottom: 13, greenhouse: 9, outdoor: -10 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Should heat: tank 15°C has 6°C delta over greenhouse 9°C');
    assert.strictEqual(result.actuators.space_heater, false,
      'No space heater: greenhouse 9°C is not < 9°C threshold');
  });

  it('exits GREENHOUSE_HEATING when tank drops below exit delta (2°C)', () => {
    // Currently heating, tank cooled to only 1°C above greenhouse → would cool
    const result = evaluate(makeState({
      temps: { collector: -20, tank_top: 9, tank_bottom: 8, greenhouse: 8, outdoor: -30 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING,
      'Should stop pump: tank 9°C is only 1°C above greenhouse 8°C (< 2°C)');
    assert.strictEqual(result.actuators.pump, false);
    assert.strictEqual(result.actuators.space_heater, true);
  });

  it('stays in GREENHOUSE_HEATING at exact exit tank delta (2°C)', () => {
    // tank_top = greenhouse + 2 → stays (>= threshold)
    const result = evaluate(makeState({
      temps: { collector: -20, tank_top: 10, tank_bottom: 8, greenhouse: 8, outdoor: -30 },
      currentMode: MODES.GREENHOUSE_HEATING,
      modeEnteredAt: 0, now: 2000,
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Should stay: tank 10°C is exactly 2°C above greenhouse 8°C');
  });

  it('simulates late-season overnight: tank depletes, emergency takes over', () => {
    // Phase 1: warm tank — greenhouse heating + emergency overlay
    const state = makeState({
      temps: { collector: -20, tank_top: 30, tank_bottom: 28, greenhouse: 8, outdoor: -30 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    });

    let result = evaluate(state, null);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Phase 1: tank 30°C has 22°C delta, pump runs');
    assert.strictEqual(result.actuators.space_heater, true,
      'Phase 1: space heater also on (greenhouse 8°C < 9°C)');
    assert.strictEqual(result.actuators.pump, true);

    // Phase 2: tank depletes near greenhouse — pump stops, pure emergency
    state.temps.tank_top = 9;
    state.temps.greenhouse = 8;
    state.currentMode = MODES.GREENHOUSE_HEATING;
    state.emergencyHeatingActive = result.flags.emergencyHeatingActive;
    result = evaluate(state, null);
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING,
      'Phase 2: tank 9°C only 1°C above greenhouse → pump off, pure emergency');
    assert.strictEqual(result.actuators.pump, false);
    assert.strictEqual(result.actuators.space_heater, true);

    // Phase 3: space heater warms greenhouse above exit
    state.temps.greenhouse = 13;
    state.currentMode = MODES.EMERGENCY_HEATING;
    state.emergencyHeatingActive = result.flags.emergencyHeatingActive;
    result = evaluate(state, null);
    assert.strictEqual(result.nextMode, MODES.IDLE,
      'Phase 3: greenhouse 13°C > 12°C → emergency off');
    assert.strictEqual(result.flags.emergencyHeatingActive, false);
  });

  it('does not activate emergency at exact threshold (greenhouse = 9)', () => {
    const result = evaluate(makeState({
      temps: { collector: 5, tank_top: 12, tank_bottom: 10, greenhouse: 9, outdoor: -5 },
      collectorsDrained: true
    }), null);
    assert.strictEqual(result.flags.emergencyHeatingActive, false,
      'greenhouse = 9 is not < 9, no emergency');
  });

  it('clears emergency flag on sensor staleness', () => {
    const result = evaluate(makeState({
      emergencyHeatingActive: true,
      sensorAge: { collector: 200, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 0 }
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.emergencyHeatingActive, false,
      'Emergency flag cleared on stale sensors');
  });
});

describe('edge cases', () => {
  it('overheat during active charging triggers drain when collector > 95', () => {
    const result = evaluate(makeState({
      temps: { collector: 96, tank_top: 86, tank_bottom: 70, greenhouse: 25, outdoor: 30 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('collector at 90 during solar charging does not drain (below 95 threshold)', () => {
    const result = evaluate(makeState({
      temps: { collector: 90, tank_top: 86, tank_bottom: 70, greenhouse: 25, outdoor: 30 },
      currentMode: MODES.SOLAR_CHARGING,
      modeEnteredAt: 0, now: 1000
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('boot during freeze: first eval triggers drain if not drained', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 5, tank_bottom: 5, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: false
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('boot during freeze: heats greenhouse if tank has delta', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 30, tank_bottom: 28, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    }), null);
    // tank_top 30°C has 33°C delta → pump useful, plus emergency overlay
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(result.actuators.space_heater, true,
      'Space heater also on: greenhouse -3°C < 9°C');
  });

  it('boot during freeze: uses tank even at low absolute temp if delta is enough', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 5, tank_bottom: 5, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    }), null);
    // tank_top 5°C has 8°C delta over greenhouse -3°C (> 5°C entry) → pump useful
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING,
      'Tank 5°C still useful: 8°C delta over greenhouse -3°C');
    assert.strictEqual(result.actuators.space_heater, true);
    assert.strictEqual(result.actuators.pump, true);
  });

  it('boot during freeze: emergency when tank has no useful delta', () => {
    const result = evaluate(makeState({
      temps: { collector: -3, tank_top: 1, tank_bottom: 1, greenhouse: -3, outdoor: -3 },
      currentMode: MODES.IDLE,
      collectorsDrained: true
    }), null);
    // tank_top 1°C is only 4°C above greenhouse -3°C (< 5°C delta) → pure emergency
    assert.strictEqual(result.nextMode, MODES.EMERGENCY_HEATING);
    assert.strictEqual(result.actuators.pump, false);
  });

  it('drain timeout sets collectorsDrained and returns IDLE', () => {
    const result = evaluate(makeState({
      currentMode: MODES.ACTIVE_DRAIN,
      modeEnteredAt: 0, now: 700  // 700s > drainTimeout 600s
    }), null);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.flags.collectorsDrained, true);
  });

  it('stays in ACTIVE_DRAIN before timeout', () => {
    const result = evaluate(makeState({
      currentMode: MODES.ACTIVE_DRAIN,
      modeEnteredAt: 0, now: 100  // 100s < 600s
    }), null);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });
});

// formatDuration / formatTemp / buildDisplayLabels moved to
// tests/control-logic-display.test.js (2026-04-23, file-size cap).

// ── Device config gated actuator tests ──

// Compact device config format: ce, ea (bitmask), am (mode codes), v
describe('config-gated actuator behavior', () => {
  // ea bitmask: valves=1, pump=2, fan=4, space_heater=8, immersion_heater=16
  const disabledConfig = { ce: false, ea: 0, v: 1 };
  const partialConfig = { ce: true, ea: 1 | 2, v: 2 }; // valves + pump only
  const allEnabled = { ce: true, ea: 31, v: 1 }; // all actuators

  it('returns suppressed flag when controls are disabled', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, disabledConfig);
    assert.strictEqual(result.suppressed, true);
  });

  it('still computes correct mode when controls disabled', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('respects per-actuator bitmask — disables fan when not in mask', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 },
    }), null, partialConfig);
    assert.strictEqual(result.nextMode, MODES.GREENHOUSE_HEATING);
    assert.strictEqual(result.actuators.pump, true);
    assert.strictEqual(result.actuators.fan, false);
  });

  it('keeps pump on when enabled in partial config', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, partialConfig);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.actuators.pump, true);
    assert.strictEqual(result.suppressed, false);
  });

  it('disables valves when valve bit is off', () => {
    const noValvesConfig = { ce: true, ea: 2 | 4 | 8 | 16, v: 3 }; // everything except valves
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, noValvesConfig);
    for (const key in result.valves) {
      assert.strictEqual(result.valves[key], false, key + ' should be closed');
    }
  });

  it('works without deviceConfig (backward compatible)', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.suppressed, false);
    assert.strictEqual(result.actuators.pump, true);
  });

  it('mode bans (wb) filter out banned modes', () => {
    // GH is permanently banned; greenhouse physics would otherwise fire
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 9, outdoor: 10 },
    }), null, { ...allEnabled, wb: { GH: 9999999999 } });
    assert.strictEqual(result.nextMode, MODES.IDLE);
  });

  it('mode bans (wb) permit unbanned modes', () => {
    // GH banned, but SC physics is firing — SC is not banned
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, { ...allEnabled, wb: { GH: 9999999999 } });
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
  });

  it('device config JSON fits within Shelly KVS 256-byte limit', () => {
    const worstCase = {
      ce: true, ea: 31,
      we: { sng: 1, scs: 1, ggr: 1 },
      wz: { sng: 1713050000, scs: 1713050000, ggr: 1713053400 },
      wb: { SC: 9999999999, GH: 1713094215, AD: 9999999999 },
      v: 9999,
    };
    const json = JSON.stringify(worstCase);
    assert.ok(json.length <= 256,
      'device config JSON is ' + json.length + ' bytes, must be <= 256. Content: ' + json);
  });
});

// ── Hard safety override tests (017-review-hardware-architecture) ──

describe('hard safety overrides bypass device config', () => {
  const disabledConfig = { ce: false, ea: 0, v: 1 };
  const allEnabled = { ce: true, ea: 31, v: 1 };

  it('freeze drain with ce=false returns ACTIVE_DRAIN, not suppressed, safetyOverride=true', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.suppressed, false);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('freeze drain with am=["SC"] (excluding AD) still returns ACTIVE_DRAIN', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, { ...allEnabled, am: ['SC'] });
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('overheat drain with ce=false returns ACTIVE_DRAIN, not suppressed, safetyOverride=true', () => {
    const result = evaluate(makeState({
      temps: { collector: 96, tank_top: 90, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING, modeEnteredAt: 0, now: 1000,
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.suppressed, false);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('overheat drain with am=["I"] (excluding AD) still returns ACTIVE_DRAIN', () => {
    const result = evaluate(makeState({
      temps: { collector: 96, tank_top: 90, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING, modeEnteredAt: 0, now: 1000,
    }), null, { ...allEnabled, am: ['I'] });
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.safetyOverride, true);
  });

  it('sensor staleness with ce=false returns IDLE, suppressed=true (safe state)', () => {
    const result = evaluate(makeState({
      sensorAge: { collector: 0, tank_top: 0, tank_bottom: 0, greenhouse: 0, outdoor: 200 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.IDLE);
    assert.strictEqual(result.suppressed, true);
  });

  it('normal solar charging with ce=false is still suppressed', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, disabledConfig);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.suppressed, true);
    assert.ok(!result.safetyOverride);
  });

  it('freeze drain with ce=true also sets safetyOverride=true', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, allEnabled);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
    assert.strictEqual(result.suppressed, false);
    assert.strictEqual(result.safetyOverride, true);
  });
});

// ── Manual override guard behavior (022-relay-toggle-ui) ──
// The override guard lives in control.js (I/O layer). These tests verify that
// evaluate() still produces correct safety signals that the guard relies on,
// and that device config with mo field doesn't break evaluate().

describe('manual override safety interaction', () => {
  // evaluate() is pure — it computes what *would* happen if automation
  // were allowed to run. The I/O layer (control.js controlLoop) is
  // what honors the hard-override rule and refuses to act on
  // evaluate()'s output while mo.a=true. These tests pin the pure-
  // side invariant: evaluate() itself never looks at mo for mode
  // selection; the hard-override gate is enforced one layer up.
  const overrideConfig = { ce: true, ea: 31, v: 1, mo: { a: true, ex: 9999999999, fm: 'I' } };

  it('evaluate() still returns safetyOverride=true during freeze even with mo set', () => {
    const result = evaluate(makeState({
      temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 1 },
    }), null, overrideConfig);
    assert.strictEqual(result.safetyOverride, true);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('evaluate() still returns safetyOverride=true during overheat even with mo set', () => {
    const result = evaluate(makeState({
      temps: { collector: 96, tank_top: 90, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
      currentMode: MODES.SOLAR_CHARGING, modeEnteredAt: 0, now: 1000,
    }), null, overrideConfig);
    assert.strictEqual(result.safetyOverride, true);
    assert.strictEqual(result.nextMode, MODES.ACTIVE_DRAIN);
  });

  it('evaluate() works normally with mo field in config (mo is I/O concern)', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, overrideConfig);
    assert.strictEqual(result.nextMode, MODES.SOLAR_CHARGING);
    assert.strictEqual(result.suppressed, false);
  });

  it('ce=false with mo set still returns suppressed (controls gate takes priority)', () => {
    const result = evaluate(makeState({
      temps: { collector: 41, tank_top: 40, tank_bottom: 30, greenhouse: 15, outdoor: 10 },
    }), null, { ce: false, ea: 0, v: 1, mo: { a: true, ex: 9999999999, fm: 'I' } });
    assert.strictEqual(result.suppressed, true);
  });
});

// planValveTransition scheduler helpers + tests moved to ./control-logic-valves.test.js
// greenhouse fan-cooling overlay tests moved to ./control-logic-fan-cooling.test.js


