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
import { pinchZoomWindow } from '../playground/js/main/chart-pinch-zoom.js';

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
