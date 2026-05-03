// @ts-check
/**
 * Tests that the Schematic view and Status history graph display live
 * values from the controller (not simulation defaults / empty state).
 *
 * Regression: updateSchematic() used to read from model.getState() (the
 * thermal simulation model) instead of the live state parameter, and the
 * history graph only read from timeSeriesStore which was never populated
 * from the /api/history response.
 */
import { test, expect } from './fixtures.js';

/**
 * Install a mock WebSocket that pushes a deterministic live state frame
 * right after the page connects. Stores the fake on window.__mockWs so
 * tests can inject additional frames.
 */
async function installMockWs(page, stateOverrides) {
  await page.addInitScript((overrides) => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function () { this.readyState = 3; },
        send: function () {},
      };
      // @ts-ignore
      window.__mockWs = fake;
      const stateData = Object.assign({
        mode: 'solar_charging',
        temps: { collector: 62.5, tank_top: 48.2, tank_bottom: 33.9, greenhouse: 21.7, outdoor: 11.4 },
        valves: { vi_btm: true, vi_top: false, vi_coll: false, vo_coll: true, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: true, fan: false, space_heater: false },
        controls_enabled: true,
        manual_override: null,
      }, overrides || {});
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
  }, stateOverrides);
}

/**
 * Mock /api/history with a deterministic response containing two points so
 * the history graph has data to render and the inspector has samples.
 */
async function mockHistoryApi(page, points) {
  const body = JSON.stringify({
    range: '24h',
    points: points || [
      { ts: Date.now() - 3600_000, collector: 30.0, tank_top: 40.0, tank_bottom: 30.0, greenhouse: 18.0, outdoor: 10.0 },
      { ts: Date.now() - 1800_000, collector: 55.0, tank_top: 44.0, tank_bottom: 31.5, greenhouse: 19.5, outdoor: 10.5 },
      { ts: Date.now() - 60_000,   collector: 62.5, tank_top: 48.2, tank_bottom: 33.9, greenhouse: 21.7, outdoor: 11.4 },
    ],
    events: [
      { ts: Date.now() - 3600_000, type: 'mode', id: 'controller', from: 'idle', to: 'idle' },
      { ts: Date.now() - 1800_000, type: 'mode', id: 'controller', from: 'idle', to: 'solar_charging' },
    ],
  });
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body,
  }));
}

test.describe('Schematic view shows live values', () => {
  test('schematic temperatures come from the live state, not the sim model', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/#schematic', { waitUntil: 'domcontentloaded' });

    // Wait until the live connection has pushed a state frame
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The SVG schematic sensor cells must reflect the live payload,
    // not the default simulation model values. The generated topology
    // SVG renders each sensor label as a drawio foreignObject inside the
    // [data-cell-id="t_…"] cell — toContainText walks descendants.
    await expect(page.locator('[data-cell-id="t_tank_top"]')).toContainText('48.2°C');
    await expect(page.locator('[data-cell-id="t_tank_bottom"]')).toContainText('33.9°C');
    await expect(page.locator('[data-cell-id="t_collector"]')).toContainText('62.5°C');
    await expect(page.locator('[data-cell-id="t_greenhouse"]')).toContainText('21.7°C');
    await expect(page.locator('[data-cell-id="t_outdoor"]')).toContainText('11.4°C');
  });

  test('schematic renders placeholders for unbound (null) sensors', async ({ page }) => {
    await installMockWs(page, {
      temps: { collector: null, tank_top: 42.5, tank_bottom: null, greenhouse: null, outdoor: null },
    });
    await mockHistoryApi(page);
    await page.goto('/playground/#schematic', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // Bound sensor renders as a formatted temperature
    await expect(page.locator('[data-cell-id="t_tank_top"]')).toContainText('42.5°C');
    // Unbound sensors render as "--°C" (placeholder from schematic.js
    // formatTemp) instead of crashing.
    await expect(page.locator('[data-cell-id="t_tank_bottom"]')).toContainText('--°C');
    await expect(page.locator('[data-cell-id="t_collector"]')).toContainText('--°C');
  });
});

