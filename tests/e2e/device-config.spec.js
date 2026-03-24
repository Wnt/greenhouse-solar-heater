// @ts-check
import { test, expect } from './fixtures.js';

/**
 * E2E tests for the Device config management UI.
 *
 * The playground runs on a static file server (no real API), so we mock
 * the /api/device-config endpoint with page.route() and capture PUT
 * requests to verify the UI produces the correct compact config format.
 */

const DEFAULT_CONFIG = { ce: false, ea: 0, fm: null, am: null, v: 1 };

/** Set up API mock and navigate to device view. */
async function setupDeviceView(page, initialConfig) {
  const config = { ...DEFAULT_CONFIG, ...initialConfig };
  let savedConfig = { ...config };
  const putRequests = [];

  // Mock GET /api/device-config
  await page.route('**/api/device-config', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(savedConfig),
      });
    } else if (method === 'PUT') {
      const body = route.request().postDataJSON();
      putRequests.push(body);
      // Simulate server: merge fields, bump version
      if (body.ce !== undefined) savedConfig.ce = body.ce;
      if (body.ea !== undefined) savedConfig.ea = body.ea;
      if (body.fm !== undefined) savedConfig.fm = body.fm;
      if (body.am !== undefined) savedConfig.am = body.am;
      savedConfig.v = (savedConfig.v || 0) + 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(savedConfig),
      });
    } else {
      await route.continue();
    }
  });

  // Mock other API endpoints to prevent hangs
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));

  await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
  // Wait for live mode to activate (localhost is live-capable)
  await expect(page.locator('#mode-toggle')).toBeVisible({ timeout: 10000 });

  // Navigate to Device view
  const deviceNav = page.locator('.sidebar-nav [data-view="device"]');
  await expect(deviceNav).toBeVisible({ timeout: 10000 });
  await deviceNav.click();

  // Wait for form to load
  await expect(page.locator('#device-config-form')).toBeVisible({ timeout: 5000 });

  return { putRequests, getConfig: () => ({ ...savedConfig }) };
}

