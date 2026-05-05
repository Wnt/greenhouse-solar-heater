// @ts-check
//
// Contract test for the sync registry + coordinator
// (playground/js/sync/). This is the executable spec that future
// full-stack features should pass when they plug into the same
// framework — see playground/js/sync/README.md.
//
// Drives a fake data source through hide/show/online via
// window.__sync, asserts:
//   - registerDataSource() rejects bad specs
//   - the coordinator runs only sources whose isActive() is true
//   - fetch is called with an AbortSignal that aborts on overlap
//   - applyToStore runs exactly once per resolved fetch (and not at
//     all if the source's signal aborted)
//   - the syncing store flag toggles around the resync window

import { test, expect } from './fixtures.js';

// Mock the API endpoints the production registered sources hit so a
// page load doesn't spawn real network requests during these tests.
async function mockApis(page) {
  await page.route('**/api/history**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ points: [], events: [] }),
  }));
  await page.route('**/api/events**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ events: [], hasMore: false }),
  }));
}

test.describe('sync registry + coordinator contract', () => {
  test.beforeEach(async ({ page }) => {
    await mockApis(page);
    await page.goto('/playground/');
    // Wait for init() to FULLY complete (window.__initComplete set
    // at the last line of main.js init). Without this, production
    // sources registered inside initConnection sneak into the
    // registry mid-test and get fetched alongside the fake source,
    // blowing source-count assertions.
    await page.waitForFunction(() => window.__initComplete === true);
    // Clean slate: drop production-registered sources for the
    // duration of this test, and abort anything in flight.
    await page.evaluate(() => {
      window.__sync._resetForTests();
      window.__sync._clearAllForTests();
    });
  });

  test('registerDataSource rejects malformed specs', async ({ page }) => {
    const errors = await page.evaluate(() => {
      const out = [];
      const tries = [
        {},
        { id: 'x' },
        { id: 'x', fetch: () => {} },
        { id: 'x', fetch: () => {}, applyToStore: () => {} },
      ];
      for (const t of tries) {
        try { window.__sync.registerDataSource(t); out.push(null); }
        catch (e) { out.push(String(e.message)); }
      }
      // Duplicate id is also rejected.
      window.__sync.registerDataSource({
        id: 'dupe',
        fetch: () => Promise.resolve(),
        applyToStore: () => {},
        isActive: () => true,
      });
      try {
        window.__sync.registerDataSource({
          id: 'dupe',
          fetch: () => Promise.resolve(),
          applyToStore: () => {},
          isActive: () => true,
        });
        out.push(null);
      } catch (e) { out.push(String(e.message)); }
      return out;
    });
    expect(errors[0]).toMatch(/spec.id is required/);
    expect(errors[1]).toMatch(/spec.fetch must be a function/);
    expect(errors[2]).toMatch(/spec.applyToStore must be a function/);
    expect(errors[3]).toMatch(/spec.isActive must be a function/);
    expect(errors[4]).toMatch(/duplicate id "dupe"/);
  });

  test('coordinator runs only active sources', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const calls = { active: 0, inactive: 0, applied: { active: 0, inactive: 0 } };
      window.__sync.registerDataSource({
        id: 'active-src',
        isActive: () => true,
        fetch: () => { calls.active++; return Promise.resolve('A'); },
        applyToStore: () => { calls.applied.active++; },
      });
      window.__sync.registerDataSource({
        id: 'inactive-src',
        isActive: () => false,
        fetch: () => { calls.inactive++; return Promise.resolve('B'); },
        applyToStore: () => { calls.applied.inactive++; },
      });
      const summary = await window.__sync.triggerResync('test');
      return { calls, summary };
    });
    expect(result.calls.active).toBe(1);
    expect(result.calls.inactive).toBe(0);
    expect(result.calls.applied.active).toBe(1);
    expect(result.calls.applied.inactive).toBe(0);
    expect(result.summary.aborted).toBe(false);
    expect(result.summary.ran).toBe(1);
  });

  test('fetch receives an AbortSignal; overlapping resyncs abort the first', async ({ page }) => {
    const result = await page.evaluate(async () => {
      let release;
      const gate = new Promise(r => { release = r; });
      let fetchCount = 0;
      const firstSignalAborted = { value: null };
      let appliedCount = 0;

      window.__sync.registerDataSource({
        id: 'slow-src',
        isActive: () => true,
        fetch: (signal) => {
          const idx = fetchCount++;
          return gate.then(() => {
            // Snapshot only the FIRST call's signal — the second
            // call's signal is fresh and won't be aborted.
            if (idx === 0) firstSignalAborted.value = signal.aborted;
            return 'data-' + idx;
          });
        },
        applyToStore: () => { appliedCount++; },
      });

      // Trigger first resync — fetch hangs on the gate.
      const firstPromise = window.__sync.triggerResync('first');
      // Trigger a second resync — aborts the first.
      const secondPromise = window.__sync.triggerResync('second');
      // Now release the gate so both .then callbacks fire.
      release();
      const firstSummary = await firstPromise;
      const secondSummary = await secondPromise;
      return { firstSignalAborted: firstSignalAborted.value, appliedCount, firstSummary, secondSummary };
    });
    // First call's signal flipped aborted by the time its .then() ran.
    expect(result.firstSignalAborted).toBe(true);
    // applyToStore runs once: only for the un-aborted second call.
    expect(result.appliedCount).toBe(1);
    expect(result.firstSummary.aborted).toBe(true);
    expect(result.secondSummary.aborted).toBe(false);
  });

  test('store.syncing toggles around a resync window', async ({ page }) => {
    const transitions = await page.evaluate(async () => {
      // Hold the fetch open so we can observe `syncing === true`
      // mid-flight before the resync resolves.
      let release;
      const gate = new Promise(r => { release = r; });
      const observed = [];
      const mod = await import('/playground/js/app-state.js');
      mod.store.subscribe('syncing', v => observed.push(v));

      window.__sync.registerDataSource({
        id: 'gate-src',
        isActive: () => true,
        fetch: () => gate,
        applyToStore: () => {},
      });

      const before = mod.store.get('syncing');
      const p = window.__sync.triggerResync('test');
      const during = mod.store.get('syncing');
      release(true);
      await p;
      const after = mod.store.get('syncing');
      return { before, during, after, observed };
    });
    expect(transitions.before).toBe(false);
    expect(transitions.during).toBe(true);
    expect(transitions.after).toBe(false);
    // Subscriber observed both edges.
    expect(transitions.observed).toEqual([true, false]);
  });

  test('one source failing does not block the others', async ({ page }) => {
    const result = await page.evaluate(async () => {
      const applied = { good: 0, bad: 0 };
      window.__sync.registerDataSource({
        id: 'bad-src',
        isActive: () => true,
        fetch: () => Promise.reject(new Error('boom')),
        applyToStore: () => { applied.bad++; },
      });
      window.__sync.registerDataSource({
        id: 'good-src',
        isActive: () => true,
        fetch: () => Promise.resolve('ok'),
        applyToStore: () => { applied.good++; },
      });
      await window.__sync.triggerResync('test');
      return applied;
    });
    expect(result.bad).toBe(0);
    expect(result.good).toBe(1);
  });

  test('startPeriodicResync re-runs sources at the configured interval', async ({ page }) => {
    // Long-lived PWA sessions: visibility/focus/network events alone
    // miss the "tab was foreground the whole time" case. The coordinator
    // therefore offers a periodic timer; each tick calls triggerResync,
    // which in turn invokes every active source's fetch.
    const result = await page.evaluate(async () => {
      let fetchCalls = 0;
      window.__sync.registerDataSource({
        id: 'periodic-src',
        isActive: () => true,
        fetch: () => { fetchCalls++; return Promise.resolve('ok'); },
        applyToStore: () => {},
      });
      // 30 ms cadence: tight for the test, well above setInterval's
      // ~4 ms minimum so we get distinct ticks.
      window.__sync._startPeriodicResync(30);
      // Wait long enough for ≥3 ticks plus the in-flight resync to settle.
      await new Promise(r => setTimeout(r, 150));
      const duringTick = fetchCalls;
      window.__sync._stopPeriodicResync();
      // Wait again — should NOT keep firing after stop.
      await new Promise(r => setTimeout(r, 150));
      const afterStop = fetchCalls;
      return { duringTick, afterStop };
    });
    expect(result.duringTick).toBeGreaterThanOrEqual(3);
    // After stop, no new ticks (small tolerance for any in-flight resync
    // that may have already started just before stop fired).
    expect(result.afterStop).toBeLessThanOrEqual(result.duringTick + 1);
  });
});
