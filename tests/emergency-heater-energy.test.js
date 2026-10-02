'use strict';

// The space heater IS the emergency heater: one 1 kW fan heater with no
// thermostat of its own. The device turns it fully on when the
// greenhouse drops below the emergency-enter threshold and fully off once
// it climbs past the exit threshold (control-logic.js). So a forecast
// hour spent in emergency_heating with the heater on costs 1 kWh, and the
// projected backup energy must equal 1 kW × projected heater-on time.
//
// Regression (field report 2026-10-02): both forecast engines modelled
// the heater as a proportional "duty" sized to hold the midpoint of the
// enter/exit band. On a mild night (outdoor just below the greenhouse)
// that duty came out at ~5 %, the greenhouse never reached the exit
// threshold, and the chart showed the mode latched at 100 % for hours
// while the summary projected only ~0.7 kWh over 48 h.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { physicsStep } = require('../server/lib/forecast/physics-step.js');
const { computeSustainForecast } = require('../server/lib/forecast/sustain-forecast.js');
const { computeMlForecast } = require('../server/lib/forecast/ml/ml-forecast.js');
const { FEATURE_NAMES } = require('../server/lib/forecast/ml/features.js');

const HOUR_MS = 3600 * 1000;

function flatWeather(tempC) {
  const out = [];
  for (let h = 0; h < 48; h++) {
    out.push({
      validAt: new Date(Date.now() + h * HOUR_MS).toISOString(),
      temperature: tempC, radiationGlobal: 0, windSpeed: 3, precipitation: 0,
    });
  }
  return out;
}

function flatPrices() {
  const out = [];
  for (let h = 0; h < 48; h++) out.push({ priceCKwh: 10 });
  return out;
}

// Pure-physics ML model: leaf-only trees with a 0 residual.
function zeroModel() {
  const forest = { trees: [{ leaf: true, value: 0 }], nFeatures: FEATURE_NAMES.length };
  return { tank: forest, greenhouse: forest, featureRanges: [] };
}

// Heater-on hours implied by the modeForecast entries — the same rule
// the chart uses (aggregateForecastBucket): each entry spans until the
// next distinct timestamp, capped at 1 h, scaled by its duty (fraction
// of that span the heater ran).
function heaterOnHours(modeForecast, horizonEndMs) {
  let hours = 0;
  for (let i = 0; i < modeForecast.length; i++) {
    const e = modeForecast[i];
    if (e.mode !== 'emergency_heating') continue;
    const t = Date.parse(e.ts);
    let end = Math.min(horizonEndMs, t + HOUR_MS);
    for (let j = i + 1; j < modeForecast.length; j++) {
      const tj = Date.parse(modeForecast[j].ts);
      if (tj > t) { end = Math.min(end, tj); break; }
    }
    hours += e.duty * (end - t) / HOUR_MS;
  }
  return hours;
}

describe('physicsStep — emergency heater runs at full power until the exit threshold', () => {
  it('turns the heater off once the greenhouse passes the exit threshold', () => {
    // gh 12.5 inside the 12/13 band, outdoor 12: the proportional model
    // sized the heater at ~6 % for the whole hour. The real heater runs
    // at 1 kW (~4 K/h into the greenhouse) and passes 13 °C in minutes.
    const r = physicsStep({
      tankAvg: 12.5, gh: 12.5, outdoor: 12, radiation: 0,
      mode: 'emergency_heating', stepHours: 1, hourOfDayHelsinki: 2,
      cfg: { emergencyEnterC: 12, emergencyExitC: 13 },
    });
    assert.ok(r.heaterDuty > 0.1 && r.heaterDuty < 0.5,
      'heater should run flat out for part of the hour, got duty ' + r.heaterDuty);
    assert.equal(r.heaterOnAtEnd, false, 'heater must be off after passing the exit threshold');
    assert.ok(12.5 + r.dGhC > 12, 'greenhouse warmed by the heater');
  });

  it('keeps the heater fully on when it cannot reach the exit threshold', () => {
    const r = physicsStep({
      tankAvg: 8, gh: 8, outdoor: -10, radiation: 0,
      mode: 'emergency_heating', stepHours: 1, hourOfDayHelsinki: 2,
      cfg: { emergencyEnterC: 9, emergencyExitC: 12 },
    });
    assert.equal(r.heaterDuty, 1);
    assert.equal(r.heaterOnAtEnd, true);
  });

  it('reports no heater activity outside emergency mode', () => {
    const r = physicsStep({
      tankAvg: 8, gh: 8, outdoor: -10, radiation: 0,
      mode: 'idle', stepHours: 1, hourOfDayHelsinki: 2,
    });
    assert.equal(r.heaterDuty, 0);
    assert.equal(r.heaterOnAtEnd, false);
  });
});

