/**
 * Unit tests for the history-graph line smoothing — a centered moving
 * average applied to ranges ≥ 7 days, scaled down as the user zooms in.
 *
 * The server already serves bucketed data for these ranges (5-min at 7d,
 * 30-min at 30d, etc.), but rendering bucket means as straight segments
 * still produces a visibly stair-stepped line. The client adds a small
 * additional moving-average so the lines read as curves; pinching in
 * narrows the window so detail comes back as the visible range shrinks.
 *
 * Both helpers are pure; the canvas-drawing call sites are integration-
 * tested by reload + screenshot in the playground.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  lineSmoothingWindow, smoothPoints,
} from '../playground/js/main/history-graph.js';

const HOUR = 3600;
const DAY = 86400;

describe('lineSmoothingWindow', () => {
  it('disables smoothing for ranges below 7 days', () => {
    assert.equal(lineSmoothingWindow(1 * HOUR), 1);
    assert.equal(lineSmoothingWindow(24 * HOUR), 1);
    assert.equal(lineSmoothingWindow(3 * DAY), 1);
    assert.equal(lineSmoothingWindow(6 * DAY + 23 * HOUR), 1);
  });

  it('enables smoothing at 7 days and scales up with range', () => {
    assert.equal(lineSmoothingWindow(7 * DAY), 11);
    assert.equal(lineSmoothingWindow(14 * DAY), 11);
    assert.equal(lineSmoothingWindow(15 * DAY), 13);
    assert.equal(lineSmoothingWindow(30 * DAY), 13);
    assert.equal(lineSmoothingWindow(45 * DAY), 17);
    assert.equal(lineSmoothingWindow(90 * DAY), 17);
    assert.equal(lineSmoothingWindow(120 * DAY), 21);
  });

  it('shrinks the window as zooming reduces visibleRange (key UX)', () => {
    // Pinch-in from the 4mo timeframe down through the bands — the
    // smoothing should monotonically loosen as the visible range shrinks.
    const ranges = [120 * DAY, 60 * DAY, 30 * DAY, 14 * DAY, 6 * DAY];
    let prev = Infinity;
    for (const r of ranges) {
      const w = lineSmoothingWindow(r);
      assert.ok(w <= prev, `smoothing window should not grow as range shrinks: ${prev} → ${w} at range=${r}`);
      prev = w;
    }
  });
});

describe('smoothPoints', () => {
  const pts = [
    { x: 0, y: 10 },
    { x: 1, y: 20 },
    { x: 2, y: 30 },
    { x: 3, y: 20 },
    { x: 4, y: 10 },
  ];

  it('returns the input untouched when window <= 1', () => {
    assert.deepEqual(smoothPoints(pts, 1), pts);
    assert.deepEqual(smoothPoints(pts, 0), pts);
  });

  it('preserves x-coordinates exactly', () => {
    const r = smoothPoints(pts, 3);
    for (let i = 0; i < pts.length; i++) {
      assert.equal(r[i].x, pts[i].x);
    }
  });

  it('produces a centered 3-point average for interior points', () => {
    const r = smoothPoints(pts, 3);
    // pts[2] = avg(20, 30, 20) = 23.333
    assert.ok(Math.abs(r[2].y - 70 / 3) < 1e-9);
  });

  it('shrinks the window at the edges so the line still reaches them', () => {
    const r = smoothPoints(pts, 3);
    // Edge point at i=0 averages over indices [0, 1]
    assert.equal(r[0].y, (10 + 20) / 2);
    // Edge point at i=last averages over [last-1, last]
    assert.equal(r[r.length - 1].y, (20 + 10) / 2);
  });

  it('returns the input when there are fewer than 2 points', () => {
    assert.deepEqual(smoothPoints([], 5), []);
    const single = [{ x: 0, y: 10 }];
    assert.deepEqual(smoothPoints(single, 5), single);
  });

  it('flattens a noisy spike when the window is wide enough', () => {
    // Single spike in an otherwise flat line.
    const noisy = [
      { x: 0, y: 50 }, { x: 1, y: 50 }, { x: 2, y: 90 },
      { x: 3, y: 50 }, { x: 4, y: 50 },
    ];
    const r = smoothPoints(noisy, 5);
    // The center sees all 5 points → avg = (50+50+90+50+50)/5 = 58
    assert.equal(r[2].y, 58);
    // Spike is no longer 90.
    assert.ok(r[2].y < 90);
  });
});
