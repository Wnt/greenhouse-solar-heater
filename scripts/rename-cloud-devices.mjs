/**
 * Rename Shelly Cloud device/channel entries to match the canonical role
 * mapping in shelly/deploy.sh.
 *
 * Why it exists:
 *   The Shelly Cloud app keeps its own name store per channel. Cloud sync is
 *   one-way (cloud → device), so the names set by `deploy.sh` via
 *   Sys.SetConfig / Switch.SetConfig never appear in the mobile / web app.
 *   This script closes that gap by calling the same Cloud REST API that the
 *   web app uses when you save a "Device name" in the UI.
 *
 * Usage:
 *   # One-shot with a 24 h access token (copy from DevTools):
 *   SHELLY_CLOUD_TOKEN=<jwt> node scripts/rename-cloud-devices.mjs [--dry-run]
 *
 *   # Long-lived: use a 60 d refresh token. The script will exchange it for a
 *   # fresh access token on each run. The refresh token ROTATES — the new one
 *   # is printed to stderr; store it to keep unattended runs working.
 *   SHELLY_CLOUD_REFRESH_TOKEN=<jwt> \
 *   SHELLY_CLOUD_API_URL=https://shelly-249-eu.shelly.cloud \
 *   node scripts/rename-cloud-devices.mjs
 *
 *   # Just refresh and print the new tokens (no renames):
 *   SHELLY_CLOUD_REFRESH_TOKEN=<jwt> SHELLY_CLOUD_API_URL=https://... \
 *   node scripts/rename-cloud-devices.mjs --refresh-only
 *
 * Getting the initial tokens:
 *   1. Log in to https://control.shelly.cloud/
 *   2. DevTools → Application → Local Storage → key `user_data`
 *   3. Copy `token` (access, 24 h) and/or `refresh_token` (60 d) and
 *      `user_api_url` (regional shard).
 *
 * The access-token JWT payload embeds `user_api_url`; the refresh-token JWT
 * does not, so when refreshing you MUST also supply SHELLY_CLOUD_API_URL.
 *
 * Name map is duplicated with deploy.sh:apply_device_names for now. If this
 * grows, extract a shared JSON data file and have deploy.sh read it via jq.
 */

// IP → per-channel cloud names. `null` means "leave whatever the cloud has".
// Channel index is 0-based and maps to the Shelly Cloud `channel` field.
const IP_TO_CHANNEL_NAMES = {
  // Pro 4PM — main controller. Channels match control.js setActuators mapping.
  '192.168.30.50': ['Pump', 'Fan', 'Heater (immersion)', 'Heater (space)'],
  // Pro 2PM valve controllers. Channels match VALVES in control.js.
  '192.168.30.51': ['VI-btm', 'VI-top'],
  '192.168.30.52': ['VI-coll', 'VO-coll'],
  '192.168.30.53': ['VO-rad', 'VO-tank'],
  '192.168.30.54': ['V-air', null], // ch 1 = reserved spare (spec 024)
  '192.168.30.55': [null, null],    // PRO2PM_5 = spare
  // Shelly Plus 1 sensor hubs (relay output is the only channel).
  '192.168.30.20': ['GH Sensors 1'],
  '192.168.30.21': ['GH Sensors 2'],
};

const DRY_RUN = process.argv.includes('--dry-run');
const REFRESH_ONLY = process.argv.includes('--refresh-only');

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function decodeJwt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    die('Invalid JWT.');
  }
}

