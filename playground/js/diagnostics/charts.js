// SVG chart renderers for the diagnostics view. Hand-rolled so the
// playground stays free of charting deps (would blow the asset gate
// just for a tuning aid). Each chart adapts its height + padding to
// the viewport so 3 line charts fit on a phone, and all line charts
// share a synced cursor via `inspector.js` — long-press on one chart
// drives the other two.
//
// Layout: SVGs use viewBox + width=100% so they scale horizontally;
// the explicit height attribute is set per-render based on viewport.
// On any resize the diagnostics view re-renders (see diagnostics-view.js).
//
// Pointer model: a transparent overlay rect on each line chart owns
// pointer events. The inspector module distinguishes a short tap
// (→ drill into nearest generation) from a long press / drag-scrub
// (→ activate synced cursor). Per-circle click handlers were removed —
// 3-px hit targets aren't usable on touch.

import {
  SVG_NS, MODE_COLOURS, num, escapeHtml, formatShortLocal, startOfLocalDayKey,
  makeSvg, errorStats,
} from './format.js';
import { subscribeCursor, attachInspectorPointer } from './inspector.js';

const CHART_W = 720;

// Viewport-adaptive dimensions. Mobile keeps the same viewBox width so
// all charts share the same x-coordinate system (the synced cursor
// just needs the timestamp domain to match), but reduces height +
// trims padding so three line charts fit on a Samsung S25 Ultra
// (412 × 883 CSS px).
function chartGeometry() {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 640;
  if (isMobile) {
    return {
      width:  CHART_W,
      height: 130,
      pad: { top: 6, right: 8, bottom: 20, left: 34 },
    };
  }
  return {
    width:  CHART_W,
    height: 220,
    pad: { top: 12, right: 16, bottom: 32, left: 48 },
  };
}

export function renderLineChart(containerId, rows, metric, title, unit, onPickGenerated) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';
  const { width: W, height: H, pad: P } = chartGeometry();
  const points = rows.map((r) => ({
    ts: new Date(r.for_hour).getTime(),
    pred: r.predicted ? num(r.predicted[metric]) : null,
    actual: r.actual ? num(r.actual[metric]) : null,
    generatedAt: r.generated_at,
  }));
  const svg = makeSvg(W, H, title);

  if (points.length === 0) {
    const txt = document.createElementNS(SVG_NS, 'text');
    txt.setAttribute('x', String(W / 2));
    txt.setAttribute('y', String(H / 2));
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

  const xScale = (t) => P.left + (W - P.left - P.right) *
    ((t - xMin) / Math.max(1, (xMax - xMin)));
  const yScale = (v) => H - P.bottom - (H - P.top - P.bottom) *
    ((v - yMin) / Math.max(0.01, (yMax - yMin)));
  const xUnscale = (svgX) => xMin
    + ((svgX - P.left) / Math.max(1, (W - P.left - P.right))) * (xMax - xMin);

  drawAxes(svg, W, H, P, xMin, xMax, yMin, yMax, unit);

  appendPolyline(svg, points, 'pred', xScale, yScale, {
    stroke: 'var(--primary)', dash: '5 4', width: 1.6, className: 'diag-line-pred',
  });
  appendPolyline(svg, points, 'actual', xScale, yScale, {
    stroke: 'var(--secondary)', dash: '', width: 1.8, className: 'diag-line-actual',
  });

  const titleEl = document.createElement('div');
  titleEl.className = 'diag-chart-title';
  // Compact stats inline with the title — visible on mobile (where
  // the standalone .diag-error-summary above the chart is hidden) and
  // unobtrusive on desktop. Mirrors the data the larger summary uses.
  const stats = errorStats(rows, metric);
  const statsHtml = stats
    ? '<span class="diag-chart-stats">μ ' + stats.mean.toFixed(1) + '°  ' +
        '|μ| ' + stats.meanAbs.toFixed(1) + '°  max ' + stats.max.toFixed(1) + '°</span>'
    : '<span class="diag-chart-stats">—</span>';
  titleEl.innerHTML = '<strong>' + escapeHtml(title) + '</strong>' +
    statsHtml +
    '<span class="diag-chart-legend">' +
      '<span class="diag-legend-pred">— predicted</span>' +
      '<span class="diag-legend-actual">— actual</span>' +
    '</span>';
  container.appendChild(titleEl);
  container.appendChild(svg);

  // Inspector cursor: a vertical line + value tooltip in a group that
  // is shown / hidden based on the shared cursor state.
  const cursor = createCursorGroup(svg, points, metric, xScale, yScale,
    P, W, H, unit);

  const unsubscribe = subscribeCursor(function (ts) {
    if (ts === null || ts < xMin || ts > xMax) {
      cursor.hide();
      return;
    }
    cursor.show(ts);
  });
  // Stash the unsubscribe on the SVG element so the next render (which
  // wipes container.innerHTML) drops it after detach. Done via a
  // MutationObserver on the container's parent would be heavier; the
  // simpler pattern: the diagnostics view re-renders the whole chart
  // tree every refresh, so subscribers tied to old SVGs become inert
  // once their cursor group has no parent. We unsubscribe explicitly
  // when the SVG leaves the DOM — done by the caller via destroyChart.
  svg._diagCursorUnsubscribe = unsubscribe;

  // Pointer overlay for tap + long-press scrub. Sized to the chart's
  // plot area only so taps outside don't fire. Always attached — even
  // without `onPickGenerated` the overlay still drives the synced
  // cursor for the drilldown trajectory charts.
  {
    const overlay = document.createElementNS(SVG_NS, 'rect');
    overlay.setAttribute('x', String(P.left));
    overlay.setAttribute('y', String(P.top));
    overlay.setAttribute('width', String(W - P.left - P.right));
    overlay.setAttribute('height', String(H - P.top - P.bottom));
    overlay.setAttribute('fill', 'transparent');
    overlay.setAttribute('class', 'diag-pointer-overlay');
    // touch-action: none lets us preventDefault on move while scrubbing
    // without the browser hijacking for pan-zoom. Set as inline style
    // so the rule travels with the element.
    overlay.style.touchAction = 'none';
    svg.appendChild(overlay);

    const detachPointer = attachInspectorPointer({
      svg,
      svgRect: overlay,
      getTsAtX: function (svgX) {
        const t = xUnscale(svgX);
        return Math.max(xMin, Math.min(xMax, t));
      },
      nearestPointAtX: function (svgX) {
        let best = null, bestD = Infinity;
        for (let i = 0; i < points.length; i++) {
          if (points[i].pred === null || !points[i].generatedAt) continue;
          const d = Math.abs(xScale(points[i].ts) - svgX);
          if (d < bestD) { bestD = d; best = points[i]; }
        }
        return best;
      },
      onTap: typeof onPickGenerated === 'function' ? onPickGenerated : null,
    });
    svg._diagPointerDetach = detachPointer;
  }
}