describe('ML forecast — backup energy equals 1 kW × heater-on time', () => {
  // Mirrors the field report: tank no warmer than the greenhouse,
  // greenhouse just above the emergency-enter threshold, outdoor a few
  // tenths below. The probabilistic entry fires (P(gh < 12) ≈ 0.37).
  const fc = computeMlForecast({
    now: new Date('2026-10-02T00:00:00Z'),
    tankTop: 12.5, tankBottom: 12.5, greenhouseTemp: 12.5,
    currentMode: 'idle',
    weather48h: flatWeather(12),
    prices48h: flatPrices(),
    model: zeroModel(),
    config: { emergencyEnterC: 12, emergencyExitC: 13 },
  });
  const horizonEnd = Date.parse(fc.generatedAt) + 48 * HOUR_MS;

  it('never stays in emergency mode with the heater only partly on', () => {
    // A 5-min step followed by another emergency step means the heater
    // was latched on throughout → duty must be 1, not a proportional
    // sliver. (A 1-h tail step may legitimately cycle off and back on.)
    const em = fc.modeForecast;
    assert.ok(em.some((m) => m.mode === 'emergency_heating'), 'scenario must enter emergency');
    for (let i = 0; i < em.length - 1; i++) {
      const fine = Date.parse(em[i + 1].ts) - Date.parse(em[i].ts) <= 5 * 60 * 1000;
      if (fine && em[i].mode === 'emergency_heating' && em[i + 1].mode === 'emergency_heating') {
        assert.equal(em[i].duty, 1, 'latched emergency step at ' + em[i].ts + ' has duty ' + em[i].duty);
      }
    }
  });

  it('bills exactly 1 kW for every projected heater-on hour', () => {
    const onH = heaterOnHours(fc.modeForecast, horizonEnd);
    // duty is rounded to 2 decimals in modeForecast.
    assert.ok(Math.abs(fc.electricKwh - onH) <= 0.01 * Math.max(1, onH),
      'electricKwh ' + fc.electricKwh + ' vs heater-on hours ' + onH);
  });

  it('lets the greenhouse climb past the exit threshold under full heater power', () => {
    assert.ok(fc.greenhouseTrajectory.some((p) => p.temp > 13),
      'greenhouse never passed the 13 °C exit threshold');
  });
});

describe('physics forecast — backup energy equals 1 kW × heater-on time', () => {
  // Greenhouse just below the 12 °C enter threshold, outdoor 11.5,
  // cold tank. The proportional model held gh at ~12.5 with a 12 % duty
  // and stayed latched in emergency for all 48 hours.
  const fc = computeSustainForecast({
    now: Date.parse('2026-10-02T00:00:00Z'),
    tankTop: 11.8, tankBottom: 11.8, greenhouseTemp: 11.8,
    currentMode: 'idle',
    weather48h: flatWeather(11.5),
    prices48h: flatPrices(),
    coefficients: {},
    config: {
      spaceHeaterKw: 1, transferFeeCKwh: 5,
      emergencyEnterC: 12, emergencyExitC: 13,
      greenhouseLossWPerK: 120,
    },
  });
  const horizonEnd = Date.parse(fc.generatedAt) + 48 * HOUR_MS;
  const emergency = fc.modeForecast.filter((m) => m.mode === 'emergency_heating');

  it('exits emergency once the heater lifts the greenhouse past the exit threshold', () => {
    assert.ok(emergency.length > 0, 'scenario must enter emergency');
    assert.ok(emergency.length < 48,
      'emergency stayed latched for all 48 h (' + emergency.length + ' entries)');
  });

  it('bills exactly 1 kW for every projected heater-on hour', () => {
    const onH = heaterOnHours(fc.modeForecast, horizonEnd);
    // duty is rounded to 2 decimals in modeForecast.
    assert.ok(Math.abs(fc.electricKwh - onH) <= 0.01 * Math.max(1, onH),
      'electricKwh ' + fc.electricKwh + ' vs heater-on hours ' + onH);
  });
});
