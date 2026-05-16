// @ts-check
// The history-graph crosshair inspector must resolve the crosshair pixel
// to the same chart-axis time the series are drawn against — including
// fullscreen mode.
//
// Bug it guards against: history-graph.js widens the plot's left padding
// to 36px in fullscreen (a gutter for the Y-axis labels), but
// graph-inspector.js hard-coded left:8. The crosshair-x→time inversion
// then ran against a different geometry than the data placement, so the
// tooltip read a sample offset by roughly one gutter-width from the
// moment under the crosshair — temperatures and duty-cycle both off.
import { test, expect } from './fixtures.js';

// Phone-sized viewport — narrow plot makes the 28px padding mismatch a
// large fraction of the width, so a desync is unmistakable.
test.use({ viewport: { width: 412, height: 915 } });

const NOW = Date.now();
const DAY_MS = 86400_000;

// 5-minute history samples spanning exactly 24 h up to "now". Greenhouse
// temperature is a steep linear ramp 2°C → 98°C across the window, so the
// inspected value pins the inspected time precisely: a horizontal mapping
// error of a few percent moves the reading by several degrees.
const POINT_COUNT = 289; // 24h / 5min + 1
const GH_MIN = 2;
const GH_SPAN = 96;
const HISTORY_POINTS = Array.from({ length: POINT_COUNT }, (_, i) => {
  const frac = i / (POINT_COUNT - 1);
  return {
    ts: NOW - DAY_MS + i * 300_000,
    collector: 20,
    tank_top: 40,
    tank_bottom: 30,
    greenhouse: GH_MIN + GH_SPAN * frac,
    outdoor: 5,
  };
});

async function scaffold(page) {
  // Deterministic Fullscreen API: requestFullscreen marks the element as
  // the fullscreen element and fires fullscreenchange synchronously, so
  // the test never depends on the headless browser's real fullscreen.
  await page.addInitScript(() => {
    let fsEl = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get() { return fsEl; },
    });
    Element.prototype.requestFullscreen = function () {
      fsEl = this;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };
    document.exitFullscreen = function () {
      fsEl = null;
      document.dispatchEvent(new Event('fullscreenchange'));
      return Promise.resolve();
    };

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
              temps: { collector: 20, tank_top: 40, tank_bottom: 30, greenhouse: 98, outdoor: 5 },
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
    body: JSON.stringify({ range: '24h', points: HISTORY_POINTS, events: [] }),
  }));
  await page.route('**/api/forecast', r => r.fulfill({
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

// Hover the chart so the crosshair lands at fraction `f` of the *plot
// area* — the data-bearing region inside the padding. padLeft is 8 in the
// embedded card, 36 in fullscreen. Returns the greenhouse temperature the
// inspector should report there, derived from the ramp the data follows.
async function hoverAtPlotFraction(page, f, padLeft) {
  const box = await page.locator('#chart').boundingBox();
  if (!box) throw new Error('canvas not laid out');
  const padRight = 16;
  const pw = box.width - padLeft - padRight;
  const x = padLeft + f * pw;
  await page.locator('#chart').hover({ position: { x, y: box.height / 2 } });
  // The visible window is exactly the 24 h data span, so plot-fraction f
  // maps linearly onto the greenhouse ramp.
  return GH_MIN + GH_SPAN * f;
}

async function readGreenhouse(page) {
  const txt = (await page.locator('#inspector-gh').textContent()) || '';
  return parseFloat(txt.replace('°C', ''));
}

test.describe('Inspector crosshair alignment', () => {
  test('embedded (non-fullscreen) tooltip reads the moment under the crosshair', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    const expected = await hoverAtPlotFraction(page, 0.2, 8);
    expect(Math.abs(await readGreenhouse(page) - expected)).toBeLessThan(1.5);
  });

  test('fullscreen tooltip reads the moment under the crosshair', async ({ page }) => {
    await scaffold(page);
    await page.goto('/playground/');
    await page.waitForFunction(() => window.__initComplete === true);

    await page.locator('#graph-fullscreen-btn').click();
    await expect(page.locator('#graph-fullscreen-btn')).toHaveAttribute('aria-pressed', 'true');

    // In fullscreen the plot's left padding is 36px. A correct inspector
    // resolves the crosshair against that gutter; the pre-fix inspector
    // used left:8 and read a sample ~6°C off the ramp here.
    const expected = await hoverAtPlotFraction(page, 0.2, 36);
    expect(Math.abs(await readGreenhouse(page) - expected)).toBeLessThan(1.5);
  });
});
