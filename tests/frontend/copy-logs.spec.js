// @ts-check
/**
 * Tests for the "Copy System Logs" feature on the Status view.
 *
 * The copy button produces a plain-text diagnostic snapshot:
 *   Simulation mode — sim parameters + sensor history + transition log
 *   Live mode       — sensor readings at 20-min resolution + transition log
 */
import { test, expect } from './fixtures.js';

// ── Helpers ──

async function goToView(page, viewName) {
  await page.locator(`.sidebar-nav [data-view="${viewName}"]`).click();
  await expect(page.locator(`#view-${viewName}`)).toBeVisible();
}

async function setSlider(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    if (el && el._sliderUpdate) el._sliderUpdate(value);
  }, { id, value });
}

/** Wait for the __buildLogsClipboardText test hook to be available. */
async function waitForTestHook(page) {
  await page.waitForFunction(
    () => typeof window.__buildLogsClipboardText === 'function',
    { timeout: 5000 },
  );
}

/** Get the clipboard text via the test hook. */
async function getClipboardText(page) {
  return page.evaluate(() => window.__buildLogsClipboardText());
}

// ── Simulation mode tests ──

test.describe('Copy System Logs — simulation mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/?mode=sim');
    await expect(page.locator('#fab-play')).toBeVisible();
    await waitForTestHook(page);
  });

  test('copy button exists in the System Logs card', async ({ page }) => {
    const btn = page.locator('#copy-logs-btn');
    await expect(btn).toBeVisible();
    await expect(page.locator('#copy-logs-btn .material-symbols-outlined')).toHaveText('content_copy');
  });

  test('clipboard text contains simulation header and parameters', async ({ page }) => {
    const text = await getClipboardText(page);

    // Header
    expect(text).toContain('=== Greenhouse Solar Heater — System Logs ===');
    expect(text).toContain('Mode: Simulation');
    expect(text).toContain('Exported:');

    // Simulation parameters section
    expect(text).toContain('--- Simulation Parameters ---');
    expect(text).toContain('Outdoor Temp:');
    expect(text).toContain('Solar Irradiance:');
    expect(text).toContain('Tank Top:');
    expect(text).toContain('Tank Bottom:');
    expect(text).toContain('Greenhouse:');
    expect(text).toContain('GH Thermal Mass:');
    expect(text).toContain('GH Heat Loss:');
    expect(text).toContain('Sim Speed:');
    expect(text).toContain('Day/Night Cycle:');

    // Transition log section
    expect(text).toContain('--- Transition Log ---');
    expect(text).toContain('(no transitions recorded)');
  });

  test('default parameter values match expected defaults', async ({ page }) => {
    const text = await getClipboardText(page);

    expect(text).toContain('Outdoor Temp:       10 °C');
    expect(text).toContain('Solar Irradiance:   500 W/m²');
    expect(text).toContain('Tank Top:           12 °C');
    expect(text).toContain('Tank Bottom:        9 °C');
    expect(text).toContain('Greenhouse:         11 °C');
    expect(text).toContain('GH Thermal Mass:    250000 J/K');
    expect(text).toContain('GH Heat Loss:       100 W/K');
    expect(text).toContain('Sim Speed:          3000×');
    expect(text).toContain('Day/Night Cycle:    on');
  });

  test('shows check icon on click then reverts', async ({ page }) => {
    // Stub clipboard to avoid SecureContext issues
    await page.evaluate(() => {
      navigator.clipboard.writeText = function () { return Promise.resolve(); };
    });

    const icon = page.locator('#copy-logs-btn .material-symbols-outlined');
    await expect(icon).toHaveText('content_copy');

    await page.locator('#copy-logs-btn').click();
    await expect(icon).toHaveText('check', { timeout: 2000 });

    // Reverts after ~2 s
    await expect(icon).toHaveText('content_copy', { timeout: 4000 });
  });

  test('includes transition log entries after simulation runs', async ({ page }) => {
    // Set params that trigger a fast transition
    await goToView(page, 'controls');
    await setSlider(page, 'tank-top', 40);
    await setSlider(page, 'tank-bot', 35);
    await setSlider(page, 'greenhouse', 8);
    await setSlider(page, 'speed', 3000);

    await page.locator('#fab-play').click();
    await goToView(page, 'status');

    // Wait for a mode transition
    await page.waitForFunction(() => {
      const el = document.getElementById('mode-card-title');
      return el && el.textContent !== 'Idle';
    }, { timeout: 5000 });

    const text = await getClipboardText(page);
    expect(text).toContain('--- Transition Log ---');
    expect(text).not.toContain('(no transitions recorded)');
  });

  test('includes sensor history section after simulation runs', async ({ page }) => {
    await goToView(page, 'controls');
    await setSlider(page, 'speed', 3000);

    await page.locator('#fab-play').click();
    await goToView(page, 'status');

    // Wait for at least one mode change (proves sim is running)
    await page.waitForFunction(() => {
      const el = document.getElementById('mode-card-title');
      return el && el.textContent !== 'Idle';
    }, { timeout: 5000 });

    const text = await getClipboardText(page);
    expect(text).toContain('--- Sensor History (20-min resolution) ---');
    expect(text).toContain('SimTime');
  });
});

