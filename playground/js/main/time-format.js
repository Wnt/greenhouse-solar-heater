// Helsinki-timezone formatting and cause/reason labels used by the
// System Logs UI and the clipboard-export path. Factored out of main.js
// so the formatting layer stays small and independently testable.

import { SIM_START_HOUR } from '../sim-bootstrap.js';

// "HH:MM" from a simulation-time offset (seconds since SIM_START_HOUR).
// Used by sim-mode log entries that don't have a wall-clock timestamp.
// Named alongside the Helsinki helpers below because they all live in
// the "time → display string" family.
export function formatTimeOfDay(simSeconds) {
  const totalHours = SIM_START_HOUR + simSeconds / 3600;
  const h = Math.floor(totalHours % 24);
  const m = Math.floor((totalHours * 60) % 60);
  return h.toString().padStart(2, '0') + ':' + m.toString().padStart(2, '0');
}

const HELSINKI_TZ = 'Europe/Helsinki';
const fmtClockHelsinki = new Intl.DateTimeFormat('fi-FI', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: HELSINKI_TZ,
});
const fmtFullHelsinki = new Intl.DateTimeFormat('fi-FI', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZone: HELSINKI_TZ,
});
const fmtDayPartsHelsinki = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric',
  hour12: false, timeZone: HELSINKI_TZ,
});

export function formatClockTime(unixMs) {
  return fmtClockHelsinki.format(new Date(unixMs));
}

// Returns { year, month, day, hour, minute } as numbers for the wall
// clock in Europe/Helsinki. Handy for same-day comparisons or for
// building custom chart tick formats without pulling in a date lib.
export function helsinkiParts(unixMs) {
  const parts = fmtDayPartsHelsinki.formatToParts(new Date(unixMs));
  const out = {};
  for (const p of parts) {
    if (p.type === 'literal') continue;
    out[p.type] = parseInt(p.value, 10);
  }
  return out;
}

// Short human-readable label for each cause tag. Keep in sync with
// state.lastTransitionCause values set in shelly/control.js.
const CAUSE_LABELS = {
  boot: 'Boot',
  automation: 'Automation',
  forced: 'Forced mode',
  safety_override: 'Safety override',
  watchdog_auto: 'Watchdog (auto)',
  user_shutdown: 'User shutdown',
  drain_complete: 'Drain complete',
  failed: 'Transition failed',
};

export function formatCauseLabel(c) {
  return CAUSE_LABELS[c] || c;
}

// Finer-grained decision codes from the evaluator (shelly/control-logic.js).
// Paired with CAUSE_LABELS in the System Logs UI to turn a bare
// "automation" tag into "Automation — solar stall". Keep the keys in
// sync with the `reason` string set at each return path inside
// evaluate().
const REASON_LABELS = {
  solar_enter: 'collector hot enough to charge',
  solar_refill: 'refilling drained collectors',
  solar_active: 'tank still gaining heat',
  solar_stall: 'tank stopped gaining heat',
  solar_drop_from_peak: 'tank cooling below peak',
  overheat_circulate: 'collector overheat — circulating to cool',
  overheat_drain: 'collector overheat — draining',
  freeze_drain: 'freeze risk — draining',
  drain_running: 'drain in progress',
  drain_timeout: 'drain timeout fallback',
  greenhouse_enter: 'greenhouse cold — heating',
  greenhouse_active: 'greenhouse still cold',
  greenhouse_warm: 'greenhouse warm enough',
  greenhouse_tank_depleted: 'tank too cool to heat greenhouse',
  emergency_enter: 'greenhouse critical — emergency heat',
  sensor_stale: 'sensor reading stale',
  watchdog_ban: 'mode in watchdog cool-off',
  mode_disabled: 'mode disabled by user',
  // Watchdog auto-shutdown reasons. The id (sng / scs / ggr) is
  // appended by buildIdleTransitionResult() in shelly/control.js so
  // the log row distinguishes which watchdog tripped, instead of a
  // bare "watchdog_auto" cause with no decision detail.
  sng_shutdown: 'tank not gaining heat — auto-shutdown',
  scs_shutdown: 'collector cooling during charging — auto-shutdown',
  ggr_shutdown: 'greenhouse not gaining heat — auto-shutdown',
  // Forced-mode transitions originating from the playground "Force
  // mode" UI carry the picked mode in the reason so the log row
  // shows the user's intent, not just the bare cause "forced".
  forced_I: 'user forced Idle',
  forced_SC: 'user forced Solar Charging',
  forced_GH: 'user forced Greenhouse Heating',
  forced_AD: 'user forced Active Drain',
  forced_EH: 'user forced Emergency Heating',
  override_cleared: 'manual override cleared',
  override_expired: 'manual override timed out',
  min_duration: 'holding minimum run time',
  idle: 'no trigger active',
};

