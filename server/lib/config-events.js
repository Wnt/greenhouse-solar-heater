// Diff (prev, next) deviceConfig snapshots into config_events rows
// covering wb (mode bans), mo (manual override session), and ea
// (enabled-actuator bitmask). ea is emitted one row per flipped bit so
// "fan toggled" shows up as a single audit entry, not "ea: 3 → 7".
// ce / we / wz / v deltas are intentionally not audited — they have
// their own UI or are coarse bookkeeping.

const { VALID_MODES } = require('./mode-constants');

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

  for (let i = 0; i < VALID_MODES.length; i++) {
    const k = VALID_MODES[i];
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

// Best-effort: a failed insert is logged and skipped, but doesn't
// short-circuit the remaining rows.
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
