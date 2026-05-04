// @ts-check
// Tests for playground/js/forecast.js — the "Next 48 h" forecast card on the
// Status view. API responses are mocked via page.route() so these tests run
// offline against the static file server.
import { test, expect } from './fixtures.js';

// ── Mock data ────────────────────────────────────────────────────────────────

const NOW = Date.now();
const makeTrajectory = () =>
  Array.from({ length: 48 }, (_, i) => ({
    ts: new Date(NOW + i * 3600_000).toISOString(),
    top: 40 - i * 0.3,
    bottom: 30 - i * 0.3,
    avg: 35 - i * 0.3,
  }));

const BASE_FORECAST = {
  generatedAt: new Date(NOW).toISOString(),
  weather: Array.from({ length: 48 }, (_, i) => ({
    validAt: new Date(NOW + i * 3600_000).toISOString(),
    temperature: 8 + Math.sin(i / 6) * 3,
    radiationGlobal: i >= 8 && i <= 18 ? 400 : 0,
    windSpeed: 2,
    precipitation: 0,
  })),
  prices: Array.from({ length: 48 }, (_, i) => ({
    validAt: new Date(NOW + i * 3600_000).toISOString(),
    priceCKwh: 15 + i * 0.2,
    source: i < 24 ? 'sahkotin' : 'nordpool-predict',
  })),
  forecast: {
    generatedAt: new Date(NOW).toISOString(),
    horizonHours: 48,
    tankTrajectory: makeTrajectory(),
    greenhouseTrajectory: Array.from({ length: 48 }, (_, i) => ({
      ts: new Date(NOW + i * 3600_000).toISOString(),
      temp: 10 + Math.sin(i / 8),
    })),
    hoursUntilFloor: 17.5,
    hoursUntilBackupNeeded: 17.5,
    electricKwh: 8.4,
    electricCostEur: 1.21,
    costBreakdown: [
      { ts: new Date(NOW + 20 * 3600_000).toISOString(), kWh: 1, priceCKwh: 18.2, eurInclTransfer: 0.232 },
      { ts: new Date(NOW + 21 * 3600_000).toISOString(), kWh: 1, priceCKwh: 19.0, eurInclTransfer: 0.24 },
    ],
    solarChargingHours: 6,
    greenhouseHeatingHours: 14,
    modelConfidence: 'medium',
    notes: [
      'Tomorrow afternoon: 4 h of solar charging, +6 kWh.',
      'Collectors typically gain heat from 11:00 to 17:00 based on the past 14 days.',
    ],
  },
};

// ── Scaffold ─────────────────────────────────────────────────────────────────

// Sets up the page for forecast-card tests. Optionally overrides the
// /api/forecast response.
async function scaffold(page, { forecastPayload = BASE_FORECAST, forecastStatus = 200 } = {}) {
  // Minimal fake WebSocket — switches the app into live mode without
  // needing a real server (same pattern as crashes-view.spec.js).
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close() { this.readyState = 3; },
        send() {},
      };
      setTimeout(() => {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({
            type: 'state',
            data: {
              mode: 'idle',
              temps: { collector: 30, tank_top: 38, tank_bottom: 28, greenhouse: 14, outdoor: 8 },
              valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
              actuators: { pump: false, fan: false, space_heater: false },
              controls_enabled: true,
              manual_override: null,
            },
          }) });
        }
      }, 50);
      return fake;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  });

  // Forecast endpoint
  await page.route('**/api/forecast', r => r.fulfill({
    status: forecastStatus,
    contentType: 'application/json',
    body: forecastStatus === 200 ? JSON.stringify(forecastPayload) : '{"error":"server error"}',
  }));

  // Silence other endpoints that main.js loads during boot
  await page.route('**/api/watchdog/state', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ pending: null, watchdogs: [], snapshot: { we: {}, wz: {}, wb: {} }, recent: [] }),
  }));
  await page.route('**/api/device-config', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }),
  }));
  await page.route('**/api/history**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ range: '48h', points: [], events: [] }),
  }));
  await page.route('**/api/events**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: '[]',
  }));
  await page.route('**/api/push/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Forecast card — basic rendering', () => {
  test('card is present on the Status view', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    const card = page.locator('#forecast-card');
    await expect(card).toBeAttached();
  });

  test('renders "Tank lasts" from hoursUntilBackupNeeded', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    // Wait for live-mode phase to propagate and the card to populate
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-hours');
      return el && el.textContent && el.textContent !== '—';
    }, { timeout: 5000 });

    const val = page.locator('#forecast-val-hours');
    await expect(val).toHaveText('~17.5 h');
  });

  test('renders "Backup heat" from electricKwh', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-kwh');
      return el && el.textContent && el.textContent !== '—';
    }, { timeout: 5000 });

    const val = page.locator('#forecast-val-kwh');
    await expect(val).toHaveText('8.4 kWh');
  });

  test('renders "Backup cost" as €1.21 for electricCostEur: 1.21', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-eur');
      return el && el.textContent && el.textContent !== '—';
    }, { timeout: 5000 });

    const val = page.locator('#forecast-val-eur');
    await expect(val).toHaveText('€1.21');
  });

  test('renders sparkline SVG', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const wrap = document.getElementById('forecast-sparkline-wrap');
      return wrap && wrap.querySelector('svg') !== null;
    }, { timeout: 5000 });

    const svg = page.locator('#forecast-sparkline-wrap svg');
    await expect(svg).toBeAttached();
  });

  test('renders forecast notes', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const notes = document.getElementById('forecast-notes');
      return notes && notes.querySelectorAll('.forecast-note').length > 0;
    }, { timeout: 5000 });

    const notes = page.locator('#forecast-notes .forecast-note');
    await expect(notes).toHaveCount(2);
  });
});

