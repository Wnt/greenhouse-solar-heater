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

var DEFAULT_CONFIG = {
  controls_enabled: false,
  enabled_actuators: {
    valves: false,
    pump: false,
    fan: false,
    space_heater: false,
    immersion_heater: false,
  },
  forced_mode: null,
  allowed_modes: null,
  version: 1,
};

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
        currentConfig = JSON.parse(bodyStr);
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
      currentConfig = JSON.parse(data);
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
      fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
      callback(null);
    } catch (err) {
      callback(err);
    }
  }
}

function getConfig() {
  return currentConfig || deepCopy(DEFAULT_CONFIG);
}

function updateConfig(newConfig, callback) {
  var config = getConfig();
  if (newConfig.controls_enabled !== undefined) {
    config.controls_enabled = !!newConfig.controls_enabled;
  }
  if (newConfig.enabled_actuators) {
    var ea = newConfig.enabled_actuators;
    if (!config.enabled_actuators) config.enabled_actuators = {};
    var keys = ['valves', 'pump', 'fan', 'space_heater', 'immersion_heater'];
    for (var i = 0; i < keys.length; i++) {
      if (ea[keys[i]] !== undefined) {
        config.enabled_actuators[keys[i]] = !!ea[keys[i]];
      }
    }
  }
  if (newConfig.forced_mode !== undefined) {
    config.forced_mode = newConfig.forced_mode || null;
  }
  if (newConfig.allowed_modes !== undefined) {
    var am = newConfig.allowed_modes;
    // null or all 5 modes = unrestricted; normalize to null to save KVS space
    if (!Array.isArray(am) || am.length === 0 || am.length >= 5) {
      config.allowed_modes = null;
    } else {
      config.allowed_modes = am;
    }
  }
  config.version = (config.version || 0) + 1;
  save(config, function (err) {
    if (err) { callback(err); return; }
    callback(null, config);
  });
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
      log.error('failed to update config', { error: err.message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to save config' }));
      return;
    }

    log.info('config updated', { version: config.version });
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

module.exports = {
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  load: load,
  save: save,
  getConfig: getConfig,
  updateConfig: updateConfig,
  handleGet: handleGet,
  handlePut: handlePut,
  _reset: _reset,
};
