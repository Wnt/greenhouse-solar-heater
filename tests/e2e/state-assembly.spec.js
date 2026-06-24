import { test, expect } from './fixtures.js';

// End-to-end of the Epic #254 server-side assembly: a device publishes the
// slimmed decision payload on greenhouse/state/min AND native Shelly relay
// status on `<prefix>/status/switch:<id>`; the server reconstructs the full
// greenhouse/state (valves/actuators from relay status, controls_enabled from
// device config) and (a) broadcasts it to WS clients and (b) derives
// valve/actuator state_events.
//
// The e2e harness sets RELAY_TOPIC_MAP so the server maps our fake device
// prefixes to the real device IPs. See tests/e2e/_setup/start.cjs.

const WS_URL = 'ws://127.0.0.1:3220/ws';

function connectWs() {
  const messages = [];
  const ws = new WebSocket(WS_URL);
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', reject);
  });
  ws.addEventListener('message', (ev) => {
    try { messages.push(JSON.parse(ev.data)); } catch { /* ignore */ }
  });
  return { ws, messages, ready };
}

async function waitFor(predicate, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = predicate();
    if (v) return v;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
}

function pub(mqttClient, topic, body) {
  return new Promise((resolve, reject) => {
    mqttClient.publish(topic, JSON.stringify(body), { qos: 1 },
      (err) => err ? reject(err) : resolve());
  });
}

test.describe('greenhouse/state/min + relay status → assembled greenhouse/state', () => {
  test('valves/actuators reconstructed from native relay status appear on the WS broadcast', async ({ mqttClient }) => {
    const { ws, messages, ready } = connectWs();
    await ready;

    // Native relay status: pump (4PM id0) on, vi_btm (.51 id0) open.
    await pub(mqttClient, 'fake-4pm/status/switch:0', { id: 0, output: true });
    await pub(mqttClient, 'fake-51/status/switch:0', { id: 0, output: true });

    // Unique sentinel so we pick our own assembled frame out of the shared
    // broker traffic.
    const sentinel = -300 - (process.pid % 1000);
    await pub(mqttClient, 'greenhouse/state/min', {
      ts: Date.now(),
      mode: 'solar_charging',
      transitioning: false,
      transition_step: null,
      temps: { outdoor: sentinel },
      flags: { collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: false },
      opening: [], queued_opens: [], pending_closes: [],
      cause: 'automation', reason: 'solar_enter', eval_reason: 'solar_active', held: null,
    });

    const frame = await waitFor(() => messages.find(
      (m) => m.type === 'state' && m.data && m.data.temps && m.data.temps.outdoor === sentinel));
    expect(frame).not.toBeNull();
    const data = frame.data;
    // valves/actuators are SERVER-assembled — they are not in greenhouse/state/min.
    expect(data.actuators.pump).toBe(true);
    expect(data.valves.vi_btm).toBe(true);
    expect(data.valves.vi_top).toBe(false); // never published → fallback false
    // Full byte-compatible key set is present.
    expect(Object.keys(data)).toEqual([
      'ts', 'mode', 'transitioning', 'transition_step', 'temps', 'valves', 'actuators',
      'flags', 'controls_enabled', 'manual_override', 'opening', 'queued_opens',
      'pending_closes', 'cause', 'reason', 'eval_reason', 'held',
    ]);
    ws.close();
  });

  test('a relay flip observed via status notifications is reflected across consecutive assembled frames', async ({ mqttClient }) => {
    // Cross-process proof that relay status drives the assembled actuators
    // field. The DB-event derivation off the assembled payload is covered
    // deterministically in the mqtt-bridge unit suite; here we only assert the
    // assembled WS frame, which is race-free per-frame when we confirm each
    // frame on the WS before advancing.
    const { ws, messages, ready } = connectWs();
    await ready;

    // Frame A: fan off.
    await pub(mqttClient, 'fake-4pm/status/switch:1', { id: 1, output: false });
    const s0 = -400 - (process.pid % 1000);
    await pub(mqttClient, 'greenhouse/state/min', {
      ts: Date.now(), mode: 'idle', temps: { greenhouse: s0 },
      flags: { collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: false },
    });
    const offFrame = await waitFor(() => messages.find((m) => m.type === 'state' && m.data
      && m.data.temps && m.data.temps.greenhouse === s0 && m.data.actuators.fan === false));
    expect(offFrame).not.toBeNull();

    // Frame B: fan on (relay status), then the next state/min tick.
    await pub(mqttClient, 'fake-4pm/status/switch:1', { id: 1, output: true });
    const s1 = s0 - 1;
    await pub(mqttClient, 'greenhouse/state/min', {
      ts: Date.now(), mode: 'idle', temps: { greenhouse: s1 },
      flags: { collectors_drained: false, emergency_heating_active: false, greenhouse_fan_cooling_active: true },
    });
    const onFrame = await waitFor(() => messages.find((m) => m.type === 'state' && m.data
      && m.data.temps && m.data.temps.greenhouse === s1 && m.data.actuators.fan === true));
    expect(onFrame).not.toBeNull();
    ws.close();
  });
});
