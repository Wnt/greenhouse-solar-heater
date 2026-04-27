/**
 * Config-events diff helper. Pure: given (prev, next) deviceConfig
 * snapshots plus a source tag and actor, returns the array of
 * config_events rows that should be inserted to capture the wb (mode
 * bans) and mo (manual override) deltas. Used by every code path that
 * mutates deviceConfig so the System Logs view sees a consistent
 * audit trail.
 *
 * Unhandled fields (ce, ea, we, wz, v) are intentionally ignored —
 * they're either operational toggles (ce, ea), watchdog config that
 * the watchdog UI tracks separately (we, wz), or bookkeeping (v).
 * If/when one of those needs an audit row, add it here.
 */

const WB_KEYS = ['I', 'SC', 'GH', 'AD', 'EH'];

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