test.describe('Device config UI', () => {

  test('loads and displays default config', async ({ page }) => {
    await setupDeviceView(page);

    // Controls enabled toggle should be OFF (default ce: false)
    const ceToggle = page.locator('#dc-ce');
    await expect(ceToggle).toBeVisible();
    await expect(ceToggle).not.toHaveClass(/active/);

    // All actuator toggles should be OFF (ea: 0)
    for (const id of ['dc-ea-v', 'dc-ea-p', 'dc-ea-f', 'dc-ea-sh', 'dc-ea-ih']) {
      await expect(page.locator('#' + id)).not.toHaveClass(/active/);
    }

    // Forced mode should be "Automatic"
    await expect(page.locator('#dc-fm')).toHaveValue('');

    // All allowed modes checkboxes should be checked (am: null = all)
    for (const code of ['I', 'SC', 'GH', 'AD', 'EH']) {
      await expect(page.locator('#dc-am-' + code)).toBeChecked();
    }

    // Version display
    await expect(page.locator('#dc-version')).toHaveText('1');
  });

  test('loads pre-existing config correctly', async ({ page }) => {
    await setupDeviceView(page, {
      ce: true,
      ea: 3, // valves + pump
      fm: 'SC',
      am: ['I', 'SC'],
      v: 5,
    });

    await expect(page.locator('#dc-ce')).toHaveClass(/active/);
    await expect(page.locator('#dc-ea-v')).toHaveClass(/active/);  // bit 1
    await expect(page.locator('#dc-ea-p')).toHaveClass(/active/);  // bit 2
    await expect(page.locator('#dc-ea-f')).not.toHaveClass(/active/);
    await expect(page.locator('#dc-ea-sh')).not.toHaveClass(/active/);
    await expect(page.locator('#dc-ea-ih')).not.toHaveClass(/active/);
    await expect(page.locator('#dc-fm')).toHaveValue('SC');
    await expect(page.locator('#dc-am-I')).toBeChecked();
    await expect(page.locator('#dc-am-SC')).toBeChecked();
    await expect(page.locator('#dc-am-GH')).not.toBeChecked();
    await expect(page.locator('#dc-am-AD')).not.toBeChecked();
    await expect(page.locator('#dc-am-EH')).not.toBeChecked();
    await expect(page.locator('#dc-version')).toHaveText('5');
  });

  test('toggle switches produce correct ea bitmask on save', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page);

    // Enable controls
    await page.locator('#dc-ce').click();
    // Enable valves (1) + pump (2) + fan (4) = 7
    await page.locator('#dc-ea-v').click();
    await page.locator('#dc-ea-p').click();
    await page.locator('#dc-ea-f').click();

    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    expect(putRequests).toHaveLength(1);
    expect(putRequests[0].ce).toBe(true);
    expect(putRequests[0].ea).toBe(7); // 1 + 2 + 4
    expect(putRequests[0].fm).toBeNull();
    expect(putRequests[0].am).toBeNull(); // all checked = null
  });

  test('all actuators toggled = ea 31', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page);

    await page.locator('#dc-ce').click();
    await page.locator('#dc-ea-v').click();
    await page.locator('#dc-ea-p').click();
    await page.locator('#dc-ea-f').click();
    await page.locator('#dc-ea-sh').click();
    await page.locator('#dc-ea-ih').click();

    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    expect(putRequests[0].ea).toBe(31);
  });

  test('forced mode dropdown sends correct code', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page);

    await page.locator('#dc-ce').click();
    await page.locator('#dc-fm').selectOption('GH');

    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    expect(putRequests[0].fm).toBe('GH');
  });

  test('forced mode "Automatic" sends null', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page, { fm: 'SC' });

    // Change from SC back to Automatic
    await page.locator('#dc-fm').selectOption('');

    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    expect(putRequests[0].fm).toBeNull();
  });

  test('unchecking allowed modes sends array of checked codes', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page);

    // Uncheck GH, AD, EH — leaving only I and SC
    await page.locator('#dc-am-GH').uncheck();
    await page.locator('#dc-am-AD').uncheck();
    await page.locator('#dc-am-EH').uncheck();

    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    expect(putRequests[0].am).toEqual(['I', 'SC']);
  });

  test('all modes checked sends null (unrestricted)', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page, { am: ['I', 'SC'] });

    // Re-check all the unchecked modes (GH, AD, EH were unchecked in initial config)
    await page.locator('#dc-am-GH').check();
    await page.locator('#dc-am-AD').check();
    await page.locator('#dc-am-EH').check();

    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    expect(putRequests[0].am).toBeNull();
  });

  test('full scenario: staged deployment step 5 config', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page);

    // Enable controls
    await page.locator('#dc-ce').click();
    // Enable valves + pump only
    await page.locator('#dc-ea-v').click();
    await page.locator('#dc-ea-p').click();
    // Allow only Idle + Solar Charging
    await page.locator('#dc-am-GH').uncheck();
    await page.locator('#dc-am-AD').uncheck();
    await page.locator('#dc-am-EH').uncheck();
    // No forced mode (leave as Automatic)

    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    const sent = putRequests[0];
    expect(sent.ce).toBe(true);
    expect(sent.ea).toBe(3); // valves(1) + pump(2)
    expect(sent.fm).toBeNull();
    expect(sent.am).toEqual(['I', 'SC']);

    // Verify it fits in KVS
    const size = JSON.stringify(sent).length;
    expect(size).toBeLessThanOrEqual(64);
  });

  test('version and size update after save', async ({ page }) => {
    await setupDeviceView(page, { v: 3 });

    await page.locator('#dc-ce').click();
    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    // Version should increment from 3 to 4
    await expect(page.locator('#dc-version')).toHaveText('4');
  });

  test('toggle is clickable and visually toggles', async ({ page }) => {
    await setupDeviceView(page);

    const toggle = page.locator('#dc-ea-v');
    await expect(toggle).not.toHaveClass(/active/);

    await toggle.click();
    await expect(toggle).toHaveClass(/active/);

    await toggle.click();
    await expect(toggle).not.toHaveClass(/active/);
  });

  test('device view only visible in live mode', async ({ page }) => {
    await page.route('**/api/device-config', route => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(DEFAULT_CONFIG),
    }));
    await page.route('**/api/ws', route => route.abort());
    await page.route('**/api/history**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: '[]',
    }));

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mode-toggle')).toBeVisible({ timeout: 10000 });

    // In live mode (default on localhost), Device nav is visible
    const deviceNav = page.locator('.sidebar-nav [data-view="device"]');
    await expect(deviceNav).toBeVisible();

    // Switch to simulation mode
    await page.locator('#mode-toggle-switch').click();

    // Device nav should be hidden
    await expect(deviceNav).not.toBeVisible();
  });
});
