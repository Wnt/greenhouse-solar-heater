// @ts-check
/**
 * E2E coverage for the GitHub-Pages auto-bootstrap behavior.
 *
 * On deploys without live mode (isLiveCapable === false), the playground
 * fetches the pre-baked snapshot at `/playground/assets/bootstrap-history.json`,
 * restores 12 h of model state into the dashboard, and starts the run
 * loop — so the user lands on a populated view instead of an empty one.
 *
 * The test forces the page to look like a GitHub Pages deploy by setting
 * `window.__simulateGitHubPagesDeploy = true` via addInitScript before
 * main.js evaluates its `isGitHubPages` check.
 *
 * The fixture also installs a `page.route` interceptor that records every
 * request to the snapshot file, so the tests can assert that main.js
 * actually fetched the pre-baked JSON (not silently fell back to an
 * empty start).
 */
import { test, expect } from './fixtures.js';

test.describe('GitHub Pages auto-bootstrap', () => {
  test.beforeEach(async ({ context }) => {
    // Pretend this is a GitHub Pages deploy. main.js reads this flag
    // before computing isLiveCapable, so the auto-bootstrap path runs.
    await context.addInitScript(() => {
      window.__simulateGitHubPagesDeploy = true;
    });
  });

  test('mode toggle is hidden when isLiveCapable is false', async ({ page }) => {
    await page.goto('/playground/');
    // The mode toggle should not have the 'visible' class added by initModeToggle().
    const toggle = page.locator('#mode-toggle');
    await expect(toggle).not.toHaveClass(/visible/);
  });

  test('simulation auto-starts (FAB shows pause icon) without user interaction', async ({ page }) => {
    await page.goto('/playground/');
    const fabIcon = page.locator('#fab-play .material-symbols-outlined');
    // togglePlay() flips running=true and updates the FAB icon to "pause".
    await expect(fabIcon).toHaveText('pause');
  });

  test('main.js fetches the pre-baked bootstrap snapshot', async ({ page }) => {
    // Track the snapshot fetch. main.js must request this exact file
    // — falling back to the empty-history path silently would mean the
    // build artifact got wired up wrong.
    /** @type {{ url: string, status: number }[]} */
    const snapshotRequests = [];
    page.on('response', (res) => {
      if (res.url().endsWith('/playground/assets/bootstrap-history.json')) {
        snapshotRequests.push({ url: res.url(), status: res.status() });
      }
    });

    await page.goto('/playground/');
    // Wait for the FAB to flip — that's a deterministic signal that
    // loadBootstrapSnapshotAndAutoStart() has finished its async work.
    await expect(page.locator('#fab-play .material-symbols-outlined')).toHaveText('pause');

    expect(snapshotRequests.length).toBeGreaterThanOrEqual(1);
    expect(snapshotRequests[0].status).toBe(200);
  });

  test('history graph and System Logs are pre-populated on first paint', async ({ page }) => {
    await page.goto('/playground/');
    // Wait for auto-start to flip the FAB so we know the snapshot
    // restore + render has run.
    await expect(page.locator('#fab-play .material-symbols-outlined')).toHaveText('pause');

    const dashboardState = await page.evaluate(() => {
      const logsList = document.getElementById('logs-list');
      const logItems = logsList ? logsList.querySelectorAll('.log-item').length : 0;
      const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('chart'));
      const canvasPainted = !!canvas && canvas.width > 0 && canvas.height > 0;
      return { logItems, canvasPainted };
    });

    // The pre-baked snapshot covers 12 h of day/night cycle, which the
    // current control logic turns into at least one solar_charging
    // transition. The drift test guarantees this stays true.
    expect(dashboardState.logItems).toBeGreaterThanOrEqual(1);
    expect(dashboardState.canvasPainted).toBe(true);
  });

  test('phase is set to simulation', async ({ page }) => {
    await page.goto('/playground/');
    // The mode toggle wasn't switched to 'live' because !isLiveCapable.
    // Sidebar subtitle reads "Simulating..." once the run loop is going.
    const subtitle = page.locator('#sidebar-subtitle');
    await expect(subtitle).toHaveText('Simulating...');
  });

  test('falls back to empty-history auto-start if the snapshot fetch fails', async ({ page }) => {
    // Force the snapshot fetch to fail. main.js should log a warning
    // and start with an empty history rather than crashing the page.
    await page.route('**/playground/assets/bootstrap-history.json', (route) =>
      route.fulfill({ status: 404, body: 'not found' })
    );

    await page.goto('/playground/');
    // Auto-start should still happen — togglePlay() runs even when the
    // snapshot is unavailable.
    await expect(page.locator('#fab-play .material-symbols-outlined')).toHaveText('pause');
    // Sidebar still reads "Simulating..." because the run loop is going.
    await expect(page.locator('#sidebar-subtitle')).toHaveText('Simulating...');
  });
});
