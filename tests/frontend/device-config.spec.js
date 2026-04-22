// @ts-check
import { test, expect } from './fixtures.js';

/**
 * E2E tests for the Device config management UI.
 *
 * The playground runs on a static file server (no real API), so we mock
 * the /api/device-config endpoint with page.route() and capture PUT
 * requests to verify the UI produces the correct compact config format.
 */

const DEFAULT_CONFIG = { ce: false, ea: 0, fm: null, we: {}, wz: {}, wb: {}, v: 1 };
const WB_PERMANENT_SENTINEL = 9999999999;

/** Mock WebSocket so the app sees a stable live connection with state data. */
async function mockLiveConnection(page) {
  await page.addInitScript(() => {
    var OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function() {
      var fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function() { this.readyState = 3; },
        send: function() {},
      };
      setTimeout(function() {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({
            type: 'state',
            data: { mode: 'idle', temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
              valves: {}, actuators: { pump: false, fan: false, space_heater: false }, controls_enabled: true }
          }) });
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
  });
}

/** Set up API mock and navigate to device view. */
async function setupDeviceView(page, initialConfig) {
  const config = { ...DEFAULT_CONFIG, ...initialConfig };
  let savedConfig = { ...config };
  const putRequests = [];

  // Mock WebSocket so connection is stable and save button stays enabled
  await mockLiveConnection(page);

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
      // Simulate server: merge fields, bump version. Partial-update
      // semantics for wb/we/wz match server/lib/device-config.js.
      if (body.ce !== undefined) savedConfig.ce = body.ce;
      if (body.ea !== undefined) savedConfig.ea = body.ea;
      if (body.fm !== undefined) savedConfig.fm = body.fm;
      if (body.wb !== undefined) {
        savedConfig.wb = savedConfig.wb || {};
        if (body.wb === null) savedConfig.wb = {};
        else for (const k of Object.keys(body.wb)) {
          const v = body.wb[k];
          if (v === 0 || v === null) delete savedConfig.wb[k];
          else savedConfig.wb[k] = v;
        }
      }
      if (body.we !== undefined) {
        if (body.we === null) savedConfig.we = {};
        else savedConfig.we = { ...savedConfig.we, ...body.we };
      }
      if (body.wz !== undefined) {
        savedConfig.wz = savedConfig.wz || {};
        if (body.wz === null) savedConfig.wz = {};
        else for (const k of Object.keys(body.wz)) {
          const v = body.wz[k];
          if (v === 0 || v === null) delete savedConfig.wz[k];
          else savedConfig.wz[k] = v;
        }
      }
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
  await expect(page.locator('#mode-toggle')).toBeVisible();

  // Navigate to Device view
  const deviceNav = page.locator('.sidebar-nav [data-view="device"]');
  await expect(deviceNav).toBeVisible();
  await deviceNav.click();

  // Wait for form to load
  await expect(page.locator('#device-config-form')).toBeVisible();

  return { putRequests, getConfig: () => ({ ...savedConfig }) };
}

// ── Relay Toggle Board helpers ──

/**
 * Mock WebSocket with send capture and dynamic message injection.
 * Stores sent messages in window.__wsSent and allows injecting responses
 * via window.__wsInject(msg).
 */
async function mockLiveConnectionWithRelay(page, stateOverrides) {
  await page.addInitScript((overrides) => {
    var OrigWS = window.WebSocket;
    window.__wsSent = [];
    // @ts-ignore
    window.WebSocket = function() {
      var fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function() { this.readyState = 3; },
        send: function(data) { try { window.__wsSent.push(JSON.parse(data)); } catch(e) {} },
      };
      window.__mockWs = fake;
      window.__wsInject = function(msg) {
        if (fake.onmessage) fake.onmessage({ data: JSON.stringify(msg) });
      };
      var stateData = Object.assign({
        mode: 'idle',
        temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
        valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false },
        controls_enabled: true,
        manual_override: null,
      }, overrides || {});
      setTimeout(function() {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({ type: 'state', data: stateData }) });
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  }, stateOverrides);
}

/** Set up relay override tests: mock WS, mock APIs, navigate to device view. */
async function setupRelayView(page, stateOverrides) {
  // Hard-override confirmation dialog (2026-04-21). Auto-accept so
  // the click path proceeds in every test that enters override.
  page.on('dialog', d => d.accept());
  await mockLiveConnectionWithRelay(page, stateOverrides);

  await page.route('**/api/device-config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }),
      });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));

  await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#mode-toggle')).toBeVisible();
  // Wait for live connection to be established (state data received)
  await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });
  await page.locator('.sidebar-nav [data-view="device"]').click();
  await expect(page.locator('#device-config-form')).toBeVisible();
}