test.describe('Status history graph uses live data', () => {
  test('/api/history points populate the graph time-series store', async ({ page }) => {
    const now = Date.now();
    const points = [
      { ts: now - 7200_000, collector: 25.0, tank_top: 38.0, tank_bottom: 30.0, greenhouse: 17.0, outdoor: 9.0 },
      { ts: now - 3600_000, collector: 45.0, tank_top: 42.0, tank_bottom: 32.0, greenhouse: 18.5, outdoor: 10.0 },
      { ts: now - 1800_000, collector: 60.0, tank_top: 46.0, tank_bottom: 33.5, greenhouse: 20.0, outdoor: 11.0 },
    ];
    await installMockWs(page);
    await mockHistoryApi(page, points);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    // Wait until the live connection is up
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The graph should have ingested the history points. Read via the
    // debug hook exposed on window. Poll rather than asserting once —
    // the connection-dot transition only signals WS-open, not that the
    // /api/history fetch has resolved and applyLiveHistory has run. Under
    // heavy parallel load the assertion could fire after the live state
    // frame's recordLiveHistoryPoint added a single point but before the
    // history fetch loaded the 3 mocked points (count=1 instead of 3).
    await expect.poll(() => page.evaluate(() => {
      // @ts-ignore
      return typeof window.__getHistoryPointCount === 'function'
        ? window.__getHistoryPointCount()
        : null;
    }), { timeout: 5000 }).toBeGreaterThanOrEqual(3);
  });

  test('graph does not stay empty after switching from simulation to live', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    // Switch to simulation, then back to live
    await page.locator('#mode-toggle-switch').click(); // -> simulation
    await page.locator('#mode-toggle-switch').click(); // -> live
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const count = await page.evaluate(() => {
      // @ts-ignore
      return typeof window.__getHistoryPointCount === 'function'
        ? window.__getHistoryPointCount()
        : null;
    });
    expect(count).not.toBeNull();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Status history graph includes collector temperature', () => {
  test('legend has a Collector entry', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The graph legend must include a Collector entry alongside
    // Tank / Greenhouse / Outside.
    await expect(page.locator('.graph-legend')).toContainText('Collector');
  });

  test('inspector row reflects collector temperature from history sample', async ({ page }) => {
    const now = Date.now();
    const points = [
      { ts: now - 7200_000, collector: 25.0, tank_top: 38.0, tank_bottom: 30.0, greenhouse: 17.0, outdoor: 9.0 },
      { ts: now - 3600_000, collector: 45.0, tank_top: 42.0, tank_bottom: 32.0, greenhouse: 18.5, outdoor: 10.0 },
      { ts: now - 1800_000, collector: 60.0, tank_top: 46.0, tank_bottom: 33.5, greenhouse: 20.0, outdoor: 11.0 },
    ];
    await installMockWs(page);
    await mockHistoryApi(page, points);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // The inspector must have a collector row that updates on hover.
    const inspectorColl = page.locator('#inspector-coll');
    await expect(inspectorColl).toHaveCount(1);

    // Hover the middle of the canvas to surface the inspector.
    const canvas = page.locator('#chart');
    await canvas.hover({ position: { x: 200, y: 100 } });

    // The collector row must render a temperature in °C (not empty).
    await expect(inspectorColl).toHaveText(/\d+\.\d°C/);
  });
});

test.describe('Bucket-resolution badge on history chart', () => {
  // Issue #132 — without this badge the user can't tell whether each duty-
  // cycle bar represents 5 minutes or a whole day at the current zoom.

  test('renders a "<bucket> / bar" badge inside the graph container', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const badge = page.locator('#chart-bucket-badge');
    await expect(badge).toBeVisible();
    // Default range is 24 h → pickBucketSize returns 1 hour.
    await expect(badge).toContainText(/^\s*1 h\s*\/\s*bar\s*$/);
    // Tooltip carries the long-form explanation so users hovering the badge
    // get the "Each bar shows duty-cycle aggregated over …" hint.
    await expect(badge).toHaveAttribute('title', /Each bar shows duty-cycle/);
  });

  test('updates the bucket label when the time range changes', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    const badge = page.locator('#chart-bucket-badge');
    await expect(badge).toContainText(/1 h \/ bar/);

    // Switch to the 1 h range — pickBucketSize(3600) returns 5 minutes.
    await page.locator('.time-range-slider-step[data-range="3600"]').click();
    await expect(badge).toContainText(/5 min \/ bar/);

    // And to 6 h — pickBucketSize(21600) returns 30 min.
    await page.locator('.time-range-slider-step[data-range="21600"]').click();
    await expect(badge).toContainText(/30 min \/ bar/);
  });
});

