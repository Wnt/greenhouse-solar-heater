// WebSocket command handlers — manual override + relay commands.
// Exports handleWsCommand (dispatch + role check) and setDb.

const mqttBridge = require('./mqtt-bridge');
const deviceConfig = require('./device-config');
const { emitConfigEvents } = require('./config-events');
const { VALID_MODES } = require('./mode-constants');
const createLogger = require('./logger');

const log = createLogger('ws-command');

const VALID_RELAYS = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air', 'pump', 'fan'];
let overrideTtlTimer = null;

// db is injected after init from server.js to avoid a circular require.
// Null in tests that skip db init — audit writes are then no-ops.
let _db = null;
function setDb(db) { _db = db; }

function wsSend(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// Schedule the secondary server-side TTL cleanup. If the override is
// still active when the timer fires, clear it and emit an audit event
// with actor='ttl_expiry'. Replaces any pending timer.
function scheduleOverrideTtl(ttl) {
  clearOverrideTtlTimer();
  overrideTtlTimer = setTimeout(function () {
    overrideTtlTimer = null;
    const current = deviceConfig.getConfig();
    if (current.mo && current.mo.a) {
      deviceConfig.updateConfig({ mo: null }, function (err, cleared, prevTtl) {
        if (err) return;
        mqttBridge.publishConfig(cleared);
        emitConfigEvents(_db, log, prevTtl, cleared, 'ws_override', 'ttl_expiry');
      });
    }
  }, ttl * 1000);
}

function handleWsCommand(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch (e) {
    return;
  }
  if (!msg || !msg.type) return;

  // Read-only sessions cannot mutate device state via the websocket.
  if (ws._role && ws._role !== 'admin') {
    wsSend(ws, { type: 'override-error', message: 'Admin role required' });
    return;
  }

  if (msg.type === 'override-enter') {
    handleOverrideEnter(ws, msg);
  } else if (msg.type === 'override-exit') {
    handleOverrideExit(ws);
  } else if (msg.type === 'override-update') {
    handleOverrideUpdate(ws, msg);
  } else if (msg.type === 'override-set-mode') {
    handleOverrideSetMode(ws, msg);
  } else if (msg.type === 'relay-command') {
    handleRelayCommand(ws, msg);
  }
}

function handleOverrideEnter(ws, msg) {
  const cfg = deviceConfig.getConfig();
  if (!cfg.ce) {
    wsSend(ws, { type: 'override-error', message: 'Controls not enabled' });
    return;
  }

  // fm is REQUIRED — hard-override (2026-04-21): automation fully
  // suspended while active, so the user must pick a concrete mode.
  const fm = msg.forcedMode;
  if (typeof fm !== 'string' || VALID_MODES.indexOf(fm) === -1) {
    wsSend(ws, { type: 'override-error', message: 'forcedMode required: one of I,SC,GH,AD,EH' });
    return;
  }

  const ttl = Math.max(60, Math.min(3600, parseInt(msg.ttl, 10) || 300));
  const ex = Math.floor(Date.now() / 1000) + ttl;

  deviceConfig.updateConfig({ mo: { a: true, ex, fm } }, function (err, updated, prev) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: true, expiresAt: ex, forcedMode: fm });
    emitConfigEvents(_db, log, prev, updated, 'ws_override', ws._userName || 'admin');
    scheduleOverrideTtl(ttl);
  });
}

function handleOverrideExit(ws) {
  clearOverrideTtlTimer();
  deviceConfig.updateConfig({ mo: null }, function (err, updated, prev) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: false, forcedMode: null });
    emitConfigEvents(_db, log, prev, updated, 'ws_override', ws._userName || 'admin');
  });
}

function handleOverrideUpdate(ws, msg) {
  const cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }

  const ttl = Math.max(60, Math.min(3600, parseInt(msg.ttl, 10) || 300));
  const ex = Math.floor(Date.now() / 1000) + ttl;

  const newMo = { a: cfg.mo.a, ex, fm: cfg.mo.fm };
  deviceConfig.updateConfig({ mo: newMo }, function (err, updated, prev) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: true, expiresAt: ex, forcedMode: (updated.mo && updated.mo.fm) || null });
    emitConfigEvents(_db, log, prev, updated, 'ws_override', ws._userName || 'admin');
    scheduleOverrideTtl(ttl);
  });
}

function handleOverrideSetMode(ws, msg) {
  const cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }

  const mode = msg.mode;
  if (typeof mode !== 'string' || VALID_MODES.indexOf(mode) === -1) {
    wsSend(ws, { type: 'override-error', message: 'mode required: one of I,SC,GH,AD,EH' });
    return;
  }
  if (cfg.wb && cfg.wb[mode] && cfg.wb[mode] > Math.floor(Date.now() / 1000)) {
    wsSend(ws, { type: 'override-error', message: 'Mode banned' });
    return;
  }

  const newMo = { a: cfg.mo.a, ex: cfg.mo.ex, fm: mode };

  deviceConfig.updateConfig({ mo: newMo }, function (err, updated) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, {
      type: 'override-ack',
      active: true,
      expiresAt: updated.mo.ex,
      forcedMode: updated.mo.fm || null,
    });
  });
}

function handleRelayCommand(ws, msg) {
  const cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  if (cfg.mo.ex <= now) {
    wsSend(ws, { type: 'override-error', message: 'Override expired' });
    return;
  }
  if (VALID_RELAYS.indexOf(msg.relay) < 0) {
    wsSend(ws, { type: 'override-error', message: 'Unknown relay: ' + msg.relay });
    return;
  }
  mqttBridge.publishRelayCommand(msg.relay, !!msg.on);
}

function clearOverrideTtlTimer() {
  if (overrideTtlTimer) {
    clearTimeout(overrideTtlTimer);
    overrideTtlTimer = null;
  }
}

module.exports = { handleWsCommand, setDb };
