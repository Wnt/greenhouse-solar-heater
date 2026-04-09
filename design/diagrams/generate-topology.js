#!/usr/bin/env node
'use strict';

// Generates design/diagrams/system-topology.drawio from:
//   - system.yaml              (source of truth: components, valves, sensors)
//   - topology-layout.yaml     (layout rules: positions, styles, pipe routing)
//
// Re-run this whenever you edit either file:
//   node design/diagrams/generate-topology.js
//
// Output cells produced by this generator have:
//   - Pipes connected via source/target vertex refs + exitX/exitY style
//     attributes, so moving a component drags the pipe endpoints with it.
//   - Pipe labels attached to the edge cell's `value` attribute.
//   - Sensor labels attached to the sensor cell via labelPosition=right/left
//     style, so the label follows the sensor dot.

const fs = require('fs');
const path = require('path');

const yaml = require('js-yaml');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SYSTEM_FILE = path.join(REPO_ROOT, 'system.yaml');
const DEFAULT_LAYOUT_FILE = path.join(__dirname, 'topology-layout.yaml');
const DEFAULT_OUTPUT_FILE = path.join(__dirname, 'system-topology.drawio');

// -----------------------------------------------------------------------------
// Public API: pure function that produces the drawio XML string.
// Used both by the CLI entry point (below) and by the up-to-date test in
// tests/topology-diagram.test.js.
// -----------------------------------------------------------------------------

function generateTopology({
  systemFile = DEFAULT_SYSTEM_FILE,
  layoutFile = DEFAULT_LAYOUT_FILE,
  silent = false,
} = {}) {
  const warn = silent ? () => {} : (...args) => console.warn(...args);

  const layout = yaml.load(fs.readFileSync(layoutFile, 'utf8'));

  // system.yaml is only used for validation (warning if a component/valve/
  // sensor declared there is missing from the layout). Parse tolerantly —
  // if it fails (e.g. the shopping_list section has mixed map/sequence
  // YAML), skip the cross-check instead of blocking diagram generation.
  let system = null;
  try {
    system = yaml.load(fs.readFileSync(systemFile, 'utf8'));
  } catch (err) {
    const firstLine = String(err.message || err).split('\n')[0];
    warn(`  ! system.yaml parse failed: ${firstLine}`);
    warn(`  ! skipping cross-validation (layout-only generation)`);
  }

  if (system) validateLayout(system, layout, warn);

  const cells = [];
  cells.push(...titleCells(layout));
  cells.push(...scaleCells(layout));
  cells.push(...textLabelCells(layout));
  cells.push(...manifoldCells(layout));
  cells.push(...componentCells(layout));
  cells.push(...valveCells(layout));
  cells.push(...sensorCells(layout));
  cells.push(...pipeCells(layout));
  cells.push(...legendCells(layout));

  return { xml: wrapMxfile(cells, layout.canvas), cellCount: cells.length };
}

// -----------------------------------------------------------------------------
// CLI entry point: writes the result to disk.
// -----------------------------------------------------------------------------

function main() {
  const { xml, cellCount } = generateTopology();
  fs.writeFileSync(DEFAULT_OUTPUT_FILE, xml);
  console.log(`✓ wrote ${path.relative(REPO_ROOT, DEFAULT_OUTPUT_FILE)} (${cellCount} cells)`);
}

// -----------------------------------------------------------------------------
// Validation: warn if system.yaml declares things the layout doesn't cover
// -----------------------------------------------------------------------------

function validateLayout(system, layout, warn = console.warn) {
  const expectedValves = [];
  const v = system.valves || {};
  if (v.input_manifold) {
    for (const k of ['vi_btm', 'vi_top', 'vi_coll']) {
      if (v.input_manifold[k]) expectedValves.push(k);
    }
  }
  if (v.output_manifold) {
    for (const k of ['vo_coll', 'vo_rad', 'vo_tank']) {
      if (v.output_manifold[k]) expectedValves.push(k);
    }
  }
  if (v.collector_top) {
    for (const k of ['v_ret', 'v_air']) {
      if (v.collector_top[k]) expectedValves.push(k);
    }
  }
  const laidOutValves = new Set(Object.keys(layout.valves || {}));
  const missingValves = expectedValves.filter((n) => !laidOutValves.has(n));
  if (missingValves.length) {
    warn('  ! layout missing valves:', missingValves.join(', '));
  }

  const expectedSensors = Object.entries(system.sensors || {})
    .filter(([, s]) => !s.optional)
    .map(([name]) => name);
  const laidOutSensors = new Set(Object.keys(layout.sensors || {}));
  const missingSensors = expectedSensors.filter((n) => !laidOutSensors.has(n));
  if (missingSensors.length) {
    warn('  ! layout missing sensors:', missingSensors.join(', '));
  }
}

