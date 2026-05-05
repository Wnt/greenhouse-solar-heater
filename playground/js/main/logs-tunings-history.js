// Tunable-values change timeline — pulled out of the mixed Transition
// Log so an operator can scan threshold tweaks without scrolling past
// mode flips. Source data is the same transitionLog the Transition Log
// section uses; we filter for `eventType === 'config' && configKind ===
// 'tu'` and render newest-first. Section is omitted entirely when
// there are no tu changes (mirrors the predictions empty-case).

import { formatFullTimeHelsinki, formatConfigSourceLabel } from './time-format.js';

// tu compact-key → human label. Mirrored from time-format.js's
// TUNING_LABELS, kept local to avoid widening that module's exports.
// Keep in sync if you add a new tunable.
const LABELS = {
  geT: 'greenhouse heat enter',
  gxT: 'greenhouse heat exit',
  gmD: 'greenhouse min tank delta',
  gxD: 'greenhouse exit tank delta',
  ehE: 'emergency heater enter',
  ehX: 'emergency heater exit',
  fcE: 'fan-cool enter',
  fcX: 'fan-cool exit',
  frT: 'freeze drain',
  ohT: 'overheat drain',
};

function labelFor(key) {
  return LABELS[key] || (key || 'unknown threshold');
}

function valueLabel(v) {
  if (v === null || v === undefined || v === '') return 'default';
  return String(v);
}

export function appendTuningsHistory(lines, transitionLog) {
  if (!Array.isArray(transitionLog) || transitionLog.length === 0) return;
  const tuRows = transitionLog
    .filter(t => t && t.eventType === 'config' && t.configKind === 'tu')
    // transitionLog is already newest-first (DESC), but defensive sort
    // — a future change to load order shouldn't silently flip this view.
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (tuRows.length === 0) return;
  lines.push('--- Tunable Values History ---');
  for (let i = 0; i < tuRows.length; i++) {
    const t = tuRows[i];
    const time = formatFullTimeHelsinki(t.ts);
    const label = labelFor(t.configKey);
    const tag   = t.configKey ? ' (' + t.configKey + ')' : '';
    const from  = valueLabel(t.from);
    const to    = valueLabel(t.to);
    const sourceLabel = formatConfigSourceLabel(t.source);
    const actor = t.actor ? ' by ' + t.actor : '';
    lines.push(
      time + '  ' +
      (label + tag).padEnd(34) + '  ' +
      from + ' → ' + to + '  [' + sourceLabel + actor + ']'
    );
  }
  lines.push('');
}
