'use strict';

// Unit tests for the in-process ML trainer's promotion gate and the
// model store's feature-contract guard + committed-model load.

const { test } = require('node:test');
const assert = require('node:assert');

const rf = require('../server/lib/forecast/ml/random-forest');
const { evaluateGate } = require('../server/lib/forecast/ml/ml-trainer');
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

test('model store loads the committed model on init', async () => {
  const store = createModelStore({ log: { info() {}, warn() {}, error() {} } });
  await new Promise(function exec(resolve) { store.loadInitial(resolve); });
  const m = store.get();
  assert.ok(m && m.tank && m.greenhouse, 'committed model should be loaded');
  assert.strictEqual(m.featureNames.length, NF);
  assert.ok(['committed', 's3'].includes(store.getInfo().source));
});
