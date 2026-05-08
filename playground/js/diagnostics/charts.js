// SVG chart renderers for the diagnostics view. Hand-rolled because:
//   1. Mobile-optimised charting is explicitly a non-goal of issue #169
//      — these only need to be legible on a desktop card.
//   2. We already vendor zero charting libs and the playground
//      otherwise renders one canvas chart by hand (history-graph.js);
//      pulling in a chart library just for a tuning aid would bloat the
//      bundle and fail the asset-size gate.

import {
  SVG_NS, MODE_COLOURS, num, escapeHtml, formatShortLocal, startOfLocalDayKey,
  makeSvg, errorStats,
} from './format.js';

const CHART_W = 720;
const CHART_H = 220;
const CHART_PAD = { top: 12, right: 16, bottom: 32, left: 48 };

export function renderLineChart(containerId, rows, metric, title, unit, onPickGenerated) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const points = rows.map((r) => ({
    ts: new Date(r.for_hour).getTime(),
    pred: r.predicted ? num(r.predicted[metric]) : null,
    actual: r.actual ? num(r.actual[metric]) : null,
    generatedAt: r.generated_at,
  }));
  const svg = makeSvg(CHART_W, CHART_H, title);

  if (points.length === 0) {
    const txt = document.createElementNS(SVG_NS, 'text');
    txt.setAttribute('x', String(CHART_W / 2));
    txt.setAttribute('y', String(CHART_H / 2));
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('class', 'diag-chart-empty');
    txt.textContent = 'No data in selected range';
    svg.appendChild(txt);
    container.appendChild(svg);
    return;
  }

  const xs = points.map((p) => p.ts);
  const ys = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i].pred !== null) ys.push(points[i].pred);
    if (points[i].actual !== null) ys.push(points[i].actual);
  }
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yPad = 1;
  const yMin = (ys.length ? Math.min(...ys) : 0) - yPad;
  const yMax = (ys.length ? Math.max(...ys) : 1) + yPad;

  const xScale = (t) => CHART_PAD.left + (CHART_W - CHART_PAD.left - CHART_PAD.right) *
    ((t - xMin) / Math.max(1, (xMax - xMin)));
  const yScale = (v) => CHART_H - CHART_PAD.bottom - (CHART_H - CHART_PAD.top - CHART_PAD.bottom) *
    ((v - yMin) / Math.max(0.01, (yMax - yMin)));

  drawAxes(svg, xMin, xMax, yMin, yMax, unit);

  appendPolyline(svg, points, 'pred', xScale, yScale, {
    stroke: 'var(--primary)', dash: '5 4', width: 1.6, className: 'diag-line-pred',
  });
  appendPolyline(svg, points, 'actual', xScale, yScale, {
    stroke: 'var(--secondary)', dash: '', width: 1.8, className: 'diag-line-actual',
  });

  // Click-to-drill markers on each predicted point.
  if (typeof onPickGenerated === 'function') {
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.pred === null || !p.generatedAt) continue;
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(xScale(p.ts)));
      c.setAttribute('cy', String(yScale(p.pred)));
      c.setAttribute('r', '3');
      c.setAttribute('class', 'diag-pred-pt');
      c.setAttribute('data-generated-at', p.generatedAt);
      c.addEventListener('click', () => onPickGenerated(p.generatedAt));
      svg.appendChild(c);
    }
  }

  const titleEl = document.createElement('div');
  titleEl.className = 'diag-chart-title';
  titleEl.innerHTML = '<strong>' + escapeHtml(title) + '</strong>' +
    '<span class="diag-chart-legend">' +
      '<span class="diag-legend-pred">— predicted</span>' +
      '<span class="diag-legend-actual">— actual</span>' +
    '</span>';
  container.appendChild(titleEl);
  container.appendChild(svg);
}

function appendPolyline(svg, points, key, xScale, yScale, style) {
  // Break into segments at any null gap so the line doesn't bridge gaps.
  const segments = [];
  let cur = [];
  for (let i = 0; i < points.length; i++) {
    if (points[i][key] === null || !isFinite(points[i][key])) {
      if (cur.length > 0) { segments.push(cur); cur = []; }
    } else {
      cur.push(points[i]);
    }
  }
  if (cur.length > 0) segments.push(cur);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.length < 1) continue;
    const path = seg.map((p) => xScale(p.ts) + ',' + yScale(p[key])).join(' ');
    const el = document.createElementNS(SVG_NS, 'polyline');
    el.setAttribute('points', path);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', style.stroke);
    el.setAttribute('stroke-width', String(style.width));
    if (style.dash) el.setAttribute('stroke-dasharray', style.dash);
    if (style.className) el.setAttribute('class', style.className);
    svg.appendChild(el);
  }
}