// -----------------------------------------------------------------------------
// XML primitives
// -----------------------------------------------------------------------------

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '&#10;');
}

function vertex({ id, value = '', style = '', x, y, w, h, parent = '1' }) {
  return (
    `<mxCell id="${xmlEscape(id)}" value="${xmlEscape(value)}" ` +
    `style="${xmlEscape(style)}" vertex="1" parent="${parent}">` +
    `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>` +
    `</mxCell>`
  );
}

function edge({
  id,
  value = '',
  style = '',
  source = '',
  target = '',
  sx = null,
  sy = null,
  tx = null,
  ty = null,
  waypoints = [],
  parent = '1',
}) {
  const srcAttr = source ? ` source="${xmlEscape(source)}"` : '';
  const tgtAttr = target ? ` target="${xmlEscape(target)}"` : '';
  const srcPt =
    !source && sx !== null ? `<mxPoint x="${sx}" y="${sy}" as="sourcePoint"/>` : '';
  const tgtPt =
    !target && tx !== null ? `<mxPoint x="${tx}" y="${ty}" as="targetPoint"/>` : '';
  const wp = waypoints.length
    ? `<Array as="points">${waypoints
        .map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`)
        .join('')}</Array>`
    : '';
  return (
    `<mxCell id="${xmlEscape(id)}" value="${xmlEscape(value)}" ` +
    `style="${xmlEscape(style)}" edge="1" parent="${parent}"${srcAttr}${tgtAttr}>` +
    `<mxGeometry relative="1" as="geometry">${srcPt}${tgtPt}${wp}</mxGeometry>` +
    `</mxCell>`
  );
}

// Merge a drawio style string with an extras object, deduplicating keys.
// Last occurrence of a key wins (both within `base` and across base+extras).
// Standalone shape names like "ellipse" or "triangle" (no `=`) are preserved
// once at the start of the output.
function mergeStyle(base, extras) {
  const parts = String(base || '').split(';').map((p) => p.trim()).filter(Boolean);
  const shapes = [];
  const keyed = new Map();
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) {
      if (!shapes.includes(p)) shapes.push(p);
    } else {
      keyed.set(p.slice(0, eq), p.slice(eq + 1));
    }
  }
  for (const [k, v] of Object.entries(extras || {})) keyed.set(k, v);
  const shapePart = shapes.join(';');
  const keyedPart = [...keyed.entries()].map(([k, v]) => `${k}=${v}`).join(';');
  const joined = [shapePart, keyedPart].filter(Boolean).join(';');
  return joined ? joined + ';' : '';
}

// -----------------------------------------------------------------------------
// Cell builders
// -----------------------------------------------------------------------------

function titleCells(layout) {
  const cells = [];
  const t = layout.title || {};
  if (t.text) {
    cells.push(
      vertex({
        id: 'title',
        value: t.text,
        style: `text;html=1;align=center;verticalAlign=middle;fontSize=20;fontStyle=1;fontColor=${
          t.color || '#ffffff'
        };`,
        x: 300,
        y: 20,
        w: 1000,
        h: 32,
      }),
    );
  }
  if (t.subtitle) {
    cells.push(
      vertex({
        id: 'subtitle',
        value: t.subtitle,
        style: `text;html=1;align=center;verticalAlign=middle;fontSize=12;fontColor=${
          t.subtitle_color || '#888888'
        };`,
        x: 300,
        y: 54,
        w: 1000,
        h: 20,
      }),
    );
  }
  return cells;
}

function scaleCells(layout) {
  const cells = [];
  const s = layout.scale;
  if (!s) return cells;
  for (const m of s.markers || []) {
    cells.push(
      vertex({
        id: `scale_${m.label.replace(/\s+/g, '_')}`,
        value: m.label,
        style: 'text;html=1;align=right;fontSize=9;fontColor=#666666;',
        x: s.label_x || 20,
        y: m.y - 7,
        w: 50,
        h: 15,
      }),
    );
  }
  if (s.line) {
    cells.push(
      edge({
        id: 'scale_line',
        style: 'endArrow=none;html=1;strokeColor=#333333;strokeWidth=1;',
        sx: s.line.x,
        sy: s.line.y1,
        tx: s.line.x,
        ty: s.line.y2,
      }),
    );
  }
  if (s.ground_line) {
    cells.push(
      edge({
        id: 'ground_line',
        style: 'endArrow=none;html=1;strokeColor=#5d4037;strokeWidth=2;dashed=1;',
        sx: s.ground_line.x1,
        sy: s.ground_line.y,
        tx: s.ground_line.x2,
        ty: s.ground_line.y,
      }),
    );
  }
  return cells;
}

function textLabelCells(layout) {
  const cells = [];
  for (const [id, l] of Object.entries(layout.text_labels || {})) {
    cells.push(
      vertex({
        id,
        value: l.value,
        style: l.style || 'text;html=1;align=left;fontSize=9;fontColor=#888888;',
        x: l.geometry.x,
        y: l.geometry.y,
        w: l.geometry.width,
        h: l.geometry.height,
      }),
    );
  }
  return cells;
}

function manifoldCells(layout) {
  const cells = [];
  for (const [id, m] of Object.entries(layout.manifolds || {})) {
    cells.push(
      vertex({
        id,
        value: m.label || '',
        style: layout.styles[m.style] || '',
        x: m.geometry.x,
        y: m.geometry.y,
        w: m.geometry.width,
        h: m.geometry.height,
      }),
    );
  }
  return cells;
}

function componentCells(layout) {
  const cells = [];
  for (const [id, c] of Object.entries(layout.components || {})) {
    if (id === 'tank') {
      cells.push(...tankCells(id, c, layout));
      continue;
    }
    cells.push(
      vertex({
        id,
        value: c.label || '',
        style: layout.styles[c.style] || '',
        x: c.geometry.x,
        y: c.geometry.y,
        w: c.geometry.width,
        h: c.geometry.height,
      }),
    );
  }
  return cells;
}

// Tank: single-geometry component with structured interior (gas, hot, cool,
// heater) + two visible ports (dip + bottom). All interior cells and port dots
// are drawio children of the tank vertex so that moving the tank drags the
// whole group (and every pipe connected to the port dots) along with it.
// Child geometry is stored relative to the tank's top-left corner (0..width,
// 0..height).
function tankCells(id, tank, layout) {
  const g = tank.geometry;
  const cells = [];
  const S = layout.styles;
  const r = Math.round;

  // Outer tank rectangle
  cells.push(
    vertex({
      id,
      value: '',
      style: S[tank.style],
      x: g.x,
      y: g.y,
      w: g.width,
      h: g.height,
    }),
  );
  // Children: positioned relative to the tank's top-left (drawio applies the
  // parent's x/y when rendering).
  const child = (extras) => vertex({ parent: id, ...extras });

  // Gas pocket (top strip)
  cells.push(
    child({
      id: `${id}_gas`,
      value: 'gas pocket',
      style:
        'rounded=0;whiteSpace=wrap;html=1;fillColor=#90caf915;strokeColor=none;fontColor=#90caf9;fontSize=8;',
      x: 4,
      y: 4,
      w: g.width - 8,
      h: 14,
    }),
  );
  // Hot zone
  cells.push(
    child({
      id: `${id}_hot`,
      value: 'HOT (top)',
      style:
        'rounded=0;whiteSpace=wrap;html=1;fillColor=#e5393515;strokeColor=none;fontColor=#ef9a9a;fontSize=11;',
      x: 4,
      y: 18,
      w: g.width - 8,
      h: r(g.height * 0.3),
    }),
  );
  // Label in the middle of the tank
  cells.push(
    child({
      id: `${id}_label`,
      value: tank.label || '',
      style: 'text;html=1;align=center;fontSize=13;fontStyle=1;fontColor=#90caf9;',
      x: 4,
      y: r(g.height * 0.42),
      w: g.width - 8,
      h: 60,
    }),
  );
  // Heater element
  cells.push(
    child({
      id: `${id}_heater`,
      value: 'heater element',
      style:
        'rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#ff5722;strokeWidth=2;dashed=1;fontColor=#ff8a65;fontSize=9;',
      x: 20,
      y: r(g.height * 0.69),
      w: g.width - 40,
      h: 20,
    }),
  );
  // Cool zone
  cells.push(
    child({
      id: `${id}_cool`,
      value: 'COOL (btm)',
      style:
        'rounded=0;whiteSpace=wrap;html=1;fillColor=#1565c025;strokeColor=none;fontColor=#64b5f6;fontSize=11;',
      x: 4,
      y: r(g.height * 0.79),
      w: g.width - 8,
      h: r(g.height * 0.19),
    }),
  );
  // Dip tube port (red dot) — child of tank at fractional port coordinates
  cells.push(
    child({
      id: `${id}_dip_port`,
      value: '',
      style: 'ellipse;whiteSpace=wrap;html=1;fillColor=#e53935;strokeColor=#e53935;',
      x: r(tank.ports.dip_port.x * g.width) - 5,
      y: r(tank.ports.dip_port.y * g.height) - 5,
      w: 10,
      h: 10,
    }),
  );
  // Bottom port (blue dot)
  cells.push(
    child({
      id: `${id}_btm_port`,
      value: '',
      style: 'ellipse;whiteSpace=wrap;html=1;fillColor=#1565c0;strokeColor=#1565c0;',
      x: r(tank.ports.btm_port.x * g.width) - 5,
      y: r(tank.ports.btm_port.y * g.height) - 5,
      w: 10,
      h: 10,
    }),
  );
  // Ports label (below the tank)
  cells.push(
    child({
      id: `${id}_ports_label`,
      value: 'dip tube port  |  bottom port  (both at 0 cm)',
      style: 'text;html=1;align=center;fontSize=9;fontColor=#888888;',
      x: -30,
      y: g.height + 12,
      w: g.width + 60,
      h: 14,
    }),
  );
  return cells;
}

function valveCells(layout) {
  const cells = [];
  const base = layout.styles.valve;
  for (const [id, v] of Object.entries(layout.valves || {})) {
    cells.push(
      vertex({
        id,
        value: v.label,
        style: base,
        x: v.geometry.x,
        y: v.geometry.y,
        w: v.geometry.width,
        h: v.geometry.height,
      }),
    );
  }
  return cells;
}

// Sensors: single 10×10 ellipse with a label attached via drawio's
// labelPosition style — the label is part of the cell and follows the dot
// when moved.
function sensorCells(layout) {
  const cells = [];
  const base = layout.styles.sensor;
  for (const [id, s] of Object.entries(layout.sensors || {})) {
    let style = base;
    if (s.label_side === 'left') {
      // Override: flip label to the left side of the dot
      style = mergeStyle(style, {
        labelPosition: 'left',
        align: 'right',
        spacingRight: 4,
        spacingLeft: 0,
      });
    }
    cells.push(
      vertex({
        id,
        value: s.label,
        style,
        x: s.geometry.x,
        y: s.geometry.y,
        w: s.geometry.width || 10,
        h: s.geometry.height || 10,
      }),
    );
  }
  return cells;
}

// Pipes: resolve from/to references to vertex ids + port fractions, then
// inject exitX/exitY/entryX/entryY into the style so drawio anchors the edge
// to those exact points. When the source or target vertex moves, the edge
// endpoints move with it.
function pipeCells(layout) {
  const cells = [];
  for (const p of layout.pipes || []) {
    const src = resolveEndpoint(p.from, layout);
    const tgt = resolveEndpoint(p.to, layout);
    const extras = {};
    if (src.port) {
      extras.exitX = src.port.x;
      extras.exitY = src.port.y;
      extras.exitDx = 0;
      extras.exitDy = 0;
    }
    if (tgt.port) {
      extras.entryX = tgt.port.x;
      extras.entryY = tgt.port.y;
      extras.entryDx = 0;
      extras.entryDy = 0;
    }
    const style = mergeStyle(layout.styles[p.style], extras);
    cells.push(
      edge({
        id: p.id,
        value: p.label || '',
        style,
        source: src.id,
        target: tgt.id,
        waypoints: p.waypoints || [],
      }),
    );
  }
  return cells;
}

function resolveEndpoint(ref, layout) {
  let ownerId;
  let owner;
  if (ref.component) {
    ownerId = ref.component;
    owner = layout.components[ownerId];
    // Tank ports are rendered as separate cells (small dots); rewire the
    // connection to the port cell so the pipe follows the dot, not the tank.
    if (
      ownerId === 'tank' &&
      (ref.port === 'dip_port' || ref.port === 'btm_port')
    ) {
      return { id: `${ownerId}_${ref.port}`, port: { x: 0.5, y: 0.5 } };
    }
  } else if (ref.valve) {
    ownerId = ref.valve;
    owner = layout.valves[ownerId];
  } else if (ref.manifold) {
    ownerId = ref.manifold;
    owner = layout.manifolds[ownerId];
  } else if (ref.sensor) {
    ownerId = ref.sensor;
    owner = layout.sensors[ownerId];
  } else {
    throw new Error(`bad pipe endpoint: ${JSON.stringify(ref)}`);
  }
  if (!owner) {
    throw new Error(`unknown pipe endpoint: ${JSON.stringify(ref)}`);
  }
  if (ref.port) {
    const port = (owner.ports || {})[ref.port];
    if (!port) {
      throw new Error(`port "${ref.port}" not defined on "${ownerId}"`);
    }
    return { id: ownerId, port };
  }
  return { id: ownerId, port: null };
}

// Legend: a framed box in the top-right with line/swatch/dot/ellipse rows.
// Items are declared in topology-layout.yaml under `legend.items`.
function legendCells(layout) {
  const L = layout.legend;
  if (!L) return [];
  const cells = [];
  const pos = L.position;
  cells.push(
    vertex({
      id: 'legend',
      value: 'Legend',
      style:
        'rounded=1;whiteSpace=wrap;html=1;fillColor=#111111;strokeColor=#444444;strokeWidth=1;fontColor=#cccccc;fontSize=12;fontStyle=1;verticalAlign=top;spacingTop=6;',
      x: pos.x,
      y: pos.y,
      w: pos.width,
      h: pos.height,
    }),
  );
  const rowH = 24;
  const rowStart = pos.y + 34;
  const iconX = pos.x + 16;
  const labelX = pos.x + 62;
  const labelW = pos.width - 70;
  L.items.forEach((item, i) => {
    const y = rowStart + i * rowH;
    const rowId = `legend_${i}`;
    if (item.type === 'line') {
      cells.push(
        edge({
          id: `${rowId}_line`,
          style: `endArrow=none;html=1;strokeColor=${item.color};strokeWidth=${
            item.width || 2
          };${item.dashed ? 'dashed=1;' : ''}`,
          sx: iconX,
          sy: y + 8,
          tx: iconX + 34,
          ty: y + 8,
        }),
      );
    } else if (item.type === 'swatch') {
      cells.push(
        vertex({
          id: `${rowId}_swatch`,
          value: '',
          style: `rounded=1;whiteSpace=wrap;html=1;fillColor=${item.fill};strokeColor=${item.stroke};strokeWidth=1.5;`,
          x: iconX,
          y: y,
          w: 34,
          h: 16,
        }),
      );
    } else if (item.type === 'dot') {
      cells.push(
        vertex({
          id: `${rowId}_dot`,
          value: '',
          style: `ellipse;whiteSpace=wrap;html=1;fillColor=${item.color};strokeColor=${item.color};`,
          x: iconX + 12,
          y: y + 3,
          w: 10,
          h: 10,
        }),
      );
    } else if (item.type === 'ellipse') {
      cells.push(
        vertex({
          id: `${rowId}_ell`,
          value: '',
          style: `ellipse;whiteSpace=wrap;html=1;fillColor=${item.fill};strokeColor=${item.stroke};strokeWidth=2;`,
          x: iconX + 4,
          y: y,
          w: 28,
          h: 22,
        }),
      );
    }
    cells.push(
      vertex({
        id: `${rowId}_label`,
        value: item.label,
        style: 'text;html=1;align=left;verticalAlign=middle;fontSize=10;fontColor=#aaaaaa;',
        x: labelX,
        y: y - 2,
        w: labelW,
        h: 20,
      }),
    );
  });
  return cells;
}

function wrapMxfile(cells, canvas) {
  const c = canvas || { width: 1600, height: 980, background: '#ffffff' };
  return (
    `<mxfile host="generate-topology.js" agent="greenhouse-solar-heater">\n` +
    `  <diagram id="system-topology" name="System Topology">\n` +
    `    <mxGraphModel dx="${c.width}" dy="${c.height}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${c.width}" pageHeight="${c.height}" math="0" shadow="0" background="${c.background}">\n` +
    `      <root>\n` +
    `        <mxCell id="0"/>\n` +
    `        <mxCell id="1" parent="0"/>\n` +
    cells.map((c) => '        ' + c).join('\n') +
    `\n      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>\n` +
    `</mxfile>\n`
  );
}

if (require.main === module) {
  main();
}

module.exports = { generateTopology };
