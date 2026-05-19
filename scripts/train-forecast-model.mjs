#!/usr/bin/env node
'use strict';

// ML temperature-forecast feasibility study.
//
// Fetches the public history feed, builds a feature dataset, trains a
// random-forest model (nordpool-predict-fi style: each step's value
// comes independently from its feature combination), and reports
// whether the available data carries enough signal to drive a forecast.
//
// Usage:
//   node scripts/train-forecast-model.mjs [--data <path>] [--refresh]
//                                         [--url <endpoint>] [--save <path>]
//
// Without --data it fetches range=all from the live site and caches it
// to /tmp so repeat runs are fast. --save writes the trained model JSON.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import rf from '../server/lib/forecast/ml/random-forest.js';
import { computeMlForecast } from '../server/lib/forecast/ml/ml-forecast.js';
import ds from './forecast-ml/dataset.js';

const DEFAULT_URL = 'https://greenhouse.madekivi.fi/api/public/history?range=all';
const CACHE_PATH = '/tmp/greenhouse-public-history.json';

// ── args ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = { refresh: false, url: DEFAULT_URL, data: null, save: null };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--refresh') a.refresh = true;
    else if (v === '--url') a.url = argv[++i];
    else if (v === '--data') a.data = argv[++i];
    else if (v === '--save') a.save = argv[++i];
  }
  return a;
}

async function loadPayload(args) {
  if (args.data) {
    console.log('Loading dataset from ' + args.data);
    return JSON.parse(readFileSync(args.data, 'utf8'));
  }
  if (!args.refresh && existsSync(CACHE_PATH)) {
    console.log('Loading cached dataset from ' + CACHE_PATH);
    return JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  }
  console.log('Fetching ' + args.url + ' ...');
  const res = await fetch(args.url);
  if (!res.ok) throw new Error('Fetch failed: HTTP ' + res.status);
  const text = await res.text();
  writeFileSync(CACHE_PATH, text);
  console.log('Cached to ' + CACHE_PATH + ' (' + (text.length / 1e6).toFixed(1) + ' MB)');
  return JSON.parse(text);
}

// ── metrics ─────────────────────────────────────────────────────────

function rmse(pred, actual) {
  let s = 0;
  for (let i = 0; i < pred.length; i++) { const e = pred[i] - actual[i]; s += e * e; }
  return Math.sqrt(s / pred.length);
}

function mae(pred, actual) {
  let s = 0;
  for (let i = 0; i < pred.length; i++) s += Math.abs(pred[i] - actual[i]);
  return s / pred.length;
}

function r2(pred, actual) {
  let mean = 0;
  for (let i = 0; i < actual.length; i++) mean += actual[i];
  mean /= actual.length;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < actual.length; i++) {
    ssRes += (pred[i] - actual[i]) * (pred[i] - actual[i]);
    ssTot += (actual[i] - mean) * (actual[i] - mean);
  }
  return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
}

function std(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) m += arr[i];
  m /= arr.length;
  let v = 0;
  for (let i = 0; i < arr.length; i++) v += (arr[i] - m) * (arr[i] - m);
  return Math.sqrt(v / arr.length);
}

// ── ridge linear regression baseline ────────────────────────────────

function solveLinear(A, b) {
  const n = b.length;
  const M = A.map(function copy(r, i) { return r.concat([b[i]]); });
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    }
    const tmp = M[c]; M[c] = M[piv]; M[piv] = tmp;
    const d = M[c][c] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map(function val(r, i) { return r[n] / (r[i] || 1e-9); });
}

