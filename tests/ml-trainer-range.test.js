'use strict';

// Regression guard: the in-process ML trainer must pull a BOUNDED
// history window, never the full 'all' range.
//
// `sensor_readings_30s` accumulates forever (see CLAUDE.md — it is never
// pruned), so training on range 'all' grows the in-memory dataset without
// bound. On 2026-06-22 this finally exceeded the app container's V8 heap
// (~250 MB): the trainer's initial run (3 min after boot) OOM-killed the
// process, which CrashLoopBackOff'd and surfaced as nginx 503s. The fix
// bounds the training window so memory stays constant regardless of how
// long the system has been collecting data.

const { test } = require('node:test');
const assert = require('node:assert');

const { createMlTrainer } = require('../server/lib/forecast/ml/ml-trainer');

test('trainer requests a bounded history window, not the full "all" range', async () => {
  const ranges = [];
  const db = {
    getHistory(range, _sensor, cb) { ranges.push(range); cb(null, []); },
    getEvents(range, _type, cb) { ranges.push(range); cb(null, []); },
  };
  const getForecastDataset = (opts, cb) => {
    ranges.push(opts && opts.range);
    cb(null, { weather: [], generations: [] });
  };
  const trainer = createMlTrainer({
    db,
    log: { info() {}, warn() {}, error() {} },
    getForecastDataset,
    modelStore: { get() { return null; }, set(_m, cb) { cb && cb(); } },
  });

  await new Promise((resolve) => trainer.retrainOnce(resolve));

  assert.ok(ranges.length > 0, 'trainer should query history at least once');
  for (const r of ranges) {
    assert.notStrictEqual(r, 'all',
      'trainer must not load the unbounded "all" range — it grows the heap without limit');
  }
  // All loaders must share the same bounded window so events/weather align
  // with the sensor history.
  const unique = Array.from(new Set(ranges));
  assert.strictEqual(unique.length, 1,
    'all loaders should use one consistent bounded range; got ' + JSON.stringify(unique));
});
