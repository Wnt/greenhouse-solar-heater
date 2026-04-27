// @ts-check
//
// Behaviour test for the Android "background → resume" data-sync
// path. Asserts the user-visible repair: when the page is backgrounded
// and brought back, /api/history is re-fetched, the unified syncing
// overlay (no heavy blur, no separate banner) shows during the catch-
// up, and the live-frame flag is reset so the trend arrows draw off
// fresh data instead of pre-background lastState.

import { test, expect } from './fixtures.js';

test.describe('visibility resync', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/events**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ events: [], hasMore: false }),
    }));
  });

  test('hide → show triggers a /api/history re-fetch', async ({ page }) => {
    let historyHits = 0;
    await page.route('**/api/history**', route => {
      historyHits++;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ points: [], events: [] }),
      });
    });
    await page.goto('/playground/');
    await page.waitForFunction(() => typeof window.__sync === 'object');
    // Wait for the initial live-mode fetch (1h, 6h, …) to land
    // before counting subsequent ones — it varies by range +
    // balance card so we just snapshot the count and look for
    // increases.
    await page.waitForTimeout(200);
    const baseline = historyHits;

    // Simulate Android resume: visibility goes hidden then visible.
    // Playwright doesn't expose visibilitychange directly, but
    // dispatching the event manually is what the coordinator listens
    // for, and the handler reads document.visibilityState — we
    // override it for the test window.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // The coordinator's resync is async — wait for the syncing flag
    // to flip back to false, then assert hits increased.
    await page.waitForFunction(async () => {
      const mod = await import('/playground/js/app-state.js');
      return mod.store.get('syncing') === false;
    }, undefined, { timeout: 5000 });
    expect(historyHits).toBeGreaterThan(baseline);
  });

  test('syncing overlay uses light variant, not full blur', async ({ page }) => {
    // Hold history fetches open so we can observe the overlay
    // mid-resync. We resolve them at the end of the test.
    let releaseHistory;
    const historyGate = new Promise(r => { releaseHistory = r; });
    await page.route('**/api/history**', async route => {
      await historyGate;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ points: [], events: [] }),
      });
    });
    await page.goto('/playground/');
    await page.waitForFunction(() => typeof window.__sync === 'object');

    // Wait for init() to complete so the connection.js syncing
    // subscribe is wired before we flip the flag. The signal is
    // phase === 'live' (set by initModeToggle, which runs after
    // initConnection registers the subscribe).
    await page.waitForFunction(async () => {
      const mod = await import('/playground/js/app-state.js');
      return mod.store.get('phase') === 'live';
    });

    // Trigger a resync directly (production path is the visibility
    // listener; we use the coordinator API to keep the test focused
    // on the overlay state machine). Fire-and-forget: page.evaluate
    // would otherwise await the returned Promise, which won't resolve
    // until the gated fetch settles.
    await page.evaluate(() => { window.__sync.triggerResync('test'); });
    await page.waitForFunction(async () => {
      const mod = await import('/playground/js/app-state.js');
      return mod.store.get('syncing') === true;
    }, undefined, { timeout: 5000 });

    // The overlay element must be visible AND carry the syncing
    // class — that's what swaps the heavy blur for the light pill.
    const overlay = page.locator('#overlay-modes');
    await expect(overlay).toHaveClass(/visible/);
    await expect(overlay).toHaveClass(/connection-overlay--syncing/);
    // Staleness banner must NOT be visible during sync — old UX
    // showed it transiently between syncing → active.
    const banner = page.locator('#staleness-banner');
    await expect(banner).not.toHaveClass(/visible/);

    // Close out: release the gated fetches.
    releaseHistory();
    await page.waitForFunction(async () => {
      const mod = await import('/playground/js/app-state.js');
      return mod.store.get('syncing') === false;
    });
    await expect(overlay).not.toHaveClass(/connection-overlay--syncing/);
  });

  test('liveFrameSeen is reset on resync start so trends fall back to fresh history', async ({ page }) => {
    // Background: the original Android bug had `liveFrameSeen` stay
    // true across the backgrounding, so on resume the UI used the
    // stale lastState (wrong-direction arrows) instead of the fresh
    // history. The coordinator resets the flag in onResyncStart;
    // this asserts the seam is wired.
    let releaseHistory;
    const historyGate = new Promise(r => { releaseHistory = r; });
    await page.route('**/api/history**', async route => {
      await historyGate;
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ points: [], events: [] }),
      });
    });
    await page.goto('/playground/');
    await page.waitForFunction(() => typeof window.__sync === 'object');

    // Pretend a live frame has already arrived so we have something
    // to observe getting reset. setLiveFrameSeen lives in
    // display-update.js, exposed for tests via the dynamic import
    // below — same pattern as window.__getHistoryPointCount.
    await page.evaluate(async () => {
      const mod = await import('/playground/js/main/display-update.js');
      mod.setLiveFrameSeen(true);
    });
    const before = await page.evaluate(() => window.__getLiveFrameSeen());
    expect(before).toBe(true);

    // Trigger a resync. onResyncStart runs synchronously inside
    // triggerResync, so the flag flips false before the fetch even
    // resolves. We hold the fetch open via historyGate so the flag
    // can be observed mid-resync. Fire-and-forget — see the other
    // test for why we don't await the returned Promise.
    await page.evaluate(() => { window.__sync.triggerResync('visibility'); });
    const during = await page.evaluate(() => window.__getLiveFrameSeen());
    expect(during).toBe(false);

    releaseHistory();
  });
});
