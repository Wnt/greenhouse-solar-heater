// @ts-check
// Tests for the Settings-view "Forecast engine" toggle wired in
// playground/js/forecast.js (initForecastEngineSetting). The toggle is
// a client-side preference that switches /api/forecast between the
// physics engine and ?engine=ml. API responses are mocked via
// page.route() so the test runs offline against the static server.
import { test, expect } from './fixtures.js';

const NOW = Date.now();

function makeForecast(engine, hoursUntilBackup) {
  const traj = Array.from({ length: 48 }, (_, i) => ({
    ts: new Date(NOW + i * 3600_000).toISOString(), top: 40, bottom: 30, avg: 35,
  }));
  const gh = Array.from({ length: 48 }, (_, i) => ({
    ts: new Date(NOW + i * 3600_000).toISOString(), temp: 12,
  }));
  return {
    generatedAt: new Date(NOW).toISOString(),
    engine,
    weather: [],
    forecast: {
      generatedAt: new Date(NOW).toISOString(),
      horizonHours: 48,
      engine,
      tankTrajectory: traj,
      greenhouseTrajectory: gh,
      modeForecast: [],
      hoursUntilFloor: hoursUntilBackup,
      hoursUntilBackupNeeded: hoursUntilBackup,
      electricKwh: engine === 'ml' ? 2 : 8,
      electricCostEur: engine === 'ml' ? 0.3 : 1.2,
      costBreakdown: [],
      solarChargingHours: 0,
      greenhouseHeatingHours: 0,
      modelConfidence: 'medium',
      notes: [engine === 'ml' ? 'ML engine note.' : 'Physics engine note.'],
    },
  };
}

// Returns { mlRequests } — a live counter of ?engine=ml fetches.
async function scaffold(page) {
  const counter = { mlRequests: 0 };

  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close() { this.readyState = 3; }, send() {},
      };
      setTimeout(() => {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
        }
      }, 50);
      return fake;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  });

  // Single handler for both engines — branch on the query string so the
  // physics glob vs. ml glob ordering can't bite us.
  await page.route('**/api/forecast**', (r) => {
    const isMl = r.request().url().includes('engine=ml');
    if (isMl) counter.mlRequests += 1;
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(isMl ? makeForecast('ml', 20) : makeForecast('physics', 10)),
    });
  });

  await page.route('**/api/watchdog/state', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ pending: null, watchdogs: [], snapshot: { we: {}, wz: {}, wb: {} }, recent: [] }),
  }));
  await page.route('**/api/device-config', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }),
  }));
  await page.route('**/api/history**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ range: '48h', points: [], events: [] }),
  }));
  await page.route('**/api/events**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/push/**', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }));

  return counter;
}

test.describe('Forecast engine toggle', () => {
  test('defaults to the physics engine', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/#settings');
    await page.waitForFunction(() => window.__initComplete === true);

    const checkbox = page.locator('#forecast-engine-ml');
    await expect(checkbox).toBeAttached();
    await expect(checkbox).not.toBeChecked();
    // Card rendered with the physics payload (hoursUntilBackupNeeded 10).
    await expect(page.locator('#forecast-val-hours')).toHaveText('~10 h');
  });

  test('enabling ML persists the preference and re-fetches with engine=ml', async ({ page }) => {
    const counter = await scaffold(page);
    await page.goto('/playground/#settings');
    await page.waitForFunction(() => window.__initComplete === true);

    await page.locator('#forecast-engine-ml').check();

    // Preference persisted.
    await expect.poll(() => page.evaluate(() => localStorage.getItem('forecastEngine')))
      .toBe('ml');
    // A ?engine=ml fetch was issued and the card shows the ML payload.
    await expect.poll(() => counter.mlRequests).toBeGreaterThan(0);
    await expect(page.locator('#forecast-val-hours')).toHaveText('~20 h');
  });

  test('the saved ML preference is used on the next load', async ({ page }) => {
    await scaffold(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('forecastEngine', 'ml'); } catch (_e) { /* ignore */ }
    });
    await page.goto('/playground/#settings');
    await page.waitForFunction(() => window.__initComplete === true);

    await expect(page.locator('#forecast-engine-ml')).toBeChecked();
    await expect(page.locator('#forecast-val-hours')).toHaveText('~20 h');
  });
});
