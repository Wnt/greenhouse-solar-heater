import { test, expect } from '@playwright/test';
import path from 'path';

const screenshotDir = path.join('tests', 'e2e', 'screenshots');

const MOBILE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 720 };

function shot(name) {
  return { path: path.join(screenshotDir, name + '.png'), fullPage: true };
}

// ─── Index / Landing Page ───────────────────────────────────────────────

test.describe('Index Page Screenshots', () => {
  // Use trailing slash so relative CSS path (css/style.css) resolves correctly.
  // serve's cleanUrls redirects /playground/index.html → /playground (no slash),
  // which breaks relative asset resolution.
  const indexUrl = '/playground/';

  test('desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto(indexUrl, { waitUntil: 'load' });
    await expect(page.locator('.tools-grid')).toBeVisible();
    await page.screenshot(shot('index-desktop'));
  });

  test('mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto(indexUrl, { waitUntil: 'load' });
    await expect(page.locator('.tools-grid')).toBeVisible();
    await page.screenshot(shot('index-mobile'));
  });
});

// ─── Thermal Simulation ─────────────────────────────────────────────────

test.describe('Thermal Simulation Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/thermal.html');
    await expect(page.locator('#controls .control-group')).toHaveCount(7);
  });

  test('initial state - desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.screenshot(shot('thermal-2d-initial-desktop'));
  });

  test('initial state - mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.screenshot(shot('thermal-2d-initial-mobile'));
  });

  test('running - solar charging mode', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // Set high irradiance to trigger solar charging
    const irradiance = page.locator('#irradiance');
    await irradiance.fill('800');
    await irradiance.dispatchEvent('input');

    // Set tank temps low so solar charging activates
    const tankTop = page.locator('#tank-top');
    await tankTop.fill('25');
    await tankTop.dispatchEvent('input');

    const tankBot = page.locator('#tank-bot');
    await tankBot.fill('20');
    await tankBot.dispatchEvent('input');

    // Set sim speed high
    const speed = page.locator('#speed');
    await speed.fill('100');
    await speed.dispatchEvent('input');

    // Start simulation
    await page.locator('#btn-play').click();

    // Wait for mode to change from idle
    await page.waitForFunction(() => {
      const el = document.getElementById('sim-mode');
      return el && el.textContent !== 'idle';
    }, { timeout: 15000 });

    await page.waitForTimeout(1000);
    await page.screenshot(shot('thermal-solar-charging-desktop'));
  });

  test('running - greenhouse heating mode', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // No sun, cold greenhouse, warm tank → greenhouse heating
    const irradiance = page.locator('#irradiance');
    await irradiance.fill('0');
    await irradiance.dispatchEvent('input');

    const tankTop = page.locator('#tank-top');
    await tankTop.fill('60');
    await tankTop.dispatchEvent('input');

    const tankBot = page.locator('#tank-bot');
    await tankBot.fill('50');
    await tankBot.dispatchEvent('input');

    const greenhouse = page.locator('#greenhouse');
    await greenhouse.fill('2');
    await greenhouse.dispatchEvent('input');

    const speed = page.locator('#speed');
    await speed.fill('100');
    await speed.dispatchEvent('input');

    await page.locator('#btn-play').click();

    await page.waitForFunction(() => {
      const el = document.getElementById('sim-mode');
      return el && el.textContent !== 'idle';
    }, { timeout: 15000 });

    await page.waitForTimeout(1000);
    await page.screenshot(shot('thermal-greenhouse-heating-desktop'));
  });

  test('day-night cycle enabled', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const dayNight = page.locator('#day-night-toggle');
    if (await dayNight.isVisible()) {
      await dayNight.check();
      await page.waitForTimeout(300);
    }

    await page.screenshot(shot('thermal-daynight-desktop'));
  });

  test('running simulation - mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const irradiance = page.locator('#irradiance');
    await irradiance.fill('800');
    await irradiance.dispatchEvent('input');

    const speed = page.locator('#speed');
    await speed.fill('100');
    await speed.dispatchEvent('input');

    await page.locator('#btn-play').click();

    await page.waitForFunction(() => {
      const el = document.getElementById('sim-mode');
      return el && el.textContent !== 'idle';
    }, { timeout: 15000 });

    await page.waitForTimeout(1000);
    await page.screenshot(shot('thermal-running-mobile'));
  });
});

// ─── Hydraulic Simulation ────────────────────────────────────────────────

test.describe('Hydraulic Simulation Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/hydraulic.html');
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(500);
  });

  test('initial state - desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.screenshot(shot('hydraulic-initial-desktop'));
  });

  test('initial state - mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.screenshot(shot('hydraulic-initial-mobile'));
  });

  test('solar charging mode', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const modeSelect = page.locator('#mode-select');
    if (await modeSelect.isVisible()) {
      await modeSelect.selectOption('solar_charging');
      await page.waitForTimeout(300);

      // Start simulation if there's a play button
      const btn = page.locator('#btn-play');
      if (await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(1500);
      }
    }
    await page.screenshot(shot('hydraulic-solar-charging-desktop'));
  });

  test('active drain mode', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const modeSelect = page.locator('#mode-select');
    if (await modeSelect.isVisible()) {
      await modeSelect.selectOption('active_drain');
      await page.waitForTimeout(300);

      const btn = page.locator('#btn-play');
      if (await btn.isVisible()) {
        await btn.click();
        await page.waitForTimeout(1500);
      }
    }
    await page.screenshot(shot('hydraulic-drain-desktop'));
  });

  test('normal operation preset', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // Click the "Normal Operation" preset button
    const preset = page.locator('button', { hasText: /Normal/i });
    if (await preset.isVisible()) {
      await preset.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot(shot('hydraulic-normal-preset-desktop'));
  });

  test('low water preset', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const preset = page.locator('button', { hasText: /Low Water/i });
    if (await preset.isVisible()) {
      await preset.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot(shot('hydraulic-lowwater-preset-desktop'));
  });

  test('air injection test', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const preset = page.locator('button', { hasText: /Air Injection/i });
    if (await preset.isVisible()) {
      await preset.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot(shot('hydraulic-air-injection-desktop'));
  });

  test('presets - mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const preset = page.locator('button', { hasText: /Normal/i });
    if (await preset.isVisible()) {
      await preset.click();
      await page.waitForTimeout(1000);
    }
    await page.screenshot(shot('hydraulic-normal-preset-mobile'));
  });
});
