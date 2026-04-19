/**
 * Sensor configuration store.
 * Manages sensor-to-role assignments and sensor host metadata.
 * S3/local persistence following the same adapter pattern as device-config.
 * Provides GET/PUT/POST HTTP handlers for sensor config.
 */

var fs = require('fs');
var path = require('path');
var createLogger = require('./logger');
var log = createLogger('sensor-config');

var s3Client = null;
var s3Config = null;
var currentConfig = null;

// Sensor roles derived from system.yaml
var SENSOR_ROLES = [
  { name: 'collector', label: 'Collector Outlet', location: 'collector outlet, ~280cm', optional: false },
  { name: 'tank_top', label: 'Tank Top', location: 'tank upper region, ~180cm', optional: false },
  { name: 'tank_bottom', label: 'Tank Bottom', location: 'tank lower region, ~10cm', optional: false },
  { name: 'greenhouse', label: 'Greenhouse Air', location: 'greenhouse air', optional: false },
  { name: 'outdoor', label: 'Outdoor', location: 'outside, shaded', optional: false },
  { name: 'radiator_in', label: 'Radiator Inlet', location: 'radiator inlet', optional: true },
  { name: 'radiator_out', label: 'Radiator Outlet', location: 'radiator outlet', optional: true },
];

function buildDefaultConfig() {
  var ips = (process.env.SENSOR_HOST_IPS || '').split(',').filter(Boolean);
  var hosts = ips.map(function (ip, idx) {
    return { id: 'sensor_' + (idx + 1), ip: ip.trim(), name: 'Sensor Hub ' + (idx + 1) };
  });
  return {
    hosts: hosts,
    assignments: {},
    version: 0,
  };
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
    key: 'sensor-config.json',
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
  return process.env.SENSOR_CONFIG_PATH || path.join(__dirname, '..', 'sensor-config.json');
}

