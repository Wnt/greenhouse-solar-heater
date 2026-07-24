'use strict';

// Unit tests for the in-process ML trainer's promotion gate and the
// model store's feature-contract guard + committed-model load.

const { test } = require('node:test');
const assert = require('node:assert');

const rf = require('../server/lib/forecast/ml/random-forest');
const {
  createMlTrainer, evaluateGate, freshTestSubset, buildCollectorTargets, MIN_FRESH_SAMPLES,
} = require('../server/lib/forecast/ml/ml-trainer');
const { createModelStore, contractOk } = require('../server/lib/forecast/ml/model-store');
const { FEATURE_NAMES, MODEL_VERSION } = require('../server/lib/forecast/ml/features');

const NF = FEATURE_NAMES.length;

// Build a synthetic matrix; `targetFn(row, rnd)` produces the label.
function synth(n, targetFn, seed) {
  const rnd = rf.mulberry32(seed);
  const X = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let j = 0; j < NF; j++) row.push(rnd() * 10);
    X.push(row);
    y.push(targetFn(row, rnd));
  }
  return { X, y };
}

const learnable = function fn(r) { return r[0] * 2 + r[1] - r[2]; };
const noise = function fn(_r, rnd) { return rnd() * 10; };

test('evaluateGate accepts a candidate that fits a learnable signal', () => {
  const tr = synth(400, learnable, 1);
  const te = synth(120, learnable, 2);
  const candTank = rf.trainForest(tr.X, tr.y, { nTrees: 30, seed: 3 });
  const candGh = rf.trainForest(tr.X, tr.y, { nTrees: 30, seed: 4 });
  const res = evaluateGate(candTank, candGh, null, te.X, te.y, te.y);
  assert.strictEqual(res.pass, true, res.reasons.join('; '));
  assert.ok(res.metrics.tankR2 > 0.55);
});

test('evaluateGate rejects a candidate with no predictive power', () => {
  const tr = synth(400, noise, 5);
  const te = synth(120, noise, 6);
  const candTank = rf.trainForest(tr.X, tr.y, { nTrees: 20, seed: 7 });
  const candGh = rf.trainForest(tr.X, tr.y, { nTrees: 20, seed: 8 });
  const res = evaluateGate(candTank, candGh, null, te.X, te.y, te.y);
  assert.strictEqual(res.pass, false);
  assert.ok(res.reasons.some(function r(x) { return /R2/.test(x); }));
});

test('evaluateGate passes an equally-good candidate against a current model', () => {
  const tr = synth(400, learnable, 9);
  const te = synth(150, learnable, 10);
  const cur = {
    tank: rf.trainForest(tr.X, tr.y, { nTrees: 40, seed: 11 }),
    greenhouse: rf.trainForest(tr.X, tr.y, { nTrees: 40, seed: 12 }),
  };
  const candTank = rf.trainForest(tr.X, tr.y, { nTrees: 40, seed: 13 });
  const candGh = rf.trainForest(tr.X, tr.y, { nTrees: 40, seed: 14 });
  const res = evaluateGate(candTank, candGh, cur, te.X, te.y, te.y);
  assert.strictEqual(res.pass, true, res.reasons.join('; '));
});

test('evaluateGate rejects a candidate whose metrics are non-finite', () => {
  // Mirrors the production failure: a missing sensor reading in the
  // 30-day window produced NaN ΔT labels. The forest still emits finite
  // predictions (it was trained on the clean rows that landed in its
  // leaves), so the existing finite-prediction check passes — but the
  // test targets carry NaN, so RMSE/R2 come out NaN. NaN < FLOOR is
  // false, which silently slipped a degenerate model past the gate.
  const tr = synth(400, learnable, 21);
  const te = synth(120, learnable, 22);
  const candTank = rf.trainForest(tr.X, tr.y, { nTrees: 30, seed: 23 });
  const candGh = rf.trainForest(tr.X, tr.y, { nTrees: 30, seed: 24 });
  const yTank = te.y.slice(); yTank[3] = NaN;
  const yGh = te.y.slice(); yGh[7] = NaN;
  const res = evaluateGate(candTank, candGh, null, te.X, yTank, yGh);
  assert.strictEqual(res.pass, false);
  assert.ok(res.reasons.some(function r(x) { return /non-finite/.test(x); }),
    res.reasons.join('; '));
});

