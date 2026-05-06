/**
 * Unit tests for aggregateForecastBucket — the helper that turns the
 * hourly modeForecast array into per-mode hour totals for a single
 * bucket. The previous implementation just counted "+1 if the entry's
 * timestamp falls inside the bucket", which left every other 30-min
 * bucket empty (1-hour-spaced events vs. 30-min buckets), producing
 * the sparse-bar look the user reported on the 24h-with-forecast view.
 *
 * The fix treats each entry as the mode active for [t, t+1h) and adds
 * its overlap with the bucket. Emergency duty scales proportionally.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { aggregateForecastBucket } from '../playground/js/main/forecast-overlay.js';

const NOW = 0;
const HOUR = 3600;

function tsAt(hour) { return new Date((NOW + hour * HOUR) * 1000).toISOString(); }

describe('aggregateForecastBucket', () => {
  it('30-min bucket fully inside a heating hour gets 0.5h heating (renders as full-height bar)', () => {
    const events = [{ ts: tsAt(1), mode: 'greenhouse_heating' }];
    const r = aggregateForecastBucket(events, 1.0 * HOUR, 1.5 * HOUR);
    assert.equal(r.heatingHours, 0.5);
    assert.equal(r.chargingHours, 0);
    assert.equal(r.emergencyHours, 0);
  });

  it('30-min bucket between two adjacent hour-events sums their partial overlaps', () => {
    // Bucket [0.75 h .. 1.25 h] straddles hour 0 (charging) and hour 1
    // (heating); each contributes 0.25 h of overlap.
    const events = [
      { ts: tsAt(0), mode: 'solar_charging' },
      { ts: tsAt(1), mode: 'greenhouse_heating' },
    ];
    const r = aggregateForecastBucket(events, 0.75 * HOUR, 1.25 * HOUR);
    assert.ok(Math.abs(r.chargingHours - 0.25) < 1e-9);
    assert.ok(Math.abs(r.heatingHours  - 0.25) < 1e-9);
  });

  it('15-min bucket fully inside a charging hour gets 0.25h (full-height)', () => {
    const events = [{ ts: tsAt(2), mode: 'solar_charging' }];
    const r = aggregateForecastBucket(events, 2.25 * HOUR, 2.5 * HOUR);
    assert.equal(r.chargingHours, 0.25);
  });

  it('emergency duty scales the contribution proportionally', () => {
    // A 30-min bucket fully inside an emergency hour at duty 0.4
    // contributes 0.4 × 0.5 = 0.2 h. Bar height = 0.2 / segHours(0.5)
    // = 40%, matching the duty cycle.
    const events = [{ ts: tsAt(3), mode: 'emergency_heating', duty: 0.4 }];
    const r = aggregateForecastBucket(events, 3.0 * HOUR, 3.5 * HOUR);
    assert.ok(Math.abs(r.emergencyHours - 0.2) < 1e-9);
  });

  it('1-hour bucket aligned with the event boundary picks up exactly 1 hour', () => {
    const events = [{ ts: tsAt(5), mode: 'greenhouse_heating' }];
    const r = aggregateForecastBucket(events, 5 * HOUR, 6 * HOUR);
    assert.equal(r.heatingHours, 1);
  });

  it('6-hour bucket gathers six hourly events into 6 hours of mode time', () => {
    const events = Array.from({ length: 6 }, (_, i) => ({
      ts: tsAt(i), mode: 'solar_charging',
    }));
    const r = aggregateForecastBucket(events, 0, 6 * HOUR);
    assert.equal(r.chargingHours, 6);
  });

  it('events with no overlap with the bucket contribute nothing', () => {
    const events = [{ ts: tsAt(10), mode: 'greenhouse_heating' }];
    const r = aggregateForecastBucket(events, 0, 5 * HOUR);
    assert.deepEqual(r, { chargingHours: 0, heatingHours: 0, emergencyHours: 0 });
  });

  it('events with unknown mode are ignored (forward-compat with future modes)', () => {
    const events = [{ ts: tsAt(0), mode: 'experimental_future_mode' }];
    const r = aggregateForecastBucket(events, 0, 1 * HOUR);
    assert.deepEqual(r, { chargingHours: 0, heatingHours: 0, emergencyHours: 0 });
  });
});
