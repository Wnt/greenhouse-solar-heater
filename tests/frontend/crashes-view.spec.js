import { test, expect } from './fixtures.js';

// Covers playground/js/crashes-view.js — the #crashes view that lists
// entries from GET /api/script/crashes and lazy-loads GET /api/script/crashes/:id
// on row click, with a Copy-JSON button on the expanded detail.

async function mockScaffold(page, { crashes, detailById }) {
  // Minimal WS mock — crashes view doesn't need live state but main.js
  // opens a WebSocket on boot. Keep it connected with no messages to
  // stop the bootstrap from spinning on the initial state fetch.
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close() { this.readyState = 3; },
        send() {},
      };
      setTimeout(() => {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
      }, 50);
      return fake;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  });

  // Crash list + per-id detail. detailById is a map id → payload OR
  // a 'HTTP ###' string to trigger the error branch.
  await page.route('**/api/script/crashes?**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ crashes }),
  }));
  await page.route('**/api/script/crashes/*', r => {
    const id = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop());
    const payload = detailById[id];
    if (typeof payload === 'number') {
      return r.fulfill({ status: payload, contentType: 'application/json', body: '{}' });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });

  // Silence the other endpoints main.js loads during boot.
  await page.route('**/api/watchdog/state', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ pending: null, watchdogs: [], snapshot: { we: {}, wz: {}, wb: {} }, recent: [] }),
  }));
  await page.route('**/api/device-config', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }),
  }));
  await page.route('**/api/history**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/events**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/push/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

test.describe('#crashes view', () => {
  const crashA = {
    id: 1001,
    ts: Date.parse('2026-04-22T10:00:00Z'),
    error_msg: 'TypeError: undefined is not a function',
    error_trace: 'at control.js:42',
    resolved_at: null,
  };
  const crashB = {
    id: 1002,
    ts: Date.parse('2026-04-21T20:00:00Z'),
    error_msg: null,
    error_trace: null,
    resolved_at: Date.parse('2026-04-21T21:00:00Z'),
  };

  test('empty list renders the empty-state panel', async ({ page }) => {
    await mockScaffold(page, { crashes: [], detailById: {} });
    await page.goto('/playground/#crashes');
    // Wait for mount — the list shows "Loading…" synchronously, then empty
    // shows once the fetch resolves.
    await expect(page.locator('#crashes-empty')).toBeVisible();
    await expect(page.locator('#crashes-list li')).toHaveCount(0);
  });

  test('list renders one row per crash with message + timestamp', async ({ page }) => {
    await mockScaffold(page, {
      crashes: [crashA, crashB],
      detailById: {},
    });
    await page.goto('/playground/#crashes');

    await expect(page.locator('#crashes-list li')).toHaveCount(2);
    // crashA's error_msg is visible; crashB shows the "(no error message)" fallback.
    await expect(page.locator('#crashes-list li[data-id="1001"]')).toContainText('TypeError');
    await expect(page.locator('#crashes-list li[data-id="1002"]')).toContainText('(no error message)');
    // crashB was resolved — resolved-timestamp chip appears.
    await expect(page.locator('#crashes-list li[data-id="1002"] .crashes-resolved')).toBeVisible();
  });

  test('clicking a row loads the detail + toggling hides it again', async ({ page }) => {
    const detail = { ...crashA, sys_status: { ok: true }, recent_states: [{ mode: 'idle' }] };
    await mockScaffold(page, { crashes: [crashA], detailById: { 1001: detail } });
    await page.goto('/playground/#crashes');

    const row = page.locator('#crashes-list li[data-id="1001"]');
    await row.click();
    // detailTemplate puts the JSON inside .crashes-detail and appends
    // a Copy JSON button.
    const detailEl = row.locator('.crashes-detail');
    await expect(detailEl).toBeVisible();
    await expect(detailEl).toContainText('"id": 1001');
    await expect(detailEl).toContainText('"recent_states"');
    await expect(row.locator('button.crashes-copy')).toBeVisible();

    // Click the row again → detail collapses.
    await row.click();
    await expect(row.locator('.crashes-detail')).toHaveCount(0);
    await expect(row.locator('button.crashes-copy')).toHaveCount(0);
  });

  test('failed detail fetch renders the failure message inline', async ({ page }) => {
    await mockScaffold(page, { crashes: [crashA], detailById: { 1001: 500 } });
    await page.goto('/playground/#crashes');
    const row = page.locator('#crashes-list li[data-id="1001"]');
    await row.click();
    await expect(row.locator('.crashes-detail')).toContainText('Failed to load: HTTP 500');
  });

  test('Copy JSON button writes the detail JSON to the clipboard', async ({ page, context }) => {
    const detail = { ...crashA, sys_status: { mode: 'idle' }, recent_states: [] };
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockScaffold(page, { crashes: [crashA], detailById: { 1001: detail } });
    await page.goto('/playground/#crashes');

    const row = page.locator('#crashes-list li[data-id="1001"]');
    await row.click();
    const copyBtn = row.locator('button.crashes-copy');
    await expect(copyBtn).toHaveText('Copy JSON');
    await copyBtn.click();
    // Button text flips to "Copied" briefly after the clipboard write resolves.
    await expect(copyBtn).toHaveText('Copied');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain('"id": 1001');
  });
});
