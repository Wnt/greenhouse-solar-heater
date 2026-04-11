#!/usr/bin/env node
'use strict';

// Generates design/docs/pdf/system-topology.pdf from the drawio source:
//
//   1. Runs generate-topology.js with --theme light to a temp drawio file
//      (the light theme only exists as an on-demand generator output —
//      the committed system-topology.drawio stays dark).
//   2. Invokes the `drawio` CLI to export an SVG with --svg-theme light.
//   3. Renders the SVG to an A4-landscape PDF via Playwright, with the
//      color-scheme emulated as light so drawio's light-dark() CSS
//      functions resolve to their light branches.
//   4. Writes design/docs/pdf/system-topology.pdf.
//   5. Removes temp files.
//
// Usage:
//   node design/docs/pdf/generate-topology-pdf.js
//     (or: npm run topology-pdf)
//
// Requires: the `drawio` CLI in PATH (brew install drawio) and `playwright`
// installed via npm (already a devDependency of the app).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GENERATOR = path.join(REPO_ROOT, 'design', 'diagrams', 'generate-topology.js');
const OUTPUT_PDF = path.join(__dirname, 'system-topology.pdf');
const DRAWIO_BIN = process.env.DRAWIO_BIN || '/opt/homebrew/bin/drawio';

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-pdf-'));
  const tmpDrawio = path.join(tmpDir, 'system-topology-light.drawio');
  const tmpSvg = path.join(tmpDir, 'system-topology-light.svg');

  try {
    // 1. Generate light-theme drawio
    step(`generating light-theme drawio → ${rel(tmpDrawio)}`);
    runChecked('node', [GENERATOR, '--theme', 'light', '--output', tmpDrawio]);

    // 2. drawio CLI → light SVG
    step(`drawio CLI export → ${rel(tmpSvg)}`);
    runChecked(DRAWIO_BIN, [
      '--export',
      '--format', 'svg',
      '--svg-theme', 'light',
      '-o', tmpSvg,
      tmpDrawio,
    ]);

    // 3. Playwright render → PDF
    step(`playwright render → ${rel(OUTPUT_PDF)}`);
    const { chromium } = require('playwright');
    const svg = fs.readFileSync(tmpSvg, 'utf8');
    const html = buildHtml(svg);

    const browser = await chromium.launch({ headless: true });
    try {
      const context = await browser.newContext({ colorScheme: 'light' });
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: 'light' });
      await page.setContent(html, { waitUntil: 'networkidle' });
      await page.pdf({
        path: OUTPUT_PDF,
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' },
      });
    } finally {
      await browser.close();
    }

    const stats = fs.statSync(OUTPUT_PDF);
    const sizeKB = (stats.size / 1024).toFixed(1);
    console.log(`\n✓ wrote ${rel(OUTPUT_PDF)} (${sizeKB} KB)`);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
}

// --- helpers ----------------------------------------------------------------

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

function buildHtml(svg) {
  return `<!doctype html>
<html lang="en" style="color-scheme: light">
<head>
  <meta charset="utf-8">
  <title>System topology</title>
  <style>
    @page { size: A4 landscape; margin: 8mm; }
    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color-scheme: light;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .wrap {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    svg {
      width: 100%;
      height: auto;
      display: block;
    }
  </style>
</head>
<body><div class="wrap">${svg}</div></body>
</html>`;
}

main().catch((err) => {
  console.error('\nError:', err.message || err);
  process.exit(1);
});
