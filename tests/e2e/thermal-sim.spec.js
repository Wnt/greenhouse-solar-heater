import { test, expect } from '@playwright/test';

test.describe('Thermal Simulation UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/thermal.html');
    // Wait for the page to initialize (sliders rendered)
    await expect(page.locator('#controls .control-group')).toHaveCount(6);
  });

  test('page loads with correct title and initial state', async ({ page }) => {
    await expect(page).toHaveTitle(/Thermal Simulation/);
    // Sim time starts at 00:00:00
    await expect(page.locator('#sim-time')).toHaveText('00:00:00');
    // Mode starts as idle
    await expect(page.locator('#sim-mode')).toHaveText('idle');
    // Start button is present
    await expect(page.locator('#btn-play')).toHaveText('Start');
  });

  test('temperature table shows initial values', async ({ page }) => {
    const tempTable = page.locator('#temp-table');
    await expect(tempTable).toBeVisible();
    // Should have 5 sensor rows
    const rows = tempTable.locator('tr');
    await expect(rows).toHaveCount(5);
    // Collector, Tank Top, Tank Bottom, Greenhouse, Outdoor
    await expect(rows.nth(0)).toContainText('Collector');
    await expect(rows.nth(1)).toContainText('Tank Top');
    await expect(rows.nth(2)).toContainText('Tank Bottom');
    await expect(rows.nth(3)).toContainText('Greenhouse');
    await expect(rows.nth(4)).toContainText('Outdoor');
  });

  test('valve table shows all 8 valves and 3 actuators', async ({ page }) => {
    const valveTable = page.locator('#valve-table');
    await expect(valveTable).toBeVisible();
    // 8 valves + 3 actuators = 11 rows
    const rows = valveTable.locator('tr');
    await expect(rows).toHaveCount(11);
  });

  test('start button toggles simulation', async ({ page }) => {
    const btn = page.locator('#btn-play');
    await expect(btn).toHaveText('Start');

    // Click start
    await btn.click();
    await expect(btn).toHaveText('Running...');

    // Wait a moment and check time advances
    await page.waitForTimeout(300);
    const time = await page.locator('#sim-time').textContent();
    expect(time).not.toBe('00:00:00');

    // Click again to pause (toggle)
    await btn.click();
    await expect(btn).toHaveText('Start');
  });

  test('pause button stops simulation', async ({ page }) => {
    // Start
    await page.locator('#btn-play').click();
    await page.waitForTimeout(200);

    // Pause
    await page.locator('#btn-pause').click();
    await expect(page.locator('#btn-play')).toHaveText('Start');

    // Record time, wait, verify it doesn't change
    const time1 = await page.locator('#sim-time').textContent();
    await page.waitForTimeout(200);
    const time2 = await page.locator('#sim-time').textContent();
    expect(time1).toBe(time2);
  });

  test('reset button resets simulation to initial state', async ({ page }) => {
    // Start and let it run briefly
    await page.locator('#btn-play').click();
    await page.waitForTimeout(300);

    // Reset
    await page.locator('#btn-reset').click();
    await expect(page.locator('#sim-time')).toHaveText('00:00:00');
    await expect(page.locator('#sim-mode')).toHaveText('idle');
    await expect(page.locator('#btn-play')).toHaveText('Start');
  });

  test('simulation produces mode transitions with default params', async ({ page }) => {
    // Default params: t_outdoor=5, irradiance=500, t_tank_top=40, t_tank_bottom=35, t_greenhouse=8
    // With irradiance=500 and t_tank_bottom=35, collector should heat up and trigger solar_charging
    // Also t_greenhouse=8 < 10 and t_tank_top=40 > 25 should trigger greenhouse_heating

    // Start simulation
    await page.locator('#btn-play').click();

    // Wait for timestamped transition entries to appear (after startup header)
    await expect(page.locator('#transition-log')).toContainText(/\[\d{2}:\d{2}:\d{2}\]/, { timeout: 5000 });

    const logText = await page.locator('#transition-log').textContent();
    // Log should contain startup header and timestamp-prefixed entries
    expect(logText).toContain('Simulation started');
    expect(logText).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  test('log output has proper line breaks', async ({ page }) => {
    // Start simulation and wait for multiple transitions
    await page.locator('#btn-play').click();

    // Wait for log content
    await expect(page.locator('#transition-log')).not.toBeEmpty({ timeout: 5000 });

    // Check that the log div has white-space: pre-wrap for proper line breaks
    const whiteSpace = await page.locator('#transition-log').evaluate(el => {
      return window.getComputedStyle(el).whiteSpace;
    });
    expect(whiteSpace).toBe('pre-wrap');

    // Check that the text content contains newlines (proper log format)
    const logText = await page.locator('#transition-log').textContent();
    expect(logText).toContain('\n');

    // Verify that the rendered height indicates multiple lines
    // (each log line is ~12px, if there's only 1 line visible despite multiple entries, line breaks are broken)
    const logEl = page.locator('#transition-log');
    const height = await logEl.evaluate(el => el.scrollHeight);
    // With proper line breaks and at least one transition, height should be > single line
    expect(height).toBeGreaterThan(14);
  });

  test('view toggle or 2D fallback works', async ({ page }) => {
    const toggleBtn = page.locator('#btn-toggle-view');
    const view3d = page.locator('#view-3d');
    const view2d = page.locator('#view-2d');

    // Wait for 3D init to complete (or fall back)
    await page.waitForTimeout(500);

    const toggleVisible = await toggleBtn.isVisible();
    if (toggleVisible) {
      // 3D available: toggle should switch views
      await toggleBtn.click();
      await expect(view2d).toBeVisible();
      await toggleBtn.click();
      await expect(view3d).toBeVisible();
    } else {
      // 3D unavailable: should fall back to 2D schematic
      await expect(view2d).toBeVisible();
      await expect(page.locator('#schematic svg')).toBeAttached();
    }
  });

  test('sliders update parameter values', async ({ page }) => {
    // Change outdoor temp slider
    const slider = page.locator('#outdoor');
    await slider.fill('20');
    await slider.dispatchEvent('input');

    // The value display should update
    await expect(page.locator('#outdoor-val')).toContainText('20');
  });

  test('mode badge updates during simulation', async ({ page }) => {
    // Start simulation
    await page.locator('#btn-play').click();

    // Wait for any mode change (the default params should trigger greenhouse_heating quickly)
    // since t_greenhouse=8 < 10 and t_tank_top=40 > 25
    await page.waitForFunction(() => {
      const mode = document.getElementById('sim-mode');
      return mode && mode.textContent !== 'idle';
    }, { timeout: 5000 });

    const modeText = await page.locator('#sim-mode').textContent();
    expect(modeText).not.toBe('idle');
  });

  test('chart canvas is present and sized', async ({ page }) => {
    const chart = page.locator('#chart');
    await expect(chart).toBeVisible();

    const box = await chart.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(50);
  });

  test('navigation links are present and correct', async ({ page }) => {
    const nav = page.locator('.page-header nav');
    await expect(nav.locator('a')).toHaveCount(4);
    await expect(nav.locator('a.active')).toHaveText('Thermal Sim');
  });
});
