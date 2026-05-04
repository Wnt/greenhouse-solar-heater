// @ts-check
// Tooltip on the history-graph forecast side must reflect forecast data,
// not the last live sample.
//
// Bug it guards against: graph-inspector.js used to do a nearest-neighbor
// lookup on timeSeriesStore only. When the cursor was past the "now"
// divider (forecast region), the lookup clamped to the last live point —
// the tooltip showed live values frozen at the last live time, while the
// dashed forecast curve was drawn over completely different temperatures.
import { test, expect } from './fixtures.js';

const NOW = Date.now();

// Live history covering ~2 h up to "now". Tank avg lands around 40°C
// (top 44, bottom 36). Forecast trajectory below starts at avg 30 and
// drops to 18 over 12 h, so any forecasted value is unmistakably distinct
// from the last live value.
const LIVE_POINTS = [
  { ts: NOW - 7200_000, collector: 25.0, tank_top: 38.0, tank_bottom: 30.0, greenhouse: 17.0, outdoor: 9.0 },
  { ts: NOW - 3600_000, collector: 45.0, tank_top: 42.0, tank_bottom: 34.0, greenhouse: 18.5, outdoor: 10.0 },
  { ts: NOW - 60_000,   collector: 60.0, tank_top: 44.0, tank_bottom: 36.0, greenhouse: 19.0, outdoor: 11.0 },
];

// 49 hourly forecast points (covers the full 48 h FORECAST_OVERLAY_SEC).
// The tank trajectory descends from 30 → ~18°C over 48 h, the greenhouse
// from 14 → ~6°C — both well below the last live values so a forecast-
// region tooltip can't be confused with a "stale live" reading.
// Weather temperature descends from 11 → ~1.2°C, distinct from the last
// live outdoor sample (11°C exactly) only after a few hours.
const FORECAST_PAYLOAD = {
  generatedAt: new Date(NOW).toISOString(),
  forecast: {
    generatedAt: new Date(NOW).toISOString(),
    horizonHours: 48,
    tankTrajectory: Array.from({ length: 49 }, (_, i) => ({
      ts: new Date(NOW + i * 3600_000).toISOString(),
      top: 32 - i * 0.25,
      bottom: 28 - i * 0.25,
      avg: 30 - i * 0.25,
    })),
    greenhouseTrajectory: Array.from({ length: 49 }, (_, i) => ({
      ts: new Date(NOW + i * 3600_000).toISOString(),
      temp: 14 - i * 0.16,
    })),
    // Hours 0,1,2 = solar_charging. Hours 6,7,8 = greenhouse_heating.
    // Hour 10 = emergency_heating. Default 1-h bucket means whichever
    // bucket the cursor lands in gets a clean 100% / 0% / 0% reading.
    modeForecast: [
      { ts: new Date(NOW + 0 * 3600_000).toISOString(), mode: 'solar_charging' },
      { ts: new Date(NOW + 1 * 3600_000).toISOString(), mode: 'solar_charging' },
      { ts: new Date(NOW + 2 * 3600_000).toISOString(), mode: 'solar_charging' },
      { ts: new Date(NOW + 6 * 3600_000).toISOString(), mode: 'greenhouse_heating' },
      { ts: new Date(NOW + 7 * 3600_000).toISOString(), mode: 'greenhouse_heating' },
      { ts: new Date(NOW + 8 * 3600_000).toISOString(), mode: 'greenhouse_heating' },
      { ts: new Date(NOW + 10 * 3600_000).toISOString(), mode: 'emergency_heating' },
    ],
    hoursUntilFloor: 48,
    hoursUntilBackupNeeded: 10,
    electricKwh: 1.0,
    electricCostEur: 0.15,
    costBreakdown: [],
    solarChargingHours: 3,
    greenhouseHeatingHours: 3,
    modelConfidence: 'medium',
    notes: [],
  },
  // Weather array is what the outside-temperature forecast line reads
  // from. Linear drop 11 → 1.4°C over 48 h gives ~7.7°C at hour ~21
  // (where the forecast-region hover lands at frac 0.625 below).
  weather: Array.from({ length: 49 }, (_, i) => ({
    validAt:         new Date(NOW + i * 3600_000).toISOString(),
    temperature:     11 - i * 0.2,
    radiationGlobal: 0,
    windSpeed:       2,
    precipitation:   0,
  })),
  prices: [],
};

async function scaffold(page) {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close() { this.readyState = 3; },
        send() {},
      };
      // @ts-ignore
      window.__mockWs = fake;
      setTimeout(() => {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({
            type: 'state',
            data: {
              mode: 'idle',
              temps: { collector: 60, tank_top: 44, tank_bottom: 36, greenhouse: 19, outdoor: 11 },
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
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
    // @ts-ignore
    window.WebSocket.CLOSED = 3;
  });

  await page.route('**/api/history**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      range: '24h',
      points: LIVE_POINTS,
      events: [
        { ts: NOW - 7200_000, type: 'mode', id: 'controller', from: 'idle', to: 'solar_charging' },
        { ts: NOW - 60_000,   type: 'mode', id: 'controller', from: 'solar_charging', to: 'idle' },
      ],
    }),
  }));
  await page.route('**/api/forecast', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify(FORECAST_PAYLOAD),
  }));
  await page.route('**/api/watchdog/state', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ pending: null, watchdogs: [], snapshot: { we: {}, wz: {}, wb: {} }, recent: [] }),
  }));
  await page.route('**/api/device-config', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }),
  }));
  await page.route('**/api/events**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/push/**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }));
}

