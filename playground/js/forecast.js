// Next-48-h forecast card on the Status view.
//
// External API:
//   initForecastCard()  — called from the app init path; registers the sync
//     source and inserts the card DOM above the energy-balance card.
//   renderForecastCard(data)  — exported for testability; mutates the existing
//     card DOM with a fresh API response.
//
// The card is always inserted during init (so nothing jumps when data arrives).
// Re-renders mutate the existing nodes; the card is never destroyed and
// re-created.

import { store } from './app-state.js';
import { registerDataSource } from './sync/registry.js';

// Heating floor used in the sparkline floor-line. Align with the
// greenhouse-heating entry threshold in control-logic.js (12 °C is the
// exit condition there; 10 °C is the trigger — 12 is the more visible
// threshold to show "where backup kicks in" on the chart).
const TANK_FLOOR_C = 12;

// Module-level state: last successful fetch result + expanded flag.
let _lastData = null;
let _expanded = false;

// ── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// ── Number formatters ────────────────────────────────────────────────────────

function fmtHours(h) {
  if (h === null || h === undefined) return '48+ h';
  const rounded = Math.round(h * 2) / 2; // round to 0.5
  return '~' + rounded + ' h';
}

function fmtKwh(v) {
  if (v === null || v === undefined || typeof v !== 'number') return '— kWh';
  return (Math.round(v * 10) / 10).toFixed(1) + ' kWh';
}

function fmtEur(v) {
  if (v === null || v === undefined || typeof v !== 'number') return '—';
  return '€' + v.toFixed(2);
}

// ── Sparkline SVG ────────────────────────────────────────────────────────────

function buildSparkline(trajectory) {
  const W = 140, H = 30;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('width', W);
  svg.setAttribute('height', H);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('forecast-sparkline');

  if (!Array.isArray(trajectory) || trajectory.length < 2) {
    return svg;
  }

  const vals = trajectory.map(p => (typeof p.avg === 'number' ? p.avg : ((p.top + p.bottom) / 2)));
  const minV = Math.min(...vals, TANK_FLOOR_C - 2);
  const maxV = Math.max(...vals, TANK_FLOOR_C + 2);
  const range = maxV - minV || 1;
  const n = vals.length;

  function xOf(i) { return (i / (n - 1)) * W; }
  function yOf(v) { return H - ((v - minV) / range) * H; }

  // Floor line
  const floorY = yOf(TANK_FLOOR_C);
  const floorLine = document.createElementNS(ns, 'line');
  floorLine.setAttribute('x1', '0');
  floorLine.setAttribute('y1', String(floorY));
  floorLine.setAttribute('x2', String(W));
  floorLine.setAttribute('y2', String(floorY));
  floorLine.setAttribute('stroke', 'rgba(238,125,119,0.35)');
  floorLine.setAttribute('stroke-width', '1');
  floorLine.setAttribute('stroke-dasharray', '3 3');
  svg.appendChild(floorLine);

  // Polyline
  const points = vals.map((v, i) => xOf(i).toFixed(1) + ',' + yOf(v).toFixed(1)).join(' ');
  const poly = document.createElementNS(ns, 'polyline');
  poly.setAttribute('points', points);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#43aea4');
  poly.setAttribute('stroke-width', '1.5');
  poly.setAttribute('stroke-linejoin', 'round');
  poly.setAttribute('stroke-linecap', 'round');
  svg.appendChild(poly);

  return svg;
}

// ── Expanded SVG chart ───────────────────────────────────────────────────────