function createCursorGroup(svg, points, metric, xScale, yScale, P, W, H, unit) {
  const g = document.createElementNS(SVG_NS, 'g');
  g.setAttribute('class', 'diag-cursor-group');
  g.style.display = 'none';
  g.setAttribute('pointer-events', 'none');

  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('y1', String(P.top));
  line.setAttribute('y2', String(H - P.bottom));
  line.setAttribute('class', 'diag-cursor-line');
  g.appendChild(line);

  // Value markers (one per series). Hidden when value is null.
  const dotPred   = createDot('diag-cursor-dot diag-cursor-dot-pred');
  const dotActual = createDot('diag-cursor-dot diag-cursor-dot-actual');
  g.appendChild(dotPred);
  g.appendChild(dotActual);

  // Tooltip: a pill positioned near the top of the chart that shows
  // the predicted + actual value at the cursor's nearest point.
  const tipBg = document.createElementNS(SVG_NS, 'rect');
  tipBg.setAttribute('class', 'diag-cursor-tip-bg');
  tipBg.setAttribute('rx', '4');
  tipBg.setAttribute('ry', '4');
  const tipText = document.createElementNS(SVG_NS, 'text');
  tipText.setAttribute('class', 'diag-cursor-tip-text');
  g.appendChild(tipBg);
  g.appendChild(tipText);

  svg.appendChild(g);

  function nearest(ts) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(points[i].ts - ts);
      if (d < bestD) { bestD = d; best = points[i]; }
    }
    return best;
  }

  return {
    show: function (ts) {
      const x = xScale(ts);
      line.setAttribute('x1', String(x));
      line.setAttribute('x2', String(x));
      const np = nearest(ts);
      const txt = unit || '°C';
      const pStr = (np && np.pred !== null) ? np.pred.toFixed(1) + txt : '—';
      const aStr = (np && np.actual !== null) ? np.actual.toFixed(1) + txt : '—';
      if (np && np.pred !== null) {
        dotPred.setAttribute('cx', String(xScale(np.ts)));
        dotPred.setAttribute('cy', String(yScale(np.pred)));
        dotPred.style.display = '';
      } else { dotPred.style.display = 'none'; }
      if (np && np.actual !== null) {
        dotActual.setAttribute('cx', String(xScale(np.ts)));
        dotActual.setAttribute('cy', String(yScale(np.actual)));
        dotActual.style.display = '';
      } else { dotActual.style.display = 'none'; }
      const label = 'p ' + pStr + '  a ' + aStr;
      tipText.textContent = label;
      // Position pill: clamp inside chart area so it never spills off.
      const approxW = label.length * 6 + 12;
      const tipX = Math.max(P.left + 4,
        Math.min(W - P.right - approxW - 4, x - approxW / 2));
      tipText.setAttribute('x', String(tipX + 6));
      tipText.setAttribute('y', String(P.top + 12));
      tipBg.setAttribute('x', String(tipX));
      tipBg.setAttribute('y', String(P.top + 1));
      tipBg.setAttribute('width', String(approxW));
      tipBg.setAttribute('height', '16');
      g.style.display = '';
    },
    hide: function () { g.style.display = 'none'; },
  };
}

