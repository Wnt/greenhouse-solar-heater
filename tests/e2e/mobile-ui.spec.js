// @ts-check
import { test, expect } from './fixtures.js';

const MOBILE = { width: 375, height: 812 };

test.describe('Simulation-only mode overlays (GitHub Pages context)', () => {
  test('connection overlays are hidden in simulation-only mode', async ({ page }) => {
    // ?mode=sim forces simulation-only mode (same as GitHub Pages)
    await page.goto('/playground/?mode=sim');
    await page.waitForTimeout(300);
    // No connection overlay should appear — simulation mode doesn't need a server
    await expect(page.locator('#overlay-modes')).not.toBeVisible();
    await expect(page.locator('#overlay-gauge')).not.toBeVisible();
    await expect(page.locator('#overlay-components')).not.toBeVisible();
  });
});

test.describe('Mobile: mode toggle visibility', () => {
  test('mode toggle is visible at mobile viewport width', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/');
    // Mode toggle must be accessible on mobile, not hidden inside the sidebar
    await expect(page.locator('#mode-toggle')).toBeVisible();
  });

  test('connection status indicator is visible at mobile viewport width', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/');
    await expect(page.locator('#connection-status')).toBeVisible();
  });
});

test.describe('Mobile: Device view does not overflow horizontally', () => {
  test('device config form does not cause horizontal scroll', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/');
    // Navigate to Device view via bottom nav (available in live mode on localhost)
    await page.locator('.bottom-nav [data-view="device"]').click();
    // Force-show the config form (normally hidden until API loads config)
    await page.evaluate(() => {
      var form = document.getElementById('device-config-form');
      if (form) form.style.display = '';
    });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  });
});
