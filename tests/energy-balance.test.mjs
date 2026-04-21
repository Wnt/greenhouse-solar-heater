// Tests for computeEnergyBalance — the pure function backing the
// "Today's balance" card on the Status view.

import test from 'node:test';
import assert from 'node:assert';
import {
  computeEnergyBalance,
  editorialDaySentence,
  editorialNightSentence,
  DAY_GAP_MS,
} from '../playground/js/energy-balance.js';
import { tankStoredEnergyKwh } from '../playground/js/physics.js';

// Helpers to build synthetic history
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function pt(tsMs, top, bottom) {
  return { ts: tsMs, tank_top: top, tank_bottom: bottom };
}
function modeEvt(tsMs, to) {
  return { ts: tsMs, type: 'mode', to };
}

test('returns nulls when fewer than 2 points', () => {
  const result = computeEnergyBalance([], [], Date.now());
  assert.strictEqual(result.night, null);
  assert.strictEqual(result.day, null);
});

test('night-only when no charging in window', () => {
  const t0 = Date.parse('2026-04-21T00:00:00Z');
  const points = [
    pt(t0, 40, 30),         // avg 35 °C
    pt(t0 + HOUR, 38, 28),  // avg 33 °C (slight cooling)
    pt(t0 + 2 * HOUR, 37, 27), // avg 32 °C
  ];
  const result = computeEnergyBalance(points, [], t0 + 2 * HOUR);
  assert.strictEqual(result.day, null);
  assert.ok(result.night);
  assert.strictEqual(result.night.complete, false);
  assert.ok(result.night.leakageKwh > 0);
  assert.strictEqual(result.night.heatingKwh, 0);
  assert.strictEqual(result.night.gatheredKwh, 0);
});

test('classifies heating-mode drops as heating loss', () => {
  const t0 = Date.parse('2026-04-21T00:00:00Z');
  const points = [
    pt(t0, 50, 40),
    pt(t0 + 30 * MIN, 46, 36),
    pt(t0 + 60 * MIN, 42, 32),
  ];
  const events = [modeEvt(t0 - HOUR, 'greenhouse_heating')];
  const result = computeEnergyBalance(points, events, t0 + 60 * MIN);
  assert.ok(result.night);
  assert.ok(result.night.heatingKwh > 0);
  assert.strictEqual(result.night.leakageKwh, 0);
});

test('detects a day from consecutive charging samples', () => {
  const t0 = Date.parse('2026-04-21T07:00:00Z');
  const tCharge = t0 + 2 * HOUR;
  const tPeak = t0 + 6 * HOUR;
  const points = [
    pt(t0, 30, 25),                // early morning idle
    pt(t0 + HOUR, 29, 24),         // cooling
    pt(tCharge, 30, 25),           // first charge
    pt(tCharge + HOUR, 40, 32),    // climbing
    pt(tPeak, 50, 42),             // peak
  ];
  const events = [
    modeEvt(t0 - HOUR, 'idle'),
    modeEvt(tCharge, 'solar_charging'),
    modeEvt(tPeak + 10 * MIN, 'idle'),
  ];
  const now = tPeak + 20 * MIN; // still inside the day window
  const result = computeEnergyBalance(points, events, now);
  assert.ok(result.day, 'expected day section');
  assert.strictEqual(result.day.complete, false);
  assert.ok(result.day.gatheredKwh > 0);
  assert.strictEqual(result.day.heatingKwh, 0);

  assert.ok(result.night, 'expected night section before day');
  assert.ok(result.night.leakageKwh > 0);
});

test('day is complete once more than DAY_GAP_MS since last charge', () => {
  const t0 = Date.parse('2026-04-21T08:00:00Z');
  const tCharge = t0 + HOUR;
  const tPeak = t0 + 4 * HOUR;
  const points = [
    pt(t0, 30, 25),
    pt(tCharge, 30, 25),
    pt(tCharge + HOUR, 42, 35),
    pt(tPeak, 50, 42),
    pt(tPeak + HOUR, 48, 40),        // post-peak cooling (still within gap)
    pt(tPeak + 3 * HOUR, 44, 36),    // well past DAY_GAP_MS
  ];
  const events = [
    modeEvt(tCharge, 'solar_charging'),
    modeEvt(tPeak, 'idle'),
  ];
  const now = tPeak + 3 * HOUR + 30 * MIN; // >2 h after last charge
  const result = computeEnergyBalance(points, events, now);
  assert.ok(result.day);
  assert.strictEqual(result.day.complete, true);
  assert.strictEqual(result.day.endTs, tPeak); // ends at last charge
  assert.ok(result.night, 'night should be ongoing after day closes');
  assert.strictEqual(result.night.complete, false);
  assert.strictEqual(result.night.startTs, tPeak);
  // Post-peak cooling becomes night leakage
  assert.ok(result.night.leakageKwh > 0);
});

