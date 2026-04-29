import { test, expect } from './fixtures.js';

// Read-only endpoints exposed pre-auth (handlers in
// server/lib/http-handlers.js). The frontend suite mocks these — here
// we drive the real server so a regression in the handler shape is
// caught before it reaches production. All three are GETs against
// already-loaded singletons; combined wall time is sub-second.

test.describe('runtime + sensor-config + version GET endpoints', () => {
  test('GET /version returns a JSON hash field', async ({ page }) => {
    const res = await page.request.get('/version');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.hash).toBe('string');
  });

  test('GET /api/runtime returns preview=null outside PREVIEW_MODE', async ({ page }) => {
    // The harness boots without PREVIEW_MODE — the login page reads
    // this to decide whether to render PR-specific branding.
    const res = await page.request.get('/api/runtime');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('preview', null);
  });

  test('GET /api/sensor-config returns hosts and assignments shape', async ({ page }) => {
    // Pre-auth read used by the Shelly controller as well as the
    // browser. Hosts are derived from SENSOR_HOST_IPS (unset in the
    // harness, so empty) and assignments default to {}.
    const res = await page.request.get('/api/sensor-config');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.hosts)).toBe(true);
    expect(typeof body.assignments).toBe('object');
    expect(typeof body.version).toBe('number');
  });
});
