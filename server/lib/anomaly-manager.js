// Server-side bridge for watchdog anomaly detection. Receives device
// MQTT fired/resolved events, formats human-readable reasons, persists
// history (Postgres or ring-buffer), broadcasts WS state, and exposes
// the ack / shutdownNow / setEnabled / getState / getHistory API.

'use strict';

const {
  WATCHDOGS, WATCHDOG_IDS, WATCHDOG_BAN_SECONDS, getWatchdog
} = require('../../shelly/watchdogs-meta.js');

let _deps = null;
let _pending = null;
// Mirror of deviceConfig fields needed to render the watchdog UI.
// Broadcast as watchdog-state.snapshot. Stay in sync with
// DEFAULT_CONFIG in device-config.js — every field the evaluator
// reads on the device should appear here.
let _lastSnapshot = {};

function init(deps) {
  _deps = deps;
  _pending = null;
  _lastSnapshot = {};
  if (deps && deps.deviceConfig && typeof deps.deviceConfig.getConfig === 'function') {
    try { updateSnapshot(deps.deviceConfig.getConfig()); } catch (e) { /* ignore */ }
  }
}

// Applies the watchdog_events schema (if a Postgres pool is available),
// builds the history backend, and calls init().
function bootstrap(opts) {
  const path = require('path');
  const fs = require('fs');
  const { createHistory: createWatchdogHistory } = require('./watchdog-history');
  const db = opts.db;
  const log = opts.log;

  if (db && typeof db.getPool === 'function') {
    try {
      const pool = db.getPool();
      const sqlPath = path.join(__dirname, '..', 'db', 'watchdog-events-schema.sql');
      const schemaSql = fs.readFileSync(sqlPath, 'utf8');
      pool.query(schemaSql, [], function (schemaErr) {
        if (schemaErr) log.warn('watchdog schema init failed', { error: schemaErr.message });
        else log.info('watchdog_events schema ready');
      });
    } catch (e) {
      log.warn('failed to apply watchdog schema', { error: e.message });
    }
  }

  const wdHistoryDb = (db && typeof db.getPool === 'function') ? db.getPool() : null;
  const watchdogHistory = createWatchdogHistory({ db: wdHistoryDb, log });
  init({
    history: watchdogHistory,
    push: opts.push,
    wsBroadcast: opts.wsBroadcast,
    mqttBridge: opts.mqttBridge,
    deviceConfig: opts.deviceConfig,
    db,
    log,
  });
  log.info('anomaly-manager initialized', { backend: wdHistoryDb ? 'postgres' : 'ring-buffer' });
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function f1(n) {
  return (Math.round(n * 10) / 10).toFixed(1);
}

function formatReason(e) {
  const m = Math.floor(e.el / 60) + ':' + pad2(e.el % 60);
  if (e.id === 'sng') {
    return 'Tank only +' + f1(e.dT) + '\u00B0C after ' + m + ' (expected \u2265+0.5\u00B0C)';
  }
  if (e.id === 'scs') {
    return 'Collector only -' + f1(e.dC) + '\u00B0C after ' + m + ' (expected \u2265-3\u00B0C)';
  }
  if (e.id === 'ggr') {
    return 'Greenhouse only +' + f1(e.dG) + '\u00B0C after ' + m + ' (expected \u2265+0.5\u00B0C)';
  }
  return 'Unknown watchdog: ' + e.id;
}

function getPending() {
  return _pending;
}

function updateSnapshot(cfg) {
  _lastSnapshot = {
    ce: !!cfg.ce,
    ea: typeof cfg.ea === 'number' ? cfg.ea : 0,
    mo: cfg.mo || null,
    we: cfg.we || {},
    wz: cfg.wz || {},
    wb: cfg.wb || {},
    v: typeof cfg.v === 'number' ? cfg.v : null,
  };
}

async function handleDeviceEvent(msg) {
  if (!_deps) throw new Error('anomaly-manager not initialized');
  if (msg.t === 'fired') {
    await _handleFired(msg);
  } else if (msg.t === 'resolved') {
    await _handleResolved(msg);
  }
}

async function _handleFired(msg) {
  const triggerReason = formatReason(msg);
  const row = {
    watchdog_id: msg.id,
    mode: msg.mode,
    fired_at: new Date(msg.ts * 1000),
    trigger_reason: triggerReason,
    resolution: null,
    resolved_at: null,
    snooze_until: null,
    snooze_reason: null,
    resolved_by: null
  };
  const { id: dbEventId } = await _deps.history.insert(row);

  _pending = {
    id: msg.id,
    firedAt: msg.ts,
    mode: msg.mode,
    triggerReason,
    dbEventId
  };

  // Push notification (fire-and-forget, logged on failure)
  if (_deps.push && typeof _deps.push.sendByCategory === 'function') {
    Promise.resolve(_deps.push.sendByCategory('watchdog_fired',
      _buildNotificationPayload(_pending)
    )).catch(err => {
      if (_deps.log && _deps.log.error) {
        _deps.log.error('watchdog push failed', { error: err.message });
      }
    });
  }

  // WebSocket broadcast
  _broadcastState();
}

async function _handleResolved(msg) {
  const resolvedAt = new Date((msg.ts || Math.floor(Date.now() / 1000)) * 1000);
  const matches = !!(_pending && _pending.id === msg.id);

  // shutdown_auto: device's 5-min grace expired and it wrote wb[modeCode]
  // itself. No device→server config feedback, so we mirror the ban back
  // into the server's mirror + audit log. shutdown_user already takes
  // the normal config-PUT path.
  if (msg.how === 'shutdown_auto') {
    await _handleAutoShutdownBan(msg);
  }

  if (matches) {
    await _deps.history.update(_pending.dbEventId, {
      resolution: msg.how,
      resolved_at: resolvedAt
    });

    // Replace the original "fired" push with a snooze-applied
    // confirmation; dispatch before clearing _pending so the metadata
    // is still around.
    if (msg.how === 'snoozed' && _pending.snoozeUntil) {
      _dispatchSnoozeAckPush(msg.id, _pending);
    }

    _pending = null;
  }

  _broadcastState();
}

function _dispatchSnoozeAckPush(id, pendingSnapshot) {
  if (!_deps.push || typeof _deps.push.sendByCategory !== 'function') return;
  const meta = getWatchdog(id);
  const label = meta ? meta.shortLabel : id;
  const reason = pendingSnapshot.snoozeReason || '(no reason provided)';
  const until = new Date(pendingSnapshot.snoozeUntil * 1000);
  // Helsinki HH:MM so the cloud server (UTC) shows the same wall clock
  // the user sees in-app.
  const untilStr = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Europe/Helsinki',
  }).format(until);

  const payload = {
    title: 'Snooze applied \u2014 ' + label,
    body: '"' + reason + '" \u2014 running until ' + untilStr,
    icon: 'assets/notif-watchdog.png',
    badge: 'assets/badge-72.png',
    // Same tag as the fire notification so this replaces it on-device
    // rather than stacking.
    tag: 'watchdog-' + id,
    data: {
      kind: 'watchdog_ack',
      watchdogId: id,
      url: '/#status',
    }
  };

  Promise.resolve(_deps.push.sendByCategory('watchdog_fired', payload))
    .catch(err => {
      if (_deps.log && _deps.log.error) {
        _deps.log.error('watchdog ack push failed', { error: err.message });
      }
    });
}

