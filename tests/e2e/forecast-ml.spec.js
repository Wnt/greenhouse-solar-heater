import { test, expect } from './fixtures.js';

// The ML forecast engine, exercised end-to-end against the real server.
// The Settings toggle drives /api/forecast?engine=ml; the response must
// satisfy the same forecast-card + history-overlay contract the physics
// engine produces. We assert shape only — contents depend on whatever
// sensor/weather rows happen to be in pg-mem.

test.describe('GET /api/forecast?engine=ml', () => {
  test('ML engine returns the forecast-card contract', async ({ page }) => {
    const res = await page.request.get('/api/forecast?engine=ml');
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.engine).toBe('ml');
    expect(body.forecast).toBeTruthy();

    const fc = body.forecast;
    expect(fc.engine).toBe('ml');
    expect(fc.horizonHours).toBe(48);
    expect(Array.isArray(fc.tankTrajectory)).toBe(true);
    expect(fc.tankTrajectory.length).toBe(49);
    expect(Array.isArray(fc.greenhouseTrajectory)).toBe(true);
    expect(fc.greenhouseTrajectory.length).toBe(49);
    expect(Array.isArray(fc.modeForecast)).toBe(true);
    expect(fc.modeForecast.length).toBe(48);
    expect(Array.isArray(fc.notes)).toBe(true);
    expect(['low', 'medium', 'high']).toContain(fc.modelConfidence);
    expect(typeof fc.electricKwh).toBe('number');
    expect(typeof fc.electricCostEur).toBe('number');
    // The history-graph overlay reads the top-level weather array.
    expect(Array.isArray(body.weather)).toBe(true);
  });
});
