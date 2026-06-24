// Relay-status cache + greenhouse/state assembler.
//
// Background (Epic #254 / contract contracts/telemetry.md): the device now
// emits a slimmed payload on greenhouse/state/min that OMITS the physically
// observable relay state (valves, actuators). The server reassembles those
// natively from each Shelly Gen2 device's per-switch status notifications,
// which the broker delivers under `<topic-prefix>/status/switch:<id>`
// (JSON body `{ "id": <n>, "output": <bool>, ... }`). We keep an in-memory
// last-write-wins cache keyed by (device, switch id) and read it at the
// instant a greenhouse/state/min payload arrives.
//
// Why MQTT status, not HTTP Switch.GetStatus polling: "No direct HTTP RPC to
// Shelly from the server for state" is a hard CLAUDE.md rule. Native status
// notifications are push-based and always-current — no polling cadence to
// tune and no per-tick latency.

const createLogger = require('./logger');
const log = createLogger('relay-status');

// Staleness window for a cached relay reading. Comfortably longer than a
// Shelly's periodic status republish and a single ~30 s state tick, so a
// healthy device never falls through to the fallback chain. Single named
// constant per the contract so it is tunable without code archaeology.
const RELAY_STALE_MS = 120000;

// (device IP, switch id) → logical name + which assembled-payload group it
// belongs to. Derived from `VALVES` and the 4PM relay map in
// shelly/control.js. Keyed by IP because the MQTT topic prefix is a
// MAC-derived string that is not known statically; we resolve prefix → IP
// separately (see resolvePrefix / DEVICE_TOPIC_MAP) and then look up by IP.
//
// 4PM 192.168.30.50: id0=pump, id1=fan, id2=immersion_heater, id3=space_heater.
//   (Note id 2 is immersion, id 3 is space — but the wire key order is
//   pump, fan, space_heater, immersion_heater. Map by id; the fixed key
//   order is applied in assembleState().)
// Valve 2PMs .51–.54 per VALVES.
const RELAY_MAP = {
  '192.168.30.50': {
    0: { group: 'actuators', name: 'pump' },
    1: { group: 'actuators', name: 'fan' },
    2: { group: 'actuators', name: 'immersion_heater' },
    3: { group: 'actuators', name: 'space_heater' },
  },
  '192.168.30.51': {
    0: { group: 'valves', name: 'vi_btm' },
    1: { group: 'valves', name: 'vi_top' },
  },
  '192.168.30.52': {
    0: { group: 'valves', name: 'vi_coll' },
    1: { group: 'valves', name: 'vo_coll' },
  },
  '192.168.30.53': {
    0: { group: 'valves', name: 'vo_rad' },
    1: { group: 'valves', name: 'vo_tank' },
  },
  '192.168.30.54': {
    0: { group: 'valves', name: 'v_air' },
    // id 1 is a reserved spare (passive T joint, spec 024) — intentionally
    // absent so its status notifications are ignored.
  },
  // 192.168.30.55 is the spare controller — never mapped, never read.
};

// Fixed key order for the assembled payload — MUST match the device's
// historical buildSnapshotJson output exactly (byte-compatible greenhouse/state).
const VALVE_KEYS = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air'];
const ACTUATOR_KEYS = ['pump', 'fan', 'space_heater', 'immersion_heater'];

// In-memory relay cache: `${ip}|${id}` → { output: bool, lastSeen: ms }.
let cache = {};

// Topic prefix → device IP map. Shelly Gen2 publishes status under its
// configured MQTT topic prefix (default `shellyproXpm-<mac>`). The prefix is
// not derivable from config, so it is supplied via the RELAY_TOPIC_MAP env
// var (JSON: { "<prefix>": "<ip>" }). Prefixes not in the map are ignored
// (logged once). A prefix that already IS the device IP (some deployments set
// `topic_prefix` to the IP) resolves directly.
let prefixToIp = {};

function loadPrefixMap() {
  prefixToIp = {};
  const raw = process.env.RELAY_TOPIC_MAP;
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    log.error('RELAY_TOPIC_MAP is not valid JSON — relay status will rely on fallback', { error: e.message });
    return;
  }
  if (parsed && typeof parsed === 'object') {
    const keys = Object.keys(parsed);
    for (let i = 0; i < keys.length; i++) {
      prefixToIp[keys[i]] = String(parsed[keys[i]]);
    }
  }
}

