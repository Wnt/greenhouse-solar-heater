// @ts-check
// Two-finger pinch zoom on the history-graph canvas. The gesture funnels
// through chart-pinch-zoom.js as raw PointerEvents, so the test drives it
// by dispatching pointerType:'touch' events directly — the same technique
// chart-mouse-zoom.spec.js uses for mouse.
//
// Behaviour under test: the pinch keeps the moment under the gesture
// midpoint anchored to that midpoint *as the midpoint moves* — so the
// chart pans while it zooms, instead of staying locked to the x-position
// the gesture started at.
import { test, expect } from './fixtures.js';

test.use({ viewport: { width: 412, height: 915 } });

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
    body: JSON.stringify({ range: '24h', points: LIVE_POINTS, events: [] }),
  }));
  await page.route('**/api/forecast**', r => r.fulfill({
    status: 200, contentType: 'application/json', body: 'null',
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

// Dispatch a two-finger pinch. fingers0 / fingers1 are [leftX, rightX]
// plot-fractions at gesture start and end. Returns nothing — read
// chartZoom afterwards.
async function pinch(page, fingers0, fingers1) {
  await page.evaluate(({ f0, f1 }) => {
    const canvas = document.getElementById('chart');
    const rect = canvas.getBoundingClientRect();
    const y = rect.top + rect.height / 2;
    const padLeft = 8, padRight = 16;
    const pw = rect.width - padLeft - padRight;
    const plotX = (frac) => rect.left + padLeft + frac * pw;
    const fire = (type, id, x) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerId: id, pointerType: 'touch', clientX: x, clientY: y,
      bubbles: true, cancelable: true,
    }));
    fire('pointerdown', 10, plotX(f0[0]));
    fire('pointerdown', 11, plotX(f0[1]));
    fire('pointermove', 10, plotX(f1[0]));
    fire('pointermove', 11, plotX(f1[1]));
    fire('pointerup', 10, plotX(f1[0]));
    fire('pointerup', 11, plotX(f1[1]));
  }, { f0: fingers0, f1: fingers1 });
}

async function chartWindow(page) {
  return page.evaluate(async () => {
    const g = await import('/playground/js/main/history-graph.js');
    return g.getChartWindow();
  });
}

async function readZoom(page) {
  return page.evaluate(async () => {
    const s = await import('/playground/js/main/state.js');
    return s.chartZoom ? { tMin: s.chartZoom.tMin, tMax: s.chartZoom.tMax } : null;
  });
}

test.describe('History-graph pinch zoom', () => {
  test('spreading two fingers zooms the x-axis in around the gesture midpoint', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    const win0 = await chartWindow(page);
    const range0 = win0.tMax - win0.tMin;

    // Midpoint stays at plot-fraction 0.5; finger gap triples (0.1→0.3 of
    // the plot width) → ~3× zoom-in.
    await pinch(page, [0.45, 0.55], [0.35, 0.65]);

    const zoom = await readZoom(page);
    expect(zoom).not.toBeNull();
    const newRange = zoom.tMax - zoom.tMin;
    expect(newRange).toBeGreaterThan(range0 * 0.25);
    expect(newRange).toBeLessThan(range0 * 0.45);

    // Midpoint did not move, so the time under it stays at fraction 0.5.
    const tMid = win0.tMin + 0.5 * range0;
    const tAtMidpoint = zoom.tMin + 0.5 * newRange;
    expect(Math.abs(tAtMidpoint - tMid)).toBeLessThan(newRange * 0.03);
  });

  test('sliding the gesture while pinching pans the window with the midpoint', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    const win0 = await chartWindow(page);
    const range0 = win0.tMax - win0.tMin;
    // The moment under the gesture midpoint at start (plot-fraction 0.5).
    const tAnchor = win0.tMin + 0.5 * range0;

    // Fingers start ±0.05 around fraction 0.5 and end ±0.10 around
    // fraction 0.7: the gap doubles (2× zoom) AND the midpoint slides
    // from 0.5 to 0.7. The anchored moment must follow to fraction 0.7.
    await pinch(page, [0.45, 0.55], [0.60, 0.80]);

    const zoom = await readZoom(page);
    expect(zoom).not.toBeNull();
    const newRange = zoom.tMax - zoom.tMin;
    // ~2× zoom from the doubled finger gap.
    expect(newRange).toBeGreaterThan(range0 * 0.4);
    expect(newRange).toBeLessThan(range0 * 0.6);

    // The anchored moment tracks the moved midpoint — it now sits at
    // fraction 0.7, not the 0.5 it started at.
    const tAt70 = zoom.tMin + 0.7 * newRange;
    expect(Math.abs(tAt70 - tAnchor)).toBeLessThan(newRange * 0.04);
  });
});
