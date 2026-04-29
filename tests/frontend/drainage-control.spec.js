// @ts-check
// Drainage control card — exercises the high-level drain/refill UI in the
// device view. Mocks the WebSocket so we can drive both the outbound
// commands the card sends and the state frames it reacts to.
//
// What this guards:
//   - Static DOM shape matches what drainage-control.js expects.
//   - Status badge tracks flags.collectors_drained from the live frame.
//   - Drain button sends override-enter { fm: 'AD', ttl: 600 } and is
//     disabled when already drained.
//   - Refill button sends override-enter { fm: 'SC', ttl: 1800 } and is
//     disabled when already filled.
//   - Auto-exit fires when the controller reports the target state
//     (drain → idle+drained / refill → solar_charging+!drained).
//   - Buttons are gated by controls_enabled and by an in-flight override
//     belonging to another UI surface.

import { test, expect } from './fixtures.js';

// Helper — installs a mock WebSocket that exposes both an inbox (incoming
// messages we can push from the test) and an outbox (commands the page
// sent). Mirrors the pattern in live-mode.spec.js but adds outbound
// capture so we can assert on what the drain/refill buttons emit.
async function installMockWs(page) {
  await page.addInitScript(() => {
    const OrigWS = window.WebSocket;
    // @ts-ignore
    window.__sentCommands = [];
    // @ts-ignore
    window.WebSocket = function (_url) {
      const fake = {
        readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
        close() { this.readyState = 3; },
        send(payload) {
          // @ts-ignore
          window.__sentCommands.push(JSON.parse(payload));
        },
      };
      // @ts-ignore
      window.__mockWs = fake;
      setTimeout(() => {
        fake.readyState = 1;
        if (fake.onopen) fake.onopen(new Event('open'));
        if (fake.onmessage) {
          fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
        }
      }, 50);
      return fake;
    };
    // @ts-ignore
    window.WebSocket.prototype = OrigWS.prototype;
    // Preserve readyState constants so data-source.js's
    // `readyState !== WebSocket.OPEN` check doesn't always fail.
    // @ts-ignore
    window.WebSocket.CONNECTING = 0;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
    // @ts-ignore
    window.WebSocket.CLOSING = 2;
    // @ts-ignore
    window.WebSocket.CLOSED = 3;
    // Auto-confirm any window.confirm() calls so the drain/refill flow
    // proceeds without a prompt blocker.
    window.confirm = () => true;
  });
}

// Push a state frame through the mock WS. Frame is the inner `data` —
// we wrap it in the { type: 'state', data: ... } envelope that the
// LiveSource expects.
async function pushState(page, frame) {
  await page.evaluate((f) => {
    // @ts-ignore
    const ws = window.__mockWs;
    if (!ws || !ws.onmessage) throw new Error('mock ws not initialized');
    ws.onmessage({ data: JSON.stringify({ type: 'state', data: f }) });
  }, frame);
}

function buildFrame(overrides = {}) {
  return Object.assign({
    ts: Date.now(),
    mode: 'idle',
    transitioning: false,
    transition_step: null,
    temps: { collector: 5, tank_top: 20, tank_bottom: 18, greenhouse: 12, outdoor: 4 },
    valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_air: false },
    actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
    flags: { collectors_drained: false, emergency_heating_active: false },
    controls_enabled: true,
    manual_override: null,
  }, overrides);
}

test.describe('drainage control card — static DOM', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/playground/#device');
  });

  test('card and key elements exist', async ({ page }) => {
    await expect(page.locator('#drainage-control-card')).toHaveCount(1);
    await expect(page.locator('#drainage-status-badge')).toHaveCount(1);
    await expect(page.locator('#drainage-drain-btn')).toHaveCount(1);
    await expect(page.locator('#drainage-refill-btn')).toHaveCount(1);
    await expect(page.locator('#drainage-progress')).toHaveCount(1);
    await expect(page.locator('#drainage-abort-btn')).toHaveCount(1);
  });

  test('actions disabled and progress hidden on static load', async ({ page }) => {
    await expect(page.locator('#drainage-drain-btn')).toBeDisabled();
    await expect(page.locator('#drainage-refill-btn')).toBeDisabled();
    await expect(page.locator('#drainage-progress')).toBeHidden();
  });

  test('card sits above the manual relay testing card', async ({ page }) => {
    // Section order matters — drainage-control should be the first card
    // inside #view-device after the staged-valve detail card.
    const order = await page.locator('#view-device .card').evaluateAll(
      els => els.map(e => e.id)
    );
    const drainIdx = order.indexOf('drainage-control-card');
    const relayIdx = order.indexOf('relay-override-card');
    expect(drainIdx).toBeGreaterThan(-1);
    expect(relayIdx).toBeGreaterThan(-1);
    expect(drainIdx).toBeLessThan(relayIdx);
  });
});

