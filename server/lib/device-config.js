/**
 * Device configuration store.
 * S3/local persistence following the same adapter pattern as credentials.
 * Provides GET/PUT HTTP handlers for device config.
 */

const fs = require('fs');
const path = require('path');
const createLogger = require('./logger');
const log = createLogger('device-config');

let s3Client = null;
let s3Config = null;
let currentConfig = null;

// Compact keys to fit Shelly KVS 256-byte limit:
//   ce = controls_enabled (bool)
//   ea = enabled_actuators bitmask (valves=1, pump=2, fan=4, sh=8, ih=16)
//   we = watchdogs_enabled ({sng:1, scs:1, ggr:1} — first-boot empty)
//   wz = watchdog_snooze ({sng:<unix>, ...} — absent = not snoozed)
//   wb = mode_bans ({SC:<unix>, GH:9999999999, ...} — sentinel = permanent)
//   mo = manual override session ({a, ex, ss, fm?} or null)
//        fm is optional, only valid when a === true
//   v  = version (int)
const DEFAULT_CONFIG = {
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
const ALL_MODES_FOR_MIGRATION = ['I', 'SC', 'GH', 'AD', 'EH'];
const WB_PERMANENT_SENTINEL = 9999999999;

function migrateAmToWb(cfg) {
  if (cfg.am && Array.isArray(cfg.am) &&
      cfg.am.length > 0 && cfg.am.length < ALL_MODES_FOR_MIGRATION.length) {
    cfg.wb = cfg.wb || {};
    for (let i = 0; i < ALL_MODES_FOR_MIGRATION.length; i++) {
      const mode = ALL_MODES_FOR_MIGRATION[i];
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
  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  s3Config = {
    endpoint,
    bucket,
    region: process.env.S3_REGION || 'europe-1',
    credentials: { accessKeyId, secretAccessKey },
    key: 'device-config.json',
  };
  return s3Config;
}

function isS3Enabled() {
  return getS3Config() !== null;
}

function getS3Client() {
  if (s3Client) return s3Client;
  const config = getS3Config();
  const S3Client = require('./s3-client').S3Client;
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
    const config = getS3Config();
    const GetObjectCommand = require('./s3-client').GetObjectCommand;
    const client = getS3Client();
    const cmd = new GetObjectCommand({ Bucket: config.bucket, Key: config.key });
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
    const filePath = getLocalPath();
    try {
      const data = fs.readFileSync(filePath, 'utf8');
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
    const s3Cfg = getS3Config();
    const PutObjectCommand = require('./s3-client').PutObjectCommand;
    const client = getS3Client();
    const cmd = new PutObjectCommand({
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
    const filePath = getLocalPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      const tmpPath = filePath + '.tmp';
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
  const err = new Error(message);
  err.code = 'VALIDATION';
  return err;
}

function updateConfig(newConfig, callback) {
  const config = getConfig();
  // Deep-copy of the prior state — passed through the success callback
  // as the third arg so callers can diff (prev → updated) for audit
  // logging without re-fetching after the mutation. `config` is
  // mutated in place by the field-by-field assignments below, so a
  // shallow alias would silently track post-update values.
  const prevConfig = deepCopy(config);
  // Snapshot for no-op detection (compare BEFORE mutating)
  const beforeSnapshot = JSON.stringify(stripVersion(config));

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
      const we = {};
      const weIds = ['sng', 'scs', 'ggr'];
      for (let wi = 0; wi < weIds.length; wi++) {
        const weId = weIds[wi];
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
      const wzIds = ['sng', 'scs', 'ggr'];
      for (let zi = 0; zi < wzIds.length; zi++) {
        const wzId = wzIds[zi];
        const wzVal = newConfig.wz[wzId];
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
      const wbKeys = ['I', 'SC', 'GH', 'AD', 'EH'];
      for (let bi = 0; bi < wbKeys.length; bi++) {
        const wbKey = wbKeys[bi];
        const wbVal = newConfig.wb[wbKey];
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
      const mo = newConfig.mo;
      if (typeof mo.a !== 'boolean' || typeof mo.ex !== 'number') {
        callback(validationError('Invalid mo: requires {a: bool, ex: int, fm: string}'));
        return;
      }
      if (mo.ss !== undefined) {
        // ss was removed 2026-04-21 (hard override). Reject explicitly
        // so stale clients fail fast rather than silently losing it.
        callback(validationError('mo.ss is not supported — override now always blocks automation'));
        return;
      }
      if (mo.a) {
        const VALID_MODES = ['I', 'SC', 'GH', 'AD', 'EH'];
        if (typeof mo.fm !== 'string' || VALID_MODES.indexOf(mo.fm) === -1) {
          callback(validationError('mo.fm required when mo.a=true: one of I,SC,GH,AD,EH'));
          return;
        }
      } else if (mo.fm !== undefined && mo.fm !== null) {
        callback(validationError('mo.fm cannot be set when mo.a is false'));
        return;
      }
      const newMo = { a: mo.a, ex: Math.floor(mo.ex) };
      if (mo.a) newMo.fm = mo.fm;
      config.mo = newMo;
    }
  }

  // No-op detection: if nothing changed, return current config without bumping
  // version. Saves S3 writes and MQTT republishes for repeated identical PUTs.
  const afterSnapshot = JSON.stringify(stripVersion(config));
  if (afterSnapshot === beforeSnapshot) {
    callback(null, config, prevConfig);
    return;
  }

  config.v = (config.v || 0) + 1;
  save(config, function (err) {
    if (err) { callback(err); return; }
    callback(null, config, prevConfig);
  });
}

function stripVersion(cfg) {
  const copy = {};
  for (const k in cfg) {
    if (k !== 'v') copy[k] = cfg[k];
  }
  return copy;
}

// ── HTTP handlers ──

function handleGet(req, res) {
  const config = getConfig();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(config));
}

function handlePut(req, res, body, onUpdate) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  updateConfig(parsed, function (err, config, prevConfig) {
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

    if (onUpdate) onUpdate(config, prevConfig);
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
  DEFAULT_CONFIG,
  WB_PERMANENT_SENTINEL,
  load,
  save,
  getConfig,
  updateConfig,
  migrateAmToWb,
  handleGet,
  handlePut,
  _reset,
  loadForTest,
};
