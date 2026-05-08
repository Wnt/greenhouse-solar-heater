import { test, expect } from './fixtures.js';

// Covers playground/js/diagnostics-view.js + playground/js/diagnostics/* —
// the #diagnostics view that renders predicted-vs-actual charts from
// /api/forecast/diagnostics and lets the operator drill into a single
// generation. API responses are mocked via page.route() so the suite
// stays offline and deterministic. (Issue #169.)

const NOW = Date.UTC(2026, 4, 8, 12, 0, 0); // 2026-05-08T12:00:00Z, fixed for snapshot stability.

const ALG = 'abcd1234';

// Build a "series" payload — N hourly generations at horizon=24, each
// with a paired actual the joiner produced.
function makeSeries({ count = 12, horizon = 24, divergence = 0.5 } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const generatedAt = new Date(NOW - (count - i) * 3600_000).toISOString();
    const forHour     = new Date(NOW + horizon * 3600_000 - (count - i) * 3600_000).toISOString();
    const baseGh = 12 + Math.sin(i / 3) * 2;
    const baseTank = 35 - i * 0.4;
    rows.push({
      generated_at: generatedAt,
      for_hour: forHour,
      horizon_h: horizon,
      algorithm_version: ALG,
      predicted: {
        mode: i % 4 === 0 ? 'solar_charging' : (i % 3 === 0 ? 'greenhouse_heating' : 'idle'),
        has_solar_overlay: false,
        duty: null,
        tank_avg_c: baseTank,
        greenhouse_c: baseGh,
        outdoor_c: 6 + Math.sin(i / 4) * 3,
        radiation_w_m2: i >= 6 && i <= 9 ? 320 : 0,
      },
      actual: {
        greenhouse_c: baseGh - divergence,
        tank_top_c: baseTank + 1,
        tank_bottom_c: baseTank - 1,
        tank_avg_c: baseTank - 0.2,
        outdoor_c: 6 + Math.sin(i / 4) * 3 - 0.4,
        collector_c: null,
      },
    });
  }
  return { kind: 'series', horizon, since: '2026-05-01T00:00:00Z', until: '2026-05-08T12:00:00Z', rows };
}

function makeGeneration(generatedAt) {
  const horizons = [];
  for (let h = 1; h <= 6; h++) {
    horizons.push({
      horizon_h: h,
      for_hour: new Date(new Date(generatedAt).getTime() + h * 3600_000).toISOString(),
      predicted: {
        mode: h <= 3 ? 'idle' : 'greenhouse_heating',
        tank_top_c: 38 - h, tank_bottom_c: 32 - h, tank_avg_c: 35 - h,
        greenhouse_c: 12 + h * 0.1,
        pred_solar_gain_kwh: h === 5 ? 0.4 : 0,
        pred_rad_delivered_w: h <= 3 ? 0 : 250,
        pred_heater_kwh: 0,
        pred_tank_loss_w: 4,
        pred_cloud_factor: 0.7,
        outdoor_c: 6, radiation_w_m2: 410,
      },
      actual: {
        greenhouse_c: 12 + h * 0.1 - 0.3,
        tank_avg_c: 35 - h - 0.2,
        outdoor_c: 6.1,
      },
    });
  }
  return {
    kind: 'generation',
    generated_at: generatedAt,
    algorithm_version: ALG,
    tu: { ehE: 5, ehX: 3 },
    coefficients: { tauGhH: 2.0, alphaSolar: 0.025, ghVentOpenC: 33, tauVentH: 0.3 },
    horizons,
  };
}

