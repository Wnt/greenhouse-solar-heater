'use strict';

// Random-forest regression — pure JS, zero dependencies.
//
// Same model family as nordpool-predict-fi: an ensemble of decorrelated
// CART regression trees, averaged. A tree learns piecewise-constant
// feature interactions with no assumed functional form, so the model
// can capture effects like "solar_charging + high radiation + cold tank
// -> large tank gain" without us hand-coding the physics.
//
// Trees split on weighted variance reduction (= MSE). Each tree grows on
// a bootstrap resample and considers a random feature subset at every
// node; that is what decorrelates the ensemble. Split search is binned
// against precomputed per-feature quantile thresholds so training stays
// O(rows) per node instead of O(rows log rows).

// Deterministic PRNG (mulberry32) so training runs are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sum of squared error about the mean: sumSq - sum^2/n.
function sse(sum, sumSq, n) {
  return n <= 0 ? 0 : sumSq - (sum * sum) / n;
}

// Per-feature quantile split candidates, computed once from the full
// training matrix. Constant features yield an empty list (never split).
function featureThresholds(X, nBins) {
  const nf = X[0].length;
  const out = [];
  for (let f = 0; f < nf; f++) {
    const vals = new Array(X.length);
    for (let i = 0; i < X.length; i++) vals[i] = X[i][f];
    vals.sort(function cmp(a, b) { return a - b; });
    const uniq = [];
    for (let i = 0; i < vals.length; i++) {
      if (i === 0 || vals[i] !== vals[i - 1]) uniq.push(vals[i]);
    }
    let thr;
    if (uniq.length <= 1) {
      thr = [];
    } else if (uniq.length <= nBins + 1) {
      thr = [];
      for (let i = 1; i < uniq.length; i++) thr.push((uniq[i - 1] + uniq[i]) / 2);
    } else {
      thr = [];
      for (let b = 1; b <= nBins; b++) {
        const v = vals[Math.floor((b / (nBins + 1)) * (vals.length - 1))];
        if (thr.length === 0 || v !== thr[thr.length - 1]) thr.push(v);
      }
    }
    out.push(thr);
  }
  return out;
}

// Count of thresholds strictly below x (the "gap" a value falls into).
function gapIndex(thr, x) {
  let lo = 0, hi = thr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (thr[m] < x) lo = m + 1; else hi = m;
  }
  return lo;
}

// Best (feature, threshold) split for `idx` rows; null when no split
// yields positive variance reduction.
function bestSplit(X, y, idx, featureSet, thresholds, minLeaf) {
  const n = idx.length;
  let total = 0, totalSq = 0;
  for (let i = 0; i < n; i++) { const v = y[idx[i]]; total += v; totalSq += v * v; }
  const parentSse = sse(total, totalSq, n);
  let best = null;

  for (let fi = 0; fi < featureSet.length; fi++) {
    const f = featureSet[fi];
    const thr = thresholds[f];
    const B = thr.length;
    if (B === 0) continue;
    const G = B + 1;
    const gSum = new Float64Array(G);
    const gSq = new Float64Array(G);
    const gCnt = new Float64Array(G);
    for (let i = 0; i < n; i++) {
      const r = idx[i];
      const g = gapIndex(thr, X[r][f]);
      const v = y[r];
      gSum[g] += v; gSq[g] += v * v; gCnt[g] += 1;
    }
    let leftSum = 0, leftSq = 0, leftCnt = 0;
    for (let t = 0; t < B; t++) {
      leftSum += gSum[t]; leftSq += gSq[t]; leftCnt += gCnt[t];
      const nL = leftCnt, nR = n - nL;
      if (nL < minLeaf || nR < minLeaf) continue;
      const rSum = total - leftSum, rSq = totalSq - leftSq;
      const childSse = sse(leftSum, leftSq, nL) + sse(rSum, rSq, nR);
      const gain = parentSse - childSse;
      if (gain > 0 && (best === null || gain > best.gain)) {
        best = { feature: f, threshold: thr[t], gain };
      }
    }
  }
  return best;
}

function sampleFeatures(nFeatures, k, rnd) {
  const pool = [];
  for (let i = 0; i < nFeatures; i++) pool.push(i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return pool.slice(0, k);
}

function grow(X, y, idx, depth, opts, rnd, thresholds, importance) {
  const n = idx.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += y[idx[i]];
  const mean = sum / n;
  if (depth >= opts.maxDepth || n < opts.minSamplesSplit) {
    return { leaf: true, value: mean, n };
  }
  const featureSet = sampleFeatures(X[0].length, opts.maxFeatures, rnd);
  const split = bestSplit(X, y, idx, featureSet, thresholds, opts.minSamplesLeaf);
  if (!split) return { leaf: true, value: mean, n };

  const leftIdx = [], rightIdx = [];
  for (let i = 0; i < n; i++) {
    const r = idx[i];
    if (X[r][split.feature] <= split.threshold) leftIdx.push(r);
    else rightIdx.push(r);
  }
  if (leftIdx.length < opts.minSamplesLeaf || rightIdx.length < opts.minSamplesLeaf) {
    return { leaf: true, value: mean, n };
  }
  importance[split.feature] += split.gain;
  return {
    leaf: false,
    feature: split.feature,
    threshold: split.threshold,
    left: grow(X, y, leftIdx, depth + 1, opts, rnd, thresholds, importance),
    right: grow(X, y, rightIdx, depth + 1, opts, rnd, thresholds, importance),
  };
}

function trainForest(X, y, options) {
  if (!X.length) throw new Error('trainForest: empty training matrix');
  const nFeatures = X[0].length;
  const opts = Object.assign({
    nTrees: 80,
    maxDepth: 12,
    minSamplesSplit: 12,
    minSamplesLeaf: 6,
    maxFeatures: Math.max(1, Math.ceil(nFeatures / 3)),
    nBins: 24,
    seed: 42,
  }, options || {});

  const rnd = mulberry32(opts.seed);
  const thresholds = featureThresholds(X, opts.nBins);
  const importance = new Array(nFeatures).fill(0);
  const trees = [];
  const n = X.length;

  for (let t = 0; t < opts.nTrees; t++) {
    const boot = new Array(n);
    for (let i = 0; i < n; i++) boot[i] = Math.floor(rnd() * n);
    trees.push(grow(X, y, boot, 0, opts, rnd, thresholds, importance));
  }

  const impTotal = importance.reduce(function add(a, b) { return a + b; }, 0) || 1;
  return {
    trees,
    nFeatures,
    opts,
    featureImportance: importance.map(function norm(v) { return v / impTotal; }),
  };
}

function predictTree(node, x) {
  let cur = node;
  while (!cur.leaf) cur = x[cur.feature] <= cur.threshold ? cur.left : cur.right;
  return cur.value;
}

function predictForest(model, x) {
  let sum = 0;
  const trees = model.trees;
  for (let i = 0; i < trees.length; i++) sum += predictTree(trees[i], x);
  return sum / trees.length;
}

// Per-tree prediction spread for one row: the cheap ensemble variance
// the probabilistic emergency-entry logic uses (ml-forecast.js,
// findings-doc rec #4). `mean` equals predictForest's output;
// predictForest itself stays untouched.
function predictForestStats(model, x) {
  const trees = model.trees;
  const n = trees.length;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const v = predictTree(trees[i], x);
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const variance = Math.max(0, sumSq / n - mean * mean);
  return { mean, std: Math.sqrt(variance) };
}

module.exports = {
  mulberry32,
  trainForest,
  predictForest,
  predictForestStats,
  featureThresholds,
};