export function formatReasonLabel(r) {
  return REASON_LABELS[r] || r;
}

// Mode short codes (matching `wb` keys / `mo.fm` values) → human label.
const MODE_CODE_LABELS = {
  I: 'Idle',
  SC: 'Solar Charging',
  GH: 'Greenhouse Heating',
  AD: 'Active Drain',
  EH: 'Emergency Heating',
};

// ea (enabled-actuator bitmask) per-bit names → human label. Bit names
// originate in server/lib/config-events.js EA_BITS — keep in sync.
const EA_BIT_LABELS = {
  valves: 'Valves',
  pump: 'Pump',
  fan: 'Fan',
  space_heater: 'Space Heater',
  immersion_heater: 'Immersion Heater',
};

// Source attribution for config_events. Combined with actor for the
// per-row description in the System Logs view.
const CONFIG_SOURCE_LABELS = {
  api: 'mode-enablement UI',
  ws_override: 'device view',
  watchdog_auto: 'watchdog auto-shutdown',
  watchdog_user: 'watchdog banner',
};

export function formatConfigSourceLabel(s) {
  return CONFIG_SOURCE_LABELS[s] || s || 'unknown source';
}

// Render a config_events row to a { title, desc } pair for the log
// list. Flavors:
//   wb add (e.g. SC=9999999999)  — "Disabled mode: Solar Charging"
//   wb remove (e.g. SC=null)     — "Re-enabled mode: Solar Charging"
//   wb change (timestamp swap)   — "Updated ban: Solar Charging"
//   ea bit on  (0 → 1)           — "Enabled actuator: Fan"
//   ea bit off (1 → 0)           — "Disabled actuator: Fan"
//   mo enter (null → object)     — "Manual override: Solar Charging (until 14:30)"
//   mo exit (object → null)      — "Manual override exited"
//   mo change (object → object)  — "Manual override updated: Active Drain"
export function formatConfigEntry(t) {
  const PERMANENT = 9999999999;
  const sourceLabel = formatConfigSourceLabel(t.source);
  const actorLabel = t.actor ? ' by ' + t.actor : '';
  const subtitle = sourceLabel + actorLabel;

  if (t.configKind === 'wb') {
    const modeLabel = MODE_CODE_LABELS[t.configKey] || t.configKey || 'unknown mode';
    if (t.from === null && t.to !== null) {
      const isPermanent = parseInt(t.to, 10) === PERMANENT;
      const verb = isPermanent ? 'Disabled mode' : 'Banned mode (cool-off)';
      return { title: verb + ': ' + modeLabel, desc: subtitle };
    }
    if (t.from !== null && t.to === null) {
      return { title: 'Re-enabled mode: ' + modeLabel, desc: subtitle };
    }
    return { title: 'Updated ban: ' + modeLabel, desc: subtitle };
  }

  if (t.configKind === 'ea') {
    const bitLabel = EA_BIT_LABELS[t.configKey] || t.configKey || 'unknown actuator';
    const verb = t.to === '1' ? 'Enabled actuator' : 'Disabled actuator';
    return { title: verb + ': ' + bitLabel, desc: subtitle };
  }

  if (t.configKind === 'mo') {
    const fromMo = t.from ? safeParseJson(t.from) : null;
    const toMo = t.to ? safeParseJson(t.to) : null;
    if (!fromMo && toMo) {
      const fmLabel = MODE_CODE_LABELS[toMo.fm] || toMo.fm || 'unknown';
      return { title: 'Manual override: ' + fmLabel, desc: subtitle };
    }
    if (fromMo && !toMo) {
      return { title: 'Manual override exited', desc: subtitle };
    }
    if (toMo) {
      const fmLabel = MODE_CODE_LABELS[toMo.fm] || toMo.fm || 'unknown';
      return { title: 'Manual override updated: ' + fmLabel, desc: subtitle };
    }
  }

  return { title: 'Config change', desc: subtitle };
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// Overlay flips (fan-cool today, future overlays will reuse this shape).
// `t` carries `overlayId`, `from`, `to` per overlayRowToLogEntry.
export function formatOverlayEntry(t) {
  if (t.overlayId === 'greenhouse_fan_cooling') {
    const verb = t.to === 'on' ? 'started' : 'stopped';
    return {
      title: 'Fan cooling ' + verb,
      desc: t.to === 'on'
        ? 'Greenhouse hot — fan circulating air'
        : 'Greenhouse cooled — fan stopped',
    };
  }
  return { title: 'Overlay ' + (t.overlayId || ''), desc: (t.from || '?') + ' → ' + (t.to || '?') };
}

// Render the temp snapshot as "coll 62.3° · tank 41/29° · gh 12° · out 8°"
export function formatSensorsLine(sensors) {
  if (!sensors) return '';
  const f = (v) => (typeof v === 'number' ? v.toFixed(1) + '°' : '—');
  const parts = [];
  if ('collector' in sensors) parts.push('coll ' + f(sensors.collector));
  if ('tank_top' in sensors || 'tank_bottom' in sensors) {
    parts.push('tank ' + f(sensors.tank_top) + '/' + f(sensors.tank_bottom));
  }
  if ('greenhouse' in sensors) parts.push('gh ' + f(sensors.greenhouse));
  if ('outdoor' in sensors) parts.push('out ' + f(sensors.outdoor));
  return escapeHtml(parts.join(' · '));
}

// YYYY-MM-DD HH:MM:SS in Europe/Helsinki — used by clipboard export.
export function formatFullTimeHelsinki(unixMs) {
  const parts = fmtFullHelsinki.formatToParts(new Date(unixMs));
  const get = (type) => { const p = parts.find(x => x.type === type); return p ? p.value : ''; };
  return get('year') + '-' + get('month') + '-' + get('day') + ' ' +
         get('hour') + ':' + get('minute') + ':' + get('second');
}

// Full ISO-8601 with the Helsinki UTC offset (e.g. "2026-04-19T13:00:00+03:00").
// Machine-readable AND unambiguous — used by Copy-JSON exports so bug
// reports carry the user's wall clock without losing the offset.
export function formatIsoHelsinki(unixMs) {
  const d = new Date(unixMs);
  const local = formatFullTimeHelsinki(unixMs).replace(' ', 'T');
  // DST-aware offset between the instant and the Helsinki wall clock.
  const parts = fmtFullHelsinki.formatToParts(d);
  const get = (type) => { const p = parts.find(x => x.type === type); return p ? parseInt(p.value, 10) : 0; };
  const wallMs = Date.UTC(get('year'), get('month') - 1, get('day'),
                          get('hour'), get('minute'), get('second'));
  const offsetMin = Math.round((wallMs - d.getTime()) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const oh = Math.floor(abs / 60).toString().padStart(2, '0');
  const om = (abs % 60).toString().padStart(2, '0');
  return local + sign + oh + ':' + om;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