async function scaffold(page, { seriesPayload = makeSeries(), generationByTs = {} } = {}) {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close() { this.readyState = 3; }, send() {},
      };
      setTimeout(() => {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({
            type: 'state',
            data: {
              mode: 'idle',
              temps: { collector: 30, tank_top: 38, tank_bottom: 28, greenhouse: 14, outdoor: 8 },
              valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
              actuators: { pump: false, fan: false, space_heater: false },
              controls_enabled: true,
              manual_override: null,
            },
          }) });
        }
      }, 30);
      return fake;
    };
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  });

  await page.route('**/api/forecast/diagnostics**', r => {
    const url = new URL(r.request().url());
    const generatedAt = url.searchParams.get('generated_at');
    if (generatedAt) {
      const payload = generationByTs[generatedAt];
      if (!payload) {
        return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not found"}' });
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    }
    return r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(seriesPayload),
    });
  });

  // Silence the rest of the boot endpoints.
  await page.route('**/api/runtime', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/forecast', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ generatedAt: new Date(NOW).toISOString(), forecast: { tankTrajectory: [], greenhouseTrajectory: [], notes: [] } }),
  }));
  await page.route('**/api/watchdog/state', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ pending: null, watchdogs: [], snapshot: { we: {}, wz: {}, wb: {} }, recent: [] }),
  }));
  await page.route('**/api/device-config', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }),
  }));
  await page.route('**/api/sensor-config', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ assignments: {}, hosts: [] }),
  }));
  await page.route('**/api/history**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ range: '48h', points: [], events: [] }),
  }));
  await page.route('**/api/events**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: '[]',
  }));
  await page.route('**/api/script/**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: '{"crashes":[]}',
  }));
  await page.route('**/api/push/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}

// Navigate the playground from any view to #diagnostics. The view is
// gated on phase === 'live', which the WS mock activates a few ticks
// after init — so we wait for live phase first, then flip the hash.
async function gotoDiagnostics(page) {
  await page.waitForFunction(() => {
    const root = document.body && document.body;
    return window.__sync && window.__initComplete && root && root.dataset.role !== undefined;
  }, { timeout: 5000 });
  // Wait for the live-mode toggle to flip availableViews to include
  // 'diagnostics'. The state-store change is driven by the WS mock's
  // 'connection' frame.
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('a[data-view="diagnostics"]'))
      .some((el) => el.style.display !== 'none');
  }, { timeout: 5000 });
  await page.evaluate(() => { window.location.hash = '#diagnostics'; });
  await page.waitForFunction(() =>
    document.getElementById('view-diagnostics') &&
    document.getElementById('view-diagnostics').classList.contains('active'),
    { timeout: 5000 });
}

test.describe('#diagnostics view — basic rendering', () => {
  test('view section is present in the markup', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await expect(page.locator('#view-diagnostics')).toBeAttached();
    await expect(page.locator('#diag-horizon')).toBeAttached();
  });

  test('navigating to #diagnostics fetches the series and renders charts', async ({ page }) => {
    const series = makeSeries({ count: 8 });
    await scaffold(page, { seriesPayload: series });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await gotoDiagnostics(page);

    // Wait until the first fetch resolves and the renderer has run.
    await page.waitForFunction(() => {
      const s = window.__diag && window.__diag.getSeriesData && window.__diag.getSeriesData();
      return s && Array.isArray(s.rows) && s.rows.length > 0;
    }, { timeout: 5000 });

    // Three predicted-vs-actual line charts plus the mode ribbon and
    // the per-day solar bars should each have rendered an SVG.
    await expect(page.locator('#diag-chart-greenhouse svg')).toBeAttached();
    await expect(page.locator('#diag-chart-tank svg')).toBeAttached();
    await expect(page.locator('#diag-chart-outdoor svg')).toBeAttached();
    await expect(page.locator('#diag-chart-mode svg')).toBeAttached();
    await expect(page.locator('#diag-chart-solar svg')).toBeAttached();

    // Each line chart has both predicted (dashed) and actual (solid) polylines.
    await expect(page.locator('#diag-chart-greenhouse polyline.diag-line-pred')).toHaveCount(1);
    await expect(page.locator('#diag-chart-greenhouse polyline.diag-line-actual')).toHaveCount(1);
  });

  test('error summary reflects predicted-vs-actual divergence', async ({ page }) => {
    const series = makeSeries({ count: 6, divergence: 1.5 });
    await scaffold(page, { seriesPayload: series });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await gotoDiagnostics(page);
    await page.waitForFunction(() => {
      const s = window.__diag && window.__diag.getSeriesData && window.__diag.getSeriesData();
      return s && Array.isArray(s.rows) && s.rows.length > 0;
    }, { timeout: 5000 });
    // With divergence=1.5 the predicted - actual error mean ≈ 1.50.
    await expect(page.locator('#diag-error-greenhouse')).toContainText('Greenhouse error');
    await expect(page.locator('#diag-error-greenhouse')).toContainText('mean 1.50°');
  });
});

