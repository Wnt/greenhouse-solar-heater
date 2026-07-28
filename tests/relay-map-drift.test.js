const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

// DRIFT GUARD: server/lib/relay-status.js carries a hand-maintained RELAY_MAP
// (and the 4PM actuator id↔key inversion) that MUST match the device's actual
// wiring. The device wiring lives in shelly/control.js as the `VALVES` object
// literal (per-(IP, switch-id) valve assignment) and the `setActuators` `plan`
// array (per-id actuator assignment). control.js is a device script with no
// module.exports, so it cannot be imported — we parse it with Acorn (the same
// parser shelly/lint uses, see shelly/lint/rules/index.js `acorn.parse`) and
// extract those two literals from the AST.
//
// If anyone re-wires a valve or swaps the immersion/space heater ids in
// control.js without updating relay-status.js, this test fails — the assembler
// would otherwise silently mislabel a relay (e.g. report the space heater's
// state under `immersion_heater`).

const CONTROL_JS = path.join(__dirname, '..', 'shelly', 'control.js');

// ── Minimal AST walker (mirrors shelly/lint/rules/index.js walkNode). ──
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) child.forEach((c) => walk(c, visit));
    else if (child && typeof child === 'object' && child.type) walk(child, visit);
  }
}

function parseControlJs() {
  const src = fs.readFileSync(CONTROL_JS, 'utf8');
  return acorn.parse(src, { ecmaVersion: 2020 });
}

// Pull the static value of a property whose value is a literal or a simple
// negative-number unary. Returns undefined for anything non-static.
function literalValue(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument.type === 'Literal') {
    return -node.argument.value;
  }
  return undefined;
}

function propKeyName(prop) {
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  return null;
}

// Find `var VALVES = { ... }` and return { name: { ip, id } }, where `ip`
// is the WiFi address — VALVES entries carry a dual-path host array
// `h: [ethIp, wifiIp]` (wired control path, system.yaml networking), and
// the server's RELAY_MAP identity stays the WiFi IP because that is what
// each device publishes as its MQTT topic_prefix.
function extractValves(ast) {
  let valvesNode = null;
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === 'VALVES'
        && n.init && n.init.type === 'ObjectExpression') {
      valvesNode = n.init;
    }
  });
  assert.ok(valvesNode, 'could not find `var VALVES = {…}` in control.js');
  const out = {};
  valvesNode.properties.forEach((prop) => {
    const name = propKeyName(prop);
    assert.ok(name, 'unexpected VALVES key shape');
    assert.strictEqual(prop.value.type, 'ObjectExpression', 'VALVES entry must be an object literal');
    const entry = {};
    prop.value.properties.forEach((p) => {
      const k = propKeyName(p);
      if (p.value.type === 'ArrayExpression') {
        entry[k] = p.value.elements.map(literalValue);
      } else {
        entry[k] = literalValue(p.value);
      }
    });
    assert.ok(Array.isArray(entry.h) && entry.h.length === 2,
      'VALVES.' + name + '.h must be a [ethIp, wifiIp] literal array');
    const ethIp = entry.h[0];
    const wifiIp = entry.h[1];
    assert.strictEqual(typeof ethIp, 'string', 'VALVES.' + name + '.h[0] (eth) must be a string literal');
    assert.strictEqual(typeof wifiIp, 'string', 'VALVES.' + name + '.h[1] (wifi) must be a string literal');
    // The two paths must address the SAME physical device: last octet match.
    assert.strictEqual(ethIp.split('.')[3], wifiIp.split('.')[3],
      'VALVES.' + name + ': eth and wifi addresses must share the device octet');
    assert.match(ethIp, /^192\.168\.31\./, 'VALVES.' + name + ': eth address must be on the wired island subnet');
    assert.strictEqual(typeof entry.id, 'number', 'VALVES.' + name + '.id must be a number literal');
    out[name] = { ip: wifiIp, id: entry.id };
  });
  return out;
}

