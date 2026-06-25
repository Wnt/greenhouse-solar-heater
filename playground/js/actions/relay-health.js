/**
 * Relay-health sidecar glue (Epic #254).
 *
 * The server assembles `greenhouse/state` from a slimmed device payload
 * plus cached native Shelly relay status. When a relay's cached status
 * goes stale or was never seen, the assembled valves/actuators fall back
 * to a previous/false value — which would otherwise render as a confident
 * OPEN/CLOSED/ON/OFF. To avoid lying to the operator, the server emits an
 * additive `relay_health` WS frame (and `greenhouse/relay-health` MQTT
 * topic) carrying per-relay freshness ALONGSIDE — never inside — the
 * byte-identical `greenhouse/state` frame.
 *
 * This module is the consumer: it stores the freshness map under the
 * `relayHealth` store key so the render pipeline (display-update.js) can
 * dim/flag a relay whose state is no longer trustworthy. It owns no DOM —
 * the visual treatment lives where valves/actuators are rendered.
 */

import { store } from '../app-state.js';

/**
 * Freshness lookup helper. Returns the per-relay freshness record
 * ({ status, ageMs }) for a logical valve/actuator name, or null when no
 * relay_health frame has been seen yet (e.g. sim mode, or before the
 * first frame). Render code treats null as "trust the state as today".
 */
export function relayFreshness(name) {
  const rh = store.get('relayHealth');
  if (!rh || !rh[name]) return null;
  return rh[name];
}

/**
 * True when a relay's rendered state should NOT be trusted — i.e. the
 * sidecar reports it as 'stale' or 'missing'. Unknown (no frame yet) and
 * 'fresh' both return false so fresh relays render exactly as today.
 */
export function relayIsStale(name) {
  const f = relayFreshness(name);
  return !!f && (f.status === 'stale' || f.status === 'missing');
}

/**
 * Hook into the live data source so every relay_health broadcast updates
 * the store. Re-attached on each LiveSource recreate (mirrors the
 * script-status wiring in connection.js).
 */
export function attachRelayHealthWebSocket(liveSource) {
  if (!liveSource || typeof liveSource.onRelayHealth !== 'function') return;
  liveSource.onRelayHealth((data) => {
    // data = { ts, relays: { name: { status, ageMs } } }
    store.set('relayHealth', (data && data.relays) || null);
  });
}
