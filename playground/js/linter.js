/**
 * Shelly Platform Conformance Linter
 *
 * Static analysis for Shelly Gen2+ scripting constraints.
 * Uses acorn for AST parsing.
 */

// Shelly-unsupported syntax node types and keywords
const UNSUPPORTED_SYNTAX = {
  'SH-004': {
    id: 'SH-004',
    severity: 'error',
    description: 'Unsupported ES6+ keyword',
    nodeTypes: ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration'],
    keywords: ['import', 'export', 'require'],
  },
  'SH-005': {
    id: 'SH-005',
    severity: 'error',
    description: 'Promises not supported',
    patterns: ['new Promise', '.then(', '.catch('],
    nodeCheck: (node) => {
      if (node.type === 'NewExpression' && node.callee?.name === 'Promise') return true;
      if (node.type === 'CallExpression' && node.callee?.property &&
          (node.callee.property.name === 'then' || node.callee.property.name === 'catch')) return true;
      return false;
    },
  },
  'SH-006': {
    id: 'SH-006',
    severity: 'warning',
    description: 'Arrow function with implicit return (compatibility varies)',
    nodeCheck: (node) => {
      return node.type === 'ArrowFunctionExpression' && node.body.type !== 'BlockStatement';
    },
  },
  'SH-007': {
    id: 'SH-007',
    severity: 'warning',
    description: 'Template literals not supported in older firmware',
    nodeCheck: (node) => node.type === 'TemplateLiteral',
  },
  'SH-008': {
    id: 'SH-008',
    severity: 'warning',
    description: 'Destructuring not supported',
    nodeCheck: (node) => {
      return node.type === 'ObjectPattern' || node.type === 'ArrayPattern';
    },
  },
  'SH-009': {
    id: 'SH-009',
    severity: 'warning',
    description: 'Spread/rest operator not supported',
    nodeCheck: (node) => node.type === 'SpreadElement' || node.type === 'RestElement',
  },
  'SH-013': {
    id: 'SH-013',
    severity: 'error',
    description: 'API not available on Shelly Gen2+',
    apis: ['fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'localStorage', 'sessionStorage'],
  },
};

// Resource limit rules
const RESOURCE_LIMITS = {
  'SH-001': {
    id: 'SH-001',
    severity: 'error',
    description: 'Max 5 timers per script',
    api: 'Timer.set',
    limit: 5,
  },
  'SH-002': {
    id: 'SH-002',
    severity: 'error',
    description: 'Max 5 event subscriptions per script',
    apis: ['Shelly.addStatusHandler', 'Shelly.addEventHandler'],
    limit: 5,
  },
  'SH-003': {
    id: 'SH-003',
    severity: 'warning',
    description: 'Max 5 concurrent RPC/HTTP calls',
    apis: ['Shelly.call', 'HTTP.GET', 'HTTP.POST', 'HTTP.request'],
    limit: 5,
  },
};

// Safety rules
const SAFETY_RULES = {
  'SH-010': {
    id: 'SH-010',
    severity: 'error',
    description: 'Pump must stop before valve switch in mode transitions',
  },
  'SH-011': {
    id: 'SH-011',
    severity: 'error',
    description: 'Exactly one input + one output valve open per mode',
  },
};

/**
 * Lint a script string and return findings.
 * @param {string} source - JavaScript source code
 * @param {object} options - { yamlConfig, acorn }
 * @returns {Array<{rule: string, severity: string, line: number, column: number, message: string}>}
 */
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

  // Walk AST
  walkNode(ast, (node) => {
    // Syntax rules
    for (const rule of Object.values(UNSUPPORTED_SYNTAX)) {
      // Node type checks
      if (rule.nodeTypes && rule.nodeTypes.includes(node.type)) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          line: node.loc?.start?.line || 0,
          column: node.loc?.start?.column || 0,
          message: `${rule.description}: ${node.type}`,
        });
      }

      // Custom node checks
      if (rule.nodeCheck && rule.nodeCheck(node)) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          line: node.loc?.start?.line || 0,
          column: node.loc?.start?.column || 0,
          message: rule.description,
        });
      }

      // Unsupported API calls
      if (rule.apis && node.type === 'Identifier' && rule.apis.includes(node.name)) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          line: node.loc?.start?.line || 0,
          column: node.loc?.start?.column || 0,
          message: `${rule.description}: ${node.name}`,
        });
      }
    }

    // Async/await/class keywords
    if (node.type === 'AwaitExpression' || (node.type === 'FunctionDeclaration' && node.async) ||
        (node.type === 'FunctionExpression' && node.async) ||
        (node.type === 'ArrowFunctionExpression' && node.async)) {
      findings.push({
        rule: 'SH-004',
        severity: 'error',
        line: node.loc?.start?.line || 0,
        column: node.loc?.start?.column || 0,
        message: 'Unsupported ES6+ keyword: async/await',
      });
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      findings.push({
        rule: 'SH-004',
        severity: 'error',
        line: node.loc?.start?.line || 0,
        column: node.loc?.start?.column || 0,
        message: 'Unsupported ES6+ keyword: class',
      });
    }
  });

  // Resource counting
  const apiCounts = {};
  walkNode(ast, (node) => {
    if (node.type === 'CallExpression') {
      const name = callExprName(node);
      if (name) {
        apiCounts[name] = (apiCounts[name] || 0) + 1;
      }
    }
  });

  for (const rule of Object.values(RESOURCE_LIMITS)) {
    const apis = rule.apis ? rule.apis : [rule.api];
    let total = 0;
    for (const api of apis) {
      total += apiCounts[api] || 0;
    }
    if (total > rule.limit) {
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        line: 0,
        column: 0,
        message: `${rule.description}: found ${total} calls (limit: ${rule.limit})`,
      });
    }
  }

  // Script size check (SH-012)
  const sizeKB = new Blob([source]).size / 1024;
  if (sizeKB > 16) {
    findings.push({
      rule: 'SH-012',
      severity: 'warning',
      line: 0,
      column: 0,
      message: `Script size ${sizeKB.toFixed(1)}KB exceeds 16KB deployment limit`,
    });
  }

  // Safety rules with YAML config
  if (options.yamlConfig) {
    checkSafetyRules(ast, options.yamlConfig, findings);
  }

  return findings;
}