// Standardised ridge regression; returns a predictor function.
function fitRidge(X, y, lambda) {
  const p = X[0].length;
  const mean = new Array(p).fill(0);
  const sd = new Array(p).fill(0);
  for (let j = 0; j < p; j++) {
    for (let i = 0; i < X.length; i++) mean[j] += X[i][j];
    mean[j] /= X.length;
  }
  for (let j = 0; j < p; j++) {
    let v = 0;
    for (let i = 0; i < X.length; i++) v += (X[i][j] - mean[j]) * (X[i][j] - mean[j]);
    sd[j] = Math.sqrt(v / X.length) || 1;
  }
  const z = function zrow(row) {
    const out = [1];
    for (let j = 0; j < p; j++) out.push((row[j] - mean[j]) / sd[j]);
    return out;
  };
  const dim = p + 1;
  const A = [];
  for (let r = 0; r < dim; r++) A.push(new Array(dim).fill(0));
  const bv = new Array(dim).fill(0);
  for (let i = 0; i < X.length; i++) {
    const zi = z(X[i]);
    for (let r = 0; r < dim; r++) {
      bv[r] += zi[r] * y[i];
      for (let c = 0; c < dim; c++) A[r][c] += zi[r] * zi[c];
    }
  }
  for (let r = 1; r < dim; r++) A[r][r] += lambda;
  const beta = solveLinear(A, bv);
  return function predict(row) {
    const zi = z(row);
    let s = 0;
    for (let r = 0; r < dim; r++) s += beta[r] * zi[r];
    return s;
  };
}

// ── helpers ─────────────────────────────────────────────────────────

function pct(x) { return (x * 100).toFixed(1) + '%'; }
function f2(x) { return x.toFixed(3); }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

function predictAll(model, X) {
  return X.map(function one(row) { return rf.predictForest(model, row); });
}

function singleStepReport(label, X, yTrain, XTest, yTest, model, lin) {
  const predRf = predictAll(model, XTest);
  const predLin = XTest.map(function p(r) { return lin(r); });
  const zero = yTest.map(function z() { return 0; });
  console.log('\n  ' + label);
  console.log('    target spread (test, per-step change):  std = ' + f2(std(yTest)) + ' degC');
  console.log('    persistence (no change)  RMSE = ' + pad(f2(rmse(zero, yTest)), 8)
    + ' MAE = ' + pad(f2(mae(zero, yTest)), 8));
  console.log('    ridge linear             RMSE = ' + pad(f2(rmse(predLin, yTest)), 8)
    + ' MAE = ' + pad(f2(mae(predLin, yTest)), 8) + ' R2 = ' + f2(r2(predLin, yTest)));
  console.log('    random forest            RMSE = ' + pad(f2(rmse(predRf, yTest)), 8)
    + ' MAE = ' + pad(f2(mae(predRf, yTest)), 8) + ' R2 = ' + f2(r2(predRf, yTest)));
  return { rfRmse: rmse(predRf, yTest), zeroRmse: rmse(zero, yTest) };
}

// Horizon buckets for the multi-step error breakdown.
const BUCKETS = [[1, 6], [7, 12], [13, 24], [25, 48]];

function bucketLabel(h) {
  for (let i = 0; i < BUCKETS.length; i++) {
    if (h >= BUCKETS[i][0] && h <= BUCKETS[i][1]) return BUCKETS[i][0] + '-' + BUCKETS[i][1] + 'h';
  }
  return null;
}

function emptyBuckets() {
  const o = {};
  BUCKETS.forEach(function init(b) { o[b[0] + '-' + b[1] + 'h'] = { tank: [], gh: [] }; });
  return o;
}

function bucketRmse(buckets, key) {
  const out = {};
  Object.keys(buckets).forEach(function each(k) {
    const arr = buckets[k][key];
    if (!arr.length) { out[k] = null; return; }
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    out[k] = Math.sqrt(s / arr.length);
  });
  return out;
}

