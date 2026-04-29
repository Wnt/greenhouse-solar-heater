/**
 * Unit tests for playground/js/main/mode-events.js — the single source
 * of truth for "what mode was active at time T" in live mode.
 *
 * The store keeps an ordered list of mode-transition events (sorted by
 * ts ascending) and exposes two pure read helpers:
 *
 *   - modeAt(ts):  returns the mode active at ts (binary search;
 *                  defaults to 'idle' when there's no leading event).
 *   - coverageInBucket(start, end): returns the per-mode wall-clock
 *                  seconds covered by events inside [start, end), used
 *                  by the duty-cycle bar chart and the inspector.
 *
 * Both helpers must work uniformly for the historical fetch (which
 * carries a leading event from before the window) and the live-append
 * path (which prepends new events as detectLiveTransition fires).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
  modeEventsStore,
  resetModeEvents,
  populateModeEvents,
  appendModeEvent,
  modeAt,
  coverageInBucket,
} from '../playground/js/main/mode-events.js';

const SEC = 1000;

describe('mode-events store', () => {
  beforeEach(() => resetModeEvents());

  it('modeAt defaults to idle when the store is empty', () => {
    assert.equal(modeAt(0), 'idle');
    assert.equal(modeAt(Date.now()), 'idle');
  });

  it('populateModeEvents sorts by ts and replaces existing entries', () => {
    populateModeEvents([
      { ts: 200 * SEC, type: 'mode', from: 'solar_charging', to: 'idle' },
      { ts: 100 * SEC, type: 'mode', from: 'idle', to: 'solar_charging' },
    ]);
    assert.equal(modeEventsStore.events.length, 2);
    assert.equal(modeEventsStore.events[0].ts, 100 * SEC);
    assert.equal(modeEventsStore.events[1].ts, 200 * SEC);

    populateModeEvents([{ ts: 50 * SEC, type: 'mode', from: 'idle', to: 'greenhouse_heating' }]);
    assert.equal(modeEventsStore.events.length, 1);
    assert.equal(modeEventsStore.events[0].ts, 50 * SEC);
  });

  it('modeAt walks events forward and returns the most recent applicable to', () => {
    populateModeEvents([
      { ts: 100 * SEC, type: 'mode', from: 'idle', to: 'solar_charging' },
      { ts: 200 * SEC, type: 'mode', from: 'solar_charging', to: 'idle' },
      { ts: 300 * SEC, type: 'mode', from: 'idle', to: 'greenhouse_heating' },
    ]);
    assert.equal(modeAt(50 * SEC), 'idle', 'before any event → default idle');
    assert.equal(modeAt(100 * SEC), 'solar_charging', 'at exact event ts → applies');
    assert.equal(modeAt(150 * SEC), 'solar_charging');
    assert.equal(modeAt(200 * SEC), 'idle');
    assert.equal(modeAt(250 * SEC), 'idle');
    assert.equal(modeAt(300 * SEC), 'greenhouse_heating');
    assert.equal(modeAt(999 * SEC), 'greenhouse_heating');
  });

  it('modeAt uses a leading event with ts before window-start as the initial mode', () => {
    // Mirrors the fix on the server: getEvents prepends one row from
    // before the window so the first sample's mode is well-defined.
    populateModeEvents([
      { ts: 50 * SEC, type: 'mode', from: 'idle', to: 'solar_charging' },
      { ts: 400 * SEC, type: 'mode', from: 'solar_charging', to: 'idle' },
    ]);
    // Visible window starts at t=100. Without a leading event this would
    // default to idle for the [100, 400) range; with one, it sees charging.
    assert.equal(modeAt(100 * SEC), 'solar_charging');
    assert.equal(modeAt(399 * SEC), 'solar_charging');
    assert.equal(modeAt(400 * SEC), 'idle');
  });

  it('appendModeEvent inserts in chronological order', () => {
    populateModeEvents([
      { ts: 100 * SEC, type: 'mode', from: 'idle', to: 'solar_charging' },
    ]);
    appendModeEvent({ ts: 200 * SEC, type: 'mode', from: 'solar_charging', to: 'idle' });
    appendModeEvent({ ts: 150 * SEC, type: 'mode', from: 'solar_charging', to: 'greenhouse_heating' });
    const ts = modeEventsStore.events.map(e => e.ts);
    assert.deepEqual(ts, [100 * SEC, 150 * SEC, 200 * SEC]);
  });

  it('appendModeEvent ignores duplicate (ts, to) pairs', () => {
    // detectLiveTransition and the next /api/history fetch can both
    // observe the same transition; the store dedupes to keep the bar
    // chart's coverage math from double-counting.
    populateModeEvents([
      { ts: 100 * SEC, type: 'mode', from: 'idle', to: 'solar_charging' },
    ]);
    appendModeEvent({ ts: 100 * SEC, type: 'mode', from: 'idle', to: 'solar_charging' });
    assert.equal(modeEventsStore.events.length, 1);
  });

  describe('coverageInBucket', () => {
    it('returns zero coverage when no event applies and no leading event', () => {
      const c = coverageInBucket(0, 600 * SEC);
      assert.equal(c.charging, 0);
      assert.equal(c.heating, 0);
      assert.equal(c.emergency, 0);
    });

    it('returns full charging coverage when a leading event puts the bucket inside SC', () => {
      populateModeEvents([
        { ts: 0, type: 'mode', from: 'idle', to: 'solar_charging' },
      ]);
      const c = coverageInBucket(100 * SEC, 700 * SEC);
      assert.equal(c.charging, 600 * SEC);
      assert.equal(c.heating, 0);
    });

    it('clamps event intervals to the bucket boundaries', () => {
      populateModeEvents([
        { ts: 100 * SEC, type: 'mode', from: 'idle', to: 'solar_charging' },
        { ts: 400 * SEC, type: 'mode', from: 'solar_charging', to: 'idle' },
      ]);
      // bucket [200, 800) overlaps charging during [200, 400) = 200s
      const c = coverageInBucket(200 * SEC, 800 * SEC);
      assert.equal(c.charging, 200 * SEC);
    });

    it('splits coverage across multiple modes inside one bucket', () => {
      populateModeEvents([
        { ts: 100 * SEC, type: 'mode', from: 'idle', to: 'solar_charging' },
        { ts: 200 * SEC, type: 'mode', from: 'solar_charging', to: 'greenhouse_heating' },
        { ts: 350 * SEC, type: 'mode', from: 'greenhouse_heating', to: 'idle' },
      ]);
      // bucket [0, 600): idle 100, charging 100, heating 150, idle 250
      const c = coverageInBucket(0, 600 * SEC);
      assert.equal(c.charging, 100 * SEC);
      assert.equal(c.heating, 150 * SEC);
      assert.equal(c.emergency, 0);
    });

    it('counts emergency_heating into its own bucket', () => {
      populateModeEvents([
        { ts: 0, type: 'mode', from: 'idle', to: 'emergency_heating' },
        { ts: 60 * SEC, type: 'mode', from: 'emergency_heating', to: 'idle' },
      ]);
      const c = coverageInBucket(0, 60 * SEC);
      assert.equal(c.emergency, 60 * SEC);
      assert.equal(c.charging, 0);
      assert.equal(c.heating, 0);
    });
  });
});
