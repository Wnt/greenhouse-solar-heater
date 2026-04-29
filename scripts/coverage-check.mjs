#!/usr/bin/env node
// Enforces the per-file frontend coverage gate described in
// coverage-exclusions.json: every playground/js/** file must have
// ≥50% statement coverage from the tests/frontend Playwright suite,
// or be listed in coverage-exclusions.json with a written reason.
//
// Failure modes:
//   - A non-excluded file is below the threshold → CI fails. Fix by
//     adding a spec that exercises it, or add the path to
//     coverage-exclusions.json with a comment explaining why.
//   - An excluded file has climbed ≥threshold → CI fails. Drop the
//     entry from coverage-exclusions.json; the exclusion is stale.
//
// Runs after scripts/coverage-report.mjs in CI. Reads:
//   coverage/coverage-summary.json (from the report script)
//   coverage-exclusions.json       (repo root)

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUMMARY_PATH = path.join(ROOT, 'coverage/coverage-summary.json');
const EXCLUSIONS_PATH = path.join(ROOT, 'coverage-exclusions.json');
const THRESHOLD = 50;

if (!existsSync(SUMMARY_PATH)) {
  process.stderr.write(`[coverage-check] ${SUMMARY_PATH} not found. Run \`node scripts/coverage-report.mjs\` first.\n`);
  process.exit(1);
}

const summary = JSON.parse(readFileSync(SUMMARY_PATH, 'utf8'));
const exclusionsRaw = existsSync(EXCLUSIONS_PATH)
  ? JSON.parse(readFileSync(EXCLUSIONS_PATH, 'utf8'))
  : { files: {} };
const exclusionsMap = exclusionsRaw.files || {};

// The summary's keys are absolute paths. The exclusions file stores
// repo-relative paths for readability. The filtered report doesn't
// include excluded files at all — so anything in the summary is a
// candidate for the threshold check. We still need the exclusions
// map to flag stale exclusions (files that ARE in the summary
// because they WEREN'T excluded but coverage climbed past the mark
// doesn't apply here — see below).
const excludedAbs = new Set(Object.keys(exclusionsMap).map(rel => path.join(ROOT, rel)));

const failed = [];
for (const [key, data] of Object.entries(summary)) {
  if (key === 'total') continue;
  const rel = path.relative(ROOT, key);
  const pct = data.statements.pct;
  if (pct < THRESHOLD) failed.push({ rel, pct });
}

// Stale-exclusion pressure: if an excluded file was converted via
// v8-to-istanbul but then filtered out of the summary, we can't read
// its % here. coverage-report.mjs does filter excluded files out of
// the summary entirely. To detect stale exclusions, re-parse the
// unfiltered summary at coverage-summary-with-excluded.json (lcov is
// line-level — easier to read a separate JSON). The report script
// emits this file when exclusions are present.
const staleExclusions = [];
const FULL_SUMMARY_PATH = path.join(ROOT, 'coverage/coverage-summary-with-excluded.json');
if (existsSync(FULL_SUMMARY_PATH)) {
  const full = JSON.parse(readFileSync(FULL_SUMMARY_PATH, 'utf8'));
  for (const [key, data] of Object.entries(full)) {
    if (key === 'total') continue;
    if (!excludedAbs.has(key)) continue;
    const pct = data.statements.pct;
    if (pct >= THRESHOLD) staleExclusions.push({ rel: path.relative(ROOT, key), pct });
  }
}

if (failed.length === 0 && staleExclusions.length === 0) {
  const excludedCount = Object.keys(exclusionsMap).length;
  process.stdout.write(
    `coverage-check: every non-excluded playground/js file ≥${THRESHOLD}% statements ` +
    `(${Object.keys(summary).length - 1} checked, ${excludedCount} excluded) ✓\n`
  );
  process.exit(0);
}

if (failed.length > 0) {
  process.stderr.write(`\n✗ Frontend coverage below ${THRESHOLD}% statements (and not excluded):\n`);
  for (const { rel, pct } of failed.sort((a, b) => a.pct - b.pct)) {
    process.stderr.write(`    ${rel}  ${pct.toFixed(1)}%\n`);
  }
  process.stderr.write(
    '\n  Either add a frontend spec that exercises the file, or add an entry ' +
    'to coverage-exclusions.json with a reason.\n'
  );
}

if (staleExclusions.length > 0) {
  process.stderr.write(`\n✗ Excluded files now ≥${THRESHOLD}% — remove them from coverage-exclusions.json:\n`);
  for (const { rel, pct } of staleExclusions) {
    process.stderr.write(`    ${rel}  ${pct.toFixed(1)}%\n`);
  }
}

process.exit(1);
