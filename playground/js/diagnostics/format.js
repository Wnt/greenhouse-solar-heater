// Shared formatters + small helpers used across the diagnostics view.
// Pulled out of the main view module to keep that file under the
// per-source line cap and to make the tiny pure functions trivially
// unit-testable in isolation.

export const SVG_NS = 'http://www.w3.org/2000/svg';

// Mode → colour. Mirrors the legend the history graph uses so a tuning
// view side-by-side with the live graph reads consistently.
export const MODE_COLOURS = {
  idle:                'var(--surface-container-highest)',
  solar_charging:      'var(--primary)',
  greenhouse_heating:  'var(--secondary)',
  emergency_heating:   '#e57373',
  active_drain:        '#7e57c2',
  overheat_drain:      '#ff7043',
};

export function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

export function fmt(v, dp) {
  const n = num(v);
  if (n === null) return '—';
  return n.toFixed(dp);
}

export function formatCoeff(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 0.001)
    ? v.toExponential(3) : v.toFixed(4);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function formatLocal(d) {
  try {
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: 'Europe/Helsinki',
    });
  } catch (_e) { return d.toISOString(); }
}

export function formatShortLocal(d) {
  try {
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
      hour12: false, timeZone: 'Europe/Helsinki',
    });
  } catch (_e) { return d.toISOString(); }
}

// YYYY-MM-DD in Europe/Helsinki — used as the bucket key for the
// per-day solar gain bars.
export function startOfLocalDayKey(d) {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'Europe/Helsinki',
  }).format(d);
}

// Predicted-vs-actual error stats per metric. Used by the line-chart
// summary subtitle and exported standalone for unit testing.
export function errorStats(rows, metric) {
  let sum = 0, sumAbs = 0, sumSq = 0, max = 0, n = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const p = r && r.predicted ? num(r.predicted[metric]) : null;
    const a = r && r.actual    ? num(r.actual[metric])    : null;
    if (p === null || a === null) continue;
    const d = p - a;
    sum += d; sumAbs += Math.abs(d); sumSq += d * d;
    if (Math.abs(d) > max) max = Math.abs(d);
    n += 1;
  }
  if (n === 0) return null;
  return {
    n,
    mean:    sum    / n,
    meanAbs: sumAbs / n,
    rmse:    Math.sqrt(sumSq / n),
    max,
  };
}

export function makeSvg(w, h, ariaLabel) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(h));
  if (ariaLabel) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', ariaLabel);
  }
  return svg;
}
