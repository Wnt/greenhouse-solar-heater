#!/usr/bin/env node
'use strict';

// Generates design/docs/pdf/system-topology.svg from the drawio source:
//
//   1. Runs generate-topology.js with --theme light to a temp drawio file
//      (the light theme only exists as an on-demand generator output —
//      the committed system-topology.drawio stays dark).
//   2. Invokes the `drawio` CLI to export a light-theme SVG directly to
//      design/docs/pdf/system-topology.svg.
//
// Usage:
//   node design/docs/pdf/generate-topology-svg.js
//     (or: npm run topology-svg)
//
// Requires: the `drawio` CLI in PATH (brew install drawio). Override the
// binary location via the DRAWIO_BIN env var if it's installed elsewhere.
//
// NOTE: design/diagrams/system-topology.svg is a **hand-authored** SVG
// (height layout diagram) and is NOT the output of this script. Do not
// confuse the two.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GENERATOR = path.join(REPO_ROOT, 'design', 'diagrams', 'generate-topology.js');
const OUTPUT_SVG = path.join(__dirname, 'system-topology.svg');
const DRAWIO_BIN = process.env.DRAWIO_BIN || '/opt/homebrew/bin/drawio';

function main() {
  const { theme, output } = parseArgs(process.argv.slice(2));
  const targetSvg = output
    ? path.resolve(process.cwd(), output)
    : OUTPUT_SVG;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-svg-'));
  const tmpDrawio = path.join(tmpDir, `system-topology-${theme}.drawio`);

  try {
    step(`generating ${theme}-theme drawio → ${rel(tmpDrawio)}`);
    runChecked('node', [GENERATOR, '--theme', theme, '--output', tmpDrawio]);

    // drawio's --svg-theme flag controls how `light-dark()` CSS functions
    // resolve in the exported SVG. Use "light" only for the light theme;
    // every other theme (dark, playground, …) takes the dark branch.
    const svgTheme = theme === 'light' ? 'light' : 'dark';

    step(`drawio CLI export (--svg-theme ${svgTheme}) → ${rel(targetSvg)}`);
    runChecked(DRAWIO_BIN, [
      '--export',
      '--format', 'svg',
      '--svg-theme', svgTheme,
      '-o', targetSvg,
      tmpDrawio,
    ]);

    const stats = fs.statSync(targetSvg);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(`\n✓ wrote ${rel(targetSvg)} (${sizeKB} KB)`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

function parseArgs(argv) {
  var theme = 'light';
  var output = null;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--theme') { theme = argv[++i]; continue; }
    if (a === '--output') { output = argv[++i]; continue; }
    throw new Error('Unknown argument: ' + a);
  }
  return { theme: theme, output: output };
}

function step(msg) {
  console.log(`  ${msg}`);
}

function rel(p) {
  return path.relative(REPO_ROOT, p) || p;
}

function runChecked(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) {
    throw new Error(`failed to spawn ${cmd}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    throw new Error(`${cmd} exited with status ${res.status}`);
  }
}

try {
  main();
} catch (err) {
  console.error('\nError:', err.message || err);
  process.exit(1);
}