// The 2026-07 staleness incident: after every promotion the shipped
// model is retrained on the FULL 30-day window, so on the next daily
// run most of the (time-ordered) test split is data the current model
// has already memorized. Evaluating the regression guard there makes
// the current model look far better than any honest candidate, and the
// gate rejected candidates for days until enough unseen data diluted
// the leak. The guard must compare the two models only on samples
// newer than the current model's trainedAt.
test('evaluateGate regression guard ignores data the current model was trained on', () => {
  const noisy = function fn(r, rnd) { return r[0] * 2 + r[1] - r[2] + (rnd() - 0.5) * 4; };
  const tr = synth(500, noisy, 31);
  const te = synth(300, noisy, 32);
  const staleN = 200; // portion of the test split the current model has seen
  const staleX = te.X.slice(0, staleN);
  const staleY = te.y.slice(0, staleN);
  const freshX = te.X.slice(staleN);
  const freshY = te.y.slice(staleN);

  // Current model: trained on train data PLUS the stale test rows
  // (exactly what full-window retraining does to the next day's split).
  const curX = tr.X.concat(staleX);
  const curY = tr.y.concat(staleY);
  const cur = {
    tank: rf.trainForest(curX, curY, { nTrees: 40, seed: 33 }),
    greenhouse: rf.trainForest(curX, curY, { nTrees: 40, seed: 34 }),
  };
  const candTank = rf.trainForest(tr.X, tr.y, { nTrees: 40, seed: 35 });
  const candGh = rf.trainForest(tr.X, tr.y, { nTrees: 40, seed: 36 });

  // Sanity: on the leaked full test split the old comparison rejects
  // the candidate — this is the production failure mode.
  const leaky = evaluateGate(candTank, candGh, cur, te.X, te.y, te.y);
  assert.strictEqual(leaky.pass, false, 'expected the leaky comparison to reject');
  assert.ok(leaky.reasons.some(function r(x) { return /regressed/.test(x); }),
    leaky.reasons.join('; '));

  // With the fresh (unseen-by-current) subset supplied, the same
  // candidate must pass — both models are strangers to those rows.
  const fair = evaluateGate(candTank, candGh, cur, te.X, te.y, te.y,
    { X: freshX, yTank: freshY, yGh: freshY });
  assert.strictEqual(fair.pass, true, fair.reasons.join('; '));
});

test('evaluateGate falls back to the full test split when the fresh subset is tiny', () => {
  const noisy = function fn(r, rnd) { return r[0] * 2 + r[1] - r[2] + (rnd() - 0.5) * 4; };
  const tr = synth(500, noisy, 41);
  const te = synth(300, noisy, 42);
  const cur = {
    tank: rf.trainForest(tr.X.concat(te.X), tr.y.concat(te.y), { nTrees: 40, seed: 43 }),
    greenhouse: rf.trainForest(tr.X.concat(te.X), tr.y.concat(te.y), { nTrees: 40, seed: 44 }),
  };
  const candTank = rf.trainForest(tr.X, tr.y, { nTrees: 40, seed: 45 });
  const candGh = rf.trainForest(tr.X, tr.y, { nTrees: 40, seed: 46 });
  // Fewer fresh samples than MIN_FRESH_SAMPLES -> conservative fallback
  // to the full split, i.e. same (rejecting) behavior as before.
  const fresh = { X: te.X.slice(0, 5), yTank: te.y.slice(0, 5), yGh: te.y.slice(0, 5) };
  assert.ok(fresh.X.length < MIN_FRESH_SAMPLES);
  const res = evaluateGate(candTank, candGh, cur, te.X, te.y, te.y, fresh);
  assert.strictEqual(res.pass, false);
});

test('freshTestSubset filters test samples by the current model trainedAt', () => {
  const X = [[1], [2], [3], [4]];
  const yTank = [10, 20, 30, 40];
  const yGh = [11, 21, 31, 41];
  const t0s = [1000, 2000, 3000, 4000];
  // No current model / no trainedAt -> null (no fresh restriction)
  assert.strictEqual(freshTestSubset(X, yTank, yGh, t0s, null), null);
  assert.strictEqual(freshTestSubset(X, yTank, yGh, t0s, {}), null);
  const cur = { trainedAt: new Date(3000).toISOString() };
  const sub = freshTestSubset(X, yTank, yGh, t0s, cur);
  assert.deepStrictEqual(sub.X, [[3], [4]]);
  assert.deepStrictEqual(sub.yTank, [30, 40]);
  assert.deepStrictEqual(sub.yGh, [31, 41]);
});

