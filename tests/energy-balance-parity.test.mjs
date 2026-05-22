// Parity guard for the energy code that is hand-mirrored across the
// client (playground/js/physics.js + energy-balance.js) and the server
// (server/lib/energy-balance.js). Those modules carry "keep in sync"
// comments but nothing enforced it — this test fails the moment a
// constant or the net-per-segment attribution rule diverges, the same
// way bootstrap-history-drift guards the control-logic snapshot.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { computeEnergyBalance } from '../playground/js/energy-balance.js';
import {
  tankStoredEnergyKwh as clientStored,
  tankKwhToDeltaC as clientDelta,
} from '../playground/js/physics.js';

const require = createRequire(import.meta.url);
const server = require('../server/lib/energy-balance.js');

test('scalar formulas are identical client ↔ server', () => {
  for (const t of [8, 12, 12.0001, 20, 30, 43.3, 55, NaN]) {
    assert.deepStrictEqual(
      clientStored(t), server.tankStoredEnergyKwh(t),
      'tankStoredEnergyKwh @' + t);
  }
  for (const k of [-3.2, 0, 0.05, 1, 6.3, 9.75, NaN]) {
    assert.deepStrictEqual(
      clientDelta(k), server.tankKwhToDeltaC(k),
      'tankKwhToDeltaC @' + k);
  }
});

const HOUR = 3600 * 1000;
const pt = (now, h, avg) => ({ ts: now - h * HOUR, tank_top: avg + 1, tank_bottom: avg - 1 });
const ev = (now, h, to) => ({ ts: now - h * HOUR, type: 'mode', to });

// The client splits a window into day/night sections; the server buckets
// the whole 24 h. With monotonic-within-segment data the net-per-segment
// attribution is additive across the split, so the client sections must
// sum to the server's daily buckets. Any divergence in the bucketing rule
// (sign handling, mode→bucket mapping, boundary attribution) breaks this.
function clientTotalsWh(bal) {
  const sum = (k) => (bal.night ? bal.night[k] : 0) + (bal.day ? bal.day[k] : 0);
  return {
    gatheredWh: sum('gatheredKwh') * 1000,
    heatingWh: sum('heatingKwh') * 1000,
    leakageWh: sum('leakageKwh') * 1000,
  };
}

function assertParity(label, points, events, now) {
  const c = clientTotalsWh(computeEnergyBalance(points, events, now));
  const s = server.computeDailyFromHistory(points, events, now);
  assert.ok(Math.abs(c.gatheredWh - s.gatheredWh) < 1e-6, label + ' gathered: ' + c.gatheredWh + ' vs ' + s.gatheredWh);
  assert.ok(Math.abs(c.heatingWh - s.heatingLossWh) < 1e-6, label + ' heating: ' + c.heatingWh + ' vs ' + s.heatingLossWh);
  assert.ok(Math.abs(c.leakageWh - s.leakageLossWh) < 1e-6, label + ' leakage: ' + c.leakageWh + ' vs ' + s.leakageLossWh);
}

test('bucketing parity: heating + idle + sensor noise', () => {
  const now = Date.parse('2026-05-01T12:00:00Z');
  const events = [ev(now, 23, 'idle'), ev(now, 18, 'greenhouse_heating'), ev(now, 17.5, 'idle')];
  // Monotonic within each segment; jitter only as small monotone steps so
  // the split stays additive while still exercising the noise paths.
  const points = [
    pt(now, 23, 30.4), pt(now, 20, 29.6),         // idle cooling
    pt(now, 18, 29.4),                            // heating begins
    pt(now, 17.7, 26), pt(now, 17.5, 24),         // heating drop
    pt(now, 12, 23.6), pt(now, 6, 22.8), pt(now, 0.05, 22), // idle cooling
  ];
  assertParity('heating+idle', points, events, now);
});

test('bucketing parity: solar charging then idle', () => {
  const now = Date.parse('2026-05-01T15:00:00Z');
  // Day must stay ongoing (last charge within DAY_GAP of now) so the
  // client's night+day sections partition the whole window — a completed
  // day would drop the pre-day idle, which the server still counts.
  const events = [ev(now, 23, 'idle'), ev(now, 8, 'solar_charging')];
  const points = [
    pt(now, 23, 20), pt(now, 8.1, 19.5),          // pre-charge idle
    pt(now, 8, 20), pt(now, 5, 30), pt(now, 0.05, 38), // charging climb to now
  ];
  assertParity('charging+idle', points, events, now);
});
