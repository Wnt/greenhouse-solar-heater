// @ts-check
/**
 * Tests that the System Logs card on the Status view is backed by the live
 * state-events database rather than the in-memory simulation transition log.
 *
 * Regression: in live mode the logs list stayed empty (transitions were only
 * appended during the client-side sim loop). The fix wires the card to a
 * paginated /api/events endpoint and in-memory mode-change detection, and
 * lazy-loads older entries when the user scrolls to the end of the list.
 */
import { test, expect } from './fixtures.js';

/**
 * Install a mock WebSocket that pushes a deterministic live state frame
 * right after the page connects. Stores the fake on window.__mockWs so
 * tests can inject additional frames.
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
        temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
        valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false },
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

function makeEvent(tsMs, from, to) {
  return { ts: tsMs, type: 'mode', id: 'mode', from, to };
}

/**
 * Route /api/events with an in-memory pool of mode-transition rows.
 * Requests are served newest-first honoring `limit` and `before`.
 */
async function mockEventsApi(page, rows) {
  // rows are expected newest-first
  await page.route('**/api/events**', async (route) => {
    const url = new URL(route.request().url());
    const type = url.searchParams.get('type') || 'mode';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 100);
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw ? parseInt(beforeRaw, 10) : null;
    const filtered = rows
      .filter(e => e.type === type)
      .filter(e => before === null || e.ts < before);
    const page_ = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: page_, hasMore }),
    });
  });
}

async function mockHistoryApi(page) {
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ range: '24h', points: [], events: [] }),
  }));
}

