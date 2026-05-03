// @ts-check
//
// Behaviour test for the "history graph stays empty after view switch" bug.
//
// Repro: load the page on a non-#status hash (so the chart canvas is in a
// hidden view from first paint), let drawHistoryGraph() run at least once
// while #status is hidden — that resets the canvas backing buffer to 0x0
// because canvas.offsetWidth is 0 — then switch to #status. Without the
// fix, the canvas stays 0x0 (visually empty) until the next periodic
// redraw trigger fires (a WebSocket state frame in live mode, or a sim
// tick), which can take 30+ seconds in live mode when controller updates
// are infrequent.
//
// The fix is to redraw the history graph synchronously when the user
// switches into the #status view.
//
// Test setup uses simulation auto-bootstrap (no WebSocket needed) and
// pauses the sim before switching views, so the only thing that can
// repaint the canvas is the view-switch handler we're testing.

import { test, expect } from './fixtures.js';

test.describe('view switch repaints the history graph', () => {
  test.beforeEach(async ({ context }) => {
    // Force GitHub-Pages mode so init takes the auto-bootstrap path
    // (no live-mode WS dependency, populates the chart from the
    // pre-baked snapshot).
    await context.addInitScript(() => {
      window.__simulateGitHubPagesDeploy = true;
    });
  });

  test('chart paints immediately when switching to #status from another view', async ({ page }) => {
    // Land on a non-#status view so the chart canvas is hidden from
    // first paint. Using #components rather than #device because the
    // auto-bootstrap (simulation) mode does not expose the device
    // route — derived.availableViews drops it outside live mode and
    // navigation.js falls back to #status. The bug is not view-id
    // specific; it triggers any time the canvas is hidden while
    // drawHistoryGraph() runs.
    await page.goto('/playground/#components');
    await page.waitForFunction(() => window.__initComplete === true);
    // Wait for auto-bootstrap to flip the FAB — guarantees the
    // simulation has restored snapshot data into the time-series store
    // and run at least once.
    await expect(page.locator('#fab-play .material-symbols-outlined')).toHaveText('pause');

    // Pause the sim so the simLoop can no longer repaint the canvas.
    // From this point on, the only thing that can give the canvas a
    // non-zero backing buffer is the view-switch handler.
    await page.locator('#fab-play').click();
    await expect(page.locator('#fab-play .material-symbols-outlined')).toHaveText('play_arrow');

    // Sanity: store has data, canvas has zero backing buffer (because
    // every drawHistoryGraph() call so far ran while #status was hidden).
    const before = await page.evaluate(() => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('chart'));
      return {
        points: window.__getHistoryPointCount(),
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      };
    });
    expect(before.points).toBeGreaterThan(0);
    expect(before.canvasWidth).toBe(0);
    expect(before.canvasHeight).toBe(0);

    // Switch to #status. The view-switch handler must repaint the
    // history graph synchronously; we don't poll for several seconds.
    await page.evaluate(() => { window.location.hash = 'status'; });
    await expect(page.locator('#view-status')).toHaveClass(/active/);

    const after = await page.evaluate(() => {
      const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('chart'));
      return { canvasWidth: canvas.width, canvasHeight: canvas.height };
    });
    expect(after.canvasWidth).toBeGreaterThan(0);
    expect(after.canvasHeight).toBeGreaterThan(0);
  });
});