function buildExpandedChart(data) {
  const W = 320, H = 140, PAD = { top: 8, right: 52, bottom: 24, left: 8 };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('width', '100%');
  svg.setAttribute('style', 'max-width:' + W + 'px;display:block;');
  svg.setAttribute('aria-label', '48-hour forecast chart');
  svg.classList.add('forecast-chart');

  const fc = data.forecast || {};
  const trajectory = Array.isArray(fc.tankTrajectory) ? fc.tankTrajectory : [];
  const weather = Array.isArray(data.weather) ? data.weather : [];
  const prices = Array.isArray(data.prices) ? data.prices : [];
  const costHours = Array.isArray(fc.costBreakdown) ? fc.costBreakdown : [];

  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  // Temperature range (primary Y axis)
  const tankVals = trajectory.map(p => typeof p.avg === 'number' ? p.avg : (p.top + p.bottom) / 2);
  const outdoorVals = weather.map(p => typeof p.temperature === 'number' ? p.temperature : null).filter(v => v !== null);
  const allTempVals = tankVals.concat(outdoorVals).concat([TANK_FLOOR_C]);
  const minTemp = Math.min(...allTempVals) - 2;
  const maxTemp = Math.max(...allTempVals) + 2;
  const tempRange = maxTemp - minTemp || 1;

  // Price range (secondary Y axis)
  const priceVals = prices.map(p => typeof p.priceCKwh === 'number' ? p.priceCKwh : null).filter(v => v !== null);
  const minPrice = priceVals.length ? Math.min(...priceVals) : 0;
  const maxPrice = priceVals.length ? Math.max(...priceVals) : 30;
  const priceRange = maxPrice - minPrice || 1;

  const n = trajectory.length;
  const nW = weather.length;
  const nP = prices.length;

  function xT(i, total) { return PAD.left + (i / Math.max(total - 1, 1)) * chartW; }
  function yTemp(v) { return PAD.top + chartH - ((v - minTemp) / tempRange) * chartH; }
  function yPrice(v) { return PAD.top + chartH - ((v - minPrice) / priceRange) * chartH; }

  // Floor line
  if (n > 0) {
    const fy = yTemp(TANK_FLOOR_C);
    const fl = document.createElementNS(ns, 'line');
    fl.setAttribute('x1', String(PAD.left)); fl.setAttribute('y1', String(fy));
    fl.setAttribute('x2', String(PAD.left + chartW)); fl.setAttribute('y2', String(fy));
    fl.setAttribute('stroke', 'rgba(238,125,119,0.3)'); fl.setAttribute('stroke-width', '1');
    fl.setAttribute('stroke-dasharray', '4 3');
    svg.appendChild(fl);
  }

  // Tank avg filled area
  if (n >= 2) {
    const pts = tankVals.map((v, i) => xT(i, n).toFixed(1) + ',' + yTemp(v).toFixed(1));
    const areaBase = yTemp(Math.max(minTemp, TANK_FLOOR_C - 5));
    const areaPath = 'M ' + pts[0] + ' L ' + pts.join(' L ') +
      ' L ' + xT(n - 1, n).toFixed(1) + ',' + areaBase +
      ' L ' + PAD.left.toFixed(1) + ',' + areaBase + ' Z';
    const area = document.createElementNS(ns, 'path');
    area.setAttribute('d', areaPath);
    area.setAttribute('fill', 'rgba(67,174,164,0.18)');
    svg.appendChild(area);

    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', '#43aea4');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(line);
  }

  // Outdoor temp (thin grey line)
  if (nW >= 2) {
    const pts = weather.map((p, i) => {
      if (typeof p.temperature !== 'number') return null;
      return xT(i, nW).toFixed(1) + ',' + yTemp(p.temperature).toFixed(1);
    }).filter(Boolean);
    if (pts.length >= 2) {
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', pts.join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', '#42a5f5');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('opacity', '0.7');
      svg.appendChild(line);
    }
  }

  // Spot price (secondary axis, right side)
  if (nP >= 2) {
    let solidPts = [], dashedPts = [];
    for (let i = 0; i < nP; i++) {
      const p = prices[i];
      if (typeof p.priceCKwh !== 'number') { solidPts = []; dashedPts = []; continue; }
      const pt = xT(i, nP).toFixed(1) + ',' + yPrice(p.priceCKwh).toFixed(1);
      if (p.source === 'sahkotin') {
        solidPts.push(pt);
        if (dashedPts.length >= 2) {
          const pl = document.createElementNS(ns, 'polyline');
          pl.setAttribute('points', dashedPts.join(' '));
          pl.setAttribute('fill', 'none');
          pl.setAttribute('stroke', '#f0a82a');
          pl.setAttribute('stroke-width', '1');
          pl.setAttribute('stroke-dasharray', '4 3');
          pl.setAttribute('opacity', '0.7');
          svg.appendChild(pl);
          dashedPts = [];
        }
      } else {
        dashedPts.push(pt);
        if (solidPts.length >= 2) {
          const pl = document.createElementNS(ns, 'polyline');
          pl.setAttribute('points', solidPts.join(' '));
          pl.setAttribute('fill', 'none');
          pl.setAttribute('stroke', '#f0a82a');
          pl.setAttribute('stroke-width', '1');
          pl.setAttribute('opacity', '0.8');
          svg.appendChild(pl);
          solidPts = [];
        }
      }
    }
    if (solidPts.length >= 2) {
      const pl = document.createElementNS(ns, 'polyline');
      pl.setAttribute('points', solidPts.join(' '));
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', '#f0a82a');
      pl.setAttribute('stroke-width', '1');
      pl.setAttribute('opacity', '0.8');
      svg.appendChild(pl);
    }
    if (dashedPts.length >= 2) {
      const pl = document.createElementNS(ns, 'polyline');
      pl.setAttribute('points', dashedPts.join(' '));
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', '#f0a82a');
      pl.setAttribute('stroke-width', '1');
      pl.setAttribute('stroke-dasharray', '4 3');
      pl.setAttribute('opacity', '0.7');
      svg.appendChild(pl);
    }
  }

  // Backup-heater hour ticks (red marks at bottom)
  const tickH = 4;
  const tickY = PAD.top + chartH + 2;
  const total48 = Math.max(n, nW, 48);
  for (const c of costHours) {
    const ts = c.ts ? new Date(c.ts).getTime() : null;
    if (!ts || !trajectory.length) continue;
    const t0 = new Date(trajectory[0].ts).getTime();
    const tN = new Date(trajectory[trajectory.length - 1].ts).getTime();
    const tRange = tN - t0 || 1;
    const x = PAD.left + ((ts - t0) / tRange) * chartW;
    if (x < PAD.left || x > PAD.left + chartW) continue;
    const tick = document.createElementNS(ns, 'rect');
    tick.setAttribute('x', String(x - 1));
    tick.setAttribute('y', String(tickY));
    tick.setAttribute('width', '2');
    tick.setAttribute('height', String(tickH));
    tick.setAttribute('fill', '#ee7d77');
    svg.appendChild(tick);
  }

  // Right-axis label (price c/kWh)
  if (priceVals.length) {
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', String(W - 2));
    label.setAttribute('y', String(PAD.top + chartH / 2));
    label.setAttribute('fill', 'rgba(240,168,42,0.7)');
    label.setAttribute('font-size', '8');
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('dominant-baseline', 'middle');
    label.textContent = 'c/kWh';
    svg.appendChild(label);
  }

  void total48; // suppress lint on unused local

  return svg;
}