// Resolve a topic prefix to a device IP. Order: explicit map → the prefix
// itself if it is a mapped device IP (topic_prefix == IP deployments).
function resolvePrefix(prefix) {
  if (Object.prototype.hasOwnProperty.call(prefixToIp, prefix)) return prefixToIp[prefix];
  if (Object.prototype.hasOwnProperty.call(RELAY_MAP, prefix)) return prefix; // prefix is the IP
  return null;
}

// Parse a native Shelly status topic. Returns { prefix, id } or null.
// Topic shape: `<prefix>/status/switch:<id>`. `<prefix>` may contain slashes
// in theory, but Shelly default prefixes do not; we anchor on the final
// `/status/switch:<id>` suffix.
function parseStatusTopic(topic) {
  const marker = '/status/switch:';
  const at = topic.lastIndexOf(marker);
  if (at < 0) return null;
  const prefix = topic.slice(0, at);
  const idStr = topic.slice(at + marker.length);
  if (!prefix || !idStr || !/^\d+$/.test(idStr)) return null;
  return { prefix, id: parseInt(idStr, 10) };
}

// Wildcard subscription that captures every device's per-switch status.
// MQTT `+` matches exactly ONE full topic level, so it cannot match the
// partial `switch:<id>` segment — `+/status/switch:+` is an invalid filter.
// We subscribe to `+/status/+` (device prefix + the whole third level, which
// is `switch:0` / `input:0` / etc.) and filter to switch-status topics in
// parseStatusTopic / ingestStatus.
const STATUS_WILDCARD = '+/status/+';

let warnedPrefixes = {};

// Ingest one native status message. `body` is the parsed JSON object
// (`{ id, output, ... }`). `now` is injectable for tests.
function ingestStatus(topic, body, now) {
  const parsed = parseStatusTopic(topic);
  if (!parsed) return false;
  const ip = resolvePrefix(parsed.prefix);
  if (!ip) {
    if (!warnedPrefixes[parsed.prefix]) {
      warnedPrefixes[parsed.prefix] = true;
      log.warn('unmapped relay topic prefix (set RELAY_TOPIC_MAP)', { prefix: parsed.prefix });
    }
    return false;
  }
  const deviceMap = RELAY_MAP[ip];
  if (!deviceMap || !deviceMap[parsed.id]) return false; // unknown/reserved switch
  if (!body || typeof body.output === 'undefined') return false;
  const key = ip + '|' + parsed.id;
  cache[key] = { output: !!body.output, lastSeen: typeof now === 'number' ? now : Date.now() };
  return true;
}

// Rate-limited fallback warning — one line per (group,name) per window so a
// silently-offline valve controller is observable without flooding the log.
let lastFallbackWarn = {};
const FALLBACK_WARN_MS = 60000;

function warnFallback(group, name, now) {
  const k = group + '.' + name;
  const t = typeof now === 'number' ? now : Date.now();
  if (lastFallbackWarn[k] && (t - lastFallbackWarn[k]) < FALLBACK_WARN_MS) return;
  lastFallbackWarn[k] = t;
  log.warn('relay status served from fallback (stale/missing)', { relay: k });
}

// Read one relay's boolean state with the staleness fallback chain:
//   1. fresh cache (lastSeen within RELAY_STALE_MS) → cached output
//   2. last assembled previousState value for that valve/actuator
//   3. false (closed/off — IDLE-safe, matches device boot baseline)
function readRelay(ip, id, group, name, previousState, now) {
  const key = ip + '|' + id;
  const entry = cache[key];
  const t = typeof now === 'number' ? now : Date.now();
  if (entry && (t - entry.lastSeen) <= RELAY_STALE_MS) {
    return entry.output;
  }
  // Fallback path — log (rate-limited) so an offline controller is visible.
  warnFallback(group, name, t);
  if (previousState && previousState[group] && typeof previousState[group][name] !== 'undefined') {
    return !!previousState[group][name];
  }
  return false;
}

