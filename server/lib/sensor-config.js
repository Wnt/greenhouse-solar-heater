// Sensor configuration store: role→address assignments + host
// metadata. Same S3/local persistence shape as device-config.

const fs = require('fs');
const path = require('path');
const createLogger = require('./logger');
const s3Helper = require('./s3-config-helper');
const log = createLogger('sensor-config');

const S3_KEY = 'sensor-config.json';
let currentConfig = null;

const SENSOR_ROLES = [
  { name: 'collector', label: 'Collector Outlet', location: 'collector outlet, ~280cm', optional: false },
  { name: 'tank_top', label: 'Tank Top', location: 'tank upper region, ~180cm', optional: false },
  { name: 'tank_bottom', label: 'Tank Bottom', location: 'tank lower region, ~10cm', optional: false },
  { name: 'greenhouse', label: 'Greenhouse Air', location: 'greenhouse air', optional: false },
  { name: 'outdoor', label: 'Outdoor', location: 'outside, shaded', optional: false },
  { name: 'radiator_in', label: 'Radiator Inlet', location: 'radiator inlet', optional: true },
  { name: 'radiator_out', label: 'Radiator Outlet', location: 'radiator outlet', optional: true },
];

function buildDefaultConfig() {
  const ips = (process.env.SENSOR_HOST_IPS || '').split(',').filter(Boolean);
  const hosts = ips.map(function (ip, idx) {
    return { id: 'sensor_' + (idx + 1), ip: ip.trim(), name: 'Sensor Hub ' + (idx + 1) };
  });
  return {
    hosts,
    assignments: {},
    version: 0,
  };
}

function getLocalPath() {
  return process.env.SENSOR_CONFIG_PATH || path.join(__dirname, '..', 'sensor-config.json');
}

// Ensure persisted config has up-to-date hosts from SENSOR_HOST_IPS env var.
// Assignments and version are preserved; hosts are always derived from env.
function reconcileHosts(config) {
  const defaults = buildDefaultConfig();
  config.hosts = defaults.hosts;
  return config;
}

