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

let sensorConfig = null;
let detectedSensors = {};  // hostId -> [{addr, component, tC, error}]
let scanning = false;
let scanInFlight = false;  // guards against concurrent scan requests
// True once a scan has completed at least once this session. Used to gate the
// red "Sensor missing: …" warning — before the first scan, detectedSensors is
// empty so every saved assignment would otherwise look "missing".
let scanAttempted = false;

// ── Sensor discovery via MQTT (routed through server API) ──

/** Map terse Shelly error strings to user-friendly messages */
function friendlyError(err) {
  if (!err) return 'Unknown error';
  if (err === 'err') return 'RPC call failed — device may be unreachable';
  if (err === 'bad') return 'Unexpected HTTP response from sensor addon';
  if (err === 'parse') return 'Invalid response from sensor addon';
  return err;
}

async function scanAllHosts({ withTemp = false } = {}) {
  if (!sensorConfig || !sensorConfig.hosts) return;
  if (scanInFlight) return;  // skip if a scan is already running
  scanInFlight = true;
  detectedSensors = {};
  const hostIps = sensorConfig.hosts.map(h => h.ip);
  try {
    const payload = { hosts: hostIps };
    if (!withTemp) payload.skipTemp = true;
    const res = await fetch('/api/sensor-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      const errMsg = errData.error || 'Server error (' + res.status + ')';
      for (const host of sensorConfig.hosts) {
        detectedSensors[host.id] = { sensors: [], error: errMsg };
      }
      return;
    }
    const data = await res.json();
    const results = data.results || [];
    for (const host of sensorConfig.hosts) {
      const hostResult = results.find(r => r.host === host.ip);
      if (!hostResult) {
        detectedSensors[host.id] = { sensors: [], error: 'No response from this host' };
      } else if (!hostResult.ok) {
        detectedSensors[host.id] = { sensors: [], error: friendlyError(hostResult.error) };
      } else {
        const sensors = (hostResult.sensors || []).map(s => ({
          addr: s.addr,
          component: s.component || null,
          tC: s.tC !== undefined ? s.tC : null,
          error: null,
        }));
        detectedSensors[host.id] = { sensors, error: null };
      }
    }
  } catch (e) {
    for (const host of sensorConfig.hosts) {
      detectedSensors[host.id] = { sensors: [], error: 'Network error: ' + e.message };
    }
  } finally {
    scanInFlight = false;
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
  const missing = getMissingRequiredRoles();

  // One card with four internal sections (Scan → Detected → Roles → Save/Apply).
  // Each section has its own heading + short description and is separated by a
  // top border via .sensor-section.
  let html = '';
  html += '<div class="card sensor-config-card">';
  html += '<h3 style="font-family:\'Newsreader\',Georgia,serif;font-style:italic;color:var(--on-surface);margin:0 0 8px;">Sensor configuration.</h3>';
  html += '<p style="font-size:12px;color:var(--on-surface-variant);margin:0 0 8px;">Discover DS18B20 probes on the Shelly sensor hubs, assign them to system roles, then push the routing to the controller.</p>';

  // ── 3a. Scan ──
  html += '<div class="sensor-section">';
  html += '<h4 class="sensor-section-title">Scan sensor hubs</h4>';
  html += '<p class="sensor-section-desc">Queries each hub for connected 1-Wire probes and reads a temperature so you can physically identify each one.</p>';
  html += '<div class="sensor-actions">';
  html += '<button class="primary' + (scanning ? ' scanning' : '') + '" id="btn-scan-sensors"' + (scanning ? ' disabled' : '') + '>' + (scanning ? '<span class="scan-spinner"></span>Scanning…' : 'Scan Sensors') + '</button>';
  html += '</div>';
  html += '<div id="sensor-status" style="margin-top:12px;"></div>';
  html += '</div>';

  // ── 3b. Detected sensors ──
  html += '<div class="sensor-section">';
  html += '<h4 class="sensor-section-title">Detected Sensors</h4>';
  html += '<p class="sensor-section-desc">Probes found on each hub during the last scan. Assignment status shows which role (if any) each probe is mapped to.</p>';
  if (!sensorConfig || !sensorConfig.hosts || sensorConfig.hosts.length === 0) {
    html += '<p style="color:var(--on-surface-variant);">No sensor hosts configured.</p>';
  } else {
    for (const host of sensorConfig.hosts) {
      const hasResult = Object.prototype.hasOwnProperty.call(detectedSensors, host.id);
      const result = detectedSensors[host.id];
      html += '<div class="host-group">';
      html += '<h4>' + host.name + ' <span class="host-ip">(' + host.ip + ')</span></h4>';
      if (!hasResult) {
        // Never scanned in this session — distinct from "scan in flight" (null).
        html += '<p style="color:var(--on-surface-variant);">Not yet scanned. Click <strong>Scan Sensors</strong> to discover.</p>';
      } else if (result === null) {
        html += '<p style="color:var(--on-surface-variant);"><span class="scan-spinner"></span>Scanning…</p>';
      } else if (result.error) {
        html += '<p class="host-error">' + result.error + '</p>';
      } else if (result.sensors.length === 0) {
        html += '<p style="color:var(--on-surface-variant);">No sensors detected. Verify DS18B20 probes are connected to the Sensor Add-on.</p>';
      } else {
        html += '<table class="sensor-table"><thead><tr><th>Address</th><th>Temp</th><th>Status</th></tr></thead><tbody>';
        for (const s of result.sensors) {
          const role = assignedAddrs[s.addr];
          const statusClass = role ? 'assigned' : 'available';
          const statusText = role ? 'Assigned: ' + role : 'Available';
          html += '<tr class="' + statusClass + '">';
          html += '<td class="addr">' + s.addr + '</td>';
          html += '<td>' + (s.tC !== null ? s.tC.toFixed(1) + '°C' : s.error || '—') + '</td>';
          html += '<td><span class="status-badge ' + statusClass + '">' + statusText + '</span></td>';
          html += '</tr>';
        }
        html += '</tbody></table>';
      }
      html += '</div>';
    }
  }
  html += '</div>';

  // ── 3c. Sensor role assignments ──
  html += '<div class="sensor-section">';
  html += '<h4 class="sensor-section-title">Sensor Roles</h4>';
  html += '<p class="sensor-section-desc">Map each detected probe to the physical location it measures. Required roles are highlighted; optional ones can be left unassigned.</p>';
  html += '<div class="sensor-roles">';
  for (const role of SENSOR_ROLES) {
    const assignedAddr = getAssignedAddr(role.name);
    const detected = allDetected.find(s => s.addr === assignedAddr);
    // Only flag as missing once we've actually scanned — otherwise every saved
    // assignment would look "missing" on the initial page load.
    const isMissing = scanAttempted && assignedAddr && !detected;

    html += '<div class="sensor-role-row" data-required="' + (!role.optional) + '">';
    html += '<div class="role-info">';
    html += '<strong>' + role.label + (role.optional ? '' : ' <span class="role-required-badge">required</span>') + '</strong>';
    html += '<span class="role-location">' + role.location + (role.optional ? ' (optional)' : '') + '</span>';
    html += '</div>';
    html += '<div class="role-assignment">';

    // Dropdown to select a sensor
    html += '<select data-role="' + role.name + '" class="sensor-select">';
    html += '<option value="">— unassigned —</option>';
    // Before the first scan, keep the stored addr selectable so the dropdown
    // reflects saved state instead of silently appearing unassigned.
    if (!scanAttempted && assignedAddr && !detected) {
      const storedHi = (sensorConfig && sensorConfig.assignments && sensorConfig.assignments[role.name] && typeof sensorConfig.assignments[role.name].hostIndex === 'number')
        ? sensorConfig.assignments[role.name].hostIndex
        : 0;
      html += '<option value="' + assignedAddr + '|' + storedHi + '" selected>' + assignedAddr + ' (not yet scanned)</option>';
    }
    for (const s of allDetected) {
      const inUse = assignedAddrs[s.addr] && assignedAddrs[s.addr] !== role.name;
      const tempStr = s.tC !== null ? ' (' + s.tC.toFixed(1) + '°C)' : s.error ? ' (error)' : '';
      const label = s.addr + tempStr + (inUse ? ' [' + assignedAddrs[s.addr] + ']' : '');
      const selected = s.addr === assignedAddr ? ' selected' : '';
      const disabled = inUse ? ' disabled' : '';
      // Option value omits the component ID — it's resolved in collectAssignments
      // so unbound probes get unique cids instead of all defaulting to 100.
      html += '<option value="' + s.addr + '|' + s.hostIndex + '"' + selected + disabled + '>' + label + '</option>';
    }
    html += '</select>';

    if (isMissing) {
      html += '<span class="sensor-warning">Sensor missing: ' + assignedAddr + '</span>';
    } else if (detected && detected.tC !== null) {
      html += '<span class="sensor-temp">' + detected.tC.toFixed(1) + '°C</span>';
    }

    html += '</div></div>';
  }
  html += '</div>';
  html += '</div>';

  // ── 3d. Save / Apply actions ──
  html += '<div class="sensor-section">';
  html += '<h4 class="sensor-section-title">Save &amp; apply</h4>';
  html += '<p class="sensor-section-desc"><strong>Save Assignments</strong> stores the role mapping on the server. <strong>Apply Configuration</strong> reprograms the sensor hubs and publishes the routing to the controller.</p>';
  html += '<div class="sensor-actions">';
  html += '<button class="primary" id="btn-save-sensors">Save Assignments</button>';
  html += '<button class="primary" id="btn-apply-sensors"' + (missing.length > 0 ? ' disabled' : '') + '>Apply Configuration</button>';
  if (missing.length > 0) {
    html += '<span class="sensor-warning">Required roles unassigned: ' + missing.join(', ') + '</span>';
  }
  html += '</div>';
  html += '<div id="apply-results" style="margin-top:12px;"></div>';
  html += '<div class="sensor-meta" style="margin-top:8px;font-size:12px;color:var(--on-surface-variant);">';
  html += 'Version: ' + (sensorConfig ? sensorConfig.version : 0);
  html += '</div>';
  html += '</div>';

  html += '</div>';  // .sensor-config-card

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
  // Step 1 — map each (hostIndex|addr) to its currently-bound component ID, if any.
  // The scan result's `component` field looks like "temperature:102" for probes
  // already bound to a Shelly peripheral slot; null for freshly-detected probes.
  const existingCid = {};
  if (sensorConfig && sensorConfig.hosts) {
    for (let hi = 0; hi < sensorConfig.hosts.length; hi++) {
      const detected = detectedSensors[sensorConfig.hosts[hi].id];
      if (!detected || !detected.sensors) continue;
      for (const s of detected.sensors) {
        if (s.component && s.component.indexOf('temperature:') === 0) {
          const cid = parseInt(s.component.split(':')[1], 10);
          if (!isNaN(cid)) existingCid[hi + '|' + s.addr] = cid;
        }
      }
    }
  }

  // Step 2 — gather the current role picks from the dropdowns.
  const picks = [];
  const selects = document.querySelectorAll('.sensor-select');
  for (const sel of selects) {
    if (!sel.value) continue;
    const parts = sel.value.split('|');
    const addr = parts[0];
    const hostIndex = parseInt(parts[1], 10);
    picks.push({
      role: sel.dataset.role,
      addr,
      hostIndex,
      fixedCid: existingCid[hostIndex + '|' + addr],  // undefined if unbound
    });
  }

  // Step 3 — reserve cids for picks whose probe is already bound, then fill in
  // the rest with the smallest free slot in [100, 199] on the same host. Without
  // this, every unbound probe defaulted to cid 100 and saves failed with
  // "Duplicate component ID 100 on host X for both <role A> and <role B>".
  const usedPerHost = {};  // hostIndex -> Set<number>
  const reserve = (hi, cid) => {
    if (!usedPerHost[hi]) usedPerHost[hi] = new Set();
    usedPerHost[hi].add(cid);
  };
  for (const p of picks) {
    if (p.fixedCid != null) reserve(p.hostIndex, p.fixedCid);
  }
  const assignments = {};
  for (const p of picks) {
    let cid = p.fixedCid;
    if (cid == null) {
      const used = usedPerHost[p.hostIndex] || new Set();
      for (let i = 100; i <= 199; i++) {
        if (!used.has(i)) { cid = i; break; }
      }
      reserve(p.hostIndex, cid);
    }
    assignments[p.role] = { addr: p.addr, hostIndex: p.hostIndex, componentId: cid };
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
  showStatus('Loading sensor config...');
  try {
    // Always re-fetch config before scanning (hosts may have changed)
    await loadSensorConfig();
  } catch (e) {
    showStatus('Failed to load config: ' + e.message, true);
    return;
  }

  // Mark all hosts as scanning before the request
  scanning = true;
  if (sensorConfig && sensorConfig.hosts) {
    for (const host of sensorConfig.hosts) {
      detectedSensors[host.id] = null; // triggers "Scanning..." in UI
    }
  }
  renderSensorsView();
  showStatus('Scanning sensor hubs...');

  try {
    // Read temperatures during the scan so the user sees actual values they
    // can use to identify which physical sensor is which (vs raw 1-Wire ROM IDs).
    await scanAllHosts({ withTemp: true });
    scanning = false;
    // Gate "Sensor missing" warnings only after we actually have scan results —
    // flipping this earlier would show red warnings during the in-flight render.
    scanAttempted = true;
    renderSensorsView();

    // Build informative status message
    const summary = buildScanSummary();
    showStatus(summary.message, summary.isError);
  } catch (e) {
    scanning = false;
    renderSensorsView();
    showStatus('Scan failed: ' + e.message, true);
  }
}

function buildScanSummary() {
  if (!sensorConfig || !sensorConfig.hosts || sensorConfig.hosts.length === 0) return { message: 'No sensor hosts configured. Check SENSOR_HOST_IPS.', isError: true };
  let totalSensors = 0;
  let hostsOk = 0;
  let hostsError = 0;
  const errors = [];
  for (const host of sensorConfig.hosts) {
    const result = detectedSensors[host.id];
    if (!result) {
      hostsError++;
      errors.push(host.name + ': no response');
    } else if (result.error) {
      hostsError++;
      errors.push(host.name + ': ' + result.error);
    } else {
      hostsOk++;
      totalSensors += result.sensors.length;
    }
  }
  if (hostsError > 0 && hostsOk === 0) {
    return { message: 'All hosts unreachable. ' + errors.join('; '), isError: true };
  }
  if (hostsError > 0) {
    return { message: totalSensors + ' sensor(s) found on ' + hostsOk + ' host(s). Errors: ' + errors.join('; '), isError: true };
  }
  if (totalSensors === 0) {
    return { message: 'Scan complete. No sensors detected on ' + hostsOk + ' host(s). Check physical connections.', isError: false };
  }
  return { message: 'Found ' + totalSensors + ' sensor(s) on ' + hostsOk + ' host(s).', isError: false };
}

function assignmentsEqual(a, b) {
  if (!a && !b) return true;
  a = a || {};
  b = b || {};
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    const av = a[aKeys[i]] || {};
    const bv = b[bKeys[i]] || {};
    if (av.addr !== bv.addr || av.hostIndex !== bv.hostIndex || av.componentId !== bv.componentId) return false;
  }
  return true;
}

async function handleSave() {
  const assignments = collectAssignments();
  // Skip the round-trip when nothing changed — no version bump, no S3 write,
  // no MQTT republish. Saves users from accidentally pushing redundant configs.
  if (sensorConfig && assignmentsEqual(assignments, sensorConfig.assignments)) {
    showStatus('No changes to save — click Apply Configuration to re-push to hubs.');
    return;
  }
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
    // Apply can take 30+ seconds when a hub needs to reboot. If the browser
    // or an intermediate proxy gives up first, `fetch` rejects with something
    // generic like "Failed to fetch" even though the device may have applied
    // the changes successfully — surface that possibility so the user doesn't
    // assume nothing happened.
    const isNetErr = /fetch|network|abort/i.test(e.message || '');
    const hint = isNetErr
      ? 'Network error during apply — the hubs may have applied the changes anyway. Scan again to verify.'
      : 'Apply failed: ' + e.message;
    showStatus(hint, true);
  }
}

// ── Lifecycle ──

export async function initSensorsView() {
  try {
    await loadSensorConfig();
    renderSensorsView();
  } catch (e) {
    const container = document.getElementById('sensors-content');
    if (container) {
      container.innerHTML = '<div class="card"><p class="host-error">Failed to load sensor config: ' + e.message + '</p></div>';
    }
  }
}

export function destroySensorsView() {
  // no-op — no background activity to clean up
}
