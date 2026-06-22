'use strict';

// Regression guard: the in-process ML trainer must pull a BOUNDED but
// SUFFICIENT history window at a FINE resolution — never the full 'all'
// range, and not so short it starves the model.
//
// Background: training on range 'all' loaded every row of
// sensor_readings_30s (a table that grows forever, never pruned) and
// OOM-killed the app's V8 heap (~250 MB) on the 3-min initial run,
// crash-looping the pod (nginx 503s, 2026-06-22). Bounding to a 7-day
// window fixed the memory but starved the model (gate rejected: tank R2
// below floor). The trainer now uses db.getTrainingHistory to pull ~1
// month at a fixed 5-minute resolution (= STEP_FINE_MS) — span decoupled
// from bucket size, so memory stays bounded while the model gets enough
// behavioural diversity to promote.

const { test } = require('node:test');
const assert = require('node:assert');

const { createMlTrainer } = require('../server/lib/forecast/ml/ml-trainer');

test('trainer pulls >= 1 month of history at a fine, fixed resolution — never "all"', async () => {
  let trainCall = null;
  const eventRanges = [];
  let datasetRange = null;
  const db = {
    // getHistory must NOT be the trainer's path (it couples span to bucket
    // size). If it is called, fail loudly.
    getHistory(range, _sensor, cb) { trainCall = { illegalRange: range }; cb(null, []); },
    getEvents(range, _type, cb) { eventRanges.push(range); cb(null, []); },
  };
  const getTrainingHistory = (days, bucket, cb) => { trainCall = { days, bucket }; cb(null, []); };
  const getForecastDataset = (opts, cb) => {
    datasetRange = opts && opts.range;
    cb(null, { weather: [], generations: [] });
  };
  const trainer = createMlTrainer({
    db,
    log: { info() {}, warn() {}, error() {} },
    getForecastDataset,
    getTrainingHistory,
    modelStore: { get() { return null; }, set(_m, cb) { cb && cb(); } },
  });

  await new Promise((resolve) => trainer.retrainOnce(resolve));

  assert.ok(trainCall && trainCall.days != null,
    'trainer must load history via getTrainingHistory, not getHistory');
  assert.ok(trainCall.days >= 28,
    'training window must be at least ~1 month; got ' + trainCall.days + ' days');
  assert.ok(trainCall.days <= 366,
    'training window must stay bounded (not effectively "all"); got ' + trainCall.days);
  assert.match(String(trainCall.bucket), /minute/,
    'resolution must be fine (minutes, ~STEP_FINE_MS), not coarse; got ' + trainCall.bucket);

  // Sparse loaders (events + forecast inputs) must share a bounded window,
  // never 'all'.
  assert.ok(eventRanges.length > 0, 'should load state events');
  for (const r of eventRanges) {
    assert.notStrictEqual(r, 'all', 'event loader must use a bounded range');
  }
  assert.notStrictEqual(datasetRange, 'all', 'forecast-dataset loader must use a bounded range');
  const allRanges = Array.from(new Set([...eventRanges, datasetRange]));
  assert.strictEqual(allRanges.length, 1,
    'event + forecast loaders should share one bounded window; got ' + JSON.stringify(allRanges));
});
