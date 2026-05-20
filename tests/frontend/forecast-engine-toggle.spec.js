// @ts-check
// Tests for the forecast-engine selectors. The engine choice (ML vs.
// physics) is a client-side preference exposed from two switches that
// stay in sync via playground/js/forecast.js:
//   - the Status-graph 3-way switch  (Off / ML / Physics)
//   - the device-view Forecast-preview 2-way switch  (ML / Physics)
// API responses are mocked via page.route() so the test runs offline
// against the static server.
import { test, expect } from './fixtures.js';

const NOW = Date.now();

function makeForecast(engine, hoursUntilBackup, modelStale) {
  const traj = Array.from({ length: 48 }, (_, i) => ({
    ts: new Date(NOW + i * 3600_000).toISOString(), top: 40, bottom: 30, avg: 35,
  }));
  const gh = Array.from({ length: 48 }, (_, i) => ({
    ts: new Date(NOW + i * 3600_000).toISOString(), temp: 12,
  }));
  return {
    generatedAt: new Date(NOW).toISOString(),
    engine,
    modelStale: !!modelStale,
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
// opts.mlStale makes the mocked ML response report a stale model.
async function scaffold(page, opts) {
  const o = opts || {};
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
      body: JSON.stringify(isMl ? makeForecast('ml', 20, o.mlStale) : makeForecast('physics', 10)),
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

async function bootStatus(page) {
  await page.goto('/playground/');
  await page.waitForFunction(() => window.__initComplete === true);
}

async function gotoDevice(page) {
  await page.locator('.sidebar-nav [data-view="device"]').click();
  await expect(page.locator('#device-config-form')).toBeVisible();
}

const engineKey = () => 'forecastEngine';

test.describe('Status-graph forecast switch (Off / ML / Physics)', () => {
  test('defaults to Off — the overlay is not shown', async ({ page }) => {
    await scaffold(page);
    await bootStatus(page);

    await expect(page.locator('#graph-forecast-off')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#graph-forecast-ml')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#graph-forecast-physics')).toHaveAttribute('aria-checked', 'false');
  });

  test('selecting ML turns the overlay on with the ML engine', async ({ page }) => {
    await scaffold(page);
    await bootStatus(page);

    await page.locator('#graph-forecast-ml').click();

    await expect(page.locator('#graph-forecast-ml')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#graph-forecast-off')).toHaveAttribute('aria-checked', 'false');
    // ML headline numbers (hoursUntilBackupNeeded 20) and the forecast
    // legend revealed by the overlay.
    await expect(page.locator('#forecast-val-hours')).toHaveText('~20 h');
    await expect(page.locator('.forecast-legend').first()).toBeVisible();
  });

  test('selecting Physics switches the engine and persists the preference', async ({ page }) => {
    await scaffold(page);
    await bootStatus(page);

    await page.locator('#graph-forecast-physics').click();

    await expect(page.locator('#graph-forecast-physics')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), engineKey()))
      .toBe('physics');
    // The card re-fetched with the physics payload (hoursUntilBackupNeeded 10).
    await expect(page.locator('#forecast-val-hours')).toHaveText('~10 h');
  });

  test('selecting Off hides the overlay again', async ({ page }) => {
    await scaffold(page);
    await bootStatus(page);

    await page.locator('#graph-forecast-ml').click();
    await expect(page.locator('#graph-forecast-ml')).toHaveAttribute('aria-checked', 'true');

    await page.locator('#graph-forecast-off').click();
    await expect(page.locator('#graph-forecast-off')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.forecast-legend').first()).toBeHidden();
  });

  test('keyboard arrows move the selection', async ({ page }) => {
    await scaffold(page);
    await bootStatus(page);

    await page.locator('#graph-forecast-off').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#graph-forecast-ml')).toHaveAttribute('aria-checked', 'true');

    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('#graph-forecast-off')).toHaveAttribute('aria-checked', 'true');
  });

  test('shows a staleness warning when the ML model is stale', async ({ page }) => {
    await scaffold(page, { mlStale: true });
    await bootStatus(page);

    // ML is the default engine, so the card fetches the stale ML payload
    // on load even before the overlay is turned on.
    await expect(page.locator('#forecast-notes')).toContainText('stale');
  });
});

test.describe('Device-view Forecast-preview engine switch (ML / Physics)', () => {
  test('defaults to ML and switches the engine, persisting the preference', async ({ page }) => {
    await scaffold(page);
    await bootStatus(page);
    await gotoDevice(page);

    await expect(page.locator('#tuning-forecast-ml')).toHaveAttribute('aria-checked', 'true');

    await page.locator('#tuning-forecast-physics').click();

    await expect(page.locator('#tuning-forecast-physics')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#tuning-forecast-ml')).toHaveAttribute('aria-checked', 'false');
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), engineKey()))
      .toBe('physics');
  });

  test('a saved physics preference is honoured on the next load', async ({ page }) => {
    await scaffold(page);
    await page.addInitScript(() => {
      try { localStorage.setItem('forecastEngine', 'physics'); } catch (_e) { /* ignore */ }
    });
    await bootStatus(page);

    // The card fetched the physics payload on load.
    await expect(page.locator('#forecast-val-hours')).toHaveText('~10 h');

    await gotoDevice(page);
    await expect(page.locator('#tuning-forecast-physics')).toHaveAttribute('aria-checked', 'true');
  });
});

test.describe('The two engine switches stay in sync', () => {
  test('a device-view engine change is reflected on the status switch', async ({ page }) => {
    await scaffold(page);
    await bootStatus(page);

    // Turn the status overlay on (ML), then switch to physics from the
    // device view.
    await page.locator('#graph-forecast-ml').click();
    await expect(page.locator('#graph-forecast-ml')).toHaveAttribute('aria-checked', 'true');

    await gotoDevice(page);
    await page.locator('#tuning-forecast-physics').click();

    await expect(page.locator('#graph-forecast-physics')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#graph-forecast-ml')).toHaveAttribute('aria-checked', 'false');
  });

  test('a status-switch engine change is reflected on the device switch', async ({ page }) => {
    await scaffold(page);
    await bootStatus(page);

    await page.locator('#graph-forecast-physics').click();
    await expect(page.locator('#graph-forecast-physics')).toHaveAttribute('aria-checked', 'true');

    await gotoDevice(page);
    await expect(page.locator('#tuning-forecast-physics')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#tuning-forecast-ml')).toHaveAttribute('aria-checked', 'false');
  });
});

test.describe('Device-view kWh summary row (#tuning-forecast-kwh)', () => {
  // Scaffold that lets baseline and entered return different electricKwh values.
  async function scaffoldKwh(page, { baselineKwh, enteredKwh, baselineCost, enteredCost }) {
    function makeKwhForecast(kwh, cost) {
      const traj = Array.from({ length: 48 }, (_, i) => ({
        ts: new Date(NOW + i * 3600_000).toISOString(), top: 40, bottom: 30, avg: 35,
      }));
      const gh = Array.from({ length: 48 }, (_, i) => ({
        ts: new Date(NOW + i * 3600_000).toISOString(), temp: 12,
      }));
      return {
        generatedAt: new Date(NOW).toISOString(),
        engine: 'ml',
        weather: Array.from({ length: 48 }, (_, i) => ({
          validAt: new Date(NOW + i * 3600_000).toISOString(), temperature: 5,
        })),
        forecast: {
          horizonHours: 48,
          tankTrajectory: traj,
          greenhouseTrajectory: gh,
          modeForecast: [],
          hoursUntilBackupNeeded: kwh > 0 ? 12 : null,
          electricKwh: kwh,
          electricCostEur: cost,
          costBreakdown: [],
          modelConfidence: 'medium',
          notes: [],
        },
      };
    }

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

    await page.route('**/api/forecast**', (r) => {
      const url = r.request().url();
      const hasTu = url.includes('tu=');
      const kwh = hasTu ? enteredKwh : baselineKwh;
      const cost = hasTu ? enteredCost : baselineCost;
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makeKwhForecast(kwh, cost)) });
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
  }

  test('shows kWh and cost when space heater is projected to run', async ({ page }) => {
    await scaffoldKwh(page, { baselineKwh: 3.2, enteredKwh: 3.2, baselineCost: 0.48, enteredCost: 0.48 });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.locator('.sidebar-nav [data-view="device"]').click();
    await expect(page.locator('#device-config-form')).toBeVisible();

    const el = page.locator('#tuning-forecast-kwh');
    await expect(el).toContainText('3.2 kWh');
    await expect(el).toContainText('€0.48');
  });

  test('shows "none" when electricKwh is 0', async ({ page }) => {
    await scaffoldKwh(page, { baselineKwh: 0, enteredKwh: 0, baselineCost: 0, enteredCost: 0 });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.locator('.sidebar-nav [data-view="device"]').click();
    await expect(page.locator('#device-config-form')).toBeVisible();

    const el = page.locator('#tuning-forecast-kwh');
    await expect(el).toContainText('none');
    await expect(el).not.toContainText('kWh');
  });

  test('shows saved-config baseline when what-if differs by ≥0.1 kWh', async ({ page }) => {
    await scaffoldKwh(page, { baselineKwh: 4.5, enteredKwh: 1.2, baselineCost: 0.72, enteredCost: 0.19 });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.locator('.sidebar-nav [data-view="device"]').click();
    await expect(page.locator('#device-config-form')).toBeVisible();

    const el = page.locator('#tuning-forecast-kwh');
    await expect(el).toContainText('1.2 kWh');
    await expect(el).toContainText('€0.19');
    await expect(el).toContainText('saved:');
    await expect(el).toContainText('4.5 kWh');
    await expect(el).toContainText('€0.72');
  });
});