// Hover the canvas at a fraction-of-width position. Returns the simTime
// (Unix seconds) the inspector should resolve to, computed from the
// chart's actual draw window so the assertions don't have to redo the
// math.
async function hoverChartAt(page, frac) {
  const box = await page.locator('#chart').boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const pad = { left: 8, right: 16 };
  const pw = box.width - pad.left - pad.right;
  const x = pad.left + frac * pw;
  await page.locator('#chart').hover({ position: { x, y: box.height / 2 } });
}

test.describe('Inspector tooltip on the forecast side of the history graph', () => {
  test('forecast-region hover shows forecast tank temperature, not the last live value', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    // Wait for the forecast payload to land in shared state — once the
    // forecast card has populated, history-graph's drawHistoryGraph()
    // has been re-invoked with forecastData set.
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-hours');
      return !!(el && el.textContent && el.textContent !== '—');
    }, { timeout: 5000 });

    // Enable the forecast overlay so the chart draws past "now".
    await page.locator('#graph-show-forecast-toggle').click();
    await expect(page.locator('#graph-show-forecast')).toHaveAttribute('aria-checked', 'true');

    // Hover ~21.6 h into the forecast region. The window spans 24 h of
    // history + 48 h of forecast (72 h total); 0.625 of the width lands
    // around now + 21.6 h. Picked to fall well past hour 8 (the last
    // greenhouse_heating slot) and well before hour 48 (last sample), so
    // none of the trajectory edges interfere with the assertions.
    await hoverChartAt(page, 0.625);

    const tankText = await page.locator('#inspector-tank').textContent();
    // Last live tank avg is (44+36)/2 = 40.0°C. Forecast tank avg at
    // hour ~21.6 is 30 - 21.6*0.25 ≈ 24.6°C. Anything > 30°C means we're
    // still reading the live nearest-neighbor — fail loudly.
    const tankNum = parseFloat((tankText || '').replace('°C', ''));
    expect(tankNum).toBeGreaterThan(0);
    expect(tankNum).toBeLessThan(30); // forecast value, not the 40°C live
    expect(tankNum).toBeGreaterThan(18); // sanity: within forecast range

    // Greenhouse forecast at hour 21.6 ≈ 14 - 21.6*0.16 = 10.5°C; live is
    // 19°C. Same shape of assertion.
    const ghText = await page.locator('#inspector-gh').textContent();
    const ghNum = parseFloat((ghText || '').replace('°C', ''));
    expect(ghNum).toBeLessThan(15);
    expect(ghNum).toBeGreaterThan(7);

    // Outdoor IS part of the forecast (weather array). At hour ~21.6 the
    // forecast outdoor is 11 - 21.6*0.2 ≈ 6.7°C — well below the last
    // live sample of 11°C, so a live-fallback would assert >10.
    const outText = await page.locator('#inspector-out').textContent();
    const outNum = parseFloat((outText || '').replace('°C', ''));
    expect(outNum).toBeLessThan(10);
    expect(outNum).toBeGreaterThan(2);

    // Collector is not part of the forecast — keeps showing the placeholder.
    await expect(page.locator('#inspector-coll')).toHaveText('—');
  });

  test('forecast-region hover shows the forecast mode-band percentages', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-hours');
      return !!(el && el.textContent && el.textContent !== '—');
    }, { timeout: 5000 });

    await page.locator('#graph-show-forecast-toggle').click();

    // Hover at frac 0.43 — visible window spans 72 h (24 h history +
    // 48 h forecast), so simTime ≈ tMin + 0.43·72h = now + ~7 h. With
    // pickBucketSize for a 72 h range stepping up to 6-h buckets, the
    // bucket containing hour 7 always overlaps at least one of the
    // greenhouse_heating slots at hours 6/7/8. Charging (hours 0/1/2)
    // and emergency (hour 10) may also share a bucket depending on
    // alignment, so we only assert heating > 0 here.
    await hoverChartAt(page, 0.43);

    const ht = await page.locator('#inspector-heating').textContent();
    expect(parseInt(ht, 10)).toBeGreaterThan(0);
  });

  test('forecast-region hover shows a future time, not the last live timestamp', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => {
      const el = document.getElementById('forecast-val-hours');
      return !!(el && el.textContent && el.textContent !== '—');
    }, { timeout: 5000 });

    await page.locator('#graph-show-forecast-toggle').click();

    // Read what the chart thinks "now" is by hovering on the right
    // edge of the historical span. The last live sample was 60 s ago —
    // a properly-working forecast tooltip at frac 0.9 should show a
    // time several hours later, not 60 s before "now".
    await hoverChartAt(page, 0.9);
    const forecastLabel = await page.locator('#inspector-time').textContent();

    await hoverChartAt(page, 0.5); // historical region
    const liveLabel = await page.locator('#inspector-time').textContent();

    expect(forecastLabel).not.toBe(liveLabel);
    // The labels are HH:MM (or HH.MM, depending on locale) — both should
    // be non-empty 5-char strings.
    expect((forecastLabel || '').trim()).toMatch(/\d\d.\d\d/);
    expect((liveLabel || '').trim()).toMatch(/\d\d.\d\d/);
  });
});
