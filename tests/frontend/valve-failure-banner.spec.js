// @ts-check
/**
 * Loud valve-failure warning banner.
 *
 * Field incident 2026-07-28: Valve Control 1 flapped WiFi, every Greenhouse
 * Heating entry died with cause="failed" — yet the Status view read
 * "Greenhouse cold — heating" with a calm STABLE gauge, so the failure was
 * invisible at first glance. The device now retries for 5 minutes before
 * bailing (VALVE_RETRY), and when it does bail the UI must shout: a global
 * banner (visible on every view, like the script-crash banner) appears while
 * the latest snapshot carries cause="failed" and disappears as soon as a
 * transition succeeds.
 */
import { test, expect } from './fixtures.js';

/**
 * Mock WebSocket that pushes an initial live state frame after connect and
 * exposes the fake on window.__mockWs so tests can inject further frames.
 */
async function installMockWs(page, stateOverrides) {
  await page.addInitScript((overrides) => {
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
      const stateData = Object.assign({
        mode: 'idle',
        temps: { collector: 12, tank_top: 40, tank_bottom: 35, greenhouse: 8, outdoor: 5 },
        valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false },
        controls_enabled: true,
        manual_override: null,
        transitioning: false,
        cause: 'automation',
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

function injectState(page, data) {
  return page.evaluate((d) => {
    // @ts-ignore
    const ws = window.__mockWs;
    ws.onmessage({ data: JSON.stringify({ type: 'state', data: Object.assign({
      mode: 'idle',
      temps: { collector: 12, tank_top: 40, tank_bottom: 35, greenhouse: 8, outdoor: 5 },
      valves: {}, actuators: {}, controls_enabled: true, manual_override: null,
      transitioning: false,
    }, d) }) });
  }, data);
}

async function mockApis(page) {
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ range: '24h', points: [], events: [] }),
  }));
  await page.route('**/api/events**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ events: [], hasMore: false }),
  }));
}

test.describe('valve-failure banner', () => {
  test('appears when the live state carries cause=failed and names the blocked mode', async ({ page }) => {
    await installMockWs(page, { cause: 'failed', eval_reason: 'greenhouse_enter' });
    await mockApis(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const banner = page.locator('#valve-failure-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Valve command failed');
    await expect(banner).toContainText('Greenhouse Heating');
  });

  test('is hidden in normal operation and toggles with the failed cause', async ({ page }) => {
    await installMockWs(page, { cause: 'automation' });
    await mockApis(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const banner = page.locator('#valve-failure-banner');
    await expect(banner).toBeHidden();

    // Retry window exhausts → device publishes the failed snapshot.
    await injectState(page, { cause: 'failed', eval_reason: 'greenhouse_enter' });
    await expect(banner).toBeVisible();

    // A later successful transition clears the failed cause → banner goes away.
    await injectState(page, { mode: 'greenhouse_heating', cause: 'automation' });
    await expect(banner).toBeHidden();
  });

  test('stays visible on other views (global, like the script-crash banner)', async ({ page }) => {
    await installMockWs(page, { cause: 'failed', eval_reason: 'greenhouse_enter' });
    await mockApis(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    await page.evaluate(() => { window.location.hash = 'device'; });
    await expect(page.locator('#view-device')).toHaveClass(/active/);
    await expect(page.locator('#valve-failure-banner')).toBeVisible();
  });
});
