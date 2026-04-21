// Tests for tankStoredEnergyKwh — the formula backing the "Energy Stored"
// card on the Status view and the Daily Solar Report notification.
//
// Formula: Q = m · c · ΔT
//   m  = 300 kg (300 L of water)
//   c  = 4.186 kJ/(kg·K)
//   ΔT = max(0, tankAvg − 12 °C)

import test from 'node:test';
import assert from 'node:assert';
import { tankStoredEnergyKwh } from '../playground/js/physics.js';

test('returns 0 at the base temperature', () => {
  assert.strictEqual(tankStoredEnergyKwh(12), 0);
});

test('returns 0 below the base temperature (never negative)', () => {
  assert.strictEqual(tankStoredEnergyKwh(5), 0);
  assert.strictEqual(tankStoredEnergyKwh(-10), 0);
});

test('300 L × 4.186 kJ/kg·K × ΔT / 3600 at 43 °C avg', () => {
  // 300 × 4.186 × 31 / 3600 ≈ 10.813 kWh
  const kwh = tankStoredEnergyKwh(43);
  assert.ok(Math.abs(kwh - 10.813) < 0.01, 'kwh=' + kwh);
});

test('scales linearly with ΔT', () => {
  const low = tankStoredEnergyKwh(22);  // ΔT=10
  const high = tankStoredEnergyKwh(32); // ΔT=20
  assert.ok(Math.abs(high - 2 * low) < 1e-9);
});

test('full-tank reference (90 °C avg)', () => {
  // 300 × 4.186 × 78 / 3600 ≈ 27.21 kWh
  const kwh = tankStoredEnergyKwh(90);
  assert.ok(Math.abs(kwh - 27.209) < 0.01, 'kwh=' + kwh);
});
