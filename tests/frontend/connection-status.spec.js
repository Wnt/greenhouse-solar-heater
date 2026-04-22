// @ts-check
import { test, expect } from './fixtures.js';

test.describe('Connection status and overlays', () => {

  test('mode toggle is fully visible with proper padding', async ({ page }) => {
    await page.goto('/playground/');
    const toggle = page.locator('#mode-toggle');
    await expect(toggle).toBeVisible();
    // Label should be fully visible (not clipped)
    const label = page.locator('#mode-toggle-label');
    await expect(label).toBeVisible();
    const text = await label.textContent();
    expect(text).toBeTruthy();
    // Label should have left offset >= 24px (proper padding inside sidebar)
    const labelBox = await label.boundingBox();
    expect(labelBox).toBeTruthy();
    expect(labelBox.x).toBeGreaterThanOrEqual(24);
  });

  test('never-connected overlay appears in live mode', async ({ page }) => {
    await page.goto('/playground/');
    // On localhost, app defaults to live mode with no WebSocket server
    // so it should show the "never connected" overlay
    const overlay = page.locator('#overlay-modes');
    await expect(overlay).toBeVisible();
    // Check editorial message
    const title = page.locator('#overlay-modes-title');
    await expect(title).toContainText('sanctuary');
    // Gauge overlay should also be visible
    await expect(page.locator('#overlay-gauge')).toBeVisible();
    // Components overlay should also be visible
    await expect(page.locator('#overlay-components')).toBeVisible();
  });

  test('overlays removed when switching to simulation', async ({ page }) => {
    await page.goto('/playground/');
    // Wait for overlays to appear
    await expect(page.locator('#overlay-modes')).toBeVisible();
    // Switch to simulation
    await page.locator('#mode-toggle-switch').click();
    // Overlays should be hidden
    await expect(page.locator('#overlay-modes')).not.toBeVisible();
    await expect(page.locator('#overlay-gauge')).not.toBeVisible();
    await expect(page.locator('#overlay-components')).not.toBeVisible();
  });

  test('save button disabled without connection', async ({ page }) => {
    // Mock API routes to allow Device view to load
    await page.route('**/api/device-config', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ v: 1, ce: true, ea: 31, fm: null, am: null }),
        });
      }
    });
    await page.route('**/api/history**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: '[]',
    }));

    await page.goto('/playground/');
    // Navigate to device view
    await page.locator('.sidebar-nav [data-view="device"]').click();
    await expect(page.locator('#view-device')).toBeVisible();
    // Wait for config to load
    await expect(page.locator('#device-config-form')).toBeVisible();
    // Save button should be disabled (no connection in live mode)
    const btn = page.locator('#dc-save');
    await expect(btn).toHaveClass(/disabled/);
    // Warning should be visible
    await expect(page.locator('#dc-connection-warning')).toBeVisible();
  });

  test('try-anyway link is present and clickable', async ({ page }) => {
    await page.route('**/api/device-config', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ v: 1, ce: true, ea: 31, fm: null, am: null }),
        });
      }
    });
    await page.route('**/api/history**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: '[]',
    }));

    await page.goto('/playground/');
    await page.locator('.sidebar-nav [data-view="device"]').click();
    await expect(page.locator('#device-config-form')).toBeVisible();
    // "Try anyway" link should be visible
    const tryLink = page.locator('#dc-try-anyway');
    await expect(tryLink).toBeVisible();
    await expect(tryLink).toHaveText('Try anyway');
  });
});
