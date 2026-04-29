// @ts-check
/**
 * On a PR preview deploy /api/runtime returns { preview: { pr, branch } }.
 * Three places rebrand themselves accordingly:
 *
 *   1. Sidebar subtitle "Live"        → "Preview #42"
 *   2. Mode-toggle label "Live"       → "Preview"
 *   3. Login page tagline "Solar
 *      sanctuary"                     → "Preview · #42 · branch/name"
 *
 * Prod / local / GitHub Pages deploys keep the prod copy (preview: null
 * or fetch failure).
 */
import { test, expect } from './fixtures.js';

async function installMockWs(page) {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function () { this.readyState = 3; }, send: function () {},
      };
      // @ts-ignore
      window.__mockWs = fake;
      const stateData = {
        mode: 'idle',
        temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
        valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false },
        controls_enabled: true, manual_override: null,
      };
      setTimeout(function () {
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
  });
}

async function mockEmptyHistory(page) {
  await page.route('**/api/history**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ range: '24h', points: [], events: [] }),
  }));
  await page.route('**/api/events**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ events: [], hasMore: false }),
  }));
}

test.describe('PR-preview rebranding', () => {
  test('sidebar subtitle and mode-toggle label show "Preview #<n>" / "Preview"', async ({ page }) => {
    await page.route('**/api/runtime', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ preview: { pr: 42, branch: 'feature/foo' } }),
    }));
    await mockEmptyHistory(page);
    await installMockWs(page);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // Sidebar subtitle: "Live" → "Preview #42" once the active state
    // settles (poll because the runtime fetch + connect race vary).
    await expect(page.locator('#sidebar-subtitle')).toHaveText('Preview #42', { timeout: 3000 });

    // Mode-toggle label: the live-side pill shows "Preview" instead of "Live"
    await expect(page.locator('#mode-toggle-label')).toHaveText('Preview');
  });

  test('prod (preview: null) keeps the existing "Live" copy', async ({ page }) => {
    await page.route('**/api/runtime', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ preview: null }),
    }));
    await mockEmptyHistory(page);
    await installMockWs(page);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    await expect(page.locator('#sidebar-subtitle')).toHaveText('Live', { timeout: 3000 });
    await expect(page.locator('#mode-toggle-label')).toHaveText('Live');
  });

  test('login page tagline rebrands to "Preview · #<n> · <branch>"', async ({ page }) => {
    await page.route('**/api/runtime', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ preview: { pr: 42, branch: 'claude/timestamp-fix' } }),
    }));
    // login.js calls /auth/status during checkStatus(); stub it with a
    // benign 'not authed' response so the page settles deterministically.
    await page.route('**/auth/status', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, setupMode: false, registrationOpen: false }),
    }));

    await page.goto('/playground/public/login.html', { waitUntil: 'load' });
    await expect(page.locator('#login-tagline')).toHaveText('Preview · #42 · claude/timestamp-fix', { timeout: 3000 });
  });

  test('login tagline falls back to "Preview · #<n>" when branch is missing', async ({ page }) => {
    await page.route('**/api/runtime', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ preview: { pr: 7, branch: null } }),
    }));
    await page.route('**/auth/status', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, setupMode: false, registrationOpen: false }),
    }));

    await page.goto('/playground/public/login.html', { waitUntil: 'load' });
    await expect(page.locator('#login-tagline')).toHaveText('Preview · #7', { timeout: 3000 });
  });

  test('login tagline keeps prod copy when /api/runtime fails', async ({ page }) => {
    await page.route('**/api/runtime', r => r.fulfill({ status: 500, body: 'oops' }));
    await page.route('**/auth/status', r => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ authenticated: false, setupMode: false, registrationOpen: false }),
    }));

    await page.goto('/playground/public/login.html', { waitUntil: 'load' });
    await expect(page.locator('#login-tagline')).toHaveText('Solar sanctuary');
  });
});
