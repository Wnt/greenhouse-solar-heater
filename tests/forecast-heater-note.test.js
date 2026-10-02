'use strict';

// The forecast card's first note must say WHEN the space heater is
// expected to switch on. It used to report the 48 h greenhouse minimum
// ("Greenhouse cools to 12.3 °C around 03:52, when the space heater
// takes over"), which is just the bottom of some heater cycle once the
// forecast models the heater bang-bang — on a night the heater was
// already cycling, it named 03:52 the next night (field report
// 2026-10-02).

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { heaterStartNote } = require('../server/lib/forecast/sustain-forecast-notes.js');
const { computeSustainForecast } = require('../server/lib/forecast/sustain-forecast.js');
const { computeMlForecast } = require('../server/lib/forecast/ml/ml-forecast.js');
const { FEATURE_NAMES } = require('../server/lib/forecast/ml/features.js');

const HOUR = 3600 * 1000;
// 2026-10-02 21:00 Helsinki (EEST, UTC+3).
const NOW = Date.parse('2026-10-02T18:00:00Z');

function iso(ms) { return new Date(ms).toISOString(); }

describe('heaterStartNote', () => {
  const traj = [
    { ts: iso(NOW), temp: 12.3 },
    { ts: iso(NOW + HOUR), temp: 12.6 },
    { ts: iso(NOW + 5 * HOUR), temp: 11.9 },
    { ts: iso(NOW + 30 * HOUR), temp: 11.8 },
  ];

  it('says "now" when the heater is on from the first step', () => {
    const note = heaterStartNote(
      [{ ts: iso(NOW), mode: 'emergency_heating', duty: 1 }], traj, NOW);
    assert.equal(note, 'Space heater is cycling on from now — greenhouse at 12.3 °C.');
  });

  it('gives the first switch-on time and the greenhouse temperature then', () => {
    const note = heaterStartNote([
      { ts: iso(NOW), mode: 'idle' },
      { ts: iso(NOW + 5 * HOUR), mode: 'emergency_heating', duty: 0.25 },
      { ts: iso(NOW + 30 * HOUR), mode: 'emergency_heating', duty: 1 },
    ], traj, NOW);
    assert.equal(note,
      'Greenhouse cools to 11.9 °C around 02:00, when the space heater first switches on.');
  });

  it('marks a switch-on time beyond the next midnight with its day', () => {
    const note = heaterStartNote([
      { ts: iso(NOW + 30 * HOUR), mode: 'emergency_heating', duty: 1 },
    ], traj, NOW);
    // NOW + 30 h = Sun 2026-10-04 03:00 Helsinki — two calendar days out.
    assert.equal(note,
      'Greenhouse cools to 11.8 °C around Sun 03:00, when the space heater first switches on.');
  });

  it('ignores emergency entries where the heater never ran', () => {
    const note = heaterStartNote([
      { ts: iso(NOW), mode: 'emergency_heating', duty: 0 },
      { ts: iso(NOW + 5 * HOUR), mode: 'emergency_heating', duty: 0.5 },
    ], traj, NOW);
    assert.match(note, /around 02:00, when the space heater first switches on/);
  });

  it('returns null when the heater never runs', () => {
    assert.equal(heaterStartNote([{ ts: iso(NOW), mode: 'idle' }], traj, NOW), null);
  });
});

function flatWeather(tempC) {
  const out = [];
  for (let h = 0; h < 48; h++) out.push({ temperature: tempC, radiationGlobal: 0, windSpeed: 3, precipitation: 0 });
  return out;
}
function flatPrices() {
  const out = [];
  for (let h = 0; h < 48; h++) out.push({ priceCKwh: 10 });
  return out;
}

describe('forecast notes lead with the heater switch-on time', () => {
  it('ML engine: heater cycling from the first step reads "from now"', () => {
    const forest = { trees: [{ leaf: true, value: 0 }], nFeatures: FEATURE_NAMES.length };
    const fc = computeMlForecast({
      now: new Date(NOW),
      tankTop: 12.5, tankBottom: 12.5, greenhouseTemp: 12.3,
      currentMode: 'idle',
      weather48h: flatWeather(12),
      prices48h: flatPrices(),
      model: { tank: forest, greenhouse: forest, featureRanges: [] },
      config: { emergencyEnterC: 12, emergencyExitC: 13.5 },
    });
    assert.ok(fc.notes.includes('Space heater is cycling on from now — greenhouse at 12.3 °C.'),
      JSON.stringify(fc.notes));
  });

  it('physics engine: names the hour the heater first switches on', () => {
    const fc = computeSustainForecast({
      now: NOW,
      tankTop: 12, tankBottom: 12, greenhouseTemp: 13,
      currentMode: 'idle',
      weather48h: flatWeather(8),
      prices48h: flatPrices(),
      coefficients: {},
      config: { spaceHeaterKw: 1, transferFeeCKwh: 5, emergencyEnterC: 12, emergencyExitC: 13.5 },
    });
    const first = fc.modeForecast.find((m) => m.mode === 'emergency_heating' && m.duty > 0);
    assert.ok(first, 'scenario must switch the heater on');
    assert.ok(Date.parse(first.ts) > NOW, 'heater starts after the first hour');
    assert.ok(fc.notes.some((n) => /when the space heater first switches on\.$/.test(n)),
      JSON.stringify(fc.notes));
  });
});
