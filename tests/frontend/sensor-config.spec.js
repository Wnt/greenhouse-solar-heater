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

    // Mock sensor discovery via MQTT (POST /api/sensor-discovery)
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-mock',
          results: [
            {
              host: '192.168.30.20',
              ok: true,
              sensors: [
                { addr: '40:255:100:6:199:204:149:177', tC: 24.5, component: 'temperature:100' },
                { addr: '40:255:100:6:199:204:149:178', tC: 22.3, component: 'temperature:101' },
                { addr: '40:255:100:6:199:204:149:179', tC: null, component: null },
              ],
            },
            {
              host: '192.168.30.21',
              ok: true,
              sensors: [
                { addr: '40:255:100:6:199:204:149:177', tC: 24.5, component: 'temperature:100' },
                { addr: '40:255:100:6:199:204:149:178', tC: 22.3, component: 'temperature:101' },
                { addr: '40:255:100:6:199:204:149:179', tC: null, component: null },
              ],
            },
          ],
        }),
      });
    });
  });

  // Helper: navigate to sensors view (force live-only visibility for test env)
  async function goToSensors(page) {
    await page.goto('/playground/');
    // Wait for the app to initialize
    await page.waitForSelector('.sidebar-nav');
    // The sensor-config UI is now part of the merged Device view.
    await page.evaluate(() => {
      document.querySelectorAll('.live-only').forEach(el => el.style.display = '');
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      var deviceView = document.getElementById('view-device');
      if (deviceView) deviceView.classList.add('active');
      document.querySelectorAll('[data-view]').forEach(l => l.classList.remove('active'));
      document.querySelectorAll('[data-view="device"]').forEach(l => l.classList.add('active'));
      window.location.hash = 'device';
    });
    await page.waitForSelector('#sensors-content .card', { timeout: 15000 });
  }

  // Helper: go to sensors view and trigger a scan
  async function goToSensorsAndScan(page) {
    await goToSensors(page);
    await page.click('#btn-scan-sensors');
    await page.waitForSelector('.sensor-table', { timeout: 15000 });
  }

  test('initial render shows "not yet scanned" hint, not stale "Scanning..." text', async ({ page }) => {
    let discoveryCallCount = 0;
    await page.route('**/api/sensor-discovery', async (route) => {
      discoveryCallCount++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'disc-mock', results: [] }) });
    });
    await goToSensors(page);

    // The Detected Sensors panel must NOT show "Scanning..." before any scan is triggered.
    const detectedCard = page.locator('#sensors-content .card', { hasText: 'Detected Sensors' });
    await expect(detectedCard).not.toContainText('Scanning');
    // It should give the user a hint to start a scan instead.
    await expect(detectedCard).toContainText(/not yet scanned|click scan|scan sensors/i);
    expect(discoveryCallCount).toBe(0);
  });

  test('save with no changes does not call PUT or bump version', async ({ page }) => {
    let putCallCount = 0;
    await page.route('**/api/sensor-config', async (route) => {
      if (route.request().method() === 'PUT') {
        putCallCount++;
        await route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ hosts: [], assignments: {}, version: 999 }) });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({
            hosts: [
              { id: 'sensor_1', ip: '192.168.30.20', name: 'Sensor Hub 1' },
              { id: 'sensor_2', ip: '192.168.30.21', name: 'Sensor Hub 2' },
            ],
            assignments: {},
            version: 5,
          }),
        });
      }
    });

    await goToSensors(page);

    // Click Save without changing anything
    await page.click('#btn-save-sensors');
    await page.waitForTimeout(500);

    expect(putCallCount, 'no-op save should not call PUT').toBe(0);
    // Version should remain unchanged on screen
    await expect(page.locator('#sensors-content')).toContainText('Version: 5');
  });

  test('required and optional sensor roles are visually distinguishable', async ({ page }) => {
    await goToSensors(page);

    // Required roles should have a "required" indicator (badge, asterisk, or class)
    const collectorRow = page.locator('.sensor-role-row', { hasText: 'Collector Outlet' });
    const radiatorInletRow = page.locator('.sensor-role-row', { hasText: 'Radiator Inlet' });

    // Required role: data-required="true" attribute or "required" class
    await expect(collectorRow).toHaveAttribute('data-required', 'true');
    // Optional role: NOT data-required="true"
    const radInReq = await radiatorInletRow.getAttribute('data-required');
    expect(radInReq).not.toBe('true');
  });

  test('loads sensors view and shows sensor hosts without auto-scanning', async ({ page }) => {
    let discoveryCallCount = 0;
    await page.route('**/api/sensor-discovery', async (route) => {
      discoveryCallCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: 'disc-mock', results: [] }),
      });
    });

    await goToSensors(page);

    // Should show sensor roles section
    await expect(page.locator('text=Sensor Roles')).toBeVisible();

    // Should show detected sensors section
    await expect(page.locator('text=Detected Sensors')).toBeVisible();

    // Should show both sensor host names
    await expect(page.locator('text=Sensor Hub 1')).toBeVisible();
    await expect(page.locator('text=Sensor Hub 2')).toBeVisible();

    // No discovery request should have been made
    expect(discoveryCallCount).toBe(0);
  });

  test('displays detected sensors with addresses and temperatures after scan', async ({ page }) => {
    await goToSensorsAndScan(page);

    // Should show sensor addresses (from mock, same 3 sensors returned by both hosts)
    await expect(page.locator('td:has-text("40:255:100:6:199:204:149:177")').first()).toBeVisible();

    // Should show temperature readings
    await expect(page.locator('td:has-text("24.5")').first()).toBeVisible();
  });

  test('shows role assignment dropdowns after scan', async ({ page }) => {
    await goToSensorsAndScan(page);

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

    await goToSensorsAndScan(page);

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

  test('auto-assigns unique component IDs when unbound probes are picked', async ({ page }) => {
    // Regression — users were getting "Duplicate component ID 100 on host 0"
    // because every unbound probe's <option> baked in componentId=100. Fix:
    // collectAssignments resolves cids at save time, reusing existing
    // bindings and filling the rest with the smallest free slot per host.
    let putBody = null;
    await page.route('**/api/sensor-config', async (route) => {
      if (route.request().method() === 'PUT') {
        putBody = JSON.parse(route.request().postData());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ hosts: [], assignments: putBody.assignments, version: 1 }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            hosts: [{ id: 'sensor_1', ip: '192.168.30.20', name: 'Sensor Hub 1' }],
            assignments: {},
            version: 0,
          }),
        });
      }
    });
    await page.route('**/api/sensor-discovery', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'disc-mock',
          results: [{
            host: '192.168.30.20',
            ok: true,
            sensors: [
              // Already bound: cid 100
              { addr: 'aa:01', tC: 55.8, component: 'temperature:100' },
              // Unbound probes — the bug was that both would default to cid 100
              { addr: 'bb:02', tC: null, component: null },
              { addr: 'cc:03', tC: null, component: null },
            ],
          }],
        }),
      });
    });

    await goToSensorsAndScan(page);

    // Probe aa:01 → collector (should keep its existing cid 100).
    // Probe bb:02 → tank_top (unbound — should get next free cid, not 100 again).
    // Probe cc:03 → tank_bottom (unbound — should get yet another free cid).
    await page.locator('[data-role="collector"]').selectOption('aa:01|0');
    await page.locator('[data-role="tank_top"]').selectOption('bb:02|0');
    await page.locator('[data-role="tank_bottom"]').selectOption('cc:03|0');

    await page.click('#btn-save-sensors');
    await expect.poll(() => putBody).not.toBeNull();

    const a = putBody.assignments;
    expect(a.collector.componentId).toBe(100);
    const cids = [a.collector.componentId, a.tank_top.componentId, a.tank_bottom.componentId];
    expect(new Set(cids).size).toBe(3);  // all distinct
    for (const cid of cids) {
      expect(cid).toBeGreaterThanOrEqual(100);
      expect(cid).toBeLessThanOrEqual(199);
    }
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
