import { test, expect } from './fixtures.js';

// /ws lifecycle + MQTT-driven state broadcasts. The frontend suite
// stubs the WebSocket constructor and feeds canned messages; here we
// dial the real ws-server in server/lib/ws-server.js so the upgrade
// handshake, retained config replay, and broadcastState fan-out are
// covered end-to-end.

const WS_URL = 'ws://127.0.0.1:3220/ws';

// Connect, push frames into an array, and resolve once the connection
// is open. Tests await `messages` to grow then close.
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

async function waitFor(predicate, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 25));
  }
  return false;
}

test.describe('WebSocket /ws lifecycle', () => {
  test('client receives a connection-status frame on upgrade', async () => {
    // server.js sends a `connection` message with the current MQTT
    // status synchronously after the upgrade. AUTH_ENABLED=false in
    // the harness means no cookie is needed.
    const { ws, messages, ready } = connectWs();
    await ready;
    const seen = await waitFor(() => messages.some(m => m.type === 'connection'));
    expect(seen).toBe(true);
    const conn = messages.find(m => m.type === 'connection');
    expect(['connected', 'reconnecting', 'disconnected']).toContain(conn.status);
    ws.close();
  });

  test('greenhouse/state publish reaches subscribed WS clients', async ({ mqttClient }) => {
    const { ws, messages, ready } = connectWs();
    await ready;
    // Use a unique sentinel temperature so we can distinguish our own
    // publish from any state messages that other workers may be
    // generating in parallel against the shared broker.
    const sentinel = -123.456 - (process.pid % 1000) / 1000;
    await new Promise((resolve, reject) => {
      mqttClient.publish(
        'greenhouse/state',
        JSON.stringify({ ts: new Date().toISOString(), mode: 'idle', temps: { outdoor: sentinel } }),
        { qos: 1 },
        (err) => err ? reject(err) : resolve(),
      );
    });

    const got = await waitFor(() =>
      messages.some(m => m.type === 'state' && m.data && m.data.temps
        && Math.abs(m.data.temps.outdoor - sentinel) < 1e-9));
    expect(got).toBe(true);
    ws.close();
  });

  test('state broadcast is enriched with manual_override field', async ({ mqttClient }) => {
    // broadcastState calls enrichState which always tacks on
    // manual_override (null when no override is active). Confirms the
    // enrichment hop runs for live broadcasts, not just the
    // /ws-upgrade replay.
    const { ws, messages, ready } = connectWs();
    await ready;
    const sentinel = -200 - (process.pid % 1000);
    await new Promise((resolve, reject) => {
      mqttClient.publish(
        'greenhouse/state',
        JSON.stringify({ ts: new Date().toISOString(), mode: 'idle', temps: { outdoor: sentinel } }),
        { qos: 1 },
        (err) => err ? reject(err) : resolve(),
      );
    });
    const got = await waitFor(() =>
      messages.some(m => m.type === 'state' && m.data && m.data.temps
        && m.data.temps.outdoor === sentinel
        && Object.prototype.hasOwnProperty.call(m.data, 'manual_override')));
    expect(got).toBe(true);
    ws.close();
  });

  test('upgrade to non-/ws path is refused (socket destroyed)', async () => {
    // server.js destroys upgrades whose pathname !== '/ws'. The
    // resulting connection should never reach `open` — we expect
    // either an error event or a close.
    const ws = new WebSocket('ws://127.0.0.1:3220/not-ws');
    const outcome = await new Promise((resolve) => {
      ws.addEventListener('open', () => resolve('open'));
      ws.addEventListener('error', () => resolve('error'));
      ws.addEventListener('close', () => resolve('close'));
      setTimeout(() => resolve('timeout'), 2000);
    });
    expect(['error', 'close']).toContain(outcome);
    try { ws.close(); } catch { /* already closed */ }
  });
});
