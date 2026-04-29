import { test, expect } from './fixtures.js';

// Read-only health endpoints used by the playground's banners + the
// device-config Watchdogs panel. The harness can't run a real Shelly
// script monitor (CONTROLLER_IP is pinned to 127.0.0.1:1 so the RPC
// fails fast) — these tests verify the endpoints respond with a
// well-formed payload regardless of the underlying probe outcome.

test.describe('script-monitor + watchdog read endpoints', () => {
  test('GET /api/script/status returns running + reachable shape', async ({ page }) => {
    // Shape of getStatus() in server/lib/script-monitor.js. With the
    // controller intentionally unreachable, reachable=false is the
    // expected steady state — but the contract is "endpoint returns
    // 200 with the documented fields", not a specific value.
    const res = await page.request.get('/api/script/status');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('reachable');
    expect(typeof body.reachable).toBe('boolean');
    // running is true / false / null (unknown)
    expect([true, false, null]).toContain(body.running);
  });

  test('GET /api/script/crashes returns a {crashes: array} body', async ({ page }) => {
    // Backed by db.listScriptCrashes against pg-mem — the harness
    // never inserts a row, so the array starts empty, but a sibling
    // worker could in principle. Assert on shape only.
    const res = await page.request.get('/api/script/crashes?limit=5');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.crashes)).toBe(true);
  });
});
