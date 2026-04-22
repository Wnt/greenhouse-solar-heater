import { test, expect } from './fixtures.js';

// Shelly → MQTT → server → pg-mem → HTTP round-trip. The frontend
// suite stubs /api/history with canned payloads; here the reading
// flows through the real mqtt-bridge parser and db.insertSensorReadings.
//
// If this goes red, either the state-message parser changed shape or
// the pg-mem schema stub in tests/e2e/_setup/start.cjs drifted from
// server/lib/db-schema.js.
test.describe('greenhouse/state publish → /api/history', () => {
  test('a state message with temps shows up in history within the range window', async ({ page, mqttClient }) => {
    // insertSensorReadings whitelists sensor ids to the five roles
    // the app ships with (collector, tank_top, tank_bottom,
    // greenhouse, outdoor). Anything else is silently dropped, so the
    // spec has to use one of those.
    const sensorId = 'collector';
    const value = 42.5;

    await new Promise((resolve, reject) => {
      mqttClient.publish(
        'greenhouse/state',
        JSON.stringify({ ts: new Date().toISOString(), mode: 'idle', temps: { [sensorId]: value } }),
        { qos: 1 },
        (err) => err ? reject(err) : resolve(),
      );
    });

    // The write is fire-and-forget on the server side — poll until the
    // row is visible rather than guessing a sleep interval. range=all
    // hits the aggregate path (sensor_readings_30s view) which pg-mem
    // can parse; the ≤6h ranges use a UNION ALL that pg-mem rejects.
    await expect.poll(async () => {
      const res = await page.request.get(`/api/history?range=all&sensor=${sensorId}`);
      if (res.status() !== 200) return null;
      const body = await res.json();
      // pivotReadings keys each point by sensor_id, not a `value` field.
      return body.points?.find(p => Math.abs(p[sensorId] - value) < 1e-6) ?? null;
    }, { timeout: 5000 }).not.toBeNull();
  });
});
