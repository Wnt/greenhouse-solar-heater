#!/usr/bin/env node
// Enforces the file-size budget defined in
// docs/superpowers/specs/2026-04-22-tech-debt-dead-code-and-file-size-design.md
//
// Source JS (playground/js/**, server/**): soft 400, hard 600 lines.
// Test JS (tests/**):                       soft 800, hard 1200 lines.
//
// Flags:
//   --strict   exit 1 if any file exceeds its hard cap (CI gate once enabled).
//              Default: warn mode, always exit 0.

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const STRICT = process.argv.includes('--strict');

const SOURCE_SOFT = 400;
const SOURCE_HARD = 600;
const TEST_SOFT = 800;
const TEST_HARD = 1200;

function listTrackedFiles() {
  const out = execSync('git ls-files playground/js server tests', { encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter(p => p.endsWith('.js') || p.endsWith('.mjs'));
}

function isTest(p) {
  return p.startsWith('tests/');
}

function countLines(p) {
  const content = readFileSync(p, 'utf8');
  return content.split('\n').length;
}

const findings = [];
for (const file of listTrackedFiles()) {
  // A tracked file may be unstaged-deleted; skip silently.
  if (!existsSync(file)) continue;
  const lines = countLines(file);
  const [soft, hard] = isTest(file) ? [TEST_SOFT, TEST_HARD] : [SOURCE_SOFT, SOURCE_HARD];
  if (lines > hard) findings.push({ file, lines, cap: hard, level: 'error' });
  else if (lines > soft) findings.push({ file, lines, cap: soft, level: 'warn' });
}

findings.sort((a, b) => b.lines - a.lines);

const errors = findings.filter(f => f.level === 'error');
const warns = findings.filter(f => f.level === 'warn');

if (findings.length === 0) {
  console.log('check-file-size: all files within caps ✓');
  process.exit(0);
}

for (const f of findings) {
  const marker = f.level === 'error' ? '✗' : '~';
  console.log(`${marker} ${f.file}  ${f.lines} lines (cap ${f.cap})`);
}
console.log('');
console.log(`check-file-size: ${errors.length} over hard cap, ${warns.length} over soft cap`);

if (errors.length > 0 && STRICT) {
  console.log('FAIL: --strict mode; files exceed hard cap.');
  process.exit(1);
}
if (errors.length > 0) {
  console.log('(warn mode — not failing. Pass --strict to enforce.)');
}
process.exit(0);
