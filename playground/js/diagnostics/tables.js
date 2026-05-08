// Table renderers for the drill-down panel: per-component breakdown
// and the fitted-coefficients / tunable-overrides view.

import { fmt, formatCoeff, formatShortLocal, escapeHtml } from './format.js';

export function renderComponentTable(containerId, horizons) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!horizons || horizons.length === 0) {
    container.innerHTML = '<div class="diag-chart-empty">No horizons in this generation.</div>';
    return;
  }
  const rows = horizons.map((h) => {
    const p = h.predicted || {};
    const a = h.actual || {};
    return [
      'h+' + h.horizon_h,
      formatShortLocal(new Date(h.for_hour)),
      p.mode || '—',
      fmt(p.tank_avg_c, 1),
      fmt(a.tank_avg_c, 1),
      fmt(p.greenhouse_c, 1),
      fmt(a.greenhouse_c, 1),
      fmt(p.pred_solar_gain_kwh, 2),
      fmt(p.pred_rad_delivered_w, 0),
      fmt(p.pred_heater_kwh, 2),
      fmt(p.pred_tank_loss_w, 0),
      fmt(p.pred_cloud_factor, 2),
    ];
  });
  const headers = ['Horizon', 'For', 'Mode',
    'Tank pred', 'Tank actual',
    'GH pred', 'GH actual',
    'Solar kWh', 'Rad W', 'Heater kWh', 'Tank loss W', 'Cloud'];
  container.innerHTML = renderTable(headers, rows, 'diag-components-table');
}

export function renderCoefficientsTable(containerId, gen) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const coeff = gen && gen.coefficients;
  const tu = gen && gen.tu;
  if (!coeff && !tu) {
    container.innerHTML = '<div class="diag-chart-empty">No coefficients or tunable values recorded.</div>';
    return;
  }
  let html = '';
  if (coeff) {
    const rows = Object.keys(coeff).sort().map((k) => [k, formatCoeff(coeff[k])]);
    html += '<h5 class="diag-coeff-title">Fitted coefficients</h5>' +
      renderTable(['Key', 'Value'], rows, 'diag-coeff-table');
  }
  if (tu) {
    const rows = Object.keys(tu).sort().map((k) => [k, formatCoeff(tu[k])]);
    html += '<h5 class="diag-coeff-title">Tunable overrides (<code>tu</code>)</h5>' +
      renderTable(['Key', 'Value'], rows, 'diag-coeff-table');
  }
  container.innerHTML = html;
}

function renderTable(headers, rows, className) {
  let html = '<table class="' + className + '"><thead><tr>';
  for (let i = 0; i < headers.length; i++) {
    html += '<th>' + escapeHtml(headers[i]) + '</th>';
  }
  html += '</tr></thead><tbody>';
  for (let i = 0; i < rows.length; i++) {
    html += '<tr>';
    for (let j = 0; j < rows[i].length; j++) {
      html += '<td>' + escapeHtml(String(rows[i][j])) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}