test.describe('Live mode is the default data source', () => {
  test('app starts in live mode on localhost (simulation is secondary)', async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    // Mode label reads "Live" immediately on startup
    await expect(page.locator('#mode-toggle-label')).toHaveText('Live');
    // The FAB (simulation play button) is hidden in live mode
    await expect(page.locator('#fab-play')).not.toBeVisible();
  });
});

test.describe("Yesterday's High label in live mode", () => {
  test("shows peak tank-average from yesterday's history points (matching the graph)", async ({ page }) => {
    const yAt = (h) => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      d.setHours(h, 0, 0, 0);
      return d.getTime();
    };
    const now = Date.now();
    const points = [
      // Yesterday's readings — peak tank avg = (80 + 60) / 2 = 70°C at 15:00
      { ts: yAt(9),  collector: 40.0, tank_top: 50.0, tank_bottom: 40.0, greenhouse: 18.0, outdoor: 10.0 },
      { ts: yAt(12), collector: 55.0, tank_top: 70.0, tank_bottom: 50.0, greenhouse: 22.0, outdoor: 12.0 },
      { ts: yAt(15), collector: 62.0, tank_top: 80.0, tank_bottom: 60.0, greenhouse: 24.0, outdoor: 14.0 },
      // Today's readings — must not count toward yesterday's high
      { ts: now - 3600_000, collector: 50.0, tank_top: 90.0, tank_bottom: 70.0, greenhouse: 20.0, outdoor: 11.0 },
    ];
    await installMockWs(page);
    await mockHistoryApi(page, points);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    await expect(page.locator('#graph-peak-label')).toHaveText(/Yesterday's High: 70°C/, { timeout: 5000 });
  });

  test("stays at -- when history has no points from yesterday", async ({ page }) => {
    const now = Date.now();
    // All points are from today (within the last 2 hours).
    const points = [
      { ts: now - 7200_000, collector: 50.0, tank_top: 60.0, tank_bottom: 40.0, greenhouse: 20.0, outdoor: 11.0 },
      { ts: now - 1800_000, collector: 55.0, tank_top: 65.0, tank_bottom: 45.0, greenhouse: 21.0, outdoor: 12.0 },
    ];
    await installMockWs(page);
    await mockHistoryApi(page, points);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    await expect(page.locator('#graph-peak-label')).toHaveText("Yesterday's High: --");
  });
});

test.describe("Graph 'All sensors' toggle", () => {
  test("is off by default and hides Tank Top / Tank Bottom legend entries", async ({ page }) => {
    await installMockWs(page);
    await mockHistoryApi(page);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    await expect(page.locator('#graph-show-all-sensors')).not.toHaveClass(/active/);
    await expect(page.locator('#legend-tank-top')).toBeHidden();
    await expect(page.locator('#legend-tank-bottom')).toBeHidden();
    await expect(page.locator('#inspector-tank-top-row')).toBeHidden();
    await expect(page.locator('#inspector-tank-bottom-row')).toBeHidden();
  });

  test("enabling the toggle reveals Tank Top / Tank Bottom legend + inspector rows", async ({ page }) => {
    const now = Date.now();
    const points = [
      { ts: now - 7200_000, collector: 25.0, tank_top: 52.0, tank_bottom: 34.0, greenhouse: 17.0, outdoor: 9.0 },
      { ts: now - 3600_000, collector: 45.0, tank_top: 58.0, tank_bottom: 36.0, greenhouse: 18.5, outdoor: 10.0 },
      { ts: now - 1800_000, collector: 60.0, tank_top: 62.0, tank_bottom: 38.0, greenhouse: 20.0, outdoor: 11.0 },
    ];
    await installMockWs(page);
    await mockHistoryApi(page, points);
    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    await page.locator('#graph-show-all-sensors').click();
    await expect(page.locator('#graph-show-all-sensors')).toHaveClass(/active/);

    await expect(page.locator('#legend-tank-top')).toBeVisible();
    await expect(page.locator('#legend-tank-bottom')).toBeVisible();

    // Hover the graph to surface the inspector and assert the new rows
    // show individual top/bottom values (not just the average).
    const canvas = page.locator('#chart');
    await canvas.hover({ position: { x: 200, y: 100 } });

    await expect(page.locator('#inspector-tank-top-row')).toBeVisible();
    await expect(page.locator('#inspector-tank-bottom-row')).toBeVisible();
    await expect(page.locator('#inspector-tank-top')).toHaveText(/\d+\.\d°C/);
    await expect(page.locator('#inspector-tank-bottom')).toHaveText(/\d+\.\d°C/);
  });
});