function _broadcastState() {
  if (!_deps || !_deps.wsBroadcast) return;
  _deps.wsBroadcast({
    type: 'watchdog-state',
    pending: _pending,
    watchdogs: WATCHDOGS,
    snapshot: _lastSnapshot
  });
}

function _buildNotificationPayload(pending) {
  const meta = getWatchdog(pending.id);
  return {
    title: 'Watchdog fired \u2014 ' + (meta ? meta.shortLabel : pending.id),
    body:  pending.triggerReason + '. Auto-shutdown in 5 min.',
    icon:  'assets/notif-watchdog.png',
    badge: 'assets/badge-72.png',
    tag:   'watchdog-' + pending.id,
    renotify: true,
    requireInteraction: true,
    actions: [
      { action: 'shutdownnow', type: 'button', title: 'Shutdown now' },
      { action: 'snooze',      type: 'text',   title: 'Snooze',
        placeholder: 'Reason (e.g. door open)' }
    ],
    data: {
      kind: 'watchdog_fired',
      eventId: pending.dbEventId,
      watchdogId: pending.id,
      url: '/#status'
    }
  };
}

// Mirror the device's auto-set wb[modeCode] back into the server
// config. Without this, the next config republish would clobber the
// device's ban (server mirror was empty) and the Mode Enablement
// cool-off display would also be wrong.
async function _handleAutoShutdownBan(msg) {
  const meta = getWatchdog(msg.id);
  if (!meta || !meta.modeCode) return;
  const tsSec = msg.ts || Math.floor(Date.now() / 1000);
  const banUntil = tsSec + WATCHDOG_BAN_SECONDS;

  // Audit row first — if the wb mirror fails, the System Logs should
  // still record the event.
  if (_deps && _deps.db && typeof _deps.db.insertConfigEvent === 'function') {
    _deps.db.insertConfigEvent({
      ts: new Date(tsSec * 1000),
      kind: 'wb',
      key: meta.modeCode,
      old_value: null,
      new_value: String(banUntil),
      source: 'watchdog_auto',
      actor: 'device',
    }, function (err) {
      if (err && _deps.log) {
        _deps.log.error('config_event insert failed (watchdog_auto)', {
          error: err.message, watchdog: msg.id, mode: meta.modeCode,
        });
      }
    });
  }

  const patch = { wb: {} };
  patch.wb[meta.modeCode] = banUntil;
  try {
    await _updateConfigAndPublish(patch);
  } catch (err) {
    if (_deps && _deps.log) {
      _deps.log.error('failed to mirror watchdog auto-shutdown ban', {
        error: err.message, watchdog: msg.id, mode: meta.modeCode,
      });
    }
  }
}

