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

// 4PM actuator wiring (192.168.30.50). This is the ONE place encoding the
// id↔key inversion: relay id 2 is the immersion heater and id 3 is the space
// heater, but the historical greenhouse/state wire key order lists
// space_heater BEFORE immersion_heater. We map by id here; the fixed wire key
// order is `ACTUATOR_KEYS` below. Keep both in this module so no other code
// re-derives or re-orders the inversion.
const ACTUATOR_4PM_IP = '192.168.30.50';
const ACTUATOR_4PM_BY_ID = {
  0: 'pump',
  1: 'fan',
  2: 'immersion_heater', // id 2 → immersion (NOT space)
  3: 'space_heater',     // id 3 → space     (NOT immersion)
};

// (device IP, switch id) → logical name + which assembled-payload group it
// belongs to.
//
// AUTHORITY: the per-(IP, switch-id) valve wiring is defined by `VALVES` in
// shelly/control.js (a device script with no module.exports, so it cannot be
// imported here at runtime). system.yaml does NOT carry the per-switch wiring,
// so control.js `VALVES` is the single source of truth. This `RELAY_MAP` is a
// derived copy; a drift test parses `VALVES` out of control.js with Acorn
// (the same approach shelly/lint uses) and asserts this map matches it. The 4PM
// actuator inversion is verified against `ACTUATOR_4PM_BY_ID` above.
//
// Keyed by IP because the MQTT topic prefix is a MAC-derived string not known
// statically; we resolve prefix → IP separately (see resolvePrefix /
// prefixToIp) and then look up by IP.
const RELAY_MAP = {
  '192.168.30.50': {
    0: { group: 'actuators', name: ACTUATOR_4PM_BY_ID[0] },
    1: { group: 'actuators', name: ACTUATOR_4PM_BY_ID[1] },
    2: { group: 'actuators', name: ACTUATOR_4PM_BY_ID[2] },
    3: { group: 'actuators', name: ACTUATOR_4PM_BY_ID[3] },
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

// Fixed key order for the assembled valves/actuators objects — MUST match the
// device's historical greenhouse/state shape exactly (byte-compatible).
const VALVE_KEYS = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air'];
const ACTUATOR_KEYS = ['pump', 'fan', 'space_heater', 'immersion_heater'];

// Top-level key order of the assembled greenhouse/state payload — MUST match
// the historical full greenhouse/state shape exactly. assembleState() builds
// the object in this order; this exported constant lets the goldens/drift tests
// assert key order against one source instead of a hand-copied list.
const KEY_ORDER = [
  'ts', 'mode', 'transitioning', 'transition_step', 'temps', 'valves', 'actuators',
  'flags', 'controls_enabled', 'manual_override', 'opening', 'queued_opens',
  'pending_closes', 'cause', 'reason', 'eval_reason', 'held',
];

// In-memory relay cache: `${ip}|${id}` → { output: bool, lastSeen: ms }.
let cache = {};

// Relay freshness classes, surfaced as an additive sidecar (greenhouse/state
// stays byte-identical). 'fresh' = cached reading inside RELAY_STALE_MS;
// 'stale' = cached but older than RELAY_STALE_MS (served from fallback);
// 'missing' = no cache entry ever seen (served from fallback). #3 suppression
// keys off this: only fresh→fresh diffs become state_events rows.
const FRESH = 'fresh';
const STALE = 'stale';
const MISSING = 'missing';

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

// Read one relay's boolean state with the staleness fallback chain, and
// classify its freshness:
//   1. fresh cache (lastSeen within RELAY_STALE_MS) → cached output, FRESH
//   2. cached but stale → last previousState value (or false), STALE
//   3. never seen → last previousState value (or false), MISSING
// Returns { value, status, ageMs }. ageMs is null when never seen.
function readRelay(ip, id, group, name, previousState, now) {
  const key = ip + '|' + id;
  const entry = cache[key];
  const t = typeof now === 'number' ? now : Date.now();
  if (entry) {
    const age = t - entry.lastSeen;
    if (age <= RELAY_STALE_MS) {
      return { value: entry.output, status: FRESH, ageMs: age };
    }
    // Stale cache — fall through to previousState/false but record the age.
    warnFallback(group, name, t);
    return { value: fallbackValue(group, name, previousState), status: STALE, ageMs: age };
  }
  // Never seen.
  warnFallback(group, name, t);
  return { value: fallbackValue(group, name, previousState), status: MISSING, ageMs: null };
}

function fallbackValue(group, name, previousState) {
  if (previousState && previousState[group] && typeof previousState[group][name] !== 'undefined') {
    return !!previousState[group][name];
  }
  return false;
}

// Build the `valves` + `actuators` objects from the relay cache, applying the
// fallback chain per relay. Returns { valves, actuators, freshness } where
// `freshness` is logical-name → { status: 'fresh'|'stale'|'missing', ageMs }
// for every valve and actuator. valves/actuators carry the exact key order
// required for byte-compatibility; `freshness` is sidecar-only (never folded
// into greenhouse/state).
function buildRelayGroups(previousState, now) {
  const valves = {};
  const actuators = {};
  const freshness = {};
  // Invert RELAY_MAP into name → {ip,id} for the lookups below.
  const ips = Object.keys(RELAY_MAP);
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
    const r = readRelay(loc.ip, loc.id, 'valves', vn, previousState, now);
    valves[vn] = r.value;
    freshness[vn] = { status: r.status, ageMs: r.ageMs };
  }
  for (let a = 0; a < ACTUATOR_KEYS.length; a++) {
    const an = ACTUATOR_KEYS[a];
    const loc = byName[an];
    const r = readRelay(loc.ip, loc.id, 'actuators', an, previousState, now);
    actuators[an] = r.value;
    freshness[an] = { status: r.status, ageMs: r.ageMs };
  }
  return { valves, actuators, freshness };
}

// Assemble the full, byte-compatible greenhouse/state payload from:
//   - the device-minimal payload `min` (greenhouse/state/min, built by
//     buildMinPayload in shelly/control-logic.js),
//   - native relay status (this cache, with fallback),
//   - device config (controls_enabled; manual_override is applied later by
//     enrichState at broadcast time, so we set it from cfg here too to keep
//     the re-published retained payload complete).
//
// Field order matches the historical full greenhouse/state shape exactly
// (see KEY_ORDER). `opts`: { previousState, controlsEnabled, manualOverride, now }.
//
// Returns { payload, freshness } — `payload` is the byte-compatible
// greenhouse/state object; `freshness` is the per-relay sidecar map
// (logical-name → { status, ageMs }) used for the relay-health sidecar and #3
// event-suppression. `freshness` is NEVER folded into `payload`.
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
  return { payload: out, freshness: groups.freshness };
}

