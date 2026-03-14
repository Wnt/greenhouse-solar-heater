import { test, expect } from '@playwright/test';

test.describe('Thermal Simulation UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/thermal.html');
    // Wait for the page to initialize (sliders rendered)
    await expect(page.locator('#controls .control-group')).toHaveCount(7);
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
    // 2-column layout: 6 rows (11 items split across 2 columns)
    const rows = valveTable.locator('tr');
    await expect(rows).toHaveCount(6);
  });

  test('start button toggles simulation', async ({ page }) => {
    const btn = page.locator('#btn-play');
    await expect(btn).toHaveText('Start');

    // Click start
    await btn.click();
    await expect(btn).toHaveText('Running...');

    // Wait for sim time to advance past 00:00:00
    await page.waitForFunction(() => {
      const el = document.getElementById('sim-time');
      return el && el.textContent !== '00:00:00';
    }, { timeout: 3000 });

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
    // Set params that trigger quick mode transitions:
    // t_greenhouse=8 < 10 and t_tank_top=40 > 25 triggers greenhouse_heating
    for (const { id, value } of [
      { id: 'tank-top', value: '40' },
      { id: 'tank-bot', value: '35' },
      { id: 'greenhouse', value: '8' },
      { id: 'speed', value: '50' },
    ]) {
      await page.locator(`#${id}`).fill(value);
      await page.locator(`#${id}`).dispatchEvent('input');
    }

    // Start simulation
    await page.locator('#btn-play').click();

    // Wait for timestamped transition entries to appear (after startup header)
    await expect(page.locator('#transition-log')).toContainText(/\[\d{2}:\d{2}:\d{2}\]/, { timeout: 10000 });

    const logText = await page.locator('#transition-log').textContent();
    // Log should contain startup header and timestamp-prefixed entries
    expect(logText).toContain('Simulation started');
    expect(logText).toMatch(/\[\d{2}:\d{2}:\d{2}\]/);
  });

  test('log output has proper line breaks', async ({ page }) => {
    // Set params that trigger quick transitions
    for (const { id, value } of [
      { id: 'tank-top', value: '40' },
      { id: 'tank-bot', value: '35' },
      { id: 'greenhouse', value: '8' },
      { id: 'speed', value: '50' },
    ]) {
      await page.locator(`#${id}`).fill(value);
      await page.locator(`#${id}`).dispatchEvent('input');
    }

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

  test('schematic is visible', async ({ page }) => {
    await expect(page.locator('#view-2d svg')).toBeVisible();
  });

  test('sliders update parameter values', async ({ page }) => {
    // Change outdoor temp slider
    const slider = page.locator('#outdoor');
    await slider.fill('20');
    await slider.dispatchEvent('input');

    // The value display should update
    await expect(page.locator('#outdoor-val')).toContainText('20');
  });

  test('simulation uses slider values, not hardcoded defaults', async ({ page }) => {
    // Set sliders to values different from defaults
    // Defaults: t_outdoor=10, t_tank_top=12, t_tank_bottom=9, t_greenhouse=11
    const sliderValues = [
      { id: 'outdoor', value: '15' },
      { id: 'tank-top', value: '40' },
      { id: 'tank-bot', value: '30' },
      { id: 'greenhouse', value: '18' },
    ];
    for (const { id, value } of sliderValues) {
      const slider = page.locator(`#${id}`);
      await slider.fill(value);
      await slider.dispatchEvent('input');
    }

    // Start the simulation
    await page.locator('#btn-play').click();

    // Wait for the startup log to appear
    await expect(page.locator('#transition-log')).toContainText('Simulation started', { timeout: 3000 });

    const logText = await page.locator('#transition-log').textContent();

    // The log should show our slider values, not the defaults
    expect(logText).toContain('Tank top:    40.0°C');
    expect(logText).toContain('Tank bottom: 30.0°C');
    expect(logText).toContain('Greenhouse:  18.0°C');
    expect(logText).toContain('Outdoor:     15.0°C');

    // Must NOT contain the hardcoded defaults
    expect(logText).not.toContain('Tank top:    12.0°C');
    expect(logText).not.toContain('Tank bottom: 9.0°C');
    expect(logText).not.toContain('Greenhouse:  11.0°C');
  });

  test('temperature table reflects slider values after start', async ({ page }) => {
    // Set non-default slider values
    await page.locator('#tank-top').fill('20');
    await page.locator('#tank-top').dispatchEvent('input');
    await page.locator('#tank-bot').fill('15');
    await page.locator('#tank-bot').dispatchEvent('input');

    // Start simulation
    await page.locator('#btn-play').click();
    await page.waitForTimeout(200);

    // Temperature table should show values close to what we set (physics may shift them slightly)
    const tankTopRow = page.locator('#temp-table tr:nth-child(2) .val');
    const tankTopText = await tankTopRow.textContent();
    const tankTopVal = parseFloat(tankTopText);
    // Should be near 20, not near the default 40
    expect(tankTopVal).toBeLessThan(25);
    expect(tankTopVal).toBeGreaterThan(15);

    const tankBotRow = page.locator('#temp-table tr:nth-child(3) .val');
    const tankBotText = await tankBotRow.textContent();
    const tankBotVal = parseFloat(tankBotText);
    // Should be near 15, not near the default 35
    expect(tankBotVal).toBeLessThan(20);
    expect(tankBotVal).toBeGreaterThan(10);
  });

  test('reset then change sliders then start uses new values', async ({ page }) => {
    // Start with defaults, run briefly, then reset
    await page.locator('#btn-play').click();
    await page.waitForTimeout(200);
    await page.locator('#btn-reset').click();

    // Now change sliders
    await page.locator('#greenhouse').fill('25');
    await page.locator('#greenhouse').dispatchEvent('input');
    await page.locator('#outdoor').fill('20');
    await page.locator('#outdoor').dispatchEvent('input');

    // Start again
    await page.locator('#btn-play').click();
    await expect(page.locator('#transition-log')).toContainText('Simulation started', { timeout: 3000 });

    const logText = await page.locator('#transition-log').textContent();
    expect(logText).toContain('Greenhouse:  25.0°C');
    expect(logText).toContain('Outdoor:     20.0°C');
  });

  test('mode badge updates during simulation', async ({ page }) => {
    // Set params that trigger greenhouse_heating: t_greenhouse < 10 and t_tank_top > 25
    for (const { id, value } of [
      { id: 'tank-top', value: '40' },
      { id: 'greenhouse', value: '8' },
      { id: 'speed', value: '50' },
    ]) {
      await page.locator(`#${id}`).fill(value);
      await page.locator(`#${id}`).dispatchEvent('input');
    }

    // Start simulation
    await page.locator('#btn-play').click();

    // Wait for any mode change (greenhouse_heating should trigger quickly)
    // since t_greenhouse=8 < 10 and t_tank_top=40 > 25
    await page.waitForFunction(() => {
      const mode = document.getElementById('sim-mode');
      return mode && mode.textContent !== 'idle';
    }, { timeout: 5000 });

    const modeText = await page.locator('#sim-mode').textContent();
    expect(modeText).not.toBe('idle');
  });

  test('sim speed slider controls simulation rate', async ({ page }) => {
    // Helper: parse HH:MM:SS to total seconds
    const parseTime = (t) => {
      const [h, m, s] = t.split(':').map(Number);
      return h * 3600 + m * 60 + s;
    };

    // Run at speed=1 for 1 second of wall time
    await page.locator('#speed').fill('1');
    await page.locator('#speed').dispatchEvent('input');
    await page.locator('#btn-play').click();
    await page.waitForTimeout(1000);
    await page.locator('#btn-pause').click();
    const timeSlow = parseTime(await page.locator('#sim-time').textContent());

    // Reset and run at speed=100 for 1 second of wall time
    await page.locator('#btn-reset').click();
    await page.locator('#speed').fill('100');
    await page.locator('#speed').dispatchEvent('input');
    await page.locator('#btn-play').click();
    await page.waitForTimeout(1000);
    await page.locator('#btn-pause').click();
    const timeFast = parseTime(await page.locator('#sim-time').textContent());

    // Fast run should advance significantly more sim-time than slow run
    // At 100x vs 1x, ratio should be ~100, but allow wide margin for CI variance.
    // The key assertion: speed=100 must produce at least 10x more sim-time than speed=1
    expect(timeFast).toBeGreaterThan(timeSlow * 10);
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
    await expect(nav.locator('a')).toHaveCount(3);
    await expect(nav.locator('a.active')).toHaveText('Thermal Sim');
  });
});