test.describe('drainage control card — live state interaction', () => {
  test.beforeEach(async ({ page }) => {
    await installMockWs(page);
    await page.goto('/playground/#device');
    // Wait for app init AND for the page to have constructed the
    // (mocked) WebSocket — the 50 ms setTimeout in installMockWs only
    // fires after `new WebSocket(...)` runs during init.
    await page.waitForFunction(() => window.__initComplete === true);
    await page.waitForFunction(() => /** @type {any} */ (window).__mockWs?.onmessage);
  });

  test('badge shows FILLED + Drain enabled when collectors_drained=false', async ({ page }) => {
    await pushState(page, buildFrame({ flags: { collectors_drained: false, emergency_heating_active: false } }));
    await expect(page.locator('#drainage-status-badge')).toHaveText('FILLED', { timeout: 3000 });
    await expect(page.locator('#drainage-drain-btn')).toBeEnabled();
    await expect(page.locator('#drainage-refill-btn')).toBeDisabled();
  });

  test('badge shows DRAINED + Refill enabled when collectors_drained=true', async ({ page }) => {
    await pushState(page, buildFrame({ flags: { collectors_drained: true, emergency_heating_active: false } }));
    await expect(page.locator('#drainage-status-badge')).toHaveText('DRAINED', { timeout: 3000 });
    await expect(page.locator('#drainage-drain-btn')).toBeDisabled();
    await expect(page.locator('#drainage-refill-btn')).toBeEnabled();
  });

  test('both buttons disabled when controls_enabled=false', async ({ page }) => {
    await pushState(page, buildFrame({ controls_enabled: false }));
    await expect(page.locator('#drainage-drain-btn')).toBeDisabled({ timeout: 3000 });
    await expect(page.locator('#drainage-refill-btn')).toBeDisabled();
  });

  test('both buttons disabled when another manual override is already active', async ({ page }) => {
    await pushState(page, buildFrame({
      manual_override: { active: true, expiresAt: Math.floor(Date.now() / 1000) + 300, forcedMode: 'I' },
    }));
    await expect(page.locator('#drainage-drain-btn')).toBeDisabled({ timeout: 3000 });
    await expect(page.locator('#drainage-refill-btn')).toBeDisabled();
  });

  test('Drain button sends override-enter { fm: AD, ttl: 600 }', async ({ page }) => {
    await pushState(page, buildFrame());
    await expect(page.locator('#drainage-drain-btn')).toBeEnabled({ timeout: 3000 });
    await page.locator('#drainage-drain-btn').click();
    const sent = await page.evaluate(() => /** @type {any} */ (window).__sentCommands);
    const drainCmd = sent.find((c) => c.type === 'override-enter' && c.forcedMode === 'AD');
    expect(drainCmd).toBeDefined();
    expect(drainCmd.ttl).toBe(600);
    // Progress banner should appear
    await expect(page.locator('#drainage-progress')).toBeVisible();
  });

  test('Refill button sends override-enter { fm: SC, ttl: 1800 }', async ({ page }) => {
    await pushState(page, buildFrame({ flags: { collectors_drained: true, emergency_heating_active: false } }));
    await expect(page.locator('#drainage-refill-btn')).toBeEnabled({ timeout: 3000 });
    await page.locator('#drainage-refill-btn').click();
    const sent = await page.evaluate(() => /** @type {any} */ (window).__sentCommands);
    const refillCmd = sent.find((c) => c.type === 'override-enter' && c.forcedMode === 'SC');
    expect(refillCmd).toBeDefined();
    expect(refillCmd.ttl).toBe(1800);
    await expect(page.locator('#drainage-progress')).toBeVisible();
  });

  test('drain auto-exits override once controller reports drained && idle', async ({ page }) => {
    // 1. Initial filled state
    await pushState(page, buildFrame());
    await expect(page.locator('#drainage-drain-btn')).toBeEnabled({ timeout: 3000 });

    // 2. Click Drain — triggers override-enter
    await page.locator('#drainage-drain-btn').click();

    // 3. Server ACKs by transitioning to AD with override active
    const exp = Math.floor(Date.now() / 1000) + 600;
    await pushState(page, buildFrame({
      mode: 'active_drain',
      manual_override: { active: true, expiresAt: exp, forcedMode: 'AD' },
    }));
    await expect(page.locator('#drainage-progress-title')).toHaveText('Draining collectors…', { timeout: 3000 });

    // 4. Drain completes — controller transitions to IDLE with drained=true
    await pushState(page, buildFrame({
      mode: 'idle',
      flags: { collectors_drained: true, emergency_heating_active: false },
      manual_override: { active: true, expiresAt: exp, forcedMode: 'AD' },
    }));

    // 5. Card should auto-send override-exit
    await expect.poll(async () => {
      const sent = await page.evaluate(() => /** @type {any} */ (window).__sentCommands);
      return sent.some((c) => c.type === 'override-exit');
    }, { timeout: 3000 }).toBe(true);

    // Progress banner cleared
    await expect(page.locator('#drainage-progress')).toBeHidden();
  });

  test('refill holds pump for 3 minutes before auto-exiting, even if controller reports !drained earlier', async ({ page }) => {
    await page.clock.install();
    // 1. Initial drained state
    await pushState(page, buildFrame({ flags: { collectors_drained: true, emergency_heating_active: false } }));
    await expect(page.locator('#drainage-refill-btn')).toBeEnabled({ timeout: 3000 });

    // 2. Click Refill
    await page.locator('#drainage-refill-btn').click();

    // 3. Server ACKs — override active in SC, but still drained while flow starts
    const exp = Math.floor(Date.now() / 1000) + 1800;
    await pushState(page, buildFrame({
      mode: 'solar_charging',
      flags: { collectors_drained: true, emergency_heating_active: false },
      manual_override: { active: true, expiresAt: exp, forcedMode: 'SC' },
    }));
    await expect(page.locator('#drainage-progress-title')).toHaveText('Refilling collectors…', { timeout: 3000 });

    // 4. Controller clears the drained flag a few seconds in — pump must keep
    //    running for the full 3-minute hold so collectors actually fill.
    await page.clock.fastForward(10_000);
    await pushState(page, buildFrame({
      mode: 'solar_charging',
      flags: { collectors_drained: false, emergency_heating_active: false },
      manual_override: { active: true, expiresAt: exp, forcedMode: 'SC' },
    }));

    // 5. Verify NO auto-exit yet — we are still inside the 3-minute hold.
    await page.waitForTimeout(200);
    const sent = await page.evaluate(() => /** @type {any} */ (window).__sentCommands);
    expect(sent.some((c) => c.type === 'override-exit')).toBe(false);

    // 6. Fast-forward past the 3-minute minimum and push another frame.
    await page.clock.fastForward(3 * 60_000);
    await pushState(page, buildFrame({
      mode: 'solar_charging',
      flags: { collectors_drained: false, emergency_heating_active: false },
      manual_override: { active: true, expiresAt: exp, forcedMode: 'SC' },
    }));

    // 7. Now the card should auto-send override-exit.
    await expect.poll(async () => {
      const cmds = await page.evaluate(() => /** @type {any} */ (window).__sentCommands);
      return cmds.some((c) => c.type === 'override-exit');
    }, { timeout: 3000 }).toBe(true);
  });

  test('Abort sends override-exit and clears the in-progress banner', async ({ page }) => {
    await pushState(page, buildFrame());
    await expect(page.locator('#drainage-drain-btn')).toBeEnabled({ timeout: 3000 });
    await page.locator('#drainage-drain-btn').click();
    await expect(page.locator('#drainage-progress')).toBeVisible();

    // Clear the outbox so we can detect the new exit cleanly
    await page.evaluate(() => { /** @type {any} */ (window).__sentCommands = []; });

    await page.locator('#drainage-abort-btn').click();
    const sent = await page.evaluate(() => /** @type {any} */ (window).__sentCommands);
    expect(sent.find((c) => c.type === 'override-exit')).toBeDefined();
    await expect(page.locator('#drainage-progress')).toBeHidden();
  });
});
