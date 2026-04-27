/**
 * Config-events diff helper. Pure: given (prev, next) deviceConfig
 * snapshots plus a source tag and actor, returns the array of
 * config_events rows that should be inserted to capture the wb (mode
 * bans), mo (manual override), and ea (enabled-actuator bitmask)
 * deltas. Used by every code path that mutates deviceConfig so the
 * System Logs view sees a consistent audit trail.
 *
 * ea is emitted per-bit: a single PUT that flips two bits produces
 * two rows, mirroring how wb emits one row per mode. Each row's `key`
 * is the bit name (valves / pump / fan / space_heater / immersion_heater)
 * and old_value/new_value are '0' / '1'. This is what makes a Fan-only
 * toggle by the user show up as a single "Enabled actuator: Fan" entry
 * instead of an opaque "ea: 3 → 7".
 *
 * Unhandled fields (ce, we, wz, v) are intentionally ignored —
 * watchdog config has its own UI surface (we, wz), and ce / v are
 * coarse-grained toggles / bookkeeping. If/when one of those needs an
 * audit row, add it here.
 */

const WB_KEYS = ['I', 'SC', 'GH', 'AD', 'EH'];

// Mirrors device-config.js: ea = valves|pump|fan|space_heater|immersion_heater
// at bits 1, 2, 4, 8, 16. Order is bit order so multi-bit diffs come
// out in a stable sequence.
const EA_BITS = [
  { bit: 1,  name: 'valves' },
  { bit: 2,  name: 'pump' },
  { bit: 4,  name: 'fan' },
  { bit: 8,  name: 'space_heater' },
  { bit: 16, name: 'immersion_heater' },
];

function getWb(cfg) {
  return (cfg && cfg.wb) || {};
}

function getMo(cfg) {
  return (cfg && cfg.mo !== undefined) ? cfg.mo : null;
}

function moEqual(a, b) {
  // mo is either null or { a, ex, fm? }. Compare by JSON since the
  // shape is small and field set is fixed.
  const sa = a ? JSON.stringify(a) : null;
  const sb = b ? JSON.stringify(b) : null;
  return sa === sb;
}

function getEa(cfg) {
  const v = cfg && cfg.ea;
  return typeof v === 'number' ? v : 0;
}

function diffConfig(prev, next, source, actor) {
  const out = [];
  const wbPrev = getWb(prev);
  const wbNext = getWb(next);

  for (let i = 0; i < WB_KEYS.length; i++) {
    const k = WB_KEYS[i];
    const pv = wbPrev[k];
    const nv = wbNext[k];
    if (pv === nv) continue;
    out.push({
      kind: 'wb',
      key: k,
      old_value: (pv === undefined || pv === null) ? null : String(pv),
      new_value: (nv === undefined || nv === null) ? null : String(nv),
      source,
      actor: actor || null,
    });
  }

  const eaPrev = getEa(prev);
  const eaNext = getEa(next);
  if (eaPrev !== eaNext) {
    for (let i = 0; i < EA_BITS.length; i++) {
      const b = EA_BITS[i];
      const wasOn = (eaPrev & b.bit) !== 0;
      const nowOn = (eaNext & b.bit) !== 0;
      if (wasOn === nowOn) continue;
      out.push({
        kind: 'ea',
        key: b.name,
        old_value: wasOn ? '1' : '0',
        new_value: nowOn ? '1' : '0',
        source,
        actor: actor || null,
      });
    }
  }

  const moPrev = getMo(prev);
  const moNext = getMo(next);
  if (!moEqual(moPrev, moNext)) {
    out.push({
      kind: 'mo',
      key: null,
      old_value: moPrev ? JSON.stringify(moPrev) : null,
      new_value: moNext ? JSON.stringify(moNext) : null,
      source,
      actor: actor || null,
    });
  }

  return out;
}

// Higher-level convenience: diff prev/next, write each row through
// the supplied db.insertConfigEvent. Failure of one insert doesn't
// short-circuit subsequent inserts — they're independent rows and
// dropping one is preferable to dropping all. Errors are logged via
// the supplied logger so the caller can rely on best-effort writes.
function emitConfigEvents(db, log, prev, next, source, actor) {
  if (!db || typeof db.insertConfigEvent !== 'function') return;
  const rows = diffConfig(prev, next, source, actor);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    db.insertConfigEvent(row, function (err) {
      if (err && log && typeof log.error === 'function') {
        log.error('config_event insert failed', {
          error: err.message,
          kind: row.kind,
          key: row.key,
          source,
        });
      }
    });
  }
}

module.exports = { diffConfig, emitConfigEvents };