test.describe('System Logs card is backed by live state events', () => {
  test('renders the first page of mode transitions from /api/events on load', async ({ page }) => {
    const now = Date.now();
    const rows = [];
    // 15 transitions, alternating idle <-> solar_charging, newest first
    for (let i = 0; i < 15; i++) {
      const from = i % 2 === 0 ? 'idle' : 'solar_charging';
      const to = i % 2 === 0 ? 'solar_charging' : 'idle';
      rows.push(makeEvent(now - i * 60_000, from, to));
    }
    await installMockWs(page);
    await mockHistoryApi(page);
    await mockEventsApi(page, rows);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // First 10 log items (not the 15 we have) should be rendered
    const logItems = page.locator('#logs-list .log-item');
    await expect(logItems).toHaveCount(10, { timeout: 3000 });

    // Newest event (idle -> solar_charging) should render as the first item
    const first = logItems.first();
    await expect(first).toContainText('Collecting Solar Energy');
  });

  test('lazy-loads older transitions when scrolling to the end of the list', async ({ page }) => {
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 25; i++) {
      const from = i % 2 === 0 ? 'idle' : 'solar_charging';
      const to = i % 2 === 0 ? 'solar_charging' : 'idle';
      rows.push(makeEvent(now - i * 60_000, from, to));
    }
    await installMockWs(page);
    await mockHistoryApi(page);
    await mockEventsApi(page, rows);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const logItems = page.locator('#logs-list .log-item');
    await expect(logItems).toHaveCount(10, { timeout: 3000 });

    // Scroll the list container to the bottom to trigger lazy-load
    await page.locator('#logs-list').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    // Now we expect another page of 10 (20 total) to be rendered
    await expect(logItems).toHaveCount(20, { timeout: 3000 });

    // Scroll again — only 5 more remain, hasMore becomes false
    await page.locator('#logs-list').evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(logItems).toHaveCount(25, { timeout: 3000 });
  });

  test('prepends a new log entry when the live mode changes', async ({ page }) => {
    const now = Date.now();
    const rows = [
      makeEvent(now - 60_000, 'idle', 'solar_charging'),
    ];
    await installMockWs(page);
    await mockHistoryApi(page);
    await mockEventsApi(page, rows);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });
    await expect(page.locator('#logs-list .log-item')).toHaveCount(1, { timeout: 3000 });

    // Inject a new live state with a different mode
    await page.evaluate(() => {
      // @ts-ignore
      const ws = window.__mockWs;
      ws.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: {
            mode: 'greenhouse_heating',
            temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
            valves: {}, actuators: { pump: true, fan: true, space_heater: false },
            controls_enabled: true, manual_override: null,
          },
        }),
      });
    });

    // A new item should appear at the top reflecting the new mode
    const items = page.locator('#logs-list .log-item');
    await expect(items).toHaveCount(2, { timeout: 3000 });
    await expect(items.first()).toContainText('Heating Greenhouse');
  });

  test('renders cause chip and sensor snapshot from /api/events', async ({ page }) => {
    const now = Date.now();
    const rows = [
      {
        ts: now - 30_000, type: 'mode', id: 'mode',
        from: 'idle', to: 'solar_charging',
        cause: 'automation',
        sensors: { collector: 62.3, tank_top: 41, tank_bottom: 29.4, greenhouse: 12, outdoor: 8 },
      },
      {
        ts: now - 120_000, type: 'mode', id: 'mode',
        from: 'solar_charging', to: 'idle',
        cause: 'user_shutdown',
        sensors: { collector: 58, tank_top: 52, tank_bottom: 37, greenhouse: 14, outdoor: 9 },
      },
    ];
    await installMockWs(page);
    await mockHistoryApi(page);
    await mockEventsApi(page, rows);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });
    await expect(page.locator('#logs-list .log-item')).toHaveCount(2, { timeout: 3000 });

    const first = page.locator('#logs-list .log-item').first();
    // Cause chip visible
    await expect(first.locator('.log-cause')).toHaveText('Automation');
    // Sensor line captures all five sensors
    await expect(first.locator('.log-sensors')).toContainText('coll 62.3°');
    await expect(first.locator('.log-sensors')).toContainText('tank 41.0°/29.4°');
    await expect(first.locator('.log-sensors')).toContainText('gh 12.0°');
    await expect(first.locator('.log-sensors')).toContainText('out 8.0°');

    const second = page.locator('#logs-list .log-item').nth(1);
    await expect(second.locator('.log-cause')).toHaveText('User shutdown');
  });

  test('carries cause + temps straight through from a live WS mode change', async ({ page }) => {
    const now = Date.now();
    await installMockWs(page);
    await mockHistoryApi(page);
    await mockEventsApi(page, [makeEvent(now - 60_000, 'idle', 'solar_charging')]);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // Fire a new state with explicit cause+temps — simulates a device
    // that reports a forced-mode transition to GREENHOUSE_HEATING.
    await page.evaluate((expiresAt) => {
      // @ts-ignore
      const ws = window.__mockWs;
      ws.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: {
            mode: 'greenhouse_heating',
            cause: 'forced',
            temps: { collector: 20, tank_top: 48, tank_bottom: 32, greenhouse: 7, outdoor: 4 },
            valves: {}, actuators: { pump: true, fan: true, space_heater: false },
            controls_enabled: true, manual_override: { active: true, expiresAt },
          },
        }),
      });
    }, now + 600_000);

    const first = page.locator('#logs-list .log-item').first();
    await expect(first).toContainText('Heating Greenhouse');
    await expect(first.locator('.log-cause')).toHaveText('Forced mode');
    await expect(first.locator('.log-sensors')).toContainText('gh 7.0°');
  });

  test('omits cause chip and sensor line for legacy rows without them', async ({ page }) => {
    const now = Date.now();
    // Simulate a pre-2026-04-20 row: no cause, no sensors.
    const rows = [makeEvent(now - 60_000, 'idle', 'solar_charging')];
    await installMockWs(page);
    await mockHistoryApi(page);
    await mockEventsApi(page, rows);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });
    await expect(page.locator('#logs-list .log-item')).toHaveCount(1, { timeout: 3000 });

    const first = page.locator('#logs-list .log-item').first();
    await expect(first.locator('.log-cause')).toHaveCount(0);
    await expect(first.locator('.log-sensors')).toHaveCount(0);
  });
});
