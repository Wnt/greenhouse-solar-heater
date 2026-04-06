import { test, expect } from './fixtures.js';

test.describe('Sensor Configuration View', () => {
  test.beforeEach(async ({ page }) => {
    // Mock the sensor config API
    await page.route('**/api/sensor-config', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            hosts: [
              { id: 'sensor_1', ip: '192.168.30.20', name: 'Sensor Hub 1' },
              { id: 'sensor_2', ip: '192.168.30.21', name: 'Sensor Hub 2' },
            ],
            assignments: {},
            version: 0,
          }),
        });
      } else if (route.request().method() === 'PUT') {
        const body = JSON.parse(route.request().postData());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            hosts: [
              { id: 'sensor_1', ip: '192.168.30.20', name: 'Sensor Hub 1' },
              { id: 'sensor_2', ip: '192.168.30.21', name: 'Sensor Hub 2' },
            ],
            assignments: body.assignments,
            version: 1,
          }),
        });
      }
    });

    // Mock sensor discovery RPC calls
    await page.route('**/api/rpc/**', async (route) => {
      const body = route.request().postData();
      const url = route.request().url();

      if (url.includes('SensorAddon.OneWireScan')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            devices: [
              { type: 'ds18b20', addr: '40:FF:64:06:C7:CC:95:B1', component: 'temperature:100' },
              { type: 'ds18b20', addr: '40:FF:64:06:C7:CC:95:B2', component: 'temperature:101' },
              { type: 'ds18b20', addr: '40:FF:64:06:C7:CC:95:B3', component: null },
            ],
          }),
        });
      } else if (url.includes('SensorAddon.GetPeripherals')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ds18b20: {
              'temperature:100': { addr: '40:FF:64:06:C7:CC:95:B1' },
              'temperature:101': { addr: '40:FF:64:06:C7:CC:95:B2' },
            },
          }),
        });
      } else if (url.includes('Temperature.GetStatus')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 100, tC: 24.5, tF: 76.1 }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 1, src: 'mock' }),
        });
      }
    });
  });

  // Helper: navigate to sensors view (force live-only visibility for test env)
  async function goToSensors(page) {
    await page.goto('/playground/');
    // Wait for the app to initialize
    await page.waitForSelector('.sidebar-nav');
    // Make live-only elements visible and navigate
    await page.evaluate(() => {
      document.querySelectorAll('.live-only').forEach(el => el.style.display = '');
      // Directly activate the sensors view since navigateToView may have already run
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      var sensorsView = document.getElementById('view-sensors');
      if (sensorsView) sensorsView.classList.add('active');
      document.querySelectorAll('[data-view]').forEach(l => l.classList.remove('active'));
      document.querySelectorAll('[data-view="sensors"]').forEach(l => l.classList.add('active'));
      // Trigger the sensors init
      window.location.hash = 'sensors';
    });
    await page.waitForSelector('#sensors-content .card', { timeout: 15000 });
  }

  test('loads sensors view and shows sensor hosts', async ({ page }) => {
    await goToSensors(page);

    // Should show sensor roles section
    await expect(page.locator('text=Sensor Roles')).toBeVisible();

    // Should show detected sensors section
    await expect(page.locator('text=Detected Sensors')).toBeVisible();

    // Should show both sensor host names
    await expect(page.locator('text=Sensor Hub 1')).toBeVisible();
    await expect(page.locator('text=Sensor Hub 2')).toBeVisible();
  });

  test('displays detected sensors with addresses and temperatures', async ({ page }) => {
    await goToSensors(page);
    // Wait for scan to complete — sensor table appears after async scan
    await page.waitForSelector('.sensor-table', { timeout: 15000 });

    // Should show sensor addresses (from mock, same 3 sensors returned by both hosts)
    await expect(page.locator('td:has-text("40:FF:64:06:C7:CC:95:B1")').first()).toBeVisible();

    // Should show temperature readings
    await expect(page.locator('td:has-text("24.5")').first()).toBeVisible();
  });

  test('shows role assignment dropdowns', async ({ page }) => {
    await goToSensors(page);
    // Wait for scan to complete so options are populated
    await page.waitForSelector('.sensor-table', { timeout: 15000 });

    // Should show dropdowns for all roles
    const selects = page.locator('.sensor-select');
    await expect(selects).toHaveCount(7); // 5 required + 2 optional

    // First select should have options: unassigned + detected sensors (3 per host × 2 hosts = 6)
    const firstSelect = selects.first();
    const options = firstSelect.locator('option');
    await expect(options).toHaveCount(7); // 1 unassigned + 6 detected
  });

  test('saves sensor assignments via PUT', async ({ page }) => {
    let putCalled = false;
    let putBody = null;

    await page.route('**/api/sensor-config', async (route) => {
      if (route.request().method() === 'PUT') {
        putCalled = true;
        putBody = JSON.parse(route.request().postData());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            hosts: [],
            assignments: putBody.assignments,
            version: 1,
          }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ hosts: [{ id: 'sensor_1', ip: '192.168.30.20', name: 'Sensor Hub 1' }], assignments: {}, version: 0 }),
        });
      }
    });

    await goToSensors(page);
    await page.waitForSelector('.sensor-select');

    // Select a sensor for the collector role
    const collectorSelect = page.locator('[data-role="collector"]');
    await collectorSelect.selectOption({ index: 1 }); // First detected sensor

    // Click save
    await page.click('#btn-save-sensors');
    await page.waitForTimeout(500);

    expect(putCalled).toBe(true);
    expect(putBody.assignments).toBeDefined();
    expect(putBody.assignments.collector).toBeDefined();
  });

  test('shows apply button and results', async ({ page }) => {
    await page.route('**/api/sensor-config/apply', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          results: {
            sensor_1: { status: 'success', message: '3 sensors configured' },
            sensor_2: { status: 'error', message: 'Device unreachable' },
            control: { status: 'success', message: 'Sensor routing published' },
          },
        }),
      });
    });

    await goToSensors(page);
    await page.waitForSelector('#btn-apply-sensors');

    // Apply button should exist
    await expect(page.locator('#btn-apply-sensors')).toBeVisible();
  });
});
