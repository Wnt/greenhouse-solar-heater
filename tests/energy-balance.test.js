const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  tankStoredEnergyKwh,
  computeOvernightFromHistory,
  computeDailyFromHistory,
  computeOvernightStats,
  computeDailyStats,
} = require('../server/lib/energy-balance.js');

describe('energy-balance', () => {
  describe('tankStoredEnergyKwh', () => {
    it('clamps below 12 °C to 0', () => {
      assert.strictEqual(tankStoredEnergyKwh(8), 0);
      assert.strictEqual(tankStoredEnergyKwh(12), 0);
    });

    it('matches Q = 300 · 4.186 · ΔT / 3600', () => {
      // avg 30 °C → ΔT = 18 → ≈6.279 kWh
      const e = tankStoredEnergyKwh(30);
      assert.ok(e > 6.2 && e < 6.3, 'energy=' + e);
    });

    it('returns 0 for non-finite input', () => {
      assert.strictEqual(tankStoredEnergyKwh(NaN), 0);
      assert.strictEqual(tankStoredEnergyKwh(undefined), 0);
    });
  });

  describe('computeOvernightFromHistory', () => {
    // Build a synthetic overnight: tank starts at 30°C avg, heating runs
    // from 22:00 to 06:00, tank cools to 16°C avg. Then idle leakage
    // until noon, dropping another 1°C. Sample density inside heating
    // is dense enough that no single delta straddles the mode transition
    // (matches production 30 s sampling).
    function buildScenario(now) {
      const HOUR = 3600 * 1000;
      const heatingStart = now - 14 * HOUR;  // 22:00 yesterday
      const heatingEnd = now - 6 * HOUR;     // 06:00 today
      const events = [
        { ts: now - 18 * HOUR, type: 'mode', to: 'idle' },
        { ts: heatingStart, type: 'mode', to: 'greenhouse_heating' },
        { ts: heatingEnd, type: 'mode', to: 'idle' },
      ];
      const points = [];
      // Pre-window leading edge
      points.push({ ts: now - 19 * HOUR, tank_top: 31, tank_bottom: 29 });
      // Pre-heating, tank at 30 avg
      points.push({ ts: now - 15 * HOUR, tank_top: 31, tank_bottom: 29 });
      // Heating start, same temp
      points.push({ ts: heatingStart, tank_top: 31, tank_bottom: 29 });
      // Quarter-way: avg 25
      points.push({ ts: now - 12 * HOUR, tank_top: 26, tank_bottom: 24 });
      // Half-way: avg 23
      points.push({ ts: now - 10 * HOUR, tank_top: 24, tank_bottom: 22 });
      // Three-quarter: avg 20
      points.push({ ts: now - 8 * HOUR, tank_top: 21, tank_bottom: 19 });
      // Last sample fully inside heating: avg 16 (14 K total drop from 30)
      points.push({ ts: heatingEnd - 60 * 1000, tank_top: 17, tank_bottom: 15 });
      // Mode-transition sample, same temp (no delta credited to idle)
      points.push({ ts: heatingEnd, tank_top: 17, tank_bottom: 15 });
      // Idle leakage — drop 1 K to 15 avg
      points.push({ ts: now - 3 * HOUR, tank_top: 16, tank_bottom: 14 });
      points.push({ ts: now, tank_top: 16, tank_bottom: 14 });
      return { points, events };
    }

    it('credits drops during greenhouse_heating to heating bucket and computes duration', () => {
      const now = Date.now();
      const { points, events } = buildScenario(now);

      const stats = computeOvernightFromHistory(points, events, now);

      // 8 hours of heating (22:00 → 06:00)
      assert.strictEqual(stats.durationMinutes, 480, 'durationMinutes=' + stats.durationMinutes);

      // Heating loss: tank drops 14 K (30 → 16 avg) during heating mode.
      // Q = 300 × 4.186 × 14 / 3600 ≈ 4.884 kWh = 4884 Wh
      assert.ok(
        stats.heatingLossWh > 4700 && stats.heatingLossWh < 5000,
        'heatingLossWh=' + stats.heatingLossWh
      );
      // Leakage loss: 1 K drop (16 → 15 avg) during idle.
      // Q = 300 × 4.186 × 1 / 3600 ≈ 0.349 kWh = 349 Wh
      assert.ok(
        stats.leakageLossWh > 250 && stats.leakageLossWh < 450,
        'leakageLossWh=' + stats.leakageLossWh
      );
    });

    it('returns zero stats when no events and no points are in window', () => {
      const now = Date.now();
      const stats = computeOvernightFromHistory([], [], now);
      assert.strictEqual(stats.durationMinutes, 0);
      assert.strictEqual(stats.heatingLossWh, 0);
      assert.strictEqual(stats.leakageLossWh, 0);
    });

    it('clips heating segment that started before window to windowStart', () => {
      const now = Date.now();
      const HOUR = 3600 * 1000;
      // Heating started 25 h ago (before the 18 h window) and ended 4 h ago.
      // Only the in-window slice should count: 18 h - 4 h = 14 h.
      const events = [
        { ts: now - 25 * HOUR, type: 'mode', to: 'greenhouse_heating' },
        { ts: now - 4 * HOUR, type: 'mode', to: 'idle' },
      ];
      const stats = computeOvernightFromHistory([], events, now);
      assert.strictEqual(stats.durationMinutes, 14 * 60, 'durationMinutes=' + stats.durationMinutes);
    });

    it('caps an open heating segment at "now"', () => {
      const now = Date.now();
      const HOUR = 3600 * 1000;
      // Heating started 5 h ago and is still active.
      const events = [
        { ts: now - 5 * HOUR, type: 'mode', to: 'greenhouse_heating' },
      ];
      const stats = computeOvernightFromHistory([], events, now);
      assert.strictEqual(stats.durationMinutes, 5 * 60, 'durationMinutes=' + stats.durationMinutes);
    });

    it('computeOvernightStats fetches both queries and returns stats', () => {
      const now = Date.now();
      const { points, events } = buildScenario(now);
      const mockDb = {
        getHistory: function (range, sensor, cb) { cb(null, points); },
        getEvents: function (range, entityType, cb) { cb(null, events); },
      };
      return new Promise(function (resolve, reject) {
        computeOvernightStats(mockDb, now, function (err, stats) {
          if (err) { reject(err); return; }
          try {
            assert.ok(stats.durationMinutes > 400);
            assert.ok(stats.heatingLossWh > 4000);
            resolve();
          } catch (e) { reject(e); }
        });
      });
    });

    it('computeOvernightStats surfaces db errors', () => {
      const now = Date.now();
      const mockDb = {
        getHistory: function (range, sensor, cb) { cb(new Error('boom')); },
        getEvents: function () { assert.fail('should not be called'); },
      };
      return new Promise(function (resolve) {
        computeOvernightStats(mockDb, now, function (err) {
          assert.ok(err);
          assert.strictEqual(err.message, 'boom');
          resolve();
        });
      });
    });

    it('computeOvernightStats rejects when db is absent', () => {
      return new Promise(function (resolve) {
        computeOvernightStats(null, Date.now(), function (err) {
          assert.ok(err);
          assert.strictEqual(err.message, 'db_unavailable');
          resolve();
        });
      });
    });
  });

  describe('computeDailyFromHistory', () => {
    // A representative day: tank starts at 16°C (1.40 kWh), solar pulse
    // mid-morning brings it to 30°C (6.28 kWh = +4.88 kWh gathered),
    // afternoon idle leakage drops 1 K (−0.35 kWh), evening greenhouse
    // heating drops 4 K (−1.40 kWh).
    function buildDayScenario(now) {
      const HOUR = 3600 * 1000;
      const events = [
        { ts: now - 25 * HOUR, type: 'mode', to: 'idle' },
        { ts: now - 10 * HOUR, type: 'mode', to: 'solar_charging' },
        { ts: now - 7 * HOUR, type: 'mode', to: 'idle' },
        { ts: now - 3 * HOUR, type: 'mode', to: 'greenhouse_heating' },
      ];
      const points = [];
      // Pre-window leading edge
      points.push({ ts: now - 26 * HOUR, tank_top: 17, tank_bottom: 15 });
      // First in-window: avg 16
      points.push({ ts: now - 23 * HOUR, tank_top: 17, tank_bottom: 15 });
      // Pre-charge: avg 16
      points.push({ ts: now - 11 * HOUR, tank_top: 17, tank_bottom: 15 });
      // Solar charge climbing: avg 23
      points.push({ ts: now - 8 * HOUR - 30 * 60 * 1000, tank_top: 24, tank_bottom: 22 });
      // Solar charge peak (still in solar_charging): avg 30
      points.push({ ts: now - 7 * HOUR - 60 * 1000, tank_top: 31, tank_bottom: 29 });
      // Mode flips to idle, no temp change yet
      points.push({ ts: now - 7 * HOUR, tank_top: 31, tank_bottom: 29 });
      // Afternoon idle leakage: avg 29
      points.push({ ts: now - 3 * HOUR - 60 * 1000, tank_top: 30, tank_bottom: 28 });
      // Mode flips to greenhouse_heating, no temp change
      points.push({ ts: now - 3 * HOUR, tank_top: 30, tank_bottom: 28 });
      // Evening heating drop: avg 25
      points.push({ ts: now, tank_top: 26, tank_bottom: 24 });
      return { points, events };
    }

    it('credits solar deltas to gathered, heating to heating, idle to leakage', () => {
      const now = Date.now();
      const { points, events } = buildDayScenario(now);

      const stats = computeDailyFromHistory(points, events, now);

      // Gathered: avg 16 → avg 30 = +14 K → ≈4884 Wh
      assert.ok(
        stats.gatheredWh > 4700 && stats.gatheredWh < 5000,
        'gatheredWh=' + stats.gatheredWh
      );
      // Idle leakage: avg 30 → avg 29 = −1 K → ≈349 Wh
      assert.ok(
        stats.leakageLossWh > 250 && stats.leakageLossWh < 450,
        'leakageLossWh=' + stats.leakageLossWh
      );
      // Heating: avg 29 → avg 25 = −4 K → ≈1395 Wh
      assert.ok(
        stats.heatingLossWh > 1300 && stats.heatingLossWh < 1500,
        'heatingLossWh=' + stats.heatingLossWh
      );
    });

    it('returns zero stats with empty inputs', () => {
      const now = Date.now();
      const stats = computeDailyFromHistory([], [], now);
      assert.strictEqual(stats.gatheredWh, 0);
      assert.strictEqual(stats.heatingLossWh, 0);
      assert.strictEqual(stats.leakageLossWh, 0);
    });

    it('computeDailyStats fetches both queries and returns stats', () => {
      const now = Date.now();
      const { points, events } = buildDayScenario(now);
      const mockDb = {
        getHistory: function (range, sensor, cb) { cb(null, points); },
        getEvents: function (range, entityType, cb) { cb(null, events); },
      };
      return new Promise(function (resolve, reject) {
        computeDailyStats(mockDb, now, function (err, stats) {
          if (err) { reject(err); return; }
          try {
            assert.ok(stats.gatheredWh > 4000);
            assert.ok(stats.heatingLossWh > 1000);
            resolve();
          } catch (e) { reject(e); }
        });
      });
    });
  });
});
