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
  test('desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/playground/index.html');
    await expect(page.locator('body')).toBeVisible();
    await page.screenshot(shot('index-desktop'));
  });

  test('mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/index.html');
    await expect(page.locator('body')).toBeVisible();
    await page.screenshot(shot('index-mobile'));
  });
});

// ─── Thermal Simulation ─────────────────────────────────────────────────

test.describe('Thermal Simulation Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/thermal.html');
    await expect(page.locator('#controls .control-group')).toHaveCount(7);
  });

  test('initial state - desktop 2D', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // Ensure we are in 2D view (click toggle if currently 3D)
    const toggle = page.locator('#btn-toggle-view');
    if (await toggle.isVisible()) {
      const text = await toggle.textContent();
      if (text.includes('2D')) {
        await toggle.click();
        await page.waitForTimeout(300);
      }
    }
    await page.screenshot(shot('thermal-2d-initial-desktop'));
  });

  test('initial state - desktop 3D', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    const toggle = page.locator('#btn-toggle-view');
    if (await toggle.isVisible()) {
      const text = await toggle.textContent();
      if (text.includes('3D')) {
        await toggle.click();
        await page.waitForTimeout(500);
      }
      await page.screenshot(shot('thermal-3d-initial-desktop'));
    } else {
      // 3D not available, take 2D screenshot as fallback
      await page.screenshot(shot('thermal-2d-fallback-desktop'));
    }
  });

  test('initial state - mobile 2D', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const toggle = page.locator('#btn-toggle-view');
    if (await toggle.isVisible()) {
      const text = await toggle.textContent();
      if (text.includes('2D')) {
        await toggle.click();
        await page.waitForTimeout(300);
      }
    }
    await page.screenshot(shot('thermal-2d-initial-mobile'));
  });

  test('initial state - mobile 3D', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const toggle = page.locator('#btn-toggle-view');
    if (await toggle.isVisible()) {
      const text = await toggle.textContent();
      if (text.includes('3D')) {
        await toggle.click();
        await page.waitForTimeout(500);
      }
      await page.screenshot(shot('thermal-3d-initial-mobile'));
    } else {
      await page.screenshot(shot('thermal-2d-fallback-mobile'));
    }
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

    // Ensure 2D view for clear pipe visualization
    const toggle = page.locator('#btn-toggle-view');
    if (await toggle.isVisible()) {
      const text = await toggle.textContent();
      if (text.includes('2D')) {
        await toggle.click();
        await page.waitForTimeout(300);
      }
    }

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

    const toggle = page.locator('#btn-toggle-view');
    if (await toggle.isVisible()) {
      const text = await toggle.textContent();
      if (text.includes('2D')) {
        await toggle.click();
        await page.waitForTimeout(300);
      }
    }

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

    const toggle = page.locator('#btn-toggle-view');
    if (await toggle.isVisible()) {
      const text = await toggle.textContent();
      if (text.includes('2D')) {
        await toggle.click();
        await page.waitForTimeout(300);
      }
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

// ─── Shelly Linter ───────────────────────────────────────────────────────

test.describe('Linter Screenshots', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/linter.html');
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(500);
  });

  test('initial state - desktop', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.screenshot(shot('linter-initial-desktop'));
  });

  test('initial state - mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.screenshot(shot('linter-initial-mobile'));
  });

  test('sample with violations loaded', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // Click "Load Sample" button
    const sampleBtn = page.locator('button', { hasText: /Sample/i });
    if (await sampleBtn.isVisible()) {
      await sampleBtn.click();
      await page.waitForTimeout(300);
    }

    // Click lint button
    const lintBtn = page.locator('button', { hasText: /Lint/i });
    if (await lintBtn.isVisible()) {
      await lintBtn.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot(shot('linter-violations-desktop'));
  });

  test('clean script loaded', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    // Load control-logic.js (should be clean)
    const loadBtn = page.locator('button', { hasText: /control-logic/i });
    if (await loadBtn.isVisible()) {
      await loadBtn.click();
      await page.waitForTimeout(500);
    }

    const lintBtn = page.locator('button', { hasText: /Lint/i });
    if (await lintBtn.isVisible()) {
      await lintBtn.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot(shot('linter-clean-desktop'));
  });

  test('violations - mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    const sampleBtn = page.locator('button', { hasText: /Sample/i });
    if (await sampleBtn.isVisible()) {
      await sampleBtn.click();
      await page.waitForTimeout(300);
    }

    const lintBtn = page.locator('button', { hasText: /Lint/i });
    if (await lintBtn.isVisible()) {
      await lintBtn.click();
      await page.waitForTimeout(500);
    }

    await page.screenshot(shot('linter-violations-mobile'));
  });
});