async function refreshAccessToken(apiUrl, refreshToken) {
  const res = await fetch(`${apiUrl}/v2/users/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    die(`refresh → ${res.status} ${res.statusText}\n${text}`);
  }
  const body = await res.json();
  if (!body.accessToken || !body.refreshToken) {
    die(`refresh response missing tokens: ${JSON.stringify(body)}`);
  }
  return body;
}

async function resolveAuth() {
  const accessEnv = process.env.SHELLY_CLOUD_TOKEN;
  const refreshEnv = process.env.SHELLY_CLOUD_REFRESH_TOKEN;

  if (accessEnv && !REFRESH_ONLY) {
    const payload = decodeJwt(accessEnv);
    if (!payload.user_api_url) die('SHELLY_CLOUD_TOKEN JWT missing user_api_url claim.');
    if (payload.exp * 1000 < Date.now()) {
      // Fall through to refresh if available; otherwise fail.
      if (!refreshEnv) die(`Access token expired at ${new Date(payload.exp * 1000).toISOString()}.`);
    } else {
      return { token: accessEnv, apiUrl: payload.user_api_url };
    }
  }

  if (!refreshEnv) {
    die(
      'No valid auth. Set SHELLY_CLOUD_TOKEN (24 h access) or\n' +
      'SHELLY_CLOUD_REFRESH_TOKEN + SHELLY_CLOUD_API_URL (60 d refresh).\n' +
      'See the header comment for how to obtain them.',
    );
  }
  const apiUrl = process.env.SHELLY_CLOUD_API_URL;
  if (!apiUrl) die('SHELLY_CLOUD_API_URL required when using SHELLY_CLOUD_REFRESH_TOKEN (e.g. https://shelly-249-eu.shelly.cloud).');

  const rt = decodeJwt(refreshEnv);
  if (rt.exp * 1000 < Date.now()) die(`Refresh token expired at ${new Date(rt.exp * 1000).toISOString()}. Log in again to obtain a new one.`);

  const body = await refreshAccessToken(apiUrl, refreshEnv);
  const newRt = decodeJwt(body.refreshToken);
  process.stderr.write(
    `\n⚠️  Refresh token rotated. The old one may stop working soon — save this new one:\n` +
    `    SHELLY_CLOUD_REFRESH_TOKEN=${body.refreshToken}\n` +
    `    (valid until ${new Date(newRt.exp * 1000).toISOString()})\n\n`,
  );
  if (REFRESH_ONLY) {
    // Emit parseable output on stdout so callers can `eval`.
    process.stdout.write(`SHELLY_CLOUD_TOKEN=${body.accessToken}\n`);
    process.stdout.write(`SHELLY_CLOUD_REFRESH_TOKEN=${body.refreshToken}\n`);
    process.stdout.write(`SHELLY_CLOUD_API_URL=${apiUrl}\n`);
    process.exit(0);
  }
  return { token: body.accessToken, apiUrl };
}

const { token, apiUrl } = await resolveAuth();

async function api(path, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${method} ${path} → ${res.status} ${res.statusText}\n${text}`);
  }
  return res.json();
}

const list = await api('/interface/device/get_all_lists');
if (!list.isok) die(`get_all_lists returned isok=false: ${JSON.stringify(list)}`);
const rows = Object.values(list.data.devices);

let renamed = 0, skipped = 0, untouched = 0;
for (const row of rows) {
  const targets = IP_TO_CHANNEL_NAMES[row.ip];
  if (!targets) { untouched++; continue; }
  const target = targets[row.channel];
  if (target == null) { untouched++; continue; }
  if (row.name === target) { skipped++; continue; }

  const prefix = DRY_RUN ? '[dry-run] ' : '';
  console.log(`${prefix}${row.id} (${row.ip} ch ${row.channel}): "${row.name}" → "${target}"`);

  if (!DRY_RUN) {
    const body = new URLSearchParams({
      id: row.id,
      data: JSON.stringify({ ...row, name: target }),
    });
    const save = await api('/interface/device/save', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!save.isok) die(`save returned isok=false for ${row.id}: ${JSON.stringify(save)}`);
  }
  renamed++;
}

console.log(`\nSummary: renamed=${renamed} already-matching=${skipped} no-mapping=${untouched}`);
if (DRY_RUN && renamed > 0) console.log('(dry run — no changes applied)');
