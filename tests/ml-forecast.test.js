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

// 48 hourly rows with a flat radiation value — for gate-threshold tests.
function flatWeather(tempC, radiation) {
  const out = [];
  for (let h = 0; h < 48; h++) {
    out.push({ temperature: tempC, radiationGlobal: radiation, windSpeed: 3, precipitation: 0 });
  }
  return out;
}

// Stub forests make the rollout deterministic: leaf-only trees add a
// fixed residual (0 → pure physics), and multi-value stubs give a
// controlled per-tree spread for the probabilistic-emergency tests.
function stubForest(values) {
  return {
    trees: values.map((v) => ({ leaf: true, value: v })),
    nFeatures: FEATURE_NAMES.length,
  };
}

function stubModel(tankValues, ghValues, collectorValues) {
  const m = { tank: stubForest(tankValues), greenhouse: stubForest(ghValues), featureRanges: [] };
  // Optional third forest (Lane D): direct collector-temperature
  // regression that switches the rollout to the device's real solar
  // entry/exit rules. Omitting it keeps the radiation-gate fallback.
  if (collectorValues) m.collector = stubForest(collectorValues);
  return m;
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
  // 48 five-min steps (first 4 h) + 44 one-h steps = 92, plus the
  // trailing 48 h trajectory point = 93.
  assert.strictEqual(fc.tankTrajectory.length, 93);
  assert.strictEqual(fc.greenhouseTrajectory.length, 93);
  assert.strictEqual(fc.modeForecast.length, 92);
  assert.ok(Array.isArray(fc.notes) && fc.notes.length > 0);
  assert.ok(['low', 'medium', 'high'].includes(fc.modelConfidence));
  assert.strictEqual(typeof fc.electricKwh, 'number');
  assert.strictEqual(typeof fc.electricCostEur, 'number');
  // First trajectory point reflects the supplied tank/greenhouse state.
  assert.strictEqual(fc.tankTrajectory[0].avg, 33);
  assert.strictEqual(fc.greenhouseTrajectory[0].temp, 16);
  // Contract spot-check: every pre-existing response key stays present
  // (the on-wire /api/forecast fields are frozen; Lane A only adds).
  ['generatedAt', 'engine', 'horizonHours', 'tankTrajectory', 'greenhouseTrajectory',
    'modeForecast', 'hoursUntilFloor', 'hoursUntilBackupNeeded', 'electricKwh',
    'electricCostEur', 'costBreakdown', 'solarChargingHours', 'greenhouseHeatingHours',
    'modelConfidence', 'notes'].forEach((k) => {
    assert.ok(k in fc, 'missing contract key ' + k);
  });
  // Additive Lane A field: per-hour occupancy fractions.
  assert.ok(Array.isArray(fc.modeFractions));
  assert.strictEqual(fc.modeFractions.length, 48);
});

test('computeMlForecast rolls a multi-resolution step schedule', () => {
  const model = loadModel();
  const fc = computeMlForecast({
    now: new Date('2026-05-18T18:00:00Z'),
    tankTop: 36, tankBottom: 30, greenhouseTemp: 16,
    currentMode: 'idle',
    weather48h: makeWeather(9, true),
    prices48h: makePrices(),
    model,
  });
  const tsAt = (i) => Date.parse(fc.tankTrajectory[i].ts);
  // First 48 trajectory points are 5-min apart (the near-term window).
  assert.strictEqual(tsAt(1) - tsAt(0), 5 * 60 * 1000);
  assert.strictEqual(tsAt(48) - tsAt(47), 5 * 60 * 1000);
  // After the fine window the points step hourly.
  assert.strictEqual(tsAt(49) - tsAt(48), 60 * 60 * 1000);
  // The trailing point lands exactly 48 h after `now`.
  assert.strictEqual(tsAt(92) - tsAt(0), 48 * 60 * 60 * 1000);
});

test('computeMlForecast throws without a loaded model', () => {
  assert.throws(() => computeMlForecast({
    now: Date.now(), weather48h: makeWeather(9, false), prices48h: makePrices(),
  }), /model not loaded/);
});

