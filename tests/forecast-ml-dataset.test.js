'use strict';

// Regression: a sensor that drops out for part of the 30-day training
// window leaves buckets with a missing reading (pivotReadings omits the
// key, so the value is `undefined`). buildDataset must NOT turn those
// into NaN training targets — a NaN ΔT poisons random-forest leaves, and
// the resulting model emits NaN predictions at serving time (the
// "ML forecast unavailable" 500). Samples straddling a missing reading
// are dropped, exactly like the existing sensor-gap handling.

const { test } = require('node:test');
const assert = require('node:assert');
const { buildDataset } = require('../scripts/forecast-ml/dataset.js');

const HOUR = 3600000;
const BASE = Date.parse('2026-05-01T00:00:00Z');

// 5-min sensor points over `hours`, with the greenhouse sensor missing
// for the buckets in [gapStartMs, gapEndMs] to simulate an offline node.
function buildPayload(hours, gapStartMs, gapEndMs) {
  const points = [];
  for (let ms = 0; ms <= hours * HOUR; ms += 5 * 60 * 1000) {
    const p = {
      ts: BASE + ms,
      tank_top: 45,
      tank_bottom: 38,
      outdoor: 5,
    };
    const inGap = ms >= gapStartMs && ms <= gapEndMs;
    if (!inGap) p.greenhouse = 15;
    points.push(p);
  }
  const weather = [];
  for (let h = 0; h <= hours; h++) {
    weather.push({
      validAt: new Date(BASE + h * HOUR).toISOString(),
      temperature: 5,
      radiationGlobal: 100,
      windSpeed: 2,
      precipitation: 0,
    });
  }
  return { points, weather, events: [], actuators: [], overlays: [], generations: [] };
}

test('buildDataset produces only finite features and targets', () => {
  // Greenhouse sensor offline for ~30 min in the middle of the window.
  const data = buildDataset(buildPayload(3, 1 * HOUR, 1 * HOUR + 30 * 60 * 1000));

  assert.ok(data.X.length > 0, 'should still yield samples away from the gap');
  assert.strictEqual(data.X.length, data.yTank.length);
  assert.strictEqual(data.X.length, data.yGh.length);

  for (let i = 0; i < data.X.length; i++) {
    assert.ok(data.X[i].every(Number.isFinite),
      'feature row ' + i + ' has a non-finite value: ' + JSON.stringify(data.X[i]));
    assert.ok(Number.isFinite(data.yTank[i]), 'yTank[' + i + '] non-finite');
    assert.ok(Number.isFinite(data.yGh[i]), 'yGh[' + i + '] non-finite');
  }
});

test('buildDataset still trains a clean window with no gaps', () => {
  const data = buildDataset(buildPayload(3, -1, -1)); // no gap
  assert.ok(data.X.length > 0);
  for (let i = 0; i < data.X.length; i++) {
    assert.ok(data.X[i].every(Number.isFinite));
    assert.ok(Number.isFinite(data.yTank[i]) && Number.isFinite(data.yGh[i]));
  }
});
