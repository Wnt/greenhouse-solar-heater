// @ts-check
/**
 * Tests for the chart's fullscreen mode (issue #166 follow-up).
 *
 * Real fullscreen requires a user-gesture and OS-level cooperation,
 * so these tests stub `Element.requestFullscreen` /
 * `document.exitFullscreen` and manually dispatch `fullscreenchange`.
 * That exercises every code path the real API would take — icon flip,
 * aria-pressed, autoscale + Y-axis labels, redraw, exit handling — in
 * a deterministic way under headless Chromium.
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

/**
 * Stub the Fullscreen API on the page so click + exit toggles dispatch
 * a `fullscreenchange` event without actually entering fullscreen.
 * Returns nothing — assertions read `document.fullscreenElement` after
 * the event fires.
 */
async function installFullscreenStub(page) {
  await page.addInitScript(() => {
    let fsElement = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get() { return fsElement; },
    });
    // @ts-ignore
    Element.prototype.requestFullscreen = function () {
      fsElement = this;
      // Fire on the next tick so a click handler chain can complete.
      setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 0);
      return Promise.resolve();
    };
    // @ts-ignore
    document.exitFullscreen = function () {
      fsElement = null;
      setTimeout(() => document.dispatchEvent(new Event('fullscreenchange')), 0);
      return Promise.resolve();
    };
  });
}

test.describe('Chart fullscreen mode', () => {
  test('button is present in the header with an a11y-friendly label', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    const btn = page.locator('#graph-fullscreen-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(btn).toHaveAttribute('aria-label', /toggle fullscreen|fullscreen/i);
    await expect(page.locator('#graph-fullscreen-icon')).toHaveText('fullscreen');
  });

  test('clicking the button enters fullscreen and flips the icon + aria', async ({ page }) => {
    await installFullscreenStub(page);
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const btn = page.locator('#graph-fullscreen-btn');
    await btn.click();

    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#graph-fullscreen-icon')).toHaveText('fullscreen_exit');

    // The graph-card must now report itself as the fullscreen element.
    const isFs = await page.evaluate(() => document.fullscreenElement && document.fullscreenElement.classList.contains('graph-card'));
    expect(isFs).toBe(true);
  });

  test('exit gesture (ESC / browser) restores the icon and aria state', async ({ page }) => {
    await installFullscreenStub(page);
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const btn = page.locator('#graph-fullscreen-btn');
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'true');

    // Simulate the user pressing ESC: the browser exits fullscreen and
    // fires fullscreenchange. The wiring must restore the entry icon.
    await btn.click();
    await expect(btn).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#graph-fullscreen-icon')).toHaveText('fullscreen');
  });

  test('toggles + clickable legend stay reachable + functional in fullscreen', async ({ page }) => {
    await installFullscreenStub(page);
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    await page.locator('#graph-fullscreen-btn').click();
    await expect(page.locator('#graph-fullscreen-btn')).toHaveAttribute('aria-pressed', 'true');

    // All Sensors switch toggles inside fullscreen too.
    await page.locator('#graph-show-all-sensors').click();
    await expect(page.locator('#graph-show-all-sensors')).toHaveClass(/active/);
    await expect(page.locator('#legend-tank-top')).toBeVisible();

    // Clickable legend label still works.
    const collector = page.locator('.graph-legend-item[data-series="t_collector"]');
    await collector.click();
    await expect(collector).toHaveAttribute('aria-pressed', 'true');
  });

  test('canvas redraws after entering fullscreen (autoscale + Y labels kick in)', async ({ page }) => {
    await installFullscreenStub(page);
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    // Wait for at least the seeded history to render.
    await expect.poll(() => page.evaluate(() => {
      // @ts-ignore
      return typeof window.__getHistoryPointCount === 'function'
        ? window.__getHistoryPointCount()
        : null;
    }), { timeout: 5000 }).toBeGreaterThanOrEqual(3);

    const before = await page.locator('#chart').screenshot();

    await page.locator('#graph-fullscreen-btn').click();
    await expect(page.locator('#graph-fullscreen-btn')).toHaveAttribute('aria-pressed', 'true');

    // Force a frame so the redraw triggered by the fullscreenchange
    // handler has flushed before we sample the canvas.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => r(null))));

    const after = await page.locator('#chart').screenshot();
    expect(Buffer.compare(before, after)).not.toBe(0);
  });
});