test('computeMlForecast throws a clear error when the model yields non-finite predictions', () => {
  // A NaN-poisoned forest (a leaf whose value is NaN) must not crash the
  // rollout with a cryptic "Cannot read properties of undefined" — it
  // must throw a model-not-available error the handler maps to a clean
  // 503 instead of a 500. This was the "ML forecast unavailable" bug.
  const nanForest = { trees: [{ leaf: true, value: NaN }], nFeatures: FEATURE_NAMES.length };
  const model = { tank: nanForest, greenhouse: nanForest, featureRanges: [] };
  assert.throws(() => computeMlForecast({
    now: new Date('2026-05-18T18:00:00Z'),
    tankTop: 36, tankBottom: 30, greenhouseTemp: 16,
    currentMode: 'idle',
    weather48h: makeWeather(9, true),
    prices48h: makePrices(),
    model,
  }), /model not available|non-finite/i);
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

test('predictForestStats exposes per-tree spread without changing predictForest', () => {
  const row = new Array(FEATURE_NAMES.length).fill(0);
  const spreadForest = stubForest([-3, 3]);
  const stats = rf.predictForestStats(spreadForest, row);
  assert.ok(Math.abs(stats.mean) < 1e-12, 'mean should match the forest average');
  assert.ok(Math.abs(stats.std - 3) < 1e-12, 'std should be the per-tree spread, got ' + stats.std);
  assert.strictEqual(rf.predictForest(spreadForest, row), 0, 'predictForest untouched');
  const flat = rf.predictForestStats(stubForest([1.25, 1.25]), row);
  assert.strictEqual(flat.mean, 1.25);
  assert.strictEqual(flat.std, 0);
});

test('solar gate defaults to 300 W/m2 (backtest-validated) and stays config-overridable', () => {
  // design/docs/ml-mode-forecast-findings.md rec #1: the old 150 W/m2
  // default over-predicted solar-dominant hours (828 false-positive
  // hours); 300 W/m2 gained +11.6 pp (2-6 h), +3.0 pp (7-24 h) and
  // +3.3 pp (25-48 h) schedule accuracy in the offline backtest.
  const base = {
    now: new Date('2026-05-18T08:00:00Z'),
    tankTop: 30, tankBottom: 30, greenhouseTemp: 16,
    currentMode: 'idle',
    prices48h: makePrices(),
    model: stubModel([0], [0]),
  };
  // 250 W/m2 sat above the old 150 gate but below the new 300 one.
  const below = computeMlForecast(Object.assign({}, base, { weather48h: flatWeather(15, 250) }));
  assert.ok(!below.modeForecast.some((m) => m.mode === 'solar_charging'),
    '250 W/m2 must not trigger solar_charging with the 300 W/m2 gate');
  assert.strictEqual(below.solarChargingHours, 0);
  // Warm greenhouse, far from emergency: no emergencyProb annotation.
  assert.ok(below.modeForecast.every((m) => m.emergencyProb === undefined));

  const above = computeMlForecast(Object.assign({}, base, { weather48h: flatWeather(15, 450) }));
  assert.ok(above.modeForecast.some((m) => m.mode === 'solar_charging'), '450 W/m2 clears the 300 gate');

  const overridden = computeMlForecast(Object.assign({}, base, {
    weather48h: flatWeather(15, 250), config: { solarChargeRadiationMinWm2: 150 },
  }));
  assert.ok(overridden.modeForecast.some((m) => m.mode === 'solar_charging'),
    'the gate stays config-overridable');
});

test('emergency entry is probabilistic: tree spread can trigger it above the point threshold', () => {
  // rec #4 (design/docs/ml-mode-forecast-findings.md): the point rule
  // `gh < emergencyEnterC` predicted 0-4 emergency hours vs 56 actual.
  // Pin gh at 10 degC (outdoor clamp holds it there) — always above
  // emergencyEnterC = 9 — with a greenhouse forest whose per-tree spread
  // is 3 degC: P(gh_true < 9) = Phi((9 - 10) / 3) ≈ 0.37, which clears
  // the default emergencyProbMin of 0.3.
  const base = {
    now: new Date('2026-01-15T18:00:00Z'),
    tankTop: 10, tankBottom: 10, greenhouseTemp: 10,
    currentMode: 'idle',
    weather48h: flatWeather(10, 0),
    prices48h: makePrices(),
    model: stubModel([0], [-3, 3]),
  };
  const fc = computeMlForecast(base);
  assert.strictEqual(fc.modeForecast[0].mode, 'emergency_heating',
    'probabilistic entry despite point gh above the threshold');
  assert.strictEqual(fc.hoursUntilBackupNeeded, 0, 'backup countdown follows the probabilistic entry');
  assert.ok(fc.electricKwh > 0, 'heater duty/cost path runs for probabilistic entries');
  assert.strictEqual(typeof fc.modeForecast[0].duty, 'number');
  assert.ok(Math.abs(fc.modeForecast[0].emergencyProb - 0.37) < 0.02,
    'emergencyProb annotated, got ' + fc.modeForecast[0].emergencyProb);

  // Raising emergencyProbMin above the ~0.37 estimate suppresses entry.
  const strict = computeMlForecast(Object.assign({}, base, { config: { emergencyProbMin: 0.5 } }));
  assert.ok(!strict.modeForecast.some((m) => m.mode === 'emergency_heating'),
    'no emergency entry once emergencyProbMin exceeds the estimated probability');
  assert.strictEqual(strict.hoursUntilBackupNeeded, null);
  assert.strictEqual(strict.electricKwh, 0);
  // Near-emergency steps still expose the probability (additive field).
  assert.ok(Math.abs(strict.modeForecast[0].emergencyProb - 0.37) < 0.02);
});

test('sigma cap keeps the probabilistic entry threshold below the exit threshold (no chatter)', () => {
  // Entry fires at gh <= enterC + z*sigma (z ≈ 0.524 at the default
  // emergencyProbMin 0.3). With a huge OOD tree spread (std 20) and
  // close enter/exit thresholds (9/10) the uncapped entry threshold
  // (~19.5 degC) overlaps exitC, so every exit at gh > 10 re-enters on
  // the next 5-min step — emergency<->idle chatter that inflates
  // electricKwh. The effective sigma must be capped so the entry
  // threshold always stays below the exit threshold.
  const base = {
    now: new Date('2026-01-15T18:00:00Z'),
    tankTop: 20, tankBottom: 20, greenhouseTemp: 11,
    currentMode: 'idle',
    weather48h: flatWeather(11, 0), // outdoor clamp pins gh at 11 > exitC
    prices48h: makePrices(),
    model: stubModel([0], [-20, 20]), // per-tree spread: std 20
    config: { emergencyEnterC: 9, emergencyExitC: 10 },
  };
  const fc = computeMlForecast(base);
  // Count maximal emergency runs in modeForecast: with the cap the
  // capped sigma (0.9*(10-9)/0.524 ≈ 1.72) gives P(gh_true < 9 | gh=11)
  // ≈ 0.12 < 0.3 — no entry at all, so zero segments (uncapped: a new
  // segment every other step).
  let segments = 0;
  let prev = null;
  fc.modeForecast.forEach((m) => {
    if (m.mode === 'emergency_heating' && prev !== 'emergency_heating') segments++;
    prev = m.mode;
  });
  assert.strictEqual(segments, 0,
    'expected no emergency chatter with gh pinned above exitC, got ' + segments + ' segments');
  assert.strictEqual(fc.electricKwh, 0, 'chatter must not inflate electricKwh');

  // Entry threshold < exitC: gh pinned just below exitC (9.95) but above
  // the capped entry threshold (9 + 0.524*1.72 ≈ 9.9) must not enter —
  // the whole band [entry, exitC) is entry-free by the invariant.
  const nearExit = computeMlForecast(Object.assign({}, base, {
    greenhouseTemp: 9.95, weather48h: flatWeather(9.95, 0),
  }));
  assert.ok(!nearExit.modeForecast.some((m) => m.mode === 'emergency_heating'),
    'gh inside [capped entry threshold, exitC) must not trigger entry');

  // The cap must not kill the probabilistic entry itself: gh below the
  // capped threshold (9.5 → P ≈ 0.39 with sigma 1.72) still enters.
  const cold = computeMlForecast(Object.assign({}, base, {
    greenhouseTemp: 9.5, weather48h: flatWeather(9.5, 0),
  }));
  assert.strictEqual(cold.modeForecast[0].mode, 'emergency_heating',
    'capped sigma must still allow probabilistic entry below the threshold');
});

test('emergency probability applies the std floor when tree spread is zero', () => {
  // The std floor (default 1.5 degC, reflecting the measured ~2.4 degC
  // greenhouse MAE) must keep the entry probabilistic even when the
  // ensemble is overconfident: gh pinned at 9.5 > enterC 9 with a
  // zero-spread forest gives Phi((9 - 9.5) / 1.5) ≈ 0.37 >= 0.3.
  const fc = computeMlForecast({
    now: new Date('2026-01-15T18:00:00Z'),
    tankTop: 9.5, tankBottom: 9.5, greenhouseTemp: 9.5,
    currentMode: 'idle',
    weather48h: flatWeather(9.5, 0),
    prices48h: makePrices(),
    model: stubModel([0], [0]),
  });
  assert.strictEqual(fc.modeForecast[0].mode, 'emergency_heating');
});

// ── Lane D: collector forest drives real solar entry/exit ───────────
// findings-doc rec #6: with a collector-temperature forest in the
// artifact, the rollout decides solar_charging with the device's own
// entry rule (collector > tank_bottom + solarEnterDelta from
// shelly/control-logic.js DEFAULT_CONFIG) and a tractable
// approximation of its exit rules, instead of the flat radiation gate.

test('collector forest drives solar entry: hot collector enters solar despite low radiation', () => {
  const base = {
    now: new Date('2026-05-18T08:00:00Z'),
    tankTop: 30, tankBottom: 30, greenhouseTemp: 20,
    currentMode: 'idle',
    weather48h: flatWeather(15, 100), // 100 W/m2 — far below the 300 gate
    prices48h: makePrices(),
  };
  // Collector simulated at 60 degC > tank_bottom 30 + solarEnterDelta 3.
  const fc = computeMlForecast(Object.assign({}, base, { model: stubModel([0], [0], [60]) }));
  assert.strictEqual(fc.modeForecast[0].mode, 'solar_charging',
    'device entry rule must fire on collector-vs-tank delta, not radiation');
  assert.ok(fc.solarChargingHours > 0);
  // Without the collector forest the radiation gate governs: 100 W/m2
  // stays idle (legacy fallback path byte-identical).
  const legacy = computeMlForecast(Object.assign({}, base, { model: stubModel([0], [0]) }));
  assert.ok(!legacy.modeForecast.some((m) => m.mode === 'solar_charging'),
    'absent collector forest -> radiation gate -> no solar at 100 W/m2');
  assert.strictEqual(legacy.solarChargingHours, 0);
});

test('collector forest suppresses solar when the collector is cold despite high radiation', () => {
  const base = {
    now: new Date('2026-05-18T08:00:00Z'),
    tankTop: 30, tankBottom: 30, greenhouseTemp: 20,
    currentMode: 'idle',
    weather48h: flatWeather(15, 450), // clears the 300 W/m2 gate
    prices48h: makePrices(),
  };
  // Collector simulated at 20 degC — below tank_bottom + solarEnterDelta.
  const fc = computeMlForecast(Object.assign({}, base, { model: stubModel([0], [0], [20]) }));
  assert.ok(!fc.modeForecast.some((m) => m.mode === 'solar_charging'),
    'a cold collector must veto solar even when radiation clears the old gate');
  assert.strictEqual(fc.solarChargingHours, 0);
  // Contrast: the same conditions without the collector forest keep the
  // legacy radiation-gate behaviour (solar on at 450 W/m2).
  const legacy = computeMlForecast(Object.assign({}, base, { model: stubModel([0], [0]) }));
  assert.ok(legacy.modeForecast.some((m) => m.mode === 'solar_charging'));
});

test('solar exits when the tank stops accepting: simulated collector head exhausted', () => {
  // Collector pinned at 35 degC; the tank forest adds +1 degC per step so
  // simulated tankAvg climbs past the collector. Entry at step 0
  // (35 > 30 + 3), exit once collector - tank_top <= 0 (~step 5), and no
  // re-entry once tank_bottom + solarEnterDelta exceeds the collector.
  const fc = computeMlForecast({
    now: new Date('2026-05-18T08:00:00Z'),
    tankTop: 30, tankBottom: 30, greenhouseTemp: 20,
    currentMode: 'idle',
    weather48h: flatWeather(15, 100),
    prices48h: makePrices(),
    model: stubModel([1], [0], [35]),
  });
  assert.strictEqual(fc.modeForecast[0].mode, 'solar_charging', 'enters while head is positive');
  // After one fine hour (12 steps) the tank is well past the collector.
  for (let i = 12; i < fc.modeForecast.length; i++) {
    assert.notStrictEqual(fc.modeForecast[i].mode, 'solar_charging',
      'saturated tank must have exited solar by step ' + i);
  }
  assert.ok(fc.solarChargingHours > 0 && fc.solarChargingHours < 1,
    'brief solar session, got ' + fc.solarChargingHours + ' h');
});

test('solar exits on tank drop-from-peak, mirroring the device rule', () => {
  // Collector pinned hot (60 degC, stall-bypass territory) while the tank
  // forest drains 0.15 degC per step: the only exit path is the
  // drop-from-peak rule (peak tankAvg - tankAvg >= solarExitTankDrop).
  const base = {
    now: new Date('2026-05-18T08:00:00Z'),
    tankTop: 40, tankBottom: 20, greenhouseTemp: 20, // spread 20, avg 30
    currentMode: 'idle',
    weather48h: flatWeather(15, 0),
    prices48h: makePrices(),
    model: stubModel([-0.15], [0], [60]),
  };
  const fc = computeMlForecast(base);
  const fineModes = fc.modeForecast.slice(0, 48).map((m) => m.mode);
  assert.strictEqual(fineModes[0], 'solar_charging');
  assert.ok(fineModes.some((m) => m !== 'solar_charging'),
    'a 2 degC drop from peak must force at least one exit in the fine window');
  // With the drop rule disabled (huge threshold override) the hot
  // collector keeps the session alive through the whole fine window —
  // isolating drop-from-peak as the exit that fired above.
  const noDrop = computeMlForecast(Object.assign({}, base, {
    config: { solarExitTankDrop: 999 },
  }));
  assert.ok(noDrop.modeForecast.slice(0, 48).every((m) => m.mode === 'solar_charging'),
    'without the drop rule the stall bypass keeps solar running');
});

test('stratified tank: a mid-band collector must not chatter solar<->idle (PR #283 review)', () => {
  // Reviewer repro: tank top 36 / bottom 30 (spread 6 > solarEnterDelta 3),
  // collector pinned at 35 — inside the old chatter band
  // (tank_bottom + 3, tank_top]: the old tank_TOP-referenced stall exit
  // fired every other step against the tank_BOTTOM-referenced entry
  // (56 transitions, solarChargingHours ~42, modeFractions ~0.5/0.5).
  // With entry and exit sharing the bottom reference the session must be
  // one contiguous run.
  const fc = computeMlForecast({
    now: new Date('2026-05-18T08:00:00Z'),
    tankTop: 36, tankBottom: 30, greenhouseTemp: 20,
    currentMode: 'idle',
    weather48h: flatWeather(15, 0),
    prices48h: makePrices(),
    model: stubModel([0], [0], [35]),
  });
  let segments = 0;
  let prevSolar = false;
  for (const m of fc.modeForecast) {
    const solar = m.mode === 'solar_charging';
    if (solar && !prevSolar) segments += 1;
    prevSolar = solar;
  }
  assert.strictEqual(segments, 1,
    'mid-band collector must produce one contiguous solar session, got ' + segments);
});

test('drop-from-peak exit does not chain fake sessions on a draining tank (PR #283 review)', () => {
  // Amplifier from the review: after a drop-from-peak exit the old code
  // re-entered on the very next step (collector still above the entry
  // threshold) and reseeded the peak from the now-lower tank average —
  // a monotonically draining tank chained back-to-back sessions. The
  // rising-edge guard requires the collector to dip to the entry
  // threshold before a new session can start, so a pinned-hot collector
  // over a draining tank yields exactly one session and one exit.
  const fc = computeMlForecast({
    now: new Date('2026-05-18T08:00:00Z'),
    tankTop: 40, tankBottom: 20, greenhouseTemp: 20,
    currentMode: 'idle',
    weather48h: flatWeather(15, 0),
    prices48h: makePrices(),
    model: stubModel([-0.15], [0], [60]),
  });
  let segments = 0;
  let prevSolar = false;
  for (const m of fc.modeForecast) {
    const solar = m.mode === 'solar_charging';
    if (solar && !prevSolar) segments += 1;
    prevSolar = solar;
  }
  assert.strictEqual(segments, 1,
    'draining tank must not re-enter solar after the drop-from-peak exit, got '
    + segments + ' sessions');
});

test('legacy artifact without a collector forest still loads and forecasts', () => {
  // Migration safety: the committed model (and any pre-Lane-D S3 model)
  // has no collector key — the rollout must produce the full contract
  // via the radiation-gate fallback.
  const model = loadModel();
  delete model.collector; // explicit, in case the committed artifact gains one later
  const fc = computeMlForecast({
    now: new Date('2026-05-18T18:00:00Z'),
    tankTop: 36, tankBottom: 30, greenhouseTemp: 16,
    currentMode: 'idle',
    weather48h: makeWeather(9, true),
    prices48h: makePrices(),
    model,
  });
  assert.strictEqual(fc.engine, 'ml');
  assert.strictEqual(fc.modeForecast.length, 92);
  assert.strictEqual(fc.tankTrajectory.length, 93);
  assert.ok(Array.isArray(fc.notes) && fc.notes.length > 0);
});

test('modeFractions aggregates step occupancy per forecast hour (additive)', () => {
  // rec #5 (design/docs/ml-mode-forecast-findings.md): median real mode
  // dwell is 6-9 min and 27.8% of hours have no >=75% dominant mode, so
  // per-hour occupancy fractions are the honest schedule output. A
  // tankMaxC just above the start temperature forces a mid-hour
  // solar_charging -> idle flip inside the 5-min fine window.
  const fc = computeMlForecast({
    now: new Date('2026-05-18T08:00:00Z'), // 11:00 Helsinki — solar-gain hours
    tankTop: 30, tankBottom: 30, greenhouseTemp: 20,
    currentMode: 'idle',
    weather48h: flatWeather(18, 500),
    prices48h: makePrices(),
    model: stubModel([0], [0]),
    config: { tankMaxC: 30.3 },
  });
  assert.ok(Array.isArray(fc.modeFractions));
  assert.strictEqual(fc.modeFractions.length, 48);
  // Hour starts: hourly-spaced ISO timestamps from `now`.
  assert.strictEqual(fc.modeFractions[0].ts, new Date('2026-05-18T08:00:00Z').toISOString());
  for (let h = 1; h < 48; h++) {
    assert.strictEqual(
      Date.parse(fc.modeFractions[h].ts) - Date.parse(fc.modeFractions[h - 1].ts), 3600000);
  }
  // Fractions sum to ~1 in every hour; solar is a 0..1 overlay fraction.
  fc.modeFractions.forEach((e) => {
    const sum = Object.values(e.fractions).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.01, 'hour ' + e.ts + ' fractions sum to ' + sum);
    assert.strictEqual(typeof e.solar, 'number');
    assert.ok(e.solar >= 0 && e.solar <= 1);
  });
  // Fine-window granularity: the tank crosses tankMaxC mid-hour, so hour
  // 0 is genuinely mixed (12 five-min samples), not one-hot.
  const h0 = fc.modeFractions[0].fractions;
  assert.ok(h0.solar_charging > 0 && h0.solar_charging < 1,
    'hour 0 solar fraction should be fractional, got ' + JSON.stringify(h0));
  assert.ok(h0.idle > 0 && h0.idle < 1);
  assert.strictEqual(fc.modeFractions[0].solar, h0.solar_charging);
  // Coarse hours are one-hot (a single hourly step).
  assert.deepStrictEqual(Object.values(fc.modeFractions[47].fractions), [1]);
  // modeForecast itself is unchanged: still one entry per rollout step.
  assert.strictEqual(fc.modeForecast.length, 92);
});
