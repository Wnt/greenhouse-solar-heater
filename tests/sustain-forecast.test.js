'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fitEmpiricalCoefficients,
  computeSustainForecast,
  _TANK_THERMAL_MASS_J_PER_K,
} = require('../server/lib/forecast/sustain-forecast.js');
const { fitSolarGainByHour, fitGreenhouseLossWPerK } = require('../server/lib/forecast/sustain-forecast-fit.js');

// ── Helpers ──

function makeWeather48h(overrides) {
  // 48 hours of cold, dark weather by default.
  return Array.from({ length: 48 }, (_, i) => ({
    ts: new Date(Date.now() + i * 3600 * 1000).toISOString(),
    temperature:     overrides && overrides.temperature     !== undefined ? overrides.temperature     : 0,
    radiationGlobal: overrides && overrides.radiationGlobal !== undefined ? overrides.radiationGlobal : 0,
    windSpeed:       overrides && overrides.windSpeed       !== undefined ? overrides.windSpeed       : 0,
  }));
}

function makePrices48h(priceCKwh) {
  const price = typeof priceCKwh === 'number' ? priceCKwh : 10;
  return Array.from({ length: 48 }, (_, i) => ({
    ts:        new Date(Date.now() + i * 3600 * 1000).toISOString(),
    priceCKwh: price,
  }));
}

// ── 1. fitEmpiricalCoefficients with empty history ──
describe('fitEmpiricalCoefficients', () => {
  it('returns defaults for empty history', () => {
    const result = fitEmpiricalCoefficients({});
    assert.equal(result.tankLeakageWPerK, 3.0);
    assert.equal(result.usedDefaults,     true);
    assert.ok(Array.isArray(result.solarGainKwhByHour));
  });

  it('returns defaults for null history', () => {
    const result = fitEmpiricalCoefficients(null);
    assert.equal(result.tankLeakageWPerK, 3.0);
    assert.equal(result.usedDefaults,     true);
  });

  it('returns defaults for single-reading history', () => {
    const result = fitEmpiricalCoefficients({
      readings: [{ ts: new Date(), tankTop: 30, tankBottom: 25, greenhouse: 12, outdoor: 0 }],
      modes:    [],
    });
    assert.equal(result.usedDefaults, true);
  });

  // ── 2. Fit with synthetic idle cooldown ──
  it('fits tankLeakageWPerK from synthetic idle cooldown data', () => {
    // Synthetic scenario: tank drops 1 °C/h with a constant 30 K delta
    // between tank average and greenhouse.
    // Expected: powerW = 1/3600 * TANK_THERMAL_MASS_J_PER_K ≈ 349.4 W
    // slope = powerW / deltaK = 349.4 / 30 ≈ 11.65 W/K
    const SECONDS_PER_HOUR = 3600;
    // Scenario: tank drops 1 °C/h, greenhouse tracks tank exactly 30 K below
    // so the deltaK is constant at 30 K throughout.
    // This ensures every consecutive pair contributes the same (x, y) sample,
    // so the least-squares slope = y/x = powerW / deltaK exactly.
    const dTankPerHour = 1;  // °C/h
    const tankAvgStart = 50;
    const DELTA_K      = 30; // constant tank-greenhouse gap

    const expectedPowerW = (dTankPerHour / SECONDS_PER_HOUR) * _TANK_THERMAL_MASS_J_PER_K;
    const expectedSlope  = expectedPowerW / DELTA_K;

    // Build 10 hourly readings in idle mode.
    const readings = [];
    const modes    = [];
    const baseMs   = Date.now();

    for (let i = 0; i < 10; i++) {
      const ts  = new Date(baseMs + i * SECONDS_PER_HOUR * 1000);
      const avg = tankAvgStart - i * dTankPerHour;
      readings.push({
        ts,
        tankTop:     avg + 2,
        tankBottom:  avg - 2,
        // Greenhouse tracks 30 K below tank average so deltaK stays constant.
        greenhouse:  avg - DELTA_K,
        outdoor:     avg - DELTA_K - 5,
        collector:   avg - DELTA_K,
      });
    }
    modes.push({ ts: new Date(baseMs), mode: 'idle' });

    const result = fitEmpiricalCoefficients({ readings, modes });

    assert.equal(result.usedDefaults, false,
      'Should not fall back to defaults with 9+ buckets');
    assert.ok(
      Math.abs(result.tankLeakageWPerK - expectedSlope) / expectedSlope < 0.10,
      'tankLeakageWPerK should be within 10% of expected: got ' +
        result.tankLeakageWPerK.toFixed(2) + ' expected ~' + expectedSlope.toFixed(2),
    );
  });
});

