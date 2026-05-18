'use strict';

// Accuracy-tuning regression tests for the sustain-forecast engine:
// tank destratification, the greenhouse-heating thermostat, and the
// self-calibrating solar cloud reference. Split from
// sustain-forecast.test.js to keep both files under the file-size cap.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  fitEmpiricalCoefficients,
  computeSustainForecast,
} = require('../server/lib/forecast/sustain-forecast.js');
const { fitCloudReferenceWm2 } = require('../server/lib/forecast/sustain-forecast-fit.js');

function makeWeather48h(overrides) {
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

// ── Tank destratification ──
// The step-4 solar skew (60/40 top/bottom) and any other per-layer
// asymmetry would otherwise let the tank top/bottom split grow without
// bound over a 48 h sim. Real tanks mix: observed tank_top − tank_bottom
// stays ~1.5 K (14 d median 1.3, p90 3.4) and relaxes within hours.
describe('computeSustainForecast — tank destratification', () => {
  const baseOpts = {
    now: Date.UTC(2026, 4, 18, 18, 0, 0),
    tankTop: 60, tankBottom: 20, greenhouseTemp: 12, currentMode: 'idle',
    weather48h: makeWeather48h({ temperature: 5 }),
    prices48h: makePrices48h(),
    coefficients: { tankLeakageWPerK: 3, usedDefaults: false },
  };

  it('relaxes an extreme top/bottom spread toward equilibrium within hours', () => {
    const result = computeSustainForecast(baseOpts);
    const traj = result.tankTrajectory;
    assert.ok((traj[0].top - traj[0].bottom) > 30, 'starts strongly stratified');
    assert.ok((traj[6].top - traj[6].bottom) < 6,
      'spread relaxes within 6 h; got ' + (traj[6].top - traj[6].bottom));
  });

  it('conserves the tank average — mixing only moves heat between layers', () => {
    const withMix = computeSustainForecast(baseOpts);
    const noMix   = computeSustainForecast(Object.assign({}, baseOpts, {
      config: { tankMixTauH: 0 },
    }));
    for (let i = 0; i < withMix.tankTrajectory.length; i++) {
      assert.ok(Math.abs(withMix.tankTrajectory[i].avg - noMix.tankTrajectory[i].avg) < 1e-6,
        'avg identical with/without mixing at h=' + i);
    }
    // tankMixTauH:0 disables destratification — spread stays wide.
    assert.ok((noMix.tankTrajectory[6].top - noMix.tankTrajectory[6].bottom) > 30,
      'disabled mixing keeps the spread');
  });
});

// ── Greenhouse heating thermostat ──
// The real controller cycles the radiator bang-bang to hold the
// greenhouse inside [geT, gxT]. Projecting a full hour of constant
// radiator output overshoots the ~1 K exit band by many K and makes
// the trajectory sawtooth instead of holding the band flat.
describe('computeSustainForecast — greenhouse heating holds the band', () => {
  it('does not overshoot the exit threshold during sustained radiator heating', () => {
    const result = computeSustainForecast({
      now: Date.UTC(2026, 4, 18, 18, 0, 0),
      tankTop: 55, tankBottom: 50, greenhouseTemp: 12.5,
      currentMode: 'greenhouse_heating',
      weather48h: makeWeather48h({ temperature: 2 }),
      prices48h: makePrices48h(),
      coefficients: { tankLeakageWPerK: 3, radiatorUaWPerK: 120, usedDefaults: false },
      config: { greenhouseEnterC: 13, greenhouseExitC: 14,
        emergencyEnterC: 9, emergencyExitC: 12 },
    });
    const peak = Math.max.apply(null, result.greenhouseTrajectory.map(p => p.temp));
    // A full hour of unthrottled radiator output blows past 18 °C; the
    // thermostat must cap the greenhouse close to the 14 °C exit point.
    assert.ok(peak < 15.5, 'greenhouse held near the band; peak=' + peak);
  });
});

// ── Self-calibrating cloud reference ──
// The solar credit is solarGainKwhByHour × radiation / cloudReferenceWm2.
// The reference must match the radiation the baseline was built from, or
// the credit is biased. The fit emits a gain-weighted mean and the engine
// honours it over the seed default.
describe('computeSustainForecast — fitted cloud reference', () => {
  it('fitCloudReferenceWm2 emits the gain-weighted charging radiation', () => {
    const base = Date.UTC(2026, 4, 1, 9, 0, 0);
    const readings = [];
    for (let i = 0; i < 8; i++) {
      readings.push({ ts: new Date(base + i * 10 * 60000),
        tankTop: 30 + i, tankBottom: 28 + i, greenhouse: 14, outdoor: 8,
        radiationGlobal: 600 });
    }
    const history = { readings, modes: [{ ts: new Date(base - 60000), mode: 'solar_charging' }] };
    assert.equal(Math.round(fitCloudReferenceWm2(history)), 600);
    assert.equal(Math.round(fitEmpiricalCoefficients(history).cloudReferenceWm2), 600);
  });

  it('returns null when there are no charging hours to measure', () => {
    assert.equal(fitCloudReferenceWm2({ readings: [], modes: [] }), null);
  });

  it('a higher coefficient cloudReferenceWm2 credits less solar gain', () => {
    const base = {
      now: Date.UTC(2026, 4, 18, 9, 0, 0),
      tankTop: 30, tankBottom: 28, greenhouseTemp: 15, currentMode: 'idle',
      weather48h: makeWeather48h({ temperature: 10, radiationGlobal: 600 }),
      prices48h: makePrices48h(),
    };
    const sg = new Array(24).fill(0.4);
    const lowRef  = computeSustainForecast(Object.assign({}, base, {
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: sg, cloudReferenceWm2: 400 } }));
    const highRef = computeSustainForecast(Object.assign({}, base, {
      coefficients: { tankLeakageWPerK: 3, solarGainKwhByHour: sg, cloudReferenceWm2: 800 } }));
    const lowEnd  = lowRef.tankTrajectory[12].avg;
    const highEnd = highRef.tankTrajectory[12].avg;
    assert.ok(lowEnd > highEnd + 2,
      'lower cloud reference credits more solar: low=' + lowEnd + ' high=' + highEnd);
  });
});
