// @ts-check
import { test, expect } from './fixtures.js';

const MOBILE = { width: 375, height: 812 };

test.describe('Simulation-only mode overlays (GitHub Pages context)', () => {
  test('connection overlays are hidden in simulation-only mode', async ({ page }) => {
    // ?mode=sim forces simulation-only mode (same as GitHub Pages)
    await page.goto('/playground/?mode=sim');
    // Overlays are toggled inside the async init() pipeline (initModeToggle
    // → switchToSimulation → updateConnectionOverlays). Wait for init to
    // finish so the assertion isn't racing the boot path.
    await page.waitForFunction(() => window.__initComplete === true);
    // No connection overlay should appear — simulation mode doesn't need a server
    await expect(page.locator('#overlay-modes')).not.toBeVisible();
    await expect(page.locator('#overlay-gauge')).not.toBeVisible();
    await expect(page.locator('#overlay-components')).not.toBeVisible();
  });
});

test.describe('Settings visibility on GitHub Pages', () => {
  test('Settings nav is hidden when isLiveCapable is false', async ({ page }) => {
    await page.goto('/playground/');
    // The store mutation below relies on initSubscriptions having wired the
    // phase subscriber. __initComplete fires only after init() has run end
    // to end, so this is the safe gate.
    await page.waitForFunction(() => window.__initComplete === true);
    // We can't fake location.hostname reliably across browsers, so stub the
    // store value after boot and re-fire the phase subscription to refresh
    // nav visibility. Setting phase to the same value is a no-op in the
    // store, so toggle through a throwaway value first.
    await page.evaluate(async () => {
      const { store } = await import('/playground/js/app-state.js');
      store.set('isLiveCapable', false);
      const phase = store.get('phase');
      store.set('phase', '__refresh__');
      store.set('phase', phase);
    });
    // The Settings anchor stays in the DOM (HTML unchanged) but must be hidden
    await expect(page.locator('.sidebar-nav [data-view="settings"]')).toBeHidden();
    await expect(page.locator('.bottom-nav [data-view="settings"]')).toBeHidden();
    // Navigating directly via hash falls back to status
    await page.evaluate(() => { window.location.hash = 'settings'; });
    await page.waitForTimeout(200);
    await expect(page.locator('#view-status')).toHaveClass(/active/);
  });

  test('Settings nav is visible on localhost (live-capable)', async ({ page }) => {
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await expect(page.locator('.sidebar-nav [data-view="settings"]')).toBeVisible();
  });
});

test.describe('Mobile: mode toggle visibility', () => {
  test('mode toggle is visible at mobile viewport width', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/');
    // Mode toggle must be accessible on mobile, not hidden inside the sidebar
    await expect(page.locator('#mode-toggle')).toBeVisible();
  });

  test('connection status indicator is visible at mobile viewport width', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/');
    await expect(page.locator('#connection-status')).toBeVisible();
  });

  test('status bar does not obstruct page content on mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/');
    // The status bar must be a compact strip, not covering a large portion of the viewport
    const barBox = await page.locator('#status-bar').boundingBox();
    expect(barBox).not.toBeNull();
    // Height should be a thin strip — no more than 60px (padding + one row of controls)
    expect(barBox.height).toBeLessThanOrEqual(60);
    // Width must be full viewport width, not sidebar width
    expect(barBox.width).toBeGreaterThanOrEqual(MOBILE.width - 1);
  });

  test('page content below status bar is interactable on mobile', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/');
    // Nav links have no href — the click handler is wired inside async init().
    await page.waitForFunction(() => window.__initComplete === true);
    // Bottom nav links must be clickable without interception from the status bar
    await page.locator('.bottom-nav [data-view="components"]').click();
    await expect(page.locator('#view-components')).toHaveClass(/active/);
    // Navigate back — confirms the nav is fully functional
    await page.locator('.bottom-nav [data-view="status"]').click();
    await expect(page.locator('#view-status')).toHaveClass(/active/);
  });
});

