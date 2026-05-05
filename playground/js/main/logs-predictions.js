// Captured next-hour forecasts (server persists one row per HH:30).
// Surfacing them in the System Logs export means a copied log carries
// predicted-vs-actual tuning data without a separate fetch.
//
// Extracted from logs-clipboard.js so that file stays under its 600-
// line hard cap; the rendering is self-contained (only depends on
// time-format helpers + a small numeric formatter).

import { formatFullTimeHelsinki } from './time-format.js';

function fmtNum(v, digits, width) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—'.padStart(width);
  return v.toFixed(digits).padStart(width);
}

export function appendPredictionHistory(lines, predictions) {
  if (!Array.isArray(predictions) || predictions.length === 0) return;
  lines.push('--- Prediction History ---');
  lines.push('For hour              Predicted at          Mode                  Solar  Duty  Tank-avg     GH  Outdoor    Rad   Price');
  for (let i = 0; i < predictions.length; i++) {
    const p = predictions[i];
    lines.push(
      formatFullTimeHelsinki(new Date(p.forHour).getTime()) + '  ' +
      formatFullTimeHelsinki(new Date(p.generatedAt).getTime()) + '  ' +
      (p.mode || 'idle').padEnd(20) + '  ' +
      (p.hasSolarOverlay ? '+SC  ' : '     ') + '  ' +
      (typeof p.duty === 'number' ? p.duty.toFixed(2) : '   —') + '  ' +
      fmtNum(p.tankAvgC, 1, 6) + '  ' +
      fmtNum(p.greenhouseC, 1, 6) + '  ' +
      fmtNum(p.outdoorC, 1, 6) + '°C  ' +
      fmtNum(p.radiationWm2, 0, 5) + '  ' +
      fmtNum(p.priceCKwh, 2, 6)
    );
  }
  lines.push('');
}
