// Device configuration store. S3/local persistence, GET/PUT HTTP handlers.

const fs = require('fs');
const path = require('path');
const createLogger = require('./logger');
const s3Helper = require('./s3-config-helper');
const { VALID_MODES, WATCHDOG_IDS } = require('./mode-constants');
const { TUNING_KEYS } = require('../../shelly/control-logic.js');

const log = createLogger('device-config');
const S3_KEY = 'device-config.json';

let currentConfig = null;

// Compact keys to fit Shelly KVS 256-byte limit:
//   ce = controls_enabled (bool)
//   ea = enabled_actuators bitmask (valves=1, pump=2, fan=4, sh=8, ih=16)
//   we = watchdogs_enabled ({sng:1, scs:1, ggr:1} — first-boot empty)
//   wz = watchdog_snooze ({sng:<unix>, ...} — absent = not snoozed)
//   wb = mode_bans ({SC:<unix>, GH:9999999999, ...} — sentinel = permanent)
//   mo = manual override session ({a, ex, fm?} or null)
//   tu = tuning thresholds (sparse — keys absent fall back to control-
//        logic.js DEFAULT_CONFIG constants). See TUNING_RANGES below
//        for the validated set.
//   v  = version (int)
const DEFAULT_CONFIG = {
  ce: false,
  ea: 0,
  we: {},
  wz: {},
  wb: {},
  tu: {},
  v: 1,
};

const WB_PERMANENT_SENTINEL = 9999999999;

// Hard clamp + invariant ranges for the user-tunable thresholds in
// `tu`. Long-name mapping lives in shelly/control-logic.js TUNING_KEYS;
// keys here MUST line up. Values outside [min,max] are clamped (and the
// clamped value is what the response carries — UI sees the actual saved
// value). Invariants (gxT > geT, fcE > fcX) are rejected with 400.
const TUNING_RANGES = {
  geT: { min: 0,  max: 25,  step: 0.5, label: 'Greenhouse heat enter (°C)' },
  gxT: { min: 1,  max: 30,  step: 0.5, label: 'Greenhouse heat exit (°C)' },
  fcE: { min: 20, max: 50,  step: 0.5, label: 'Fan-cool enter (°C)' },
  fcX: { min: 15, max: 50,  step: 0.5, label: 'Fan-cool exit (°C)' },
  frT: { min: 0,  max: 10,  step: 0.5, label: 'Freeze drain (°C)' },
  ohT: { min: 70, max: 100, step: 1,   label: 'Overheat drain (°C)' },
};
const TUNING_SHORT_KEYS = Object.keys(TUNING_RANGES);

function clampTuningValue(key, value) {
  const range = TUNING_RANGES[key];
  if (!range) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < range.min) return range.min;
  if (value > range.max) return range.max;
  return value;
}

// Resolve the effective tuning values for invariant checks: pull from
// `tu` when present, otherwise fall back to the control-logic.js
// DEFAULT_CONFIG constant via TUNING_KEYS. Lazy-loaded to avoid a
// circular-import gotcha at module-eval time (control-logic.js is a
// pure leaf, but some tests stub the require cache around it).
function effectiveTuning(tu) {
  const cl = require('../../shelly/control-logic.js');
  const out = {};
  for (let i = 0; i < TUNING_SHORT_KEYS.length; i++) {
    const k = TUNING_SHORT_KEYS[i];
    out[k] = (tu && typeof tu[k] === 'number')
      ? tu[k]
      : cl.DEFAULT_CONFIG[TUNING_KEYS[k]];
  }
  return out;
}

function getLocalPath() {
  return process.env.DEVICE_CONFIG_PATH || path.join(__dirname, '..', 'device-config.json');
}

