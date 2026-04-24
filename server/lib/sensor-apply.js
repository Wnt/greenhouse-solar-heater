/**
 * Apply sensor configuration to Shelly hubs over direct HTTP.
 *
 * The Shelly Add-on has two quirks we learned the hard way:
 *
 *   1. After RemovePeripheral, the freed 1-Wire address stays in an
 *      internal "reserved" cache. A subsequent AddPeripheral for the
 *      same addr — even at a different cid — fails with -106 "Resource
 *      'address:…' already exists!". Only a reboot clears the cache.
 *
 *   2. AddPeripheral creates the peripheral but does NOT register the
 *      Temperature.GetStatus handler for the new component id until
 *      the hub reboots. Polling the cid in the meantime returns
 *      -105 "Argument 'id', value N not found!".
 *
 * So the reliable flow is: remove-all → reboot → wait → add-all → reboot.
 * That's far easier in Node on the server than in ES5 on the controller,
 * and the hubs are reachable over the VPN — so apply now goes direct
 * HTTP, same pattern as sensor-discovery. Control/state/relay commands
 * still flow through MQTT.
 */

const http = require('http');
const createLogger = require('./logger');

const log = createLogger('sensor-apply');

const RPC_TIMEOUT_MS = 10000;
const REBOOT_WAIT_MS = 30000;
const REBOOT_POLL_INTERVAL_MS = 1000;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function httpRpc(host, method, params, timeoutMs) {
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
      timeout: timeoutMs || RPC_TIMEOUT_MS,
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        if (res.statusCode !== 200) {
          reject(new Error('HTTP ' + res.statusCode + ' from ' + host + ' on ' + method));
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          if (parsed.error) {
            const code = parsed.error.code !== undefined ? parsed.error.code + ': ' : '';
            reject(new Error(code + (parsed.error.message || 'unknown')));
            return;
          }
          resolve(parsed.result);
        } catch (e) {
          reject(new Error('Invalid JSON from ' + host + ': ' + e.message));
        }
      });
    });
    req.on('error', function (err) { reject(new Error((err.code || '') + ' ' + (err.message || err))); });
    req.on('timeout', function () { req.destroy(); reject(new Error('Timeout on ' + method + ' to ' + host)); });
    req.write(body);
    req.end();
  });
}

// Wait until the hub responds to a SensorAddon RPC after a reboot. The hub
// answers Shelly.GetDeviceInfo almost immediately but SensorAddon takes
// another 15–20s to finish loading, so we poll a real Add-on method.
async function waitForHubReady(host, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || REBOOT_WAIT_MS);
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await httpRpc(host, 'SensorAddon.GetPeripherals', null, 3000);
      return true;
    } catch (e) {
      lastErr = e;
      await sleep(REBOOT_POLL_INTERVAL_MS);
    }
  }
  log.warn('waitForHubReady timed out', { host, error: lastErr && lastErr.message });
  return false;
}

function buildTargetMap(hosts, assignments, roleLabels) {
  // Returns { hostIp: { cid: { addr, role, label }, ... }, ... }.
  // `label` is the human-readable role label (e.g. "Tank Top") that the
  // Shelly app shows as the Temperature component name. Falls back to the
  // role key if no label is supplied.
  const byHost = {};
  const labels = roleLabels || {};
  for (const role in assignments) {
    const a = assignments[role];
    if (!a || !a.addr) continue;
    const h = hosts[a.hostIndex];
    if (!h || !h.ip) continue;
    if (!byHost[h.ip]) byHost[h.ip] = {};
    byHost[h.ip][String(a.componentId)] = {
      addr: a.addr,
      role,
      label: labels[role] || role,
    };
  }
  return byHost;
}

function currentMatchesTarget(existing, target) {
  // existing: { "temperature:N": { addr, ... }, ... }
  // target:   { "N": { addr, role }, ... }
  const existingKeys = Object.keys(existing).map(function (k) { return k.replace('temperature:', ''); }).sort();
  const targetKeys = Object.keys(target).sort();
  if (existingKeys.length !== targetKeys.length) return false;
  for (let i = 0; i < targetKeys.length; i++) {
    if (existingKeys[i] !== targetKeys[i]) return false;
    const e = existing['temperature:' + targetKeys[i]];
    if (!e || e.addr !== target[targetKeys[i]].addr) return false;
  }
  return true;
}

