/**
 * Sensor configuration UI module.
 * Discovers DS18B20 sensors on Shelly sensor hosts, lets the operator
 * assign them to system roles, and applies the configuration.
 */

// Sensor roles derived from system.yaml
const SENSOR_ROLES = [
  { name: 'collector', label: 'Collector Outlet', location: 'Collector outlet, ~280cm', optional: false },
  { name: 'tank_top', label: 'Tank Top', location: 'Tank upper region, ~180cm', optional: false },
  { name: 'tank_bottom', label: 'Tank Bottom', location: 'Tank lower region, ~10cm', optional: false },
  { name: 'greenhouse', label: 'Greenhouse Air', location: 'Greenhouse air', optional: false },
  { name: 'outdoor', label: 'Outdoor', location: 'Outside, shaded', optional: false },
  { name: 'radiator_in', label: 'Radiator Inlet', location: 'Radiator inlet', optional: true },
  { name: 'radiator_out', label: 'Radiator Outlet', location: 'Radiator outlet', optional: true },
];

const RPC_HEADERS = {
  'Content-Type': 'application/json',
  'X-Requested-With': 'greenhouse-monitor',
};

let sensorConfig = null;
let detectedSensors = {};  // hostId -> [{addr, component, tC, error}]
let refreshTimer = null;

// ── RPC helpers ──

