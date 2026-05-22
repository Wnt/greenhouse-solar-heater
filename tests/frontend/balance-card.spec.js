// @ts-check
//
// Renders the Status-view "Today's balance" card with real history points
// and asserts the user-visible formatting decisions that unit tests can't
// see end-to-end: each stat shows its temperature swing (Δ°C), "Released"
// is a bare magnitude (no double-negative), "Net today" keeps its sign,
// and the destination split caption survives. The card only renders in
// live mode, so we flip phase=live and drive the public fetch path
// directly rather than standing up a WebSocket.

import { test, expect } from './fixtures.js';

test.describe("Today's balance card", () => {
  test('renders both sections with temperature deltas and a signed net', async ({ page }) => {
    const now = Date.now();
    const H = 3600 * 1000;
    const pt = (h, avg) => ({ ts: now - h * H, tank_top: avg + 1, tank_bottom: avg - 1 });
    const ev = (h, to) => ({ ts: now - h * H, type: 'mode', to });
    // Completed night with a heating pulse + idle leakage, then an ongoing
    // solar-charging day with post-peak idle leakage.
    const points = [
      pt(20, 30), pt(18, 28),            // night idle leakage
      pt(17.4, 24), pt(17.1, 22),        // night heating drop
      pt(12, 21), pt(8.1, 20.5),         // night idle leakage to morning
      pt(8, 21), pt(5, 35),              // day solar charging climb
      pt(2, 33), pt(1.5, 32.5), pt(0.05, 32), // day idle leakage (ongoing)
    ];
    const events = [
      ev(21, 'idle'), ev(17.5, 'greenhouse_heating'), ev(17.1, 'idle'),
      ev(8, 'solar_charging'), ev(1.5, 'idle'),
    ];

    await page.route('**/api/history**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ points, events, spaceHeaterEvents: [] }),
    }));
    await page.route('**/api/events**', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ events: [], hasMore: false }),
    }));

    await page.goto('/playground/#status');
    await page.waitForFunction(() => window.__initComplete === true);

    await page.evaluate(async () => {
      const st = await import('/playground/js/app-state.js');
      st.store.set('phase', 'live');
      const bc = await import('/playground/js/main/balance-card.js');
      bc.fetchBalanceHistory();
    });

    await expect(page.locator('#balance-card')).toBeVisible({ timeout: 5000 });

    const nightHtml = await page.locator('#balance-night-stats').evaluate(el => el.innerHTML);
    expect(nightHtml).toMatch(/Released/);
    expect(nightHtml).toMatch(/Δ\d+°C/);                    // temperature swing shown
    expect(nightHtml).toMatch(/to greenhouse/);             // split caption
    expect(nightHtml).toMatch(/to air/);
    expect(nightHtml).not.toMatch(/balance-stat-value">−/); // no double-negative

    const dayHtml = await page.locator('#balance-day-stats').evaluate(el => el.innerHTML);
    expect(dayHtml).toMatch(/Gathered/);
    expect(dayHtml).toMatch(/Net today/);
    expect(dayHtml).toMatch(/Δ\d+°C/);                      // gathered/released swing
    expect(dayHtml).toMatch(/Net today<\/span><div><span class="balance-stat-value positive">\+/); // signed net
    expect(dayHtml).toMatch(/Δ\+\d+°C/);                    // signed net swing
  });
});
