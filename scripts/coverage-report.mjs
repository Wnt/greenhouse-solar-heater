#!/usr/bin/env node
// Merges per-spec V8 coverage dumps (written by tests/frontend/fixtures.js
// when COVERAGE=1) into an istanbul coverage map and renders it to
// coverage/{lcov-report, lcov.info, text summary}.
//
// Scope: tests/frontend only — the tests/e2e suite has so little
// surface right now that running coverage against it adds noise, not
// signal. See memory/feedback_* for context.
//
// Usage:
//   COVERAGE=1 npx playwright test --project=frontend
//   node scripts/coverage-report.mjs
//
// Or just:
//   npm run coverage:frontend

import { readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8toIstanbul from 'v8-to-istanbul';
import libCoverage from 'istanbul-lib-coverage';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_DIR = path.join(ROOT, 'coverage/raw');
const REPORT_DIR = path.join(ROOT, 'coverage');
const PLAYGROUND_DIR = path.join(ROOT, 'playground');

// Map the URL Playwright reports (http://localhost:3210/js/main.js)
// to the local file v8-to-istanbul needs to resolve. Anything outside
// playground/js/ or playground/public/ is dropped — we only care about
// first-party code, not Playwright internals or vendored libraries.
function urlToLocalPath(url) {
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  // `serve` is run from the repo root, so URLs come through as
  // /playground/js/main.js. Strip the /playground prefix when present.
  if (pathname.startsWith('/playground/')) pathname = pathname.slice('/playground'.length);
  if (pathname.startsWith('/js/') || pathname === '/sw.js') {
    const candidate = path.join(PLAYGROUND_DIR, pathname);
    return existsSync(candidate) ? candidate : null;
  }
  return null;
}

async function convertEntry(map, entry) {
  const localPath = urlToLocalPath(entry.url);
  if (!localPath) return;
  const converter = v8toIstanbul(localPath, 0, { source: entry.source });
  try {
    await converter.load();
    converter.applyCoverage(entry.functions);
    const istanbulData = converter.toIstanbul();
    map.merge(istanbulData);
  } catch (err) {
    // v8-to-istanbul chokes occasionally on source-map edge cases —
    // don't let one bad file black-hole the whole report.
    process.stderr.write(`[coverage] skipped ${localPath}: ${err.message}\n`);
  } finally {
    converter.destroy();
  }
}

function listPlaygroundJsFiles() {
  const root = path.join(PLAYGROUND_DIR, 'js');
  const entries = readdirSync(root, { recursive: true, withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.js') && !ent.name.endsWith('.mjs')) continue;
    const abs = path.join(ent.parentPath || ent.path || root, ent.name);
    out.push(abs);
  }
  return out;
}

async function seedZeroCoverage(map) {
  for (const absPath of listPlaygroundJsFiles()) {
    if (map.files().includes(absPath)) continue;
    const source = readFileSync(absPath, 'utf8');
    const converter = v8toIstanbul(absPath, 0, { source });
    try {
      await converter.load();
      converter.applyCoverage([]);
      const data = converter.toIstanbul();
      // v8-to-istanbul defaults every statement/branch/function hit
      // count to 1 and only drops counts based on explicit uncovered
      // ranges. Empty coverage therefore reads as 100% — the opposite
      // of what we want. Manually zero the counters so "never loaded"
      // reports as 0%.
      for (const file of Object.keys(data)) {
        const entry = data[file];
        for (const k of Object.keys(entry.s)) entry.s[k] = 0;
        for (const k of Object.keys(entry.f)) entry.f[k] = 0;
        for (const k of Object.keys(entry.b)) entry.b[k] = entry.b[k].map(() => 0);
      }
      map.merge(data);
    } catch (err) {
      process.stderr.write(`[coverage] zero-seed failed for ${absPath}: ${err.message}\n`);
    } finally {
      converter.destroy();
    }
  }
}

async function main() {
  if (!existsSync(RAW_DIR)) {
    process.stderr.write(`[coverage] no raw dump at ${RAW_DIR}. Run COVERAGE=1 npx playwright test --project=frontend first.\n`);
    process.exit(1);
  }

  const rawFiles = readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));
  if (rawFiles.length === 0) {
    process.stderr.write('[coverage] raw dir is empty — tests ran but no coverage entries matched playground/js/**.\n');
    process.exit(1);
  }

  const map = libCoverage.createCoverageMap({});
  for (const f of rawFiles) {
    const entries = JSON.parse(readFileSync(path.join(RAW_DIR, f), 'utf8'));
    for (const entry of entries) {
      await convertEntry(map, entry);
    }
  }

  // V8 coverage only records files V8 actually loaded. A playground
  // module that no spec ever imports silently vanishes from the
  // report — the opposite of what we want. Walk the playground/js
  // tree and synthesise a 0% entry for anything not already in the
  // map so "never loaded" shows up as "0% covered".
  await seedZeroCoverage(map);

  // Clear previous report artifacts so removed files don't linger.
  const prior = ['lcov-report', 'lcov.info', 'coverage-summary.json'];
  for (const p of prior) {
    const abs = path.join(REPORT_DIR, p);
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
  }

  const context = libReport.createContext({
    dir: REPORT_DIR,
    defaultSummarizer: 'nested',
    coverageMap: map,
  });

  reports.create('text', { skipEmpty: false, skipFull: false }).execute(context);
  reports.create('lcov').execute(context);
  reports.create('json-summary').execute(context);

  const htmlIndex = path.join(REPORT_DIR, 'lcov-report/index.html');
  if (existsSync(htmlIndex)) {
    process.stdout.write(`\n[coverage] HTML report: ${pathToFileURL(htmlIndex).href}\n`);
  }
}

main().catch(err => {
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
