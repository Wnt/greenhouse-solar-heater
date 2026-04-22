/**
 * Thin wrapper around scripts/rename-cloud-devices.mjs for server-side use.
 *
 * Lets sensor-remap (and anything else that changes naming state) trigger a
 * Shelly Cloud rename without duplicating the script's logic. Spawns the
 * script as a child process so both the CLI and this module stay in sync.
 *
 * Non-fatal by design: a broken cloud-side rename should never block the
 * primary operation. The caller gets back either `null` (success) or a
 * `{ id, message }` warning object suitable for surfacing to the UI as a
 * dismissible banner.
 *
 * Rotation caveat: Shelly's /v2/users/auth/refresh rotates the refresh
 * token on every call. After a successful run the script prints the new
 * refresh token to stderr — we forward that to the log so an operator can
 * update the stored secret. Until the stored token is updated, subsequent
 * runs will fail with a clear auth error (still non-fatal).
 */

const { spawn } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.resolve(__dirname, '..', '..', 'scripts', 'rename-cloud-devices.mjs');

const WARNING_ID = 'cloud-rename';

// The DevTools-console one-liner that grabs a fresh 60-day refresh token
// out of the Shelly Cloud app's localStorage and copies it to the clipboard.
// Kept as a single line so it pastes cleanly into the browser console.
var TOKEN_ONELINER =
  "(u=>{const {refresh_token:t,user_api_url:a}=u;console.log({refresh_token:t,user_api_url:a," +
  "exp:new Date(JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).exp*1e3).toISOString()});" +
  "copy(`SHELLY_CLOUD_REFRESH_TOKEN=${t}\\nSHELLY_CLOUD_API_URL=${a}`)})(JSON.parse(localStorage.user_data))";

function buildFixInstructions(lead) {
  return [
    lead,
    '',
    'To fix:',
    '  1. Log in at https://control.shelly.cloud/',
    '  2. Open DevTools (F12) → Console, paste this one-liner — it copies the',
    '     refresh token and API URL to your clipboard:',
    '',
    '       ' + TOKEN_ONELINER,
    '',
    '  3. In deploy/terraform/, set (or update) the two variables with the',
    '     copied values:',
    '',
    '       shelly_cloud_refresh_token = "eyJ…"',
    '       shelly_cloud_api_url       = "https://shelly-XXX-eu.shelly.cloud"',
    '',
    '  4. Run: cd deploy/terraform && terraform apply',
    '',
    'The token is valid for 60 days and rotates on every successful use — you',
    'will see this warning again after each rotation until the stored value',
    'is refreshed.',
  ].join('\n');
}

const MISSING_CREDS_MSG = buildFixInstructions(
  "Device names in the Shelly Cloud app aren't being kept in sync — " +
  'SHELLY_CLOUD_REFRESH_TOKEN is not set on the server.',
);

const SCRIPT_FAILED_LEAD = "Couldn't update device names in the Shelly Cloud app. " +
  'The stored SHELLY_CLOUD_REFRESH_TOKEN was likely consumed by an earlier run ' +
  '(refresh tokens rotate on every use) or has expired.';

function renameCloudDevices(log) {
  return new Promise(function (resolve) {
    if (!process.env.SHELLY_CLOUD_TOKEN && !process.env.SHELLY_CLOUD_REFRESH_TOKEN) {
      log.warn(MISSING_CREDS_MSG);
      resolve({ id: WARNING_ID, message: MISSING_CREDS_MSG, reason: 'missing-credentials' });
      return;
    }

    var stdout = '';
    var stderr = '';
    var child;
    try {
      child = spawn('node', [SCRIPT_PATH], { env: process.env });
    } catch (e) {
      var msg = 'Failed to spawn Shelly Cloud rename script: ' + e.message;
      log.warn({ err: e.message }, msg);
      resolve({ id: WARNING_ID, message: msg, reason: 'spawn-error' });
      return;
    }

    child.stdout.on('data', function (d) { stdout += d.toString(); });
    child.stderr.on('data', function (d) { stderr += d.toString(); });

    child.on('error', function (e) {
      var msg = 'Shelly Cloud rename script error: ' + e.message;
      log.warn({ err: e.message }, msg);
      resolve({ id: WARNING_ID, message: msg, reason: 'script-error' });
    });

    child.on('close', function (code) {
      var trimmedOut = stdout.trim();
      var trimmedErr = stderr.trim();
      if (code === 0) {
        if (trimmedOut) log.info({ output: trimmedOut }, 'Shelly Cloud rename complete');
        if (trimmedErr) {
          // Rotation warning lives on stderr — always surface so operator
          // can update the stored secret before it becomes invalid.
          log.warn({ notice: trimmedErr }, 'Shelly Cloud refresh token rotated — update stored secret');
        }
        resolve(null);
      } else {
        var errMsg = buildFixInstructions(SCRIPT_FAILED_LEAD + ' (exit ' + code + ')');
        log.warn({ code: code, stdout: trimmedOut, stderr: trimmedErr }, 'Shelly Cloud rename failed');
        resolve({ id: WARNING_ID, message: errMsg, reason: 'script-failed' });
      }
    });
  });
}

module.exports = {
  renameCloudDevices: renameCloudDevices,
  WARNING_ID: WARNING_ID,
};
