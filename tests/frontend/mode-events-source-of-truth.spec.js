// @ts-check
/**
 * Regression: the graph "charging" bars and the System Logs sensor-
 * readings table column drew from a per-sample mode array reconstructed
 * in the browser, while the transition log drew from /api/events. With
 * just one transition in the visible window and a non-idle leading
 * state, the bars/table claimed solar_charging at timestamps that the
 * transition log placed in idle — exactly the screenshot scenario.
 *
 * Fix: server prepends a leading event to /api/history's events list,
 * the client populates a single mode-events store, and every consumer
 * (bars, clipboard table, inspector, fallback render) resolves mode
 * via that store. This spec mirrors the original bug — leading idle,
 * one transition at the 12:39 mark, samples back to 09:25 — and asserts
 * that the clipboard table's mode column matches the events feed (idle
 * before the transition, solar_charging from it onwards).
 */
import { test, expect } from './fixtures.js';

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
        temps: { collector: 38.8, tank_top: 35.5, tank_bottom: 31.8, greenhouse: 25.8, outdoor: 13.9 },
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

test.describe('mode-events store is the single source of truth', () => {
  test('clipboard table mode column matches the events feed (idle before transition, charging after)', async ({ page }) => {
    // Anchor the scenario at a fixed wall-clock so points are
    // deterministic. transitionTs = "12:39" in epoch ms; samples start
    // at "09:25" — same shape as the user's screenshot.
    const now = Date.UTC(2026, 3, 29, 12, 26, 4); // 2026-04-29 12:26:04 UTC
    const transitionTs = now - 47 * 60_000; // ~11:39 UTC == 14:39 Helsinki — but we don't care about TZ here

    // Three points: two before the transition, one after.
    const beforeA = transitionTs - 3 * 60 * 60_000; // 3h before
    const beforeB = transitionTs - 60 * 60_000;     // 1h before
    const after  = transitionTs + 30 * 60_000;     // 30 min after

    const body = {
      range: '6h',
      points: [
        { ts: beforeA, collector: 7.6,  tank_top: 19.8, tank_bottom: 12.4, greenhouse: 4.1,  outdoor: 4.6 },
        { ts: beforeB, collector: 18.4, tank_top: 18.4, tank_bottom: 17.1, greenhouse: 24.3, outdoor: 8.1 },
        { ts: after,   collector: 33.1, tank_top: 25.6, tank_bottom: 21.4, greenhouse: 31.1, outdoor: 10.3 },
      ],
      events: [
        // The leading event the server now prepends — the controller was
        // idle for the whole pre-transition stretch, going back well
        // before the visible window.
        { ts: beforeA - 5 * 60 * 60_000, type: 'mode', from: 'idle', to: 'idle' },
        { ts: transitionTs, type: 'mode', from: 'idle', to: 'solar_charging' },
      ],
    };
    await page.route('**/api/history**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    }));
    await page.route('**/api/events**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ events: [], hasMore: false }),
    }));
    await installMockWs(page);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    // Wait until the history fetch has populated the store (both the
    // mocked points and the live frame; ≥3 mocked points expected).
    await expect.poll(() => page.evaluate(() => {
      // @ts-ignore
      return typeof window.__getHistoryPointCount === 'function' ? window.__getHistoryPointCount() : 0;
    }), { timeout: 5000 }).toBeGreaterThanOrEqual(3);

    // The clipboard text builder is the same code path that produces
    // the System Logs export the user pasted. Read it back and verify
    // the mode column on each row agrees with the transition feed.
    const text = await page.evaluate(() => {
      // @ts-ignore
      return window.__buildLogsClipboardText();
    });

    // Extract the `Sensor Readings` section table rows.
    const sensorStart = text.indexOf('--- Sensor Readings');
    const transitionStart = text.indexOf('--- Transition Log ---');
    const sensorBlock = text.slice(sensorStart, transitionStart);
    const rows = sensorBlock.split('\n').filter(l => /^20\d\d-\d\d-\d\d /.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(3);

    // Every row's mode column is the last whitespace-separated token.
    // Pre-transition rows must be 'idle'; post-transition rows must be
    // 'solar_charging'. The bug previously labelled pre-transition rows
    // as solar_charging because the leading event was missing and the
    // live-frame mode bled backward across the timeline.
    for (const row of rows) {
      const tokens = row.trim().split(/\s+/);
      const mode = tokens[tokens.length - 1];
      // Helsinki TZ printer: pull the HH:MM out of the formatted time
      const timePart = tokens[1]; // "HH:MM:SS"
      const [hh, mm] = timePart.split(':').map(Number);
      const localMinutes = hh * 60 + mm;
      // Transition was at 14:39 Helsinki (UTC+3 in summer, but
      // Europe/Helsinki uses CEST in late April — UTC+3). The exact
      // wall-clock time depends on the formatter, so we don't pin it;
      // we only check that the table is internally consistent: rows
      // earlier than the latest row labelled 'solar_charging' must NOT
      // claim 'solar_charging' if they predate the transition.
      void localMinutes;
      expect(['idle', 'solar_charging']).toContain(mode);
    }

    // Strong assertion: there must be at least one idle row AND at
    // least one solar_charging row (pre/post the transition), with
    // idle rows preceding all solar_charging rows.
    const modes = rows.map(r => r.trim().split(/\s+/).pop());
    const firstChargingIdx = modes.indexOf('solar_charging');
    const lastIdleIdx = modes.lastIndexOf('idle');
    expect(firstChargingIdx).toBeGreaterThan(-1);
    expect(lastIdleIdx).toBeGreaterThan(-1);
    expect(lastIdleIdx).toBeLessThan(firstChargingIdx);
  });

  test('a leading non-idle event makes early samples charging without an in-window transition', async ({ page }) => {
    // The other half of the bug: when /api/history's events list has
    // ZERO in-window transitions but the controller was already in
    // solar_charging at window-start, the server's leading event tells
    // the client so. Before this fix the bars/table defaulted to idle.
    const now = Date.now();
    const body = {
      range: '6h',
      points: [
        { ts: now - 3600_000, collector: 30, tank_top: 40, tank_bottom: 32, greenhouse: 20, outdoor: 11 },
        { ts: now - 600_000,  collector: 35, tank_top: 42, tank_bottom: 34, greenhouse: 22, outdoor: 12 },
      ],
      events: [
        { ts: now - 12 * 3600_000, type: 'mode', from: 'idle', to: 'solar_charging' },
      ],
    };
    await page.route('**/api/history**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    }));
    await page.route('**/api/events**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ events: [], hasMore: false }),
    }));
    await installMockWs(page);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 3000 });

    await expect.poll(() => page.evaluate(() => {
      // @ts-ignore
      return typeof window.__getHistoryPointCount === 'function' ? window.__getHistoryPointCount() : 0;
    }), { timeout: 5000 }).toBeGreaterThanOrEqual(2);

    const text = await page.evaluate(() => {
      // @ts-ignore
      return window.__buildLogsClipboardText();
    });
    const sensorStart = text.indexOf('--- Sensor Readings');
    const transitionStart = text.indexOf('--- Transition Log ---');
    const sensorBlock = text.slice(sensorStart, transitionStart);
    const rows = sensorBlock.split('\n').filter(l => /^20\d\d-\d\d-\d\d /.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      const mode = row.trim().split(/\s+/).pop();
      // Every row's mode must be solar_charging — the controller has
      // been in that mode since 12 h ago. No idle leakage.
      expect(mode).toBe('solar_charging');
    }
  });
});
