// server/lib/anomaly-manager.js
//
// Server-side bridge for the watchdog anomaly detection feature.
// Receives device MQTT events (fired/resolved), formats human-readable
// reasons, persists history to Postgres (with ring-buffer fallback),
// dispatches push notifications and WebSocket state broadcasts, and
// exposes ack/shutdownNow/setEnabled/getState/getHistory for the HTTP
// endpoint handlers.

'use strict';

const {
  WATCHDOGS, WATCHDOG_IDS, WATCHDOG_BAN_SECONDS, getWatchdog
} = require('../../shelly/watchdogs-meta.js');

// Module-scoped state — set by init()
let _deps = null;         // { deviceConfig, mqttBridge, push, wsBroadcast, history, log }
let _pending = null;      // { id, firedAt, mode, triggerReason, dbEventId } | null
let _lastSnapshot = {};   // { we, wz, wb } cached from latest device config

function init(deps) {
  _deps = deps;
  _pending = null;
  _lastSnapshot = {};
  // Initial snapshot from current device config if available
  if (deps && deps.deviceConfig && typeof deps.deviceConfig.getConfig === 'function') {
    try { updateSnapshot(deps.deviceConfig.getConfig()); } catch (e) { /* ignore */ }
  }
}

// Bootstrap helper called from server.js. Applies the watchdog_events
// schema (if a Postgres pool is available), creates the history
// backend (Postgres or ring-buffer fallback), and calls init().
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
    we: cfg.we || {},
    wz: cfg.wz || {},
    wb: cfg.wb || {}
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

  if (matches) {
    await _deps.history.update(_pending.dbEventId, {
      resolution: msg.how,
      resolved_at: resolvedAt
    });

    // Snooze ack push: the user submitted a snooze (via inline reply
    // or web UI), the server pushed the wz config, and the device has
    // now confirmed it processed the snooze. Send a positive
    // confirmation push so the user sees the result of their action
    // even if they were interacting purely via the system notification
    // and never had the app open. The push is dispatched BEFORE
    // _pending is cleared so the stashed snooze metadata is still
    // available.
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
  // Compact "HH:MM" in Europe/Helsinki so the cloud server (typically
  // UTC) renders the same wall clock the user sees in-app.
  const untilStr = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Europe/Helsinki',
  }).format(until);

  const payload = {
    title: 'Snooze applied \u2014 ' + label,
    body: '"' + reason + '" \u2014 running until ' + untilStr,
    icon: 'assets/notif-watchdog.png',
    badge: 'assets/badge-72.png',
    // Same tag as the original fire notification so this REPLACES it
    // on the device rather than stacking. The user sees the original
    // notification turn into the ack confirmation.
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

// Internal helper: PUT a partial device-config update and publish the
// resulting full config via the existing greenhouse/config retained
// MQTT topic. Returns a Promise that resolves with the merged config.
//
// The device picks up the change in its existing config_changed event
// handler, where it detects watchdog-relevant transitions (wz[id] for
// snooze, wb[modeCode] for shutdown) and reacts. This avoids needing
// a second MQTT subscription on the Shelly device, which has a
// limited subscription budget.
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

  // Stash snooze metadata on _pending so _handleResolved can build
  // the ack notification once the device confirms it processed the
  // snooze. We don't fire the ack push here directly — we wait for
  // the device's "resolved snoozed" event so the confirmation truly
  // means "the device has applied your snooze", not just "the server
  // accepted your request".
  _pending.snoozeUntil = snoozeUntil;
  _pending.snoozeReason = reason;
  _pending.snoozedBy = user.name;

  // Encode the snooze as a wz[id] config update. The device's
  // config_changed handler detects "wz[id] just became set while a
  // pending fire exists for this id" and treats it as the snooze
  // ack — same effect as the old MQTT cmd path, but uses the
  // existing greenhouse/config subscription.
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

  // Encode the user-triggered shutdown as a wb[modeCode] cool-off
  // ban set to (now + WATCHDOG_BAN_SECONDS). The device detects
  // "wb[modeCode] just became set while a pending fire exists for
  // a watchdog of this mode" and reacts: clears pending, transitions
  // to IDLE, publishes "resolved shutdown_user".
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
