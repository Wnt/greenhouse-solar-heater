#!/usr/bin/env node
'use strict';

// Static WCAG contrast checker for a drawio file.
//
// Usage:
//   node design/docs/pdf/check-contrast.js <path-to.drawio>
//
// Reads every <mxCell> with a fontColor, determines the effective background
// (parent fillColor if the cell is a drawio child, else the smallest vertex
// whose bounding box contains the cell centroid, else white), alpha-blends
// the bg over white, and computes a WCAG contrast ratio. Reports a status
// table and exits non-zero if any cell fails the AA normal-text threshold
// (4.5:1). Large-text threshold (3.0:1) is noted but not enforced.

const fs = require('fs');
const path = require('path');

// --- WCAG helpers -----------------------------------------------------------

function relLuminance(hex) {
  let h = hex.replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// Parse `#RRGGBB` or `#RRGGBBAA` and blend over white. Keeps things simple —
// the actual canvas is white in the light theme, and alpha layering of
// multiple translucent panels on top of each other is rare enough to ignore.
function blendOverWhite(hexAlpha) {
  if (!hexAlpha) return null;
  const m = hexAlpha.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);
  if (!m) return null;
  const base = m[1];
  const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
  if (a >= 0.999) return '#' + base.toLowerCase();
  const R = parseInt(base.slice(0, 2), 16);
  const G = parseInt(base.slice(2, 4), 16);
  const B = parseInt(base.slice(4, 6), 16);
  const br = Math.round(R * a + 255 * (1 - a));
  const bg = Math.round(G * a + 255 * (1 - a));
  const bb = Math.round(B * a + 255 * (1 - a));
  return '#' + [br, bg, bb].map((v) => v.toString(16).padStart(2, '0')).join('');
}

// --- Cell parsing -----------------------------------------------------------

function parseCells(xml) {
  const cells = {};
  const blockRe = /<mxCell\b([^>]*?)(?:\/>|>)/g;
  let m;
  while ((m = blockRe.exec(xml)) !== null) {
    const attrs = m[1];
    const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
    if (!id) continue;
    const style = (attrs.match(/\bstyle="([^"]*)"/) || [])[1] || '';
    const parent = (attrs.match(/\bparent="([^"]+)"/) || [])[1] || '1';
    const fontRaw = (style.match(/fontColor=(#[0-9a-fA-F]+)/) || [])[1];
    const fillRaw = (style.match(/fillColor=(#[0-9a-fA-F]+)/) || [])[1];
    cells[id] = {
      id,
      parent,
      fontColor: blendOverWhite(fontRaw),
      fillColor: blendOverWhite(fillRaw),
    };
  }
  return cells;
}

function parseGeometries(xml) {
  const geom = {};
  const re = /<mxCell\b[^>]*\bid="([^"]+)"[\s\S]*?<mxGeometry\b([^>]*?)(?:\/>|>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const id = m[1];
    if (geom[id]) continue;
    const g = m[2];
    const x = +((g.match(/\bx="([-\d.]+)"/) || [])[1] || 0);
    const y = +((g.match(/\by="([-\d.]+)"/) || [])[1] || 0);
    const w = +((g.match(/\bwidth="([-\d.]+)"/) || [])[1] || 0);
    const h = +((g.match(/\bheight="([-\d.]+)"/) || [])[1] || 0);
    geom[id] = { x, y, w, h };
  }
  return geom;
}

// --- Background resolver ----------------------------------------------------

function backgroundFor(cell, cells, geom, canvasBg) {
  // If the cell has its own fill (panel with a title), that's where its
  // fontColor is painted — not whatever happens to overlap its centroid.
  if (cell.fillColor) return cell.fillColor;

  // If the cell is a drawio child of another vertex with a fill, use that.
  const parentCell = cells[cell.parent];
  if (parentCell && parentCell.fillColor) return parentCell.fillColor;
  if (cell.parent !== '1') return canvasBg;

  // Otherwise, find the smallest filled vertex whose bounding box contains
  // the cell's centroid — that's the visual backdrop.
  const g = geom[cell.id];
  if (!g) return canvasBg;
  const cx = g.x + g.w / 2;
  const cy = g.y + g.h / 2;
  let best = null;
  let bestArea = Infinity;
  for (const other of Object.values(cells)) {
    if (other.id === cell.id || !other.fillColor) continue;
    const og = geom[other.id];
    if (!og) continue;
    if (cx < og.x || cx > og.x + og.w || cy < og.y || cy > og.y + og.h) continue;
    const area = og.w * og.h;
    if (area < bestArea) {
      bestArea = area;
      best = other.fillColor;
    }
  }
  return best || canvasBg;
}

// --- Main -------------------------------------------------------------------

function main() {
  const drawioPath = process.argv[2];
  if (!drawioPath) {
    console.error('Usage: node check-contrast.js <path-to.drawio>');
    process.exit(2);
  }
  const xml = fs.readFileSync(drawioPath, 'utf8');

  // Canvas background from <mxGraphModel ... background="#xxxxxx">
  const bgMatch = xml.match(/background="(#[0-9a-fA-F]{6,8})"/);
  const canvasBg = bgMatch ? blendOverWhite(bgMatch[1]) : '#ffffff';

  const cells = parseCells(xml);
  const geom = parseGeometries(xml);

  const rows = [];
  for (const cell of Object.values(cells)) {
    if (!cell.fontColor) continue;
    const bg = backgroundFor(cell, cells, geom, canvasBg);
    rows.push({
      id: cell.id,
      fg: cell.fontColor,
      bg,
      ratio: contrast(cell.fontColor, bg),
    });
  }
  rows.sort((a, b) => a.ratio - b.ratio);

  const AA_NORMAL = 4.5;
  const AA_LARGE = 3.0;

  let okCount = 0;
  let largeCount = 0;
  let failCount = 0;

  console.log(`File:   ${path.relative(process.cwd(), drawioPath)}`);
  console.log(`Canvas: ${canvasBg}`);
  console.log(`\nWCAG contrast (text vs background, alpha blended over white)`);
  console.log(`AA normal ≥ ${AA_NORMAL.toFixed(1)}  |  AA large ≥ ${AA_LARGE.toFixed(1)}\n`);
  console.log(`${'ID'.padEnd(34)}${'FG'.padEnd(10)}${'BG'.padEnd(10)}Ratio  Status`);
  console.log('-'.repeat(70));
  for (const r of rows) {
    let status;
    if (r.ratio >= AA_NORMAL) {
      status = 'OK';
      okCount++;
    } else if (r.ratio >= AA_LARGE) {
      status = 'large';
      largeCount++;
    } else {
      status = 'FAIL';
      failCount++;
    }
    console.log(
      r.id.padEnd(34) +
        r.fg.padEnd(10) +
        r.bg.padEnd(10) +
        r.ratio.toFixed(2).padStart(5) +
        '  ' +
        status,
    );
  }
  console.log(
    `\nTotals: ${okCount} OK / ${largeCount} large-only / ${failCount} FAIL  (of ${rows.length})`,
  );

  process.exit(failCount === 0 ? 0 : 1);
}

if (require.main === module) main();

module.exports = { contrast, relLuminance, blendOverWhite, parseCells, parseGeometries, backgroundFor };