test.describe('Collectors fluid-state indicator', () => {
  test('shows DRAINED when the live frame reports collectors_drained=true', async ({ page }) => {
    await installMockWs(page, {
      mode: 'idle',
      flags: { collectors_drained: true, emergency_heating_active: false },
    });
    await mockHistoryApi(page);
    await page.goto('/playground/#status', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });
    await expect(page.locator('#comp-collectors')).toHaveText('DRAINED');
  });

  test('shows FILLED when the live frame reports collectors_drained=false', async ({ page }) => {
    await installMockWs(page, {
      mode: 'solar_charging',
      flags: { collectors_drained: false, emergency_heating_active: false },
    });
    await mockHistoryApi(page);
    await page.goto('/playground/#status', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });
    await expect(page.locator('#comp-collectors')).toHaveText('FILLED');
  });
});

test.describe('Direction-of-change is decoupled from the graph timeframe selector', () => {
  // The trend arrows in the Status gauge ("RISING" / "FALLING" / "STABLE")
  // and the per-sensor arrows in the Components view must always reflect
  // the most recent ~5 minutes of samples. Picking a longer graph range
  // (4mo) reloads the graph's history with downsampled points; that must
  // NOT clear the trend state.
  test('trend label stays RISING after switching the graph range', async ({ page }) => {
    const now = Date.now();
    // 6 fine-grained recent samples within the trend's 5-min window,
    // tank_top climbing 32 → 35 °C (well past the 0.083 °C threshold).
    const fineGrained = [];
    for (let i = 6; i >= 0; i--) {
      fineGrained.push({
        ts: now - i * 30_000,
        collector: 50 + (6 - i),
        tank_top: 32 + (6 - i) * 0.5,
        tank_bottom: 28 + (6 - i) * 0.5,
        greenhouse: 20,
        outdoor: 10,
      });
    }

    // Server-side handler: respond with the fine-grained set for the
    // initial 24h fetch, then with a sparse downsampled set (one
    // ancient point, no recent ones) for any 4mo refetch. The sparse
    // response is what would silently break the trend if it clobbered
    // the trendStore.
    await page.route('**/api/history**', (route) => {
      const url = route.request().url();
      const isLong = url.includes('range=4mo');
      const body = isLong
        ? JSON.stringify({
            range: '4mo',
            points: [
              // One coarse point months ago; nothing within 5 min of now.
              { ts: now - 30 * 24 * 3600_000, collector: 20, tank_top: 25, tank_bottom: 22, greenhouse: 18, outdoor: 5 },
            ],
            events: [],
          })
        : JSON.stringify({
            range: '24h',
            points: fineGrained,
            events: [{ ts: now - 3600_000, type: 'mode', id: 'controller', from: 'idle', to: 'solar_charging' }],
          });
      route.fulfill({ status: 200, contentType: 'application/json', body });
    });

    await installMockWs(page, {
      temps: { collector: 56, tank_top: 35, tank_bottom: 31, greenhouse: 21, outdoor: 11 },
    });
    await page.goto('/playground/#status', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // Trend should populate from the seeded high-resolution history.
    await expect(page.locator('#tank-temp-status')).toHaveText('RISING', { timeout: 5000 });

    // Click the 4mo pill — triggers a fresh fetchLiveHistory(10368000)
    // that returns the sparse downsampled response. timeSeriesStore is
    // reset by loadLiveHistoryIntoStore; trendStore must NOT be.
    const longResponse = page.waitForResponse((r) => r.url().includes('range=4mo'));
    await page.locator('button.time-range-slider-step[data-range="10368000"]').click({ force: true });
    await longResponse;

    // Wait for applyLiveHistory to actually land — the sparse 4mo
    // payload reduces __getHistoryPointCount well below the seeded 7
    // (typically to 1–2 after the rerender pipeline appends the cached
    // live WS frame). Without this guard the assertion below could
    // fire before the rerender, masking the bug.
    await page.waitForFunction(() => window.__getHistoryPointCount() <= 2, null, { timeout: 5000 });

    // Trend label must still read RISING — proves trendStore survived
    // the timeframe change. Before this fix, trendFor read from
    // timeSeriesStore, so reducing it to 1 point would force the trend
    // back to STABLE (the null-trend fallback).
    await expect(page.locator('#tank-temp-status')).toHaveText('RISING');
  });
});