// ── 3. Smoke test: dark cold 48 h ──
describe('computeSustainForecast', () => {
  it('smoke test: dark cold 48 h charges electricity', () => {
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        30,
      tankBottom:     28,
      greenhouseTemp: 5,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 0, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},   // will use defaults
      config:         { greenhouseTargetC: 8, spaceHeaterKw: 1, transferFeeCKwh: 5 },
    });

    assert.equal(result.horizonHours, 48);
    assert.ok(result.electricKwh > 0, 'Should have some electric usage on dark cold 48 h');

    // Cost should equal kWh × (10+5)/100 ± tiny rounding.
    const expectedCost = result.electricKwh * (10 + 5) / 100;
    assert.ok(
      Math.abs(result.electricCostEur - expectedCost) < 0.001,
      'electricCostEur = electricKwh × (price+transfer)/100: got ' +
        result.electricCostEur + ' expected ' + expectedCost.toFixed(4),
    );

    // Trajectory arrays should have 49 entries (48 hours + 1 trailing point).
    assert.equal(result.tankTrajectory.length, 49);
    assert.equal(result.greenhouseTrajectory.length, 49);
    assert.ok(typeof result.generatedAt === 'string');
    assert.ok(result.modelConfidence === 'low' || result.modelConfidence === 'medium');
  });

  // ── 4. Warm and sunny ──
  it('warm/sunny: solarChargingHours > 0, low electric kWh', () => {
    // Build weather with sunny midday hours (radiation 600 W/m²).
    const weather = makeWeather48h({ temperature: 10, radiationGlobal: 0 });
    // Hours 10-16 of the first day are sunny.
    for (let h = 10; h <= 16; h++) {
      weather[h] = { temperature: 15, radiationGlobal: 600, windSpeed: 1 };
    }

    // Pin `now` to local midnight EEST so the weather index `h` coincides
    // with Helsinki hour-of-day `h` for the solarGainKwhByHour mask. With
    // Date.now() the test was time-of-day-flaky: an afternoon run shifted
    // the sunny indexes outside the [6..20] mask and zeroed out solar gain.
    const now = new Date('2026-05-03T21:00:00Z'); // 00:00 EEST May 4

    const result = computeSustainForecast({
      now,
      tankTop:        40,
      tankBottom:     38,
      greenhouseTemp: 12,
      currentMode:    'idle',
      weather48h:     weather,
      prices48h:      makePrices48h(5),
      coefficients:   {
        // Provide a non-zero baseline so the data-driven solar credit fires.
        solarGainKwhByHour: (function () {
          const a = new Array(24);
          for (let h = 0; h < 24; h++) a[h] = (h >= 6 && h <= 20) ? 0.5 : 0;
          return a;
        }()),
      },
      config:         { greenhouseTargetC: 8, spaceHeaterKw: 1, transferFeeCKwh: 5 },
    });

    assert.ok(result.solarChargingHours > 0,
      'Should have solar charging hours on a sunny day');
    // With a warm tank (60 °C) and warm greenhouse (12 °C > target 8 °C), no electric needed
    // during the sunny period.
    assert.ok(result.electricKwh < result.solarChargingHours,
      'Electric kWh should be small relative to solar hours when tank starts warm');
  });

  // ── 5. Floor crossing ──
  it('floor crossing: hoursUntilFloor < 12 and backup heater runs after', () => {
    // Tank barely above floor (14 °C avg), no sun, cold outdoor.
    // Use a high tankLeakageWPerK so the tank drains quickly.
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        15,
      tankBottom:     13,
      greenhouseTemp: 8,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: -5, radiationGlobal: 0, windSpeed: 3 }),
      prices48h:      makePrices48h(10),
      coefficients:   {
        tankLeakageWPerK: 50,  // high leakage: tank drains fast
        usedDefaults:     false,
      },
      config:         {
        tankFloorC:           12,
        greenhouseTargetC:    10,
        spaceHeaterKw:        1,
        transferFeeCKwh:      5,
      },
    });

    assert.ok(result.hoursUntilFloor !== null, 'Tank should hit floor within 48 h');
    assert.ok(result.hoursUntilFloor < 12,
      'With a cold start, floor should be hit within 12 h; got ' + result.hoursUntilFloor);
    assert.ok(result.electricKwh > 0, 'Backup heater should run after floor is hit');
    assert.ok(result.costBreakdown.length > 0, 'costBreakdown should have entries');
  });

  // ── 6. Confidence: empty history + fresh weather → low ──
  it('confidence is low when usedDefaults is true', () => {
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        30,
      tankBottom:     28,
      greenhouseTemp: 10,
      currentMode:    'idle',
      weather48h:     makeWeather48h(),
      prices48h:      makePrices48h(10),
      // No coefficients → will use defaults
      coefficients:   {},
      config:         {
        weatherFetchedAt: new Date(Date.now() - 60 * 1000), // 1 minute ago (fresh)
        fitBucketCount:   0,
      },
    });

    assert.equal(result.modelConfidence, 'low',
      'Empty history → defaults → confidence should be low');
  });

  // ── Extra: high confidence when many buckets + fresh weather ──
  it('confidence is high with many buckets and fresh weather', () => {
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        30,
      tankBottom:     28,
      greenhouseTemp: 10,
      currentMode:    'idle',
      weather48h:     makeWeather48h(),
      prices48h:      makePrices48h(10),
      coefficients:   {
        tankLeakageWPerK: 3.0,
        usedDefaults:     false,
      },
      config:         {
        weatherFetchedAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
        fitBucketCount:   12,
      },
    });

    assert.equal(result.modelConfidence, 'high',
      'Many buckets + fresh weather → confidence should be high');
  });
});

// ── fitSolarGainByHour — empirical kWh-per-clock-hour baseline ──

describe('fitSolarGainByHour', () => {
  it('empty history → conservative fallback (low-gain 10..16)', () => {
    const out = fitSolarGainByHour({ readings: [], modes: [] });
    assert.equal(out.length, 24);
    assert.equal(out[5], 0);
    assert.equal(out[12], 0.4);   // fallback peak
    assert.equal(out[20], 0);
  });

  it('null history → conservative fallback', () => {
    const out = fitSolarGainByHour(null);
    assert.equal(out.length, 24);
    assert.equal(out[14], 0.4);
  });

  it('synthetic charging history → produces non-zero gain at the active hour', () => {
    // Build 14 days of readings; on each day, hour 12-14 the system is in
    // solar_charging mode and the tank rises by 1 K every 5 min.
    const readings = [];
    const modes    = [{ ts: new Date('2026-04-01T00:00:00Z'), mode: 'idle' }];
    const dayMs = 24 * 3600 * 1000;
    const stepMs = 5 * 60 * 1000;
    const start = new Date('2026-04-01T00:00:00Z').getTime();
    for (let d = 0; d < 14; d++) {
      const dayStart = start + d * dayMs;
      // Switch to solar_charging at 09:00 UTC (local 12:00 in EEST)
      modes.push({ ts: new Date(dayStart + 9 * 3600 * 1000), mode: 'solar_charging' });
      modes.push({ ts: new Date(dayStart + 12 * 3600 * 1000), mode: 'idle' });
      // Per-day readings (288 every 5 min)
      let tank = 30;
      for (let s = 0; s < 288; s++) {
        const ts = new Date(dayStart + s * stepMs);
        const hUtc = ts.getUTCHours();
        // While in solar_charging (09:00 UTC – 12:00 UTC = local 12-15 EEST),
        // tank rises by 0.5 K per 5 min step → 6 K per hour.
        if (hUtc >= 9 && hUtc < 12) tank += 0.5;
        readings.push({ ts, tankTop: tank + 1, tankBottom: tank - 1, greenhouse: 15, outdoor: 10, collector: 50 });
      }
    }
    const out = fitSolarGainByHour({ readings, modes });
    // Expected per-hour gain: 6 K/h × 0.349 kWh/K = 2.09 kWh/h while charging.
    // Local hours 12, 13, 14 (EEST) — three hours of strong gain.
    assert.ok(out[12] > 1.0, 'expected non-trivial gain at local hour 12, got ' + out[12]);
    assert.ok(out[13] > 1.0, 'expected non-trivial gain at local hour 13, got ' + out[13]);
    assert.ok(out[14] > 1.0, 'expected non-trivial gain at local hour 14, got ' + out[14]);
    assert.equal(out[3], 0,  'no gain expected outside charging hours');
    assert.equal(out[20], 0, 'no gain expected at evening');
  });
});

// ── Cloud-factor modulation (data-driven solar gain) ──