test.describe('#diagnostics view — drill-down', () => {
  test('drill list renders one entry per generation, newest first', async ({ page }) => {
    const series = makeSeries({ count: 5 });
    await scaffold(page, { seriesPayload: series });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await gotoDiagnostics(page);
    await page.waitForFunction(() => document.querySelectorAll('#diag-drill-list li').length >= 5,
      { timeout: 5000 });

    const items = page.locator('#diag-drill-list li[data-generated-at]');
    await expect(items).toHaveCount(5);

    // Newest-first: the first <li> should have the largest generated_at.
    const firstAt = await items.first().getAttribute('data-generated-at');
    const lastAt = await items.last().getAttribute('data-generated-at');
    expect(new Date(firstAt).getTime()).toBeGreaterThan(new Date(lastAt).getTime());
  });

  test('clicking a list entry fetches the generation and renders the breakdown + coefficients', async ({ page }) => {
    const series = makeSeries({ count: 4 });
    const pickAt = series.rows[0].generated_at;
    const generationByTs = { [pickAt]: makeGeneration(pickAt) };
    await scaffold(page, { seriesPayload: series, generationByTs });

    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await gotoDiagnostics(page);
    await page.waitForSelector('#diag-drill-list li[data-generated-at]', { timeout: 5000 });

    await page.locator(`#diag-drill-list li[data-generated-at="${pickAt}"]`).click();
    await page.waitForFunction(() => {
      const g = window.__diag && window.__diag.getGenerationData && window.__diag.getGenerationData();
      return g && Array.isArray(g.horizons) && g.horizons.length > 0;
    }, { timeout: 5000 });

    // Detail block becomes visible.
    await expect(page.locator('#diag-drill-detail')).toBeVisible();
    await expect(page.locator('#diag-drill-empty')).toBeHidden();

    // Both trajectory charts rendered.
    await expect(page.locator('#diag-drill-chart-greenhouse svg')).toBeAttached();
    await expect(page.locator('#diag-drill-chart-tank svg')).toBeAttached();

    // Per-component table has one row per horizon.
    const compRows = page.locator('#diag-drill-components tbody tr');
    await expect(compRows).toHaveCount(6);
    // First column reads "h+1".
    await expect(compRows.first().locator('td').first()).toHaveText('h+1');

    // Coefficient + tu blocks both render with their key/value pairs.
    const coeffTables = page.locator('#diag-drill-coefficients table');
    await expect(coeffTables).toHaveCount(2);
    await expect(page.locator('#diag-drill-coefficients')).toContainText('tauGhH');
    await expect(page.locator('#diag-drill-coefficients')).toContainText('ehE');

    // Selected list entry is marked active.
    await expect(page.locator(`#diag-drill-list li[data-generated-at="${pickAt}"]`)).toHaveClass(/active/);
  });
});

