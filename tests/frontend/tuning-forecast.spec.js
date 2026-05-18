// @ts-check
import { test, expect } from './fixtures.js';

/**
 * Frontend tests for the Tuning-thresholds forecast preview.
 *
 * The device view's Tuning section renders a 24 h simulated projection
 * from the latest live readings: a solid trajectory for the values
 * typed into the form and a dashed one for the values saved on the
 * controller. The preview re-simulates live as the user edits a
 * threshold.
 */

const DEFAULT_CONFIG = { ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 };

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

/** Set up API mocks and navigate to the device view. */
async function setupDeviceView(page, initialConfig) {
  const config = { ...DEFAULT_CONFIG, ...initialConfig };

  await mockLiveConnection(page);

  await page.route('**/api/device-config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(config),
      });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));

  await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__initComplete === true);

  await page.locator('.sidebar-nav [data-view="device"]').click();
  await expect(page.locator('#device-config-form')).toBeVisible();
}

/**
 * Read a fingerprint of the forecast canvas: how many pixels are
 * painted, plus a cheap hash so two renders can be compared.
 */
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
    await setupDeviceView(page, { tu: { geT: 11 } });

    await expect(page.locator('#tuning-forecast-chart')).toBeVisible();

    // The canvas paints once the simulation has run (debounced ~200 ms).
    await expect.poll(
      async () => (await canvasFingerprint(page)).painted,
      { timeout: 4000 },
    ).toBeGreaterThan(200);

    // No error / waiting message once readings are available.
    await expect(page.locator('#tuning-forecast-status')).toHaveText('');
  });

  test('re-simulates when a tuning threshold is edited', async ({ page }) => {
    await setupDeviceView(page, { tu: { geT: 11 } });

    await expect.poll(
      async () => (await canvasFingerprint(page)).painted,
      { timeout: 4000 },
    ).toBeGreaterThan(200);
    const before = await canvasFingerprint(page);

    // Pull the greenhouse-heating enter threshold well above the
    // current greenhouse temperature — the entered trajectory diverges
    // from the saved-config baseline.
    await page.locator('#dc-tu-geT').fill('22');

    await expect.poll(
      async () => (await canvasFingerprint(page)).hash,
      { timeout: 4000 },
    ).not.toBe(before.hash);
  });

});
