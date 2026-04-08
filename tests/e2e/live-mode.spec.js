// @ts-check
import { test, expect } from './fixtures.js';

test.describe('Live mode toggle', () => {
  test('mode toggle is visible on non-GitHub-Pages deployment', async ({ page }) => {
    await page.goto('/playground/');
    // The app detects localhost as live-capable
    const toggle = page.locator('#mode-toggle');
    await expect(toggle).toBeVisible();
  });

  test('connection status indicator is present', async ({ page }) => {
    await page.goto('/playground/');
    const dot = page.locator('#connection-dot');
    await expect(dot).toBeVisible();
  });

  test('switching to simulation mode shows controls view', async ({ page }) => {
    await page.goto('/playground/');
    // Click toggle to switch to simulation
    const sw = page.locator('#mode-toggle-switch');
    await sw.click();
    // Controls nav item should be visible
    const controlsNav = page.locator('.sidebar-nav [data-view="controls"]');
    await expect(controlsNav).toBeVisible();
  });

  test('simulation mode still works after toggle', async ({ page }) => {
    await page.goto('/playground/');
    // Switch to simulation
    await page.locator('#mode-toggle-switch').click();
    // Start simulation
    await page.locator('#fab-play').click();
    // Wait for simulation to produce data
    await page.waitForTimeout(100);
    // Verify display updates
    const tankTemp = page.locator('#tank-temp-val');
    const text = await tankTemp.textContent();
    expect(text).not.toBe('--');
  });
});

test.describe('Connection state overlays', () => {
  test('never_connected: overlay shows when server is unreachable', async ({ page }) => {
    // Static server has no WS — the app will fail to connect
    await page.goto('/playground/');
    // Overlay should show immediately in live mode (connecting or never_connected)
    const overlay = page.locator('#overlay-modes');
    await expect(overlay).toBeVisible();
    // Initially shows "Connecting..." then transitions to "Cannot reach the server."
    // after the WebSocket connection fails
    await expect(page.locator('#overlay-modes-subtitle')).toHaveText('Cannot reach the server.', { timeout: 5000 });
  });

  test('never_connected: connection dot shows disconnected or reconnecting', async ({ page }) => {
    await page.goto('/playground/');
    await page.waitForTimeout(1500);
    const dot = page.locator('#connection-dot');
    // Dot alternates between disconnected and reconnecting as WS retries
    const cls = await dot.getAttribute('class');
    expect(cls).toMatch(/disconnected|reconnecting/);
  });

  test('never_connected: all three overlay zones are visible', async ({ page }) => {
    await page.goto('/playground/');
    await page.waitForTimeout(1500);
    await expect(page.locator('#overlay-modes')).toBeVisible();
    await expect(page.locator('#overlay-gauge')).toBeVisible();
    await expect(page.locator('#overlay-components')).toBeVisible();
  });

  test('switching to simulation removes all overlays', async ({ page }) => {
    await page.goto('/playground/');
    await page.waitForTimeout(1500);
    // Overlays should be visible in live mode
    await expect(page.locator('#overlay-modes')).toBeVisible();
    // Switch to simulation
    await page.locator('#mode-toggle-switch').click();
    // Overlays should be hidden
    await expect(page.locator('#overlay-modes')).not.toBeVisible();
    await expect(page.locator('#overlay-gauge')).not.toBeVisible();
    await expect(page.locator('#overlay-components')).not.toBeVisible();
  });

  test('device_offline: overlay shows when WS connects but MQTT is disconnected', async ({ page }) => {
    // Mock WebSocket to simulate server connected but MQTT down
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      // @ts-ignore
      window.WebSocket = function(url) {
        const fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
          close() { this.readyState = 3; },
          send() {},
        };
        setTimeout(() => {
          fake.readyState = 1;
          if (fake.onopen) fake.onopen(new Event('open'));
          // Server sends MQTT disconnected status
          if (fake.onmessage) {
            fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'disconnected' }) });
          }
        }, 50);
        return fake;
      };
      // @ts-ignore
      window.WebSocket.prototype = OrigWS.prototype;
    });
    await page.goto('/playground/');
    // Wait for mock WS to connect and MQTT status to propagate
    await page.waitForTimeout(500);
    const overlay = page.locator('#overlay-modes');
    await expect(overlay).toBeVisible();
    await expect(page.locator('#overlay-modes-subtitle')).toHaveText(
      'The server is running, but the controller is unreachable.'
    );
  });

  test('device_offline: connection dot shows device-offline class', async ({ page }) => {
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      // @ts-ignore
      window.WebSocket = function(url) {
        const fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
          close() { this.readyState = 3; },
          send() {},
        };
        setTimeout(() => {
          fake.readyState = 1;
          if (fake.onopen) fake.onopen(new Event('open'));
          if (fake.onmessage) {
            fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'disconnected' }) });
          }
        }, 50);
        return fake;
      };
      // @ts-ignore
      window.WebSocket.prototype = OrigWS.prototype;
    });
    await page.goto('/playground/');
    await page.waitForTimeout(500);
    const dot = page.locator('#connection-dot');
    await expect(dot).toHaveClass(/device-offline/);
    await expect(page.locator('#connection-label')).toHaveText('Controller offline');
  });

  test('device_offline: overlay clears when state data arrives', async ({ page }) => {
    let sendMessage;
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      // @ts-ignore
      window.WebSocket = function(url) {
        const fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
          close() { this.readyState = 3; },
          send() {},
        };
        // Store ref for later use
        // @ts-ignore
        window.__mockWs = fake;
        setTimeout(() => {
          fake.readyState = 1;
          if (fake.onopen) fake.onopen(new Event('open'));
          if (fake.onmessage) {
            fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'disconnected' }) });
          }
        }, 50);
        return fake;
      };
      // @ts-ignore
      window.WebSocket.prototype = OrigWS.prototype;
    });
    await page.goto('/playground/');
    await page.waitForTimeout(500);
    // Overlay should be visible
    await expect(page.locator('#overlay-modes')).toBeVisible();
    // Simulate state data arriving via MQTT
    await page.evaluate(() => {
      // @ts-ignore
      const ws = window.__mockWs;
      if (ws && ws.onmessage) {
        // First send MQTT connected
        ws.onmessage({ data: JSON.stringify({ type: 'connection', status: 'connected' }) });
        // Then send state data
        ws.onmessage({ data: JSON.stringify({
          type: 'state',
          data: {
            mode: 'idle',
            temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
            valves: {}, actuators: { pump: false, fan: false, space_heater: false },
            controls_enabled: true,
          }
        }) });
      }
    });
    // Overlay should be removed
    await expect(page.locator('#overlay-modes')).not.toBeVisible();
    await expect(page.locator('#connection-dot')).toHaveClass(/connected/);
    await expect(page.locator('#connection-label')).toHaveText('Live');
  });
});

