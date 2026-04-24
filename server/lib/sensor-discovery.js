/**
 * Sensor discovery over direct HTTP to each Shelly sensor hub.
 *
 * Background: the earlier MQTT-routed flow (server → Pro 4PM → HTTP to each
 * hub → MQTT result) was slow (~30s) and brittle — a single unreachable hub
 * or a stale subscription on the controller produced an opaque "MQTT timeout"
 * with no per-hub detail. The Shelly mobile app talks to each hub directly;
 * we do the same here. Discovery is read-only, so sidestepping the MQTT
 * convention for this one endpoint is a deliberate trade.
 */

const http = require('http');
const createLogger = require('./logger');

const log = createLogger('sensor-discovery');

const DEFAULT_RPC_TIMEOUT_MS = 15000;       // per-RPC (OneWireScan can take ~10s on a long bus)
const DEFAULT_PER_HOST_TIMEOUT_MS = 25000;  // overall budget per host including temp polls

function rpc(host, method, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify({ id: 1, method, params: params || {} });
    const req = http.request({
      host,
      port: 80,
      path: '/rpc',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' from ' + host));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) {
          reject(new Error('Invalid JSON from ' + host + ': ' + e.message));
        }
      });
    });
    req.on('error', function (err) {
      reject(new Error(friendlyNetError(err, host)));
    });
    req.on('timeout', function () {
      req.destroy();
      reject(new Error('No response from ' + host + ' after ' + timeoutMs + 'ms (' + method + ')'));
    });
    req.write(body);
    req.end();
  });
}

function getTemperature(host, componentId, timeoutMs) {
  return new Promise(function (resolve, reject) {
    const req = http.get({
      host,
      port: 80,
      path: '/rpc/Temperature.GetStatus?id=' + encodeURIComponent(componentId),
      timeout: timeoutMs,
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString());
          resolve(data && typeof data.tC === 'number' ? data.tC : null);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', function () { resolve(null); });
    req.on('timeout', function () { req.destroy(); resolve(null); });
  });
}

function friendlyNetError(err, host) {
  switch (err.code) {
    case 'ECONNREFUSED': return host + ' refused connection — device off or wrong IP';
    case 'EHOSTUNREACH': return host + ' unreachable — check VPN / network';
    case 'ENETUNREACH':  return host + ' unreachable — no route to network';
    case 'ETIMEDOUT':    return host + ' timed out — device slow or down';
    case 'ECONNRESET':   return host + ' reset the connection';
    case 'ENOTFOUND':    return host + ' — DNS lookup failed';
    default:             return (err.code ? err.code + ': ' : '') + (err.message || String(err));
  }
}

function extractDevices(rpcResponse) {
  if (!rpcResponse) return [];
  // Shelly Gen2 RPC returns either {result: {devices}} (HTTP.POST /rpc) or
  // {devices} (HTTP.GET /rpc/SensorAddon.OneWireScan). Both forms observed.
  if (rpcResponse.result && rpcResponse.result.devices) return rpcResponse.result.devices;
  if (rpcResponse.devices) return rpcResponse.devices;
  return [];
}

async function scanHost(host, options) {
  const opts = options || {};
  const rpcTimeout = opts.rpcTimeoutMs || DEFAULT_RPC_TIMEOUT_MS;
  const started = Date.now();
  try {
    const res = await rpc(host, 'SensorAddon.OneWireScan', null, rpcTimeout);
    const devices = extractDevices(res);
    const sensors = devices.map(function (d) {
      return {
        addr: d.addr || '',
        component: d.component || null,
        tC: null,
      };
    });
    if (opts.skipTemp) {
      return { host, ok: true, sensors };
    }
    // Fetch temperatures for sensors that have a bound component — in parallel.
    await Promise.all(sensors.map(async function (s) {
      if (!s.component || s.component.indexOf('temperature:') !== 0) return;
      const cid = s.component.slice('temperature:'.length);
      s.tC = await getTemperature(host, cid, rpcTimeout);
    }));
    log.info('scan ok', { host, count: sensors.length, ms: Date.now() - started });
    return { host, ok: true, sensors };
  } catch (err) {
    log.warn('scan failed', { host, error: err.message, ms: Date.now() - started });
    return { host, ok: false, error: err.message, sensors: [] };
  }
}

function withOverallTimeout(promise, ms, host) {
  let timer;
  const timeout = new Promise(function (resolve) {
    timer = setTimeout(function () {
      resolve({ host, ok: false, error: host + ' scan exceeded ' + ms + 'ms budget', sensors: [] });
    }, ms);
  });
  return Promise.race([
    promise.then(function (v) { clearTimeout(timer); return v; }),
    timeout,
  ]);
}

function discoverSensors(hosts, options) {
  const opts = options || {};
  const perHost = opts.perHostTimeoutMs || DEFAULT_PER_HOST_TIMEOUT_MS;
  const id = 'disc-' + Date.now();
  const hostList = Array.isArray(hosts) ? hosts : [];
  return Promise.all(hostList.map(function (host) {
    return withOverallTimeout(scanHost(host, opts), perHost, host);
  })).then(function (results) {
    return { id, results };
  });
}

module.exports = {
  discoverSensors,
  scanHost,
  _internals: { rpc, getTemperature, friendlyNetError },
};
