// @ts-check
import { test, expect } from './fixtures.js';

/**
 * Helper: set up a /version route that returns one hash for the baseline
 * call and a different hash for subsequent calls.
 */
async function setupVersionRoute(page, { baseline = 'aaaa000000000000', updated = 'bbbb111111111111' } = {}) {
  let callCount = 0;
  await page.route('/version', route => {
    callCount++;
    const hash = callCount <= 1 ? baseline : updated;
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ hash, ts: new Date().toISOString() }),
    });
  });
}

/** Trigger a poll cycle via the exposed test helper. */
async function triggerPoll(page) {
  await page.evaluate(() => window.__triggerVersionCheck());
}

test.describe('Version check toast', () => {
  test('toast appears when version hash changes', async ({ page }) => {
    await setupVersionRoute(page);
    await page.goto('/playground/');
    await page.waitForTimeout(300);

    // Trigger a poll — hash will now differ from baseline
    await triggerPoll(page);
    const toast = page.locator('.update-toast');
    await expect(toast).toHaveClass(/visible/);
  });

  test('toast has editorial copy and Stitch styling', async ({ page }) => {
    await setupVersionRoute(page);
    await page.goto('/playground/');
    await page.waitForTimeout(300);
    await triggerPoll(page);

    await expect(page.locator('.update-toast-headline')).toHaveText('A new edition is available');
    await expect(page.locator('.update-toast-refresh')).toHaveText('Refresh');
    await expect(page.locator('.update-toast-dismiss')).toHaveText('\u00d7');
  });

  test('dismiss hides the toast', async ({ page }) => {
    await setupVersionRoute(page);
    await page.goto('/playground/');
    await page.waitForTimeout(300);
    await triggerPoll(page);

    const toast = page.locator('.update-toast');
    await expect(toast).toHaveClass(/visible/);

    await page.locator('.update-toast-dismiss').click();
    await expect(toast).not.toHaveClass(/visible/);
  });

  test('no toast when version unchanged', async ({ page }) => {
    await setupVersionRoute(page, { baseline: 'same000000000000', updated: 'same000000000000' });
    await page.goto('/playground/');
    await page.waitForTimeout(300);
    await triggerPoll(page);

    const toast = page.locator('.update-toast.visible');
    await expect(toast).toHaveCount(0);
  });

  test('silent failure on network error', async ({ page }) => {
    await page.route('/version', route => route.abort('connectionrefused'));
    await page.goto('/playground/');
    await page.waitForTimeout(300);

    // Trigger poll — should not throw or show toast
    await page.evaluate(async () => {
      if (window.__triggerVersionCheck) await window.__triggerVersionCheck();
    });

    const toast = page.locator('.update-toast.visible');
    await expect(toast).toHaveCount(0);
  });
});