// Recursive 48 h rollout from each start anchor. Uses actual historical
// mode fractions (the controller's real decisions) — so this measures
// the thermal model assuming a perfect mode schedule; predicting the
// schedule itself is a separate problem the engine already simulates.
function rolloutReport(index, tankModel, ghModel, startTs, endTs) {
  const buckets = emptyBuckets();
  let starts = 0;
  for (let t0 = startTs; t0 <= endTs - 48 * ds.STEP_COARSE_MS; t0 += 6 * ds.STEP_COARSE_MS) {
    const s0 = index.stateAt(t0);
    if (!s0) continue;
    let tankAvg = s0.tankAvg;
    let gh = s0.greenhouse;
    let ok = true;
    for (let h = 1; h <= 48 && ok; h++) {
      const hStart = t0 + (h - 1) * ds.STEP_COARSE_MS;
      const wx = index.weatherAt(hStart);
      if (!ds.weatherUsable(wx)) { ok = false; break; }
      const frac = index.modeFractions(hStart, hStart + ds.STEP_COARSE_MS);
      const aux = index.auxFractions(hStart, hStart + ds.STEP_COARSE_MS);
      const row = ds.featureRow(tankAvg, gh, wx.temperature, wx, frac, aux, hStart, ds.STEP_COARSE_MS);
      tankAvg += rf.predictForest(tankModel, row);
      gh += rf.predictForest(ghModel, row);
      const actual = index.stateAt(hStart + ds.STEP_COARSE_MS);
      if (actual) {
        const b = bucketLabel(h);
        if (b) {
          buckets[b].tank.push(tankAvg - actual.tankAvg);
          buckets[b].gh.push(gh - actual.greenhouse);
        }
      }
    }
    if (ok) starts++;
  }
  return { tank: bucketRmse(buckets, 'tank'), gh: bucketRmse(buckets, 'gh'), starts };
}

// Error of the shipping physics engine, from its stored predictions.
function physicsReport(payload, index) {
  const buckets = emptyBuckets();
  (payload.predictions || []).forEach(function each(p) {
    const b = bucketLabel(p.horizonH);
    if (!b) return;
    const actual = index.stateAt(Date.parse(p.forHour));
    if (!actual) return;
    if (typeof p.tankAvgC === 'number') buckets[b].tank.push(p.tankAvgC - actual.tankAvg);
    if (typeof p.greenhouseC === 'number') buckets[b].gh.push(p.greenhouseC - actual.greenhouse);
  });
  return { tank: bucketRmse(buckets, 'tank'), gh: bucketRmse(buckets, 'gh') };
}

function printBuckets(label, res) {
  let line = '    ' + pad(label, 22);
  Object.keys(res).forEach(function each(k) {
    line += pad(k + ': ' + (res[k] === null ? '  n/a' : res[k].toFixed(2)), 16);
  });
  console.log(line);
}

function importanceReport(model, names) {
  const ranked = model.featureImportance
    .map(function tag(v, i) { return { name: names[i], v }; })
    .sort(function cmp(a, b) { return b.v - a.v; });
  ranked.slice(0, 8).forEach(function row(r) {
    console.log('    ' + pad(r.name, 26) + pct(r.v));
  });
}

function rmseR2(model, X, y) {
  const p = predictAll(model, X);
  return { rmse: rmse(p, y), r2: r2(p, y) };
}

// Retrain with the controller thresholds appended as features and
// compare held-out accuracy — answers "does the model need to know the
// tuning thresholds, or is the observed mode enough?".
function thresholdExperiment(data, split, Xtr, Xte, tankTe, ghTe, baseTank, baseGh) {
  const keys = ds.TU_KEYS;
  console.log('  threshold variation across the ' + data.tu.length + ' training samples:');
  keys.forEach(function show(k) {
    const vals = Array.from(new Set(data.tu.map(function pick(t) { return t[k]; })))
      .sort(function cmp(a, b) { return a - b; });
    console.log('    ' + pad(k, 6) + JSON.stringify(vals)
      + (vals.length < 2 ? '   (constant — unlearnable)' : ''));
  });

  function augment(baseX, tuRows) {
    return baseX.map(function row(r, i) {
      return r.concat(keys.map(function val(k) { return tuRows[i][k]; }));
    });
  }
  const augXtr = augment(Xtr, data.tu.slice(0, split));
  const augXte = augment(Xte, data.tu.slice(split));
  const augTank = rf.trainForest(augXtr, data.yTank.slice(0, split), { seed: 1 });
  const augGh = rf.trainForest(augXtr, data.yGh.slice(0, split), { seed: 2 });

  const bt = rmseR2(baseTank, Xte, tankTe);
  const at = rmseR2(augTank, augXte, tankTe);
  const bg = rmseR2(baseGh, Xte, ghTe);
  const ag = rmseR2(augGh, augXte, ghTe);
  console.log('\n  held-out 1 h accuracy   baseline (' + ds.FEATURE_NAMES.length
    + ' feat)      + thresholds (' + (ds.FEATURE_NAMES.length + keys.length) + ' feat)');
  console.log('    tank        RMSE ' + pad(f2(bt.rmse), 9) + 'R2 ' + pad(f2(bt.r2), 11)
    + 'RMSE ' + pad(f2(at.rmse), 9) + 'R2 ' + f2(at.r2));
  console.log('    greenhouse  RMSE ' + pad(f2(bg.rmse), 9) + 'R2 ' + pad(f2(bg.r2), 11)
    + 'RMSE ' + pad(f2(ag.rmse), 9) + 'R2 ' + f2(ag.r2));
  console.log('\n  threshold-feature importance (augmented tank model):');
  keys.forEach(function imp(k, i) {
    console.log('    ' + pad(k, 7) + pct(augTank.featureImportance[ds.FEATURE_NAMES.length + i]));
  });
}