test.describe('Relay toggle board', () => {

  test('override button visible and enabled when controls enabled', async ({ page }) => {
    await setupRelayView(page);

    const btn = page.locator('#override-enter-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
  });

  test('override button disabled when controls not enabled', async ({ page }) => {
    await setupRelayView(page, { controls_enabled: false });

    const btn = page.locator('#override-enter-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();

    // Gate message visible
    await expect(page.locator('#override-gate-msg')).toBeVisible();
    await expect(page.locator('#override-gate-msg')).toContainText('Controls Enabled');
  });

  test('clicking enter override sends WebSocket command', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();

    await page.locator('#override-enter-btn').click();
    await expect(page.locator('#override-enter-btn')).toContainText('Connecting');

    const sent = await page.evaluate(() => window.__wsSent);
    const enterCmd = sent.find(m => m.type === 'override-enter');
    expect(enterCmd).toBeTruthy();
    expect(enterCmd.ttl).toBe(300);
    expect(enterCmd.forcedMode).toBe('I');
  });

  test('toggle board appears on override-ack', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();

    await page.locator('#override-enter-btn').click();

    // Simulate server ack
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });

    // Board and relay buttons visible
    await expect(page.locator('#relay-board')).toBeVisible();
    const buttons = page.locator('.relay-btn');
    await expect(buttons).toHaveCount(9);

    // All buttons enabled
    for (const btn of await buttons.all()) {
      await expect(btn).toBeEnabled();
    }
  });

  test('relay buttons show correct labels', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    // Check a few labels
    await expect(page.locator('.relay-btn[data-relay="pump"] .relay-label')).toHaveText('Pump');
    await expect(page.locator('.relay-btn[data-relay="vi_btm"] .relay-label')).toHaveText('Tank Btm In');
    await expect(page.locator('.relay-btn[data-relay="v_air"] .relay-label')).toHaveText('Air Intake');

    // Check technical IDs
    await expect(page.locator('.relay-btn[data-relay="pump"] .relay-id')).toHaveText('pump');
    await expect(page.locator('.relay-btn[data-relay="vo_rad"] .relay-id')).toHaveText('vo_rad');
  });

  test('clicking relay button sends command and applies optimistic state', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    const pumpBtn = page.locator('.relay-btn[data-relay="pump"]');
    await expect(pumpBtn).not.toHaveClass(/\bon\b/);

    // Click pump
    await pumpBtn.click();

    // Optimistic: button should show ON + pending
    await expect(pumpBtn).toHaveClass(/\bon\b/);
    await expect(pumpBtn).toHaveClass(/relay-btn--pending/);

    // Verify WS command sent
    const sent = await page.evaluate(() => window.__wsSent);
    const relayCmd = sent.find(m => m.type === 'relay-command');
    expect(relayCmd).toBeTruthy();
    expect(relayCmd.relay).toBe('pump');
    expect(relayCmd.on).toBe(true);
  });

  test('state broadcast confirms relay toggle and clears pending', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    const pumpBtn = page.locator('.relay-btn[data-relay="pump"]');
    await pumpBtn.click();
    await expect(pumpBtn).toHaveClass(/relay-btn--pending/);

    // Simulate state broadcast confirming pump is on
    await page.evaluate(() => {
      window.__wsInject({ type: 'state', data: {
        mode: 'idle', temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
        valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: true, fan: false, space_heater: false },
        controls_enabled: true,
        manual_override: { active: true, expiresAt: Math.floor(Date.now()/1000) + 300, },
      }});
    });

    // Pending cleared, still ON
    await expect(pumpBtn).toHaveClass(/\bon\b/);
    await expect(pumpBtn).not.toHaveClass(/relay-btn--pending/);
  });

  test('state broadcast contradiction triggers shake animation', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    const fanBtn = page.locator('.relay-btn[data-relay="fan"]');
    await fanBtn.click();
    await expect(fanBtn).toHaveClass(/\bon\b/);

    // State broadcast says fan is still OFF (command failed)
    await page.evaluate(() => {
      window.__wsInject({ type: 'state', data: {
        mode: 'idle', temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
        valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false },
        controls_enabled: true,
        manual_override: { active: true, expiresAt: Math.floor(Date.now()/1000) + 300, },
      }});
    });

    // Button reverted to OFF with error animation
    await expect(fanBtn).not.toHaveClass(/\bon\b/);
    await expect(fanBtn).toHaveClass(/relay-btn--error/);

    // Error class removed after animation
    await expect(fanBtn).not.toHaveClass(/relay-btn--error/, { timeout: 1000 });
  });

  test('countdown timer visible during override', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });

    const countdown = page.locator('#override-countdown');
    await expect(countdown).toBeVisible();
    // Should show ~5:00 or 4:59
    await expect(countdown).toContainText(/[45]:\d\d/);
  });

  test('TTL buttons visible and send override-update', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });

    const ttlBtns = page.locator('.ttl-btn');
    await expect(ttlBtns).toHaveCount(5);

    // Click 15 min button
    await page.locator('.ttl-btn[data-ttl="900"]').click();

    const sent = await page.evaluate(() => window.__wsSent);
    const updateCmd = sent.find(m => m.type === 'override-update');
    expect(updateCmd).toBeTruthy();
    expect(updateCmd.ttl).toBe(900);
  });

  test('exit button sends override-exit and deactivates board', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    // Click exit
    await page.locator('#override-exit-btn').click();

    const sent = await page.evaluate(() => window.__wsSent);
    const exitCmd = sent.find(m => m.type === 'override-exit');
    expect(exitCmd).toBeTruthy();

    // Simulate ack
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: false });
    });

    // Board hidden, entry controls visible
    await expect(page.locator('#relay-board')).not.toBeVisible();
    await expect(page.locator('#override-entry')).toBeVisible();
  });

  test('after exit, enter button text resets and re-enables immediately (no 30s wait)', async ({ page }) => {
    // Regression: previously the button stayed at "Connecting..." disabled
    // until the next state broadcast (~30s), making it look broken.
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();

    // Enter override
    await page.locator('#override-enter-btn').click();
    await expect(page.locator('#override-enter-btn')).toContainText('Connecting');
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    // Exit override
    await page.locator('#override-exit-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: false });
    });

    // Without any further state broadcast: button text should be reset and enabled.
    const enterBtn = page.locator('#override-enter-btn');
    await expect(enterBtn).toHaveText('Enter Manual Override');
    await expect(enterBtn).toBeEnabled();
  });

  test('entry select sends the chosen forcedMode', async ({ page }) => {
    // Replaces the old "suppress safety toggle" test. As of
    // 2026-04-21 override is always hard; `ss` is gone and the entry
    // UI is now a mode <select>. This checks the send path.
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-entry-fm').selectOption('AD');

    await page.locator('#override-enter-btn').click();
    await expect(page.locator('#override-enter-btn')).toContainText('Connecting');

    const sent = await page.evaluate(() => window.__wsSent);
    const enterCmd = sent.find(m => m.type === 'override-enter');
    expect(enterCmd).toBeTruthy();
    expect(enterCmd.forcedMode).toBe('AD');
  });

  test('board deactivates when override ends externally via state broadcast', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    // State broadcast with manual_override: null (override ended externally)
    await page.evaluate(() => {
      window.__wsInject({ type: 'state', data: {
        mode: 'idle', temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
        valves: {}, actuators: { pump: false, fan: false, space_heater: false },
        controls_enabled: true, manual_override: null,
      }});
    });

    await expect(page.locator('#relay-board')).not.toBeVisible();
    await expect(page.locator('#override-entry')).toBeVisible();
  });

  test('controls disabled during override forces deactivation', async ({ page }) => {
    await setupRelayView(page);
    await expect(page.locator('#override-enter-btn')).toBeEnabled();
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, expiresAt: Math.floor(Date.now()/1000) + 300, });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    // State broadcast with controls_enabled: false
    await page.evaluate(() => {
      window.__wsInject({ type: 'state', data: {
        mode: 'idle', temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
        valves: {}, actuators: { pump: false, fan: false, space_heater: false },
        controls_enabled: false, manual_override: null,
      }});
    });

    await expect(page.locator('#relay-board')).not.toBeVisible();
    await expect(page.locator('#override-enter-btn')).toBeDisabled();
  });

});

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

    // Mode enablement card: with empty wb, all 5 modes show as "allowed"
    const rows = page.locator('.mode-enablement-row');
    await expect(rows).toHaveCount(5);
    const allowedCells = page.locator('.mode-allowed');
    await expect(allowedCells).toHaveCount(5);

    // Version display
    await expect(page.locator('#dc-version')).toHaveText('1');
  });

  test('loads pre-existing config correctly', async ({ page }) => {
    await setupDeviceView(page, {
      ce: true,
      ea: 3, // valves + pump
      fm: 'SC',
      // GH, AD, EH permanently disabled via wb sentinel
      wb: {
        GH: WB_PERMANENT_SENTINEL,
        AD: WB_PERMANENT_SENTINEL,
        EH: WB_PERMANENT_SENTINEL,
      },
      v: 5,
    });

    await expect(page.locator('#dc-ce')).toHaveClass(/active/);
    await expect(page.locator('#dc-ea-v')).toHaveClass(/active/);  // bit 1
    await expect(page.locator('#dc-ea-p')).toHaveClass(/active/);  // bit 2
    await expect(page.locator('#dc-ea-f')).not.toHaveClass(/active/);
    await expect(page.locator('#dc-ea-sh')).not.toHaveClass(/active/);
    await expect(page.locator('#dc-ea-ih')).not.toHaveClass(/active/);
    // I and SC show as allowed; GH/AD/EH show as disabled-by-user
    await expect(page.locator('.mode-allowed')).toHaveCount(2);
    await expect(page.locator('.mode-disabled')).toHaveCount(3);
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
    // am is no longer sent from the Save button — mode bans live
    // exclusively in wb, edited via the Mode Enablement card.
    expect(putRequests[0].am).toBeUndefined();
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

  test('Mode Override block is removed from the device-config card', async ({ page }) => {
    await page.goto('/#controls');
    await expect(page.locator('#dc-fm')).toHaveCount(0);
  });

  test('Disable button on Mode Enablement card sends wb sentinel', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page);

    // Click the Disable button on the GREENHOUSE_HEATING row
    const ghRow = page.locator('.mode-enablement-row').filter({ hasText: 'GREENHOUSE_HEATING' });
    await ghRow.locator('button').click();

    // Wait for the PUT to complete
    await expect.poll(() => putRequests.length).toBeGreaterThan(0);
    const body = putRequests[0];
    expect(body.wb).toBeDefined();
    expect(body.wb.GH).toBe(WB_PERMANENT_SENTINEL);
  });

  test('Re-enable button removes wb sentinel', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page, {
      wb: { GH: WB_PERMANENT_SENTINEL }
    });

    // Wait for the Mode Enablement card to show GH as disabled
    await expect(page.locator('.mode-disabled')).toHaveCount(1);

    // Click the Re-enable button on the GH row
    const ghRow = page.locator('.mode-enablement-row').filter({ hasText: 'GREENHOUSE_HEATING' });
    await ghRow.locator('button').click();

    await expect.poll(() => putRequests.length).toBeGreaterThan(0);
    const body = putRequests[0];
    expect(body.wb).toBeDefined();
    expect(body.wb.GH).toBe(0); // 0 means "remove this entry"
  });

  test('full scenario: staged deployment step 5 config', async ({ page }) => {
    const { putRequests } = await setupDeviceView(page);

    // Enable controls
    await page.locator('#dc-ce').click();
    // Enable valves + pump only
    await page.locator('#dc-ea-v').click();
    await page.locator('#dc-ea-p').click();
    // No forced mode (leave as Automatic)

    // Save — ce/ea/fm only. Mode bans are edited separately.
    await page.locator('#dc-save').click();
    await expect(page.locator('#dc-status')).toContainText('Saved');

    const sent = putRequests[0];
    expect(sent.ce).toBe(true);
    expect(sent.ea).toBe(3); // valves(1) + pump(2)
    // fm (forced mode) is no longer sent from Save — it's set via the
    // manual-override card flow, not the device-config form.
    expect(sent.fm).toBeUndefined();
    expect(sent.am).toBeUndefined();

    // Verify the saved config still fits in KVS (256-byte limit)
    const size = JSON.stringify(sent).length;
    expect(size).toBeLessThanOrEqual(256);
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
    await expect(page.locator('#mode-toggle')).toBeVisible();

    // In live mode (default on localhost), Device nav is visible
    const deviceNav = page.locator('.sidebar-nav [data-view="device"]');
    await expect(deviceNav).toBeVisible();

    // Switch to simulation mode
    await page.locator('#mode-toggle-switch').click();

    // Device nav should be hidden
    await expect(deviceNav).not.toBeVisible();
  });
});
