/**
 * Device configuration store.
 * S3/local persistence following the same adapter pattern as credentials.
 * Provides GET/PUT HTTP handlers for device config.
 */

var fs = require('fs');
var path = require('path');
var createLogger = require('./logger');
var log = createLogger('device-config');

var s3Client = null;
var s3Config = null;
var currentConfig = null;

// Compact keys to fit Shelly KVS 256-byte limit:
//   ce = controls_enabled (bool)
//   ea = enabled_actuators bitmask (valves=1, pump=2, fan=4, sh=8, ih=16)
//   we = watchdogs_enabled ({sng:1, scs:1, ggr:1} — first-boot empty)
//   wz = watchdog_snooze ({sng:<unix>, ...} — absent = not snoozed)
//   wb = mode_bans ({SC:<unix>, GH:9999999999, ...} — sentinel = permanent)
//   mo = manual override session ({a, ex, ss, fm?} or null)
//        fm is optional, only valid when a === true
//   v  = version (int)
var DEFAULT_CONFIG = {
  ce: false,
  ea: 0,
  we: {},
  wz: {},
  wb: {},
  v: 1,
};

// Migration helper: translate legacy `am` (allowed modes) array into
// `wb` entries with the permanent sentinel timestamp. Called on every
// config load — idempotent by design. Once migrated, the `am` field is
// deleted so it never round-trips back to the device.
var ALL_MODES_FOR_MIGRATION = ['I', 'SC', 'GH', 'AD', 'EH'];
var WB_PERMANENT_SENTINEL = 9999999999;

function migrateAmToWb(cfg) {
  if (cfg.am && Array.isArray(cfg.am) &&
      cfg.am.length > 0 && cfg.am.length < ALL_MODES_FOR_MIGRATION.length) {
    cfg.wb = cfg.wb || {};
    for (var i = 0; i < ALL_MODES_FOR_MIGRATION.length; i++) {
      var mode = ALL_MODES_FOR_MIGRATION[i];
      if (cfg.am.indexOf(mode) === -1) {
        cfg.wb[mode] = WB_PERMANENT_SENTINEL;
      }
    }
  }
  delete cfg.am;
  return cfg;
}

function stripLegacyFm(cfg) {
  if (cfg && cfg.fm !== undefined) delete cfg.fm;
  return cfg;
}

function getS3Config() {
  if (s3Config) return s3Config;
  var endpoint = process.env.S3_ENDPOINT;
  var bucket = process.env.S3_BUCKET;
  var accessKeyId = process.env.S3_ACCESS_KEY_ID;
  var secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  s3Config = {
    endpoint: endpoint,
    bucket: bucket,
    region: process.env.S3_REGION || 'europe-1',
    credentials: { accessKeyId: accessKeyId, secretAccessKey: secretAccessKey },
    key: 'device-config.json',
  };
  return s3Config;
}

function isS3Enabled() {
  return getS3Config() !== null;
}

function getS3Client() {
  if (s3Client) return s3Client;
  var config = getS3Config();
  var S3Client = require('@aws-sdk/client-s3').S3Client;
  s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: config.credentials,
    forcePathStyle: true,
  });
  return s3Client;
}

function getLocalPath() {
  return process.env.DEVICE_CONFIG_PATH || path.join(__dirname, '..', 'device-config.json');
}

function load(callback) {
  if (isS3Enabled()) {
    var config = getS3Config();
    var GetObjectCommand = require('@aws-sdk/client-s3').GetObjectCommand;
    var client = getS3Client();
    var cmd = new GetObjectCommand({ Bucket: config.bucket, Key: config.key });
    client.send(cmd).then(function (response) {
      return response.Body.transformToString();
    }).then(function (bodyStr) {
      try {
        currentConfig = migrateAmToWb(JSON.parse(bodyStr));
        stripLegacyFm(currentConfig);
        callback(null, currentConfig);
      } catch (e) {
        callback(new Error('Failed to parse device config JSON'));
      }
    }).catch(function (err) {
      if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
        currentConfig = deepCopy(DEFAULT_CONFIG);
        callback(null, currentConfig);
      } else {
        callback(err);
      }
    });
  } else {
    var filePath = getLocalPath();
    try {
      var data = fs.readFileSync(filePath, 'utf8');
      currentConfig = migrateAmToWb(JSON.parse(data));
      stripLegacyFm(currentConfig);
      callback(null, currentConfig);
    } catch (err) {
      if (err.code === 'ENOENT') {
        currentConfig = deepCopy(DEFAULT_CONFIG);
        callback(null, currentConfig);
      } else {
        callback(err);
      }
    }
  }
}

