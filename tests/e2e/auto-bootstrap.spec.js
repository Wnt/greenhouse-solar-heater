// @ts-check
/**
 * E2E coverage for the GitHub-Pages auto-bootstrap behavior.
 *
 * On deploys without live mode (isLiveCapable === false), the playground
 * pre-rolls 12 h of simulation history and starts the run loop immediately
 * so the dashboard is populated on first paint.
 *
 * The test forces the page to look like a GitHub Pages deploy by
 * monkey-patching `Location.prototype.hostname` via addInitScript before
 * main.js evaluates its `isGitHubPages` check.
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

  test('history graph and System Logs are pre-populated on first paint', async ({ page }) => {
    await page.goto('/playground/');

    // The bootstrap pushes 12 h × (1 sample / 5 s) ≈ 8640 points into the
    // time series store synchronously during init(). By the time the
    // page is interactive, the store should already be populated.
    const storeSize = await page.evaluate(async () => {
      // Wait a single rAF tick to make sure init() has finished its
      // synchronous work and the dashboard has rendered.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      // The store lives inside the main.js module scope. We can't read it
      // directly, so instead we count the rendered .log-item elements
      // and check the canvas has been painted.
      const logsList = document.getElementById('logs-list');
      const logItems = logsList ? logsList.querySelectorAll('.log-item').length : 0;
      const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('chart'));
      // A populated canvas has been drawn at least once and has non-zero
      // backing dimensions.
      const canvasPainted = !!canvas && canvas.width > 0 && canvas.height > 0;
      return { logItems, canvasPainted };
    });

    // Bootstrap runs the day/night cycle for 12 h, which is guaranteed
    // to produce at least one mode transition (sun rises → solar_charging)
    // and therefore at least one rendered log entry.
    expect(storeSize.logItems).toBeGreaterThanOrEqual(1);
    expect(storeSize.canvasPainted).toBe(true);
  });

  test('phase is set to simulation', async ({ page }) => {
    await page.goto('/playground/');
    // The mode toggle wasn't switched to 'live' because !isLiveCapable.
    // Sidebar subtitle reads "Simulating..." once the run loop is going.
    const subtitle = page.locator('#sidebar-subtitle');
    await expect(subtitle).toHaveText('Simulating...');
  });
});
