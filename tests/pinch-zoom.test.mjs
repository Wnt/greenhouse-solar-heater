/**
 * Unit tests for pinchZoomWindow — the pure helper behind two-finger
 * pinch zoom on the history-graph canvas. The y-axis is fixed; only the
 * x-axis range changes. The current timeframe-selector value
 * (1H/6H/12H/24H) is the upper bound — pinch can shrink below it but
 * never grow past it. When the gesture would zoom out beyond that bound
 * the helper returns null, signalling the caller to clear chartZoom and
 * fall back to the default sliding window.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { pinchZoomWindow, panZoomWindow, computeDefaultBound } from '../playground/js/main/chart-pinch-zoom.js';

const HOUR = 3600;

describe('pinchZoomWindow', () => {
  it('halves the visible range when fingers spread to twice the distance', () => {
    const r = pinchZoomWindow({
      initialRange: 24 * HOUR,
      initialFracOfPinchCenter: 0.5,
      initialTimeAtPinchCenter: 12 * HOUR,
      distanceRatio: 2,
      maxRange: 24 * HOUR,
      minRange: 60,
    });
    assert.equal(r.tMax - r.tMin, 12 * HOUR);
  });

  it('keeps the time at the pinch center pinned to the same canvas fraction', () => {
    // Fingers landed at 25% across the plot, looking at the 6h mark in sim
    // time. After zooming 2×, that mark must still sit at 25% across.
    const r = pinchZoomWindow({
      initialRange: 24 * HOUR,
      initialFracOfPinchCenter: 0.25,
      initialTimeAtPinchCenter: 6 * HOUR,
      distanceRatio: 2,
      maxRange: 24 * HOUR,
      minRange: 60,
    });
    const newRange = r.tMax - r.tMin;
    const tAtFrac = r.tMin + 0.25 * newRange;
    assert.ok(Math.abs(tAtFrac - 6 * HOUR) < 1e-6);
  });

  it('returns null when the gesture would equal or exceed maxRange', () => {
    // distanceRatio < 1 means fingers came together — caller wants to
    // zoom out. With initialRange already at maxRange any zoom-out
    // immediately busts the cap.
    const r = pinchZoomWindow({
      initialRange: 12 * HOUR,
      initialFracOfPinchCenter: 0.5,
      initialTimeAtPinchCenter: 12 * HOUR,
      distanceRatio: 0.4,
      maxRange: 24 * HOUR,
      minRange: 60,
    });
    assert.equal(r, null);
  });

  it('clamps very tight pinches to minRange instead of going to zero', () => {
    const r = pinchZoomWindow({
      initialRange: 1 * HOUR,
      initialFracOfPinchCenter: 0.5,
      initialTimeAtPinchCenter: 0,
      distanceRatio: 1000,
      maxRange: 24 * HOUR,
      minRange: 60,
    });
    assert.equal(r.tMax - r.tMin, 60);
  });

  it('zooms within an already-zoomed window without resetting', () => {
    // Caller has already pinched in — chartZoom currently spans 6 h. A
    // further 1.5× zoom should narrow it further, not snap back to
    // maxRange.
    const r = pinchZoomWindow({
      initialRange: 6 * HOUR,
      initialFracOfPinchCenter: 0.5,
      initialTimeAtPinchCenter: 3 * HOUR,
      distanceRatio: 1.5,
      maxRange: 24 * HOUR,
      minRange: 60,
    });
    assert.ok(r !== null, 'expected a window, got null');
    assert.equal(r.tMax - r.tMin, 4 * HOUR);
  });
});

describe('panZoomWindow', () => {
  const BOUND = { tMin: 0, tMax: 24 * HOUR };

  it('shifts the window by dt when fully inside the bound', () => {
    const r = panZoomWindow({ tMin: 6 * HOUR, tMax: 12 * HOUR }, 1 * HOUR, BOUND);
    assert.equal(r.tMin, 7 * HOUR);
    assert.equal(r.tMax, 13 * HOUR);
  });

  it('clamps to the left bound and preserves window width', () => {
    // Wanted [-2, 4]; clamped to [0, 6].
    const r = panZoomWindow({ tMin: 1 * HOUR, tMax: 7 * HOUR }, -3 * HOUR, BOUND);
    assert.equal(r.tMin, 0);
    assert.equal(r.tMax, 6 * HOUR);
  });

  it('clamps to the right bound and preserves window width', () => {
    // Wanted [23, 27]; clamped to [20, 24].
    const r = panZoomWindow({ tMin: 18 * HOUR, tMax: 22 * HOUR }, 5 * HOUR, BOUND);
    assert.equal(r.tMin, 20 * HOUR);
    assert.equal(r.tMax, 24 * HOUR);
  });

  it('clamps a far-overshooting pan against either bound', () => {
    const r = panZoomWindow({ tMin: 5 * HOUR, tMax: 10 * HOUR }, -100 * HOUR, BOUND);
    assert.equal(r.tMin, 0);
    assert.equal(r.tMax, 5 * HOUR);
  });

  it('returns the same window when dt is zero', () => {
    const r = panZoomWindow({ tMin: 5 * HOUR, tMax: 9 * HOUR }, 0, BOUND);
    assert.equal(r.tMin, 5 * HOUR);
    assert.equal(r.tMax, 9 * HOUR);
  });
});

describe('computeDefaultBound', () => {
  const NOW = 1000 * HOUR;

  it('clamps right edge at "now" in live mode without forecast', () => {
    const b = computeDefaultBound({
      isLive: true, latestSampleT: NOW - 60, nowSec: NOW,
      graphRange: 24 * HOUR, showForecast: false, forecastSec: 48 * HOUR,
    });
    assert.equal(b.tMax, NOW);
    assert.equal(b.tMin, NOW - 24 * HOUR);
  });

  it('extends right edge by forecastSec when forecast overlay is on (live mode)', () => {
    const b = computeDefaultBound({
      isLive: true, latestSampleT: NOW - 60, nowSec: NOW,
      graphRange: 24 * HOUR, showForecast: true, forecastSec: 48 * HOUR,
    });
    assert.equal(b.tMax, NOW + 48 * HOUR,
      'pannable area must include the projected horizon so users can pan into it');
    assert.equal(b.tMin, NOW - 24 * HOUR,
      'historical left edge stays anchored to graphRange — turning forecast on does not stretch history');
  });

  it('ignores forecast in sim mode (forecast overlay is live-only)', () => {
    const b = computeDefaultBound({
      isLive: false, latestSampleT: 36 * HOUR, nowSec: NOW,
      graphRange: 24 * HOUR, showForecast: true, forecastSec: 48 * HOUR,
    });
    assert.equal(b.tMax, 36 * HOUR);
  });
});
