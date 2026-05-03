/**
 * Unit tests for computeSeriesStats — the pure helper that backs the
 * per-series legend labels (latest + min/max for the visible window,
 * issue #133). It walks the timeSeriesStore once and pulls the
 * latest in-window sample plus min/max for each requested key, so the
 * legend line "Collector 62° (30–62°)" updates in step with pan/zoom.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { computeSeriesStats, tankAvgOf } from '../playground/js/main/history-graph.js';

const baseKeys = [
  { id: 't_collector' },
  { id: 'tank', extract: tankAvgOf },
];

function makeStore(rows) {
  return {
    times: rows.map(r => r.t),
    values: rows.map(r => r.v),
  };
}

describe('computeSeriesStats', () => {
  it('returns min / max / latest for keys with samples in the window', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 30, t_tank_top: 40, t_tank_bottom: 30 } },
      { t: 200, v: { t_collector: 55, t_tank_top: 50, t_tank_bottom: 36 } },
      { t: 300, v: { t_collector: 62, t_tank_top: 56, t_tank_bottom: 40 } },
    ]);
    const stats = computeSeriesStats(store, 0, 1000, baseKeys);
    assert.deepEqual(stats.t_collector, { min: 30, max: 62, latest: 62 });
    // Tank avg: 35, 43, 48 → latest 48, range 35–48.
    assert.deepEqual(stats.tank, { min: 35, max: 48, latest: 48 });
  });

  it('respects the [tMin, tMax] window — out-of-window samples are skipped', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 90 } }, // out
      { t: 250, v: { t_collector: 30 } }, // in
      { t: 350, v: { t_collector: 40 } }, // in
      { t: 500, v: { t_collector: 99 } }, // out
    ]);
    const stats = computeSeriesStats(store, 200, 400, [{ id: 't_collector' }]);
    assert.deepEqual(stats.t_collector, { min: 30, max: 40, latest: 40 });
  });

  it('returns null for series with no in-window samples', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 30 } },
    ]);
    const stats = computeSeriesStats(store, 1000, 2000, [{ id: 't_collector' }, { id: 'tank', extract: tankAvgOf }]);
    assert.equal(stats.t_collector, null);
    assert.equal(stats.tank, null);
  });

  it('skips non-numeric / null values without poisoning min/max', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: null,    t_tank_top: 50, t_tank_bottom: 40 } },
      { t: 200, v: { t_collector: 30,      t_tank_top: 50, t_tank_bottom: 40 } },
      { t: 300, v: { t_collector: NaN,     t_tank_top: null, t_tank_bottom: 40 } },
      { t: 400, v: { t_collector: 'oops',  t_tank_top: 60, t_tank_bottom: 50 } },
    ]);
    const stats = computeSeriesStats(store, 0, 1000, baseKeys);
    // Only the t=200 sample contributes a numeric collector reading.
    assert.deepEqual(stats.t_collector, { min: 30, max: 30, latest: 30 });
    // Tank avg only valid at t=200 (45) and t=400 (55); t=300 has a null half.
    assert.deepEqual(stats.tank, { min: 45, max: 55, latest: 55 });
  });

  it('latest tracks the most recent in-window timestamp, not the largest value', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 80 } }, // largest, but earliest
      { t: 200, v: { t_collector: 50 } },
      { t: 300, v: { t_collector: 20 } }, // most recent
    ]);
    const stats = computeSeriesStats(store, 0, 1000, [{ id: 't_collector' }]);
    assert.deepEqual(stats.t_collector, { min: 20, max: 80, latest: 20 });
  });
});