describe('computeSustainForecast — FMI cloud factor', () => {
  function localMidnight() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function makeWeather48hWithRad(radPerHour) {
    return Array.from({ length: 48 }, function (_, i) {
      const t = new Date(localMidnight() + i * 3600000);
      return { validAt: t, temperature: 5, radiationGlobal: radPerHour, windSpeed: 1, precipitation: 0 };
    });
  }
  const flatGain = (function () { const a = new Array(24); for (let h = 0; h < 24; h++) a[h] = 1.0; return a; }());

  it('overcast (radiation 50 W/m²) → near-zero solar charging credited', () => {
    const result = computeSustainForecast({
      now:            localMidnight(),
      tankTop:        30, tankBottom: 28, greenhouseTemp: 12,
      currentMode:    'idle',
      weather48h:     makeWeather48hWithRad(50),
      prices48h:      Array.from({ length: 48 }, function (_, i) { return { validAt: new Date(localMidnight() + i * 3600000), priceCKwh: 5 }; }),
      coefficients:   { solarGainKwhByHour: flatGain, usedDefaults: false },
      config:         { greenhouseTargetC: 8 },
    });
    assert.equal(result.solarChargingHours, 0,
      '50 W/m² with baseline 1 kWh/h × cloudFactor 0.1 = 0.1 kWh < 0.15 threshold → 0 hours');
  });

  it('partly cloudy (radiation 250 W/m²) → modest solar gain credited', () => {
    const result = computeSustainForecast({
      now:            localMidnight(),
      tankTop:        30, tankBottom: 28, greenhouseTemp: 12,
      currentMode:    'idle',
      weather48h:     makeWeather48hWithRad(250),
      prices48h:      Array.from({ length: 48 }, function (_, i) { return { validAt: new Date(localMidnight() + i * 3600000), priceCKwh: 5 }; }),
      coefficients:   { solarGainKwhByHour: flatGain, usedDefaults: false },
      config:         { greenhouseTargetC: 8 },
    });
    // 250/500 = 0.5 cloudFactor × 1 kWh = 0.5 kWh per hour > 0.15 threshold
    assert.ok(result.solarChargingHours >= 24,
      'all 48 hours should count when radiation × baseline > threshold');
  });

  it('clear sky (radiation 700 W/m²) → cloudFactor capped at 1.5', () => {
    const result = computeSustainForecast({
      now:            localMidnight(),
      tankTop:        30, tankBottom: 28, greenhouseTemp: 12,
      currentMode:    'idle',
      weather48h:     makeWeather48hWithRad(700),
      prices48h:      Array.from({ length: 48 }, function (_, i) { return { validAt: new Date(localMidnight() + i * 3600000), priceCKwh: 5 }; }),
      coefficients:   { solarGainKwhByHour: flatGain, usedDefaults: false },
      config:         { greenhouseTargetC: 8, tankMaxC: 80 },
    });
    // Verify per-day breakdown is exposed and roughly matches 24h × 1.4 = ~33 kWh/day
    assert.ok(Array.isArray(result.solarGainByDay));
    assert.ok(result.solarGainByDay.length >= 1);
    // Tank cap kicks in mid-day so the per-day total stops growing once tank
    // reaches tankMaxC; just assert it's well above the partly-cloudy
    // baseline (24 × 0.5 = 12) to confirm cloudFactor scaled past 1.
    assert.ok(result.solarGainByDay[0].kWh > 18,
      'expected > 18 kWh/day on a 700 W/m² day; got ' + result.solarGainByDay[0].kWh);
  });
});

// Regression: emergencyRecentlyActive short-circuits hoursUntilBackup
// to 0. Pre-fix the card said "Tank lasts ~4 h" while the heater was
// already cycling — confusing for the operator.
describe('computeSustainForecast — emergencyRecentlyActive', () => {
  it('reports hoursUntilBackupNeeded=0 when emergency cycled recently', () => {
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        14, tankBottom: 14, greenhouseTemp: 13,
      currentMode:    'idle',
      emergencyRecentlyActive: true,
      weather48h:     makeWeather48h({ temperature: 6, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        emergencyEnterC: 11, emergencyExitC: 13,
      },
    });
    assert.equal(result.hoursUntilBackupNeeded, 0,
      'expected 0 (backup engaged) when emergencyRecentlyActive=true');
    const exhaustedNote = result.notes.find(function (n) {
      return /too cold to drive the radiator/.test(n);
    });
    assert.ok(exhaustedNote,
      'expected note explaining the tank is functionally exhausted; got: ' + JSON.stringify(result.notes));
  });

  it('does NOT short-circuit when emergencyRecentlyActive=false', () => {
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        50, tankBottom: 50, greenhouseTemp: 14,
      currentMode:    'idle',
      emergencyRecentlyActive: false,
      weather48h:     makeWeather48h({ temperature: 6, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        greenhouseEnterC: 13, greenhouseExitC: 14,
        emergencyEnterC: 11, emergencyExitC: 13,
      },
    });
    // Warm tank (50 °C), gh comfortably above geT — no backup expected.
    assert.notEqual(result.hoursUntilBackupNeeded, 0,
      'expected null/positive hoursUntilBackupNeeded with warm tank, got 0');
  });
});