// ── Card DOM structure ───────────────────────────────────────────────────────

function createCardDom() {
  const card = el('div', 'card bento-span-3 forecast-card');
  card.id = 'forecast-card';

  // Header row
  const header = el('div', 'forecast-card-header');
  const title = el('h3', 'forecast-title', 'Next 48 h');
  header.appendChild(title);
  card.appendChild(header);

  // Headline stats
  const stats = el('div', 'forecast-stats');
  stats.id = 'forecast-stats';

  const s1 = el('div', 'forecast-stat');
  s1.innerHTML = '<span class="forecast-stat-label">Tank lasts</span>' +
    '<div class="forecast-stat-value" id="forecast-val-hours">—</div>';
  const s2 = el('div', 'forecast-stat');
  s2.innerHTML = '<span class="forecast-stat-label">Backup heat</span>' +
    '<div class="forecast-stat-value" id="forecast-val-kwh">—</div>';
  const s3 = el('div', 'forecast-stat');
  s3.innerHTML = '<span class="forecast-stat-label">Backup cost</span>' +
    '<div class="forecast-stat-value" id="forecast-val-eur">—</div>';
  stats.appendChild(s1);
  stats.appendChild(s2);
  stats.appendChild(s3);
  card.appendChild(stats);

  // Sparkline placeholder
  const sparkWrap = el('div', 'forecast-sparkline-wrap');
  sparkWrap.id = 'forecast-sparkline-wrap';
  card.appendChild(sparkWrap);

  // Notes
  const notes = el('div', 'forecast-notes');
  notes.id = 'forecast-notes';
  card.appendChild(notes);

  // Expand/collapse toggle
  const toggle = el('button', 'forecast-expand-btn');
  toggle.id = 'forecast-expand-btn';
  toggle.setAttribute('type', 'button');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = 'tap to expand ▾';
  card.appendChild(toggle);

  // Expanded chart container (hidden until toggled)
  const chartWrap = el('div', 'forecast-chart-wrap');
  chartWrap.id = 'forecast-chart-wrap';
  chartWrap.hidden = true;
  card.appendChild(chartWrap);

  // Expand/collapse handler
  toggle.addEventListener('click', function () {
    _expanded = !_expanded;
    toggle.setAttribute('aria-expanded', String(_expanded));
    toggle.textContent = _expanded ? 'tap to collapse ▴' : 'tap to expand ▾';
    chartWrap.hidden = !_expanded;
    if (_expanded && _lastData) {
      _renderChart(chartWrap, _lastData);
    }
  });

  return card;
}

