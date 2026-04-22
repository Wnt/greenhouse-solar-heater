// WebSocket command handlers — manual override + relay commands.
// Extracted from server.js.
//
// Exports:
//   handleWsCommand(ws, data)  — top-level dispatch (validates role).
//   clearOverrideTtlTimer()    — server-side TTL cleanup, called from
//                                shutdown/hot-reload paths.

const mqttBridge = require('./mqtt-bridge');
const deviceConfig = require('./device-config');

const VALID_RELAYS = ['vi_btm', 'vi_top', 'vi_coll', 'vo_coll', 'vo_rad', 'vo_tank', 'v_air', 'pump', 'fan'];
let overrideTtlTimer = null;

function wsSend(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function handleWsCommand(ws, data) {
  var msg;
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
  var cfg = deviceConfig.getConfig();
  if (!cfg.ce) {
    wsSend(ws, { type: 'override-error', message: 'Controls not enabled' });
    return;
  }

  // `fm` is REQUIRED when entering override (2026-04-21 hard-override
  // semantics): automation is fully suspended for the duration, so the
  // user must pick a concrete mode. The old "Automatic" state (fm=null
  // while mo.a=true) is gone.
  var VALID_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];
  var fm = msg.forcedMode;
  if (typeof fm !== 'string' || VALID_MODES.indexOf(fm) === -1) {
    wsSend(ws, { type: 'override-error', message: 'forcedMode required: one of I,SC,GH,AD,EH' });
    return;
  }

  var ttl = Math.max(60, Math.min(3600, parseInt(msg.ttl, 10) || 300));
  var ex = Math.floor(Date.now() / 1000) + ttl;

  deviceConfig.updateConfig({ mo: { a: true, ex: ex, fm: fm } }, function (err, updated) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: true, expiresAt: ex, forcedMode: fm });

    // Secondary server-side TTL tracking
    clearOverrideTtlTimer();
    overrideTtlTimer = setTimeout(function () {
      overrideTtlTimer = null;
      var current = deviceConfig.getConfig();
      if (current.mo && current.mo.a) {
        deviceConfig.updateConfig({ mo: null }, function (err2, cleared) {
          if (!err2) mqttBridge.publishConfig(cleared);
        });
      }
    }, ttl * 1000);
  });
}

function handleOverrideExit(ws) {
  clearOverrideTtlTimer();
  deviceConfig.updateConfig({ mo: null }, function (err, updated) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: false, forcedMode: null });
  });
}

function handleOverrideUpdate(ws, msg) {
  var cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }

  var ttl = Math.max(60, Math.min(3600, parseInt(msg.ttl, 10) || 300));
  var ex = Math.floor(Date.now() / 1000) + ttl;

  var newMo = { a: cfg.mo.a, ex: ex, fm: cfg.mo.fm };
  deviceConfig.updateConfig({ mo: newMo }, function (err, updated) {
    if (err) {
      wsSend(ws, { type: 'override-error', message: err.message });
      return;
    }
    mqttBridge.publishConfig(updated);
    wsSend(ws, { type: 'override-ack', active: true, expiresAt: ex, forcedMode: (updated.mo && updated.mo.fm) || null });

    // Reset secondary TTL timer
    clearOverrideTtlTimer();
    overrideTtlTimer = setTimeout(function () {
      overrideTtlTimer = null;
      var current = deviceConfig.getConfig();
      if (current.mo && current.mo.a) {
        deviceConfig.updateConfig({ mo: null }, function (err2, cleared) {
          if (!err2) mqttBridge.publishConfig(cleared);
        });
      }
    }, ttl * 1000);
  });
}

function handleOverrideSetMode(ws, msg) {
  var cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }

  var mode = msg.mode;
  var VALID_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];
  // With hard override, `fm` is required while active. Null/omit is no
  // longer a legal state — server rejects it. If the user wants
  // automation back, they must exit override.
  if (typeof mode !== 'string' || VALID_MODES.indexOf(mode) === -1) {
    wsSend(ws, { type: 'override-error', message: 'mode required: one of I,SC,GH,AD,EH' });
    return;
  }
  if (cfg.wb && cfg.wb[mode] && cfg.wb[mode] > Math.floor(Date.now() / 1000)) {
    wsSend(ws, { type: 'override-error', message: 'Mode banned' });
    return;
  }

  var newMo = { a: cfg.mo.a, ex: cfg.mo.ex, fm: mode };

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
  var cfg = deviceConfig.getConfig();
  if (!cfg.mo || !cfg.mo.a) {
    wsSend(ws, { type: 'override-error', message: 'Override not active' });
    return;
  }
  var now = Math.floor(Date.now() / 1000);
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

module.exports = { handleWsCommand };
