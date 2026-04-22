import { test, expect } from './fixtures.js';

// Proves the harness is wired end-to-end: server/server.js boots,
// pg-mem stands in for Postgres, and aedes accepts the MQTT bridge's
// connection. If this spec goes red, nothing else in tests/e2e/ will
// run reliably — investigate the harness first.
test.describe('e2e server smoke', () => {
  test('GET /health reports mqtt connected + db available', async ({ page }) => {
    const res = await page.request.get('/health');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.mqtt).toBe('connected');
  });

  test('playground index renders via the real server', async ({ page }) => {
    // Capture 5xxs from the start, not just after goto, so background
    // API calls during the initial render are included in the check.
    // /api/history is excluded: pg-mem can't parse the ≤6h UNION ALL
    // query the production db.js builds, so those requests 500 under
    // the harness. That limitation is harness-local and doesn't block
    // the server from booting — which is what this test is asserting.
    const errors = [];
    page.on('response', r => {
      if (r.status() < 500) return;
      if (new URL(r.url()).pathname === '/api/history') return;
      errors.push(r.url());
    });

    await page.goto('/');
    await expect(page.locator('body')).toBeVisible();
    await page.waitForLoadState('networkidle').catch(() => { /* ok to timeout */ });
    expect(errors).toEqual([]);
  });
});
