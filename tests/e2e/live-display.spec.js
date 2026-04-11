// @ts-check
/**
 * Tests that the Schematic view and Status history graph display live
 * values from the controller (not simulation defaults / empty state).
 *
 * Regression: updateSchematic() used to read from model.getState() (the
 * thermal simulation model) instead of the live state parameter, and the
 * history graph only read from timeSeriesStore which was never populated
 * from the /api/history response.
 */
import { test, expect } from './fixtures.js';

/**
 * Install a mock WebSocket that pushes a deterministic live state frame
 * right after the page connects. Stores the fake on window.__mockWs so
 * tests can inject additional frames.
 */
async function installMockWs(page, stateOverrides) {
  await page.addInitScript((overrides) => {
    var OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function () {
      var fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function () { this.readyState = 3; },
        send: function () {},
      };
      // @ts-ignore
      window.__mockWs = fake;
      var stateData = Object.assign({
        mode: 'solar_charging',
        temps: { collector: 62.5, tank_top: 48.2, tank_bottom: 33.9, greenhouse: 21.7, outdoor: 11.4 },
        valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: true, fan: false, space_heater: false },
        controls_enabled: true,
        manual_override: null,
      }, overrides || {});
      setTimeout(function () {
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
  }, stateOverrides);
}

/**
 * Mock /api/history with a deterministic response containing two points so
 * the history graph has data to render and the inspector has samples.
 */
async function mockHistoryApi(page, points) {
  const body = JSON.stringify({
    range: '24h',
    points: points || [
      { ts: Date.now() - 3600_000, collector: 30.0, tank_top: 40.0, tank_bottom: 30.0, greenhouse: 18.0, outdoor: 10.0 },
      { ts: Date.now() - 1800_000, collector: 55.0, tank_top: 44.0, tank_bottom: 31.5, greenhouse: 19.5, outdoor: 10.5 },
      { ts: Date.now() - 60_000,   collector: 62.5, tank_top: 48.2, tank_bottom: 33.9, greenhouse: 21.7, outdoor: 11.4 },
    ],
    events: [
      { ts: Date.now() - 3600_000, type: 'mode', id: 'controller', from: 'idle', to: 'idle' },
      { ts: Date.now() - 1800_000, type: 'mode', id: 'controller', from: 'idle', to: 'solar_charging' },
    ],
  });
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body,
  }));
}

test.describe('Schematic view shows live values', () => {
  test('schematic temperatures come from the live state, not the sim model', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/#schematic', { waitUntil: 'domcontentloaded' });

    // Wait until the live connection has pushed a state frame
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The SVG schematic sensor cells must reflect the live payload,
    // not the default simulation model values. The generated topology
    // SVG renders each sensor label as a drawio foreignObject inside the
    // [data-cell-id="t_…"] cell — toContainText walks descendants.
    await expect(page.locator('[data-cell-id="t_tank_top"]')).toContainText('48.2°C');
    await expect(page.locator('[data-cell-id="t_tank_bottom"]')).toContainText('33.9°C');
    await expect(page.locator('[data-cell-id="t_collector"]')).toContainText('62.5°C');
    await expect(page.locator('[data-cell-id="t_greenhouse"]')).toContainText('21.7°C');
    await expect(page.locator('[data-cell-id="t_outdoor"]')).toContainText('11.4°C');
  });

  test('schematic renders placeholders for unbound (null) sensors', async ({ page }) => {
    await installMockWs(page, {
      temps: { collector: null, tank_top: 42.5, tank_bottom: null, greenhouse: null, outdoor: null },
    });
    await mockHistoryApi(page);
    await page.goto('/playground/#schematic', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // Bound sensor renders as a formatted temperature
    await expect(page.locator('[data-cell-id="t_tank_top"]')).toContainText('42.5°C');
    // Unbound sensors render as "--°C" (placeholder from schematic.js
    // formatTemp) instead of crashing.
    await expect(page.locator('[data-cell-id="t_tank_bottom"]')).toContainText('--°C');
    await expect(page.locator('[data-cell-id="t_collector"]')).toContainText('--°C');
  });
});

test.describe('Status history graph uses live data', () => {
  test('/api/history points populate the graph time-series store', async ({ page }) => {
    const now = Date.now();
    const points = [
      { ts: now - 7200_000, collector: 25.0, tank_top: 38.0, tank_bottom: 30.0, greenhouse: 17.0, outdoor: 9.0 },
      { ts: now - 3600_000, collector: 45.0, tank_top: 42.0, tank_bottom: 32.0, greenhouse: 18.5, outdoor: 10.0 },
      { ts: now - 1800_000, collector: 60.0, tank_top: 46.0, tank_bottom: 33.5, greenhouse: 20.0, outdoor: 11.0 },
    ];
    await installMockWs(page);
    await mockHistoryApi(page, points);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    // Wait until the live connection is up
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The graph should have ingested the history points.  This is tested
    // via a debug hook exposed by the page on window.
    const count = await page.evaluate(() => {
      // @ts-ignore
      return typeof window.__getHistoryPointCount === 'function'
        ? window.__getHistoryPointCount()
        : null;
    });
    expect(count).not.toBeNull();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('graph does not stay empty after switching from simulation to live', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    // Switch to simulation, then back to live
    await page.locator('#mode-toggle-switch').click(); // -> simulation
    await page.locator('#mode-toggle-switch').click(); // -> live
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const count = await page.evaluate(() => {
      // @ts-ignore
      return typeof window.__getHistoryPointCount === 'function'
        ? window.__getHistoryPointCount()
        : null;
    });
    expect(count).not.toBeNull();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Status history graph includes collector temperature', () => {
  test('legend has a Collector entry', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The graph legend must include a Collector entry alongside Tank/In/Out.
    await expect(page.locator('.graph-legend')).toContainText('Collector');
  });

  test('inspector row reflects collector temperature from history sample', async ({ page }) => {
    const now = Date.now();
    const points = [
      { ts: now - 7200_000, collector: 25.0, tank_top: 38.0, tank_bottom: 30.0, greenhouse: 17.0, outdoor: 9.0 },
      { ts: now - 3600_000, collector: 45.0, tank_top: 42.0, tank_bottom: 32.0, greenhouse: 18.5, outdoor: 10.0 },
      { ts: now - 1800_000, collector: 60.0, tank_top: 46.0, tank_bottom: 33.5, greenhouse: 20.0, outdoor: 11.0 },
    ];
    await installMockWs(page);
    await mockHistoryApi(page, points);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The inspector must have a collector row that updates on hover.
    const inspectorColl = page.locator('#inspector-coll');
    await expect(inspectorColl).toHaveCount(1);

    // Hover the middle of the canvas to surface the inspector.
    const canvas = page.locator('#chart');
    await canvas.hover({ position: { x: 200, y: 100 } });

    // The collector row must render a temperature in °C (not empty).
    await expect(inspectorColl).toHaveText(/\d+\.\d°C/);
  });
});

test.describe('Live mode is the default data source', () => {
  test('app starts in live mode on localhost (simulation is secondary)', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    // Mode label reads "Live" immediately on startup
    await expect(page.locator('#mode-toggle-label')).toHaveText('Live');
    // The FAB (simulation play button) is hidden in live mode
    await expect(page.locator('#fab-play')).not.toBeVisible();
  });
});