// Regression: heater duty cycle in emergency mode. Old code charged
// 1 kWh per emergency hour unconditionally; the user observed the
// engine projecting 45 kWh of backup over 48 h (≈95% duty cycle) when
// outdoor was only 6 °C below the greenhouse target. Real device
// cycles based on heat-loss demand, not full-on.
describe('computeSustainForecast — emergency heater duty cycle', () => {
  it('scales heater kWh by greenhouse loss when outdoor is mild', () => {
    // Cold tank (forces emergency), mild outdoor (small ΔT to greenhouse).
    // ehE=11 ehX=13 → target = 12. Outdoor 6 → ΔT=6K. With UA=120 W/K:
    // ghLossW = 720W. Heater 1kW → duty ~72%. 48h × 0.72 ≈ 35 kWh,
    // not 48 kWh.
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        12, tankBottom: 12, greenhouseTemp: 10,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 6, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        emergencyEnterC: 11, emergencyExitC: 13,
        greenhouseLossWPerK: 120,
      },
    });
    // 48h × 0.72 duty = 34.6 kWh. Allow 30-40 range for transient hours.
    assert.ok(result.electricKwh >= 25 && result.electricKwh <= 40,
      'expected ~35 kWh of heater energy at 72% duty, got ' + result.electricKwh);
  });

  // Regression: emergency overlays the space heater on the active pump
  // mode (system.yaml overlays.emergency_heating). Pre-fix the engine
  // zero'd the radiator during emergency, so a 40 °C tank still
  // projected ~40 kWh of heater energy even though the radiator alone
  // could carry the load.
  it('hot tank materially reduces projected heater energy', () => {
    const baseOpts = {
      now:            Date.now(),
      greenhouseTemp: 10,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 7, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        greenhouseEnterC: 13, greenhouseExitC: 14,
        emergencyEnterC: 11, emergencyExitC: 13,
        greenhouseLossWPerK: 120,
      },
    };
    const cold = computeSustainForecast(Object.assign({}, baseOpts, {
      tankTop: 12, tankBottom: 12,
    }));
    const hot  = computeSustainForecast(Object.assign({}, baseOpts, {
      tankTop: 40, tankBottom: 40,
    }));
    // ~25% reduction is the steady-state expectation: a 40 °C tank carries
    // ~7 hours of greenhouse heating before it drops to gh temperature, then
    // the heater takes over at the same duty as the cold-tank case.
    assert.ok(hot.electricKwh < cold.electricKwh * 0.85,
      'expected hot tank to materially reduce projected heater energy: cold=' +
        cold.electricKwh.toFixed(2) + ' hot=' + hot.electricKwh.toFixed(2));
  });

  // Regression: tank near floor + recent backup cycling used to project
  // ~30 kWh of continuous emergency over the next 48 h, ignoring sunny
  // afternoons that would charge the tank back up.
  it('cycles emergency duty down during sunny hours', () => {
    // Strong solar gain at midday (Helsinki hours 10–15). Outdoor 7 °C.
    const solarGainKwhByHour = new Array(24).fill(0);
    for (let h = 10; h <= 15; h++) solarGainKwhByHour[h] = 1.5;
    const weather = Array.from({ length: 48 }, function (_, i) {
      return {
        ts:              new Date(Date.now() + i * 3600 * 1000).toISOString(),
        temperature:     7,
        radiationGlobal: 500, // matches cloudReferenceWm2 → cloudFactor=1
      };
    });

    const noFix = computeSustainForecast({
      now:            Date.now(),
      tankTop:        14, tankBottom: 13, greenhouseTemp: 11,
      currentMode:    'idle',
      emergencyRecentlyActive: true,
      weather48h:     weather,
      prices48h:      makePrices48h(10),
      coefficients:   { tankLeakageWPerK: 3, solarGainKwhByHour },
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        greenhouseEnterC: 13, greenhouseExitC: 14,
        emergencyEnterC: 11, emergencyExitC: 13,
        greenhouseLossWPerK: 120,
      },
    });

    // Old engine: 60% duty × 48 h ≈ 29 kWh. With the radiator running
    // alongside as it does in hardware, daytime hours drop to near-zero
    // duty as the tank charges, dragging the 48 h total below 22 kWh.
    // Under the unified GH heat balance, sunny hours warm the greenhouse
    // above the emergency threshold via solar absorption alone — making
    // the projection even lower (often near zero), which is more
    // accurate than the old "always-some-duty" projection.
    assert.ok(noFix.electricKwh < 22,
      'expected sunny days to lower projected backup energy, got ' + noFix.electricKwh);

    // Emergency entries (if any) must carry numeric duty so the chart
    // can render fractional bars. Sunny midday may lift gh above ehE
    // before any emergency entry fires — zero entries is OK.
    const emEntries = (noFix.modeForecast || []).filter(function (e) {
      return e.mode === 'emergency_heating';
    });
    assert.ok(emEntries.every(function (e) { return typeof e.duty === 'number'; }),
      'every emergency entry (if any) must carry a numeric duty fraction');
  });

  // Regression (field report 2026-05-05): cold tank (avg 13, gh 12.4)
  // shouldn't project greenhouse_heating bars — the controller wouldn't
  // run the pump because tank_top ≯ greenhouse + gmD.
  it('skips greenhouse_heating projection when tank is too cold to drive the radiator', () => {
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        14.3, tankBottom: 11.8, greenhouseTemp: 12.4,
      currentMode:    'idle',
      emergencyRecentlyActive: true,
      weather48h:     makeWeather48h({ temperature: 6, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        greenhouseEnterC: 13, greenhouseExitC: 14,
        emergencyEnterC: 11, emergencyExitC: 13,
        greenhouseMinTankDeltaC: 5, greenhouseExitTankDeltaC: 2,
        greenhouseLossWPerK: 120,
      },
    });
    const heatingEntries = (result.modeForecast || []).filter(function (e) {
      return e.mode === 'greenhouse_heating';
    });
    assert.equal(heatingEntries.length, 0,
      'expected no greenhouse_heating projection with tank avg 13°C and gh 12.4°C; got ' +
        heatingEntries.length + ' entries: ' +
        JSON.stringify(heatingEntries.slice(0, 3)));
    // And emergency_heating must take over (gh will drift below ehE without
    // the radiator running).
    const emergencyEntries = (result.modeForecast || []).filter(function (e) {
      return e.mode === 'emergency_heating';
    });
    assert.ok(emergencyEntries.length > 0,
      'expected emergency_heating to cover the cold-tank shortfall; got 0 entries');
  });

  // Once the tank is hot enough to deliver useful radiator power the
  // forecast must STILL project greenhouse_heating — the gating only
  // suppresses the mode when the tank-greenhouse delta is below the
  // device's entry threshold.
  it('projects greenhouse_heating when tank is hot enough', () => {
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        25, tankBottom: 22, greenhouseTemp: 12,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 4, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        greenhouseEnterC: 13, greenhouseExitC: 14,
        emergencyEnterC: 11, emergencyExitC: 13,
        greenhouseMinTankDeltaC: 5, greenhouseExitTankDeltaC: 2,
        greenhouseLossWPerK: 120,
      },
    });
    const heatingEntries = (result.modeForecast || []).filter(function (e) {
      return e.mode === 'greenhouse_heating';
    });
    assert.ok(heatingEntries.length > 0,
      'expected at least one greenhouse_heating projection with hot tank; got 0');
  });

  it('zero heater kWh when outdoor is warmer than the target', () => {
    // Outdoor 15 > target 12 → no heat needed even though gh starts cold.
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        12, tankBottom: 12, greenhouseTemp: 10,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 15, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        emergencyEnterC: 11, emergencyExitC: 13,
        greenhouseLossWPerK: 120,
      },
    });
    // Heater should run for at most a couple of transient hours before
    // the warm outdoor lifts gh above ehX and emergency exits.
    assert.ok(result.electricKwh < 5,
      'expected near-zero kWh when outdoor (15°C) > target (12°C); got ' + result.electricKwh);
  });
});