// ── Live mode tests ──
// These require a mock WebSocket that works in the test environment.

async function installMockWs(page, stateOverrides) {
  await page.addInitScript((overrides) => {
    const OrigWS = window.WebSocket;
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function () { this.readyState = 3; },
        send: function () {},
      };
      window.__mockWs = fake;
      const stateData = Object.assign({
        mode: 'idle',
        temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
        valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
        actuators: { pump: false, fan: false, space_heater: false },
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
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  }, stateOverrides);
}

function makeEvent(tsMs, from, to) {
  return { ts: tsMs, type: 'mode', id: 'mode', from, to };
}

async function mockEventsApi(page, rows) {
  await page.route('**/api/events**', async (route) => {
    const url = new URL(route.request().url());
    const type = url.searchParams.get('type') || 'mode';
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 100);
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw ? parseInt(beforeRaw, 10) : null;
    const filtered = rows
      .filter(e => e.type === type)
      .filter(e => before === null || e.ts < before);
    const page_ = filtered.slice(0, limit);
    const hasMore = filtered.length > limit;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ events: page_, hasMore }),
    });
  });
}

function makeHistoryPoints(count, intervalMs, startTs) {
  const points = [];
  for (let i = 0; i < count; i++) {
    points.push({
      ts: startTs + i * intervalMs,
      collector: 25 + i * 0.1,
      tank_top: 40 + i * 0.05,
      tank_bottom: 35,
      greenhouse: 18,
      outdoor: 10,
    });
  }
  return points;
}

async function mockHistoryApi(page, points, events) {
  await page.route('**/api/history**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ range: '24h', points: points || [], events: events || [] }),
  }));
}

async function mockWatchdogStateApi(page, snapshot) {
  await page.route('**/api/watchdog/state', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      pending: null,
      watchdogs: [
        { id: 'sng', label: 'Stalled — no gain' },
        { id: 'scs', label: 'Stalled — collector cooling' },
        { id: 'ggr', label: 'Greenhouse not heating' },
      ],
      snapshot: snapshot || { ce: true, ea: 31, mo: null, we: {}, wz: {}, wb: {}, v: 1 },
      recent: [],
    }),
  }));
}