// Assert that RELAY_TOPIC_MAP (or topic_prefix==IP fallback) can resolve EVERY
// device IP referenced by RELAY_MAP. Without full coverage, an unmapped
// device's status notifications are silently dropped and every one of its
// relays falls back to false — a dead/unmapped controller renders as a
// confident "closed/off". We fail loud at startup instead.
//
// Returns { ok, missing: [ip,...] }. `missing` lists every RELAY_MAP IP that is
// neither a value in prefixToIp nor a self-resolving prefix (topic_prefix==IP).
function checkTopicMapCoverage() {
  const resolvableIps = {};
  // IPs reachable via an explicit prefix→IP mapping.
  const prefixes = Object.keys(prefixToIp);
  for (let i = 0; i < prefixes.length; i++) {
    resolvableIps[prefixToIp[prefixes[i]]] = true;
  }
  // IPs reachable via topic_prefix==IP (the prefix IS the device IP).
  const mapIps = Object.keys(RELAY_MAP);
  for (let j = 0; j < mapIps.length; j++) {
    if (Object.prototype.hasOwnProperty.call(prefixToIp, mapIps[j])) {
      resolvableIps[mapIps[j]] = true;
    }
  }
  const missing = [];
  for (let k = 0; k < mapIps.length; k++) {
    if (!resolvableIps[mapIps[k]]) missing.push(mapIps[k]);
  }
  return { ok: missing.length === 0, missing };
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
  // Canonical wiring constants — single source of truth other code asserts
  // against (drift test verifies RELAY_MAP against control.js VALVES).
  RELAY_MAP,
  VALVE_KEYS,
  ACTUATOR_KEYS,
  KEY_ORDER,
  ACTUATOR_4PM_IP,
  ACTUATOR_4PM_BY_ID,
  // Freshness class constants (sidecar values).
  FRESH,
  STALE,
  MISSING,
  loadPrefixMap,
  parseStatusTopic,
  resolvePrefix,
  ingestStatus,
  assembleState,
  buildRelayGroups,
  checkTopicMapCoverage,
  reset,
  // Test-only injectors.
  _setCacheEntry: function (ip, id, output, lastSeen) {
    cache[ip + '|' + id] = { output: !!output, lastSeen };
  },
  _getCache: function () { return cache; },
};