function _renderChart(wrap, data) {
  wrap.innerHTML = '';
  wrap.appendChild(buildExpandedChart(data));
}

// ── Public render ────────────────────────────────────────────────────────────

export function renderForecastCard(data) {
  const card = document.getElementById('forecast-card');
  if (!card) return;

  _lastData = data;

  const fc = (data && data.forecast) ? data.forecast : null;

  // Headline values
  const elHours = document.getElementById('forecast-val-hours');
  const elKwh   = document.getElementById('forecast-val-kwh');
  const elEur   = document.getElementById('forecast-val-eur');

  // "Tank lasts" = until the tank can no longer cover the greenhouse heating
  // load (avg drops below floor + 5°C). That's the operationally meaningful
  // moment — the floor itself (12°C) is where stored heat is exhausted. Fall
  // back to hoursUntilFloor for older API responses without the new field.
  const lastsH = fc
    ? (fc.hoursUntilBackupNeeded !== undefined && fc.hoursUntilBackupNeeded !== null
        ? fc.hoursUntilBackupNeeded
        : fc.hoursUntilFloor)
    : null;
  if (elHours) elHours.textContent = fc ? fmtHours(lastsH) : '—';
  if (elKwh)   elKwh.textContent   = fc ? fmtKwh(fc.electricKwh)       : '—';
  if (elEur)   elEur.textContent   = fc ? fmtEur(fc.electricCostEur)   : '—';

  // Sparkline
  const sparkWrap = document.getElementById('forecast-sparkline-wrap');
  if (sparkWrap) {
    sparkWrap.innerHTML = '';
    if (fc && Array.isArray(fc.tankTrajectory) && fc.tankTrajectory.length >= 2) {
      sparkWrap.appendChild(buildSparkline(fc.tankTrajectory));
    }
  }

  // Notes — low-confidence warning + notes array
  const notesEl = document.getElementById('forecast-notes');
  if (notesEl) {
    notesEl.innerHTML = '';
    if (fc) {
      if (fc.modelConfidence === 'low') {
        const warn = el('p', 'forecast-note forecast-note-warn',
          '⚠ Forecast model still warming up — limited history.');
        notesEl.appendChild(warn);
      }
      const arr = Array.isArray(fc.notes) ? fc.notes : [];
      for (const note of arr) {
        const p = el('p', 'forecast-note', note);
        notesEl.appendChild(p);
      }
    }
  }

  // If already expanded, refresh the chart
  const chartWrap = document.getElementById('forecast-chart-wrap');
  if (chartWrap && _expanded && fc) {
    _renderChart(chartWrap, data);
  }

  // Clear any loading/error state
  card.classList.remove('forecast-card-error', 'forecast-card-loading');
}

