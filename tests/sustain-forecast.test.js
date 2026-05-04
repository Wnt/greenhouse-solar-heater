'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fitEmpiricalCoefficients,
  computeSustainForecast,
  _TANK_THERMAL_MASS_J_PER_K,
} = require('../server/lib/sustain-forecast.js');
const { fitSolarGainByHour } = require('../server/lib/sustain-forecast-fit.js');

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

    const result = computeSustainForecast({
      now:            Date.now(),
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
  it('uses cfg.emergencyExitC, not emergencyEnterC + 2', () => {
    // Pick non-trivial values: ehE=8, ehX=15 (much higher than ehE+2=10).
    // Cold outdoor + cold tank → backup triggers and gh drifts toward
    // (8+15)/2 = 11.5 °C, not the old (8+1) = 9 °C target.
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
    // After several backup-mode hours, gh should reach the (8+15)/2=11.5 midpoint.
    const lateGh = result.greenhouseTrajectory[10].temp;
    assert.ok(Math.abs(lateGh - 11.5) < 1,
      'expected gh ≈ 11.5 °C after backup hysteresis settles; got ' + lateGh);
  });
});

// Regression test for the undefined-threshold bug. The forecast handler used to
// pass `tuning.greenhouseEnterTemp` etc. where `effectiveTuning` actually
// returns `tuning.geT` — so all three thresholds were undefined. With the
// previous Object.assign, undefined overwrote DEFAULT_CONFIG, and every
// `curGhTemp < cfg.emergencyEnterC` comparison was false → backup never fired
// → the card showed "Tank lasts 48+ h, Backup 0 kWh" while greenhouse drifted
// down to outdoor (~5 °C). Pinning this so a future regression surfaces in CI.
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
