import { test, expect } from './fixtures.js';

// Read paths that the dashboard's "system logs" + history graphs
// hit. The frontend suite stubs canned payloads; here we exercise
// the real getEventsPaginated / getHistory queries against pg-mem.

test.describe('GET /api/events + /api/history', () => {
  test('GET /api/events?type=mode returns {events, hasMore} shape', async ({ page }) => {
    // Newest-first cursor pagination. Fresh DB or pre-existing rows
    // both satisfy the response contract — we only assert shape, not
    // contents, so the test is independent of sibling-worker writes.
    const res = await page.request.get('/api/events?type=mode&limit=10');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(typeof body.hasMore).toBe('boolean');
  });

  test('mode change triggers a state_events row visible via /api/events', async ({ page, mqttClient }) => {
    // detectStateChanges only fires on `previousState !== current`,
    // so we publish twice — first a baseline, then a change with a
    // unique `cause` string we can find in the result.
    const cause = 'e2e-test-' + process.pid + '-' + Date.now();

    function publish(payload) {
      return new Promise((resolve, reject) => {
        mqttClient.publish('greenhouse/state', JSON.stringify(payload), { qos: 1 },
          (err) => err ? reject(err) : resolve());
      });
    }

    // Two distinct modes so the bridge writes a transition row. cause
    // is free-text so it survives the round-trip and lets us pick our
    // event out of the shared events feed without racing.
    await publish({ ts: new Date().toISOString(), mode: 'idle', temps: { outdoor: 1 } });
    await publish({ ts: new Date().toISOString(), mode: 'solar_charging', cause, temps: { outdoor: 2 } });

    await expect.poll(async () => {
      const res = await page.request.get('/api/events?type=mode&limit=50');
      if (res.status() !== 200) return null;
      const body = await res.json();
      return body.events.find(e => e.cause === cause) ?? null;
    }, { timeout: 5000 }).not.toBeNull();
  });

  test('GET /api/history?range=all returns points + events fields', async ({ page, mqttClient }) => {
    // Seed one reading so points has at least one entry from this
    // worker (older readings may still be present from sibling tests
    // — we only assert the shape and that our specific value is
    // recoverable). range=all hits the aggregate path which pg-mem
    // can parse.
    const sentinel = 99 + (process.pid % 1000) / 1000;
    await new Promise((resolve, reject) => {
      mqttClient.publish(
        'greenhouse/state',
        JSON.stringify({ ts: new Date().toISOString(), mode: 'idle', temps: { tank_top: sentinel } }),
        { qos: 1 },
        (err) => err ? reject(err) : resolve(),
      );
    });

    await expect.poll(async () => {
      const res = await page.request.get('/api/history?range=all&sensor=tank_top');
      if (res.status() !== 200) return null;
      const body = await res.json();
      if (!Array.isArray(body.points) || !Array.isArray(body.events)) return null;
      if (body.range !== 'all') return null;
      return body.points.find(p => Math.abs((p.tank_top ?? Infinity) - sentinel) < 1e-9) ?? null;
    }, { timeout: 5000 }).not.toBeNull();
  });
});