test.describe('#diagnostics view — mobile + synced cursor', () => {
  // Samsung S25 Ultra logical viewport (412 × 883 CSS px). The
  // explicit goal of issue: three line charts must all be visible
  // on this viewport without scrolling, and a synced inspector
  // cursor drives all charts.
  test('three line charts all fit inside the S25 Ultra viewport without scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 883 });
    const series = makeSeries({ count: 6 });
    await scaffold(page, { seriesPayload: series });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await gotoDiagnostics(page);
    await page.waitForFunction(() => {
      const s = window.__diag && window.__diag.getSeriesData && window.__diag.getSeriesData();
      return s && Array.isArray(s.rows) && s.rows.length > 0;
    }, { timeout: 5000 });

    await page.evaluate(() => window.scrollTo(0, 0));

    // On regression, dump every diagnostics element's vertical
    // position so the failure points straight at the offending block.
    async function layoutDump() {
      return page.evaluate(() => {
        const ids = ['view-diagnostics', 'diag-controls-card',
          'diag-series-card', 'diag-chart-greenhouse',
          'diag-chart-tank', 'diag-chart-outdoor'];
        return ids.map((id) => {
          const el = document.getElementById(id);
          if (!el) return { id, present: false };
          const r = el.getBoundingClientRect();
          return { id, top: Math.round(r.top),
            bottom: Math.round(r.bottom), height: Math.round(r.height) };
        });
      });
    }

    const viewportHeight = 883;
    const ids = ['#diag-chart-greenhouse', '#diag-chart-tank', '#diag-chart-outdoor'];
    for (const id of ids) {
      const box = await page.locator(id).boundingBox();
      expect(box, `${id} should have a bounding box`).not.toBeNull();
      const bottom = box.y + box.height;
      if (bottom > viewportHeight) {
        const layout = await layoutDump();
        expect(bottom, `${id} bottom (${bottom}) outside viewport (${viewportHeight})`
          + ` — layout=${JSON.stringify(layout)}`)
          .toBeLessThanOrEqual(viewportHeight);
      }
    }
  });

  test('synced cursor: setting the cursor draws a line in every line chart', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 883 });
    const series = makeSeries({ count: 8 });
    await scaffold(page, { seriesPayload: series });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await gotoDiagnostics(page);
    await page.waitForFunction(() => {
      const s = window.__diag && window.__diag.getSeriesData && window.__diag.getSeriesData();
      return s && Array.isArray(s.rows) && s.rows.length > 0;
    }, { timeout: 5000 });

    // Pick a timestamp in the middle of the rendered series and push
    // it through the inspector. This is what the long-press handler
    // does once it activates — the cursor groups in each chart should
    // un-hide as a result.
    await page.evaluate(() => {
      const rows = window.__diag.getSeriesData().rows;
      const ts = new Date(rows[Math.floor(rows.length / 2)].for_hour).getTime();
      window.__diag.inspector.setCursorTs(ts);
    });

    for (const id of ['#diag-chart-greenhouse', '#diag-chart-tank', '#diag-chart-outdoor']) {
      const cursor = page.locator(`${id} .diag-cursor-group`);
      await expect(cursor).toBeAttached();
      // The group flips display from 'none' to '' (visible) on
      // setCursorTs. The mode ribbon's cursor uses a bare line, not
      // the group, so we only assert the group on line charts.
      const display = await cursor.evaluate((el) => el.style.display);
      expect(display).not.toBe('none');
    }
  });

  test('clearCursor hides the synced cursor in all charts', async ({ page }) => {
    await page.setViewportSize({ width: 412, height: 883 });
    const series = makeSeries({ count: 6 });
    await scaffold(page, { seriesPayload: series });
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await gotoDiagnostics(page);
    await page.waitForFunction(() => {
      const s = window.__diag && window.__diag.getSeriesData && window.__diag.getSeriesData();
      return s && Array.isArray(s.rows) && s.rows.length > 0;
    }, { timeout: 5000 });

    await page.evaluate(() => {
      const rows = window.__diag.getSeriesData().rows;
      const ts = new Date(rows[1].for_hour).getTime();
      window.__diag.inspector.setCursorTs(ts);
    });
    // setCursorTs flips inline `style.display` from 'none' to ''.
    // Computed display is `inline` for SVG groups, so we assert the
    // inline-style value directly.
    expect(await page.locator('#diag-chart-greenhouse .diag-cursor-group')
      .evaluate((el) => el.style.display)).not.toBe('none');

    await page.evaluate(() => window.__diag.inspector.clearCursor());
    for (const id of ['#diag-chart-greenhouse', '#diag-chart-tank', '#diag-chart-outdoor']) {
      const display = await page.locator(`${id} .diag-cursor-group`)
        .evaluate((el) => el.style.display);
      expect(display).toBe('none');
    }
  });
});

test.describe('#diagnostics view — control wiring', () => {
  test('changing the horizon triggers a fresh fetch with the new horizon param', async ({ page }) => {
    let lastHorizon = null;
    await scaffold(page);
    // Override the diagnostics route so we can watch the horizon param.
    await page.unroute('**/api/forecast/diagnostics**');
    await page.route('**/api/forecast/diagnostics**', r => {
      const url = new URL(r.request().url());
      const generatedAt = url.searchParams.get('generated_at');
      if (generatedAt) {
        return r.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
      }
      lastHorizon = url.searchParams.get('horizon');
      return r.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(makeSeries({ count: 2, horizon: parseInt(lastHorizon, 10) || 24 })),
      });
    });

    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);
    await gotoDiagnostics(page);
    await page.waitForFunction(() => window.__diag && window.__diag.getSeriesData && window.__diag.getSeriesData() !== null,
      { timeout: 5000 });
    expect(lastHorizon).toBe('24');

    await page.locator('#diag-horizon').selectOption('6');
    await page.waitForFunction(() => {
      const s = window.__diag.getSeriesData();
      return s && s.horizon === 6;
    }, { timeout: 5000 });
    expect(lastHorizon).toBe('6');
  });
});