function checkSafetyRules(ast, config, findings) {
  // SH-011: Check valve states per mode
  const modes = config.modes || {};
  for (const [modeName, mode] of Object.entries(modes)) {
    if (modeName === 'idle' || modeName === 'emergency_heating') continue;
    const vs = mode.valve_states || {};
    if (typeof vs === 'string') continue; // "same as active_drain"

    const inputOpen = ['vi_btm', 'vi_top', 'vi_coll'].filter(v => vs[v] === 'OPEN');
    const outputOpen = ['vo_coll', 'vo_rad', 'vo_tank'].filter(v => vs[v] === 'OPEN');

    if (inputOpen.length !== 1) {
      findings.push({
        rule: 'SH-011',
        severity: 'error',
        line: 0,
        column: 0,
        message: `Mode "${modeName}": expected 1 input valve open, found ${inputOpen.length} (${inputOpen.join(', ') || 'none'})`,
      });
    }
    if (outputOpen.length !== 1) {
      findings.push({
        rule: 'SH-011',
        severity: 'error',
        line: 0,
        column: 0,
        message: `Mode "${modeName}": expected 1 output valve open, found ${outputOpen.length} (${outputOpen.join(', ') || 'none'})`,
      });
    }
  }
}

/** Walk all nodes in an AST */
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

/** Extract dotted call expression name like "Timer.set" */
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

/** Format findings for display */
export function formatFindings(findings, format = 'terminal') {
  if (findings.length === 0) return 'No issues found.';

  if (format === 'json') return JSON.stringify(findings, null, 2);

  return findings.map(f => {
    const loc = f.line > 0 ? `:${f.line}:${f.column}` : '';
    const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
    return `[${f.rule}] ${prefix} ${f.message}${loc}`;
  }).join('\n');
}