function save(config, callback) {
  currentConfig = config;
  if (isS3Enabled()) {
    var s3Cfg = getS3Config();
    var PutObjectCommand = require('@aws-sdk/client-s3').PutObjectCommand;
    var client = getS3Client();
    var cmd = new PutObjectCommand({
      Bucket: s3Cfg.bucket,
      Key: s3Cfg.key,
      Body: JSON.stringify(config, null, 2),
      ContentType: 'application/json',
    });
    client.send(cmd).then(function () {
      callback(null);
    }).catch(function (err) {
      callback(err);
    });
  } else {
    var filePath = getLocalPath();
    var dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      var tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
      fs.renameSync(tmpPath, filePath);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

function getConfig() {
  return currentConfig || deepCopy(DEFAULT_CONFIG);
}

function validationError(message) {
  var err = new Error(message);
  err.code = 'VALIDATION';
  return err;
}

function updateConfig(newConfig, callback) {
  var config = getConfig();
  // Snapshot for no-op detection (compare BEFORE mutating)
  var beforeSnapshot = JSON.stringify(stripVersion(config));

  if (newConfig.ce !== undefined) {
    config.ce = !!newConfig.ce;
  }
  if (newConfig.ea !== undefined) {
    config.ea = parseInt(newConfig.ea, 10) || 0;
  }
  // we (watchdogs_enabled): object with 0/1 values per watchdog id.
  // null clears all; unknown ids are silently dropped.
  if (newConfig.we !== undefined) {
    if (newConfig.we === null) {
      config.we = {};
    } else if (typeof newConfig.we === 'object') {
      var we = {};
      var weIds = ['sng', 'scs', 'ggr'];
      for (var wi = 0; wi < weIds.length; wi++) {
        var weId = weIds[wi];
        if (newConfig.we[weId] !== undefined) {
          we[weId] = newConfig.we[weId] ? 1 : 0;
        } else if (config.we && config.we[weId] !== undefined) {
          we[weId] = config.we[weId];
        }
      }
      config.we = we;
    }
  }

  // wz (watchdog_snooze): object with unix-seconds values.
  // null clears all; 0 or null for a specific key removes that entry.
  if (newConfig.wz !== undefined) {
    if (newConfig.wz === null) {
      config.wz = {};
    } else if (typeof newConfig.wz === 'object') {
      config.wz = config.wz || {};
      var wzIds = ['sng', 'scs', 'ggr'];
      for (var zi = 0; zi < wzIds.length; zi++) {
        var wzId = wzIds[zi];
        var wzVal = newConfig.wz[wzId];
        if (wzVal === 0 || wzVal === null) {
          delete config.wz[wzId];
        } else if (typeof wzVal === 'number' && wzVal > 0) {
          config.wz[wzId] = wzVal;
        }
      }
    }
  }

  // wb (mode_bans): object with unix-seconds values. Sentinel 9999999999
  // represents a user-set permanent ban. 0 or null for a specific key
  // removes that entry. null for the field clears all bans.
  if (newConfig.wb !== undefined) {
    if (newConfig.wb === null) {
      config.wb = {};
    } else if (typeof newConfig.wb === 'object') {
      config.wb = config.wb || {};
      var wbKeys = ['I', 'SC', 'GH', 'AD', 'EH'];
      for (var bi = 0; bi < wbKeys.length; bi++) {
        var wbKey = wbKeys[bi];
        var wbVal = newConfig.wb[wbKey];
        if (wbVal === 0 || wbVal === null) {
          delete config.wb[wbKey];
        } else if (typeof wbVal === 'number' && wbVal > 0) {
          config.wb[wbKey] = wbVal;
        }
      }
    }
  }
  // Manual override session
  if (newConfig.mo !== undefined) {
    if (newConfig.mo === null) {
      config.mo = null;
    } else if (typeof newConfig.mo === 'object') {
      var mo = newConfig.mo;
      if (typeof mo.a !== 'boolean' || typeof mo.ex !== 'number' || typeof mo.ss !== 'boolean') {
        callback(validationError('Invalid mo: requires {a: bool, ex: int, ss: bool}'));
        return;
      }
      var newMo = { a: mo.a, ex: Math.floor(mo.ex), ss: mo.ss };
      if (mo.fm !== undefined && mo.fm !== null) {
        var VALID_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];
        if (VALID_MODES.indexOf(mo.fm) === -1) {
          callback(validationError('Invalid mo.fm: must be one of I,SC,GH,AD,EH'));
          return;
        }
        if (!mo.a) {
          callback(validationError('mo.fm cannot be set when mo.a is false'));
          return;
        }
        newMo.fm = mo.fm;
      }
      config.mo = newMo;
    }
  }

  // No-op detection: if nothing changed, return current config without bumping
  // version. Saves S3 writes and MQTT republishes for repeated identical PUTs.
  var afterSnapshot = JSON.stringify(stripVersion(config));
  if (afterSnapshot === beforeSnapshot) {
    callback(null, config);
    return;
  }

  config.v = (config.v || 0) + 1;
  save(config, function (err) {
    if (err) { callback(err); return; }
    callback(null, config);
  });
}

function stripVersion(cfg) {
  var copy = {};
  for (var k in cfg) {
    if (k !== 'v') copy[k] = cfg[k];
  }
  return copy;
}

// ── HTTP handlers ──

function handleGet(req, res) {
  var config = getConfig();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(config));
}

function handlePut(req, res, body, onUpdate) {
  var parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  updateConfig(parsed, function (err, config) {
    if (err) {
      // Validation errors are user-correctable — surface them as 400 with the
      // exact message so the UI can show it to the user.
      if (err.code === 'VALIDATION') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      log.error('failed to update config', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to save config' }));
      return;
    }

    log.info('config updated', { version: config.v });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));

    if (onUpdate) onUpdate(config);
  });
}

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function _reset() {
  s3Client = null;
  s3Config = null;
  currentConfig = null;
}

function loadForTest(cfg) {
  currentConfig = deepCopy(cfg);
  migrateAmToWb(currentConfig);
  stripLegacyFm(currentConfig);
}

module.exports = {
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  WB_PERMANENT_SENTINEL: WB_PERMANENT_SENTINEL,
  load: load,
  save: save,
  getConfig: getConfig,
  updateConfig: updateConfig,
  migrateAmToWb: migrateAmToWb,
  handleGet: handleGet,
  handlePut: handlePut,
  _reset: _reset,
  loadForTest: loadForTest,
};
