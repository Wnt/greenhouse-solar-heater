import { test, expect } from './fixtures.js';

// Round-trip tests for /api/device-config — frontend suite mocks the
// endpoint and asserts on the request body; here we exercise the real
// updateConfig() partial-merge logic and version bump.
//
// All e2e workers share one server, so each PUT has to use a worker-
// unique value (counter + pid) to stay independent of sibling tests
// that may also be writing wb / we / ea.

let counter = 0;

test.describe('PUT /api/device-config round-trips', () => {
  test('wb mode-ban write echoes back in the PUT response', async ({ page }) => {
    // wb is a partial-merge map — VALID_MODES keys only. A unique
    // future timestamp lets us assert "this exact value came back"
    // without caring what other workers wrote to other keys.
    const banUntil = Math.floor(Date.now() / 1000) + 7200
      + (process.pid % 7919) + (++counter);
    const res = await page.request.put('/api/device-config', {
      data: { wb: { GH: banUntil } },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.wb.GH).toBe(banUntil);
    expect(typeof body.v).toBe('number');
  });

  test('ea bitmask + ce flag round-trip in one PUT', async ({ page }) => {
    // ea is a small bitmask (valves=1, pump=2, fan=4, sh=8, ih=16)
    // and ce is a bool. Both replace-not-merge, so we just assert the
    // PUT response carries our exact values back.
    const ea = 1 + 2 + 4; // valves + pump + fan
    const res = await page.request.put('/api/device-config', {
      data: { ea, ce: true },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ea).toBe(ea);
    expect(body.ce).toBe(true);
  });

  test('PUT with invalid `mo` payload returns 400 with a validation error', async ({ page }) => {
    // updateConfig fails fast on a malformed manual-override session
    // (mo.a true but missing mo.fm). Stays purely synchronous in
    // server/lib/device-config.js — no DB or MQTT round-trip — so it
    // is independent of whatever wb / ea state sibling workers have
    // accumulated.
    const res = await page.request.put('/api/device-config', {
      data: { mo: { a: true, ex: Math.floor(Date.now() / 1000) + 300 } },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/mo\.fm required/);
  });

});
