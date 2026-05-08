/**
 * #diagnostics view — predicted vs actual forecast diagnostic.
 *
 * Operator-facing tuning aid (issue #169). Fetches from the read-only
 * /api/forecast/diagnostics endpoint, which joins forecast_predictions
 * rows at the chosen horizon to the closest sensor_readings_30s bucket
 * per for_hour.
 *
 * Renders three artefacts:
 *
 *   1. Time-series predicted-vs-actual lines for greenhouse temp, tank
 *      avg, and outdoor temp at the chosen horizon. Each generation is
 *      one point on each line.
 *   2. Mode classification ribbon: predicted mode at each for_hour as a
 *      coloured band, so the operator can spot persistent
 *      misclassifications.
 *   3. Per-day predicted radiation as a bar chart.
 *
 * Drill-down: clicking a generation in the recent-list (or a marker in
 * a chart) pulls the full 1..48 h trajectory for that generation and
 * shows the per-component breakdown (solar gain, radiator W, heater
 * kWh, tank loss, cloud factor) plus the fitted coefficients in
 * effect at that capture.
 *
 * Mobile-optimised charting is explicitly out of scope (issue #169) —
 * the charts are hand-rolled SVG, sized for the desktop card width.
 *
 * mountDiagnosticsView() — called when the user navigates to
 *   #diagnostics. Returns an unmount function that detaches listeners
 *   and aborts in-flight fetches.
 *
 * registerDiagnosticsSync() — call once at app boot to register the
 *   sync coordinator source. The source's isActive() gates per-resync
 *   execution to "in live mode AND on #diagnostics".
 */

import { registerDataSource } from './sync/registry.js';
import { store } from './app-state.js';
import {
  renderLineChart, renderModeRibbon, renderSolarGainBars, renderErrorSummary,
} from './diagnostics/charts.js';
import { renderComponentTable, renderCoefficientsTable } from './diagnostics/tables.js';
import { escapeHtml, formatLocal } from './diagnostics/format.js';

let _activeFetchAbort  = null;
let _activeDrillAbort  = null;
let _seriesData        = null;
let _generationData    = null;
let _selectedGenerated = null;

// ── Lifecycle ─────────────────────────────────────────────────────────

export function mountDiagnosticsView() {
  const horizonSel = document.getElementById('diag-horizon');
  const rangeSel   = document.getElementById('diag-range');
  const refreshBtn = document.getElementById('diag-refresh');
  const list       = document.getElementById('diag-drill-list');
  if (!horizonSel || !rangeSel || !refreshBtn || !list) return () => {};

  const onChange = () => fetchSeries();
  const onListClick = (e) => {
    const li = e.target.closest && e.target.closest('li[data-generated-at]');
    if (!li) return;
    selectGeneration(li.getAttribute('data-generated-at'));
  };

  horizonSel.addEventListener('change', onChange);
  rangeSel.addEventListener('change', onChange);
  refreshBtn.addEventListener('click', onChange);
  list.addEventListener('click', onListClick);

  fetchSeries();

  return () => {
    horizonSel.removeEventListener('change', onChange);
    rangeSel.removeEventListener('change', onChange);
    refreshBtn.removeEventListener('click', onChange);
    list.removeEventListener('click', onListClick);
    if (_activeFetchAbort) _activeFetchAbort.abort();
    if (_activeDrillAbort) _activeDrillAbort.abort();
    _activeFetchAbort = null;
    _activeDrillAbort = null;
  };
}

let _syncRegistered = false;
export function registerDiagnosticsSync() {
  if (_syncRegistered) return;
  _syncRegistered = true;
  registerDataSource({
    id: 'forecast-diagnostics',
    isActive: () => store.get('phase') === 'live' && store.get('currentView') === 'diagnostics',
    fetch: (signal) => fetchSeriesBlob(signal),
    applyToStore: (data) => {
      _seriesData = data;
      renderSeries();
      renderDrillList();
    },
  });
}

// ── Series fetch + render ────────────────────────────────────────────

function readControls() {
  const horizon = parseInt(document.getElementById('diag-horizon').value, 10) || 24;
  const days = parseInt(document.getElementById('diag-range').value, 10) || 7;
  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 3600 * 1000);
  return { horizon, since, until };
}