function _updateConfigAndPublish(patch) {
  return new Promise((resolve, reject) => {
    _deps.deviceConfig.updateConfig(patch, (err, updated) => {
      if (err) return reject(err);
      try {
        if (_deps.mqttBridge && typeof _deps.mqttBridge.publishConfig === 'function') {
          _deps.mqttBridge.publishConfig(updated);
        }
      } catch (e) { /* ignore publish errors — server already persisted */ }
      // Mirror snapshot for live broadcasts and getState() calls.
      updateSnapshot(updated);
      resolve(updated);
    });
  });
}

async function ack(id, reason, user) {
  if (!_pending || _pending.id !== id) {
    throw new Error('no matching pending');
  }
  const meta = getWatchdog(id);
  const ttl = meta ? meta.snoozeTtlSeconds : 3600;
  const snoozeUntil = Math.floor(Date.now() / 1000) + ttl;

  await _deps.history.update(_pending.dbEventId, {
    snooze_reason: reason,
    snooze_until: new Date(snoozeUntil * 1000),
    resolved_by: user.name
  });

  // Stash on _pending so _handleResolved can build the ack push once
  // the device confirms it processed the snooze — we want the
  // confirmation to mean "the device applied it", not "server got it".
  _pending.snoozeUntil = snoozeUntil;
  _pending.snoozeReason = reason;
  _pending.snoozedBy = user.name;

  // The device's config_changed handler treats a fresh wz[id] as the
  // snooze ack, riding on the greenhouse/config subscription.
  const patch = { wz: {} };
  patch.wz[id] = snoozeUntil;
  await _updateConfigAndPublish(patch);

  return { snoozeUntil };
}

async function shutdownNow(id, user) {
  if (!_pending || _pending.id !== id) {
    throw new Error('no matching pending');
  }
  const meta = getWatchdog(id);
  if (!meta || !meta.modeCode) {
    throw new Error('unknown watchdog mode for id ' + id);
  }
  await _deps.history.update(_pending.dbEventId, {
    resolved_by: user.name
  });

  // wb[modeCode] = (now + WATCHDOG_BAN_SECONDS) — the device picks
  // this up via config_changed, transitions to IDLE, and publishes
  // "resolved shutdown_user".
  const banUntil = Math.floor(Date.now() / 1000) + WATCHDOG_BAN_SECONDS;
  const patch = { wb: {} };
  patch.wb[meta.modeCode] = banUntil;
  await _updateConfigAndPublish(patch);
}

function setEnabled(id, enabled, user) {
  return new Promise((resolve, reject) => {
    if (WATCHDOG_IDS.indexOf(id) === -1) {
      return reject(new Error('unknown watchdog id: ' + id));
    }
    const current = _deps.deviceConfig.getConfig();
    const we = Object.assign({}, current.we || {});
    we[id] = enabled ? 1 : 0;
    _deps.deviceConfig.updateConfig({ we }, (err, updated) => {
      if (err) return reject(err);
      if (_deps.mqttBridge && typeof _deps.mqttBridge.publishConfig === 'function') {
        try { _deps.mqttBridge.publishConfig(updated); } catch (e) { /* ignore */ }
      }
      updateSnapshot(updated);
      _broadcastState();
      resolve(updated);
    });
  });
}

async function getState() {
  const recent = _deps && _deps.history
    ? await _deps.history.list(10)
    : [];
  return {
    pending: _pending,
    watchdogs: WATCHDOGS,
    snapshot: _lastSnapshot,
    recent
  };
}

async function getHistory(limit) {
  return _deps.history.list(limit || 20);
}

module.exports = {
  init,
  bootstrap,
  formatReason,
  getPending,
  updateSnapshot,
  handleDeviceEvent,
  ack,
  shutdownNow,
  setEnabled,
  getState,
  getHistory,
};
