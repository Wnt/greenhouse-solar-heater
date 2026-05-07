// @ts-check
/**
 * Tests for clickable legend labels on the Status history graph.
 *
 * Each .graph-legend-item carries a data-series id; clicking it toggles
 * the matching series in the hiddenSeries set (state.js), updates
 * aria-pressed on the row, and triggers a redraw that skips that
 * series' bars/lines.
 */
import { test, expect } from './fixtures.js';

async function installMockWs(page) {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function () { this.readyState = 3; },
        send: function () {},
      };
      // @ts-ignore
      window.__mockWs = fake;
      const stateData = {
        mode: 'solar_charging',
        temps: { collector: 62.5, tank_top: 48.2, tank_bottom: 33.9, greenhouse: 21.7, outdoor: 11.4 },
        valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: true, fan: false, space_heater: false },
        controls_enabled: true,
        manual_override: null,
      };
      setTimeout(() => {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({ type: 'state', data: stateData }) });
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  });
}

async function mockHistoryApi(page) {
  const now = Date.now();
  const body = JSON.stringify({
    range: '24h',
    points: [
      { ts: now - 7200_000, collector: 25.0, tank_top: 52.0, tank_bottom: 34.0, greenhouse: 17.0, outdoor: 9.0 },
      { ts: now - 3600_000, collector: 45.0, tank_top: 58.0, tank_bottom: 36.0, greenhouse: 18.5, outdoor: 10.0 },
      { ts: now - 1800_000, collector: 60.0, tank_top: 62.0, tank_bottom: 38.0, greenhouse: 20.0, outdoor: 11.0 },
    ],
    events: [
      { ts: now - 7200_000, type: 'mode', id: 'controller', from: 'idle', to: 'idle' },
      { ts: now - 3600_000, type: 'mode', id: 'controller', from: 'idle', to: 'solar_charging' },
    ],
  });
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body,
  }));
}

test.describe('Chart legend toggles', () => {
  test('clicking a legend label toggles aria-pressed and applies inactive style', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const collector = page.locator('.graph-legend-item[data-series="t_collector"]');
    await expect(collector).toHaveAttribute('aria-pressed', 'false');

    // Visible by default — line-through only applies when pressed.
    await expect(collector).toHaveCSS('text-decoration-line', 'none');

    await collector.click();
    await expect(collector).toHaveAttribute('aria-pressed', 'true');
    await expect(collector).toHaveCSS('text-decoration-line', 'line-through');

    // Click again restores it.
    await collector.click();
    await expect(collector).toHaveAttribute('aria-pressed', 'false');
    await expect(collector).toHaveCSS('text-decoration-line', 'none');
  });

  test('Enter and Space toggle a legend label from the keyboard', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const tank = page.locator('.graph-legend-item[data-series="tank"]');
    await tank.focus();

    await page.keyboard.press('Enter');
    await expect(tank).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('Space');
    await expect(tank).toHaveAttribute('aria-pressed', 'false');
  });

  test('every clickable legend row has role=button + tabindex for a11y', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    const items = page.locator('.graph-legend-item[data-series]');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(7);
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      await expect(item).toHaveAttribute('role', 'button');
      await expect(item).toHaveAttribute('tabindex', '0');
      await expect(item).toHaveAttribute('aria-pressed', /^(true|false)$/);
    }
  });

  test('hiding the Charging bar visibly changes the rendered chart', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // Wait for at least the seeded history to be drawn.
    await expect.poll(() => page.evaluate(() => {
      // @ts-ignore
      return typeof window.__getHistoryPointCount === 'function'
        ? window.__getHistoryPointCount()
        : null;
    }), { timeout: 5000 }).toBeGreaterThanOrEqual(3);

    const before = await page.locator('#chart').screenshot();

    await page.locator('.graph-legend-item[data-series="charging"]').click();
    await expect(page.locator('.graph-legend-item[data-series="charging"]'))
      .toHaveAttribute('aria-pressed', 'true');

    const after = await page.locator('#chart').screenshot();
    expect(Buffer.compare(before, after)).not.toBe(0);
  });
});
