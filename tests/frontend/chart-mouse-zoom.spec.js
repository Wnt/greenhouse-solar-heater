// @ts-check
// Desktop mouse interactions on the history-graph canvas: shift+drag
// to zoom-select a time range, plain drag to pan once zoomed. Exercises
// the chart-mouse-zoom.js setup so the coverage gate stays green and
// the wiring (cursor toggling, rubber-band overlay, chartZoom updates)
// keeps working as the file evolves.
import { test, expect } from './fixtures.js';

const NOW = Date.now();

const LIVE_POINTS = [
  { ts: NOW - 7200_000, collector: 25.0, tank_top: 38.0, tank_bottom: 30.0, greenhouse: 17.0, outdoor: 9.0 },
  { ts: NOW - 3600_000, collector: 45.0, tank_top: 42.0, tank_bottom: 34.0, greenhouse: 18.5, outdoor: 10.0 },
  { ts: NOW - 60_000,   collector: 60.0, tank_top: 44.0, tank_bottom: 36.0, greenhouse: 19.0, outdoor: 11.0 },
];

async function scaffold(page) {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close() { this.readyState = 3; },
        send() {},
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
              temps: { collector: 60, tank_top: 44, tank_bottom: 36, greenhouse: 19, outdoor: 11 },
              valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
              actuators: { pump: false, fan: false, space_heater: false },
              controls_enabled: true,
              manual_override: null,
            },
          }) });
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
    // @ts-ignore
    window.WebSocket.CLOSED = 3;
  });

  await page.route('**/api/history**', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({
      range: '24h', points: LIVE_POINTS,
      events: [{ ts: NOW - 7200_000, type: 'mode', id: 'controller', from: 'idle', to: 'solar_charging' }],
    }),
  }));
  await page.route('**/api/forecast**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ forecast: null, weather: [], prices: [] }),
  }));
  await page.route('**/api/watchdog/state', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ pending: null, watchdogs: [], snapshot: { we: {}, wz: {}, wb: {} }, recent: [] }),
  }));
  await page.route('**/api/device-config', r => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 }),
  }));
  await page.route('**/api/events**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: '[]',
  }));
  await page.route('**/api/push/**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: '{}',
  }));
}

test.describe('History-graph desktop mouse interactions', () => {
  test('shift + drag selects a time range and zooms the chart to it', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    // Default state: chartZoom is null.
    const zoomBefore = await page.evaluate(async () => {
      const mod = await import('/playground/js/main/state.js');
      return mod.chartZoom;
    });
    expect(zoomBefore).toBeNull();

    // Drive the gesture by dispatching pointer events directly with
    // shiftKey: true. page.mouse.down + page.keyboard.down has historically
    // not propagated shift state to PointerEvents in Chromium, so dispatch
    // the canonical PointerEvent shape ourselves.
    await page.evaluate(() => {
      const canvas = document.getElementById('chart');
      const rect = canvas.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const x1 = rect.left + rect.width * 0.30;
      const x2 = rect.left + rect.width * 0.65;
      const fire = (type, x, opts = {}) => canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y,
        button: 0, buttons: 1, bubbles: true, shiftKey: true, ...opts,
      }));
      fire('pointerdown', x1);
      fire('pointermove', x1 + 50);
      fire('pointermove', x2);
      fire('pointerup', x2, { buttons: 0 });
    });

    // The rubber-band overlay element should exist (created on first drag)
    // and be hidden after the drag completes.
    await expect(page.locator('.graph-container .graph-selection')).toBeHidden();

    // Selection commits → chart zoom is now a narrower window than
    // the original (which was null = full default range).
    const zoomAfter = await page.evaluate(async () => {
      const mod = await import('/playground/js/main/state.js');
      return mod.chartZoom;
    });
    expect(zoomAfter).not.toBeNull();
    expect(zoomAfter.tMax - zoomAfter.tMin).toBeGreaterThan(0);
  });

  test('plain drag pans the visible window once the chart is zoomed', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    // Pre-zoom programmatically so a plain drag has somewhere to go.
    await page.evaluate(async () => {
      const stateMod = await import('/playground/js/main/state.js');
      const graphMod = await import('/playground/js/main/history-graph.js');
      const win = graphMod.getChartWindow();
      const quarter = (win.tMax - win.tMin) / 4;
      stateMod.setChartZoom({ tMin: win.tMin + quarter, tMax: win.tMax - quarter });
      graphMod.drawHistoryGraph();
    });

    const before = await page.evaluate(async () => {
      const mod = await import('/playground/js/main/state.js');
      return { ...mod.chartZoom };
    });

    // Drag rightward → window shifts left in time (panZoomWindow uses
    // -dxPx as dt). Dispatch PointerEvents directly so we don't depend
    // on Playwright's mouse-state propagation.
    await page.evaluate(() => {
      const canvas = document.getElementById('chart');
      const rect = canvas.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const x = rect.left + rect.width * 0.5;
      const fire = (type, dx, opts = {}) => canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 2, pointerType: 'mouse', clientX: x + dx, clientY: y,
        button: 0, buttons: 1, bubbles: true, ...opts,
      }));
      fire('pointerdown', 0);
      fire('pointermove', 100);
      fire('pointerup', 100, { buttons: 0 });
    });

    const after = await page.evaluate(async () => {
      const mod = await import('/playground/js/main/state.js');
      return { ...mod.chartZoom };
    });

    expect(after.tMin).not.toEqual(before.tMin);
    // Window width preserved across the pan.
    expect(after.tMax - after.tMin).toBeCloseTo(before.tMax - before.tMin, 0);
  });

  test('click on a zoomed chart resets the zoom back to default', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    // Pre-zoom programmatically so the click has something to reset.
    await page.evaluate(async () => {
      const stateMod = await import('/playground/js/main/state.js');
      const graphMod = await import('/playground/js/main/history-graph.js');
      const win = graphMod.getChartWindow();
      const quarter = (win.tMax - win.tMin) / 4;
      stateMod.setChartZoom({ tMin: win.tMin + quarter, tMax: win.tMax - quarter });
      graphMod.drawHistoryGraph();
    });

    const beforeZoom = await page.evaluate(async () => {
      const mod = await import('/playground/js/main/state.js');
      return mod.chartZoom;
    });
    expect(beforeZoom).not.toBeNull();

    // pointerdown / pointerup at the same x — no movement = a click.
    await page.evaluate(() => {
      const canvas = document.getElementById('chart');
      const rect = canvas.getBoundingClientRect();
      const y = rect.top + rect.height / 2;
      const x = rect.left + rect.width * 0.5;
      const fire = (type, opts = {}) => canvas.dispatchEvent(new PointerEvent(type, {
        pointerId: 3, pointerType: 'mouse', clientX: x, clientY: y,
        button: 0, buttons: 1, bubbles: true, ...opts,
      }));
      fire('pointerdown');
      fire('pointerup', { buttons: 0 });
    });

    const afterZoom = await page.evaluate(async () => {
      const mod = await import('/playground/js/main/state.js');
      return mod.chartZoom;
    });
    expect(afterZoom).toBeNull();
  });
});
