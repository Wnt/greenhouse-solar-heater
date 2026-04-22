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

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const STRICT = process.argv.includes('--strict');

const SOURCE_SOFT = 400;
const SOURCE_HARD = 600;
const TEST_SOFT = 800;
const TEST_HARD = 1200;

// Roots to walk. Everything not under these trees is ignored by design;
// the file-size budget applies to hand-written JS only.
const ROOTS = ['playground/js', 'server', 'tests'];

// Paths under ROOTS we don't enforce the budget on: test output, copied
// runtime deps, and directories the CLAUDE.md exclusions cover.
const IGNORE_PREFIXES = ['tests/output/', 'tests/output'];

function listJsFiles() {
  const files = [];
  for (const root of ROOTS) {
    const entries = readdirSync(root, { recursive: true, withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!(ent.name.endsWith('.js') || ent.name.endsWith('.mjs'))) continue;
      const rel = path.posix.join(ent.parentPath || ent.path || root, ent.name)
        .replace(/\\/g, '/');
      if (IGNORE_PREFIXES.some(p => rel.startsWith(p))) continue;
      files.push(rel);
    }
  }
  return files;
}

function isTest(p) {
  return p.startsWith('tests/');
}

function countLines(p) {
  const content = readFileSync(p, 'utf8');
  return content.split('\n').length;
}

const findings = [];
for (const file of listJsFiles()) {
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
