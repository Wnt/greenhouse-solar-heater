import { test, expect } from './fixtures.js';

// Covers CLAUDE.md §Critical Rules: "Device communication flows
// through MQTT". The frontend suite mocks out /api/device-config and
// asserts on the request body; this spec drives the real PUT and
// verifies a retained message actually lands on greenhouse/config.
//
// If this goes red, the mqtt-bridge → broker hop is broken —
// likely to affect sensor-config and relay-command flows too.
test.describe('device-config PUT → MQTT publish', () => {
  test('publishes the new config to greenhouse/config (retained)', async ({ page, mqttClient }) => {
    // Subscribing to greenhouse/config immediately delivers the
    // retained "current config" message that the server re-publishes
    // on every MQTT (re)connect (see republishDeviceConfig). We don't
    // care about that one — filter by the unique `ea` value we're
    // about to send.
    const targetEa = 31;
    const messages = [];
    mqttClient.on('message', (topic, payload) => {
      if (topic === 'greenhouse/config') messages.push(JSON.parse(payload.toString()));
    });
    await new Promise((resolve, reject) => {
      mqttClient.subscribe('greenhouse/config', { qos: 1 }, (err) => err ? reject(err) : resolve());
    });

    const banUntil = Math.floor(Date.now() / 1000) + 3600;
    const res = await page.request.put('/api/device-config', {
      data: { ea: targetEa, wb: { I: banUntil } },
    });
    expect(res.status()).toBe(200);

    await expect.poll(() => messages.find(m => m.ea === targetEa) ?? null,
      { timeout: 3000 }).not.toBeNull();
    const msg = messages.find(m => m.ea === targetEa);
    expect(msg.wb).toEqual({ I: banUntil });
  });
});