function load(callback) {
  if (s3Helper.isS3Enabled()) {
    const s3 = s3Helper.getS3CredsConfig();
    const { GetObjectCommand } = require('./s3-client');
    s3Helper.getS3Client().send(new GetObjectCommand({ Bucket: s3.bucket, Key: S3_KEY }))
      .then(function (response) { return response.Body.transformToString(); })
      .then(function (bodyStr) {
        try {
          currentConfig = JSON.parse(bodyStr);
          callback(null, currentConfig);
        } catch (e) {
          callback(new Error('Failed to parse device config JSON'));
        }
      })
      .catch(function (err) {
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
      currentConfig = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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
  if (s3Helper.isS3Enabled()) {
    const s3 = s3Helper.getS3CredsConfig();
    const { PutObjectCommand } = require('./s3-client');
    s3Helper.getS3Client().send(new PutObjectCommand({
      Bucket: s3.bucket,
      Key: S3_KEY,
      Body: JSON.stringify(config, null, 2),
      ContentType: 'application/json',
    }))
      .then(function () { callback(null); })
      .catch(callback);
  } else {
    const filePath = getLocalPath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  // prevConfig is passed back so callers can diff for audit logs without
  // re-reading after the mutation. config itself is mutated in place.
  const prevConfig = deepCopy(config);
  const beforeSnapshot = JSON.stringify(stripVersion(config));

  if (newConfig.ce !== undefined) {
    config.ce = !!newConfig.ce;
  }
  if (newConfig.ea !== undefined) {
    config.ea = parseInt(newConfig.ea, 10) || 0;
  }
  if (newConfig.we !== undefined) {
    if (newConfig.we === null) {
      config.we = {};
    } else if (typeof newConfig.we === 'object') {
      const we = {};
      for (let i = 0; i < WATCHDOG_IDS.length; i++) {
        const id = WATCHDOG_IDS[i];
        if (newConfig.we[id] !== undefined) {
          we[id] = newConfig.we[id] ? 1 : 0;
        } else if (config.we && config.we[id] !== undefined) {
          we[id] = config.we[id];
        }
      }
      config.we = we;
    }
  }

  if (newConfig.wz !== undefined) {
    if (newConfig.wz === null) {
      config.wz = {};
    } else if (typeof newConfig.wz === 'object') {
      config.wz = config.wz || {};
      for (let i = 0; i < WATCHDOG_IDS.length; i++) {
        const id = WATCHDOG_IDS[i];
        const v = newConfig.wz[id];
        if (v === 0 || v === null) {
          delete config.wz[id];
        } else if (typeof v === 'number' && v > 0) {
          config.wz[id] = v;
        }
      }
    }
  }

  // wb sentinel 9999999999 = user-set permanent ban. 0/null clears one key;
  // null for the whole field clears all.
  if (newConfig.wb !== undefined) {
    if (newConfig.wb === null) {
      config.wb = {};
    } else if (typeof newConfig.wb === 'object') {
      config.wb = config.wb || {};
      for (let i = 0; i < VALID_MODES.length; i++) {
        const k = VALID_MODES[i];
        const v = newConfig.wb[k];
        if (v === 0 || v === null) {
          delete config.wb[k];
        } else if (typeof v === 'number' && v > 0) {
          config.wb[k] = v;
        }
      }
    }
  }

  // tu: sparse map of compact tuning keys (geT, gxT, fcE, fcX, frT,
  // ohT) -> Celsius. null clears all tuning; 0/null per key clears
  // that one entry and falls back to the control-logic constant.
  // Out-of-range numbers are clamped to TUNING_RANGES[k] (the response
  // body carries the clamped value so the UI can re-display it).
  // Invariant violations (gxT must exceed geT, fcE must exceed fcX)
  // reject the whole PUT with a 400.
  if (newConfig.tu !== undefined) {
    if (newConfig.tu === null) {
      config.tu = {};
    } else if (typeof newConfig.tu === 'object') {
      config.tu = config.tu || {};
      for (let i = 0; i < TUNING_SHORT_KEYS.length; i++) {
        const k = TUNING_SHORT_KEYS[i];
        if (!Object.prototype.hasOwnProperty.call(newConfig.tu, k)) continue;
        const raw = newConfig.tu[k];
        if (raw === null) {
          delete config.tu[k];
        } else if (typeof raw === 'number') {
          const clamped = clampTuningValue(k, raw);
          if (clamped === null) {
            callback(validationError('tu.' + k + ' must be a finite number'));
            return;
          }
          config.tu[k] = clamped;
        } else {
          callback(validationError('tu.' + k + ' must be a number or null'));
          return;
        }
      }
      // Invariants computed against the *effective* values (any key
      // not in tu falls through to its control-logic constant).
      const effective = effectiveTuning(config.tu);
      if (effective.gxT <= effective.geT) {
        callback(validationError(
          'tu invariant violated: greenhouse heat exit (' + effective.gxT +
          ') must be greater than enter (' + effective.geT + ')'
        ));
        return;
      }
      if (effective.fcE <= effective.fcX) {
        callback(validationError(
          'tu invariant violated: fan-cool enter (' + effective.fcE +
          ') must be greater than exit (' + effective.fcX + ')'
        ));
        return;
      }
    }
  }

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
        callback(validationError('mo.ss is not supported — override now always blocks automation'));
        return;
      }
      if (mo.a) {
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

  // Reject configs that would exceed the Shelly KVS 256-byte cap before
  // we persist them. Without this guard the server would happily save a
  // 271-byte config to S3, then the controller's KVS.Set would fail and
  // it'd be left running on stale config silently. Worst-case shape =
  // every watchdog snoozed + every mode banned + manual override active
  // + all six tu thresholds set; realistic users stay well under.
  const projectedSize = JSON.stringify(Object.assign({}, config, { v: (config.v || 0) + 1 })).length;
  if (projectedSize > 256) {
    callback(validationError(
      'Config too large: ' + projectedSize + ' bytes exceeds the 256-byte Shelly KVS cap. ' +
      'Clear unused tuning thresholds, watchdog snoozes, or mode bans.'
    ));
    return;
  }

  // Skip the S3 write + MQTT republish if nothing actually changed.
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

function handleGet(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(getConfig()));
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
  s3Helper._reset();
  currentConfig = null;
}

function loadForTest(cfg) {
  currentConfig = deepCopy(cfg);
}

module.exports = {
  DEFAULT_CONFIG,
  WB_PERMANENT_SENTINEL,
  TUNING_RANGES,
  load,
  save,
  getConfig,
  updateConfig,
  handleGet,
  handlePut,
  _reset,
  loadForTest,
};
