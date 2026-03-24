// @ts-check
import { test, expect } from './fixtures.js';

test.describe('Live mode toggle', () => {
  test('mode toggle is visible on non-GitHub-Pages deployment', async ({ page }) => {
    await page.goto('/playground/');
    // The app detects localhost as live-capable
    const toggle = page.locator('#mode-toggle');
    await expect(toggle).toBeVisible();
  });

  test('connection status indicator is present', async ({ page }) => {
    await page.goto('/playground/');
    const dot = page.locator('#connection-dot');
    await expect(dot).toBeVisible();
  });

  test('switching to simulation mode shows controls view', async ({ page }) => {
    await page.goto('/playground/');
    // Click toggle to switch to simulation
    const sw = page.locator('#mode-toggle-switch');
    await sw.click();
    // Controls nav item should be visible
    const controlsNav = page.locator('.sidebar-nav [data-view="controls"]');
    await expect(controlsNav).toBeVisible();
  });

  test('simulation mode still works after toggle', async ({ page }) => {
    await page.goto('/playground/');
    // Switch to simulation
    await page.locator('#mode-toggle-switch').click();
    // Start simulation
    await page.locator('#fab-play').click();
    // Wait for simulation to produce data
    await page.waitForTimeout(100);
    // Verify display updates
    const tankTemp = page.locator('#tank-temp-val');
    const text = await tankTemp.textContent();
    expect(text).not.toBe('--');
  });
});