test.describe('Forecast card — "48+ h" when no backup needed', () => {
  test('shows "48+ h" when hoursUntilBackupNeeded is null', async ({ page }) => {
    const payload = JSON.parse(JSON.stringify(BASE_FORECAST));
    payload.forecast.hoursUntilFloor = null;
    payload.forecast.hoursUntilBackupNeeded = null;

    await scaffold(page, { forecastPayload: payload });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-hours');
      return el && el.textContent && el.textContent !== '—';
    }, { timeout: 5000 });

    const val = page.locator('#forecast-val-hours');
    await expect(val).toHaveText('48+ h');
  });
});

test.describe('Forecast card — expand/collapse', () => {
  test('tap expands the detail chart', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-hours');
      return el && el.textContent && el.textContent !== '—';
    }, { timeout: 5000 });

    // Initially collapsed
    const chartWrap = page.locator('#forecast-chart-wrap');
    await expect(chartWrap).toBeHidden();

    // Click expand
    await page.locator('#forecast-expand-btn').click();
    await expect(chartWrap).toBeVisible();

    // Expanded chart SVG should be present
    const svg = page.locator('#forecast-chart-wrap svg');
    await expect(svg).toBeAttached();
  });

  test('tap again collapses the chart', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-hours');
      return el && el.textContent && el.textContent !== '—';
    }, { timeout: 5000 });

    const btn = page.locator('#forecast-expand-btn');
    const chartWrap = page.locator('#forecast-chart-wrap');

    await btn.click();
    await expect(chartWrap).toBeVisible();

    await btn.click();
    await expect(chartWrap).toBeHidden();
  });
});

test.describe('Forecast card — error state', () => {
  test('shows "Forecast unavailable" on server error', async ({ page }) => {
    await scaffold(page, { forecastStatus: 500 });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    // Wait for the error text to appear
    await page.waitForFunction(() => {
      const wrap = document.getElementById('forecast-sparkline-wrap');
      return wrap && wrap.textContent && wrap.textContent.includes('Forecast unavailable');
    }, { timeout: 5000 });

    const sparkWrap = page.locator('#forecast-sparkline-wrap');
    await expect(sparkWrap).toContainText('Forecast unavailable');
  });

  test('retry button is present on error', async ({ page }) => {
    await scaffold(page, { forecastStatus: 503 });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      return !!document.getElementById('forecast-retry-btn');
    }, { timeout: 5000 });

    const retryBtn = page.locator('#forecast-retry-btn');
    await expect(retryBtn).toBeAttached();
  });
});

test.describe('Forecast card — low confidence warning', () => {
  test('shows warning when modelConfidence is "low"', async ({ page }) => {
    const payload = JSON.parse(JSON.stringify(BASE_FORECAST));
    payload.forecast.modelConfidence = 'low';

    await scaffold(page, { forecastPayload: payload });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const notes = document.getElementById('forecast-notes');
      return notes && notes.querySelector('.forecast-note-warn') !== null;
    }, { timeout: 5000 });

    const warn = page.locator('.forecast-note-warn');
    await expect(warn).toBeAttached();
    await expect(warn).toContainText('warming up');
  });

  test('no warning shown when modelConfidence is "medium"', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-hours');
      return el && el.textContent && el.textContent !== '—';
    }, { timeout: 5000 });

    const warn = page.locator('.forecast-note-warn');
    await expect(warn).toHaveCount(0);
  });
});
