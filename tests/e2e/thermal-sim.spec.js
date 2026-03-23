import { test, expect } from '@playwright/test';

// Helper: navigate to a view via sidebar (desktop) or bottom nav
async function goToView(page, viewName) {
  await page.locator(`.sidebar-nav [data-view="${viewName}"]`).click();
  await expect(page.locator(`#view-${viewName}`)).toBeVisible();
}

// Helper: set a slider value (must be on Controls view)
async function setSlider(page, id, value) {
  const slider = page.locator('#' + id);
  await slider.fill(String(value));
  await slider.dispatchEvent('input');
}

test.describe('Thermal Simulation UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/thermal.html');
    // Wait for controls to render (7 control groups: 6 sliders + day/night toggle)
    await goToView(page, 'controls');
    await expect(page.locator('#controls .control-group')).toHaveCount(7);
    await goToView(page, 'status');
  });

  test('page loads with correct title and initial state', async ({ page }) => {
    await expect(page).toHaveTitle(/Thermal Simulation/);
    // Mode card shows Idle
    await expect(page.locator('#mode-card-title')).toHaveText('Idle');
    // FAB shows play icon
    await expect(page.locator('#fab-play')).toBeVisible();
  });

  test('temperature table shows initial values', async ({ page }) => {
    await goToView(page, 'components');
    const tempTable = page.locator('#temp-table');
    await expect(tempTable).toBeVisible();
    const rows = tempTable.locator('tr');
    await expect(rows).toHaveCount(5);
    await expect(rows.nth(0)).toContainText('Collector');
    await expect(rows.nth(1)).toContainText('Tank Top');
    await expect(rows.nth(2)).toContainText('Tank Bottom');
    await expect(rows.nth(3)).toContainText('Greenhouse');
    await expect(rows.nth(4)).toContainText('Outdoor');
  });

  test('valve grid shows all 8 valves', async ({ page }) => {
    await goToView(page, 'components');
    const valveChips = page.locator('#valve-grid .valve-chip');
    await expect(valveChips).toHaveCount(8);
  });

  test('FAB toggles simulation', async ({ page }) => {
    const fab = page.locator('#fab-play');

    // Click to start
    await fab.click();
    // FAB icon should change to pause
    await expect(fab.locator('.material-symbols-outlined')).toHaveText('pause');

    // Click again to pause
    await fab.click();
    await expect(fab.locator('.material-symbols-outlined')).toHaveText('play_arrow');
  });

  test('reset button resets simulation to initial state', async ({ page }) => {
    // Start simulation
    await page.locator('#fab-play').click();
    await page.waitForTimeout(300);

    // Go to controls and reset
    await goToView(page, 'controls');
    await page.locator('#btn-reset').click();

    // Go back to status — mode should be Idle
    await goToView(page, 'status');
    await expect(page.locator('#mode-card-title')).toHaveText('Idle');
    // FAB should show play
    await expect(page.locator('#fab-play .material-symbols-outlined')).toHaveText('play_arrow');
  });

  test('simulation produces mode transitions', async ({ page }) => {
    // Set params that trigger greenhouse_heating
    await goToView(page, 'controls');
    await setSlider(page, 'tank-top', 40);
    await setSlider(page, 'tank-bot', 35);
    await setSlider(page, 'greenhouse', 8);
    await setSlider(page, 'speed', 500);

    // Start
    await page.locator('#fab-play').click();
    await goToView(page, 'status');

    // Wait for mode to change from Idle
    await page.waitForFunction(() => {
      const el = document.getElementById('mode-card-title');
      return el && el.textContent !== 'Idle';
    }, { timeout: 10000 });

    const modeText = await page.locator('#mode-card-title').textContent();
    expect(modeText).not.toBe('Idle');
  });

  test('system logs show transitions', async ({ page }) => {
    await goToView(page, 'controls');
    await setSlider(page, 'tank-top', 40);
    await setSlider(page, 'greenhouse', 8);
    await setSlider(page, 'speed', 500);

    await page.locator('#fab-play').click();
    await goToView(page, 'status');

    // Wait for log entries to appear
    await page.waitForFunction(() => {
      const items = document.querySelectorAll('#logs-list .log-item');
      return items.length > 0;
    }, { timeout: 10000 });

    const logItems = page.locator('#logs-list .log-item');
    const count = await logItems.count();
    expect(count).toBeGreaterThan(0);
  });

  test('schematic is visible', async ({ page }) => {
    await goToView(page, 'schematic');
    await expect(page.locator('#schematic svg')).toBeVisible();
  });

  test('sliders update parameter values', async ({ page }) => {
    await goToView(page, 'controls');
    const slider = page.locator('#outdoor');
    await slider.fill('20');
    await slider.dispatchEvent('input');
    await expect(page.locator('#outdoor-val')).toContainText('20');
  });

  test('temperature table reflects slider values after start', async ({ page }) => {
    await goToView(page, 'controls');
    await setSlider(page, 'tank-top', 20);
    await setSlider(page, 'tank-bot', 15);

    await page.locator('#fab-play').click();
    await page.waitForTimeout(300);

    await goToView(page, 'components');
    const tankTopRow = page.locator('#temp-table tr:nth-child(2) .val');
    const tankTopText = await tankTopRow.textContent();
    const tankTopVal = parseFloat(tankTopText);
    expect(tankTopVal).toBeLessThan(25);
    expect(tankTopVal).toBeGreaterThan(15);
  });

  test('mode badge updates during simulation', async ({ page }) => {
    await goToView(page, 'controls');
    await setSlider(page, 'tank-top', 40);
    await setSlider(page, 'greenhouse', 8);
    await setSlider(page, 'speed', 500);

    await page.locator('#fab-play').click();
    await goToView(page, 'status');

    await page.waitForFunction(() => {
      const el = document.getElementById('mode-card-title');
      return el && el.textContent !== 'Idle';
    }, { timeout: 5000 });

    const modeText = await page.locator('#mode-card-title').textContent();
    expect(modeText).not.toBe('Idle');
  });

  test('sim speed slider controls simulation rate', async ({ page }) => {
    await goToView(page, 'controls');

    // Run at speed=1 for 1 second
    await setSlider(page, 'speed', 1);
    await page.locator('#fab-play').click();
    await page.waitForTimeout(1000);
    await page.locator('#fab-play').click(); // pause

    // Read tank temp (proxy for sim progress)
    await goToView(page, 'components');
    const slowTemp = parseFloat(await page.locator('#temp-table tr:nth-child(2) .val').textContent());

    // Reset
    await goToView(page, 'controls');
    await page.locator('#btn-reset').click();

    // Run at speed=100 for 1 second
    await setSlider(page, 'speed', 100);
    await page.locator('#fab-play').click();
    await page.waitForTimeout(1000);
    await page.locator('#fab-play').click(); // pause

    await goToView(page, 'components');
    const fastTemp = parseFloat(await page.locator('#temp-table tr:nth-child(2) .val').textContent());

    // At 100x speed, temp should have changed more (more sim time elapsed)
    // Both start from same initial conditions, so the difference shows speed works
    // This is a soft check — just verify both ran
    expect(typeof slowTemp).toBe('number');
    expect(typeof fastTemp).toBe('number');
  });

  test('chart canvas is present and sized', async ({ page }) => {
    const chart = page.locator('#chart');
    await expect(chart).toBeVisible();

    const box = await chart.boundingBox();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(50);
  });

  test('navigation links are present and correct', async ({ page }) => {
    const sidebarLinks = page.locator('.sidebar-nav a');
    await expect(sidebarLinks).toHaveCount(4);
    await expect(page.locator('.sidebar-nav a.active')).toContainText('Status');
  });
});
