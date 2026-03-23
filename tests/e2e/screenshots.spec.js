import { test, expect } from '@playwright/test';
import path from 'path';

const screenshotDir = path.join('tests', 'e2e', 'screenshots');

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 720 };

function shot(name) {
  return { path: path.join(screenshotDir, name + '.png'), fullPage: true };
}

// Helper: navigate to Controls view to set sliders, then back to a target view
async function setSlider(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    if (el && el._sliderUpdate) el._sliderUpdate(value);
  }, { id, value });
}

// ─── Status View (default) ──────────────────────────────────────────────

test.describe('Status View Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await page.goto('/playground/');
    await expect(page.locator('#view-status')).toBeVisible();
  });

  test('initial state - desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.screenshot(shot('status-initial-desktop'));
  });

  test('initial state - mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.screenshot(shot('status-initial-mobile'));
  });

  test('running - solar charging mode', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // Switch to controls view to set params
    await page.locator('[data-view="controls"]').first().click();
    await expect(page.locator('#view-controls')).toBeVisible();

    await setSlider(page, 'irradiance', 800);
    await setSlider(page, 'tank-top', 25);
    await setSlider(page, 'tank-bot', 20);
    await setSlider(page, 'speed', 500);

    // Start simulation via FAB
    await page.locator('#fab-play').click();

    // Switch to status view
    await page.locator('[data-view="status"]').first().click();

    // Wait for mode to change
    await page.waitForFunction(() => {
      const el = document.getElementById('mode-card-title');
      return el && el.textContent !== 'Idle';
    }, { timeout: 15000 });

    await page.waitForTimeout(1000);
    await page.screenshot(shot('status-solar-charging-desktop'));
  });

  test('running - greenhouse heating mode', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.locator('[data-view="controls"]').first().click();
    await expect(page.locator('#view-controls')).toBeVisible();

    await setSlider(page, 'irradiance', 0);
    await setSlider(page, 'tank-top', 60);
    await setSlider(page, 'tank-bot', 50);
    await setSlider(page, 'greenhouse', 2);
    await setSlider(page, 'speed', 500);

    await page.locator('#fab-play').click();
    await page.locator('[data-view="status"]').first().click();

    await page.waitForFunction(() => {
      const el = document.getElementById('mode-card-title');
      return el && el.textContent !== 'Idle';
    }, { timeout: 15000 });

    await page.waitForTimeout(1000);
    await page.screenshot(shot('status-greenhouse-heating-desktop'));
  });

  test('running simulation - mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.locator('.bottom-nav [data-view="controls"]').click();
    await expect(page.locator('#view-controls')).toBeVisible();

    await setSlider(page, 'irradiance', 800);
    await setSlider(page, 'speed', 500);

    await page.locator('#fab-play').click();
    await page.locator('.bottom-nav [data-view="status"]').click();

    await page.waitForFunction(() => {
      const el = document.getElementById('mode-card-title');
      return el && el.textContent !== 'Idle';
    }, { timeout: 15000 });

    await page.waitForTimeout(1000);
    await page.screenshot(shot('status-running-mobile'));
  });
});

// ─── Components View ────────────────────────────────────────────────────

test.describe('Components View Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await page.goto('/playground/');
    await page.locator('[data-view="components"]').first().click();
    await expect(page.locator('#view-components')).toBeVisible();
  });

  test('desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.screenshot(shot('components-desktop'));
  });

  test('mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.screenshot(shot('components-mobile'));
  });
});

// ─── Schematic View ─────────────────────────────────────────────────────

test.describe('Schematic View Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await page.goto('/playground/');
    await page.locator('[data-view="schematic"]').first().click();
    await expect(page.locator('#view-schematic')).toBeVisible();
  });

  test('desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.screenshot(shot('schematic-desktop'));
  });

  test('mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.screenshot(shot('schematic-mobile'));
  });
});

// ─── Controls View ──────────────────────────────────────────────────────

test.describe('Controls View Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, route => route.abort());
    await page.goto('/playground/');
    await page.locator('[data-view="controls"]').first().click();
    await expect(page.locator('#view-controls')).toBeVisible();
  });

  test('desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.screenshot(shot('controls-desktop'));
  });

  test('day-night cycle enabled', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const toggle = page.locator('#day-night-toggle');
    if (await toggle.isVisible()) {
      await toggle.check();
      await page.waitForTimeout(300);
    }
    await page.screenshot(shot('controls-daynight-desktop'));
  });
});
