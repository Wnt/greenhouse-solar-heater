/**
 * Unit tests for the synced cursor pub/sub of the diagnostics
 * inspector module. The pointer-event handler logic is covered by the
 * Playwright frontend suite (touch + long-press is meaningless to
 * exercise outside a real browser); here we just lock in the
 * subscribe/notify/clear contract that drives the synced cursor
 * across charts.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

// The module references `window` for the test bridge. Provide a stub
// before importing so the top-level guard's branch is exercised
// truthfully (the real frontend always has a `window`).
globalThis.window = globalThis.window || {};

const inspector = await import('../playground/js/diagnostics/inspector.js');

describe('diagnostics inspector — synced cursor pub/sub', () => {
  beforeEach(() => { inspector.resetCursor(); });

  it('subscribers receive the current state on subscription', () => {
    inspector.setCursorTs(123);
    const seen = [];
    inspector.subscribeCursor((ts) => seen.push(ts));
    assert.deepEqual(seen, [123]);
  });

  it('setCursorTs notifies all subscribers exactly once per change', () => {
    const a = []; const b = [];
    inspector.subscribeCursor((ts) => a.push(ts));
    inspector.subscribeCursor((ts) => b.push(ts));
    a.length = 0; b.length = 0; // drop the replay-on-subscribe
    inspector.setCursorTs(1000);
    assert.deepEqual(a, [1000]);
    assert.deepEqual(b, [1000]);
  });

  it('setting the same ts twice is idempotent (no double-notify)', () => {
    const seen = [];
    inspector.subscribeCursor((ts) => seen.push(ts));
    seen.length = 0;
    inspector.setCursorTs(5);
    inspector.setCursorTs(5);
    assert.deepEqual(seen, [5]);
  });

  it('clearCursor resets to null and notifies', () => {
    inspector.setCursorTs(42);
    const seen = [];
    inspector.subscribeCursor((ts) => seen.push(ts));
    seen.length = 0;
    inspector.clearCursor();
    assert.deepEqual(seen, [null]);
    assert.equal(inspector.getCursorTs(), null);
  });

  it('unsubscribe stops further notifications for that subscriber', () => {
    const a = []; const b = [];
    const off = inspector.subscribeCursor((ts) => a.push(ts));
    inspector.subscribeCursor((ts) => b.push(ts));
    a.length = 0; b.length = 0;
    off();
    inspector.setCursorTs(99);
    assert.deepEqual(a, []);
    assert.deepEqual(b, [99]);
  });

  it('resetCursor clears state without notifying (between mount cycles)', () => {
    inspector.setCursorTs(7);
    const seen = [];
    inspector.subscribeCursor((ts) => seen.push(ts));
    seen.length = 0;
    inspector.resetCursor();
    assert.equal(inspector.getCursorTs(), null);
    // resetCursor is the mount-cycle reset, not a state change to
    // broadcast — subscribers shouldn't get a spurious null.
    assert.deepEqual(seen, []);
  });

  it('exposes a window.__diag.inspector test bridge', () => {
    assert.equal(typeof globalThis.window.__diag, 'object');
    assert.equal(typeof globalThis.window.__diag.inspector, 'object');
    assert.equal(typeof globalThis.window.__diag.inspector.setCursorTs, 'function');
    assert.equal(typeof globalThis.window.__diag.inspector.LONG_PRESS_MS, 'number');
  });
});