// Round-trip: real-shaped 14d history → fitEmpiricalCoefficients → engine.
// Catches drift in the fit→engine interface (field name renames, shape
// changes, anything where the fit produces a value the engine no longer
// consumes or vice versa).
describe('fit → engine round-trip', () => {
  it('synthetic 14d history flows through fit and engine without warmup-warning', () => {
    // Synthesise 14 days of 30-min readings: idle most of the time with a
    // mild cooldown (so tank-leakage fit converges), and a 3 h solar_charging
    // window each midday (so solarGainKwhByHour fits a non-zero peak).
    const readings = [];
    const modes    = [];
    const dayMs   = 24 * 3600 * 1000;
    const stepMs  = 30 * 60 * 1000;
    const start   = new Date('2026-04-01T00:00:00Z').getTime();

    modes.push({ ts: new Date(start), mode: 'idle' });

    for (let d = 0; d < 14; d++) {
      const dayStart = start + d * dayMs;
      // Solar-charging window: 09:00 – 12:00 UTC (= 12 – 15 EEST). Toggle
      // mode events at the boundary so the fit attributes the gain
      // correctly.
      modes.push({ ts: new Date(dayStart + 9 * 3600 * 1000),  mode: 'solar_charging' });
      modes.push({ ts: new Date(dayStart + 12 * 3600 * 1000), mode: 'idle' });

      let tank = 30 - 0.05 * d; // slow background drift over 14 days
      for (let s = 0; s < 48; s++) {
        const ts    = new Date(dayStart + s * stepMs);
        const utcH  = ts.getUTCHours();
        if (utcH >= 9 && utcH < 12) {
          tank += 0.5;       // gain during charging window
        } else {
          tank -= 0.005;     // mild leakage in idle
        }
        readings.push({
          ts,
          tankTop:    tank + 1,
          tankBottom: tank - 1,
          greenhouse: 12,
          outdoor:    8,
          collector:  utcH >= 9 && utcH < 16 ? 60 : 8,
        });
      }
    }

    const coeff = fitEmpiricalCoefficients({ readings, modes });

    // Fit must produce live-shape coefficients (not the warmup defaults).
    assert.equal(coeff.usedDefaults, false,
      'expected fit to converge with 14 days of synthetic data');
    assert.ok(typeof coeff.tankLeakageWPerK === 'number',
      'tankLeakageWPerK must be a number');
    assert.ok(Array.isArray(coeff.solarGainKwhByHour) && coeff.solarGainKwhByHour.length === 24,
      'solarGainKwhByHour must be a 24-entry array');

    // Engine must accept the coefficients and produce a complete forecast.
    const result = computeSustainForecast({
      now:            new Date(start + 14 * dayMs),
      tankTop:        25, tankBottom: 23, greenhouseTemp: 12,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 5, radiationGlobal: 200 }),
      prices48h:      makePrices48h(8),
      coefficients:   coeff,
      config:         { fitBucketCount: readings.length },
    });

    assert.equal(result.horizonHours, 48);
    assert.ok(!result.notes.some(function (n) { return /default coefficients/.test(n); }),
      'expected no "warming up" note when fit converged; got: ' + JSON.stringify(result.notes));
  });
});

// Regression: the engine's stored-kWh figure must match the shared
// tankStoredEnergyKwh() formula used by the gauge tile, balance card and
// push notifications. Past divergence: engine subtracted an extra 5 K
// margin, so the same tank state read 1.1 kWh on the forecast card and
// 2.9 kWh on the gauge — the user noticed and asked which one was right.
describe('computeSustainForecast — stored-kWh consistency', () => {
  it('Note 2 reports the same kWh as tankStoredEnergyKwh(avg)', () => {
    const { tankStoredEnergyKwh } = require('../server/lib/energy-balance.js');
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        21,
      tankBottom:     19,   // avg = 20
      greenhouseTemp: 14,   // above geT, no heating triggered
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 12, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: { greenhouseEnterC: 10, greenhouseExitC: 12, emergencyEnterC: 8, emergencyExitC: 11 },
    });
    const tankNote = result.notes.find(function (n) { return /kWh above the floor/.test(n); });
    assert.ok(tankNote, 'expected a tank-stored note: ' + JSON.stringify(result.notes));
    const expectedKwh = tankStoredEnergyKwh(20).toFixed(1);
    assert.ok(tankNote.indexOf(expectedKwh) >= 0,
      'expected note to contain "' + expectedKwh + '" kWh; got: ' + tankNote);
  });
});

// Regression: emergencyExitC (ehX) must be threaded through. Old code
// hardcoded `emergencyEnterC + 2` for the exit hysteresis, so a user
// who set ehX to anything other than ehE+2 would see the engine ignore
// their exit threshold.
describe('computeSustainForecast — ehX threading', () => {
  it('uses cfg.emergencyExitC for emergency-exit hysteresis', () => {
    // Pick non-trivial values: ehE=8, ehX=15. With outdoor=-5 and a 1kW
    // heater on a 120 W/K greenhouse, the heater cannot physically lift
    // gh past ehE+8K = 16K above outdoor — it will plateau well below
    // ehX. So emergency must STAY active across the whole window.
    // The pre-fix bug used `emergencyEnterC + 2` (= 10) for the exit
    // threshold; under that bug emergency would have prematurely
    // exited as soon as gh ≥ 10. The fix threads cfg.emergencyExitC
    // (= 15) so the engine keeps emergency on while gh < 15.
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        14, tankBottom: 14, greenhouseTemp: 7,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: -5, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      config: {
        greenhouseEnterC: 10, greenhouseExitC: 12,
        emergencyEnterC: 8, emergencyExitC: 15,
      },
    });
    // Expect emergency entries throughout (heater can't lift gh past
    // ehX with the supplied loss/heater sizing).
    const emergencyHours = result.modeForecast.filter(function (m) {
      return m.mode === 'emergency_heating';
    }).length;
    assert.ok(emergencyHours >= 24,
      'expected emergency to stay active when heater is undersized for ehX; got ' + emergencyHours + ' hours');
  });
});

// Regression: handler used to pass tuning.greenhouseEnterTemp where
// effectiveTuning returns tuning.geT — undefined leaked through and
// silently disabled all heating thresholds.
describe('computeSustainForecast — undefined config thresholds fall back to defaults', () => {
  it('cold night with explicit-undefined thresholds still triggers backup', () => {
    const result = computeSustainForecast({
      now:            Date.now(),
      tankTop:        20,
      tankBottom:     18,
      greenhouseTemp: 12,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 2, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      coefficients:   {},
      // Simulates the broken handler shape: keys present but undefined values.
      config: {
        spaceHeaterKw:    1,
        transferFeeCKwh:  5,
        greenhouseEnterC: undefined,
        greenhouseExitC:  undefined,
        emergencyEnterC:  undefined,
      },
    });

    // With defaults restored (greenhouseEnterC=10, emergencyEnterC=8), the
    // greenhouse should cool below 8 within 48 h and trigger backup heating.
    assert.ok(result.hoursUntilBackupNeeded !== null,
      'expected hoursUntilBackupNeeded to be set, got null');
    assert.ok(result.electricKwh > 0,
      'expected backup heating > 0 kWh, got ' + result.electricKwh);
  });
});