function _showLoading() {
  const card = document.getElementById('forecast-card');
  if (!card) return;
  card.classList.add('forecast-card-loading');
  card.classList.remove('forecast-card-error');
  const elHours = document.getElementById('forecast-val-hours');
  const elKwh   = document.getElementById('forecast-val-kwh');
  const elEur   = document.getElementById('forecast-val-eur');
  if (elHours) elHours.textContent = '—';
  if (elKwh)   elKwh.textContent   = '—';
  if (elEur)   elEur.textContent   = '—';
  const sparkWrap = document.getElementById('forecast-sparkline-wrap');
  if (sparkWrap) sparkWrap.innerHTML = '<span class="forecast-loading-text">Loading next-48 h forecast…</span>';
  const notes = document.getElementById('forecast-notes');
  if (notes) notes.innerHTML = '';
}

function _showError() {
  const card = document.getElementById('forecast-card');
  if (!card) return;
  card.classList.add('forecast-card-error');
  card.classList.remove('forecast-card-loading');
  const sparkWrap = document.getElementById('forecast-sparkline-wrap');
  if (sparkWrap) {
    sparkWrap.innerHTML =
      '<span class="forecast-error-text">Forecast unavailable.</span>' +
      '<button class="forecast-retry-btn" id="forecast-retry-btn" type="button">Retry</button>';
    const retryBtn = document.getElementById('forecast-retry-btn');
    if (retryBtn) {
      retryBtn.addEventListener('click', function () {
        _doFetch();
      });
    }
  }
}

// ── Fetch ────────────────────────────────────────────────────────────────────

function _doFetch(signal) {
  _showLoading();
  return fetch('/api/forecast', signal ? { signal } : {})
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      renderForecastCard(data);
      return data;
    })
    .catch(function (err) {
      if (err && err.name === 'AbortError') return;
      _showError();
    });
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function initForecastCard() {
  // Insert card above the balance card (or as the last card in .bento-grid
  // if the balance card is absent). The balance-card is the last child of
  // the .bento-grid inside #view-status.
  const bentoGrid = document.querySelector('#view-status .bento-grid');
  if (!bentoGrid) return;

  // Don't double-insert
  if (document.getElementById('forecast-card')) return;

  const card = createCardDom();

  const balanceCard = document.getElementById('balance-card');
  if (balanceCard) {
    bentoGrid.insertBefore(card, balanceCard);
  } else {
    bentoGrid.appendChild(card);
  }

  // Register with the sync coordinator so the card refreshes on Android
  // resume, network recovery, and tab focus — just like the balance card.
  registerDataSource({
    id: 'forecast',
    isActive: function () { return store.get('phase') === 'live'; },
    fetch: function (signal) {
      return fetch('/api/forecast', { signal }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    },
    applyToStore: function (data) {
      renderForecastCard(data);
    },
  });

  // Initial fetch when entering live mode — the sync coordinator will
  // drive subsequent refreshes, but we want data on first paint.
  store.subscribe('phase', function () {
    if (store.get('phase') === 'live') {
      _doFetch();
    }
  });
}