// Drive computeMlForecast at a range of greenhouse-heating thresholds
// from one fixed start state — shows whether the *forecast* responds to
// the threshold even though the random forest does not take it as input.
function sensitivitySweep() {
  let model;
  try {
    model = JSON.parse(gunzipSync(
      readFileSync('server/lib/forecast/ml/forecast-model.json.gz')).toString('utf8'));
  } catch (e) {
    console.log('  (skipped — committed model not found: ' + e.message + ')');
    return;
  }
  const wx = [], px = [];
  for (let h = 0; h < 48; h++) {
    const hod = h % 24;
    wx.push({ temperature: 6, radiationGlobal: (hod >= 9 && hod <= 16) ? 250 : 0, windSpeed: 3, precipitation: 0 });
    px.push({ priceCKwh: 12 });
  }
  console.log('  start: tank 37 degC, greenhouse 15 degC, 6 degC outdoor, partly-sunny days');
  console.log('    geT/gxT    tank avg +12h    +24h    +48h    heating h   backup kWh');
  // The multi-resolution trajectory is 48 five-min points (hours 0-4)
  // then hourly points — map an hour offset to its trajectory index.
  const trajAvgAt = function avgAt(traj, h) {
    const idx = h <= 4 ? h * 12 : 48 + (h - 4);
    return (traj[idx] ? traj[idx].avg : NaN).toFixed(1);
  };
  [8, 10, 12, 14, 16].forEach(function sweep(geT) {
    const fc = computeMlForecast({
      now: new Date('2026-05-15T15:00:00Z'),
      tankTop: 40, tankBottom: 34, greenhouseTemp: 15, currentMode: 'idle',
      weather48h: wx, prices48h: px, model,
      config: { greenhouseEnterC: geT, greenhouseExitC: geT + 1 },
    });
    console.log('    ' + pad(geT + '/' + (geT + 1), 11)
      + pad(trajAvgAt(fc.tankTrajectory, 12), 16)
      + pad(trajAvgAt(fc.tankTrajectory, 24), 8)
      + pad(trajAvgAt(fc.tankTrajectory, 48), 8)
      + pad(fc.greenhouseHeatingHours.toFixed(1), 12)
      + fc.electricKwh.toFixed(1));
  });
}

