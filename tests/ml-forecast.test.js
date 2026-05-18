'use strict';

// Unit tests for the ML forecast engine and the random-forest model it
// runs on. Covers the random-forest regressor, the committed model
// artifact, and the computeMlForecast output contract.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const rf = require('../server/lib/forecast/ml/random-forest');
const { computeMlForecast } = require('../server/lib/forecast/ml/ml-forecast');
const { FEATURE_NAMES } = require('../server/lib/forecast/ml/features');

const MODEL_PATH = path.join(__dirname, '..', 'server/lib/forecast/ml/forecast-model.json.gz');

function loadModel() {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(MODEL_PATH)).toString('utf8'));
}

// 48 hourly weather rows; `sunny` toggles a daytime radiation profile.
function makeWeather(tempC, sunny) {
  const out = [];
  for (let h = 0; h < 48; h++) {
    const hod = h % 24;
    out.push({
      temperature: tempC,
      radiationGlobal: sunny && hod >= 8 && hod <= 17 ? 450 : 0,
      windSpeed: 3,
      precipitation: 0,
    });
  }
  return out;
}

function makePrices() {
  const out = [];
  for (let h = 0; h < 48; h++) out.push({ priceCKwh: 12 });
  return out;
}

test('random forest regression learns an additive function', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 400; i++) {
    const a = i % 20;
    const b = (i * 7) % 20;
    X.push([a, b]);
    y.push(a * 2 + b);
  }
  const model = rf.trainForest(X, y, { nTrees: 40, seed: 7 });
  const pred = rf.predictForest(model, [10, 10]);
  assert.ok(Math.abs(pred - 30) < 6, 'prediction ' + pred + ' should be near 30');
});

test('committed model artifact matches the feature contract', () => {
  const model = loadModel();
  assert.deepStrictEqual(model.featureNames, FEATURE_NAMES);
  assert.ok(model.tank && Array.isArray(model.tank.trees) && model.tank.trees.length > 0);
  assert.ok(model.greenhouse && Array.isArray(model.greenhouse.trees) && model.greenhouse.trees.length > 0);
  assert.strictEqual(model.tank.nFeatures, FEATURE_NAMES.length);
  assert.strictEqual(model.featureRanges.length, FEATURE_NAMES.length);
});

test('computeMlForecast returns the forecast-card contract', () => {
  const model = loadModel();
  const fc = computeMlForecast({
    now: new Date('2026-05-18T18:00:00Z'),
    tankTop: 36, tankBottom: 30, greenhouseTemp: 16,
    currentMode: 'idle',
    weather48h: makeWeather(9, true),
    prices48h: makePrices(),
    model,
  });
  assert.strictEqual(fc.engine, 'ml');
  assert.strictEqual(fc.horizonHours, 48);
  assert.strictEqual(fc.tankTrajectory.length, 49);
  assert.strictEqual(fc.greenhouseTrajectory.length, 49);
  assert.strictEqual(fc.modeForecast.length, 48);
  assert.ok(Array.isArray(fc.notes) && fc.notes.length > 0);
  assert.ok(['low', 'medium', 'high'].includes(fc.modelConfidence));
  assert.strictEqual(typeof fc.electricKwh, 'number');
  assert.strictEqual(typeof fc.electricCostEur, 'number');
  // First trajectory point reflects the supplied tank/greenhouse state.
  assert.strictEqual(fc.tankTrajectory[0].avg, 33);
  assert.strictEqual(fc.greenhouseTrajectory[0].temp, 16);
});

test('computeMlForecast throws without a loaded model', () => {
  assert.throws(() => computeMlForecast({
    now: Date.now(), weather48h: makeWeather(9, false), prices48h: makePrices(),
  }), /model not loaded/);
});

test('computeMlForecast flags a cold greenhouse as needing backup now', () => {
  const model = loadModel();
  const fc = computeMlForecast({
    now: new Date('2026-01-15T18:00:00Z'),
    tankTop: 20, tankBottom: 16, greenhouseTemp: 5,
    currentMode: 'emergency_heating',
    emergencyRecentlyActive: true,
    weather48h: makeWeather(-12, false),
    prices48h: makePrices(),
    model,
  });
  // Greenhouse already below the emergency-enter threshold → backup now.
  assert.strictEqual(fc.hoursUntilBackupNeeded, 0);
  assert.ok(fc.electricKwh > 0, 'expected backup electricity, got ' + fc.electricKwh);
  assert.ok(fc.modeForecast.some((m) => m.mode === 'emergency_heating'));
});

test('computeMlForecast reports low confidence on out-of-range inputs', () => {
  const model = loadModel();
  const fc = computeMlForecast({
    now: Date.now(),
    // A 200 degC tank is far outside any trained condition.
    tankTop: 202, tankBottom: 198, greenhouseTemp: 16,
    currentMode: 'idle',
    weather48h: makeWeather(9, false),
    prices48h: makePrices(),
    model,
  });
  assert.strictEqual(fc.modelConfidence, 'low');
  assert.ok(fc.notes.some((n) => /extrapolating/.test(n)));
});
