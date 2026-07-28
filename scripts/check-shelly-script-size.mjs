#!/usr/bin/env node
// Shelly control-script memory-budget gate (2026-07-28 OOM postmortem).
//
// The Pro 4PM's per-script JsVar pool is fixed (25,186 bytes) and resident
// usage tracks the deploy-shape source size, so this check computes the
// EXACT bytes deploy.sh uploads (its minify: strip comment-only lines +
// leading whitespace) for control-logic.js + control.js and fails when the
// total exceeds the hard cap in shelly/script-budget.json.
//
// The cap is not a style budget — it is calibrated against on-device
// measurements recorded in the budget file. To raise it: deploy the
// candidate script, observe a mode transition, read Script.GetStatus
// mem_peak (or run scripts/spare-2pm-memcheck.mjs against the spare 2PM),
// then update the calibration block together with the new cap in the same
// commit. See the budget file's _comment.
//
// Env override SHELLY_SCRIPT_MAX_BYTES exists for the unit test only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SHELLY_DIR = path.join(__dirname, '..', 'shelly');
const BUDGET_PATH = path.join(SHELLY_DIR, 'script-budget.json');

// Mirrors minify() in shelly/deploy.sh (and tests/deploy.test.js): drop
// blank/comment-only lines, strip leading whitespace, join, trailing \n.
export function minify(src) {
  const out = [];
  for (const line of src.split('\n')) {
    const stripped = line.replace(/^\s+/, '');
    if (!stripped || stripped.startsWith('//')) continue;
    out.push(stripped);
  }
  return out.join('\n') + '\n';
}

const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
const cap = process.env.SHELLY_SCRIPT_MAX_BYTES
  ? parseInt(process.env.SHELLY_SCRIPT_MAX_BYTES, 10)
  : budget.maxMinifiedBytes;

let total = 0;
const rows = [];
for (const f of budget.files) {
  const bytes = Buffer.byteLength(minify(readFileSync(path.join(SHELLY_DIR, f), 'utf8')));
  rows.push(`  ${f.padEnd(20)} ${String(bytes).padStart(6)} B`);
  total += bytes;
}

console.log('shelly control-script deploy-shape bytes (post-minify):');
for (const r of rows) console.log(r);
console.log(`  ${'TOTAL'.padEnd(20)} ${String(total).padStart(6)} B  (cap ${cap} B, margin ${cap - total} B)`);
console.log(`  JsVar pool ${budget.jsvarPoolBytes} B; last calibration ${budget.calibration.date}: ` +
  `transition mem_peak ${budget.calibration.transitionMemPeak} B ` +
  `(headroom ${budget.jsvarPoolBytes - budget.calibration.transitionMemPeak} B)`);

if (total > cap) {
  console.error(
    `\nFAIL: control script is ${total - cap} B over the budget cap.\n` +
    'The on-device JsVar pool is fixed and the last calibrated transition peak\n' +
    `left only ${budget.jsvarPoolBytes - budget.calibration.transitionMemPeak} B of headroom — growth here OOM-crash-loops the 4PM\n` +
    '(2026-07-28 incident). Either shrink the script, or recalibrate on-device\n' +
    'and update shelly/script-budget.json (calibration block + cap) in the same\n' +
    'commit. Procedure in the budget file’s _comment.'
  );
  process.exit(1);
}
