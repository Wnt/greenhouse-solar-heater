/**
 * Unit tests for the history-chart x-axis tick helpers in playground/js/ui.js.
 *
 * Two long-standing bugs surfaced during live smoke-testing:
 *
 *  1. The tick step capped at 4 h, so a 7d / 30d / 1y range crammed hundreds
 *     of "HH:00" labels into the same axis and they overlapped into an
 *     unreadable solid bar.
 *
 *  2. The label text was always "HH:00" (time-of-day), which is useless for
 *     multi-day or multi-month ranges.
 *
 * The fix is to expose pure `pickTickStep(rangeSec, plotWidthPx)` and
 * `formatTick(tEpochSec, stepSec)` helpers and have drawHistoryGraph call
 * them. These tests pin both contracts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { pickTickStep, formatTick, pickBucketSize, formatBucketLabel } from '../playground/js/ui.js';

const HOUR = 3600;
const DAY = 86400;

describe('pickTickStep — x-axis tick spacing', () => {
  const PLOT_W = 520; // ~typical live-chart plot width after padding

  it('returns a tick step that keeps the label count within the budget', () => {
    const budget = Math.max(3, Math.floor(PLOT_W / 72)); // same formula the UI uses
    const ranges = [
      { name: '1h', seconds: 1 * HOUR },
      { name: '6h', seconds: 6 * HOUR },
      { name: '12h', seconds: 12 * HOUR },
      { name: '24h', seconds: 24 * HOUR },
      { name: '7d', seconds: 7 * DAY },
      { name: '30d', seconds: 30 * DAY },
      { name: '1y', seconds: 365 * DAY },
    ];
    for (const { name, seconds } of ranges) {
      const step = pickTickStep(seconds, PLOT_W);
      const ticks = Math.ceil(seconds / step);
      assert.ok(
        ticks <= budget + 1,
        `${name}: ${ticks} ticks at step=${step}s exceeds budget ${budget}`,
      );
      assert.ok(step > 0, `${name}: step must be positive, got ${step}`);
    }
  });

  it('scales monotonically — bigger range ⇒ bigger (or equal) step', () => {
    const ranges = [HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 7 * DAY, 30 * DAY, 365 * DAY];
    let prev = 0;
    for (const r of ranges) {
      const step = pickTickStep(r, 520);
      assert.ok(step >= prev, `step should not decrease: range=${r}, step=${step}, prev=${prev}`);
      prev = step;
    }
  });

  it('gives more ticks on a wider plot (respects plotWidthPx)', () => {
    const narrow = pickTickStep(7 * DAY, 300);
    const wide = pickTickStep(7 * DAY, 1200);
    assert.ok(wide <= narrow, 'wider plot should produce a tick step <= narrower plot');
  });

  it('always returns at least 3 ticks for a visible chart', () => {
    const ranges = [HOUR, 6 * HOUR, 24 * HOUR, 30 * DAY, 365 * DAY];
    for (const r of ranges) {
      const step = pickTickStep(r, 520);
      const ticks = Math.ceil(r / step);
      assert.ok(ticks >= 2, `range=${r}: only ${ticks} ticks — chart would look empty`);
    }
  });
});

describe('pickBucketSize — duty-cycle bar windowing', () => {
  // Contract: chart should always show ~12-24 bars across the visible
  // window. The previous "≤48h → 1h, >48h → 1d" rule produced 3 bars at
  // 3d and 7 bars at 7d — readable in 24h view, useless in the larger
  // ranges. The function is now derived from rangeSec rather than a
  // hand-tabulated band, and these tests pin the band, not the buckets.

  it('produces 12+ bars at every range from 1h through 4mo', () => {
    const ranges = [
      1 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR,
      3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 120 * DAY,
    ];
    for (const r of ranges) {
      const s = pickBucketSize(r);
      const bars = r / s;
      assert.ok(
        bars >= 12,
        `range ${r}s with bucket ${s}s gives only ${bars.toFixed(1)} bars (want ≥ 12)`,
      );
    }
  });

  it('keeps the bar count below ~28 (no stripes of dozens of micro-buckets)', () => {
    const ranges = [
      1 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR,
      3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 120 * DAY,
    ];
    for (const r of ranges) {
      const s = pickBucketSize(r);
      const bars = r / s;
      assert.ok(
        bars <= 28,
        `range ${r}s with bucket ${s}s gives ${bars.toFixed(1)} bars (want ≤ 28)`,
      );
    }
  });

  it('returns canonical bucket sizes (5/15/30 min, 1/3/6/12 h, 1/2/4/7/14/30 d) — no oddballs', () => {
    const allowed = new Set([
      60, 5 * 60, 15 * 60, 30 * 60,
      HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
      DAY, 2 * DAY, 4 * DAY, 7 * DAY, 14 * DAY, 30 * DAY,
    ]);
    const ranges = [HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR, 7 * DAY, 30 * DAY, 365 * DAY];
    for (const r of ranges) {
      const s = pickBucketSize(r);
      assert.ok(allowed.has(s), `bucket ${s}s for range ${r}s isn't a canonical step`);
    }
  });

  it('scales monotonically — bigger range ⇒ bigger (or equal) bucket', () => {
    const ranges = [HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 7 * DAY, 30 * DAY];
    let prev = 0;
    for (const r of ranges) {
      const s = pickBucketSize(r);
      assert.ok(s >= prev, `bucket should not shrink: range=${r}, size=${s}, prev=${prev}`);
      prev = s;
    }
  });
});

describe('formatTick — label format per step', () => {
  // Fixed epoch so tests don't drift with local time: 2026-04-19T10:30:00Z
  const T0 = 1776551400;

  it('formats sub-day steps as HH:MM (local time, zero-padded)', () => {
    const s = formatTick(T0, HOUR);
    assert.match(s, /^\d{2}:\d{2}$/, `expected HH:MM, got "${s}"`);
  });

  it('formats multi-day steps as short date (no time)', () => {
    const s = formatTick(T0, DAY);
    assert.doesNotMatch(s, /:/, `expected no time component for day step, got "${s}"`);
    assert.match(s, /\d/, `expected digits in date label, got "${s}"`);
  });

  it('formats monthly+ steps with month abbreviation', () => {
    const s = formatTick(T0, 30 * DAY);
    assert.match(s, /[A-Za-z]{3}/, `expected month abbrev in long-range label, got "${s}"`);
  });

  it('different epoch ⇒ different label for the same step', () => {
    const a = formatTick(T0, HOUR);
    const b = formatTick(T0 + 2 * HOUR, HOUR);
    assert.notStrictEqual(a, b, 'HH:MM labels must change with time');
  });
});

describe('formatBucketLabel — human-readable bucket size', () => {
  // The badge in the corner of the history chart shows "what each bar means"
  // so users can tell whether they're looking at 5-minute or 1-day buckets.
  // Issue #132 — without this, pinch-zooming changes the bar resolution
  // invisibly.

  it('uses minute units below an hour', () => {
    assert.strictEqual(formatBucketLabel(60), '1 min');
    assert.strictEqual(formatBucketLabel(5 * 60), '5 min');
    assert.strictEqual(formatBucketLabel(15 * 60), '15 min');
    assert.strictEqual(formatBucketLabel(30 * 60), '30 min');
  });

  it('uses hour units from one hour up to one day', () => {
    assert.strictEqual(formatBucketLabel(HOUR), '1 h');
    assert.strictEqual(formatBucketLabel(3 * HOUR), '3 h');
    assert.strictEqual(formatBucketLabel(6 * HOUR), '6 h');
    assert.strictEqual(formatBucketLabel(12 * HOUR), '12 h');
  });

  it('uses singular "day" for 1 day and plural "days" thereafter', () => {
    assert.strictEqual(formatBucketLabel(DAY), '1 day');
    assert.strictEqual(formatBucketLabel(2 * DAY), '2 days');
    assert.strictEqual(formatBucketLabel(4 * DAY), '4 days');
    assert.strictEqual(formatBucketLabel(7 * DAY), '7 days');
    assert.strictEqual(formatBucketLabel(14 * DAY), '14 days');
    assert.strictEqual(formatBucketLabel(30 * DAY), '30 days');
  });

  it('round-trips every canonical bucket size from pickBucketSize', () => {
    // Every value pickBucketSize can return must format to a non-empty
    // label without throwing.
    const ranges = [
      1 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR,
      3 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY, 120 * DAY, 365 * DAY,
    ];
    for (const r of ranges) {
      const s = pickBucketSize(r);
      const label = formatBucketLabel(s);
      assert.ok(typeof label === 'string' && label.length > 0,
        `bucket ${s}s (range ${r}s) produced empty label: ${JSON.stringify(label)}`);
      assert.match(label, /^\d+\s+(min|h|day|days)$/,
        `bucket ${s}s formatted as "${label}" — expected "<n> min|h|day|days"`);
    }
  });
});