async function rpc(method, params, hostIp) {
  const body = Object.assign({}, params || {});
  if (hostIp) body._host = hostIp;
  const res = await fetch('/api/rpc/' + method, {
    method: 'POST',
    headers: RPC_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('RPC ' + method + ' failed: ' + res.status);
  return res.json();
}

// ── Sensor discovery ──

async function scanHost(host) {
  try {
    // Scan 1-Wire bus for all connected sensors
    const scanResult = await rpc('SensorAddon.OneWireScan', null, host.ip);
    const devices = (scanResult && scanResult.devices) || [];

    // Get current bindings
    const peripherals = await rpc('SensorAddon.GetPeripherals', null, host.ip);
    const ds18b20 = (peripherals && peripherals.ds18b20) || {};

    // Build address-to-component map from peripherals
    const addrToComp = {};
    for (const comp in ds18b20) {
      const info = ds18b20[comp];
      if (info && info.addr) addrToComp[info.addr] = comp;
    }

    // Get temperatures for bound sensors
    const sensors = [];
    for (const dev of devices) {
      const sensor = { addr: dev.addr, component: dev.component || addrToComp[dev.addr] || null, tC: null, error: null };
      if (sensor.component) {
        const compId = parseInt(sensor.component.replace('temperature:', ''), 10);
        try {
          const status = await rpc('Temperature.GetStatus', { id: compId }, host.ip);
          sensor.tC = status.tC !== undefined ? status.tC : null;
          if (status.errors && status.errors.length) sensor.error = status.errors.join(', ');
        } catch (e) {
          sensor.error = e.message;
        }
      }
      sensors.push(sensor);
    }
    return { sensors, error: null };
  } catch (e) {
    return { sensors: [], error: e.message };
  }
}

async function scanAllHosts() {
  if (!sensorConfig || !sensorConfig.hosts) return;
  detectedSensors = {};
  for (const host of sensorConfig.hosts) {
    const result = await scanHost(host);
    detectedSensors[host.id] = result;
  }
}

// ── Config API ──

async function loadSensorConfig() {
  const res = await fetch('/api/sensor-config');
  sensorConfig = await res.json();
  return sensorConfig;
}

async function saveSensorConfig(assignments) {
  const res = await fetch('/api/sensor-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Save failed');
  }
  sensorConfig = await res.json();
  return sensorConfig;
}

async function applyConfig() {
  const res = await fetch('/api/sensor-config/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return res.json();
}

async function applyTarget(targetId) {
  const res = await fetch('/api/sensor-config/apply/' + targetId, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return res.json();
}

// ── UI rendering ──

function getAssignedAddr(role) {
  if (!sensorConfig || !sensorConfig.assignments) return null;
  const a = sensorConfig.assignments[role];
  return a && a.addr ? a.addr : null;
}

function getAllDetectedSensors() {
  const all = [];
  if (!sensorConfig || !sensorConfig.hosts) return all;
  for (const host of sensorConfig.hosts) {
    const result = detectedSensors[host.id];
    if (!result || result.error) continue;
    for (const s of result.sensors) {
      all.push({ addr: s.addr, tC: s.tC, error: s.error, hostId: host.id, hostIndex: sensorConfig.hosts.indexOf(host), component: s.component });
    }
  }
  return all;
}

function getAssignedAddrs() {
  const addrs = {};
  if (!sensorConfig || !sensorConfig.assignments) return addrs;
  for (const role in sensorConfig.assignments) {
    const a = sensorConfig.assignments[role];
    if (a && a.addr) addrs[a.addr] = role;
  }
  return addrs;
}

function renderSensorsView() {
  const container = document.getElementById('sensors-content');
  if (!container) return;

  const assignedAddrs = getAssignedAddrs();
  const allDetected = getAllDetectedSensors();

  let html = '';

  // ── Sensor Roles section ──
  html += '<div class="card"><h3>Sensor Roles</h3>';
  html += '<div class="sensor-roles">';
  for (const role of SENSOR_ROLES) {
    const assignedAddr = getAssignedAddr(role.name);
    const detected = allDetected.find(s => s.addr === assignedAddr);
    const isMissing = assignedAddr && !detected;

    html += '<div class="sensor-role-row">';
    html += '<div class="role-info">';
    html += '<strong>' + role.label + '</strong>';
    html += '<span class="role-location">' + role.location + (role.optional ? ' (optional)' : '') + '</span>';
    html += '</div>';
    html += '<div class="role-assignment">';

    // Dropdown to select a sensor
    html += '<select data-role="' + role.name + '" class="sensor-select">';
    html += '<option value="">— unassigned —</option>';
    for (const s of allDetected) {
      const inUse = assignedAddrs[s.addr] && assignedAddrs[s.addr] !== role.name;
      const tempStr = s.tC !== null ? ' (' + s.tC.toFixed(1) + '\u00B0C)' : s.error ? ' (error)' : '';
      const label = s.addr + tempStr + (inUse ? ' [' + assignedAddrs[s.addr] + ']' : '');
      const selected = s.addr === assignedAddr ? ' selected' : '';
      const disabled = inUse ? ' disabled' : '';
      html += '<option value="' + s.addr + '|' + s.hostIndex + '|' + (s.component ? s.component.replace('temperature:', '') : '100') + '"' + selected + disabled + '>' + label + '</option>';
    }
    html += '</select>';

    if (isMissing) {
      html += '<span class="sensor-warning">Sensor missing: ' + assignedAddr + '</span>';
    } else if (detected && detected.tC !== null) {
      html += '<span class="sensor-temp">' + detected.tC.toFixed(1) + '\u00B0C</span>';
    }

    html += '</div></div>';
  }
  html += '</div></div>';

  // ── Detected Sensors section ──
  html += '<div class="card" style="margin-top:16px;"><h3>Detected Sensors</h3>';
  if (!sensorConfig || !sensorConfig.hosts || sensorConfig.hosts.length === 0) {
    html += '<p style="color:var(--on-surface-variant);">No sensor hosts configured.</p>';
  } else {
    for (const host of sensorConfig.hosts) {
      const result = detectedSensors[host.id];
      html += '<div class="host-group">';
      html += '<h4>' + host.name + ' <span class="host-ip">(' + host.ip + ')</span></h4>';
      if (!result) {
        html += '<p style="color:var(--on-surface-variant);">Scanning...</p>';
      } else if (result.error) {
        html += '<p class="host-error">Unreachable: ' + result.error + '</p>';
      } else if (result.sensors.length === 0) {
        html += '<p style="color:var(--on-surface-variant);">No sensors detected.</p>';
      } else {
        html += '<table class="sensor-table"><thead><tr><th>Address</th><th>Temp</th><th>Status</th></tr></thead><tbody>';
        for (const s of result.sensors) {
          const role = assignedAddrs[s.addr];
          const statusClass = role ? 'assigned' : 'available';
          const statusText = role ? 'Assigned: ' + role : 'Available';
          html += '<tr class="' + statusClass + '">';
          html += '<td class="addr">' + s.addr + '</td>';
          html += '<td>' + (s.tC !== null ? s.tC.toFixed(1) + '\u00B0C' : s.error || '—') + '</td>';
          html += '<td><span class="status-badge ' + statusClass + '">' + statusText + '</span></td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
      }
      html += '</div>';
    }
  }
  html += '</div>';

  // ── Actions section ──
  const missing = getMissingRequiredRoles();
  html += '<div class="card" style="margin-top:16px;"><h3>Actions</h3>';
  html += '<div class="sensor-actions">';
  html += '<button class="secondary" id="btn-scan-sensors">Scan Sensors</button>';
  html += '<button class="primary" id="btn-save-sensors">Save Assignments</button>';
  html += '<button class="primary" id="btn-apply-sensors"' + (missing.length > 0 ? ' disabled' : '') + '>Apply Configuration</button>';
  if (missing.length > 0) {
    html += '<span class="sensor-warning">Required roles unassigned: ' + missing.join(', ') + '</span>';
  }
  html += '</div>';
  html += '<div id="sensor-status" style="margin-top:12px;"></div>';
  html += '<div id="apply-results" style="margin-top:12px;"></div>';
  html += '<div class="sensor-meta" style="margin-top:8px;font-size:12px;color:var(--on-surface-variant);">';
  html += 'Version: ' + (sensorConfig ? sensorConfig.version : 0);
  html += '</div>';
  html += '</div>';

  container.innerHTML = html;

  // Bind event handlers
  document.getElementById('btn-scan-sensors').addEventListener('click', handleScan);
  document.getElementById('btn-save-sensors').addEventListener('click', handleSave);
  document.getElementById('btn-apply-sensors').addEventListener('click', handleApply);
}

function getMissingRequiredRoles() {
  const missing = [];
  for (const role of SENSOR_ROLES) {
    if (!role.optional && !getAssignedAddr(role.name)) {
      missing.push(role.name);
    }
  }
  return missing;
}

function collectAssignments() {
  const assignments = {};
  const selects = document.querySelectorAll('.sensor-select');
  for (const sel of selects) {
    const role = sel.dataset.role;
    if (sel.value) {
      const parts = sel.value.split('|');
      assignments[role] = {
        addr: parts[0],
        hostIndex: parseInt(parts[1], 10),
        componentId: parseInt(parts[2], 10),
      };
    }
  }
  return assignments;
}

function showStatus(msg, isError) {
  const el = document.getElementById('sensor-status');
  if (el) {
    el.innerHTML = '<span style="color:' + (isError ? 'var(--error)' : 'var(--primary)') + ';">' + msg + '</span>';
  }
}

function showApplyResults(data) {
  const el = document.getElementById('apply-results');
  if (!el || !data || !data.results) return;
  let html = '<div class="apply-results-grid">';
  for (const target in data.results) {
    const r = data.results[target];
    const isOk = r.status === 'success';
    html += '<div class="apply-result ' + (isOk ? 'success' : 'error') + '">';
    html += '<strong>' + target + '</strong>: ' + r.message;
    if (!isOk) {
      html += ' <button class="retry-btn" data-target="' + target + '">Retry</button>';
    }
    html += '</div>';
  }
  html += '</div>';
  el.innerHTML = html;

  // Bind retry buttons
  el.querySelectorAll('.retry-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Retrying...';
      try {
        const result = await applyTarget(btn.dataset.target);
        showApplyResults({ results: Object.assign({}, data.results, result.results) });
      } catch (e) {
        showStatus('Retry failed: ' + e.message, true);
      }
    });
  });
}

// ── Event handlers ──

async function handleScan() {
  showStatus('Scanning sensor hosts...');
  try {
    await scanAllHosts();
    renderSensorsView();
    showStatus('Scan complete.');
  } catch (e) {
    showStatus('Scan failed: ' + e.message, true);
  }
}

async function handleSave() {
  const assignments = collectAssignments();
  showStatus('Saving...');
  try {
    await saveSensorConfig(assignments);
    renderSensorsView();
    showStatus('Saved (v' + sensorConfig.version + ')');
  } catch (e) {
    showStatus('Save failed: ' + e.message, true);
  }
}

async function handleApply() {
  showStatus('Applying configuration...');
  try {
    const result = await applyConfig();
    showApplyResults(result);
    showStatus('Apply complete.');
  } catch (e) {
    showStatus('Apply failed: ' + e.message, true);
  }
}

// ── Lifecycle ──

export async function initSensorsView() {
  try {
    await loadSensorConfig();
    renderSensorsView();
    // Start auto-refresh
    await scanAllHosts();
    renderSensorsView();
    startAutoRefresh();
  } catch (e) {
    const container = document.getElementById('sensors-content');
    if (container) {
      container.innerHTML = '<div class="card"><p class="host-error">Failed to load sensor config: ' + e.message + '</p></div>';
    }
  }
}

export function destroySensorsView() {
  stopAutoRefresh();
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(async () => {
    await scanAllHosts();
    renderSensorsView();
  }, 30000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