test('contractOk validates the model feature contract', () => {
  const ok = { tank: {}, greenhouse: {}, version: MODEL_VERSION, featureNames: FEATURE_NAMES.slice() };
  assert.strictEqual(contractOk(ok), true);
  assert.strictEqual(contractOk(Object.assign({}, ok, { featureNames: ['x'] })), false);
  assert.strictEqual(contractOk({ tank: {}, greenhouse: {} }), false);
  assert.strictEqual(contractOk(null), false);
  // Wrong version (old absolute-target model) — must be rejected so the
  // v2 rollout doesn't double-count the physics step.
  assert.strictEqual(contractOk(Object.assign({}, ok, { version: 1 })), false);
  assert.strictEqual(contractOk(Object.assign({}, ok, { version: undefined })), false);
});

// ── Lane D: optional collector forest (findings-doc rec #6) ─────────
// The artifact may carry a third forest — a direct regression of the
// collector outlet temperature — so the rollout can run the device's
// real solar entry/exit rules. It is OPTIONAL: old S3/committed models
// without it must stay loadable, and its presence must not change the
// promotion gate.

test('contractOk accepts artifacts with and without the optional collector forest', () => {
  const base = { tank: {}, greenhouse: {}, version: MODEL_VERSION, featureNames: FEATURE_NAMES.slice() };
  // Old artifacts (no collector key) stay valid — migration safety.
  assert.strictEqual(contractOk(base), true);
  assert.strictEqual(contractOk(Object.assign({}, base, { collector: null })), true);
  // New artifacts carry the third forest.
  const forest = { trees: [{ leaf: true, value: 40 }], nFeatures: NF };
  assert.strictEqual(contractOk(Object.assign({}, base, { collector: forest })), true);
  // A collector key that is not a real forest must be rejected — the
  // rollout would crash (or NaN-poison) predicting from it.
  assert.strictEqual(contractOk(Object.assign({}, base, { collector: {} })), false);
  assert.strictEqual(contractOk(Object.assign({}, base, { collector: 'garbage' })), false);
  assert.strictEqual(contractOk(Object.assign({}, base, { collector: { trees: 'x' } })), false);
});

test('buildCollectorTargets interpolates at anchors and NaNs across sensor gaps', () => {
  const points = [
    { ts: 0, collector: 10, tank_top: 30, tank_bottom: 28, greenhouse: 15, outdoor: 10 },
    { ts: 600000, collector: 20, tank_top: 30, tank_bottom: 28, greenhouse: 15, outdoor: 10 },
    // 50-minute hole to the next reading — anchors inside it must be NaN
    // (mirrors dataset.js's MAX_GAP sensor-gap rule).
    { ts: 3600000, collector: 40, tank_top: 30, tank_bottom: 28, greenhouse: 15, outdoor: 10 },
  ];
  const y = buildCollectorTargets(points, [0, 300000, 1800000, 3600000]);
  assert.strictEqual(y[0], 10);
  assert.strictEqual(y[1], 15); // midpoint interpolation
  assert.ok(Number.isNaN(y[2]), 'anchor inside a sensor gap must be NaN');
  assert.strictEqual(y[3], 40);
  // Rows where the collector column is missing are ignored entirely.
  const y2 = buildCollectorTargets([{ ts: 0 }, { ts: 1000 }], [0]);
  assert.ok(Number.isNaN(y2[0]));
});

// Synthetic 48 h history payload with smooth, noise-free diurnal
// temperature curves — deterministic targets keep the candidate safely
// above the gate's R2 floors so retrainOnce reaches promotion.
// `includeCollector` toggles the collector column in the pivoted points,
// mimicking a deployment where that sensor never reported.
function trainerPayload(includeCollector) {
  const HOURS = 48;
  const start = Date.parse('2026-06-01T00:00:00Z');
  const radAt = (hod) => (hod >= 6 && hod <= 20) ? 600 * Math.sin(Math.PI * (hod - 6) / 14) : 0;
  const points = [];
  for (let t = start; t <= start + HOURS * 3600000; t += 5 * 60000) {
    const h = (t - start) / 3600000;
    const p = {
      ts: t,
      tank_top: 32 + 6 * Math.sin(2 * Math.PI * h / 24),
      tank_bottom: 28 + 6 * Math.sin(2 * Math.PI * h / 24),
      greenhouse: 15 + 8 * Math.sin(2 * Math.PI * (h - 3) / 24),
      outdoor: 10 + 5 * Math.sin(2 * Math.PI * (h - 4) / 24),
    };
    if (includeCollector) p.collector = 15 + radAt(h % 24) / 10;
    points.push(p);
  }
  const weather = [];
  for (let h = 0; h <= HOURS; h++) {
    weather.push({
      validAt: new Date(start + h * 3600000).toISOString(),
      temperature: 10 + 5 * Math.sin(2 * Math.PI * (h - 4) / 24),
      radiationGlobal: radAt(h % 24),
      windSpeed: 3,
      precipitation: 0,
    });
  }
  return { points, weather };
}

