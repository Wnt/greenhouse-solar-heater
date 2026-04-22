// @ts-check
import { test, expect } from './fixtures.js';

/**
 * E2E: script-crash banner lifecycle.
 *
 * The playground is served by a plain static file server in tests; we
 * mock the WebSocket so we can inject `script-status` broadcasts at
 * will. The banner is the key UX surface for "control script is down"
 * and must react to both broadcasts (live status changes) and the
 * initial replay the server sends on WS open.
 */

async function mockLiveConnectionWithScriptStatus(page, initialStatus) {
  await page.addInitScript((initial) => {
    const initialPayload = initial || null;
    var OrigWS = window.WebSocket;
    window.__scriptSent = [];
    // @ts-ignore
    window.WebSocket = function () {
      var fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function () { this.readyState = 3; },
        send: function (data) { try { window.__scriptSent.push(JSON.parse(data)); } catch (e) { /* ignore */ } }
      };
      window.__injectScriptStatus = function (status) {
        if (fake.onmessage) fake.onmessage({ data: JSON.stringify({ type: 'script-status', data: status }) });
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
              controls_enabled: true
            }
          }) });
          if (initialPayload) {
            fake.onmessage({ data: JSON.stringify({ type: 'script-status', data: initialPayload }) });
          }
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  }, initialStatus || null);

  // Prevent other API hangs.
  await page.route('**/api/watchdog/state', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ pending: null, watchdogs: [], snapshot: { we: {}, wz: {}, wb: {} }, recent: [] })
  }));
  await page.route('**/api/device-config', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 })
  }));
  await page.route('**/api/history**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/events**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/push/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

test.describe('script-crash banner', () => {
  test('banner is hidden when the script is running', async ({ page }) => {
    await mockLiveConnectionWithScriptStatus(page, { running: true, reachable: true });
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mode-toggle')).toBeVisible();
    // Banner stays hidden for a healthy script.
    await expect(page.locator('#script-crash-banner')).toBeHidden();
  });

  test('banner appears when a crash broadcast arrives', async ({ page }) => {
    await mockLiveConnectionWithScriptStatus(page, { running: true, reachable: true });
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mode-toggle')).toBeVisible();
    await expect(page.locator('#script-crash-banner')).toBeHidden();

    // Inject crash broadcast
    await page.evaluate(() => {
      window.__injectScriptStatus({
        running: false, reachable: true,
        error_msg: 'Uncaught Error: Too much recursion - the stack is about to overflow',
        crashId: 7,
      });
    });

    await expect(page.locator('#script-crash-banner')).toBeVisible();
    await expect(page.locator('#script-crash-banner-msg')).toContainText('Too much recursion');
    await expect(page.locator('#script-crash-banner-restart')).toBeVisible();

    // Recovery broadcast clears the banner.
    await page.evaluate(() => {
      window.__injectScriptStatus({ running: true, reachable: true, error_msg: null, crashId: null });
    });
    await expect(page.locator('#script-crash-banner')).toBeHidden();
  });

  test('restart button POSTs /api/script/restart', async ({ page }) => {
    await mockLiveConnectionWithScriptStatus(page, {
      running: false, reachable: true,
      error_msg: 'Uncaught Error: boom', crashId: 1
    });
    /** @type {Array<string>} */
    const posted = [];
    await page.route('**/api/script/restart', async (route) => {
      posted.push(route.request().method());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    });

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#script-crash-banner')).toBeVisible();
    await page.click('#script-crash-banner-restart');
    await expect.poll(() => posted.length).toBeGreaterThan(0);
    expect(posted[0]).toBe('POST');
  });
});
