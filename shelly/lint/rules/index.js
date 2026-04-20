/**
 * Linter rules — shared between CLI and web UI.
 * Re-exports the core linting logic.
 */

// ── AST Walker ──

function walkNode(node, visitor) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visitor(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkNode(item, visitor);
    } else if (child && typeof child === 'object' && child.type) {
      walkNode(child, visitor);
    }
  }
}

function walkNodeWithParents(node, visitor, parents) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visitor(node, parents);
  const nextParents = node.type ? parents.concat([node]) : parents;
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) walkNodeWithParents(item, visitor, nextParents);
    } else if (child && typeof child === 'object' && child.type) {
      walkNodeWithParents(child, visitor, nextParents);
    }
  }
}

const LOOP_TYPES = new Set(['ForStatement', 'WhileStatement', 'DoWhileStatement', 'ForInStatement', 'ForOfStatement']);

function callExprName(node) {
  const callee = node.callee;
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    const obj = callee.object;
    const prop = callee.property;
    if (obj?.type === 'Identifier' && prop) {
      return obj.name + '.' + (prop.name || prop.value);
    }
  }
  return null;
}

// ── Rules ──

const UNSUPPORTED_APIS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'localStorage', 'sessionStorage'];

// Only SH-002 remains as a static-count check: `Shelly.addEventHandler`
// registrations add to the 5-slot budget permanently (unlike timers and
// Shelly.call which are ephemeral), so counting call sites is a faithful
// approximation. Runtime concurrency for Timer.set and Shelly.call is
// authoritatively checked by tests/shelly-platform-limits.test.js.
const RESOURCE_LIMITS = [
  { id: 'SH-002', severity: 'error', desc: 'Max 5 event subscriptions per script', apis: ['Shelly.addStatusHandler', 'Shelly.addEventHandler'], limit: 5 },
];

// ── Main lint function ──

