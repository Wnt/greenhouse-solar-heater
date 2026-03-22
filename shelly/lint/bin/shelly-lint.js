#!/usr/bin/env node

/**
 * Shelly Platform Conformance Linter — CLI
 *
 * Usage:
 *   shelly-lint <script.js> [--config system.yaml] [--format terminal|json|github]
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as acorn from 'acorn';
import { load as loadYaml } from 'js-yaml';
import { lintScript, formatFindings } from '../rules/index.js';

const args = process.argv.slice(2);

if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: shelly-lint <script.js> [options]

Options:
  --config <path>    Path to system.yaml for safety rule validation
  --format <fmt>     Output format: terminal (default), json, github
  --help, -h         Show this help

Examples:
  shelly-lint scripts/control.js
  shelly-lint scripts/control-logic.js --config system.yaml
  shelly-lint scripts/*.js --format github`);
  process.exit(0);
}

// Parse args
let files = [];
let configPath = null;
let format = 'terminal';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) {
    configPath = args[++i];
  } else if (args[i] === '--format' && args[i + 1]) {
    format = args[++i];
  } else if (!args[i].startsWith('-')) {
    files.push(args[i]);
  }
}

if (files.length === 0) {
  console.error('Error: No script files specified.');
  process.exit(1);
}

// Load YAML config if provided
let yamlConfig = null;
if (configPath) {
  try {
    const yamlText = readFileSync(resolve(configPath), 'utf-8');
    const raw = loadYaml(yamlText);
    yamlConfig = { modes: raw.modes, valves: raw.valves, safety: raw.safety };
  } catch (e) {
    console.error(`Warning: Could not load config ${configPath}: ${e.message}`);
  }
}

// Lint each file
let totalErrors = 0;
let totalWarnings = 0;
const allFindings = [];

for (const file of files) {
  let source;
  try {
    source = readFileSync(resolve(file), 'utf-8');
  } catch (e) {
    console.error(`Error: Cannot read ${file}: ${e.message}`);
    continue;
  }

  const findings = lintScript(source, { acorn, yamlConfig });

  // Add file path to findings
  for (const f of findings) {
    f.file = file;
    totalErrors += f.severity === 'error' ? 1 : 0;
    totalWarnings += f.severity === 'warning' ? 1 : 0;
  }

  allFindings.push(...findings);
}

// Output
if (format === 'json') {
  console.log(JSON.stringify(allFindings, null, 2));
} else if (format === 'github') {
  for (const f of allFindings) {
    const level = f.severity === 'error' ? 'error' : 'warning';
    const loc = f.line > 0 ? `,line=${f.line},col=${f.column}` : '';
    console.log(`::${level} file=${f.file}${loc}::${f.rule}: ${f.message}`);
  }
} else {
  // Terminal
  if (allFindings.length === 0) {
    console.log('\x1b[32m✓ No issues found.\x1b[0m');
  } else {
    for (const f of allFindings) {
      const color = f.severity === 'error' ? '\x1b[31m' : '\x1b[33m';
      const prefix = f.severity === 'error' ? 'ERROR' : 'WARN ';
      const loc = f.line > 0 ? `:${f.line}:${f.column}` : '';
      console.log(`${color}[${f.rule}] ${prefix}\x1b[0m ${f.file}${loc}: ${f.message}`);
    }
    console.log(`\n${totalErrors} error(s), ${totalWarnings} warning(s)`);
  }
}

process.exit(totalErrors > 0 ? 1 : 0);