// ── main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const payload = await loadPayload(args);

  console.log('\n=== ML Temperature Forecast — Feasibility Study ===');
  const data = ds.buildDataset(payload);
  if (data.X.length < 100) {
    console.log('Not enough usable samples (' + data.X.length + '). Aborting.');
    process.exit(1);
  }

  const spanDays = (data.index.lastTs - data.index.firstTs) / 86400000;
  console.log('\nDataset');
  console.log('  history span        ' + spanDays.toFixed(1) + ' days');
  console.log('  raw sensor points   ' + payload.points.length);
  console.log('  weather rows        ' + payload.weather.length);
  console.log('  mode transitions    ' + payload.events.length);
  console.log('  training samples    ' + data.X.length + ' (5-min + 1-h steps, 15 min anchors)');
  console.log('  features            ' + ds.FEATURE_NAMES.length);

  // Time-ordered split: train on the older 80%, test on the newest 20%.
  // A random split would leak — adjacent 15 min anchors overlap heavily.
  const split = Math.floor(data.X.length * 0.8);
  const Xtr = data.X.slice(0, split);
  const Xte = data.X.slice(split);
  const tankTr = data.yTank.slice(0, split), tankTe = data.yTank.slice(split);
  const ghTr = data.yGh.slice(0, split), ghTe = data.yGh.slice(split);
  const splitTs = data.t0s[split];
  console.log('  train / test        ' + Xtr.length + ' / ' + Xte.length
    + ' (test from ' + new Date(splitTs).toISOString().slice(0, 16) + ')');

  console.log('\nTraining random forest (' + 80 + ' trees) ...');
  const t0 = Date.now();
  const tankModel = rf.trainForest(Xtr, tankTr, { seed: 1 });
  const ghModel = rf.trainForest(Xtr, ghTr, { seed: 2 });
  console.log('  done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

  const linTank = fitRidge(Xtr, tankTr, 1);
  const linGh = fitRidge(Xtr, ghTr, 1);

  console.log('\n--- Single-step accuracy (held-out test period) ---');
  singleStepReport('Tank average temperature', Xtr, tankTr, Xte, tankTe, tankModel, linTank);
  singleStepReport('Greenhouse temperature', Xtr, ghTr, Xte, ghTe, ghModel, linGh);

  console.log('\n--- 48 h recursive rollout RMSE (degC), by horizon ---');
  console.log('  (rollout uses actual mode schedule; isolates thermal-model error)');
  const roll = rolloutReport(data.index, tankModel, ghModel, splitTs, data.index.lastTs);
  const phys = physicsReport(payload, data.index);
  console.log('  rollout start points: ' + roll.starts);
  console.log('\n  Tank average:');
  printBuckets('ML rollout', roll.tank);
  printBuckets('physics engine (shipped)', phys.tank);
  console.log('\n  Greenhouse:');
  printBuckets('ML rollout', roll.gh);
  printBuckets('physics engine (shipped)', phys.gh);

  console.log('\n--- Feature importance (tank model) ---');
  importanceReport(tankModel, ds.FEATURE_NAMES);

  console.log('\n--- Threshold-feature experiment ---');
  thresholdExperiment(data, split, Xtr, Xte, tankTe, ghTe, tankModel, ghModel);

  console.log('\n--- Forecast sensitivity to the greenhouse-heating threshold ---');
  sensitivitySweep();

  if (args.save) {
    // The committed artifact is trained on ALL available history (the
    // 80/20 split above exists only to produce the held-out report).
    console.log('\nTraining shipped model on full history ...');
    const tankFull = rf.trainForest(data.X, data.yTank, { seed: 1 });
    const ghFull = rf.trainForest(data.X, data.yGh, { seed: 2 });
    const model = {
      version: 1,
      featureNames: ds.FEATURE_NAMES,
      steps: [ds.STEP_FINE_MS, ds.STEP_COARSE_MS],
      featureRanges: ds.featureRanges(data.X),
      tank: tankFull,
      greenhouse: ghFull,
      trainedAt: new Date().toISOString(),
      trainSamples: data.X.length,
    };
    const json = JSON.stringify(model);
    const gzip = /\.gz$/.test(args.save);
    const out = gzip ? gzipSync(json, { level: 9 }) : json;
    writeFileSync(args.save, out);
    console.log('Model saved to ' + args.save + ' ('
      + (json.length / 1e6).toFixed(2) + ' MB JSON'
      + (gzip ? ' -> ' + (out.length / 1e6).toFixed(2) + ' MB gzip' : '') + ')');
  }
  console.log('');
}

main().catch(function fail(err) {
  console.error(err);
  process.exit(1);
});