async function applyHost(hostIp, target) {
  const errors = [];
  let added = 0;
  let rebooted = false;

  let existing;
  try {
    const result = await httpRpc(hostIp, 'SensorAddon.GetPeripherals');
    existing = (result && result.ds18b20) || {};
  } catch (e) {
    return { host: hostIp, ok: false, error: 'GetPeripherals: ' + e.message, peripherals: 0 };
  }

  const targetCount = Object.keys(target).length;
  if (targetCount > 0 && currentMatchesTarget(existing, target)) {
    // Peripherals match by address — skip the add/remove dance, but still
    // sync names because currentMatchesTarget doesn't compare them (the
    // cloud tile shows these labels, and an earlier apply may have bound
    // the peripherals before labels were ever pushed).
    for (const cid of Object.keys(target)) {
      const t = target[cid];
      try {
        await httpRpc(hostIp, 'Temperature.SetConfig', {
          id: parseInt(cid, 10),
          config: { name: t.label },
        });
      } catch (e) {
        log.warn('failed to label temperature component', {
          host: hostIp, cid, role: t.role, error: e.message,
        });
      }
    }
    log.info('already matches target', { host: hostIp, peripherals: targetCount });
    return { host: hostIp, ok: true, peripherals: targetCount };
  }

  // Phase 1 — remove everything currently bound so we start from a clean slate.
  const existingKeys = Object.keys(existing);
  if (existingKeys.length > 0) {
    for (const k of existingKeys) {
      try {
        await httpRpc(hostIp, 'SensorAddon.RemovePeripheral', { component: k });
      } catch (e) {
        errors.push('remove ' + k + ': ' + e.message);
      }
    }
    // Reboot after removes to clear the Add-on's internal address cache
    // (see module header comment — quirk #1).
    try { await httpRpc(hostIp, 'Shelly.Reboot'); } catch (_) { /* reboot kills the response */ }
    rebooted = true;
    log.info('removed + rebooted, waiting for hub', { host: hostIp, removed: existingKeys.length });
    const ready = await waitForHubReady(hostIp, REBOOT_WAIT_MS);
    if (!ready) {
      errors.push('hub did not come back within ' + REBOOT_WAIT_MS + 'ms after phase-1 reboot');
      return { host: hostIp, ok: false, error: errors.join('; '), peripherals: 0, rebooted };
    }
  }

  // Phase 2 — add all target peripherals with explicit cid + addr, and
  // immediately name each Temperature component after its role (e.g.
  // "Tank Top"). SetConfig persists even before the Temperature.GetStatus
  // handlers register, so the label survives the phase-3 reboot.
  // Naming failures are non-fatal: the peripheral is bound, the routing
  // works, only the app-side label is missing.
  for (const cid of Object.keys(target)) {
    const t = target[cid];
    try {
      await httpRpc(hostIp, 'SensorAddon.AddPeripheral', {
        type: 'ds18b20',
        attrs: { cid: parseInt(cid, 10), addr: t.addr },
      });
      added++;
    } catch (e) {
      errors.push('add ' + t.role + ' (cid ' + cid + ', addr ' + t.addr + '): ' + e.message);
      continue;
    }
    try {
      await httpRpc(hostIp, 'Temperature.SetConfig', {
        id: parseInt(cid, 10),
        config: { name: t.label },
      });
    } catch (e) {
      log.warn('failed to label temperature component', {
        host: hostIp, cid, role: t.role, error: e.message,
      });
    }
  }

  // Phase 3 — reboot once more so Temperature.GetStatus handlers register
  // for the new cids (quirk #2). Fire and don't wait; the controller's
  // 30s polling loop will pick up the temps once the hub is back.
  if (added > 0) {
    try { await httpRpc(hostIp, 'Shelly.Reboot'); } catch (_) { /* expected */ }
    rebooted = true;
    log.info('added + rebooted', { host: hostIp, added });
  }

  const out = { host: hostIp, ok: errors.length === 0, peripherals: added };
  if (rebooted) out.rebooted = true;
  if (errors.length) out.error = errors.join('; ');
  return out;
}

async function applyAll(hosts, assignments, roleLabels) {
  const targetByHost = buildTargetMap(hosts, assignments, roleLabels);
  const ips = hosts.map(function (h) { return h.ip; });
  const results = await Promise.all(ips.map(function (ip) {
    return applyHost(ip, targetByHost[ip] || {}).catch(function (e) {
      return { host: ip, ok: false, error: e.message || String(e), peripherals: 0 };
    });
  }));
  return {
    id: 'apply-' + Date.now(),
    success: results.every(function (r) { return r.ok; }),
    results,
  };
}

async function applyOne(hosts, assignments, hostIp, roleLabels) {
  const targetByHost = buildTargetMap(hosts, assignments, roleLabels);
  const result = await applyHost(hostIp, targetByHost[hostIp] || {});
  return { id: 'apply-' + Date.now(), success: result.ok, results: [result] };
}

module.exports = {
  applyAll,
  applyOne,
  _internals: { httpRpc, buildTargetMap, currentMatchesTarget },
};
