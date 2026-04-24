import { test, expect } from './fixtures.js';

// Shared sensor config mock
const sensorConfigResponse = {
  hosts: [
    { id: 'sensor_1', ip: '192.168.30.20', name: 'Sensor Hub 1' },
    { id: 'sensor_2', ip: '192.168.30.21', name: 'Sensor Hub 2' },
  ],
  assignments: {},
  version: 0,
};

// Helper: navigate to the Device view (contains the merged sensors section)
async function goToSensors(page) {
  await page.goto('/playground/');
  await page.waitForSelector('.sidebar-nav');
  await page.evaluate(() => {
    document.querySelectorAll('.live-only').forEach(el => el.style.display = '');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const deviceView = document.getElementById('view-device');
    if (deviceView) deviceView.classList.add('active');
    document.querySelectorAll('[data-view]').forEach(l => l.classList.remove('active'));
    document.querySelectorAll('[data-view="device"]').forEach(l => l.classList.add('active'));
    window.location.hash = 'device';
  });
  await page.waitForSelector('#sensors-content .card', { timeout: 15000 });
}

// Helper: navigate to sensors view and click Scan Sensors
async function goToSensorsAndScan(page) {
  await goToSensors(page);
  await page.click('#btn-scan-sensors');
}

test.describe('Sensor view does not auto-scan', () => {
  test('opening the view does not call sensor-discovery', async ({ page }) => {
    let discoveryCallCount = 0;
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      discoveryCallCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'disc-mock', results: [] }),
      });
    });

    await goToSensors(page);
    // Wait a bit to ensure no background scan fires
    await page.waitForTimeout(2000);
    expect(discoveryCallCount).toBe(0);
  });

  test('no periodic polling happens while view is open', async ({ page }) => {
    // Explicit 10s budget: the assertion needs 4 s of real waits (1 s post-
    // click + 3 s to prove no interval polling fires) on top of the page
    // load. The 5 s global timeout in playwright.config.js left this test
    // routinely sitting ~200 ms below the limit on developer machines and
    // tipping over under CI worker contention.
    test.setTimeout(10000);
    let discoveryCallCount = 0;
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      discoveryCallCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'disc-mock', results: [] }),
      });
    });

    await goToSensors(page);
    // Click scan once
    await page.click('#btn-scan-sensors');
    await page.waitForTimeout(1000);
    expect(discoveryCallCount).toBe(1);

    // Wait well past old auto-refresh interval (was 30s, use shorter wait to prove no timer)
    // If there was a setInterval, we'd see extra calls
    await page.waitForTimeout(3000);
    expect(discoveryCallCount).toBe(1);
  });
});

test.describe('Sensor discovery error messages', () => {
  test('shows descriptive message when host returns legacy "err" error', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-mock',
          results: [
            { host: '192.168.30.20', ok: true, sensors: [{ addr: '40:255:170:187:204:221:0:1', tC: 21.0, component: 'temperature:100' }] },
            { host: '192.168.30.21', ok: false, error: 'err' },
          ],
        }),
      });
    });

    await goToSensorsAndScan(page);
    await page.waitForSelector('.sensor-table', { timeout: 15000 });

    // Sensor Hub 1 should show its sensor
    await expect(page.locator('td:has-text("40:255:170:187:204:221:0:1")')).toBeVisible();

    // Sensor Hub 2 should show a descriptive error, NOT raw "err"
    const hub2Error = page.locator('.host-error');
    await expect(hub2Error).toBeVisible();
    const errorText = await hub2Error.textContent();
    expect(errorText).not.toBe('err');
    expect(errorText).toContain('RPC call failed');
  });

  test('shows descriptive message when host returns legacy "bad" error', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-mock',
          results: [
            { host: '192.168.30.20', ok: false, error: 'bad' },
            { host: '192.168.30.21', ok: false, error: 'bad' },
          ],
        }),
      });
    });

    await goToSensorsAndScan(page);
    await page.waitForSelector('.host-error', { timeout: 15000 });

    const errors = page.locator('.host-error');
    const count = await errors.count();
    expect(count).toBe(2);
    for (let i = 0; i < count; i++) {
      const text = await errors.nth(i).textContent();
      expect(text).not.toBe('bad');
      expect(text).toContain('Unexpected HTTP response');
    }
  });

  test('shows descriptive message when host returns legacy "parse" error', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-mock',
          results: [
            { host: '192.168.30.20', ok: true, sensors: [] },
            { host: '192.168.30.21', ok: false, error: 'parse' },
          ],
        }),
      });
    });

    await goToSensorsAndScan(page);
    await page.waitForSelector('.host-group', { timeout: 15000 });

    const hub2Error = page.locator('.host-error');
    await expect(hub2Error).toBeVisible();
    const errorText = await hub2Error.textContent();
    expect(errorText).not.toBe('parse');
    expect(errorText).toContain('Invalid response');
  });

  test('passes through descriptive errors from newer firmware unchanged', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-mock',
          results: [
            { host: '192.168.30.20', ok: true, sensors: [] },
            { host: '192.168.30.21', ok: false, error: 'RPC error: {"code":-1,"message":"Timeout"}' },
          ],
        }),
      });
    });

    await goToSensorsAndScan(page);
    await page.waitForSelector('.host-error', { timeout: 15000 });

    const errorText = await page.locator('.host-error').textContent();
    expect(errorText).toContain('RPC error');
  });
});