function runTrainer(payload, done) {
  let promoted = null;
  const warns = [];
  const trainer = createMlTrainer({
    db: { getEvents(_range, _type, cb) { cb(null, []); } },
    log: { info() {}, warn(msg, meta) { warns.push({ msg, meta }); }, error() {} },
    getForecastDataset: (_opts, cb) => cb(null, { weather: payload.weather, generations: [] }),
    getTrainingHistory: (_days, _bucket, cb) => cb(null, payload.points),
    modelStore: { get() { return null; }, set(m, cb) { promoted = m; if (cb) cb(); } },
  });
  trainer.retrainOnce(() => done(promoted, trainer.getStatus(), warns));
}

test('retrainOnce promotes an artifact carrying a collector forest when history has the collector column', async () => {
  const { promoted, status } = await new Promise((resolve) => {
    runTrainer(trainerPayload(true), (p, s) => resolve({ promoted: p, status: s }));
  });
  assert.ok(promoted, 'gate should promote on the synthetic history: ' + (status.lastError || ''));
  assert.ok(promoted.collector, 'artifact must carry the collector forest');
  assert.ok(Array.isArray(promoted.collector.trees) && promoted.collector.trees.length > 0);
  assert.strictEqual(promoted.collector.nFeatures, NF);
  assert.strictEqual(contractOk(promoted), true, 'promoted artifact must pass the contract check');
  // The collector forest predicts an absolute temperature — sanity-check
  // it emits something finite for an in-distribution row.
  const someRow = new Array(NF).fill(0);
  assert.ok(Number.isFinite(rf.predictForest(promoted.collector, someRow)));
});

test('retrainOnce omits the collector forest when the collector column is absent — artifact stays valid', async () => {
  const { promoted, status } = await new Promise((resolve) => {
    runTrainer(trainerPayload(false), (p, s) => resolve({ promoted: p, status: s }));
  });
  assert.ok(promoted, 'promotion must not depend on the collector column: ' + (status.lastError || ''));
  assert.strictEqual(promoted.collector, undefined, 'no collector column -> no collector forest');
  assert.strictEqual(contractOk(promoted), true, 'collector-less artifact remains contract-valid');
});

test('retrainOnce omits a degenerate (flatline) collector forest and logs the sanity-check skip', async () => {
  // A collector sensor stuck at a constant value trains a forest with
  // zero predictive power (R2 = 0 on the held-out tail). Shipping it
  // would silently swap the validated 300 W/m2 radiation gate for
  // garbage device-rule solar rollouts, so the trainer must evaluate
  // the collector forest before attaching it, omit it on failure, and
  // log the skip — while promotion of the tank/greenhouse model stays
  // unaffected.
  const payload = trainerPayload(true);
  payload.points.forEach((p) => { p.collector = 20; });
  const { promoted, status, warns } = await new Promise((resolve) => {
    runTrainer(payload, (p, s, w) => resolve({ promoted: p, status: s, warns: w }));
  });
  assert.ok(promoted, 'promotion must not depend on collector quality: ' + (status.lastError || ''));
  assert.strictEqual(promoted.collector, undefined,
    'a degenerate collector forest must not ship in the artifact');
  assert.strictEqual(promoted.collectorTrainSamples, undefined);
  assert.strictEqual(contractOk(promoted), true);
  assert.ok(warns.some((w) => /collector forest failed sanity check/.test(w.msg)),
    'expected a logged sanity-check skip, got: ' + JSON.stringify(warns.map((w) => w.msg)));
});

test('model store loads the committed model on init', async () => {
  const store = createModelStore({ log: { info() {}, warn() {}, error() {} } });
  await new Promise(function exec(resolve) { store.loadInitial(resolve); });
  const m = store.get();
  assert.ok(m && m.tank && m.greenhouse, 'committed model should be loaded');
  assert.strictEqual(m.featureNames.length, NF);
  assert.ok(['committed', 's3'].includes(store.getInfo().source));
});
