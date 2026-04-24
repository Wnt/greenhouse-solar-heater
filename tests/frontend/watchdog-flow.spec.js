// @ts-check
import { test, expect } from './fixtures.js';

/**
 * E2E tests for the watchdog anomaly detection UI flow.
 *
 * The playground runs on a static file server (no real API), so we mock
 * the /api/watchdog/state and /api/device-config endpoints with
 * page.route() and inject a mock WebSocket that can deliver
 * `watchdog-state` broadcasts on demand.
 */

const DEFAULT_CONFIG = { ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 };
const WATCHDOGS_META = [
  { id: 'sng', mode: 'SOLAR_CHARGING',     label: 'No tank gain',      shortLabel: 'Tank not heating',      windowSeconds: 600, snoozeTtlSeconds:  7200 },
  { id: 'scs', mode: 'SOLAR_CHARGING',     label: 'Collector stuck',   shortLabel: 'Collector flow stuck',  windowSeconds: 300, snoozeTtlSeconds:  3600 },
  { id: 'ggr', mode: 'GREENHOUSE_HEATING', label: 'No greenhouse rise', shortLabel: 'Greenhouse not warming', windowSeconds: 900, snoozeTtlSeconds: 43200 },
];

/**
 * Mock WebSocket that exposes window.__wdInject(msg) so the test can
 * push broadcast messages into the page at arbitrary times.
 */
async function mockLiveConnectionWithWatchdog(page) {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    window.__wdSent = [];
    // @ts-ignore
    window.WebSocket = function () {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close: function () { this.readyState = 3; },
        send: function (data) { try { window.__wdSent.push(JSON.parse(data)); } catch (e) { /* ignore */ } }
      };
      window.__wdInject = function (msg) {
        if (fake.onmessage) fake.onmessage({ data: JSON.stringify(msg) });
      };
      setTimeout(function () {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
          fake.onmessage({ data: JSON.stringify({
            type: 'state',
            data: {
              mode: 'idle',
              temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
              valves: {}, actuators: { pump: false, fan: false, space_heater: false },
              controls_enabled: true
            }
          }) });
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSED = 3;
  });
}

/** Mock the API endpoints the watchdog UI depends on. */
async function setupWatchdogRoutes(page, opts) {
  opts = opts || {};
  const config = { ...DEFAULT_CONFIG, ...(opts.initialConfig || {}) };
  const calls = { ack: [], shutdownnow: [], enabled: [], deviceConfigPut: [] };

  await mockLiveConnectionWithWatchdog(page);

  // Device config
  await page.route('**/api/device-config', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      await route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(config)
      });
    } else if (method === 'PUT') {
      const body = route.request().postDataJSON();
      calls.deviceConfigPut.push(body);
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ...config, ...body, v: (config.v || 0) + 1 })
      });
    } else {
      await route.continue();
    }
  });

  // Watchdog state
  await page.route('**/api/watchdog/state', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        pending: opts.pending || null,
        watchdogs: WATCHDOGS_META,
        snapshot: { we: config.we || {}, wz: config.wz || {}, wb: config.wb || {} },
        recent: opts.recent || []
      })
    });
  });

  await page.route('**/api/watchdog/ack', async (route) => {
    const body = route.request().postDataJSON();
    calls.ack.push(body);
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ snoozeUntil: Math.floor(Date.now() / 1000) + 43200 })
    });
  });
  await page.route('**/api/watchdog/shutdownnow', async (route) => {
    const body = route.request().postDataJSON();
    calls.shutdownnow.push(body);
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.route('**/api/watchdog/enabled', async (route) => {
    const body = route.request().postDataJSON();
    calls.enabled.push(body);
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ we: { [body.id]: body.enabled ? 1 : 0 } })
    });
  });

  // Prevent other api hangs
  await page.route('**/api/history**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '[]'
  }));
  await page.route('**/api/push/**', route => route.fulfill({
    status: 200, contentType: 'application/json', body: '{}'
  }));

  return calls;
}

