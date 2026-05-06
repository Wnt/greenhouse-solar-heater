/**
 * Unit tests for selectionToWindow — the pure helper that turns a
 * shift+drag rubber-band selection (canvas-relative x coords) into a
 * {tMin, tMax} chart window. The mouse handlers in
 * chart-mouse-zoom.js wrap this with DOM lookups, but the math is
 * isolated here so it can be pinned without a browser.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { selectionToWindow } from '../playground/js/main/chart-mouse-zoom.js';

const HOUR = 3600;

const PAD = 8;
const PLOT_W = 1000;
// Canvas spans pad..pad+plotW = 8..1008 in x.
const WINDOW = { tMin: 0, tMax: 24 * HOUR };
const BOUND = { tMin: -2 * HOUR, tMax: 26 * HOUR };
const MIN_RANGE = 60;

describe('selectionToWindow', () => {
  it('maps the middle half of the plot to hours 6..18 of a 24h window', () => {
    const r = selectionToWindow({
      startCanvasX: PAD + PLOT_W * 0.25,
      endCanvasX:   PAD + PLOT_W * 0.75,
      padLeft: PAD, plotW: PLOT_W,
      currentWindow: WINDOW, bound: BOUND, minRange: MIN_RANGE,
    });
    assert.ok(r);
    assert.equal(r.tMin, 6 * HOUR);
    assert.equal(r.tMax, 18 * HOUR);
  });

  it('handles the user dragging right-to-left (start > end)', () => {
    const r = selectionToWindow({
      startCanvasX: PAD + PLOT_W * 0.8,
      endCanvasX:   PAD + PLOT_W * 0.2,
      padLeft: PAD, plotW: PLOT_W,
      currentWindow: WINDOW, bound: BOUND, minRange: MIN_RANGE,
    });
    assert.ok(r);
    assert.equal(r.tMin, 24 * HOUR * 0.2);
    assert.equal(r.tMax, 24 * HOUR * 0.8);
  });

  it('clamps a selection that overshoots the canvas edges to the plot bounds', () => {
    const r = selectionToWindow({
      startCanvasX: -50,
      endCanvasX:   PAD + PLOT_W + 999,
      padLeft: PAD, plotW: PLOT_W,
      currentWindow: WINDOW, bound: BOUND, minRange: MIN_RANGE,
    });
    assert.ok(r);
    assert.equal(r.tMin, 0);
    assert.equal(r.tMax, 24 * HOUR);
  });

  it('returns null for a degenerate selection narrower than minRange seconds', () => {
    // Two pixels apart in a 1000px-wide 24h window ≈ 173 s, OK.
    const ok = selectionToWindow({
      startCanvasX: PAD + 100,
      endCanvasX:   PAD + 102,
      padLeft: PAD, plotW: PLOT_W,
      currentWindow: WINDOW, bound: BOUND, minRange: MIN_RANGE,
    });
    assert.ok(ok, '2 px in 24h plot should map to >60 s range');
    // But selecting against a 1h window: 2 px ≈ 7 s, below the floor.
    const tooNarrow = selectionToWindow({
      startCanvasX: PAD + 100,
      endCanvasX:   PAD + 102,
      padLeft: PAD, plotW: PLOT_W,
      currentWindow: { tMin: 0, tMax: 1 * HOUR },
      bound: { tMin: 0, tMax: 1 * HOUR },
      minRange: MIN_RANGE,
    });
    assert.equal(tooNarrow, null);
  });

  it('clamps to the pannable bound when the visible window has been panned beyond it', () => {
    // The selection math is anchored to currentWindow; the result is
    // then clamped to bound. Check that a selection inside currentWindow
    // but outside bound gets clamped.
    const r = selectionToWindow({
      startCanvasX: PAD + 0,
      endCanvasX:   PAD + PLOT_W,
      padLeft: PAD, plotW: PLOT_W,
      currentWindow: { tMin: 30 * HOUR, tMax: 50 * HOUR },
      bound:         { tMin: 32 * HOUR, tMax: 48 * HOUR },
      minRange: MIN_RANGE,
    });
    assert.ok(r);
    assert.equal(r.tMin, 32 * HOUR);
    assert.equal(r.tMax, 48 * HOUR);
  });
});