// Ensure persisted config has up-to-date hosts from SENSOR_HOST_IPS env var.
// Assignments and version are preserved; hosts are always derived from env.
function reconcileHosts(config) {
  var defaults = buildDefaultConfig();
  config.hosts = defaults.hosts;
  return config;
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
        currentConfig = reconcileHosts(JSON.parse(bodyStr));
        callback(null, currentConfig);
      } catch (e) {
        callback(new Error('Failed to parse sensor config JSON'));
      }
    }).catch(function (err) {
      if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
        currentConfig = buildDefaultConfig();
        callback(null, currentConfig);
      } else {
        callback(err);
      }
    });
  } else {
    var filePath = getLocalPath();
    try {
      var data = fs.readFileSync(filePath, 'utf8');
      currentConfig = reconcileHosts(JSON.parse(data));
      callback(null, currentConfig);
    } catch (err) {
      if (err.code === 'ENOENT') {
        currentConfig = buildDefaultConfig();
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
  return currentConfig || buildDefaultConfig();
}

// ── Validation ──

// Shelly's SensorAddon.OneWireScan returns 1-Wire addresses as colon-separated
// DECIMAL bytes (e.g. "40:208:87:71:0:0:0:120" — leading 40 = 0x28, the
// DS18B20 family code). Validate as 8 decimal bytes, each 0-255.
function isValidOneWireAddr(addr) {
  if (typeof addr !== 'string') return false;
  var parts = addr.split(':');
  if (parts.length !== 8) return false;
  for (var i = 0; i < 8; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false;
    var n = parseInt(parts[i], 10);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function validateAssignments(assignments, hosts) {
  var addrs = {};
  var components = {};
  for (var role in assignments) {
    var a = assignments[role];
    if (!a || !a.addr) continue;

    if (!isValidOneWireAddr(a.addr)) {
      return 'Invalid 1-Wire address format for ' + role + ': ' + a.addr;
    }

    // Validate component ID range
    if (typeof a.componentId !== 'number' || a.componentId < 100 || a.componentId > 199) {
      return 'Component ID must be 100-199 for ' + role + ': ' + a.componentId;
    }

    // Validate host index
    if (typeof a.hostIndex !== 'number' || a.hostIndex < 0 || a.hostIndex >= hosts.length) {
      return 'Invalid host index for ' + role + ': ' + a.hostIndex;
    }

    // Check duplicate addresses
    if (addrs[a.addr]) {
      return 'Duplicate sensor address ' + a.addr + ' assigned to both ' + addrs[a.addr] + ' and ' + role;
    }
    addrs[a.addr] = role;

    // Check duplicate component IDs within same host
    var compKey = a.hostIndex + ':' + a.componentId;
    if (components[compKey]) {
      return 'Duplicate component ID ' + a.componentId + ' on host ' + a.hostIndex + ' for both ' + components[compKey] + ' and ' + role;
    }
    components[compKey] = role;
  }
  return null;
}

function getUnassignedRequiredRoles(assignments) {
  var missing = [];
  for (var i = 0; i < SENSOR_ROLES.length; i++) {
    var r = SENSOR_ROLES[i];
    if (!r.optional && (!assignments[r.name] || !assignments[r.name].addr)) {
      missing.push(r.name);
    }
  }
  return missing;
}

function updateAssignments(newAssignments, callback) {
  var config = getConfig();
  var error = validateAssignments(newAssignments, config.hosts);
  if (error) {
    callback(new Error(error));
    return;
  }
  config.assignments = newAssignments;
  config.version = (config.version || 0) + 1;
  save(config, function (err) {
    if (err) { callback(err); return; }
    callback(null, config);
  });
}

// ── Compact format for Shelly KVS ──

function toCompactFormat(config) {
  var compact = { s: {}, h: [], v: config.version };
  for (var i = 0; i < config.hosts.length; i++) {
    compact.h.push(config.hosts[i].ip);
  }
  for (var role in config.assignments) {
    var a = config.assignments[role];
    if (a && a.addr) {
      // `a` (addr) is required by SensorAddon.AddPeripheral to bind a specific
      // physical probe to the chosen component ID. Without it the Add-on
      // creates an empty peripheral slot and polls return no temperature.
      compact.s[role] = { h: a.hostIndex, i: a.componentId, a: a.addr };
    }
  }
  return compact;
}

// ── Apply to sensor hosts via MQTT (routed through Shelly controller) ──

function applyConfig(mqttBridge, callback) {
  var config = getConfig();
  if (!mqttBridge) {
    callback(new Error('MQTT bridge not available'));
    return;
  }

  var compact = toCompactFormat(config);
  var request = {
    id: 'apply-' + Date.now(),
    target: null,
    config: compact,
  };

  mqttBridge.publishSensorConfigApply(request).then(function (result) {
    // Also publish the sensor routing config for the controller's own use
    mqttBridge.publishSensorConfig(compact);

    // Convert MQTT response to the existing results format
    var results = {};
    if (result.results) {
      for (var i = 0; i < result.results.length; i++) {
        var r = result.results[i];
        var hostInfo = config.hosts.find(function (h) { return h.ip === r.host; });
        var hostId = hostInfo ? hostInfo.id : r.host;
        results[hostId] = r.ok
          ? { status: 'success', message: r.peripherals + ' sensors configured' }
          : { status: 'error', message: r.error || 'Failed' };
      }
    }
    results.control = { status: 'success', message: 'Sensor routing published' };
    callback(null, results);
  }).catch(function (err) {
    callback(err);
  });
}

function applySingleTarget(targetId, mqttBridge, callback) {
  var config = getConfig();

  if (targetId === 'control') {
    if (mqttBridge) {
      var ok = mqttBridge.publishSensorConfig(toCompactFormat(config));
      callback(null, { control: ok
        ? { status: 'success', message: 'Sensor routing published' }
        : { status: 'error', message: 'MQTT not connected' } });
    } else {
      callback(null, { control: { status: 'error', message: 'MQTT bridge not available' } });
    }
    return;
  }

  if (!mqttBridge) {
    callback(new Error('MQTT bridge not available'));
    return;
  }

  // Find host by id
  var host = null;
  for (var i = 0; i < config.hosts.length; i++) {
    if (config.hosts[i].id === targetId) {
      host = config.hosts[i];
      break;
    }
  }
  if (!host) {
    callback(new Error('Unknown target: ' + targetId));
    return;
  }

  var compact = toCompactFormat(config);
  var request = {
    id: 'apply-' + Date.now(),
    target: host.ip,
    config: compact,
  };

  mqttBridge.publishSensorConfigApply(request).then(function (result) {
    var results = {};
    if (result.results) {
      for (var j = 0; j < result.results.length; j++) {
        var r = result.results[j];
        results[host.id] = r.ok
          ? { status: 'success', message: r.peripherals + ' sensors configured' }
          : { status: 'error', message: r.error || 'Failed' };
      }
    }
    callback(null, results);
  }).catch(function (err) {
    callback(err);
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

  if (!parsed.assignments || typeof parsed.assignments !== 'object') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing assignments object' }));
    return;
  }

  updateAssignments(parsed.assignments, function (err, config) {
    if (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    log.info('sensor config updated', { version: config.version });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(config));

    if (onUpdate) onUpdate(config);
  });
}

function handleApply(req, res, mqttBridge) {
  applyConfig(mqttBridge, function (err, results) {
    if (err) {
      var statusCode = err.message === 'Request timed out' ? 504 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message === 'Request timed out' ? 'Config apply timed out' : err.message }));
      return;
    }
    log.info('sensor config applied', { results: results });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: results }));
  });
}

function handleApplyTarget(req, res, targetId, mqttBridge) {
  applySingleTarget(targetId, mqttBridge, function (err, results) {
    if (err) {
      var statusCode = err.message === 'Request timed out' ? 504 : 400;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message === 'Request timed out' ? 'Config apply timed out' : err.message }));
      return;
    }
    log.info('sensor config applied to target', { target: targetId, results: results });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results: results }));
  });
}

function _reset() {
  s3Client = null;
  s3Config = null;
  currentConfig = null;
}

module.exports = {
  SENSOR_ROLES: SENSOR_ROLES,
  buildDefaultConfig: buildDefaultConfig,
  load: load,
  save: save,
  getConfig: getConfig,
  updateAssignments: updateAssignments,
  validateAssignments: validateAssignments,
  getUnassignedRequiredRoles: getUnassignedRequiredRoles,
  toCompactFormat: toCompactFormat,
  handleGet: handleGet,
  handlePut: handlePut,
  handleApply: handleApply,
  handleApplyTarget: handleApplyTarget,
  applyConfig: applyConfig,
  applySingleTarget: applySingleTarget,
  _reset: _reset,
};