function drawAxes(svg, xMin, xMax, yMin, yMax, unit) {
  const xa = document.createElementNS(SVG_NS, 'line');
  xa.setAttribute('x1', String(CHART_PAD.left));
  xa.setAttribute('y1', String(CHART_H - CHART_PAD.bottom));
  xa.setAttribute('x2', String(CHART_W - CHART_PAD.right));
  xa.setAttribute('y2', String(CHART_H - CHART_PAD.bottom));
  xa.setAttribute('stroke', 'var(--text-muted)');
  xa.setAttribute('stroke-width', '0.5');
  svg.appendChild(xa);

  const ya = document.createElementNS(SVG_NS, 'line');
  ya.setAttribute('x1', String(CHART_PAD.left));
  ya.setAttribute('y1', String(CHART_PAD.top));
  ya.setAttribute('x2', String(CHART_PAD.left));
  ya.setAttribute('y2', String(CHART_H - CHART_PAD.bottom));
  ya.setAttribute('stroke', 'var(--text-muted)');
  ya.setAttribute('stroke-width', '0.5');
  svg.appendChild(ya);

  for (let i = 0; i <= 4; i++) {
    const v = yMin + (yMax - yMin) * (i / 4);
    const y = CHART_H - CHART_PAD.bottom - (CHART_H - CHART_PAD.top - CHART_PAD.bottom) * (i / 4);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(CHART_PAD.left - 6));
    t.setAttribute('y', String(y + 3));
    t.setAttribute('text-anchor', 'end');
    t.setAttribute('class', 'diag-axis-label');
    t.textContent = v.toFixed(1) + (unit || '');
    svg.appendChild(t);
    const grid = document.createElementNS(SVG_NS, 'line');
    grid.setAttribute('x1', String(CHART_PAD.left));
    grid.setAttribute('y1', String(y));
    grid.setAttribute('x2', String(CHART_W - CHART_PAD.right));
    grid.setAttribute('y2', String(y));
    grid.setAttribute('stroke', 'var(--surface-container-highest)');
    grid.setAttribute('stroke-width', '0.5');
    svg.appendChild(grid);
  }

  const span = xMax - xMin || 1;
  for (let i = 0; i <= 4; i++) {
    const tx = xMin + (span * i / 4);
    const x = CHART_PAD.left + (CHART_W - CHART_PAD.left - CHART_PAD.right) * (i / 4);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(CHART_H - CHART_PAD.bottom + 14));
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('class', 'diag-axis-label');
    t.textContent = formatShortLocal(new Date(tx));
    svg.appendChild(t);
  }
}

export function renderModeRibbon(containerId, rows, onPickGenerated) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'diag-chart-empty';
    empty.textContent = 'No data';
    container.appendChild(empty);
    return;
  }
  const xs = rows.map((r) => new Date(r.for_hour).getTime());
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const svg = makeSvg(CHART_W, 56, 'mode classification');

  const w = CHART_W - CHART_PAD.left - CHART_PAD.right;
  const span = xMax - xMin || 1;
  for (let i = 0; i < rows.length; i++) {
    const t = new Date(rows[i].for_hour).getTime();
    const x = CHART_PAD.left + w * ((t - xMin) / span);
    const next = i + 1 < rows.length ? new Date(rows[i + 1].for_hour).getTime() : t + 3600000;
    const x2 = CHART_PAD.left + w * ((Math.min(next, xMax) - xMin) / span);
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', '8');
    rect.setAttribute('width', String(Math.max(1, x2 - x)));
    rect.setAttribute('height', '24');
    const mode = rows[i].predicted ? rows[i].predicted.mode : 'idle';
    rect.setAttribute('fill', MODE_COLOURS[mode] || 'var(--surface-container-highest)');
    rect.setAttribute('class', 'diag-mode-rect');
    rect.setAttribute('data-mode', mode);
    rect.setAttribute('data-generated-at', rows[i].generated_at);
    if (typeof onPickGenerated === 'function') {
      rect.addEventListener('click', () => onPickGenerated(rows[i].generated_at));
    }
    svg.appendChild(rect);
  }

  const modeKeys = Object.keys(MODE_COLOURS);
  for (let i = 0; i < modeKeys.length; i++) {
    const k = modeKeys[i];
    const lx = CHART_PAD.left + i * 110;
    if (lx > CHART_W - 110) break;
    const sw = document.createElementNS(SVG_NS, 'rect');
    sw.setAttribute('x', String(lx));
    sw.setAttribute('y', '40');
    sw.setAttribute('width', '10');
    sw.setAttribute('height', '10');
    sw.setAttribute('fill', MODE_COLOURS[k]);
    svg.appendChild(sw);
    const label = document.createElementNS(SVG_NS, 'text');
    label.setAttribute('x', String(lx + 14));
    label.setAttribute('y', '49');
    label.setAttribute('class', 'diag-axis-label');
    label.textContent = k;
    svg.appendChild(label);
  }
  container.appendChild(svg);
}