test.describe('Sensor discovery per-host error isolation', () => {
  test('one host succeeds and another fails independently', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-mock',
          results: [
            { host: '192.168.30.20', ok: true, sensors: [
              { addr: '40:170:187:204:221:238:0:1', tC: 20.5, component: 'temperature:100' },
            ]},
            { host: '192.168.30.21', ok: false, error: 'RPC error: {"code":-1,"message":"Timeout"}' },
          ],
        }),
      });
    });

    await goToSensorsAndScan(page);
    await page.waitForSelector('.sensor-table', { timeout: 15000 });

    // Hub 1 should show its sensor in a table
    await expect(page.locator('.sensor-table')).toHaveCount(1);
    await expect(page.locator('td:has-text("40:170:187:204:221:238:0:1")')).toBeVisible();

    // Hub 2 should show an error
    await expect(page.locator('.host-error')).toHaveCount(1);
    await expect(page.locator('.host-error')).toContainText('RPC error');

    // The sensor from Hub 1 should still appear in role dropdowns
    const firstSelect = page.locator('.sensor-select').first();
    const options = firstSelect.locator('option');
    // 1 unassigned + 1 sensor from Hub 1
    await expect(options).toHaveCount(2);
  });
});

test.describe('Sensor discovery per-host error surfacing', () => {
  test('shows specific per-host error when a single hub is unreachable', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-1',
          results: [
            { host: '192.168.30.20', ok: true, sensors: [{ addr: 'aa:01', component: 'temperature:100', tC: 22.9 }] },
            { host: '192.168.30.21', ok: false, error: '192.168.30.21 refused connection — device off or wrong IP', sensors: [] },
          ],
        }),
      });
    });

    await goToSensorsAndScan(page);
    await page.waitForSelector('.host-error', { timeout: 15000 });

    const errors = page.locator('.host-error');
    await expect(errors).toHaveCount(1);
    const text = await errors.nth(0).textContent();
    expect(text).toContain('refused connection');
    // The working hub still renders its sensors in the other host group.
    await expect(page.locator('.sensor-table')).toHaveCount(1);
  });

  test('shows server error message on HTTP 500', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Internal discovery failure' }),
      });
    });

    await goToSensorsAndScan(page);
    await page.waitForSelector('.host-error', { timeout: 15000 });

    const errors = page.locator('.host-error');
    await expect(errors).toHaveCount(2);
    for (let i = 0; i < 2; i++) {
      const text = await errors.nth(i).textContent();
      expect(text).toContain('Internal discovery failure');
    }
  });
});

test.describe('Sensor discovery concurrent scan guard', () => {
  test('scan button is disabled while scan is in flight', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      // Simulate a slow response (2 seconds)
      await new Promise(resolve => setTimeout(resolve, 2000));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-1',
          results: [
            { host: '192.168.30.20', ok: true, sensors: [] },
            { host: '192.168.30.21', ok: true, sensors: [] },
          ],
        }),
      });
    });

    await goToSensors(page);
    // Click scan
    await page.click('#btn-scan-sensors');
    await page.waitForTimeout(100);

    // Button should be disabled while scan is in flight
    const isDisabled = await page.evaluate(() => {
      const btn = document.getElementById('btn-scan-sensors');
      return btn && btn.disabled;
    });
    expect(isDisabled).toBe(true);
  });
});

test.describe('Sensor discovery no response for a host', () => {
  test('shows per-host "No response" when host is missing from results', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      // Only return results for one host, not both
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-mock',
          results: [
            { host: '192.168.30.20', ok: true, sensors: [{ addr: '40:255:0:0:0:0:0:1', tC: 22.0, component: 'temperature:100' }] },
            // No result for 192.168.30.21
          ],
        }),
      });
    });

    await goToSensorsAndScan(page);
    await page.waitForSelector('.sensor-table', { timeout: 15000 });

    // Hub 1 should show sensor
    await expect(page.locator('td:has-text("40:255:0:0:0:0:0:1")')).toBeVisible();

    // Hub 2 should show "No response" error
    const error = page.locator('.host-error');
    await expect(error).toHaveCount(1);
    await expect(error).toContainText('No response');
  });
});

test.describe('Sensor view hash navigation on reload', () => {
  test('navigating directly to #sensors shows the device view (legacy alias)', async ({ page }) => {
    await page.route('**/api/sensor-config', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sensorConfigResponse) });
    });

    // Navigate with legacy #sensors hash — routed through HASH_ALIASES to the
    // merged Device view that now hosts sensor configuration.
    await page.goto('/playground/#sensors');
    await page.waitForSelector('#sensors-content .card', { timeout: 15000 });

    const deviceView = page.locator('#view-device');
    await expect(deviceView).toHaveClass(/active/);

    const statusView = page.locator('#view-status');
    await expect(statusView).not.toHaveClass(/active/);
  });

  test('navigating directly to #device shows the device view', async ({ page }) => {
    await page.goto('/playground/#device');
    await page.waitForSelector('.sidebar-nav');

    const deviceView = page.locator('#view-device');
    await expect(deviceView).toHaveClass(/active/);

    const statusView = page.locator('#view-status');
    await expect(statusView).not.toHaveClass(/active/);
  });
});