test.describe('Mobile: Device view does not overflow horizontally', () => {
  test('device config form does not cause horizontal scroll', async ({ page }) => {
    await page.setViewportSize(MOBILE);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    // Navigate to Device view via bottom nav (available in live mode on localhost)
    await page.locator('.bottom-nav [data-view="device"]').click();
    // Force-show the config form (normally hidden until API loads config)
    await page.evaluate(() => {
      const form = document.getElementById('device-config-form');
      if (form) form.style.display = '';
    });
    await page.waitForTimeout(200);
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  });
});

// ── Mobile relay override tests ──

/** Mock WS with send capture and message injection, same as device-config.spec.js */
async function mockLiveConnectionWithRelay(page, stateOverrides) {
  await page.addInitScript((overrides) => {
    const OrigWS = window.WebSocket;
    window.__wsSent = [];
    // @ts-ignore
    window.WebSocket = function() {
      const fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function() { this.readyState = 3; },
        send: function(data) { try { window.__wsSent.push(JSON.parse(data)); } catch(e) {} },
      };
      window.__mockWs = fake;
      window.__wsInject = function(msg) {
        if (fake.onmessage) fake.onmessage({ data: JSON.stringify(msg) });
      };
      const stateData = Object.assign({
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

/** Set up relay override tests at mobile viewport: mock WS, mock APIs, navigate via bottom nav. */
async function setupMobileRelayView(page, stateOverrides) {
  await page.setViewportSize(MOBILE);
  await mockLiveConnectionWithRelay(page, stateOverrides);

  await page.route('**/api/device-config', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ ce: true, ea: 31, fm: null, am: null, v: 1 }),
      });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));

  await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
  // Wait for live connection
  await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });
  // Navigate via bottom nav (sidebar is hidden on mobile)
  await page.locator('.bottom-nav [data-view="device"]').click();
  await expect(page.locator('#device-config-form')).toBeVisible();
}

test.describe('Mobile: relay override UI', () => {

  test('override enter button is clickable on mobile', async ({ page }) => {
    page.on('dialog', d => d.accept());
    await setupMobileRelayView(page);
    const btn = page.locator('#override-enter-btn');
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();
    // Must be clickable — not intercepted by any overlay or status bar
    await btn.click();
    await expect(btn).toContainText('Connecting');
    const sent = await page.evaluate(() => window.__wsSent);
    expect(sent.find(m => m.type === 'override-enter')).toBeTruthy();
  });

  test('relay board buttons are clickable on mobile', async ({ page }) => {
    page.on('dialog', d => d.accept());
    await setupMobileRelayView(page);
    // Enter override
    await page.locator('#override-enter-btn').click();
    // Simulate server ack
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, ttl: 300, expiresAt: Date.now() + 300000 });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    // Click a relay button — must not be intercepted by status bar or other overlays
    const pumpBtn = page.locator('.relay-btn[data-relay="pump"]');
    await expect(pumpBtn).toBeEnabled();
    await pumpBtn.click();

    const sent = await page.evaluate(() => window.__wsSent);
    const relayCmd = sent.find(m => m.type === 'relay-command');
    expect(relayCmd).toBeTruthy();
    expect(relayCmd.relay).toBe('pump');
  });

  test('relay board fits within viewport on mobile without horizontal scroll', async ({ page }) => {
    await setupMobileRelayView(page);
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, ttl: 300, expiresAt: Date.now() + 300000 });
    });
    await expect(page.locator('#relay-board')).toBeVisible();

    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(overflow).toBe(false);
  });

  test('exit override button is clickable on mobile', async ({ page }) => {
    await setupMobileRelayView(page);
    await page.locator('#override-enter-btn').click();
    await page.evaluate(() => {
      window.__wsInject({ type: 'override-ack', active: true, ttl: 300, expiresAt: Date.now() + 300000 });
    });

    const exitBtn = page.locator('#override-exit-btn');
    await expect(exitBtn).toBeVisible();
    await exitBtn.click();

    const sent = await page.evaluate(() => window.__wsSent);
    expect(sent.find(m => m.type === 'override-exit')).toBeTruthy();
  });
});