export function lintScript(source, options = {}) {
  const { acorn } = options;
  if (!acorn) throw new Error('acorn parser required');

  const findings = [];
  let ast;

  try {
    ast = acorn.parse(source, {
      ecmaVersion: 2020,
      sourceType: 'script',
      locations: true,
      allowReturnOutsideFunction: true,
    });
  } catch (e) {
    findings.push({
      rule: 'PARSE',
      severity: 'error',
      line: e.loc?.line || 1,
      column: e.loc?.column || 0,
      message: `Parse error: ${e.message}`,
    });
    return findings;
  }

  const apiCounts = {};

  walkNode(ast, (node) => {
    // SH-004: async, await, class, import, export
    if (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
      findings.push({ rule: 'SH-004', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: `Unsupported ES6+ syntax: ${node.type}` });
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      findings.push({ rule: 'SH-004', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: 'Unsupported ES6+ keyword: class' });
    }
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') && node.async) {
      findings.push({ rule: 'SH-004', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: 'Unsupported ES6+ keyword: async' });
    }
    if (node.type === 'AwaitExpression') {
      findings.push({ rule: 'SH-004', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: 'Unsupported ES6+ keyword: await' });
    }

    // SH-005: Promises
    if (node.type === 'NewExpression' && node.callee?.name === 'Promise') {
      findings.push({ rule: 'SH-005', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: 'Promise constructor not supported' });
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' &&
        (node.callee.property?.name === 'then' || node.callee.property?.name === 'catch')) {
      findings.push({ rule: 'SH-005', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: `Promise .${node.callee.property.name}() not supported` });
    }

    // SH-006: Arrow with implicit return
    if (node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement') {
      findings.push({ rule: 'SH-006', severity: 'warning', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: 'Arrow function with implicit return (compatibility varies)' });
    }

    // SH-007: Template literals
    if (node.type === 'TemplateLiteral') {
      findings.push({ rule: 'SH-007', severity: 'warning', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: 'Template literals not supported in older firmware' });
    }

    // SH-008: Destructuring
    if (node.type === 'ObjectPattern' || node.type === 'ArrayPattern') {
      findings.push({ rule: 'SH-008', severity: 'warning', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: 'Destructuring not supported' });
    }

    // SH-009: Spread/rest
    if (node.type === 'SpreadElement' || node.type === 'RestElement') {
      findings.push({ rule: 'SH-009', severity: 'warning', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: 'Spread/rest operator not supported' });
    }

    // SH-013: Unavailable APIs
    if (node.type === 'Identifier' && UNSUPPORTED_APIS.includes(node.name)) {
      // Avoid flagging declarations
      findings.push({ rule: 'SH-013', severity: 'error', line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0, message: `API not available on Shelly Gen2+: ${node.name}` });
    }

    // SH-014: Array methods missing from Shelly's Espruino runtime.
    // Verified on device:
    //   2026-04-09: control script crashed with 'Function "shift" not
    //               found!' after using arr.shift().
    //   2026-04-10: control script crashed with 'Function "sort" not
    //               found!' after buildSnapshotFromState called
    //               opening.sort() to alphabetize the staged-open list.
    //               Post-023-limit-valve-operations deploy.
    // If you discover another missing method, add it here and document
    // the device incident so future maintainers know this is empirical,
    // not speculative.
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression') {
      const propName = node.callee.property?.name;
      if (propName === 'shift' || propName === 'unshift' || propName === 'splice' ||
          propName === 'sort' || propName === 'flat' || propName === 'flatMap' ||
          propName === 'findLast' || propName === 'findLastIndex') {
        findings.push({
          rule: 'SH-014',
          severity: 'error',
          line: node.loc?.start?.line || 0,
          column: node.loc?.start?.column || 0,
          message: `Array.${propName}() not supported by Shelly's Espruino runtime — iterate a pre-sorted constant or use manual insertion instead`
        });
      }
    }

    // Count API calls for resource limits
    if (node.type === 'CallExpression') {
      const name = callExprName(node);
      if (name) apiCounts[name] = (apiCounts[name] || 0) + 1;
    }
  });

  // Callback-leak rules: Timer.set / MQTT.subscribe / Shelly.call inside a
  // loop. Class of bug behind the 2026-04-09 timer-overflow and 2026-04-20
  // subscribe-orphan incidents. Recursion via callback chaining (setActuators,
  // setValves) is allowed — only syntactic loops trip these rules.
  walkNodeWithParents(ast, (node, parents) => {
    if (node.type !== 'CallExpression') return;
    const name = callExprName(node);
    if (!name) return;
    const inLoop = parents.some(p => LOOP_TYPES.has(p.type));
    if (!inLoop) return;
    if (name === 'Timer.set') {
      findings.push({ rule: 'SH-LEAK-TIMER', severity: 'error',
        line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0,
        message: 'Timer.set inside a loop — a forgotten Timer.clear here crashes the script with a 5-handle overflow' });
    } else if (name === 'MQTT.subscribe') {
      findings.push({ rule: 'SH-LEAK-SUB', severity: 'error',
        line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0,
        message: 'MQTT.subscribe inside a loop — duplicate topic throws "Invalid topic" on the second iteration' });
    } else if (name === 'Shelly.call') {
      findings.push({ rule: 'SH-LEAK-RPC', severity: 'error',
        line: node.loc?.start?.line || 0, column: node.loc?.start?.column || 0,
        message: 'Shelly.call inside a loop — concurrent calls can exceed the 5-RPC budget' });
    }
  }, []);

  // Resource limit checks
  for (const rule of RESOURCE_LIMITS) {
    let total = 0;
    for (const api of rule.apis) total += apiCounts[api] || 0;
    if (total > rule.limit) {
      findings.push({ rule: rule.id, severity: rule.severity, line: 0, column: 0, message: `${rule.desc}: found ${total} calls (limit: ${rule.limit})` });
    }
  }

  // Script size is checked post-minify by tests/deploy.test.js against
  // the real 65 535-byte Shelly Script.PutCode limit. The old SH-012
  // rule flagged pre-minify source > 16 KB which produced false positives
  // on code that minified to well under the device limit.

  // Safety rules with YAML config
  if (options.yamlConfig) {
    checkSafetyRules(ast, options.yamlConfig, findings);
  }

  return findings;
}

function checkSafetyRules(ast, config, findings) {
  const modes = config.modes || {};
  for (const [modeName, mode] of Object.entries(modes)) {
    if (modeName === 'idle' || modeName === 'emergency_heating') continue;
    // Skip sequence-based modes that don't define explicit valve_states
    if (!mode.valve_states || typeof mode.valve_states === 'string') continue;
    const vs = mode.valve_states;

    const inputOpen = ['vi_btm', 'vi_top', 'vi_coll'].filter(v => vs[v] === 'OPEN');
    const outputOpen = ['vo_coll', 'vo_rad', 'vo_tank'].filter(v => vs[v] === 'OPEN');

    if (inputOpen.length !== 1) {
      findings.push({ rule: 'SH-011', severity: 'error', line: 0, column: 0, message: `Mode "${modeName}": expected 1 input valve open, found ${inputOpen.length} (${inputOpen.join(', ') || 'none'})` });
    }
    if (outputOpen.length !== 1) {
      findings.push({ rule: 'SH-011', severity: 'error', line: 0, column: 0, message: `Mode "${modeName}": expected 1 output valve open, found ${outputOpen.length} (${outputOpen.join(', ') || 'none'})` });
    }
  }
}

export function formatFindings(findings, format = 'terminal') {
  if (findings.length === 0) return 'No issues found.';
  if (format === 'json') return JSON.stringify(findings, null, 2);
  return findings.map(f => {
    const loc = f.line > 0 ? `:${f.line}:${f.column}` : '';
    const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
    return `[${f.rule}] ${prefix} ${f.message}${loc}`;
  }).join('\n');
}
