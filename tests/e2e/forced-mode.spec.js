// @ts-check
// DOM-shape coverage for the forced-mode UI added in the mo.fm migration.
// Keeps under ~1 s of wall time — no websocket, no backend, just asserts
// the controls/status markup is wired the way main.js expects.

import { test, expect } from './fixtures.js';

test.describe('forced-mode button group (override card)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/#controls');
  });

  test('group exists with all 6 mode buttons', async ({ page }) => {
    const group = page.locator('#forced-mode-group');
    await expect(group).toHaveCount(1);
    const buttons = page.locator('#forced-mode-btns .fm-btn');
    await expect(buttons).toHaveCount(6);
    const codes = await buttons.evaluateAll(bs => bs.map(b => b.getAttribute('data-mode')));
    expect(codes).toEqual(['', 'I', 'SC', 'GH', 'AD', 'EH']);
  });

  test('Automatic is the default active button', async ({ page }) => {
    const automatic = page.locator('#forced-mode-btns .fm-btn[data-mode=""]');
    await expect(automatic).toHaveClass(/active/);
    const others = page.locator('#forced-mode-btns .fm-btn:not([data-mode=""])');
    const count = await others.count();
    for (let i = 0; i < count; i++) {
      await expect(others.nth(i)).not.toHaveClass(/active/);
    }
  });

  test('group is hidden until override is active', async ({ page }) => {
    // Static load: mo is null → group should carry display:none inline.
    await expect(page.locator('#forced-mode-group')).toHaveCSS('display', 'none');
  });

  test('Mode Override block is removed from device-config card', async ({ page }) => {
    await expect(page.locator('#dc-fm')).toHaveCount(0);
  });
});

test.describe('status-view forced-mode indicator', () => {
  test('mode-card-exit-link is in the DOM and hidden by default', async ({ page }) => {
    await page.goto('/playground/#status');
    const link = page.locator('#mode-card-exit-link');
    await expect(link).toHaveCount(1);
    // Hidden when no override is active
    await expect(link).toBeHidden();
  });
});