function fetchSeriesBlob(signal) {
  const { horizon, since, until } = readControls();
  const url = '/api/forecast/diagnostics' +
    '?horizon=' + horizon +
    '&since=' + encodeURIComponent(since.toISOString()) +
    '&until=' + encodeURIComponent(until.toISOString());
  return fetch(url, { credentials: 'include', signal }).then((r) => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function fetchSeries() {
  if (_activeFetchAbort) _activeFetchAbort.abort();
  const ctrl = new AbortController();
  _activeFetchAbort = ctrl;
  setStatus('Loading…');
  fetchSeriesBlob(ctrl.signal)
    .then((data) => {
      if (ctrl.signal.aborted) return;
      _seriesData = data;
      _activeFetchAbort = null;
      setStatus('Loaded ' + (data.rows || []).length + ' rows');
      renderSeries();
      renderDrillList();
    })
    .catch((err) => {
      if (err && err.name === 'AbortError') return;
      _activeFetchAbort = null;
      setStatus('Failed: ' + (err && err.message ? err.message : err));
    });
}

function setStatus(text) {
  const el = document.getElementById('diag-status');
  if (el) el.textContent = text;
}

function renderSeries() {
  const data = _seriesData;
  const rows = (data && data.rows) || [];
  renderLineChart('diag-chart-greenhouse', rows, 'greenhouse_c', 'Greenhouse temp', '°C', selectGeneration);
  renderLineChart('diag-chart-tank', rows, 'tank_avg_c', 'Tank avg', '°C', selectGeneration);
  renderLineChart('diag-chart-outdoor', rows, 'outdoor_c', 'Outdoor temp', '°C', selectGeneration);
  renderErrorSummary('diag-error-greenhouse', rows, 'greenhouse_c', 'Greenhouse');
  renderErrorSummary('diag-error-tank', rows, 'tank_avg_c', 'Tank avg');
  renderErrorSummary('diag-error-outdoor', rows, 'outdoor_c', 'Outdoor');
  renderModeRibbon('diag-chart-mode', rows, selectGeneration);
  renderSolarGainBars('diag-chart-solar', rows);
}

// ── Drill-down list + detail ──────────────────────────────────────────

function renderDrillList() {
  const list = document.getElementById('diag-drill-list');
  if (!list) return;
  const rows = (_seriesData && _seriesData.rows) || [];
  const sorted = rows.slice().sort((a, b) => (new Date(b.generated_at)) - (new Date(a.generated_at)));
  list.innerHTML = '';
  if (sorted.length === 0) {
    const li = document.createElement('li');
    li.className = 'diag-drill-empty';
    li.textContent = 'No predictions captured in this range yet.';
    list.appendChild(li);
    return;
  }
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    const li = document.createElement('li');
    li.setAttribute('data-generated-at', row.generated_at);
    if (row.generated_at === _selectedGenerated) li.classList.add('active');
    const ts = new Date(row.generated_at);
    li.innerHTML =
      '<span class="diag-drill-ts">' + escapeHtml(formatLocal(ts)) + '</span>' +
      '<span class="diag-drill-mini">algo ' + escapeHtml(row.algorithm_version || '?').slice(0, 8) + '</span>';
    list.appendChild(li);
  }
}

function selectGeneration(generatedAt) {
  if (_activeDrillAbort) _activeDrillAbort.abort();
  _selectedGenerated = generatedAt;
  renderDrillList();
  setStatus('Loading drill…');
  const ctrl = new AbortController();
  _activeDrillAbort = ctrl;
  const url = '/api/forecast/diagnostics?generated_at=' + encodeURIComponent(generatedAt);
  fetch(url, { credentials: 'include', signal: ctrl.signal })
    .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((data) => {
      if (ctrl.signal.aborted) return;
      _generationData = data;
      _activeDrillAbort = null;
      setStatus('Loaded generation ' + generatedAt);
      renderDrill();
    })
    .catch((err) => {
      if (err && err.name === 'AbortError') return;
      _activeDrillAbort = null;
      setStatus('Drill failed: ' + (err && err.message ? err.message : err));
    });
}

function renderDrill() {
  const empty = document.getElementById('diag-drill-empty');
  const detail = document.getElementById('diag-drill-detail');
  if (!empty || !detail) return;
  if (!_generationData) {
    empty.style.display = 'block';
    detail.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  detail.style.display = 'block';
  const title = document.getElementById('diag-drill-title');
  if (title) title.textContent = 'Generated ' + formatLocal(new Date(_generationData.generated_at)) +
    ' • algorithm ' + (_generationData.algorithm_version || 'unknown');
  // Reuse the line-chart renderer for the per-horizon trajectory
  // (no click-to-drill here — we're already inside the drill).
  const horizons = _generationData.horizons || [];
  const trajRows = horizons.map((h) => ({
    for_hour: h.for_hour, generated_at: null,
    predicted: { greenhouse_c: h.predicted ? h.predicted.greenhouse_c : null,
                 tank_avg_c:   h.predicted ? h.predicted.tank_avg_c   : null,
                 mode:         h.predicted ? h.predicted.mode         : 'idle' },
    actual:    { greenhouse_c: h.actual ? h.actual.greenhouse_c : null,
                 tank_avg_c:   h.actual ? h.actual.tank_avg_c   : null },
  }));
  renderLineChart('diag-drill-chart-greenhouse', trajRows, 'greenhouse_c', 'Greenhouse trajectory', '°C', null);
  renderLineChart('diag-drill-chart-tank', trajRows, 'tank_avg_c', 'Tank avg trajectory', '°C', null);
  renderComponentTable('diag-drill-components', horizons);
  renderCoefficientsTable('diag-drill-coefficients', _generationData);
}

// Test bridge: expose a couple of internals so the Playwright suite can
// drive the view without round-tripping through the real network. Same
// pattern as window.__sync (sync registry test bridge).
if (typeof window !== 'undefined') {
  window.__diag = window.__diag || {};
  window.__diag.selectGeneration = selectGeneration;
  window.__diag.getSeriesData = () => _seriesData;
  window.__diag.getGenerationData = () => _generationData;
}
