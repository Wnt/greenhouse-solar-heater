/**
 * Unit tests for autoYRange — the pure helper that the chart's
 * fullscreen mode uses to fit the Y axis to the visible non-hidden
 * temperature samples. The embedded card view stays on the fixed
 * [0,100] range, so this helper is only exercised when the user
 * enters fullscreen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { autoYRange } from '../playground/js/main/history-graph.js';

function makeStore(rows) {
  return {
    times: rows.map(r => r.t),
    values: rows.map(r => r.v),
  };
}

describe('autoYRange', () => {
  it('returns [0,100] when no in-window samples exist', () => {
    const store = makeStore([]);
    const r = autoYRange(store, 0, 1000, new Set(), false);
    assert.deepStrictEqual(r, { yMin: 0, yMax: 100 });
  });

  it('fits the visible range with 10% headroom snapped to multiples of 5', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 30, t_tank_top: 50, t_tank_bottom: 40, t_greenhouse: 18, t_outdoor: 10 } },
      { t: 200, v: { t_collector: 60, t_tank_top: 55, t_tank_bottom: 42, t_greenhouse: 19, t_outdoor: 11 } },
    ]);
    const r = autoYRange(store, 0, 1000, new Set(), false);
    // min visible = 10 (outdoor), max visible = 60 (collector)
    // range = 50 → pad ±5 → [5, 65] → snap to multiples of 5 = [5, 65]
    assert.strictEqual(r.yMin, 5);
    assert.strictEqual(r.yMax, 65);
  });

  it('skips samples outside [tMin,tMax]', () => {
    const store = makeStore([
      { t: 50,  v: { t_collector: 90, t_tank_top: 80, t_tank_bottom: 70, t_greenhouse: 60, t_outdoor: 50 } },
      { t: 200, v: { t_collector: 30, t_tank_top: 40, t_tank_bottom: 30, t_greenhouse: 18, t_outdoor: 10 } },
    ]);
    const r = autoYRange(store, 100, 300, new Set(), false);
    // Only the t=200 row counts: min=10, max=35 (tank avg = (40+30)/2)
    // range = 25 → pad ±2.5 → [7.5, 37.5] → floor/ceil to /5 = [5, 40]
    assert.strictEqual(r.yMin, 5);
    assert.strictEqual(r.yMax, 40);
  });

  it('drops a series whose id is in the hidden set', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 90, t_tank_top: 50, t_tank_bottom: 40, t_greenhouse: 20, t_outdoor: 12 } },
    ]);
    const r = autoYRange(store, 0, 1000, new Set(['t_collector']), false);
    // collector hidden — max visible = 45 (tank avg), min = 12 (outdoor)
    assert.ok(r.yMax < 90, `expected < 90 with collector hidden, got ${r.yMax}`);
  });

  it('drops the tank average when "tank" is hidden', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 30, t_tank_top: 90, t_tank_bottom: 80, t_greenhouse: 20, t_outdoor: 12 } },
    ]);
    // With tank hidden and allSensors=false, the 80-90° tank readings
    // shouldn't pull the upper bound up — only collector/greenhouse/outdoor
    // contribute, so max ≈ 30.
    const r = autoYRange(store, 0, 1000, new Set(['tank']), false);
    assert.ok(r.yMax <= 35, `expected yMax around 30 with tank hidden, got ${r.yMax}`);
  });

  it('includes tank top/bottom only when allSensors=true', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 30, t_tank_top: 80, t_tank_bottom: 60, t_greenhouse: 20, t_outdoor: 12 } },
    ]);
    // With tank hidden but allSensors=true the individual top/bottom
    // are visible and pull the upper bound to ~80.
    const r = autoYRange(store, 0, 1000, new Set(['tank']), true);
    assert.ok(r.yMax >= 80, `expected yMax >= 80 with allSensors top visible, got ${r.yMax}`);
  });

  it('keeps a flat-line band visible (5° floor on the data span)', () => {
    const store = makeStore([
      { t: 100, v: { t_collector: 20, t_tank_top: 20, t_tank_bottom: 20, t_greenhouse: 20, t_outdoor: 20 } },
      { t: 200, v: { t_collector: 20.1, t_tank_top: 20, t_tank_bottom: 20, t_greenhouse: 20, t_outdoor: 20 } },
    ]);
    const r = autoYRange(store, 0, 1000, new Set(), false);
    // All ≈20 → floor enforces ≥5° band; with 10% headroom and snap
    // to /5, the result must straddle 20 with a non-zero range.
    assert.ok(r.yMax - r.yMin >= 5, `expected band ≥ 5°, got ${r.yMax - r.yMin}`);
    assert.ok(r.yMin <= 20 && r.yMax >= 20);
  });
});
