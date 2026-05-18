// @ts-check
// History-graph temperature lines must be stroked with round line joins.
//
// Bug it guards against: drawHistoryGraph / drawTempLine left the canvas
// lineJoin at its 'miter' default. When the chart is zoomed out, adjacent
// noisy samples compress into a narrow x-range, so an up/down spike
// becomes a very acute V. A miter join extends the stroke a long point
// past that vertex — the drawn spike overshoots the real peak
// temperature. Round joins clamp the stroke to the vertex.
import { test, expect } from './fixtures.js';

const NOW = Date.now();
const DAY_MS = 86400_000;

// 24 h of 5-minute samples. The collector value zigzags so the polyline
// has the acute vertices that expose a miter overshoot.
const HISTORY_POINTS = Array.from({ length: 289 }, (_, i) => ({
  ts: NOW - DAY_MS + i * 300_000,
  collector: 5 + (i % 2 === 0 ? 3 : 0),
  tank_top: 42,
  tank_bottom: 38,
  greenhouse: 15,
  outdoor: 6,
}));

async function scaffold(page) {
  await page.addInitScript(() => {
    // Record the lineJoin in effect at every canvas stroke() so the test
    // can inspect how the temperature lines were drawn.
    window.__strokes = [];
    const proto = CanvasRenderingContext2D.prototype;
    const origStroke = proto.stroke;
    proto.stroke = function (...args) {
      window.__strokes.push({
        lineJoin: this.lineJoin,
        lineCap: this.lineCap,
        strokeStyle: this.strokeStyle,
      });
      return origStroke.apply(this, args);
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
              temps: { collector: 8, tank_top: 42, tank_bottom: 38, greenhouse: 15, outdoor: 6 },
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

test('temperature lines are stroked with round joins so spikes do not overshoot', async ({ page }) => {
  await scaffold(page);
  await page.goto('/playground/');
  await page.waitForFunction(() => window.__initComplete === true);

  // Collector line is '#ef5350', main tank line is '#e9c349'. Wait until
  // both have been drawn at least once.
  await page.waitForFunction(() => {
    const s = window.__strokes || [];
    return s.some(x => x.strokeStyle === '#ef5350') && s.some(x => x.strokeStyle === '#e9c349');
  });

  const strokes = await page.evaluate(() => window.__strokes);
  const collector = strokes.filter(s => s.strokeStyle === '#ef5350');
  const tank = strokes.filter(s => s.strokeStyle === '#e9c349');

  expect(collector.length).toBeGreaterThan(0);
  expect(tank.length).toBeGreaterThan(0);
  for (const s of collector) {
    expect(s.lineJoin).toBe('round');
    expect(s.lineCap).toBe('round');
  }
  for (const s of tank) {
    expect(s.lineJoin).toBe('round');
    expect(s.lineCap).toBe('round');
  }
});
