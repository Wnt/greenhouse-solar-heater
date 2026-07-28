// @ts-check
/**
 * Loud stale-data warning when the controller goes silent.
 *
 * 2026-07-28 incident: the controller stopped publishing entirely (boot
 * blocked on an unreachable valve host), yet the Status view showed a green
 * "Live" dot and a calm mode card built from stale data — the failure was
 * invisible at first glance. Two gaps conspired:
 *   1. Staleness was measured from frame ARRIVAL time, so the retained
 *      last-known state the server replays to a freshly connected client
 *      counted as "fresh" and bought a silent controller 60 s of green UI
 *      on every app open.
 *   2. The periodic resync reset the staleness clock, renewing that grace.
 *
 * Fix under test: staleness is anchored to the state payload's own device
 * timestamp (`ts`). A payload older than 5 minutes flips the Status view
 * into a LOUD variant of the staleness banner (with the data age spelled
 * out) and the connection indicator to "Stale" immediately — no grace, no
 * suppression.
 */
import { test, expect } from './fixtures.js';

function installMockWs(page, tsAgeMs) {
  return page.addInitScript((ageMs) => {
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
        ts: Date.now() - ageMs,
        mode: 'idle',
        temps: { collector: 12, tank_top: 40, tank_bottom: 35, greenhouse: 8, outdoor: 5 },
        valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false },
        controls_enabled: true,
        manual_override: null,
        transitioning: false,
        cause: 'automation',
      };
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
  }, tsAgeMs);
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

test.describe('controller-silence staleness banner', () => {
  test('an hour-old replayed state trips the loud banner immediately on open', async ({ page }) => {
    await installMockWs(page, 60 * 60 * 1000); // payload ts is 1 h old
    await mockApis(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    const banner = page.locator('#staleness-banner');
    await expect(banner).toBeVisible({ timeout: 8000 });
    await expect(banner).toHaveClass(/staleness-banner--long/);
    // The age is spelled out so the operator sees how long they've been blind.
    await expect(banner).toContainText(/No data from the controller for \d+ min/);
    // Connection indicator must not claim "Live".
    await expect(page.locator('#connection-label')).toHaveText('Stale');
  });

  test('a fresh state keeps the banner hidden and the indicator Live', async ({ page }) => {
    await installMockWs(page, 0);
    await mockApis(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-label')).toHaveText('Live', { timeout: 8000 });
    await expect(page.locator('#staleness-banner')).toBeHidden();
  });

  test('a fresh frame clears the loud banner', async ({ page }) => {
    await installMockWs(page, 60 * 60 * 1000);
    await mockApis(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#staleness-banner')).toBeVisible({ timeout: 8000 });

    // Controller comes back: a payload with a current ts arrives.
    await page.evaluate(() => {
      // @ts-ignore
      const ws = window.__mockWs;
      ws.onmessage({ data: JSON.stringify({ type: 'state', data: {
        ts: Date.now(),
        mode: 'idle',
        temps: { collector: 12, tank_top: 40, tank_bottom: 35, greenhouse: 8, outdoor: 5 },
        valves: {}, actuators: {}, controls_enabled: true, manual_override: null,
        transitioning: false, cause: 'automation',
      } }) });
    });
    await expect(page.locator('#staleness-banner')).toBeHidden({ timeout: 8000 });
    await expect(page.locator('#connection-label')).toHaveText('Live');
  });
});
