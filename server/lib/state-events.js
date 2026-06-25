// State-event derivation for the MQTT bridge. Given two consecutive assembled
// greenhouse/state payloads (plus their per-relay freshness maps), write the
// mode / valve / actuator / overlay state_events rows. Extracted from
// mqtt-bridge.js to keep that file within the file-size budget; the bridge
// re-exports detectStateChanges so the public contract (and the direct test
// callers) are unchanged.

const createLogger = require('./logger');
const log = createLogger('mqtt-bridge');
const relayStatus = require('./relay-status');

// `prevFreshness` / `currFreshness` (optional) are the per-relay freshness maps
// (logical-name → { status, ... }) for the prior and current assembled ticks.
// When supplied, a valve/actuator state_events row is written ONLY when the
// relay was FRESH on BOTH sides (#3): a fallback (stale/missing) read this tick
// or last tick means the value didn't come from a live device reading, so a
// flip against it is an artefact of the relay cache converging — not a real
// transition. Suppressing those kills the cold-cache restart burst
// (missing→fresh) and the stale-window flip. A genuine fresh→fresh change is
// still logged. When the maps are absent (direct full-state callers), we keep
// the prior diff-everything behaviour. mode/overlay detection is unaffected —
// those fields are device-authored, not relay-derived.
function isFresh(map, name) {
  return !!(map && map[name] && map[name].status === relayStatus.FRESH);
}
function bothFresh(prevFreshness, currFreshness, name) {
  // No freshness context → legacy diff-everything (caller carries
  // device-authored relay state).
  if (!prevFreshness && !currFreshness) return true;
  return isFresh(prevFreshness, name) && isFresh(currFreshness, name);
}

// `d` is the resolved db handle (caller passes its module-level db when the
// trailing arg is omitted). Returns early when there is no db.
function detectStateChanges(ts, prev, curr, d, prevFreshness, currFreshness) {
  if (!d) return;
  // cause / reason / sensors carry transition context for the log view
  // ("automation fired SOLAR_CHARGING at collector=62 °C"). All
  // nullable for back-compat with older payloads.
  if (prev.mode !== curr.mode) {
    const modeOpts = {
      cause: (typeof curr.cause === 'string' && curr.cause) || null,
      reason: (typeof curr.reason === 'string' && curr.reason) || null,
      sensors: (curr.temps && typeof curr.temps === 'object') ? curr.temps : null,
    };
    d.insertStateEvent(ts, 'mode', 'mode', prev.mode, curr.mode, modeOpts, function (err) {
      if (err) log.error('db insert mode event failed', { error: err.message });
    });
  }

  // Valve changes — only when fresh on both sides (#3).
  if (prev.valves && curr.valves) {
    const valveNames = relayStatus.VALVE_KEYS;
    for (let i = 0; i < valveNames.length; i++) {
      const v = valveNames[i];
      if (prev.valves[v] !== curr.valves[v] && bothFresh(prevFreshness, currFreshness, v)) {
        const oldVal = prev.valves[v] ? 'open' : 'closed';
        const newVal = curr.valves[v] ? 'open' : 'closed';
        d.insertStateEvent(ts, 'valve', v, oldVal, newVal, function (err) {
          if (err) log.error('db insert valve event failed', { error: err.message });
        });
      }
    }
  }

  // Actuator changes — only when fresh on both sides (#3).
  if (prev.actuators && curr.actuators) {
    const actuatorNames = relayStatus.ACTUATOR_KEYS;
    for (let j = 0; j < actuatorNames.length; j++) {
      const a = actuatorNames[j];
      if (prev.actuators[a] !== curr.actuators[a] && bothFresh(prevFreshness, currFreshness, a)) {
        const oldA = prev.actuators[a] ? 'on' : 'off';
        const newA = curr.actuators[a] ? 'on' : 'off';
        d.insertStateEvent(ts, 'actuator', a, oldA, newA, function (err) {
          if (err) log.error('db insert actuator event failed', { error: err.message });
        });
      }
    }
  }

  // Overlay flag flips. Mode-driven actuator changes are already covered
  // above, but overlays (fan-cool, emergency heat) can flip the actuator
  // *within* the same mode and the operator has no way to tell from the
  // mode log why the fan came on. Persist a separate `overlay` row so
  // System Logs can render "Fan cooling started/stopped" entries.
  const prevFlags = prev.flags || {};
  const currFlags = curr.flags || {};
  if (prevFlags.greenhouse_fan_cooling_active !== undefined &&
      currFlags.greenhouse_fan_cooling_active !== undefined &&
      prevFlags.greenhouse_fan_cooling_active !== currFlags.greenhouse_fan_cooling_active) {
    const oldO = prevFlags.greenhouse_fan_cooling_active ? 'on' : 'off';
    const newO = currFlags.greenhouse_fan_cooling_active ? 'on' : 'off';
    d.insertStateEvent(ts, 'overlay', 'greenhouse_fan_cooling', oldO, newO, function (err) {
      if (err) log.error('db insert overlay event failed', { error: err.message });
    });
  }
}

module.exports = { detectStateChanges };