test.describe('Copy System Logs — live mode', () => {
  test('clipboard text contains live mode header and sensor readings', async ({ page }) => {
    const now = Date.now();
    const rows = [makeEvent(now - 60_000, 'idle', 'solar_charging')];
    const historyPoints = makeHistoryPoints(3, 20 * 60 * 1000, now - 60 * 60 * 1000);
    const historyEvents = [{ ts: now - 60_000, type: 'mode', from: 'idle', to: 'solar_charging' }];

    await installMockWs(page);
    await mockHistoryApi(page, historyPoints, historyEvents);
    await mockEventsApi(page, rows);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 5000 });
    await waitForTestHook(page);

    const text = await getClipboardText(page);

    expect(text).toContain('Mode: Live');
    expect(text).toContain('--- Sensor Readings (24h, 20-min resolution) ---');
    expect(text).toContain('--- Transition Log ---');
    expect(text).not.toContain('--- Simulation Parameters ---');
  });

  test('includes live transition log entries', async ({ page }) => {
    const now = Date.now();
    const rows = [
      makeEvent(now - 120_000, 'idle', 'solar_charging'),
      makeEvent(now - 60_000, 'solar_charging', 'greenhouse_heating'),
    ];

    await installMockWs(page, { mode: 'greenhouse_heating' });
    await mockHistoryApi(page);
    await mockEventsApi(page, rows);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 5000 });
    await expect(page.locator('#logs-list .log-item')).toHaveCount(2, { timeout: 5000 });
    await waitForTestHook(page);

    const text = await getClipboardText(page);
    expect(text).toContain('Collecting Solar Energy');
    expect(text).toContain('Heating Greenhouse');
  });

  test('sensor readings table has data rows from history', async ({ page }) => {
    const now = Date.now();
    const historyPoints = makeHistoryPoints(3, 20 * 60 * 1000, now - 60 * 60 * 1000);

    await installMockWs(page);
    await mockHistoryApi(page, historyPoints);
    await mockEventsApi(page, []);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 5000 });
    await waitForTestHook(page);

    const text = await getClipboardText(page);
    expect(text).not.toContain('(no history data available)');
    expect(text).toContain('idle');
  });

  test('controller state section reflects deviceConfig mirror (ce/ea/mo/wb/we)', async ({ page }) => {
    // Reproduces the diagnostic case that motivated the section: idle
    // mode with collectors flagged as drained and a GH watchdog cool-off
    // ban active. Without this section, the user has to cross-reference
    // the watchdog UI to see why mode transitions are gated.
    const nowSec = Math.floor(Date.now() / 1000);
    const banUntil = nowSec + 4 * 3600; // 4 h GH ban

    await installMockWs(page, {
      mode: 'idle',
      flags: { collectors_drained: true, emergency_heating_active: false },
    });
    await mockHistoryApi(page);
    await mockEventsApi(page, []);
    await mockWatchdogStateApi(page, {
      ce: true,
      ea: 31,
      mo: null,
      we: { sng: 1, scs: 1, ggr: 1 },
      wz: {},
      wb: { GH: banUntil },
      v: 42,
    });

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 5000 });
    await waitForTestHook(page);

    const text = await getClipboardText(page);

    expect(text).toContain('--- Controller State ---');
    expect(text).toContain('Mode:               idle');
    expect(text).toContain('Collectors drained: yes');
    expect(text).toContain('Emergency heating:  off');
    expect(text).toContain('Controls enabled:   yes');
    expect(text).toContain('Enabled actuators:  valves, pump, fan, space_heater, immersion_heater (ea=31)');
    expect(text).toContain('Manual override:    off');
    expect(text).toContain('Watchdogs enabled:  sng, scs, ggr');
    expect(text).toContain('Watchdogs snoozed:  none');
    expect(text).toMatch(/Mode bans \(wb\): {5}GH=[34]h\d{2}m/);
    expect(text).toContain('Config version:     42');
  });

  test('controller state shows manual-override forced mode + permanent SC ban', async ({ page }) => {
    const nowSec = Math.floor(Date.now() / 1000);

    await installMockWs(page, {
      mode: 'idle',
      flags: { collectors_drained: false, emergency_heating_active: false },
    });
    await mockHistoryApi(page);
    await mockEventsApi(page, []);
    await mockWatchdogStateApi(page, {
      ce: false,
      ea: 0,
      mo: { a: true, ex: nowSec + 1800, fm: 'I' },
      we: { ggr: 1 },
      wz: { ggr: nowSec + 600 },
      wb: { SC: 9999999999 },
      v: 7,
    });

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 5000 });
    await waitForTestHook(page);

    const text = await getClipboardText(page);

    expect(text).toContain('Controls enabled:   no');
    expect(text).toContain('Enabled actuators:  none (ea=0)');
    expect(text).toMatch(/Manual override: {4}I \(until /);
    expect(text).toContain('Watchdogs enabled:  ggr');
    expect(text).toMatch(/Watchdogs snoozed: {2}ggr=\d+m/);
    expect(text).toContain('Mode bans (wb):     SC=disabled');
  });
});

// ── Timezone tests ──
// The clipboard export and all visible timestamps must render in
// Europe/Helsinki regardless of the browser's local timezone.
// Browser timezone pinned to UTC to make the assertion unambiguous: a
// UTC formatter would emit "…T12:00:00Z", a Helsinki one would emit
// the same wall clock shifted by +02:00 / +03:00 (DST-aware).

test.describe('Copy System Logs — Helsinki timezone', () => {
  test.use({ timezoneId: 'UTC' });

  test('exported timestamp and sensor readings render in Europe/Helsinki', async ({ page }) => {
    // 2026-04-19T10:00:00Z — Helsinki is UTC+3 in April (EEST), so the
    // same instant reads as 13:00 in Helsinki wall clock.
    const fixedMs = Date.UTC(2026, 3, 19, 10, 0, 0);
    const historyPoints = [{
      ts: fixedMs,
      collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10,
    }];

    await installMockWs(page);
    await mockHistoryApi(page, historyPoints);
    await mockEventsApi(page, []);

    // Freeze the clock used for the "Exported:" header.
    await page.addInitScript((frozenMs) => {
      const OrigDate = Date;
      // eslint-disable-next-line no-global-assign, no-implicit-globals
      Date = class extends OrigDate {
        constructor(...args) {
          if (args.length === 0) { super(frozenMs); return; }
          super(...args);
        }
        static now() { return frozenMs; }
      };
      Date.UTC = OrigDate.UTC;
      Date.parse = OrigDate.parse;
    }, fixedMs);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/, { timeout: 5000 });
    await waitForTestHook(page);

    const text = await getClipboardText(page);

    // Helsinki wall clock for 2026-04-19T10:00:00Z is 13:00:00 (EEST, UTC+3).
    // Both the header "Exported:" line and the sensor row should carry that.
    expect(text).toContain('Exported: 2026-04-19 13:00:00');
    expect(text).toMatch(/2026-04-19 13:00:00\s+25\.0/);
    // And never the raw UTC ISO.
    expect(text).not.toContain('2026-04-19T10:00:00');
  });
});