test.describe('watchdog flow', () => {
  test('pending banner appears on fired broadcast and clears on ack', async ({ page }) => {
    const calls = await setupWatchdogRoutes(page);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mode-toggle')).toBeVisible();

    // The banner should be hidden initially (no pending)
    await expect(page.locator('#watchdog-banner')).toBeHidden();

    // Inject a watchdog-state fired broadcast via the mock WS
    await page.evaluate(({ watchdogs }) => {
      window.__wdInject({
        type: 'watchdog-state',
        pending: {
          id: 'ggr', firedAt: Math.floor(Date.now() / 1000),
          mode: 'GREENHOUSE_HEATING', dbEventId: 42,
          triggerReason: 'Greenhouse only +0.2°C after 15:00 (expected ≥+0.5°C)'
        },
        watchdogs,
        snapshot: { we: { ggr: 1 }, wz: {}, wb: {} }
      });
    }, { watchdogs: WATCHDOGS_META });

    // Banner should now be visible
    await expect(page.locator('#watchdog-banner')).toBeVisible();
    await expect(page.locator('#watchdog-banner-title')).toContainText('Greenhouse not warming');
    await expect(page.locator('#watchdog-banner-reason')).toContainText('Greenhouse only +0.2');

    // Fill in reason and click snooze
    await page.fill('#watchdog-banner-reply', 'door open testing');
    await page.click('#watchdog-banner-snooze');

    // Wait for the ack request
    await expect.poll(() => calls.ack.length).toBeGreaterThan(0);
    expect(calls.ack[0]).toMatchObject({
      id: 'ggr',
      eventId: 42,
      reason: 'door open testing'
    });

    // Inject a resolved broadcast → banner disappears
    await page.evaluate(({ watchdogs }) => {
      window.__wdInject({
        type: 'watchdog-state',
        pending: null,
        watchdogs,
        snapshot: { we: { ggr: 1 }, wz: { ggr: 9999999999 }, wb: {} }
      });
    }, { watchdogs: WATCHDOGS_META });

    await expect(page.locator('#watchdog-banner')).toBeHidden();
  });

  test('shutdown now button POSTs to /api/watchdog/shutdownnow', async ({ page }) => {
    const calls = await setupWatchdogRoutes(page);

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mode-toggle')).toBeVisible();

    await page.evaluate(({ watchdogs }) => {
      window.__wdInject({
        type: 'watchdog-state',
        pending: {
          id: 'scs', firedAt: Math.floor(Date.now() / 1000),
          mode: 'SOLAR_CHARGING', dbEventId: 7,
          triggerReason: 'Collector only -0.5°C after 5:00 (expected ≥-3°C)'
        },
        watchdogs,
        snapshot: { we: { scs: 1 }, wz: {}, wb: {} }
      });
    }, { watchdogs: WATCHDOGS_META });

    await expect(page.locator('#watchdog-banner')).toBeVisible();
    await page.click('#watchdog-banner-shutdown');

    await expect.poll(() => calls.shutdownnow.length).toBeGreaterThan(0);
    expect(calls.shutdownnow[0]).toMatchObject({ id: 'scs', eventId: 7 });
  });

  test('WS broadcast received during initial GET is not clobbered when GET resolves later', async ({ page }) => {
    // Regression for a race where the initial GET /api/watchdog/state
    // resolved AFTER a WebSocket broadcast had already set the banner
    // visible, and unconditionally overwrote _watchdogPending with the
    // GET's `pending: null`, hiding the banner. The CI failure showed
    // up as flake on tests that injected without a sync gap, because
    // under load the GET could lose the race and resolve last.
    //
    // This test forces the bad order deterministically: the GET is
    // held until the test releases it, and the test injects the WS
    // broadcast first. After releasing the GET, the banner must
    // STILL be visible — the WS state must win.

    await mockLiveConnectionWithWatchdog(page);

    let releaseGet;
    const getReleased = new Promise(resolve => { releaseGet = resolve; });

    // Hold the watchdog/state GET until the test releases it.
    await page.route('**/api/watchdog/state', async (route) => {
      await getReleased;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          pending: null,  // server reports no pending — but WS will say otherwise
          watchdogs: WATCHDOGS_META,
          snapshot: { we: {}, wz: {}, wb: {} },
          recent: []
        })
      });
    });
    await page.route('**/api/device-config', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ ce: true, ea: 31, fm: null, we: {}, wz: {}, wb: {}, v: 1 })
        });
      } else { await route.continue(); }
    });
    await page.route('**/api/history**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: '[]'
    }));
    await page.route('**/api/push/**', route => route.fulfill({
      status: 200, contentType: 'application/json', body: '{}'
    }));

    await page.goto('/playground/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#mode-toggle')).toBeVisible();

    // GET is still pending — inject a WS broadcast that should set the banner
    await page.evaluate(({ watchdogs }) => {
      window.__wdInject({
        type: 'watchdog-state',
        pending: {
          id: 'ggr', firedAt: Math.floor(Date.now() / 1000),
          mode: 'GREENHOUSE_HEATING', dbEventId: 99,
          triggerReason: 'race regression test'
        },
        watchdogs,
        snapshot: { we: { ggr: 1 }, wz: {}, wb: {} }
      });
    }, { watchdogs: WATCHDOGS_META });

    await expect(page.locator('#watchdog-banner')).toBeVisible();

    // Now release the GET — it returns pending:null. Without the
    // fix the banner would be hidden again here. With the fix the
    // GET is discarded because the WS already seeded the state.
    releaseGet();

    // Give the GET a chance to fully resolve. We expect the banner
    // to STAY visible the whole time.
    await page.waitForTimeout(300);
    await expect(page.locator('#watchdog-banner')).toBeVisible();
    await expect(page.locator('#watchdog-banner-title')).toContainText('Greenhouse not warming');
  });
});
