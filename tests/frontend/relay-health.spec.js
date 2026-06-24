// @ts-check
/**
 * Relay-health sidecar consumer (Epic #254).
 *
 * The server emits an additive `relay_health` WS frame alongside the
 * byte-identical `state` frame. When a relay's native Shelly status is
 * stale/missing, the assembled valves/actuators carry a fallback value;
 * the frontend must mark those as not-trusted (dim + "?" badge) instead
 * of rendering a confident OPEN/CLOSED/ON/OFF. Fresh relays render exactly
 * as today (no visual change).
 */
import { test, expect } from './fixtures.js';

/**
 * Mock WebSocket that pushes a deterministic `state` frame and, optionally,
 * a following `relay_health` sidecar frame. Exposes the fake on
 * window.__mockWs so tests can inject more frames mid-test.
 */
async function installMockWs(page, opts) {
  await page.addInitScript((o) => {
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
      setTimeout(function () {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({ type: 'state', data: stateData }) });
          if (o && o.relays) {
            fake.onmessage({ data: JSON.stringify({ type: 'relay_health', data: { ts: Date.now(), relays: o.relays } }) });
          }
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  }, opts || {});
}

async function mockHistoryApi(page) {
  const body = JSON.stringify({ range: '24h', points: [], events: [] });
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body,
  }));
}

test.describe('relay_health sidecar', () => {
  test('no relay_health frame → grids render exactly as today (no stale markers)', async ({ page }) => {
    await installMockWs(page); // no relays — sidecar absent
    await mockHistoryApi(page);
    await page.goto('/playground/#components', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // valves/actuators rendered
    await expect(page.locator('#valve-grid .valve-chip')).toHaveCount(7);
    await expect(page.locator('#actuator-grid .component-card')).toHaveCount(3);
    // nothing flagged stale, no badges
    await expect(page.locator('#valve-grid .relay-stale')).toHaveCount(0);
    await expect(page.locator('#actuator-grid .relay-stale')).toHaveCount(0);
    await expect(page.locator('.relay-stale-badge')).toHaveCount(0);
  });

  test('stale/missing relays are dimmed + badged; fresh relays are not', async ({ page }) => {
    await installMockWs(page, {
      relays: {
        // valves
        vi_btm: { status: 'stale', ageMs: 90000 },
        vi_top: { status: 'fresh', ageMs: 1200 },
        vi_coll: { status: 'fresh', ageMs: 1200 },
        vo_coll: { status: 'missing', ageMs: null },
        vo_rad: { status: 'fresh', ageMs: 1200 },
        vo_tank: { status: 'fresh', ageMs: 1200 },
        v_air: { status: 'fresh', ageMs: 1200 },
        // actuators
        pump: { status: 'stale', ageMs: 90000 },
        fan: { status: 'fresh', ageMs: 1200 },
        space_heater: { status: 'fresh', ageMs: 1200 },
      },
    });
    await mockHistoryApi(page);
    await page.goto('/playground/#components', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The stale valve (vi_btm) and missing valve (vo_coll) get the marker.
    await expect(page.locator('#valve-grid .valve-chip[data-relay="vi_btm"]')).toHaveClass(/relay-stale/, { timeout: 3000 });
    await expect(page.locator('#valve-grid .valve-chip[data-relay="vo_coll"]')).toHaveClass(/relay-stale/);
    await expect(page.locator('#valve-grid .valve-chip[data-relay="vi_btm"] .relay-stale-badge')).toHaveCount(1);

    // A fresh valve renders exactly as before — no stale class, no badge,
    // and its real OPEN/CLOSED state is preserved.
    const freshColl = page.locator('#valve-grid .valve-chip[data-relay="vo_rad"]');
    await expect(freshColl).not.toHaveClass(/relay-stale/);
    await expect(freshColl.locator('.relay-stale-badge')).toHaveCount(0);

    // Stale actuator (pump) flagged; fresh actuator (fan) not.
    await expect(page.locator('#actuator-grid .component-card[data-relay="pump"]')).toHaveClass(/relay-stale/);
    await expect(page.locator('#actuator-grid .component-card[data-relay="pump"] .relay-stale-badge')).toHaveCount(1);
    await expect(page.locator('#actuator-grid .component-card[data-relay="fan"]')).not.toHaveClass(/relay-stale/);

    // Exactly the two stale/missing valves + one stale actuator are flagged.
    await expect(page.locator('#valve-grid .relay-stale')).toHaveCount(2);
    await expect(page.locator('#actuator-grid .relay-stale')).toHaveCount(1);
  });

  test('a later relay_health frame repaints the markers without a new state frame', async ({ page }) => {
    // First sidecar: pump stale. Then push a fresh-everything sidecar and
    // assert the pump marker clears — proves the store subscription
    // repaints on its own cadence (no fresh state frame in between).
    await installMockWs(page, {
      relays: {
        vi_btm: { status: 'fresh', ageMs: 1000 }, vi_top: { status: 'fresh', ageMs: 1000 },
        vi_coll: { status: 'fresh', ageMs: 1000 }, vo_coll: { status: 'fresh', ageMs: 1000 },
        vo_rad: { status: 'fresh', ageMs: 1000 }, vo_tank: { status: 'fresh', ageMs: 1000 },
        v_air: { status: 'fresh', ageMs: 1000 },
        pump: { status: 'stale', ageMs: 90000 }, fan: { status: 'fresh', ageMs: 1000 },
        space_heater: { status: 'fresh', ageMs: 1000 },
      },
    });
    await mockHistoryApi(page);
    await page.goto('/playground/#components', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });
    await expect(page.locator('#actuator-grid .component-card[data-relay="pump"]')).toHaveClass(/relay-stale/, { timeout: 3000 });

    // Inject a follow-up relay_health frame: pump now fresh.
    await page.evaluate(() => {
      const allFresh = {};
      ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air', 'pump', 'fan', 'space_heater']
        .forEach((k) => { allFresh[k] = { status: 'fresh', ageMs: 1000 }; });
      // @ts-ignore
      window.__mockWs.onmessage({ data: JSON.stringify({ type: 'relay_health', data: { ts: Date.now(), relays: allFresh } }) });
    });

    await expect(page.locator('#actuator-grid .component-card[data-relay="pump"]')).not.toHaveClass(/relay-stale/, { timeout: 3000 });
    await expect(page.locator('#actuator-grid .relay-stale')).toHaveCount(0);
  });
});