// Regression: greenhouseLossWPerK was a hardcoded 120 W/K. Live data
// (Jonni's greenhouse, 2026-05-04) showed 23–49% heater duty at gh~12,
// outdoor~6-7 °C — implying a real loss coefficient of ~40-100 W/K. The
// engine over-predicted backup energy by 2-3× as a result. This suite
// exercises the empirical fit that derives the coefficient from observed
// emergency-only hours where the heater is the sole heat source and gh
// is roughly steady (bang-bang cycling around the hysteresis midpoint).
describe('fitGreenhouseLossWPerK', () => {
  it('returns null with no usable history', () => {
    assert.equal(fitGreenhouseLossWPerK({ readings: [], modes: [] }), null);
    assert.equal(fitGreenhouseLossWPerK(null), null);
  });

  it('recovers a known slope from synthetic emergency-only hours', () => {
    // Synthesise 10 days × ~3 h/day of emergency-only hours where the
    // heater bang-bangs to hold gh ≈ 12 °C against varying outdoor temps.
    // Pre-set duty = trueLoss * (gh - outdoor) / 1000 W so the bucketed
    // fit recovers trueLoss.
    const trueLossWPerK = 50;
    const heaterW       = 1000;
    const start         = new Date('2026-04-20T00:00:00Z').getTime();
    const readings      = [];
    const modes         = [];

    // Modes alternate emergency_heating ↔ idle every few minutes,
    // stamped at 30 s resolution so the bucketer can sum the seconds.
    let modeAt = 'idle';
    modes.push({ ts: new Date(start), mode: modeAt });

    for (let day = 0; day < 10; day++) {
      // Three emergency-only hours per day, with different outdoor
      // temperatures to give the slope-fit useful spread.
      const outdoorByHour = [-2, 4, 8];
      for (let h = 0; h < 3; h++) {
        const hourStart = start + (day * 24 + h) * 3600 * 1000;
        const outdoor   = outdoorByHour[h];
        const ghAvg     = 12;
        const dutyTrue  = (trueLossWPerK * (ghAvg - outdoor)) / heaterW;
        // Carve the hour into 60 one-minute slices; turn the heater on
        // for the first floor(60·duty) of them, off for the rest.
        const onMinutes = Math.round(60 * dutyTrue);
        for (let m = 0; m < 60; m++) {
          const ts = new Date(hourStart + m * 60 * 1000);
          // Two 30s readings per minute.
          for (let s = 0; s < 2; s++) {
            const tsR = new Date(ts.getTime() + s * 30 * 1000);
            readings.push({
              ts:         tsR,
              tankTop:    14, tankBottom: 14,
              greenhouse: ghAvg + (m < onMinutes ? 0.5 : -0.5), // ±0.5 around mean
              outdoor,
              collector:  10,
            });
          }
          const wantMode = m < onMinutes ? 'emergency_heating' : 'idle';
          if (wantMode !== modeAt) {
            modes.push({ ts, mode: wantMode });
            modeAt = wantMode;
          }
        }
      }
    }

    const slope = fitGreenhouseLossWPerK({ readings, modes }, { heaterW });
    assert.ok(slope !== null, 'expected fit to converge with 10 days of data');
    assert.ok(Math.abs(slope - trueLossWPerK) / trueLossWPerK < 0.10,
      'expected slope within 10% of true ' + trueLossWPerK + ': got ' + slope.toFixed(1));
  });

  it('skips hours contaminated by greenhouse_heating or solar_charging', () => {
    // Build a single hour where the heater fires but greenhouse_heating
    // is also active (radiator delivers extra heat). The fitter should
    // refuse the bucket — the duty cycle is no longer a clean lossWPerK
    // signal because some of the heating came from the tank.
    const start    = new Date('2026-04-20T00:00:00Z').getTime();
    const readings = [];
    const modes    = [
      { ts: new Date(start), mode: 'greenhouse_heating' },
      // emergency overlay starts 10 min in; 30 min later the controller
      // exits both modes. Still entirely contaminated.
      { ts: new Date(start + 10 * 60 * 1000), mode: 'emergency_heating' },
      { ts: new Date(start + 40 * 60 * 1000), mode: 'idle' },
    ];
    for (let s = 0; s < 120; s++) {
      readings.push({
        ts:         new Date(start + s * 30 * 1000),
        tankTop:    14, tankBottom: 14,
        greenhouse: 12,
        outdoor:    6,
        collector:  10,
      });
    }

    const slope = fitGreenhouseLossWPerK({ readings, modes }, { heaterW: 1000 });
    assert.equal(slope, null,
      'expected the contaminated bucket to be discarded → no fit possible');
  });

  it('flows through fitEmpiricalCoefficients into the engine', () => {
    // End-to-end: a synthetic 10d history with emergency-only hours
    // produces a fitted greenhouseLossWPerK that the engine actually uses.
    // Reduces the projected heater energy materially compared to the old
    // hardcoded 120 W/K default.
    const trueLossWPerK = 40;
    const heaterW       = 1000;
    const start         = new Date('2026-04-20T00:00:00Z').getTime();
    const readings      = [];
    const modes         = [];

    let modeAt = 'idle';
    modes.push({ ts: new Date(start), mode: modeAt });
    for (let day = 0; day < 10; day++) {
      const outdoorByHour = [0, 5, 8];
      for (let h = 0; h < 3; h++) {
        const hourStart = start + (day * 24 + h) * 3600 * 1000;
        const outdoor   = outdoorByHour[h];
        const dutyTrue  = (trueLossWPerK * (12 - outdoor)) / heaterW;
        const onMinutes = Math.round(60 * dutyTrue);
        for (let m = 0; m < 60; m++) {
          const ts = new Date(hourStart + m * 60 * 1000);
          for (let s = 0; s < 2; s++) {
            readings.push({
              ts:         new Date(ts.getTime() + s * 30 * 1000),
              tankTop:    14, tankBottom: 14,
              greenhouse: 12,
              outdoor,
              collector:  10,
            });
          }
          const wantMode = m < onMinutes ? 'emergency_heating' : 'idle';
          if (wantMode !== modeAt) {
            modes.push({ ts, mode: wantMode });
            modeAt = wantMode;
          }
        }
      }
    }

    const coeff = fitEmpiricalCoefficients({ readings, modes });
    assert.ok(typeof coeff.greenhouseLossWPerK === 'number',
      'fit output should expose greenhouseLossWPerK');
    assert.ok(Math.abs(coeff.greenhouseLossWPerK - trueLossWPerK) / trueLossWPerK < 0.15,
      'engine coefficient should track true loss within 15%: got ' +
        coeff.greenhouseLossWPerK.toFixed(1));

    // Run the engine with the fitted coefficient and with the hardcoded
    // 120 W/K default → fitted should project materially less heater kWh.
    const baseOpts = {
      now:            new Date(start + 10 * 24 * 3600 * 1000),
      tankTop:        12, tankBottom: 12, greenhouseTemp: 10,
      currentMode:    'idle',
      weather48h:     makeWeather48h({ temperature: 7, radiationGlobal: 0 }),
      prices48h:      makePrices48h(10),
      config: {
        spaceHeaterKw: 1, transferFeeCKwh: 5,
        emergencyEnterC: 11, emergencyExitC: 13,
      },
    };
    const fitted   = computeSustainForecast(Object.assign({}, baseOpts, { coefficients: coeff }));
    const baseline = computeSustainForecast(Object.assign({}, baseOpts, {
      coefficients: { greenhouseLossWPerK: 120 },
    }));
    assert.ok(fitted.electricKwh < baseline.electricKwh * 0.6,
      'fitted coefficient should reduce projected heater energy: baseline=' +
        baseline.electricKwh.toFixed(2) + ' fitted=' + fitted.electricKwh.toFixed(2));
  });
});