export function renderSolarGainBars(containerId, rows) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'diag-chart-empty';
    empty.textContent = 'No data';
    container.appendChild(empty);
    return;
  }
  // Sum predicted radiation per local day. The series payload carries
  // radiation_w_m2 (the engine input the prediction was based on), not
  // pred_solar_gain_kwh — that lives on the per-component drilldown.
  // Per-day radiation is a useful proxy for "what the algorithm thought
  // the solar resource would be" at this horizon.
  const byDay = {};
  for (let i = 0; i < rows.length; i++) {
    const day = startOfLocalDayKey(new Date(rows[i].for_hour));
    if (!byDay[day]) byDay[day] = 0;
    const rad = rows[i].predicted && rows[i].predicted.radiation_w_m2;
    if (typeof rad === 'number') byDay[day] += rad / 1000; // 1 W·1h/m² = 0.001 kWh/m²
  }
  const days = Object.keys(byDay).sort();
  if (days.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'diag-chart-empty';
    empty.textContent = 'No radiation forecast in selected rows';
    container.appendChild(empty);
    return;
  }
  const svg = makeSvg(CHART_W, 180, 'per-day solar gain');
  const maxV = Math.max.apply(null, days.map((d) => byDay[d])) || 1;
  const w = CHART_W - CHART_PAD.left - CHART_PAD.right;
  const barW = Math.max(8, Math.floor(w / Math.max(days.length, 1)) - 4);

  for (let i = 0; i < days.length; i++) {
    const v = byDay[days[i]];
    const x = CHART_PAD.left + i * (w / days.length);
    const h = (180 - CHART_PAD.top - CHART_PAD.bottom) * (v / maxV);
    const y = 180 - CHART_PAD.bottom - h;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW));
    rect.setAttribute('height', String(h));
    rect.setAttribute('fill', 'var(--primary)');
    svg.appendChild(rect);
    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.setAttribute('x', String(x + barW / 2));
    lbl.setAttribute('y', String(180 - CHART_PAD.bottom + 14));
    lbl.setAttribute('text-anchor', 'middle');
    lbl.setAttribute('class', 'diag-axis-label');
    lbl.textContent = days[i].slice(5);
    svg.appendChild(lbl);
    const val = document.createElementNS(SVG_NS, 'text');
    val.setAttribute('x', String(x + barW / 2));
    val.setAttribute('y', String(y - 4));
    val.setAttribute('text-anchor', 'middle');
    val.setAttribute('class', 'diag-axis-label');
    val.textContent = v.toFixed(2);
    svg.appendChild(val);
  }
  container.appendChild(svg);
}

export function renderErrorSummary(containerId, rows, metric, label) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const stats = errorStats(rows, metric);
  if (!stats) {
    el.textContent = label + ': no overlapping predicted/actual pairs.';
    return;
  }
  el.innerHTML =
    '<strong>' + escapeHtml(label) + ' error</strong> over ' + stats.n + ' pair' + (stats.n === 1 ? '' : 's') + ': ' +
    'mean ' + stats.mean.toFixed(2) + '°, ' +
    'mean abs ' + stats.meanAbs.toFixed(2) + '°, ' +
    'RMSE ' + stats.rmse.toFixed(2) + '°, ' +
    'max ' + stats.max.toFixed(2) + '°';
}
