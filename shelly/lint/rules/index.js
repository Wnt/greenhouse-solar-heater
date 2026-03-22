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

const RESOURCE_LIMITS = [
  { id: 'SH-001', severity: 'warning', desc: 'Max 5 timers per script (static count — actual concurrency may be lower)', apis: ['Timer.set'], limit: 5 },
  { id: 'SH-002', severity: 'error', desc: 'Max 5 event subscriptions per script', apis: ['Shelly.addStatusHandler', 'Shelly.addEventHandler'], limit: 5 },
  { id: 'SH-003', severity: 'warning', desc: 'Max 5 concurrent RPC/HTTP calls', apis: ['Shelly.call', 'HTTP.GET', 'HTTP.POST', 'HTTP.request'], limit: 5 },
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

    // Count API calls for resource limits
    if (node.type === 'CallExpression') {
      const name = callExprName(node);
      if (name) apiCounts[name] = (apiCounts[name] || 0) + 1;
    }
  });

  // Resource limit checks
  for (const rule of RESOURCE_LIMITS) {
    let total = 0;
    for (const api of rule.apis) total += apiCounts[api] || 0;
    if (total > rule.limit) {
      findings.push({ rule: rule.id, severity: rule.severity, line: 0, column: 0, message: `${rule.desc}: found ${total} calls (limit: ${rule.limit})` });
    }
  }

  // SH-012: Script size
  const sizeKB = Buffer.byteLength(source, 'utf-8') / 1024;
  if (sizeKB > 16) {
    findings.push({ rule: 'SH-012', severity: 'warning', line: 0, column: 0, message: `Script size ${sizeKB.toFixed(1)}KB exceeds 16KB deployment limit` });
  }

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