test('collapses short idle gaps inside a single day', () => {
  const t0 = Date.parse('2026-04-21T09:00:00Z');
  const points = [
    pt(t0, 30, 25),                  // charge begins
    pt(t0 + HOUR, 38, 30),           // charging
    pt(t0 + 90 * MIN, 40, 32),       // brief idle stall
    pt(t0 + 2 * HOUR, 44, 35),       // charging again (30 min gap, < 2 h)
    pt(t0 + 3 * HOUR, 50, 40),       // peak
  ];
  const events = [
    modeEvt(t0, 'solar_charging'),
    modeEvt(t0 + 90 * MIN, 'idle'),
    modeEvt(t0 + 100 * MIN, 'solar_charging'),
    modeEvt(t0 + 3 * HOUR + MIN, 'idle'),
  ];
  const result = computeEnergyBalance(points, events, t0 + 3 * HOUR + 10 * MIN);
  assert.ok(result.day);
  assert.strictEqual(result.day.startTs, t0); // start at first charge
});

test('user-data sanity check: 21 Apr charging day', () => {
  // Rough reconstruction of the real 21-Apr pattern: charging starts at
  // 09:09, climbs to peak ~13:30, tank cools through the afternoon but
  // brief solar_charging bounces continue until 18:03. Viewed at 19:10
  // (1h 7min after last charge, still inside DAY_GAP_MS window — so the
  // "day" is still ongoing and covers the whole 09:09 → 19:10 sweep).
  const night0 = Date.parse('2026-04-20T19:29:00Z');
  const chargeStart = Date.parse('2026-04-21T09:09:00Z');
  const peak = Date.parse('2026-04-21T13:29:00Z');
  const lastCharge = Date.parse('2026-04-21T18:03:00Z');
  const evening = Date.parse('2026-04-21T19:10:00Z');
  const points = [
    pt(night0, 40.1, 33.5),                   // 36.8 avg
    pt(chargeStart - 20 * MIN, 35.7, 27.6),   // 31.65 avg (end of night)
    pt(chargeStart, 36.1, 33.8),              // 34.95 avg
    pt(peak, 51.6, 48.8),                     // 50.2 avg
    pt(lastCharge, 48.9, 45.6),               // ~47.25 avg (afternoon cooling between bounces)
    pt(evening, 47.3, 38.7),                  // 43.0 avg
  ];
  const events = [
    modeEvt(night0 - HOUR, 'idle'),
    modeEvt(chargeStart, 'solar_charging'),
    modeEvt(lastCharge, 'idle'), // transitions out of charging for the last time
  ];
  const result = computeEnergyBalance(points, events, evening);
  assert.ok(result.night, 'need a night section');
  assert.ok(result.day, 'need a day section');
  assert.strictEqual(result.day.complete, false, 'day is still ongoing');

  // Night leakage ≈ 1.79 kWh (overnight drop 36.8 → 31.65 avg)
  assert.ok(result.night.leakageKwh > 1.5 && result.night.leakageKwh < 2.1,
    'night leakage ' + result.night.leakageKwh);

  // Day breakdown over 09:09 → 19:10 (boundary-delta p1→p2 counts toward
  // night because nightEnd == dayStart):
  //   gathered ≈ 5.33 kWh (34.95 → 50.2 avg at peak, inside the day range)
  //   leakage  ≈ 2.52 kWh (50.2 → 43.0 avg, post-peak cooling)
  //   net      ≈ +2.81 kWh
  assert.ok(result.day.gatheredKwh > 5 && result.day.gatheredKwh < 6,
    'day gathered ' + result.day.gatheredKwh);
  assert.ok(result.day.leakageKwh > 2.3 && result.day.leakageKwh < 2.7,
    'day leakage ' + result.day.leakageKwh);
  assert.ok(Math.abs(result.day.netKwh - 2.81) < 0.3,
    'day net ' + result.day.netKwh);
});

test('DAY_GAP_MS is exported and sensible (≥ 1 h, ≤ 3 h)', () => {
  assert.ok(DAY_GAP_MS >= HOUR);
  assert.ok(DAY_GAP_MS <= 3 * HOUR);
});

test('editorial sentences adapt to the content', () => {
  // Pure leakage night
  const sleepyNight = { heatingKwh: 0, leakageKwh: 1.5, gatheredKwh: 0 };
  assert.match(editorialNightSentence(sleepyNight), /rested without the sun/);

  // Heating-active night
  const warmNight = { heatingKwh: 2.0, leakageKwh: 0.3, gatheredKwh: 0 };
  assert.match(editorialNightSentence(warmNight), /drew warmth.*slipped to air/);

  // Sunny day
  const sunnyDay = { gatheredKwh: 6.5, heatingKwh: 0, leakageKwh: 2.5, netKwh: 4 };
  assert.match(editorialDaySentence(sunnyDay), /gathered warmth.*slipped/);

  // Cloudy day
  const cloudyDay = { gatheredKwh: 0, heatingKwh: 0, leakageKwh: 1.4, netKwh: -1.4 };
  assert.match(editorialDaySentence(cloudyDay), /No sun/);

  // Flat
  const stillDay = { gatheredKwh: 0.01, heatingKwh: 0.01, leakageKwh: 0.02, netKwh: 0 };
  assert.match(editorialDaySentence(stillDay), /still day/);
});