test.describe('Manual override gating with unbound sensors', () => {
  // Helper: install a mock WebSocket that lets the test push state messages
  // into the page after navigation. The Shelly publishes `null` for any
  // temperature whose role is not assigned, and the override button must
  // still become enableable when controls_enabled is true.
  async function installMockWs(page) {
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      // @ts-ignore
      window.WebSocket = function (url) {
        const fake = {
          readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
          close() { this.readyState = 3; },
          send() {},
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
    });
  }

  test('Enter Manual Override becomes enabled when controls_enabled=true even if all sensors are null', async ({ page }) => {
    await installMockWs(page);
    await page.goto('/playground/#device');
    await page.waitForTimeout(300);

    // Push a Shelly-shaped state with all sensors unbound (null) and controls enabled
    await page.evaluate(() => {
      // @ts-ignore
      const ws = window.__mockWs;
      if (!ws || !ws.onmessage) throw new Error('mock ws not initialized');
      ws.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: {
            ts: Date.now(),
            mode: 'idle',
            transitioning: false,
            transition_step: null,
            temps: { collector: null, tank_top: null, tank_bottom: null, greenhouse: null, outdoor: null },
            valves: { vi_btm: false, vi_top: false, vi_coll: false, vo_coll: false, vo_rad: false, vo_tank: false, v_ret: false, v_air: false },
            actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
            flags: { collectors_drained: false, emergency_heating_active: false },
            controls_enabled: true,
            manual_override: null,
          },
        }),
      });
    });

    // Button should be enabled — the live-update pipeline must not throw on null temps
    const btn = page.locator('#override-enter-btn');
    await expect(btn).toBeEnabled({ timeout: 3000 });
  });

  test('Live-update pipeline does not throw uncaught errors on null sensor data', async ({ page }) => {
    await installMockWs(page);

    const errors = [];
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/playground/#device');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      // @ts-ignore
      const ws = window.__mockWs;
      ws.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: {
            ts: Date.now(), mode: 'idle',
            temps: { collector: null, tank_top: null, tank_bottom: null, greenhouse: null, outdoor: null },
            valves: {}, actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
            controls_enabled: true, manual_override: null,
          },
        }),
      });
    });

    await page.waitForTimeout(500);
    expect(errors, 'no uncaught page errors').toEqual([]);
  });

  test('temperature display shows placeholder for null sensors instead of crashing', async ({ page }) => {
    await installMockWs(page);
    await page.goto('/playground/#components');
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      // @ts-ignore
      const ws = window.__mockWs;
      ws.onmessage({
        data: JSON.stringify({
          type: 'state',
          data: {
            ts: Date.now(), mode: 'idle',
            temps: { collector: null, tank_top: 42.5, tank_bottom: null, greenhouse: null, outdoor: null },
            valves: {}, actuators: { pump: false, fan: false, space_heater: false, immersion_heater: false },
            controls_enabled: true, manual_override: null,
          },
        }),
      });
    });

    const tempTable = page.locator('#temp-table');
    // Bound sensor renders as a number, unbound sensors render as a placeholder
    await expect(tempTable).toContainText('42.5', { timeout: 3000 });
    await expect(tempTable).toContainText('—');
  });
});

