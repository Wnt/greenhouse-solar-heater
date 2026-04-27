import { test, expect } from './fixtures.js';

// Covers CLAUDE.md §Critical Rules: "Device communication flows
// through MQTT". The frontend suite mocks out /api/device-config and
// asserts on the request body; this spec drives the real PUT and
// verifies a retained message actually lands on greenhouse/config.
//
// If this goes red, the mqtt-bridge → broker hop is broken —
// likely to affect sensor-config and relay-command flows too.

let counter = 0;

test.describe('device-config PUT → MQTT publish', () => {
  test('publishes the new config to greenhouse/config (retained)', async ({ page, mqttClient }) => {
    // Subscribing to greenhouse/config immediately delivers the
    // retained "current config" message that the server re-publishes
    // on every MQTT (re)connect (see republishDeviceConfig). We don't
    // care about that one. Filter by a unique `wb.I` value so this test
    // doesn't pick up a config published by another parallel worker —
    // every worker subscribes to the same retained topic on a shared
    // broker, so `find(m => m.ea === 31)` would also match a sibling
    // worker's PUT.
    const targetEa = 31;
    const messages = [];
    mqttClient.on('message', (topic, payload) => {
      if (topic === 'greenhouse/config') messages.push(JSON.parse(payload.toString()));
    });
    await new Promise((resolve, reject) => {
      mqttClient.subscribe('greenhouse/config', { qos: 1 }, (err) => err ? reject(err) : resolve());
    });

    // Worker-unique banUntil: pid + sub-millisecond entropy so two workers
    // that hit Date.now() in the same millisecond still pick distinct
    // values. (Workers occupy disjoint pids, so pid alone is enough; the
    // counter is belt-and-braces for parallel repeats inside one worker.)
    const banUntil = Math.floor(Date.now() / 1000) + 3600
      + (process.pid % 7919) + (++counter);
    const res = await page.request.put('/api/device-config', {
      data: { ea: targetEa, wb: { I: banUntil } },
    });
    expect(res.status()).toBe(200);

    const matchOurs = (m) => m.ea === targetEa && m.wb && m.wb.I === banUntil;
    await expect.poll(() => messages.find(matchOurs) ?? null,
      { timeout: 3000 }).not.toBeNull();
    const msg = messages.find(matchOurs);
    expect(msg.wb).toEqual({ I: banUntil });
  });
});