function createDot(className) {
  const c = document.createElementNS(SVG_NS, 'circle');
  c.setAttribute('r', '3.5');
  c.setAttribute('class', className);
  c.style.display = 'none';
  return c;
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

function drawAxes(svg, W, H, P, xMin, xMax, yMin, yMax, unit) {
  const xa = document.createElementNS(SVG_NS, 'line');
  xa.setAttribute('x1', String(P.left));
  xa.setAttribute('y1', String(H - P.bottom));
  xa.setAttribute('x2', String(W - P.right));
  xa.setAttribute('y2', String(H - P.bottom));
  xa.setAttribute('stroke', 'var(--text-muted)');
  xa.setAttribute('stroke-width', '0.5');
  svg.appendChild(xa);

  const ya = document.createElementNS(SVG_NS, 'line');
  ya.setAttribute('x1', String(P.left));
  ya.setAttribute('y1', String(P.top));
  ya.setAttribute('x2', String(P.left));
  ya.setAttribute('y2', String(H - P.bottom));
  ya.setAttribute('stroke', 'var(--text-muted)');
  ya.setAttribute('stroke-width', '0.5');
  svg.appendChild(ya);

  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const v = yMin + (yMax - yMin) * (i / yTicks);
    const y = H - P.bottom - (H - P.top - P.bottom) * (i / yTicks);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(P.left - 4));
    t.setAttribute('y', String(y + 3));
    t.setAttribute('text-anchor', 'end');
    t.setAttribute('class', 'diag-axis-label');
    t.textContent = v.toFixed(1) + (unit || '');
    svg.appendChild(t);
    const grid = document.createElementNS(SVG_NS, 'line');
    grid.setAttribute('x1', String(P.left));
    grid.setAttribute('y1', String(y));
    grid.setAttribute('x2', String(W - P.right));
    grid.setAttribute('y2', String(y));
    grid.setAttribute('stroke', 'var(--surface-container-highest)');
    grid.setAttribute('stroke-width', '0.5');
    svg.appendChild(grid);
  }

  const xTicks = (W - P.left - P.right) < 500 ? 3 : 4;
  const span = xMax - xMin || 1;
  for (let i = 0; i <= xTicks; i++) {
    const tx = xMin + (span * i / xTicks);
    const x = P.left + (W - P.left - P.right) * (i / xTicks);
    const t = document.createElementNS(SVG_NS, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(H - P.bottom + 14));
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
  const { width: W, pad: P } = chartGeometry();
  const xs = rows.map((r) => new Date(r.for_hour).getTime());
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const ribbonH = 56;
  const svg = makeSvg(W, ribbonH, 'mode classification');

  const w = W - P.left - P.right;
  const span = xMax - xMin || 1;
  for (let i = 0; i < rows.length; i++) {
    const t = new Date(rows[i].for_hour).getTime();
    const x = P.left + w * ((t - xMin) / span);
    const next = i + 1 < rows.length ? new Date(rows[i + 1].for_hour).getTime() : t + 3600000;
    const x2 = P.left + w * ((Math.min(next, xMax) - xMin) / span);
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
  const legendStep = (W - P.left - P.right) < 500 ? 86 : 110;
  for (let i = 0; i < modeKeys.length; i++) {
    const k = modeKeys[i];
    const lx = P.left + i * legendStep;
    if (lx > W - legendStep) break;
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

  // Synced cursor line on the ribbon too — useful when scrubbing to
  // see what mode the engine predicted at the inspected timestamp.
  const cursorLine = document.createElementNS(SVG_NS, 'line');
  cursorLine.setAttribute('y1', '4');
  cursorLine.setAttribute('y2', '36');
  cursorLine.setAttribute('class', 'diag-cursor-line');
  cursorLine.setAttribute('pointer-events', 'none');
  cursorLine.style.display = 'none';
  svg.appendChild(cursorLine);
  const xScale = (t) => P.left + w * ((t - xMin) / span);
  svg._diagCursorUnsubscribe = subscribeCursor(function (ts) {
    if (ts === null || ts < xMin || ts > xMax) {
      cursorLine.style.display = 'none';
      return;
    }
    const x = xScale(ts);
    cursorLine.setAttribute('x1', String(x));
    cursorLine.setAttribute('x2', String(x));
    cursorLine.style.display = '';
  });

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
  const { width: W, pad: P } = chartGeometry();
  const barsH = 180;
  const svg = makeSvg(W, barsH, 'per-day solar gain');
  const maxV = Math.max.apply(null, days.map((d) => byDay[d])) || 1;
  const w = W - P.left - P.right;
  const barW = Math.max(8, Math.floor(w / Math.max(days.length, 1)) - 4);

  for (let i = 0; i < days.length; i++) {
    const v = byDay[days[i]];
    const x = P.left + i * (w / days.length);
    const h = (barsH - P.top - P.bottom) * (v / maxV);
    const y = barsH - P.bottom - h;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
    rect.setAttribute('width', String(barW));
    rect.setAttribute('height', String(h));
    rect.setAttribute('fill', 'var(--primary)');
    svg.appendChild(rect);
    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.setAttribute('x', String(x + barW / 2));
    lbl.setAttribute('y', String(barsH - P.bottom + 14));
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
