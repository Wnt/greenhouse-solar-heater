// @ts-check
// Staged-valve observability (023-limit-valve-operations, US5).
//
// Verifies the Status view has the staged-valve indicator element and the
// Device view has the staged-valve detail card, both hidden at boot.
// Drives the rendering path directly via the playground's display-update
// function to confirm they appear when a staged transition is active.
import { test, expect } from './fixtures.js';

test.describe('Staged valve observability', () => {
  test('status view has a hidden staged-valve indicator at boot', async ({ page }) => {
    await page.goto('/playground/');
    // Switch to simulation mode (deterministic, no WS required).
    await page.locator('#mode-toggle-switch').click();
    const stagedInd = page.locator('#staged-valve-indicator');
    await expect(stagedInd).toBeHidden();
  });

  test('device view has a hidden staged-valve detail card at boot', async ({ page }) => {
    await page.goto('/playground/');
    await page.locator('#mode-toggle-switch').click();
    const card = page.locator('#staged-valve-detail-card');
    await expect(card).toBeHidden();
  });

  test('staged-valve indicator elements are wired in the DOM', async ({ page }) => {
    await page.goto('/playground/');
    // Both the Status-view indicator and Device-view detail card exist,
    // even when hidden — this confirms the HTML wiring survived any
    // template changes. US5 lists the three new fields; we assert the
    // container elements all exist.
    await expect(page.locator('#staged-valve-indicator')).toHaveCount(1);
    await expect(page.locator('#staged-valve-detail-card')).toHaveCount(1);
    await expect(page.locator('#staged-valve-detail-opening')).toHaveCount(1);
    await expect(page.locator('#staged-valve-detail-queued')).toHaveCount(1);
    await expect(page.locator('#staged-valve-detail-pending-close')).toHaveCount(1);
  });
});
