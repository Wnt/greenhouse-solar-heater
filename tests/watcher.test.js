'use strict';

/**
 * Unit tests for server/watcher.js — specifically the pure decide() function.
 *
 * decide(state, ok, nowMs, thresholdMs) -> { state, fire }
 *   state = { downSince: number|null, fired: boolean }
 *
 * No network, no timers — all inputs are passed explicitly.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { decide } = require('../server/watcher');

describe('watcher decide()', () => {
  it('(a) ok=true resets to up state with fired=false', () => {
    // Start from a state where we were down and had fired
    const state = { downSince: 1000, fired: true };
    const result = decide(state, true, 10000, 300000);
    assert.strictEqual(result.state.downSince, null, 'downSince must be null after ok');
    assert.strictEqual(result.state.fired, false, 'fired must be false after ok');
    assert.strictEqual(result.fire, false, 'must not fire on ok');
  });

  it('(a) ok=true from clean state stays clean', () => {
    const state = { downSince: null, fired: false };
    const result = decide(state, true, 5000, 300000);
    assert.deepStrictEqual(result.state, { downSince: null, fired: false });
    assert.strictEqual(result.fire, false);
  });

  it('(b) consecutive down accumulates and fires exactly once when threshold first reached', () => {
    const thresholdMs = 300000; // 5 min
    let state = { downSince: null, fired: false };
    const t0 = 1000000;

    // First down tick — sets downSince, but not yet at threshold
    const r1 = decide(state, false, t0, thresholdMs);
    state = r1.state;
    assert.strictEqual(state.downSince, t0, 'downSince should be set to t0');
    assert.strictEqual(state.fired, false);
    assert.strictEqual(r1.fire, false, 'not yet at threshold');

    // Just-before threshold
    const r2 = decide(state, false, t0 + thresholdMs - 1, thresholdMs);
    state = r2.state;
    assert.strictEqual(r2.fire, false, 'one ms before threshold must not fire');
    assert.strictEqual(state.fired, false);

    // Exactly at threshold — should fire
    const r3 = decide(state, false, t0 + thresholdMs, thresholdMs);
    state = r3.state;
    assert.strictEqual(r3.fire, true, 'must fire at exactly the threshold');
    assert.strictEqual(state.fired, true, 'state.fired must be set after firing');
    assert.strictEqual(state.downSince, t0, 'downSince must still be the original t0');
  });

  it('(c) does NOT re-fire while still down after having fired once', () => {
    const thresholdMs = 300000;
    const t0 = 2000000;
    // State: already fired, still down
    let state = { downSince: t0, fired: true };

    // Keep receiving down checks well past threshold
    for (let i = 1; i <= 5; i++) {
      const r = decide(state, false, t0 + thresholdMs * i, thresholdMs);
      state = r.state;
      assert.strictEqual(r.fire, false, `must not re-fire at iteration ${i}`);
      assert.strictEqual(state.fired, true);
      assert.strictEqual(state.downSince, t0);
    }
  });

  it('(d) ok between outages resets so the next outage fires again', () => {
    const thresholdMs = 300000;
    const t0 = 3000000;

    // First outage fires
    let state = { downSince: t0, fired: false };
    const r1 = decide(state, false, t0 + thresholdMs, thresholdMs);
    state = r1.state;
    assert.strictEqual(r1.fire, true, 'first outage must fire');

    // OK resets
    const r2 = decide(state, true, t0 + thresholdMs + 1000, thresholdMs);
    state = r2.state;
    assert.strictEqual(r2.fire, false);
    assert.deepStrictEqual(state, { downSince: null, fired: false }, 'ok must fully reset state');

    // Second outage — should fire again
    const t1 = t0 + thresholdMs + 60000;
    const r3 = decide(state, false, t1, thresholdMs);
    state = r3.state;
    assert.strictEqual(state.downSince, t1, 'downSince set to new outage start');
    assert.strictEqual(r3.fire, false, 'not at threshold yet');

    const r4 = decide(state, false, t1 + thresholdMs, thresholdMs);
    state = r4.state;
    assert.strictEqual(r4.fire, true, 'second outage must fire after reset');
    assert.strictEqual(state.fired, true);
  });

  it('(e) just-below-threshold does not fire', () => {
    const thresholdMs = 300000;
    const t0 = 4000000;
    const state = { downSince: t0, fired: false };

    const r = decide(state, false, t0 + thresholdMs - 1, thresholdMs);
    assert.strictEqual(r.fire, false, 'one ms before threshold must not fire');
    assert.strictEqual(r.state.fired, false);
    assert.strictEqual(r.state.downSince, t0);
  });

  it('first down check with downSince=null sets downSince to nowMs', () => {
    const state = { downSince: null, fired: false };
    const now = 9999999;
    const r = decide(state, false, now, 300000);
    assert.strictEqual(r.state.downSince, now, 'downSince must be set to nowMs on first down');
    assert.strictEqual(r.fire, false, 'should not fire immediately');
  });
});