describe('greenhouse heat balance — solar absorption', () => {
  it('predicted GH temp rises above outdoor on a sunny day', () => {
    // Sunny noon: outdoor 15 °C, ramp radiation 0 → 700 W/m² over the
    // first 6 hours, hold flat. Tank starts cold so no heating overlay
    // muddies the GH curve.
    const now = Date.UTC(2026, 5, 1, 6, 0, 0); // Helsinki noon (UTC+3)
    const weather = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      const rad = h < 6 ? Math.min(700, 100 * h)
                : h < 12 ? 700
                : h < 18 ? Math.max(0, 700 - 100 * (h - 12))
                : 0;
      weather.push({ ts, temperature: 15, radiationGlobal: rad, windSpeed: 1, precipitation: 0 });
    }
    const prices = weather.map(w => ({ ts: w.ts, priceCKwh: 5 }));

    const fc = computeSustainForecast({
      now,
      tankTop: 14, tankBottom: 13,
      greenhouseTemp: 15,
      currentMode: 'idle',
      weather48h: weather, prices48h: prices,
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0) },
      config: {},
    });
    const peakGh = Math.max.apply(null, fc.greenhouseTrajectory.map(p => p.temp));
    assert.ok(peakGh >= 25, 'expected GH peak >= 25C from solar gain, got ' + peakGh);
  });

  it('cold overnight triggers greenhouse_heating within 4 h', () => {
    // GH starts at 18 °C, outdoor steady at 5 °C, no sun. With the
    // realistic τ ≈ 2 h the GH should drop below the heating threshold
    // (geT default 10) within 4 h, which the simulation must surface
    // as a greenhouse_heating mode entry.
    const now = Date.UTC(2026, 5, 1, 18, 0, 0);
    const weather = []; const prices = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      weather.push({ ts, temperature: 5, radiationGlobal: 0, windSpeed: 1, precipitation: 0 });
      prices.push({ ts, priceCKwh: 5 });
    }
    const fc = computeSustainForecast({
      now,
      tankTop: 35, tankBottom: 30, greenhouseTemp: 18,
      currentMode: 'idle',
      weather48h: weather, prices48h: prices,
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0) },
      config: {},
    });
    const firstHeatingEntry = fc.modeForecast.find(m => m.mode === 'greenhouse_heating' || m.mode === 'emergency_heating');
    assert.ok(firstHeatingEntry, 'expected a heating mode entry, got none');
    const firstHeatingH = (new Date(firstHeatingEntry.ts).getTime() - now) / 3600000;
    assert.ok(firstHeatingH <= 4,
      'expected heating within 4 h, first heating at simulation hour ' + firstHeatingH);
  });

  it('fitGhPassiveAndSolar recovers tau within 20% on no-sun synthetic data', () => {
    // Synthetic readings: gh starts at 25, outdoor at 5, no sun, idle.
    // Generated with dT/dt = (out-gh)/τ; 30 s sampling for 24 h.
    // Radiation=0 throughout → joint fit's design matrix is rank-1 and
    // it falls back to the 1-variable τ-only path.
    const dtSec = 30; const tauH = 2.0;
    const readings = [];
    let gh = 25;
    for (let i = 0; i < 24 * 60 * 2; i++) {
      const ts = new Date(Date.UTC(2026, 4, 1) + i * dtSec * 1000);
      readings.push({ ts, greenhouse: gh, outdoor: 5, tankTop: 20, tankBottom: 20, radiationGlobal: 0 });
      gh = gh + (5 - gh) * (dtSec / 3600) / tauH;
    }
    const modes = [{ ts: readings[0].ts, mode: 'idle' }];
    const coeff = fitEmpiricalCoefficients({ readings, modes });
    assert.ok(coeff.ghTimeConstantH !== undefined, 'fit did not converge');
    assert.ok(Math.abs(coeff.ghTimeConstantH - tauH) / tauH < 0.2,
      'tau off by >20%: got ' + coeff.ghTimeConstantH);
  });

  it('fitGhPassiveAndSolar co-fits tau AND alpha on synthetic mixed data', () => {
    // Synthetic readings: oscillate radiation between 0 (night) and 600
    // W/m² (sunny) every 12 h; outdoor 10 °C constant; gh integrated
    // forward with the heat balance dT/dt = (out-gh)/τ + α·rad.
    // Both tau and alpha must come back recognisable.
    const dtSec = 30; const tauH = 2.0; const alpha = 0.02;
    const readings = [];
    let gh = 12;
    for (let i = 0; i < 7 * 24 * 60 * 2; i++) { // 7 days
      const ts = new Date(Date.UTC(2026, 4, 1) + i * dtSec * 1000);
      // 12 h sun, 12 h dark
      const hourOfDay = Math.floor(i / 120) % 24;
      const rad = hourOfDay >= 6 && hourOfDay < 18 ? 600 : 0;
      readings.push({ ts, greenhouse: gh, outdoor: 10, tankTop: 20, tankBottom: 20, radiationGlobal: rad });
      gh = gh + ((10 - gh) / tauH + alpha * rad) * (dtSec / 3600);
    }
    const modes = [{ ts: readings[0].ts, mode: 'idle' }];
    const coeff = fitEmpiricalCoefficients({ readings, modes });
    assert.ok(coeff.ghTimeConstantH !== undefined && coeff.ghSolarAlphaCPerWm2 !== undefined,
      'joint fit did not produce both coefficients');
    assert.ok(Math.abs(coeff.ghTimeConstantH - tauH) / tauH < 0.25,
      'tau off by >25%: got ' + coeff.ghTimeConstantH);
    assert.ok(Math.abs(coeff.ghSolarAlphaCPerWm2 - alpha) / alpha < 0.25,
      'alpha off by >25%: got ' + coeff.ghSolarAlphaCPerWm2);
  });

  it('emits a 48-entry componentTrajectory with per-hour input/output components', () => {
    const now = Date.UTC(2026, 5, 1);
    const weather = []; const prices = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      weather.push({ ts, temperature: 10, radiationGlobal: 200, windSpeed: 1, precipitation: 0 });
      prices.push({ ts, priceCKwh: 5 });
    }
    const fc = computeSustainForecast({
      now, tankTop: 30, tankBottom: 25, greenhouseTemp: 12,
      currentMode: 'idle', weather48h: weather, prices48h: prices,
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0.3) },
      config: {},
    });
    assert.equal(fc.componentTrajectory.length, 48);
    const c0 = fc.componentTrajectory[0];
    assert.ok('solarGainKwh' in c0);
    assert.ok('radDeliveredW' in c0);
    assert.ok('heaterKwh' in c0);
    assert.ok('tankLossW' in c0);
    assert.ok('cloudFactor' in c0);
  });

  it('vent saturation holds GH below 35 C even at 700 W/m^2 + outdoor 25 C', () => {
    // Worst-case summer: hot outdoor + full sun. The new vent term
    // must keep the prediction realistic — without it the heat-balance
    // would diverge to ~50 °C.
    const now = Date.UTC(2026, 6, 1, 9, 0, 0);
    const weather = []; const prices = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      weather.push({ ts, temperature: 25, radiationGlobal: 700, windSpeed: 1, precipitation: 0 });
      prices.push({ ts, priceCKwh: 5 });
    }
    const fc = computeSustainForecast({
      now,
      tankTop: 40, tankBottom: 35, greenhouseTemp: 25,
      currentMode: 'idle',
      weather48h: weather, prices48h: prices,
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0) },
      config: {},
    });
    const peakGh = Math.max.apply(null, fc.greenhouseTrajectory.map(p => p.temp));
    // Vent saturates a few K above ventOpenC in summer extremes; real
    // ceiling ≤ ~38C (user's observed worst case).
    assert.ok(peakGh <= 38, 'vent cap must hold GH below 38C; got ' + peakGh);
    assert.ok(peakGh >= 28, 'expected non-trivial solar warming; got ' + peakGh);
  });
});

