/**
 * Duty-cycle bar placement is computed by dutyBucketsIn — the pure helper
 * extracted from drawHistoryGraph in history-graph.js. It decides which
 * buckets the bar loop walks and what sub-interval coverage is queried over.
 *
 * Regression: when sim mode pinned the visible window to a fixed 24h, the
 * loop kept emitting buckets all the way to the right edge of the window.
 * coverageInBucket dutifully reported "still solar_charging" for every
 * bucket past the latest sample (modeAt extrapolates the most-recent
 * mode forward), so a 6-minute simulation painted red CHARGING bars
 * across the entire 24h timeline. Both edges must clamp to the data span.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dutyBucketsIn } from '../playground/js/main/history-graph.js';

const HOUR = 3600;

describe('dutyBucketsIn — visible duty-cycle buckets', () => {
  it('clamps the right edge to lastSampleT so future hours are not painted', () => {
    const buckets = dutyBucketsIn({
      tMin: 0,
      tMax: 24 * HOUR,
      bucketSec: HOUR,
      firstSampleT: 0,
      lastSampleT: 6 * HOUR,
    });
    assert.ok(buckets.length > 0, 'expected at least one bucket inside the data span');
    for (const b of buckets) {
      assert.ok(b.hrStart < 6 * HOUR, `bucket past lastSampleT was emitted: hrStart=${b.hrStart}`);
      assert.ok(b.segEnd <= 6 * HOUR, `segment extends past lastSampleT: segEnd=${b.segEnd}`);
    }
    const last = buckets[buckets.length - 1];
    assert.equal(last.segEnd, 6 * HOUR, 'final bucket should clamp segEnd to lastSampleT');
  });

  it('clamps the left edge to firstSampleT so pre-data buckets are skipped', () => {
    const buckets = dutyBucketsIn({
      tMin: 0,
      tMax: 24 * HOUR,
      bucketSec: HOUR,
      firstSampleT: 5 * HOUR,
      lastSampleT: 10 * HOUR,
    });
    for (const b of buckets) {
      assert.ok(b.hrEnd > 5 * HOUR, `bucket before firstSampleT was emitted: hrEnd=${b.hrEnd}`);
      assert.ok(b.segStart >= 5 * HOUR, `segment starts before firstSampleT: segStart=${b.segStart}`);
    }
    assert.equal(buckets[0].segStart, 5 * HOUR, 'first bucket should clamp segStart to firstSampleT');
  });

  it('emits every full bucket inside the data span when sim has run a while', () => {
    const buckets = dutyBucketsIn({
      tMin: 0,
      tMax: 24 * HOUR,
      bucketSec: HOUR,
      firstSampleT: 0,
      lastSampleT: 6 * HOUR,
    });
    // 6 hourly buckets fit fully inside [0, 6h]
    assert.equal(buckets.length, 6, `expected 6 buckets for 6h of data, got ${buckets.length}`);
    assert.equal(buckets[0].hrStart, 0);
    assert.equal(buckets[5].hrEnd, 6 * HOUR);
  });

  it('returns no buckets when no samples exist (lastSampleT <= firstSampleT)', () => {
    const buckets = dutyBucketsIn({
      tMin: 0,
      tMax: 24 * HOUR,
      bucketSec: HOUR,
      firstSampleT: 0,
      lastSampleT: 0,
    });
    assert.equal(buckets.length, 0);
  });
});
