import { test, expect } from './fixtures.js';

test.describe('schematic tester', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/schematic-tester.html');
    // Wait for the SVG to be inlined
    await page.locator('#schematic-container svg').waitFor();
  });

  test('loads with idle preset — nothing active', async ({ page }) => {
    // All valves that have a visual cell should be data-active="false"
    // (v_air is in VALVE_IDS but has no SVG cell — skip it)
    for (const vid of ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'false');
    }
    await expect(
      page.locator('[data-cell-id="pump"]')
    ).toHaveAttribute('data-active', 'false');
  });

  test('solar charging preset lights collector loop + passive coll-top pipe', async ({ page }) => {
    await page.getByRole('button', { name: 'Solar charging' }).click();

    // Valves that should be open
    for (const vid of ['vi_btm', 'vo_coll']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    // Valves that should be closed (v_air excluded — no SVG cell)
    for (const vid of ['vi_top', 'vi_coll', 'vo_rad', 'vo_tank']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'false');
    }
    // Pipes that should be active
    for (const pid of [
      'pipe_tank_vibtm',
      'pipe_vibtm_pump',
      'pipe_pump_vocoll',
      'pipe_vocoll_collbtm',
      'pipe_coll_top_reservoir',
      'pipe_dip_reservoir',
    ]) {
      await expect(
        page.locator(`[data-cell-id="${pid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    // Pipes that must NOT be active in this mode
    for (const pid of ['pipe_pump_vorad', 'pipe_pump_votank']) {
      await expect(
        page.locator(`[data-cell-id="${pid}"]`)
      ).toHaveAttribute('data-active', 'false');
    }
    // Pump is on
    await expect(
      page.locator('[data-cell-id="pump"]')
    ).toHaveAttribute('data-active', 'true');
  });

  test('greenhouse heating preset lights radiator loop', async ({ page }) => {
    await page.getByRole('button', { name: 'Greenhouse heating' }).click();

    for (const vid of ['vi_top', 'vo_rad']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    for (const pid of ['pipe_pump_vorad', 'pipe_vorad_radiator', 'pipe_rad_return', 'pipe_dip_reservoir']) {
      await expect(
        page.locator(`[data-cell-id="${pid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    // collector-top pipe must NOT be active (vi_coll / vo_coll are both closed)
    await expect(
      page.locator('[data-cell-id="pipe_coll_top_reservoir"]')
    ).toHaveAttribute('data-active', 'false');
  });

  test('active drain preset lights drain path', async ({ page }) => {
    await page.getByRole('button', { name: 'Active drain' }).click();

    // v_air is true in the preset but has no SVG cell — don't assert on it
    for (const vid of ['vi_coll', 'vo_tank']) {
      await expect(
        page.locator(`[data-cell-id="${vid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
    for (const pid of ['pipe_collbtm_vicoll', 'pipe_vicoll_pump', 'pipe_pump_votank', 'pipe_votank_tank']) {
      await expect(
        page.locator(`[data-cell-id="${pid}"]`)
      ).toHaveAttribute('data-active', 'true');
    }
  });

  test('toggling a valve checkbox updates the schematic', async ({ page }) => {
    // Start from idle (nothing active)
    await page.getByRole('button', { name: 'Idle' }).click();

    // Toggle vi_btm on — but pipe should NOT light (pump still off)
    await page.locator('[data-valve="vi_btm"]').check();
    await expect(
      page.locator('[data-cell-id="vi_btm"]')
    ).toHaveAttribute('data-active', 'true');
    await expect(
      page.locator('[data-cell-id="pipe_tank_vibtm"]')
    ).toHaveAttribute('data-active', 'false');

    // Now turn the pump on — pipe lights
    await page.locator('[data-actuator="pump"]').check();
    await expect(
      page.locator('[data-cell-id="pipe_tank_vibtm"]')
    ).toHaveAttribute('data-active', 'true');
  });
});