describe('coefficient sanity gates', () => {
  const fitMod = require('../server/lib/forecast/sustain-forecast-fit.js');
  const { _bounds } = fitMod;

  function makeIdleHistory(out, ghStart, dGhPerSample, samples, rad) {
    const dtSec = 30;
    const readings = [];
    let gh = ghStart;
    for (let i = 0; i < samples; i++) {
      const ts = new Date(Date.UTC(2026, 4, 1) + i * dtSec * 1000);
      readings.push({ ts, greenhouse: gh, outdoor: out, tankTop: 30, tankBottom: 30, radiationGlobal: rad });
      gh = gh + dGhPerSample;
    }
    return { readings, modes: [{ ts: readings[0].ts, mode: 'idle' }] };
  }

  it('rejects τ_gh below the lower bound (would predict full cooling in <30 min)', () => {
    // Force the regression to find a steep slope: gh drops 1 K every 30 s
    // sample with (gh-out) ≈ 20 K. -d(gh)/dt = 120 K/h, dT = 20, slope ≈ 6,
    // τ ≈ 0.17 h — below GH_TAU_MIN_H=0.5.
    const h = makeIdleHistory(5, 25, -1, 60, 0);
    assert.equal(fitMod.fitGhTauNight(h), null);
    assert.ok(_bounds.GH_TAU_MIN_H >= 0.5);
  });

  it('rejects α below the lower bound (effectively no solar absorption)', () => {
    // α=0.001 → 700 W/m² gives 0.7 K/h, too small to matter.
    const dtSec = 30; const tauH = 2.0; const trueAlpha = 0.001;
    const readings = []; let gh = 12;
    for (let i = 0; i < 6 * 24 * 60 * 2; i++) {
      const ts = new Date(Date.UTC(2026, 4, 1) + i * dtSec * 1000);
      const hourOfDay = Math.floor(i / 120) % 24;
      const rad = hourOfDay >= 6 && hourOfDay < 18 ? 600 : 0;
      readings.push({ ts, greenhouse: gh, outdoor: 10, tankTop: 20, tankBottom: 20, radiationGlobal: rad });
      gh = gh + ((10 - gh) / tauH + trueAlpha * rad) * (dtSec / 3600);
    }
    const coeff = fitMod.fitEmpiricalCoefficients({
      readings, modes: [{ ts: readings[0].ts, mode: 'idle' }],
    });
    assert.equal(coeff.ghSolarAlphaCPerWm2, undefined,
      'α=0.001 should be rejected; got ' + coeff.ghSolarAlphaCPerWm2);
  });

  it('rejects radiator UA outside [40, 200] W/K and accepts 80 W/K', () => {
    // dTank/dt = UA·(tank-gh)·3600/MASS — physically integrate so UA
    // stays constant as ΔT shrinks (Newton's law of cooling).
    const dtSec = 30; const ghTemp = 12; const tankAvgInit = 25;
    const TANK_M = 300 * 4186;
    function makeHistory(uaWPerK) {
      const readings = []; let tank = tankAvgInit;
      for (let i = 0; i < 4 * 60 * 2; i++) {
        const ts = new Date(Date.UTC(2026, 4, 1) + i * dtSec * 1000);
        readings.push({ ts, greenhouse: ghTemp, outdoor: 5, tankTop: tank, tankBottom: tank, radiationGlobal: 0 });
        tank = tank - uaWPerK * Math.max(0, tank - ghTemp) * dtSec / TANK_M;
      }
      return { readings, modes: [{ ts: readings[0].ts, mode: 'greenhouse_heating' }] };
    }
    const ok = fitMod.fitRadiatorUaWPerK(makeHistory(80));
    assert.ok(ok !== null && Math.abs(ok - 80) / 80 < 0.1, 'expected ≈ 80, got ' + ok);
    assert.equal(fitMod.fitRadiatorUaWPerK(makeHistory(25)), null, 'UA=25 should be rejected');
    assert.equal(fitMod.fitRadiatorUaWPerK(makeHistory(250)), null, 'UA=250 should be rejected');
  });

  it('engine consumes coefficient.radiatorUaWPerK over the hardcoded 80', () => {
    // Lower UA → more heater kWh because radiator covers less GH loss.
    const now = Date.UTC(2026, 5, 1, 18, 0, 0);
    const weather = []; const prices = [];
    for (let h = 0; h < 48; h++) {
      const ts = new Date(now + h * 3600 * 1000).toISOString();
      weather.push({ ts, temperature: 0, radiationGlobal: 0, windSpeed: 1, precipitation: 0 });
      prices.push({ ts, priceCKwh: 5 });
    }
    const baseOpts = {
      now, tankTop: 25, tankBottom: 23, greenhouseTemp: 12,
      currentMode: 'idle', weather48h: weather, prices48h: prices,
      config: { spaceHeaterKw: 1, transferFeeCKwh: 5, greenhouseLossWPerK: 120,
        emergencyEnterC: 11, emergencyExitC: 12, greenhouseEnterC: 12, greenhouseExitC: 13 },
    };
    const high = computeSustainForecast(Object.assign({}, baseOpts, {
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0), radiatorUaWPerK: 100 },
    }));
    const low = computeSustainForecast(Object.assign({}, baseOpts, {
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: new Array(24).fill(0), radiatorUaWPerK: 50 },
    }));
    assert.ok(low.electricKwh > high.electricKwh,
      'low UA should project more heater: low=' + low.electricKwh + ' high=' + high.electricKwh);
  });
});