// Find `function setActuators(states, cb)` and parse its `var plan = [ … ]`
// array of `{ key, id, … }` objects → { id: key }.
function extractActuatorPlan(ast) {
  let fnNode = null;
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id && n.id.name === 'setActuators') fnNode = n;
  });
  assert.ok(fnNode, 'could not find function setActuators in control.js');
  let planArray = null;
  walk(fnNode, (n) => {
    if (!planArray && n.type === 'VariableDeclarator' && n.id.type === 'Identifier'
        && n.id.name === 'plan' && n.init && n.init.type === 'ArrayExpression') {
      planArray = n.init;
    }
  });
  assert.ok(planArray, 'could not find `var plan = [...]` inside setActuators');
  const byId = {};
  planArray.elements.forEach((el) => {
    assert.strictEqual(el.type, 'ObjectExpression', 'each plan entry must be an object literal');
    const entry = {};
    el.properties.forEach((p) => {
      const k = propKeyName(p);
      const v = literalValue(p.value);
      if (typeof v !== 'undefined') entry[k] = v;
    });
    assert.strictEqual(typeof entry.id, 'number', 'plan entry id must be a number literal');
    assert.strictEqual(typeof entry.key, 'string', 'plan entry key must be a string literal');
    byId[entry.id] = entry.key;
  });
  return byId;
}

describe('relay-status.js RELAY_MAP must not drift from shelly/control.js wiring', () => {
  const relay = require('../server/lib/relay-status.js');
  const ast = parseControlJs();

  it('valve (IP, switch-id) → name matches control.js VALVES exactly', () => {
    const valves = extractValves(ast);

    // Build the device-authoritative (IP, id) → name map from VALVES.
    const deviceByIpId = {};
    Object.keys(valves).forEach((name) => {
      const { ip, id } = valves[name];
      deviceByIpId[ip + '|' + id] = name;
    });

    // Build the same map out of RELAY_MAP's `valves`-group entries.
    const mapByIpId = {};
    Object.keys(relay.RELAY_MAP).forEach((ip) => {
      const dm = relay.RELAY_MAP[ip];
      Object.keys(dm).forEach((idStr) => {
        if (dm[idStr].group === 'valves') {
          mapByIpId[ip + '|' + idStr] = dm[idStr].name;
        }
      });
    });

    assert.deepStrictEqual(mapByIpId, deviceByIpId,
      'RELAY_MAP valve entries must match control.js VALVES by (IP, switch-id)');

    // And every device valve name is one of the canonical VALVE_KEYS.
    Object.keys(valves).forEach((name) => {
      assert.ok(relay.VALVE_KEYS.indexOf(name) !== -1,
        'VALVES name "' + name + '" missing from relay-status VALVE_KEYS');
    });
    assert.strictEqual(Object.keys(valves).length, relay.VALVE_KEYS.length,
      'VALVE_KEYS count must equal the number of wired valves in control.js');
  });

  it('4PM actuator id → key matches control.js setActuators plan (id2=immersion, id3=space)', () => {
    const planById = extractActuatorPlan(ast);

    // The module's single source of the inversion.
    assert.deepStrictEqual(relay.ACTUATOR_4PM_BY_ID, planById,
      'ACTUATOR_4PM_BY_ID must match the setActuators plan id→key mapping');

    // Guard the exact inversion the comment warns about, so a silent swap of
    // the two heater ids fails loudly here.
    assert.strictEqual(planById[2], 'immersion_heater', 'control.js: switch id 2 must be the immersion heater');
    assert.strictEqual(planById[3], 'space_heater', 'control.js: switch id 3 must be the space heater');

    // And RELAY_MAP's 4PM-IP actuator entries are exactly that map.
    const mapById = {};
    const dm = relay.RELAY_MAP[relay.ACTUATOR_4PM_IP];
    Object.keys(dm).forEach((idStr) => {
      if (dm[idStr].group === 'actuators') mapById[Number(idStr)] = dm[idStr].name;
    });
    assert.deepStrictEqual(mapById, planById,
      'RELAY_MAP 4PM actuator entries must match the setActuators plan id→key mapping');

    // Every actuator key is one of the canonical ACTUATOR_KEYS (different
    // ORDER is intentional — space before immersion on the wire).
    Object.keys(planById).forEach((id) => {
      assert.ok(relay.ACTUATOR_KEYS.indexOf(planById[id]) !== -1,
        'actuator key "' + planById[id] + '" missing from relay-status ACTUATOR_KEYS');
    });
    assert.strictEqual(Object.keys(planById).length, relay.ACTUATOR_KEYS.length,
      'ACTUATOR_KEYS count must equal the number of actuators in setActuators');
  });
});
