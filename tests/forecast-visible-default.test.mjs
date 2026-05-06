/**
 * Unit tests for defaultVisibleForecastSec — the helper that decides
 * how much projected horizon the *default* (non-zoomed) chart view
 * shows when the Forecast toggle is on. Spec:
 *
 *   - 24h range  → +12h forecast (range / 2)
 *   - 12h range  → +6h           (range / 2)
 *   - 6h  range  → +3h           (range / 2)
 *   - 7d  range  → +48h          (capped at the full forecast horizon)
 *   - 4mo range  → +48h          (cap)
 *
 * The pannable bound (computeDefaultBound) still uses the full 48h
 * horizon — see pinch-zoom.test.mjs — so users can pan past the
 * default visible right-edge to reveal the rest of the projected
 * window. This test only pins the default-visible portion.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { defaultVisibleForecastSec } from '../playground/js/main/history-graph.js';

const HOUR = 3600;
const DAY = 86400;
const FORECAST_CAP = 48 * HOUR;

describe('defaultVisibleForecastSec', () => {
  it('shows half the range as forecast for sub-day ranges', () => {
    assert.equal(defaultVisibleForecastSec(24 * HOUR), 12 * HOUR);
    assert.equal(defaultVisibleForecastSec(12 * HOUR), 6 * HOUR);
    assert.equal(defaultVisibleForecastSec(6 * HOUR), 3 * HOUR);
    assert.equal(defaultVisibleForecastSec(1 * HOUR), 0.5 * HOUR);
  });

  it('caps at the full forecast horizon (48 h) for ranges longer than 4 days', () => {
    assert.equal(defaultVisibleForecastSec(7 * DAY), FORECAST_CAP);
    assert.equal(defaultVisibleForecastSec(30 * DAY), FORECAST_CAP);
    assert.equal(defaultVisibleForecastSec(120 * DAY), FORECAST_CAP);
  });

  it('hits the cap exactly when range is 4 days (range / 2 = 48h)', () => {
    assert.equal(defaultVisibleForecastSec(4 * DAY), FORECAST_CAP);
  });
});
