// @ts-check
import { test, expect } from './fixtures.js';

/**
 * Frontend tests for the Tuning-thresholds forecast preview.
 *
 * The device view's Tuning section asks the real forecast engine for
 * two 48 h projections: a dashed baseline (plain /api/forecast, live
 * device-config tuning) and a solid "entered" line (/api/forecast?tu=…,
 * the values typed into the form). It recomputes as a threshold is
 * edited.
 */

const DEFAULT_CONFIG = { ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, tu: { geT: 11 }, v: 1 };

/** Build a forecast-engine response whose greenhouse line tracks geT. */
function buildForecast(geT) {
  const now = Date.now();
  const tank = [];
  const gh = [];
  const weather = [];
  const modeForecast = [];
  const MODES = ['solar_charging', 'solar_charging', 'greenhouse_heating',
    'greenhouse_heating', 'emergency_heating', 'idle', 'idle', 'idle'];
  for (let h = 0; h < 48; h++) {
    const ts = new Date(now + h * 3600000).toISOString();
    tank.push({ ts, top: 45 - h * 0.2, bottom: 40 - h * 0.2, avg: 42.5 - h * 0.2 });
    gh.push({ ts, temp: 8 + (geT - 10) * 0.6 + Math.sin(h / 6) });
    weather.push({ validAt: ts, temperature: 5 + 4 * Math.sin(h / 8) });
    modeForecast.push({ ts, mode: MODES[h % MODES.length] });
  }
  return {
    generatedAt: new Date(now).toISOString(),
    tu: {},
    weather,
    prices: [],
    forecast: {
      horizonHours: 48,
      tankTrajectory: tank,
      greenhouseTrajectory: gh,
      modeForecast,
      hoursUntilBackupNeeded: null,
      electricKwh: 0,
      electricCostEur: 0,
      modelConfidence: 'medium',
      notes: [],
    },
  };
}

/** Mock WebSocket so the app sees a live connection with sensor data. */
async function mockLiveConnection(page) {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function () { this.readyState = 3; },
        send: function () {},
      };
      setTimeout(function () {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({
            type: 'state',
            data: {
              mode: 'idle',
              temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
              valves: {}, actuators: { pump: false, fan: false, space_heater: false },
              controls_enabled: true,
            },
          }) });
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
  });
}

/** Set up API mocks and navigate to the device view. Captures forecast URLs. */
async function setupDeviceView(page) {
  const forecastUrls = [];

  await mockLiveConnection(page);

  await page.route('**/api/device-config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(DEFAULT_CONFIG),
      });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));

  // The forecast engine — baseline (no tu) uses geT 11; the what-if
  // variant echoes the geT carried in the `?tu=` override.
  await page.route('**/api/forecast**', async (route) => {
    const url = route.request().url();
    forecastUrls.push(url);
    let geT = 11;
    const m = url.match(/[?&]tu=([^&]+)/);
    if (m) {
      try {
        const tu = JSON.parse(decodeURIComponent(m[1]));
        if (typeof tu.geT === 'number') geT = tu.geT;
      } catch (e) { /* fall back to baseline geT */ }
    }
    await route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(buildForecast(geT)),
    });
  });

  await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__initComplete === true);

  await page.locator('.sidebar-nav [data-view="device"]').click();
  await expect(page.locator('#device-config-form')).toBeVisible();

  return { forecastUrls };
}

/** Fingerprint the forecast canvas: painted-pixel count + a cheap hash. */
async function canvasFingerprint(page) {
  return page.evaluate(() => {
    const c = /** @type {HTMLCanvasElement} */ (
      document.getElementById('tuning-forecast-chart'));
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let painted = 0;
    let hash = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) painted++;
    }
    for (let i = 0; i < data.length; i += 263) {
      hash = (hash * 31 + data[i]) >>> 0;
    }
    return { painted, hash };
  });
}

test.describe('Tuning forecast preview', () => {

  test('renders a forecast graph on the device view', async ({ page }) => {
    const { forecastUrls } = await setupDeviceView(page);

    await expect(page.locator('#tuning-forecast-chart')).toBeVisible();

    await expect.poll(
      async () => (await canvasFingerprint(page)).painted,
      { timeout: 5000 },
    ).toBeGreaterThan(200);

    await expect(page.locator('#tuning-forecast-status')).toHaveText('');

    // Both a baseline (no override) and a what-if (`?tu=`) request fired.
    expect(forecastUrls.some(u => /[?&]tu=/.test(u))).toBe(true);
    expect(forecastUrls.some(u => !/[?&]tu=/.test(u))).toBe(true);
  });

  test('re-fetches with the ?tu= override when a threshold is edited', async ({ page }) => {
    const { forecastUrls } = await setupDeviceView(page);

    await expect.poll(
      async () => (await canvasFingerprint(page)).painted,
      { timeout: 5000 },
    ).toBeGreaterThan(200);
    const before = await canvasFingerprint(page);
    const urlsBefore = forecastUrls.length;

    // Drop the greenhouse-heating enter threshold via the dual-knob
    // slider's lower range input — the what-if trajectory diverges from
    // the saved-config baseline. The slider drives the hidden #dc-tu-geT
    // input and dispatches an 'input' event on it. Value (5) stays
    // below the gxT firmware default (12) so the cross-knob clamp does
    // not kick in.
    await page.evaluate(() => {
      const lo = document.querySelector(
        '#dc-greenhouse-heat-slider .temp-dual-slider-input--lo');
      lo.value = '5';
      lo.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await expect.poll(
      async () => (await canvasFingerprint(page)).hash,
      { timeout: 5000 },
    ).not.toBe(before.hash);

    // The recompute carried geT=5 in the override.
    const newUrls = forecastUrls.slice(urlsBefore);
    expect(newUrls.some(u => /"geT":5\b/.test(decodeURIComponent(u)))).toBe(true);
  });

  test('legend shows the projected min/max for tank and greenhouse', async ({ page }) => {
    await setupDeviceView(page);

    await expect.poll(
      async () => (await canvasFingerprint(page)).painted,
      { timeout: 5000 },
    ).toBeGreaterThan(200);

    // Both badges are populated with a "min…max" range in °.
    await expect(page.locator('#tfl-tank-range')).toHaveText(/\d+\.\d+°…\d+\.\d+°/);
    await expect(page.locator('#tfl-gh-range')).toHaveText(/\d+\.\d+°…\d+\.\d+°/);
  });

  test('hover shows the crosshair inspector with projected values', async ({ page }) => {
    await setupDeviceView(page);

    await expect.poll(
      async () => (await canvasFingerprint(page)).painted,
      { timeout: 5000 },
    ).toBeGreaterThan(200);

    const canvas = page.locator('#tuning-forecast-chart');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);

    const inspector = page.locator('#tuning-forecast-inspector');
    await expect(inspector).toBeVisible();
    await expect(page.locator('#tuning-forecast-crosshair')).toBeVisible();
    // Readout is populated — temperatures and a mode label.
    await expect(page.locator('#tfi-tank')).toContainText('°C');
    await expect(page.locator('#tfi-mode')).not.toHaveText('');

    // Leaving the canvas hides the inspector.
    await page.mouse.move(box.x - 20, box.y - 20);
    await expect(inspector).toBeHidden();
  });

});