// Build the `valves` + `actuators` objects from the relay cache, applying the
// fallback chain per relay. Returns { valves, actuators } with the exact key
// order required for byte-compatibility.
function buildRelayGroups(previousState, now) {
  // Invert RELAY_MAP into name → {ip,id} for the lookups below.
  const valves = {};
  const actuators = {};
  const ips = Object.keys(RELAY_MAP);
  // name → {ip, id}
  const byName = {};
  for (let i = 0; i < ips.length; i++) {
    const ip = ips[i];
    const dm = RELAY_MAP[ip];
    const idKeys = Object.keys(dm);
    for (let j = 0; j < idKeys.length; j++) {
      const id = parseInt(idKeys[j], 10);
      const m = dm[idKeys[j]];
      byName[m.name] = { ip, id, group: m.group };
    }
  }
  for (let v = 0; v < VALVE_KEYS.length; v++) {
    const vn = VALVE_KEYS[v];
    const loc = byName[vn];
    valves[vn] = readRelay(loc.ip, loc.id, 'valves', vn, previousState, now);
  }
  for (let a = 0; a < ACTUATOR_KEYS.length; a++) {
    const an = ACTUATOR_KEYS[a];
    const loc = byName[an];
    actuators[an] = readRelay(loc.ip, loc.id, 'actuators', an, previousState, now);
  }
  return { valves, actuators };
}

// Assemble the full, byte-compatible greenhouse/state payload from:
//   - the device-minimal payload `min` (greenhouse/state/min),
//   - native relay status (this cache, with fallback),
//   - device config (controls_enabled; manual_override is applied later by
//     enrichState at broadcast time, so we set it from cfg here too to keep
//     the re-published retained payload complete).
//
// Field order matches the historical buildSnapshotJson output exactly.
// `opts`: { previousState, controlsEnabled, manualOverride, now }.
function assembleState(min, opts) {
  opts = opts || {};
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const groups = buildRelayGroups(opts.previousState || null, now);

  const temps = (min && min.temps) || {};
  const flags = (min && min.flags) || {};

  // Built in the historical key order. We construct the object with explicit
  // property assignments in order; downstream JSON.stringify preserves
  // insertion order, matching the device's hand-serialized output.
  const out = {};
  out.ts = (min && typeof min.ts !== 'undefined') ? min.ts : Date.now();
  out.mode = (min && min.mode) || 'idle';
  out.transitioning = !!(min && min.transitioning);
  out.transition_step = (min && typeof min.transition_step !== 'undefined') ? min.transition_step : null;
  out.temps = {
    collector: typeof temps.collector === 'undefined' ? null : temps.collector,
    tank_top: typeof temps.tank_top === 'undefined' ? null : temps.tank_top,
    tank_bottom: typeof temps.tank_bottom === 'undefined' ? null : temps.tank_bottom,
    greenhouse: typeof temps.greenhouse === 'undefined' ? null : temps.greenhouse,
    outdoor: typeof temps.outdoor === 'undefined' ? null : temps.outdoor,
  };
  out.valves = groups.valves;
  out.actuators = groups.actuators;
  out.flags = {
    collectors_drained: !!flags.collectors_drained,
    emergency_heating_active: !!flags.emergency_heating_active,
    greenhouse_fan_cooling_active: !!flags.greenhouse_fan_cooling_active,
  };
  out.controls_enabled = !!opts.controlsEnabled;
  out.manual_override = typeof opts.manualOverride === 'undefined' ? null : opts.manualOverride;
  out.opening = (min && Array.isArray(min.opening)) ? min.opening : [];
  out.queued_opens = (min && Array.isArray(min.queued_opens)) ? min.queued_opens : [];
  out.pending_closes = (min && Array.isArray(min.pending_closes)) ? min.pending_closes : [];
  out.cause = (min && typeof min.cause !== 'undefined') ? min.cause : 'boot';
  out.reason = (min && typeof min.reason !== 'undefined') ? min.reason : null;
  out.eval_reason = (min && typeof min.eval_reason !== 'undefined') ? min.eval_reason : null;
  out.held = (min && typeof min.held !== 'undefined') ? min.held : null;
  return out;
}

function reset() {
  cache = {};
  warnedPrefixes = {};
  lastFallbackWarn = {};
  loadPrefixMap();
}

// Initialise on load (reads RELAY_TOPIC_MAP).
loadPrefixMap();

module.exports = {
  RELAY_STALE_MS,
  STATUS_WILDCARD,
  loadPrefixMap,
  parseStatusTopic,
  resolvePrefix,
  ingestStatus,
  assembleState,
  buildRelayGroups,
  reset,
  // Test-only injectors.
  _setCacheEntry: function (ip, id, output, lastSeen) {
    cache[ip + '|' + id] = { output: !!output, lastSeen };
  },
  _getCache: function () { return cache; },
};