test.describe('FAB visibility', () => {
  test('FAB is hidden in live mode', async ({ page }) => {
    await page.goto('/playground/');
    // On localhost the app starts in live mode
    const fab = page.locator('#fab-play');
    await expect(fab).not.toBeVisible();
  });

  test('FAB becomes visible when switching to simulation', async ({ page }) => {
    await page.goto('/playground/');
    // Switch to simulation mode
    await page.locator('#mode-toggle-switch').click();
    const fab = page.locator('#fab-play');
    await expect(fab).toBeVisible();
  });

  test('FAB is hidden again when switching back to live', async ({ page }) => {
    await page.goto('/playground/');
    // Switch to simulation
    await page.locator('#mode-toggle-switch').click();
    await expect(page.locator('#fab-play')).toBeVisible();
    // Switch back to live
    await page.locator('#mode-toggle-switch').click();
    await expect(page.locator('#fab-play')).not.toBeVisible();
  });
});

test.describe('Sidebar subtitle', () => {
  test('shows "Connecting..." initially then "Offline" when server is unreachable', async ({ page }) => {
    await page.goto('/playground/');
    const subtitle = page.locator('#sidebar-subtitle');
    // Initially shows Connecting or Offline
    await expect(subtitle).toHaveText(/Connecting…|Offline/);
    // After WS fails, shows Offline
    await expect(subtitle).toHaveText('Offline', { timeout: 5000 });
  });

  test('shows "Ready" in simulation mode', async ({ page }) => {
    await page.goto('/playground/');
    await page.locator('#mode-toggle-switch').click();
    const subtitle = page.locator('#sidebar-subtitle');
    await expect(subtitle).toHaveText('Ready');
  });

  test('shows "Simulating..." when simulation is running', async ({ page }) => {
    await page.goto('/playground/');
    await page.locator('#mode-toggle-switch').click();
    await page.locator('#fab-play').click();
    const subtitle = page.locator('#sidebar-subtitle');
    await expect(subtitle).toHaveText('Simulating...');
  });

  test('shows "Controller Offline" when WS connected but MQTT disconnected', async ({ page }) => {
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      // @ts-ignore
      window.WebSocket = function(url) {
        const fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
          close() { this.readyState = 3; },
          send() {},
        };
        setTimeout(() => {
          fake.readyState = 1;
          if (fake.onopen) fake.onopen(new Event('open'));
          if (fake.onmessage) {
            fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'disconnected' }) });
          }
        }, 50);
        return fake;
      };
      // @ts-ignore
      window.WebSocket.prototype = OrigWS.prototype;
    });
    await page.goto('/playground/');
    await page.waitForTimeout(500);
    const subtitle = page.locator('#sidebar-subtitle');
    await expect(subtitle).toHaveText('Controller Offline');
  });

  test('subtitle has offline pulsating class when controller offline', async ({ page }) => {
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      // @ts-ignore
      window.WebSocket = function(url) {
        const fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
          close() { this.readyState = 3; },
          send() {},
        };
        setTimeout(() => {
          fake.readyState = 1;
          if (fake.onopen) fake.onopen(new Event('open'));
          if (fake.onmessage) {
            fake.onmessage({ data: JSON.stringify({ type: 'connection', status: 'disconnected' }) });
          }
        }, 50);
        return fake;
      };
      // @ts-ignore
      window.WebSocket.prototype = OrigWS.prototype;
    });
    await page.goto('/playground/');
    await page.waitForTimeout(500);
    const subtitle = page.locator('#sidebar-subtitle');
    await expect(subtitle).toHaveClass('subtitle-offline');
  });

  test('shows "Live" with live class when data is flowing', async ({ page }) => {
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;
      // @ts-ignore
      window.WebSocket = function(url) {
        const fake = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null,
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
                temps: { collector: 25, tank_top: 40, tank_bottom: 35, greenhouse: 18, outdoor: 10 },
                valves: {}, actuators: { pump: false, fan: false, space_heater: false },
                controls_enabled: true,
              }
            }) });
          }
        }, 50);
        return fake;
      };
      // @ts-ignore
      window.WebSocket.prototype = OrigWS.prototype;
    });
    await page.goto('/playground/');
    await page.waitForTimeout(500);
    const subtitle = page.locator('#sidebar-subtitle');
    await expect(subtitle).toHaveText('Live');
    await expect(subtitle).toHaveClass('subtitle-live');
  });
});

test.describe('Immediate overlay on load', () => {
  test('overlay appears immediately in live mode, not after delay', async ({ page }) => {
    await page.goto('/playground/');
    // Overlay should be visible immediately (connecting state), not showing stale simulation data
    const overlay = page.locator('#overlay-modes');
    await expect(overlay).toBeVisible({ timeout: 500 });
  });

  test('switching to live from simulation immediately shows overlay', async ({ page }) => {
    await page.goto('/playground/');
    // Switch to simulation first
    await page.locator('#mode-toggle-switch').click();
    await expect(page.locator('#overlay-modes')).not.toBeVisible();
    // Switch back to live
    await page.locator('#mode-toggle-switch').click();
    // Overlay should appear immediately
    await expect(page.locator('#overlay-modes')).toBeVisible({ timeout: 500 });
  });
});