function load(callback) {
  if (s3Helper.isS3Enabled()) {
    const s3 = s3Helper.getS3CredsConfig();
    const { GetObjectCommand } = require('./s3-client');
    s3Helper.getS3Client().send(new GetObjectCommand({ Bucket: s3.bucket, Key: S3_KEY }))
      .then(function (response) { return response.Body.transformToString(); })
      .then(function (bodyStr) {
        try {
          currentConfig = reconcileHosts(JSON.parse(bodyStr));
          callback(null, currentConfig);
        } catch (e) {
          callback(new Error('Failed to parse sensor config JSON'));
        }
      })
      .catch(function (err) {
        if (err.name === 'NoSuchKey' || (err.$metadata && err.$metadata.httpStatusCode === 404)) {
          currentConfig = buildDefaultConfig();
          callback(null, currentConfig);
        } else {
          callback(err);
        }
      });
  } else {
    const filePath = getLocalPath();
    try {
      currentConfig = reconcileHosts(JSON.parse(fs.readFileSync(filePath, 'utf8')));
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
  return currentConfig || buildDefaultConfig();
}

// ── Validation ──

// Shelly's SensorAddon.OneWireScan returns 1-Wire addresses as colon-separated
// DECIMAL bytes (e.g. "40:208:87:71:0:0:0:120" — leading 40 = 0x28, the
// DS18B20 family code). Validate as 8 decimal bytes, each 0-255.
function isValidOneWireAddr(addr) {
  if (typeof addr !== 'string') return false;
  const parts = addr.split(':');
  if (parts.length !== 8) return false;
  for (let i = 0; i < 8; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return false;
    const n = parseInt(parts[i], 10);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function validateAssignments(assignments, hosts) {
  const addrs = {};
  const components = {};
  for (const role in assignments) {
    const a = assignments[role];
    if (!a || !a.addr) continue;
    if (!isValidOneWireAddr(a.addr)) {
      return 'Invalid 1-Wire address format for ' + role + ': ' + a.addr;
    }
    if (typeof a.componentId !== 'number' || a.componentId < 100 || a.componentId > 199) {
      return 'Component ID must be 100-199 for ' + role + ': ' + a.componentId;
    }
    if (typeof a.hostIndex !== 'number' || a.hostIndex < 0 || a.hostIndex >= hosts.length) {
      return 'Invalid host index for ' + role + ': ' + a.hostIndex;
    }
    if (addrs[a.addr]) {
      return 'Duplicate sensor address ' + a.addr + ' assigned to both ' + addrs[a.addr] + ' and ' + role;
    }
    addrs[a.addr] = role;
    const compKey = a.hostIndex + ':' + a.componentId;
    if (components[compKey]) {
      return 'Duplicate component ID ' + a.componentId + ' on host ' + a.hostIndex + ' for both ' + components[compKey] + ' and ' + role;
    }
    components[compKey] = role;
  }
  return null;
}

function getUnassignedRequiredRoles(assignments) {
  const missing = [];
  for (let i = 0; i < SENSOR_ROLES.length; i++) {
    const r = SENSOR_ROLES[i];
    if (!r.optional && (!assignments[r.name] || !assignments[r.name].addr)) {
      missing.push(r.name);
    }
  }
  return missing;
}

function updateAssignments(newAssignments, callback) {
  const config = getConfig();
  const error = validateAssignments(newAssignments, config.hosts);
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
  const compact = { s: {}, h: [], v: config.version };
  for (let i = 0; i < config.hosts.length; i++) {
    compact.h.push(config.hosts[i].ip);
  }
  for (const role in config.assignments) {
    const a = config.assignments[role];
    if (a && a.addr) {
      // Only h (hostIndex) and i (componentId) — including the 1-Wire
      // address would blow the 256-byte Shelly KVS cap with 7 sensors.
      // The hub already has the probe bound by cid via sensor-apply.
      compact.s[role] = { h: a.hostIndex, i: a.componentId };
    }
  }
  return compact;
}

const sensorApply = require('./sensor-apply');

function buildRoleLabels() {
  const labels = {};
  for (let i = 0; i < SENSOR_ROLES.length; i++) {
    labels[SENSOR_ROLES[i].name] = SENSOR_ROLES[i].label;
  }
  return labels;
}

function formatHostResult(config, r) {
  const hostInfo = config.hosts.find(function (h) { return h.ip === r.host; });
  const hostId = hostInfo ? hostInfo.id : r.host;
  let okMsg = r.peripherals + ' sensors configured';
  if (r.rebooted) okMsg += ' — hub rebooted to apply';
  return {
    id: hostId,
    result: r.ok
      ? { status: 'success', message: okMsg }
      : { status: 'error', message: r.error || 'Failed' },
  };
}

function applyConfig(mqttBridge, callback) {
  const config = getConfig();
  const compact = toCompactFormat(config);

  sensorApply.applyAll(config.hosts, config.assignments, buildRoleLabels()).then(function (result) {
    const results = {};
    for (let i = 0; i < result.results.length; i++) {
      const f = formatHostResult(config, result.results[i]);
      results[f.id] = f.result;
    }
    // Routing tells the controller which cid to poll per role. Not
    // fatal if the bridge is down — the hub bindings just applied are
    // the durable source of truth.
    if (mqttBridge) {
      try {
        const ok = mqttBridge.publishSensorConfig(compact);
        results.control = ok
          ? { status: 'success', message: 'Sensor routing published' }
          : { status: 'error', message: 'MQTT not connected' };
      } catch (e) {
        results.control = { status: 'error', message: e.message || String(e) };
      }
    } else {
      results.control = { status: 'error', message: 'MQTT bridge not available' };
    }
    callback(null, results);
  }).catch(function (err) {
    callback(err);
  });
}

function applySingleTarget(targetId, mqttBridge, callback) {
  const config = getConfig();

  if (targetId === 'control') {
    if (mqttBridge) {
      const ok = mqttBridge.publishSensorConfig(toCompactFormat(config));
      callback(null, { control: ok
        ? { status: 'success', message: 'Sensor routing published' }
        : { status: 'error', message: 'MQTT not connected' } });
    } else {
      callback(null, { control: { status: 'error', message: 'MQTT bridge not available' } });
    }
    return;
  }

  // Find host by id
  let host = null;
  for (let i = 0; i < config.hosts.length; i++) {
    if (config.hosts[i].id === targetId) {
      host = config.hosts[i];
      break;
    }
  }
  if (!host) {
    callback(new Error('Unknown target: ' + targetId));
    return;
  }

  sensorApply.applyOne(config.hosts, config.assignments, host.ip, buildRoleLabels()).then(function (result) {
    const results = {};
    if (result.results && result.results[0]) {
      const f = formatHostResult(config, result.results[0]);
      results[host.id] = f.result;
    }
    callback(null, results);
  }).catch(function (err) {
    callback(err);
  });
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
      const statusCode = err.message === 'Request timed out' ? 504 : 500;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message === 'Request timed out' ? 'Config apply timed out' : err.message }));
      return;
    }
    log.info('sensor config applied', { results });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
  });
}

function handleApplyTarget(req, res, targetId, mqttBridge) {
  applySingleTarget(targetId, mqttBridge, function (err, results) {
    if (err) {
      const statusCode = err.message === 'Request timed out' ? 504 : 400;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message === 'Request timed out' ? 'Config apply timed out' : err.message }));
      return;
    }
    log.info('sensor config applied to target', { target: targetId, results });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ results }));
  });
}

function _reset() {
  s3Helper._reset();
  currentConfig = null;
}

module.exports = {
  SENSOR_ROLES,
  buildDefaultConfig,
  load,
  save,
  getConfig,
  updateAssignments,
  validateAssignments,
  getUnassignedRequiredRoles,
  toCompactFormat,
  handleGet,
  handlePut,
  handleApply,
  handleApplyTarget,
  applyConfig,
  applySingleTarget,
  _reset,
};
